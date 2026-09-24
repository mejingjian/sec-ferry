// 平台接口冒烟测试：每次改动代码后跑一遍，覆盖本次几轮 Bug 的高风险点。
// 运行：
//   node scripts/smoke-test.mjs
//   node scripts/smoke-test.mjs --base http://127.0.0.1:8787 --admin a@x.com --approver b@x.com --requester c@x.com
// 域账号登录（LDAP bind）环境下需带密码，可用通用 --password，或按角色分别指定：
//   node scripts/smoke-test.mjs --admin zhangsan@example.local --admin-password 域密码 ...
// 可选写入用例（会真实提交一笔申请）：
//   node scripts/smoke-test.mjs --write
//
// 用例数量取决于传入的账号：不传账号时只跑 14 项（单角色 + 接口契约），
// 传入 admin/approver/requester 三个角色后才会覆盖「高权限可见全部 / 发起人仅见本人」等可见性用例。
// 注意：这三个账号必须是 LDAP 目录里真实存在且能判定出对应角色的邮箱；
// 若实例刚建好、LDAP 尚未同步（ldapUsers 为空），多角色用例无法执行，只跑单角色即可。
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const BASE = argValue("base", process.env.SMOKE_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const ADMIN_EMAIL = argValue("admin", process.env.SMOKE_ADMIN_EMAIL || "");
const APPROVER_EMAIL = argValue("approver", process.env.SMOKE_APPROVER_EMAIL || "");
const REQUESTER_EMAIL = argValue("requester", process.env.SMOKE_REQUESTER_EMAIL || "");
// 域账号登录（LDAP bind）需要的密码：--password 为通用值，也可按角色单独给
// --admin-password / --approver-password / --requester-password。
// 不传密码时按"联调态自声明登录"走（仅当平台未配置 LDAP 认证源时才可能成功）。
const COMMON_PASSWORD = argValue("password", process.env.SMOKE_PASSWORD || "");
const ADMIN_PASSWORD = argValue("admin-password", process.env.SMOKE_ADMIN_PASSWORD || COMMON_PASSWORD);
const APPROVER_PASSWORD = argValue("approver-password", process.env.SMOKE_APPROVER_PASSWORD || COMMON_PASSWORD);
const REQUESTER_PASSWORD = argValue("requester-password", process.env.SMOKE_REQUESTER_PASSWORD || COMMON_PASSWORD);
const WRITE = args.includes("--write");

let passed = 0;
let failed = 0;
function record(ok, label, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function createSession(account, password = "") {
  // 带密码 → 走「域账号 + 域密码」；不带 → 走联调态自声明登录 / 本地兜底
  const payload = account ? (password ? { account, password } : { email: account }) : { local: true };
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  return { status: response.status, body, cookie };
}

async function get(path, cookie) {
  const response = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, json, text };
}

async function postJson(path, payload, cookie) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, json, text };
}

