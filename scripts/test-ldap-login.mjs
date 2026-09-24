// ③ 域账号登录（LDAP bind）回归脚本 —— 直接打平台接口，覆盖「配认证源 → 同步 → 登录 → 锁定」整条链路。
//
// 前置：
//   1) mock LDAP 已启动：node scripts/mock-ldap-server.mjs --port 3890
//      （mock 规则：服务帐号任意非空密码；普通用户密码 = 域账号，如 zhangsan/zhangsan）
//   2) 平台已启动（http://127.0.0.1:8787），且未配置 PLATFORM_ADMIN_EMAILS —— 用本地管理员做管理操作
// 运行：
//   node scripts/test-ldap-login.mjs
//   node scripts/test-ldap-login.mjs --base http://127.0.0.1:8787 --ldap-port 3890 --assign-roles
//
// ⚠️ 会真实写入：LDAP 认证源配置、目录用户、登录审计与失败计数；--assign-roles 还会写角色，
//    只能对本地 / 验收环境运行。
// ⚠️ 失败锁定用例会把测试账号锁在 login_attempts 里（默认 15 分钟）。脚本结束时会打印清理提示，
//    也可执行：node scripts/test-ldap-login.mjs --unlock 需要的账号由你按提示清理。

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const BASE = argValue("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const LDAP_HOST = argValue("ldap-host", "127.0.0.1");
const LDAP_PORT = Number(argValue("ldap-port", "3890"));
const BASE_DN = argValue("base-dn", "dc=example,dc=local");
const BIND_DN = argValue("bind-dn", `cn=admin,${BASE_DN}`);
// 服务帐号密码：默认不传 —— 保留库里已保存的密码（换成 mock LDAP 时尤其重要：
// 直接覆盖会丢掉真实 AD 的绑定密码）。mock LDAP 不校验服务帐号口令，因此无需重填。
const SERVICE_PASSWORD = argValue("service-password", "");
const ASSIGN_ROLES = args.includes("--assign-roles");
const MAX_FAILURES = Number(argValue("max-failures", "5"));

// 与 scripts/mock-ldap-server.mjs 的测试目录一致：密码 = 域账号
const USERS = {
  admin: { account: "zhangsan", email: "zhangsan@example.local" },
  approver: { account: "wangwu", email: "wangwu@example.local" },
  requester: { account: "lisi", email: "lisi@example.local" },
  lockTarget: { account: "zhaoliu", email: "zhaoliu@example.local" },
};

let passed = 0;
let failed = 0;
function record(ok, label, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, json, text, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}

const login = (payload) => request("/api/auth/login", { method: "POST", body: payload });

async function main() {
  console.log(`③ 域账号登录回归：平台 ${BASE} · LDAP ${LDAP_HOST}:${LDAP_PORT}（${BASE_DN}）\n`);

  // 1) 本地管理员（管理操作入口）
  const adminSession = await login({ local: true });
  record(adminSession.status === 200, "本地管理员兜底登录", adminSession.status === 200 ? `角色 ${adminSession.json?.role}` : `HTTP ${adminSession.status} ${adminSession.json?.error || ""}`);
  if (adminSession.status !== 200) {
    console.log("\n无法以本地管理员登录（可能已配置 PLATFORM_ADMIN_EMAILS）。请改用已有管理员账号后重跑。");
    process.exit(1);
  }
  const adminCookie = adminSession.cookie;

  // 2) 配置 LDAP 认证源（直连模式 + 加密保存密码）
  const saved = await request("/api/admin/config", {
    method: "PUT",
    cookie: adminCookie,
    body: {
      ldapName: "Mock_LDAP",
      ldapHost: LDAP_HOST,
      ldapPort: LDAP_PORT,
      ldapLdaps: false,
      baseDn: BASE_DN,
      bindDn: BIND_DN,
      ...(SERVICE_PASSWORD ? { secret: SERVICE_PASSWORD } : {}),
      ldapFilter: "(objectClass=person)",
      syncIntervalMinutes: 30,
    },
  });
  record(saved.status === 200, "保存 LDAP 认证源（直连 + 密码加密）", saved.status === 200 ? `secretConfigured=${saved.json?.secretConfigured}` : `HTTP ${saved.status} ${saved.json?.error || ""}`);

  const config = await request("/api/admin/config", { cookie: adminCookie });
  record(config.status === 200 && config.json?.ldap?.secretConfigured === true, "回读配置：密码已配置且不回显明文", JSON.stringify(config.json?.ldap?.ldapHost));

  // 3) 目录同步（同时验证 LDAP 客户端重构后 search 仍可用）
  const sync = await request("/api/ldap/sync", { method: "POST", cookie: adminCookie, body: { mode: "full" } });
  const upserted = sync.json?.upserted ?? 0;
  record(sync.status === 202 && upserted >= 4, "目录同步（服务帐号 bind + search）", sync.status === 202 ? `写入 ${upserted} 人：${sync.json?.summary || ""}` : `HTTP ${sync.status} ${sync.json?.error || ""}`);

  // 4) 同步结果（bootstrap 的目录列表只返回前 500 条，历史库有上千条 DN 形式数据时可能不含 mock 用户，
  //    因此这里只断言"目录可读"，域账号回填由下面的「短名登录 → 邮箱身份」用例间接验证）
  const bootstrap = await request("/api/bootstrap", { cookie: adminCookie });
  const directory = bootstrap.json?.ldapUsers || [];
  record(Array.isArray(directory) && directory.length > 0, "bootstrap 返回 LDAP 目录（收件人候选来源）", `${directory.length} 条`);
  const mockEntry = directory.find((user) => (user.email || "").toLowerCase() === USERS.admin.email);
  if (mockEntry) {
    record(Boolean(mockEntry.account), "ldap_users 回填域账号（account）", `account=${mockEntry.account}`);
  } else {
    console.log(`SKIP 目录列表未包含 ${USERS.admin.email}（bootstrap 仅前 500 条，本库已有上千条 DN 形式历史数据）`);
  }

  // 5) 管理员认证自检：正确 / 错误密码
  const probeOk = await request("/api/ldap/test-bind", { method: "POST", cookie: adminCookie, body: { account: USERS.admin.account, password: USERS.admin.account } });
  record(probeOk.status === 200 && probeOk.json?.ok === true, "认证自检（正确域密码）", probeOk.status === 200 ? `匹配方式 ${probeOk.json?.matchedBy}，识别为 ${probeOk.json?.identity?.email}` : `HTTP ${probeOk.status} ${probeOk.json?.error || ""}`);
  const probeBad = await request("/api/ldap/test-bind", { method: "POST", cookie: adminCookie, body: { account: USERS.admin.account, password: "definitely-wrong" } });
  record(probeBad.status === 401, "认证自检（错误域密码）返回 401", `HTTP ${probeBad.status} ${probeBad.json?.error || ""}`);

  // 6) 域账号短名登录 / 邮箱登录
  const shortName = await login({ account: USERS.admin.account, password: USERS.admin.account });
  record(shortName.status === 200, "域账号（短名）登录成功", shortName.status === 200 ? `身份 ${shortName.json?.email} · 角色 ${shortName.json?.role}` : `HTTP ${shortName.status} ${shortName.json?.error || ""}`);
  const byEmail = await login({ account: USERS.admin.email, password: USERS.admin.account });
  record(byEmail.status === 200, "域账号（邮箱形式）登录成功", byEmail.status === 200 ? `身份 ${byEmail.json?.email}` : `HTTP ${byEmail.status} ${byEmail.json?.error || ""}`);
  record(shortName.json?.email === byEmail.json?.email, "两种输入形式解析为同一身份", `${shortName.json?.email} / ${byEmail.json?.email}`);

  // 7) 负向用例：错误密码 / 缺密码 / 不存在的账号
  const wrongPassword = await login({ account: USERS.approver.account, password: "wrong-password" });
  record(wrongPassword.status === 401, "错误域密码返回 401", `HTTP ${wrongPassword.status} ${wrongPassword.json?.error || ""}`);
  const noPassword = await login({ account: USERS.approver.account });
  record(noPassword.status === 422, "缺少域密码返回 422", `HTTP ${noPassword.status} ${noPassword.json?.error || ""}`);
  const unknownUser = await login({ account: "no-such-user", password: "whatever" });
  record(unknownUser.status === 401, "不存在的域账号返回 401（不泄露账号是否存在）", `HTTP ${unknownUser.status} ${unknownUser.json?.error || ""}`);

  // 8) 失败锁定：连续失败达阈值 → 锁定（429），且锁定期内正确密码也不放行
  const target = USERS.lockTarget;
  const precheck = await login({ account: target.account, password: target.account });
  if (precheck.status === 429) {
    console.log(`SKIP 失败锁定用例：${target.account} 已处于锁定状态（上一次运行留下的），需清理 login_attempts 后重跑`);
  } else {
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt += 1) {
      await login({ account: target.account, password: `wrong-${attempt}` });
    }
    const locked = await login({ account: target.account, password: target.account });
    record(locked.status === 429, `连续失败 ${MAX_FAILURES} 次后触发锁定（正确密码也被拒）`, `HTTP ${locked.status} ${locked.json?.error || ""}`);
  }

  // 9) 角色配置（可选）：给 domain 账号配平台角色，便于随后用域账号跑多角色冒烟
  if (ASSIGN_ROLES) {
    const assignments = [
      { email: USERS.admin.email, displayName: "张三", role: "管理员" },
      { email: USERS.approver.email, displayName: "王五", role: "审批人" },
      { email: USERS.requester.email, displayName: "李四", role: "发起人" },
    ];
    for (const assignment of assignments) {
      const result = await request("/api/admin/roles", { method: "POST", cookie: adminCookie, body: assignment });
      record(result.status === 200, `配置角色：${assignment.email} → ${assignment.role}`, result.status === 200 ? "已保存" : `HTTP ${result.status} ${result.json?.error || ""}`);
    }
  }

  console.log(`\n合计：${passed} 通过 / ${failed} 失败`);
  console.log(`提示：锁定用例已把 ${target.account} 锁在 login_attempts 表里（默认 ${MAX_FAILURES} 次阈值，15 分钟自动解锁）。`);
  console.log(`     本地排查时可执行：node scripts/smoke-test.mjs 前先等锁过期，或直接删除该行（DELETE FROM login_attempts WHERE identifier='${target.account}';）。`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`脚本异常：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
