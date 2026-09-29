#!/usr/bin/env node
// 联调环境准备：把平台配成「可以直接跑回归」的状态（mock LDAP 认证源 + 平台角色）。
//
// 为什么需要它：各专项脚本只会「顺手」配自己需要的那一块 —— e2e 只切认证源，
// verify-content-type 只补管理员/发起人两个角色。于是想让 smoke-test 之类的
// 多角色用例跑全，就还得人工到页面上点几下。CI 里没人可点，环境准备必须是代码。
//
// 做的事（全部幂等，重复执行无副作用）：
//   ① 本地兜底管理员登录（要求实例**未配置** PLATFORM_ADMIN_EMAILS）
//   ② 认证源指向 mock LDAP（库里尚无绑定口令时写入占位值：mock 目录不校验服务帐号密码）
//   ③ 写入平台角色（默认 zhangsan=管理员 / wangwu=审批人 / lisi=发起人）
//   ④ 可选 --sync：触发一次目录同步，把 mock 目录的 4 个用户灌进通讯录
//
// 用法（mock 目录里口令 = 账号名，本脚本不写任何口令字面量）：
//   node scripts/seed-mock-env.mjs                 # 打本机 8787 + mock LDAP 3890
//   node scripts/seed-mock-env.mjs --sync          # 顺带同步目录（会把目录当成唯一真相）
//   node scripts/seed-mock-env.mjs --roles "zhangsan:管理员,lisi:发起人"   # 自定义角色清单
//   node scripts/seed-mock-env.mjs --base http://127.0.0.1:8787 --mock-port 3890
//
// ⚠️ 会真实写入平台配置与角色（与其它回归脚本同级），只对开发/验收环境执行。
// ⚠️ 不改「内容类型防护」档位，也不动 SMTP 设置 —— 那些由各自专项脚本负责还原。

const args = process.argv.slice(2);
function argValue(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return process.env[`E2E_${name.replace(/-/g, "_").toUpperCase()}`] ?? fallback;
}

const BASE = argValue("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const MOCK_HOST = argValue("mock-host", "127.0.0.1");
const MOCK_PORT = Number(argValue("mock-port", "3890"));
const MOCK_BASE_DN = argValue("mock-base-dn", "dc=example,dc=local");
const MOCK_BIND_DN = argValue("mock-bind-dn", `cn=admin,${MOCK_BASE_DN}`);
const MAIL_DOMAIN = argValue("mail-domain", "example.local");
// 占位口令：mock 目录对服务帐号不校验密码，这里只是为了让「认证源完整」这一校验通过。
// 不是凭据，仅用于联调；真实环境请用 bootstrap / 管理页写入真实绑定口令。
const MOCK_PLACEHOLDER_SECRET = "mock-ldap-placeholder";
const DO_SYNC = args.includes("--sync");
const SYNC_MODE = argValue("sync-mode", "full") === "incremental" ? "incremental" : "full";

// 默认角色清单：与 mock 目录的 4 个用户对齐（zhaoliu 刻意留作「无角色」的对照组）
const DEFAULT_ROLES = [
  { account: "zhangsan", role: "管理员" },
  { account: "wangwu", role: "审批人" },
  { account: "lisi", role: "发起人" },
];
const ROLES = (() => {
  const raw = argValue("roles", "");
  if (!raw) return DEFAULT_ROLES;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [account, ...rest] = item.split(":");
      return { account: account.trim(), role: rest.join(":").trim() };
    });
})();

const toEmail = (account) => (account.includes("@") ? account.toLowerCase() : `${account.toLowerCase()}@${MAIL_DOMAIN}`);

let failed = 0;
function record(ok, label, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "  [OK]  " : "  [FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers || {}) },
    body: options.body,
  });
  const contentType = response.headers.get("content-type") || "";
  const json = contentType.includes("json") ? await response.json().catch(() => ({})) : null;
  return { status: response.status, json, headers: response.headers };
}

async function main() {
  console.log(`联调环境准备 — 平台 ${BASE}\n`);

  const health = await request("/api/auth/me");
  if (health.status === 0) {
    console.error(`平台不可达：${BASE}（先把平台跑起来：npm run start 或 npm run local:start）`);
    process.exit(1);
  }

  console.log("① 本地兜底管理员登录");
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  record(login.status === 200, "本地兜底管理员登录", `HTTP ${login.status} ${login.json?.error || ""}`);
  if (login.status !== 200) {
    console.error("\n兜底入口不可用：本脚本需要「未配置 PLATFORM_ADMIN_EMAILS」的实例。");
    console.error("若这是已收紧的验收/生产实例，请改用 bootstrap 或管理页完成配置。");
    process.exit(1);
  }

  console.log("\n② 认证源指向 mock LDAP");
  const before = await request("/api/admin/config", { cookie });
  const original = before.json?.ldap || null;
  const needsPlaceholderSecret = original?.secretConfigured !== true;
  const put = await request("/api/admin/config", {
    method: "PUT",
    cookie,
    headers: { "content-type": "application/json" },
    // 已有绑定口令时不提交 secret：沿用已存口令，避免覆盖真实 AD 的绑定密码
    body: JSON.stringify({
      ldapName: "Mock_LDAP",
      ldapHost: MOCK_HOST,
      ldapPort: MOCK_PORT,
      ldapLdaps: false,
      baseDn: MOCK_BASE_DN,
      bindDn: MOCK_BIND_DN,
      ldapFilter: "(objectClass=person)",
      syncIntervalMinutes: 30,
      ...(needsPlaceholderSecret ? { secret: MOCK_PLACEHOLDER_SECRET } : {}),
    }),
  });
  record(put.status === 200, `认证源 → ldap://${MOCK_HOST}:${MOCK_PORT}（baseDn ${MOCK_BASE_DN}）`, `HTTP ${put.status} ${put.json?.error || ""}`);
  if (needsPlaceholderSecret) console.log("         （库中尚无绑定口令，本次写入 mock 占位值；mock 目录不校验服务帐号密码）");

  console.log("\n③ 平台角色");
  for (const item of ROLES) {
    const email = toEmail(item.account);
    const saved = await request("/api/admin/roles", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, displayName: item.account.split("@")[0], role: item.role }),
    });
    record(saved.status === 200, `${email} → ${item.role}`, `HTTP ${saved.status} ${saved.json?.error || ""}`);
  }

  if (DO_SYNC) {
    console.log("\n④ 目录同步");
    const sync = await request("/api/ldap/sync", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: SYNC_MODE }),
    });
    record(sync.status === 202, "触发目录同步", `HTTP ${sync.status} ${sync.json?.summary || sync.json?.error || ""}`);
  } else {
    console.log("\n④ 目录同步：未执行（需要时加 --sync；注意它会把目录当成唯一真相，真实用户会被标记离职）");
  }

  console.log("");
  if (failed) {
    console.log(`环境准备未全部成功：${failed} 项失败。`);
    process.exit(1);
  }
  console.log("环境已就绪。可用账号（mock 目录口令 = 账号名）：");
  for (const item of ROLES) console.log(`  ${item.account} / ${item.account}  → ${item.role}`);
  console.log("  （收件人可用 zhaoliu，它刻意不配角色）");
  process.exit(0);
}

main().catch((error) => {
  console.error("环境准备异常：", error);
  process.exit(1);
});
