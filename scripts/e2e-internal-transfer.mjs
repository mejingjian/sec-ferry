#!/usr/bin/env node
// 站内收发闭环端到端回归（对应任务 ④ 发送流程 + ⑤ 收件箱与下载留痕）：
//   发起人提交 → 收件人此时不可下载 → 审批人通过 → 收件人下载（校验 SHA-256/留痕）→ 收件箱可见性 → 发起人撤回 → 收件人下载被拒
//
// 运行（平台需已启动）：
//   node scripts/e2e-internal-transfer.mjs --mock-ldap
//   node scripts/e2e-internal-transfer.mjs --base http://127.0.0.1:8787 \
//     --requester lisi --approver wangwu --recipient zhaoliu
//
// --mock-ldap：先以本地兜底管理员会话把 LDAP 认证源临时指向 127.0.0.1:3890 的 mock LDAP，
// 跑完后**自动把认证源还原成运行前的配置**（不覆盖原密码）。
// ⚠️ 默认不动目录：mock 目录里没有真实 AD 用户，同步会把真实用户标记为离职（加 --sync 才执行同步）。
// 账号口令默认取账号名（mock LDAP 约定），可用 --requester-password 等参数覆盖，或走同名环境变量。
// 本脚本会真实写入数据（发送单 / 送达记录 / 下载事件 / 审计），只能打验收或开发环境。

const args = process.argv.slice(2);
function argValue(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return process.env[`E2E_${name.replace(/-/g, "_").toUpperCase()}`] ?? fallback;
}

