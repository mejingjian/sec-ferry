#!/usr/bin/env node
// 邮件通知端到端回归（对应任务 ⑥：审批待办通知 + 收件通知，内网 SMTP）：
//   ① 管理员配置 SMTP（指向本脚本内嵌的 mock SMTP 服务器）→ 测试发送
//   ② 故障演练：SMTP 指向不可达端口时提交转人工发送单 → 提交必须成功（发送失败不阻断主流程）
//   ③ 恢复配置 → 积压的审批待办通知补发到 mock SMTP（重试队列生效）
//   ④ 审批通过 → 收件通知发到收件人邮箱（送达通知挂接生效）
//
// 运行（平台需已启动；本脚本会真实写入发送单/角色/邮件配置，只能打开发/验收环境）：
//   node scripts/test-mail-notify.mjs --mock-ldap          # 容器栈（openldap 389，口令 Passw0rd!<账号>）
//   node scripts/test-mail-notify.mjs --base http://127.0.0.1:8787 --smtp-host 127.0.0.1
//
// --smtp-host 是「平台应用侧」看到的 mock SMTP 地址：打容器实例时用默认 host.docker.internal，
// 打本地（local:start）实例时传 127.0.0.1。mock SMTP 始终监听在本机 127.0.0.1:2525。
// 结束时自动把邮件配置恢复为运行前状态（密码不覆盖原值）。

import net from "node:net";

const args = process.argv.slice(2);
function argValue(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return process.env[`MAIL_${name.replace(/-/g, "_").toUpperCase()}`] ?? fallback;
}

const BASE = argValue("base", "http://127.0.0.1:8787").replace(/\/$/, "");
const REQUESTER = argValue("requester", "lisi");
const APPROVER = argValue("approver", "wangwu");
const RECIPIENT = argValue("recipient", "zhaoliu");
const MAIL_DOMAIN = argValue("mail-domain", "example.local");
const SMTP_PORT = Number(argValue("smtp-port", "2525"));
// 应用侧访问 mock SMTP 的主机名：容器实例 → host.docker.internal；本地实例 → 127.0.0.1
const SMTP_HOST_FOR_APP = argValue("smtp-host", "host.docker.internal");
const SMTP_FROM = argValue("smtp-from", "transfer-platform@test.local");
// 容器栈 openldap 口令约定：Passw0rd!<账号名>；--password 可整体覆盖
const password = (account) => argValue("password") || `Passw0rd!${account}`;
const DEAD_PORT = Number(argValue("dead-port", "2599"));
const SIZE = 300 * 1024;

const requesterEmail = `${REQUESTER}@${MAIL_DOMAIN}`;
const approverEmail = `${APPROVER}@${MAIL_DOMAIN}`;
const recipientEmail = `${RECIPIENT}@${MAIL_DOMAIN}`;