async function main() {
  console.log(`冒烟测试目标：${BASE}\n`);

  // 1) 未登录访问必须 401（登录页由前端处理）
  const anonymous = await get("/api/bootstrap");
  record(anonymous.status === 401, "未登录访问 bootstrap 返回 401", `实际 ${anonymous.status}`);

  // 2) 角色登录与身份返回
  const accounts = [];
  if (ADMIN_EMAIL) accounts.push({ label: "管理员", email: ADMIN_EMAIL, password: ADMIN_PASSWORD, expect: "管理员" });
  if (APPROVER_EMAIL) accounts.push({ label: "审批人", email: APPROVER_EMAIL, password: APPROVER_PASSWORD, expect: "审批人" });
  if (REQUESTER_EMAIL) accounts.push({ label: "发起人", email: REQUESTER_EMAIL, password: REQUESTER_PASSWORD, expect: "发起人" });
  if (!accounts.length) {
    console.log("未提供账号参数，使用本地管理员兜底登录进行后续检查");
    accounts.push({ label: "本地管理员", email: "", password: "", expect: "管理员" });
  }

  const sessions = {};
  for (const account of accounts) {
    const session = await createSession(account.email, account.password);
    sessions[account.label] = session;
    record(session.status === 200, `${account.label}登录成功`, session.status === 200 ? `角色 ${session.body.role}` : `HTTP ${session.status} ${session.body.error || ""}`);
    if (session.body.email !== undefined && account.expect) {
      record(session.body.role === account.expect, `${account.label}角色判定为「${account.expect}」`, `实际 ${session.body.role}`);
    }
  }

  // 3) 可见性：高权限角色可见全部；发起人只能是「本人提交 + 被指定审批」的子集
  const roleViews = {};
  for (const [label, session] of Object.entries(sessions)) {
    const view = await get("/api/bootstrap", session.cookie);
    record(view.status === 200, `${label}读取 bootstrap`, `HTTP ${view.status}`);
    if (view.status === 200) roleViews[label] = view.json.applications || [];
  }
  const elevatedLabels = Object.keys(sessions).filter((label) => ["管理员", "审批人", "审计员"].includes(sessions[label].body.role));
  const requesterLabels = Object.keys(sessions).filter((label) => sessions[label].body.role === "发起人");
  if (elevatedLabels.length && requesterLabels.length) {
    const elevatedCount = roleViews[elevatedLabels[0]].length;
    for (const label of elevatedLabels) {
      record(roleViews[label].length === elevatedCount, `高权限角色「${label}」可见全部申请`, `${roleViews[label].length}/${elevatedCount}`);
    }
    for (const label of requesterLabels) {
      const rows = roleViews[label];
      const email = (sessions[label].body.email || "").toLowerCase();
      const ownOnly = rows.every((row) => row.requesterId === sessions[label].body.email || row.requesterId === email || (row.assignedApprovers || "").toLowerCase().includes(email));
      record(ownOnly && rows.length <= elevatedCount, `发起人「${label}」仅见本人/被指派申请`, `可见 ${rows.length} 条`);
    }
  }

  // 4) 可见性口径一致性：两个接口对同一账号返回同样的申请集合
  for (const [label, session] of Object.entries(sessions)) {
    const list = await get("/api/applications", session.cookie);
    if (list.status !== 200 || !roleViews[label]) continue;
    const idsFromList = new Set(list.json.map((row) => row.id));
    const idsFromBootstrap = new Set(roleViews[label].map((row) => row.id));
    const same = idsFromList.size === idsFromBootstrap.size && [...idsFromList].every((id) => idsFromBootstrap.has(id));
    record(same, `「${label}」bootstrap 与 /api/applications 可见集合一致`, `${idsFromBootstrap.size} vs ${idsFromList.size}`);
  }

  // 5) 规则预判接口：结构契约 + 幂等
  const primary = sessions[Object.keys(sessions)[0]];
  const previewBody = { fileName: "smoke.bin", sizeBytes: 125026 };
  const first = await postJson("/api/rules/preview", previewBody, primary.cookie);
  const again = await postJson("/api/rules/preview", previewBody, primary.cookie);
  const contractOk = first.status === 200 && typeof first.json.ruleId === "string" && typeof first.json.action === "string" && "fallbackReason" in first.json;
  record(contractOk, "规则预判接口返回判定结构", `HTTP ${first.status}`);
  record(first.status === 200 && again.status === 200 && first.json.ruleId === again.json.ruleId && first.json.fallbackReason === again.json.fallbackReason, "同一输入的预判结果幂等");
  if (first.status === 200) {
    console.log(`     判定样例：smoke.bin 122KB → ${first.json.ruleId}（${first.json.action}）${first.json.fallbackReason ? ` / ${first.json.fallbackReason}` : ""}`);
  }

  // 6) 提交校验：缺文件名 / 空文件 / 旧版表单上传已被明确拒绝
  const boot = await get("/api/bootstrap", primary.cookie);
  // 收件人 = 站内域账号：取通讯录中第一个含 @ 的邮箱（DN 形式的同步数据不能当收件人）
  const ldapUser = (boot.json?.ldapUsers || []).find((user) => (user.email || "").includes("@"));
  const upload = (fileName, bytes, recipients, description, cookie) => {
    const search = new URLSearchParams({ fileName, recipients, description });
    return fetch(`${BASE}/api/applications?${search.toString()}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: bytes,
    });
  };

  const noName = await upload("", new Uint8Array(16), ldapUser?.email || "any@example.local", "冒烟测试", primary.cookie);
  const noNameBody = await noName.json().catch(() => ({}));
  record(noName.status === 400 && String(noNameBody.error || "").includes("请选择"), "未提供文件名时提交被拒绝", `HTTP ${noName.status} ${noNameBody.error || ""}`);

  const emptySubmit = await upload("empty.bin", new Uint8Array(0), ldapUser?.email || "any@example.local", "冒烟测试", primary.cookie);
  const emptyBody = await emptySubmit.json().catch(() => ({}));
  record(emptySubmit.status === 400 && String(emptyBody.error || "").includes("空"), "0 字节空文件提交被拒绝", `HTTP ${emptySubmit.status} ${emptyBody.error || ""}`);

  // 旧版表单上传会把整个文件读进 Worker 内存（超过隔离上限即崩），必须被明确拒绝而不是静默接受
  const legacyForm = new FormData();
  legacyForm.set("file", new File([new Uint8Array(16)], "legacy.bin", { type: "application/octet-stream" }));
  legacyForm.set("recipients", ldapUser?.email || "any@example.local");
  legacyForm.set("description", "旧接口");
  const legacySubmit = await fetch(`${BASE}/api/applications`, { method: "POST", headers: { cookie: primary.cookie }, body: legacyForm });
  record(legacySubmit.status === 415, "旧版表单上传被明确拒绝（415）", `HTTP ${legacySubmit.status}`);

  // 7) 可选：真实提交一笔发送单，验证流式直传与哈希落库
  if (WRITE) {
    if (!ldapUser) {
      record(false, "写入用例需要 LDAP 通讯录中至少一位用户（先完成目录同步）");
    } else {
      const payload = new Uint8Array(300 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
      const expectedHash = await crypto.subtle.digest("SHA-256", payload).then((buffer) =>
        Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""));
      const submit = await upload("smoke-upload.bin", payload, ldapUser.email, "冒烟测试自动提交", primary.cookie);
      const created = await submit.json().catch(() => ({}));
      record(submit.status === 201, "提交发送单（流式直传）", `HTTP ${submit.status} ${created.error || created.id || ""}`);
      if (submit.status === 201) {
        record(created.sha256 === expectedHash, "落库 SHA-256 与原文一致", `${created.sha256}`);
        record(created.sizeBytes === payload.byteLength, "落库大小与实际字节数一致", `期望 ${payload.byteLength} 实际 ${created.sizeBytes}`);
        record(typeof created.typeMismatch === "boolean" && Boolean(created.detectedKind), "内容嗅探结果落库（detectedKind/typeMismatch）", `${created.detectedKind} / mismatch=${created.typeMismatch}`);
        const list = await get("/api/applications", primary.cookie);
        record(list.status === 200 && list.json.some((row) => row.id === created.id), "新发送单在列表中可见", created.id);
      }
    }
  } else {
    console.log("（未开启写入用例，跳过真实提交；需要时加 --write）");
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("冒烟测试异常：", error);
  process.exit(1);
});