const BASE = argValue("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const REQUESTER = argValue("requester", "lisi");
const APPROVER = argValue("approver", "wangwu");
const RECIPIENT = argValue("recipient", "zhaoliu");
const ADMIN = argValue("admin", "zhangsan");
const USE_MOCK_LDAP = args.includes("--mock-ldap");
const DO_SYNC = args.includes("--sync");
const KEEP_CONFIG = args.includes("--keep-config");
const MOCK_HOST = argValue("mock-host", "127.0.0.1");
const MOCK_PORT = Number(argValue("mock-port", "3890"));
const MOCK_BASE_DN = argValue("mock-base-dn", "dc=example,dc=local");
const MOCK_BIND_DN = `cn=admin,${MOCK_BASE_DN}`;
// 全新实例上库里还没有服务帐号口令时用这个占位值（mock 目录不校验服务帐号密码）。
// 不是真实凭据，只为了让「认证源完整」这一校验通过。
const MOCK_PLACEHOLDER_SECRET = "mock-ldap-placeholder";
const SIZE = Number(argValue("size", String(300 * 1024)));
// 后缀默认取 "e2e"：通常不落在任何规则的后缀白名单里 → 命中兜底规则「转人工审批」，
// 从而覆盖「未命中自动通过规则 → 转人工审批」这条主路径（命中自动通过时脚本会自动跳过大半用例并说明）。
const EXTENSION = argValue("extension", "e2e");

// 口令：显式传入优先，否则按 mock LDAP 约定取账号名（不在源码里写死任何口令字面量）
const credential = (account, kind) => argValue(`${kind}-password`) || account.split("@")[0];

let passed = 0;
let failed = 0;
function record(ok, label, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n— ${title} —`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers || {}) },
    body: options.body,
  });
  const contentType = response.headers.get("content-type") || "";
  const json = contentType.includes("json") ? await response.json().catch(() => ({})) : null;
  return { status: response.status, json, headers: response.headers, response };
}

async function login(payload) {
  const result = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ...result, cookie: (result.headers.get("set-cookie") || "").split(";")[0] };
}

async function domainSession(account) {
  const password = credential(account, account === REQUESTER ? "requester" : account === APPROVER ? "approver" : account === RECIPIENT ? "recipient" : "admin");
  return login({ account, password });
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bootstrap(cookie) {
  const result = await request("/api/bootstrap", { cookie });
  return result.json || {};
}

function findApplication(data, id) {
  return (data.applications || []).find((row) => row.id === id);
}

async function main() {
  const health = await request("/api/auth/me");
  if (health.status === 0 || (health.status >= 500 && !health.json)) {
    console.error(`平台不可达：${BASE}`);
    process.exit(1);
  }

  let adminCookie = "";
  let originalConfig = null;
  if (USE_MOCK_LDAP) {
    section("准备：把认证源临时指向本地 mock LDAP");
    const fallback = await login({ local: true });
    record(fallback.status === 200, "本地兜底管理员登录（未配置 PLATFORM_ADMIN_EMAILS 时可用）", `HTTP ${fallback.status} ${fallback.json?.error || ""}`);
    if (fallback.status !== 200) {
      console.log("无法取得管理员会话：请先在未配置 PLATFORM_ADMIN_EMAILS 的实例上运行，或手动完成认证源与角色配置后去掉 --mock-ldap");
      process.exit(1);
    }
    adminCookie = fallback.cookie;
    originalConfig = (await request("/api/admin/config", { cookie: adminCookie })).json?.ldap || null;
    // 库里还没存过服务帐号口令时（全新实例第一次跑），必须提交一个占位口令：
    // mock 目录不校验服务帐号密码，但平台侧「认证源缺 bindPassword」会直接拒绝域账号登录。
    const needsPlaceholderSecret = originalConfig?.secretConfigured !== true;
    if (needsPlaceholderSecret) console.log("    （库中尚无 LDAP 绑定密码，本次写入 mock 占位口令）");
    const put = await request("/api/admin/config", {
      method: "PUT",
      cookie: adminCookie,
      headers: { "content-type": "application/json" },
      // 已有口令时不提交 secret：沿用已存储的服务帐号口令（避免覆盖真实 AD 的绑定密码）
      body: JSON.stringify({
        ldapName: "Mock_LDAP", ldapHost: MOCK_HOST, ldapPort: MOCK_PORT, ldapLdaps: false,
        baseDn: MOCK_BASE_DN, bindDn: MOCK_BIND_DN, ldapFilter: "(objectClass=person)", syncIntervalMinutes: 30,
        ...(needsPlaceholderSecret ? { secret: MOCK_PLACEHOLDER_SECRET } : {}),
      }),
    });
    record(put.status === 200, `认证源切到 mock LDAP ${MOCK_HOST}:${MOCK_PORT}`, `HTTP ${put.status} ${put.json?.error || ""}`);
    if (DO_SYNC) {
      const sync = await request("/api/ldap/sync", { method: "POST", cookie: adminCookie });
      record(sync.status === 200, "目录同步", `HTTP ${sync.status} ${sync.json?.summary || sync.json?.error || ""}`);
    } else {
      console.log("    （跳过目录同步：mock 目录不含真实 AD 用户，同步会把真实用户标记为离职；需要时加 --sync）");
    }
    // 角色只补缺失的，避免覆盖既有配置
    const currentRoles = new Map((((await request("/api/admin/config", { cookie: adminCookie })).json?.roles) || []).map((row) => [row.email, row.role]));
    const wanted = [[ADMIN, "管理员"], [APPROVER, "审批人"], [REQUESTER, "发起人"], [RECIPIENT, "发起人"]]
      .map(([account, role]) => [account.includes("@") ? account : `${account}@example.local`, role]);
    const missing = wanted.filter(([email, role]) => currentRoles.get(email) !== role);
    for (const [email, role] of missing) {
      await request("/api/admin/roles", { method: "POST", cookie: adminCookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ email, displayName: email.split("@")[0], role }) });
    }
    record(true, missing.length ? `补齐角色 ${missing.map(([email, role]) => `${email.split("@")[0]}=${role}`).join("、")}` : "平台角色已就绪（无需改动）");
  }

  try {
    section("① 三方身份登录（域账号 + 域密码）");
    const requester = await domainSession(REQUESTER);
    const approver = await domainSession(APPROVER);
    const recipient = await domainSession(RECIPIENT);
    record(requester.status === 200 && requester.json?.role === "发起人", `发起人 ${REQUESTER} 登录`, `HTTP ${requester.status} ${requester.json?.role || requester.json?.error || ""}`);
    record(approver.status === 200 && approver.json?.role === "审批人", `审批人 ${APPROVER} 登录`, `HTTP ${approver.status} ${approver.json?.role || approver.json?.error || ""}`);
    record(recipient.status === 200, `收件人 ${RECIPIENT} 登录`, `HTTP ${recipient.status} ${recipient.json?.role || recipient.json?.error || ""}`);
    if (![requester, approver, recipient].every((session) => session.status === 200)) {
      record(false, "三方身份未齐备，后续用例无法执行");
      return;
    }
    const requesterEmail = requester.json.email;
    const recipientEmail = recipient.json.email;

    section("② 提交发送单（多选收件人 + 流式直传）");
    const payload = new Uint8Array(SIZE);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 251;
    const expectedHash = await sha256Hex(payload);
    const search = new URLSearchParams({ fileName: `e2e-internal.${EXTENSION}`, recipients: recipientEmail, description: "站内收发闭环回归" });
    const submit = await fetch(`${BASE}/api/applications?${search.toString()}`, {
      method: "POST",
      headers: { cookie: requester.cookie, "content-type": "application/octet-stream" },
      body: payload,
    });
    const created = await submit.json().catch(() => ({}));
    record(submit.status === 201, "提交发送单", `HTTP ${submit.status} ${created.error || created.id || ""}`);
    if (submit.status !== 201) return;
    const id = created.id;
    record(created.sha256 === expectedHash, "落库 SHA-256 与原文一致", `期望 ${expectedHash.slice(0, 12)}… 实际 ${String(created.sha256).slice(0, 12)}…`);
    record(created.sizeBytes === payload.byteLength, "落库大小与实际字节数一致", `${created.sizeBytes}`);
    // kind 列已随「历史外发」归档移除；改为校验内容类型防护的落库字段（嗅探结果恒有值，未知类型记为 unknown）
    record(typeof created.detectedKind === "string" && created.detectedKind.length > 0 && typeof created.typeMismatch === "boolean", "内容类型嗅探结果落库（detectedKind/typeMismatch）", `detectedKind=${created.detectedKind} typeMismatch=${created.typeMismatch}`);
    console.log(`    规则判定：${created.ruleId} ${created.ruleName} → ${created.status}${created.decisionReason ? `（${created.decisionReason}）` : ""}`);

    section("③ 收件人在审批前不可下载（安全门槛）");
    const recipientsSeen = (await bootstrap(recipient.cookie));
    const recipientView = findApplication(recipientsSeen, id);
    record(Boolean(recipientView), "收件人在 bootstrap 中看得到该发送单（发给我的）", recipientView ? recipientView.status : "不可见");
    const recipientList = (recipientsSeen.applicationRecipients || []).filter((row) => row.applicationId === id);
    record(recipientList.length === 1 && recipientList[0].email === recipientEmail, "application_recipients 记录了收件人", recipientList.map((row) => row.email).join(",") || "空");
    if (created.status === "PENDING_APPROVAL") {
      const early = await request(`/api/files/${id}`, { cookie: recipient.cookie });
      record(early.status === 403 && String(early.json?.error || "").includes("尚未送达"), "审批通过前收件人下载被拒（403 NOT_DELIVERED）", `HTTP ${early.status} ${early.json?.error || ""}`);
      const noDelivery = (recipientView?.deliveries || []).filter((row) => row.recipientEmail === recipientEmail);
      record(noDelivery.length === 0, "待审批阶段不存在送达记录（收件箱显示待送达）", `记录数 ${noDelivery.length}`);
    } else {
      console.log("    （该文件命中自动通过规则，提交即送达；「审批前不可下载」门槛由渲染前的 403 分支覆盖，此处跳过）");
    }

    section("④ 审批：发起人无权审批，审批人通过后立即送达");
    if (created.status === "PENDING_APPROVAL") {
      const hijack = await request(`/api/applications/${id}/decision`, { method: "POST", cookie: requester.cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
      record(hijack.status === 403, "发起人无法自行审批（403）", `HTTP ${hijack.status} ${hijack.json?.error || ""}`);
      const decision = await request(`/api/applications/${id}/decision`, { method: "POST", cookie: approver.cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve", reason: "回归用例自动审批" }) });
      record(decision.status === 200 && decision.json?.status === "TRANSFERRED", "审批通过后自动送达（TRANSFERRED）", `HTTP ${decision.status} ${decision.json?.status || decision.json?.error || ""}`);
    } else {
      record(created.status === "TRANSFERRED", "命中自动通过规则，免审批直接送达", String(created.status));
    }
    const deliveries = (await bootstrap(requester.cookie)).applications.find((row) => row.id === id)?.deliveries || [];
    record(deliveries.length === 1 && deliveries[0].recipientEmail === recipientEmail, "按收件人生成送达记录（每人一条）", `记录数 ${deliveries.length}`);
    record(deliveries.every((row) => row.enabled && !row.revokedAt), "送达记录初始为有效状态");

    section("⑤ 收件人下载：内容一致 + 留痕 + 收件箱状态");
    const download = await fetch(`${BASE}/api/files/${id}`, { headers: { cookie: recipient.cookie } });
    const bytes = new Uint8Array(await download.arrayBuffer());
    record(download.status === 200, "收件人站内下载成功（会话鉴权）", `HTTP ${download.status}`);
    record(bytes.byteLength === payload.byteLength && (await sha256Hex(bytes)) === expectedHash, "下载内容与上传原文一致（SHA-256）");
    const afterDownload = await bootstrap(recipient.cookie);
    const myDelivery = (afterDownload.applications.find((row) => row.id === id)?.deliveries || []).find((row) => row.recipientEmail === recipientEmail);
    record(Boolean(myDelivery?.firstDownloadedAt), "送达记录写入首次下载时间（收件箱=已下载）", String(myDelivery?.firstDownloadedAt || "未写入"));
    record((myDelivery?.downloadCount || 0) >= 1, "送达记录累加下载次数", String(myDelivery?.downloadCount ?? 0));
    // 审计口径校验需要管理员/审计员会话：--mock-ldap 下直接用兜底管理员，否则用 ADMIN 域账号登录
    const adminSession = USE_MOCK_LDAP ? { status: adminCookie ? 200 : 0, cookie: adminCookie } : await domainSession(ADMIN);
    const auditCookie = adminSession.status === 200 ? adminSession.cookie : "";
    if (auditCookie) {
      const events = (await bootstrap(auditCookie)).downloadEvents || [];
      record(events.some((event) => event.applicationId === id && event.event === "DOWNLOAD_INTERNAL" && event.result === "SUCCESS"), "下载事件本地写入 download_events（DOWNLOAD_INTERNAL）");
    } else {
      console.log(`    （未取得管理员会话，跳过 download_events 校验；可传 --admin 指定审计账号）`);
    }

    section("⑥ 收件箱口径：只看到发给我的");
    const leaked = (recipientsSeen.applicationRecipients || []).filter((row) => !(recipientsSeen.applications || []).some((app) => app.id === row.applicationId));
    record(leaked.length === 0, "普通用户拿不到不可见发送单的收件人明细（bootstrap 按可见性收敛）", `越权 ${leaked.length} 条`);
    // 只看本次创建的发送单：收件人 ≠ 发起人，它不应出现在发起人的「发给我的」里。
    // 不做全量扫描——其他测试（如内容防护专项）可能留下「自发收」单，发起人本来就该看到。
    const mineOnly = (await bootstrap(requester.cookie)).applications.filter((row) => row.id === id && (row.deliveries || []).some((delivery) => delivery.recipientEmail === requesterEmail));
    record(mineOnly.length === 0, "发起人不会把自己的发送单误判为「发给我的」", `误判 ${mineOnly.length} 条`);

    section("⑦ 撤回：立即失效 + 下载被拒");
    const revoke = await request(`/api/applications/${id}/revoke`, { method: "POST", cookie: requester.cookie });
    record(revoke.status === 200 && (revoke.json?.revoked || 0) >= 1, "发起人撤回送达（本地撤回 + 审计）", `HTTP ${revoke.status} revoked=${revoke.json?.revoked ?? "?"}`);
    const afterRevoke = await request(`/api/files/${id}`, { cookie: recipient.cookie });
    record(afterRevoke.status === 403 && String(afterRevoke.json?.error || "").includes("撤回"), "撤回后收件人下载被拒（403 DELIVERY_REVOKED）", `HTTP ${afterRevoke.status} ${afterRevoke.json?.error || ""}`);
    const revokedDelivery = ((await bootstrap(recipient.cookie)).applications.find((row) => row.id === id)?.deliveries || []).find((row) => row.recipientEmail === recipientEmail);
    record(Boolean(revokedDelivery?.revokedAt) && revokedDelivery?.enabled === false, "送达记录标记撤回（enabled=0）", `revokedAt=${revokedDelivery?.revokedAt || "无"} enabled=${revokedDelivery?.enabled}`);
  } finally {
    if (USE_MOCK_LDAP && originalConfig && !KEEP_CONFIG && adminCookie) {
      section("还原：认证源恢复为运行前配置");
      const restore = await request("/api/admin/config", {
        method: "PUT",
        cookie: adminCookie,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ldapName: originalConfig.ldapName || "LDAP",
          ldapHost: originalConfig.ldapHost || "",
          ldapPort: originalConfig.ldapPort || 389,
          ldapLdaps: Boolean(originalConfig.ldapLdaps),
          baseDn: originalConfig.baseDn || "",
          bindDn: originalConfig.bindDn || "",
          ldapFilter: originalConfig.ldapFilter || "",
          ldapGatewayUrl: originalConfig.ldapGatewayUrl || "",
          syncIntervalMinutes: originalConfig.syncIntervalMinutes || 30,
        }),
      });
      record(restore.status === 200, `认证源已还原为 ${originalConfig.ldapHost || "(网关模式)"}`, `HTTP ${restore.status} ${restore.json?.error || ""}`);
    }
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("闭环回归异常：", error);
  process.exit(1);
});