let passed = 0;
let failed = 0;
function record(ok, label, detail = "") {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n— ${title} —`);
}

// ---------- 内嵌 mock SMTP 服务器（只实现收信所需的最小状态机） ----------
const received = []; // { to, subject, subjectDecoded, at }
let server;
function startMockSmtp() {
  return new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 mock-smtp ready\r\n");
      let buffer = "";
      let inData = false;
      let current = null;
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\r\n");
          if (index < 0) return;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              const subject = (current.raw.match(/^Subject: (.*)$/m) || [])[1] || "";
              const decoded = subject.replace(/=\?UTF-8\?B\?(.*?)\?=/g, (_, b64) => Buffer.from(b64, "base64").toString("utf8"));
              received.push({ to: current.to, subject, subjectDecoded: decoded, at: new Date().toISOString() });
              socket.write("250 OK queued\r\n");
              continue;
            }
            current.raw += (line.startsWith("..") ? line.slice(1) : line) + "\n";
            continue;
          }
          const verb = line.toUpperCase();
          if (verb.startsWith("EHLO") || verb.startsWith("HELO")) socket.write("250-mock-smtp\r\n250 8BITMIME\r\n");
          else if (verb.startsWith("MAIL FROM:")) { current = { raw: "", to: null }; socket.write("250 OK\r\n"); }
          else if (verb.startsWith("RCPT TO:")) { current.to = line.slice(8).trim().replace(/^<|>$/g, ""); socket.write("250 OK\r\n"); }
          else if (verb === "DATA") { inData = true; socket.write("354 go ahead\r\n"); }
          else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
          else if (verb === "RSET" || verb === "NOOP") socket.write("250 OK\r\n");
          else socket.write("250 OK\r\n");
        }
      });
      socket.on("error", () => socket.destroy());
    });
    server.once("error", reject);
    server.listen(SMTP_PORT, "127.0.0.1", () => resolve());
  });
}

async function waitForMail(predicate, timeoutMs = 15000, expect = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = received.filter(predicate);
    if (matched.length >= expect) return matched;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return received.filter(predicate);
}

// ---------- HTTP 助手 ----------
async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers || {}) },
    body: options.body,
  });
  const contentType = response.headers.get("content-type") || "";
  const json = contentType.includes("json") ? await response.json().catch(() => ({})) : null;
  return { status: response.status, json };
}
async function login(payload) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}
async function domainSession(account) {
  return login({ account, password: password(account) });
}
async function adminSession() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}

async function putMailConfig(cookie, config) {
  return request("/api/admin/mail-config", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(config) });
}

async function main() {
  const probe = await request("/api/auth/me");
  if (probe.status === 0 || (probe.status >= 500 && !probe.json)) {
    console.error(`平台不可达：${BASE}`);
    process.exit(1);
  }
  await startMockSmtp();
  console.log(`mock SMTP 已监听 127.0.0.1:${SMTP_PORT}（应用侧地址：${SMTP_HOST_FOR_APP}）`);

  let admin;
  try {
    admin = await adminSession();
  } finally { /* 统一在下面判断 */ }
  if (admin.status !== 200) {
    console.error(`本地兜底管理员登录失败（HTTP ${admin.status}）：本脚本需要未配置 PLATFORM_ADMIN_EMAILS 的开发/验收实例`);
    server?.close();
    process.exit(1);
  }
  const { cookie: adminCookie } = admin;

  let originalConfig = null;
  try {
    originalConfig = (await request("/api/admin/mail-config", { cookie: adminCookie })).json;
  } catch { /* 保持 null */ }

  try {
    section("① SMTP 配置与测试发送");
    const saved = await putMailConfig(adminCookie, { smtpHost: SMTP_HOST_FOR_APP, smtpPort: SMTP_PORT, smtpSecure: false, smtpFrom: SMTP_FROM });
    record(saved.status === 200, "SMTP 配置保存成功", `HTTP ${saved.status} ${saved.json?.error || ""}`);
    const testSend = await request("/api/admin/mail-config", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ to: approverEmail }) });
    record(testSend.status === 200, "管理员测试发送成功", `HTTP ${testSend.status} ${testSend.json?.error || ""}`);
    const got = await waitForMail((mail) => mail.to === approverEmail && mail.subjectDecoded.includes("测试邮件"), 8000);
    record(got.length >= 1, "mock SMTP 收到测试邮件", `收到 ${got.length} 封`);

    section("② 故障演练：SMTP 不可达时提交不阻断");
    const dead = await putMailConfig(adminCookie, { smtpHost: SMTP_HOST_FOR_APP, smtpPort: DEAD_PORT, smtpSecure: false, smtpFrom: SMTP_FROM });
    record(dead.status === 200, "邮件配置临时指向不可达端口", `HTTP ${dead.status}`);
    // 确保审批人角色存在（兜底通知名单 / 后续审批会话）
    await request("/api/admin/roles", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ email: approverEmail, displayName: APPROVER, role: "审批人" }) });
    const requester = await domainSession(REQUESTER);
    record(requester.status === 200, `发起人 ${requesterEmail} 登录`, `HTTP ${requester.status} ${requester.body?.error || ""}`);
    if (requester.status !== 200) return;
    const payload = Buffer.alloc(SIZE);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 251;
    const search = new URLSearchParams({ fileName: "mail-e2e.e2e", recipients: recipientEmail, description: "邮件通知回归" });
    const submit = await fetch(`${BASE}/api/applications?${search.toString()}`, {
      method: "POST",
      headers: { cookie: requester.cookie, "content-type": "application/octet-stream" },
      body: payload,
    });
    const submitBody = await submit.json().catch(() => ({}));
    record(submit.status === 201 && submitBody.status === "PENDING_APPROVAL", "SMTP 故障下提交转人工发送单仍成功", `HTTP ${submit.status} status=${submitBody.status || submitBody.error}`);
    const appId = submitBody.id;
    if (!appId) return;

    section("③ 恢复配置 → 积压审批待办通知补发");
    await putMailConfig(adminCookie, { smtpHost: SMTP_HOST_FOR_APP, smtpPort: SMTP_PORT, smtpSecure: false, smtpFrom: SMTP_FROM });
    // 测试发送接口会顺手消费积压队列（管理员修完配置后的典型动作）
    await request("/api/admin/mail-config", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({}) });
    const approvalMails = await waitForMail((mail) => mail.to === approverEmail && mail.subjectDecoded.includes(appId), 15000);
    record(approvalMails.length >= 1, "审批待办通知已补发（重试队列生效）", `收到 ${approvalMails.length} 封，主题含 ${appId}`);
    record(approvalMails[0]?.subjectDecoded.includes("等待审批"), "审批待办通知主题正确", approvalMails[0]?.subjectDecoded || "");

    section("④ 审批通过 → 收件通知");
    const approver = await domainSession(APPROVER);
    record(approver.status === 200, `审批人 ${approverEmail} 登录`, `HTTP ${approver.status} ${approver.body?.error || ""}`);
    if (approver.status !== 200) return;
    const decision = await request(`/api/applications/${appId}/decision`, { method: "POST", headers: { "content-type": "application/json", cookie: approver.cookie }, body: JSON.stringify({ decision: "approve" }) });
    record(decision.status === 200 && decision.json?.status === "TRANSFERRED", "审批通过并送达", `HTTP ${decision.status} status=${decision.json?.status || decision.json?.error}`);
    const deliveredMails = await waitForMail((mail) => mail.to === recipientEmail && mail.subjectDecoded.includes(appId), 15000);
    record(deliveredMails.length >= 1, "收件通知已发送到收件人邮箱", `收到 ${deliveredMails.length} 封`);
    record(deliveredMails[0]?.subjectDecoded.includes("向您发送"), "收件通知主题正确", deliveredMails[0]?.subjectDecoded || "");

    section("⑤ outbox 统计一致性");
    const after = await request("/api/admin/mail-config", { cookie: adminCookie });
    record(typeof after.json?.stats?.sent === "number" && after.json.stats.sent >= 2, "outbox 已发送计数 ≥ 本轮 2 封队列邮件（测试邮件不走队列）", JSON.stringify(after.json?.stats || {}));
  } finally {
    // 还原邮件配置（密码留空 = 保留库中已存密文；原配置为空则整段停用）
    if (originalConfig?.smtp?.smtpHost) {
      await putMailConfig(adminCookie, {
        smtpHost: originalConfig.smtp.smtpHost, smtpPort: originalConfig.smtp.smtpPort,
        smtpSecure: Boolean(originalConfig.smtp.smtpSecure), smtpFrom: originalConfig.smtp.smtpFrom,
        smtpUsername: originalConfig.smtp.smtpUsername,
      });
      console.log("\n邮件配置已还原为运行前状态");
    } else {
      await putMailConfig(adminCookie, {});
      console.log("\n运行前未配置邮件通知，已停用并还原");
    }
    server?.close();
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("脚本异常：", error);
  server?.close();
  process.exit(1);
});
