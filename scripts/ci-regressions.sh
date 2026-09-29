#!/usr/bin/env bash
# 回归套件（CI 与本地共用）：依次跑各专项脚本，最后汇总成一条结论。
#
# 为什么要有它：原先 CI 只跑 test:rekey + e2e 两支，其余专项（内容防护 / 冒烟 /
# 邮件通知 / 域账号登录）都得手工敲命令 —— 开源之后没有人会替你敲。
#
# 执行顺序是有讲究的，改动请保持：
#   1 e2e-internal-transfer  收发闭环；会临时切认证源、跑完还原
#   2 verify-content-type    内容防护；用 zhaoliu 当收件人（需要它能登录）
#   3 smoke-test             接口契约 + 可见性；只读，角色由 seed-mock-env 预先配好
#   4 test-mail-notify       邮件通知闭环；内嵌 mock SMTP 监听 127.0.0.1:2525
#   5 test-ldap-login        必须放最后：失败锁定用例会把 zhaoliu 锁 15 分钟，
#                            放在前面会让其它脚本登录不上
#
# 前置条件：
#   * 平台已在 $BASE 运行（未配置 PLATFORM_ADMIN_EMAILS 的联调/验收实例）
#   * mock LDAP 已在 3890 监听：node scripts/mock-ldap-server.mjs --port 3890
#   * 已跑过 node scripts/seed-mock-env.mjs（配认证源与角色）—— 见 --prepare
#
# 用法：
#   bash scripts/ci-regressions.sh                    # 打 http://127.0.0.1:8787
#   bash scripts/ci-regressions.sh --base http://127.0.0.1:8787
#   bash scripts/ci-regressions.sh --prepare          # 先跑环境准备再跑套件
#   bash scripts/ci-regressions.sh --only smoke       # 只跑匹配到的那几支（调试用）
#   bash scripts/ci-regressions.sh --list             # 只列出会跑哪些

set -uo pipefail

BASE="http://127.0.0.1:8787"
ONLY=""
DO_PREPARE=0
LOG_DIR="${TMPDIR:-/tmp}/regress-logs"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --prepare) DO_PREPARE=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

# 名称 | 说明 | 命令（--base 由套件拼进去）
names=(e2e content-type smoke mail ldap-login)
titles=("收发闭环" "内容防护" "接口冒烟" "邮件通知" "域账号登录")
commands=(
  "node scripts/e2e-internal-transfer.mjs --mock-ldap"
  "node scripts/verify-content-type.mjs --mock-ldap"
  "node scripts/smoke-test.mjs --mock-ldap --write --admin zhangsan@example.local --approver wangwu@example.local --requester lisi@example.local"
  "node scripts/test-mail-notify.mjs --mock-ldap"
  "node scripts/test-ldap-login.mjs --ldap-port 3890"
)

if [ -n "${LIST_ONLY:-}" ]; then
  for index in "${!names[@]}"; do
    printf '%-12s %-10s %s\n' "${names[$index]}" "${titles[$index]}" "${commands[$index]}"
  done
  exit 0
fi

mkdir -p "$LOG_DIR"
echo "回归套件 — 平台 ${BASE}"
echo "运行日志：${LOG_DIR}"
echo ""

if [ "$DO_PREPARE" = "1" ]; then
  echo "══════ 0/5 环境准备（seed-mock-env） ══════"
  if node scripts/seed-mock-env.mjs --base "$BASE" --sync; then
    echo "→ 环境准备完成"
  else
    echo "→ 环境准备失败（后续脚本多半也会失败）"
  fi
  echo ""
fi

passed_names=()
failed_names=()
summary_lines=()

for index in "${!names[@]}"; do
  name="${names[$index]}"
  title="${titles[$index]}"
  command="${commands[$index]}"

  if [ -n "$ONLY" ] && [ "${name#*"$ONLY"}" = "$name" ]; then
    continue
  fi

  log="${LOG_DIR}/${name}.log"
  echo "══════ $((index + 1))/${#names[@]} ${name}（${title}） ══════"

  # 不用 set -e：任何一支失败都要把后面的跑完，才能一次拿到全景
  start=$(date +%s)
  # shellcheck disable=SC2086  # command 里是「可执行文件 + 参数」，需要按空格拆开
  ${command} --base "$BASE" > "$log" 2>&1
  code=$?
  elapsed=$(( $(date +%s) - start ))

  tail -n 6 "$log"

  # 各脚本的汇总行格式不统一（「通过 N 项」/「结果：N 通过」/「合计」），宽松匹配
  line="$(grep -E '通过 [0-9]+ 项|通过 / [0-9]+ 失败|全部通过|结果：|pass=' "$log" | tail -1 || true)"
  [ -n "$line" ] || line="（未取到汇总行，见 ${log}）"

  if [ "$code" = "0" ]; then
    passed_names+=("$name")
    summary_lines+=("| ${title} | ${line} | ${elapsed}s | OK |")
    echo "→ ${name}: PASS（${elapsed}s）"
  else
    failed_names+=("$name")
    summary_lines+=("| ${title} | ${line} | ${elapsed}s | **FAIL** |")
    echo "→ ${name}: FAIL（退出码 ${code}，${elapsed}s）"
    echo "  —— 失败尾部 ——"
    tail -n 25 "$log"
    echo "  ————————————"
  fi
  echo ""
done

total=$(( ${#passed_names[@]} + ${#failed_names[@]} ))
result="通过 ${#passed_names[@]}/${total} 支（$(IFS=、; echo "${passed_names[*]:-无}")）"
[ ${#failed_names[@]} -gt 0 ] && result="${result}，失败：$(IFS=、; echo "${failed_names[*]}")"

echo "══════ 汇总 ══════"
echo "$result"

# 步骤日志与 Job Summary 都需要登录，注解（annotation）匿名可读 —— 结论走注解
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  if [ ${#failed_names[@]} -gt 0 ]; then
    echo "::error title=回归套件::${result}"
  else
    echo "::notice title=回归套件::${result}"
  fi
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### 回归套件（${BASE}）"
    echo ""
    echo "| 专项 | 结果 | 耗时 | 状态 |"
    echo "|---|---|---|---|"
    for line in "${summary_lines[@]}"; do echo "$line"; done
    echo ""
    echo "**${result}**"
  } >> "$GITHUB_STEP_SUMMARY"
fi

[ ${#failed_names[@]} -eq 0 ] || exit 1
