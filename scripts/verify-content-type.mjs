#!/usr/bin/env node
// 内容类型防伪装专项回归（对应 CONTENT-TYPE-GUARD.md §5 验收用例 TC-01~TC-12）：
//   改后缀拒绝（格式不正确）→ 未知类型转人工 → 预判与提交同引擎同结论 → 档位开关（normal/strict/off）
//
// 运行（平台需已启动）：
//   node scripts/verify-content-type.mjs --mock-ldap
//   node scripts/verify-content-type.mjs --base http://127.0.0.1:8787 --requester lisi
//
// --mock-ldap：先以本地兜底管理员会话把 LDAP 认证源临时指向 127.0.0.1:3890 的 mock LDAP，
// 跑完后自动还原认证源与「内容类型防护」档位（不覆盖原密码）。口令默认取账号名（mock 约定）。
// 本脚本会真实写入发送单/审计，只能打验收或开发环境。

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
const RECIPIENT = argValue("recipient", "zhaoliu");
const ADMIN = argValue("admin", "zhangsan");
const USE_MOCK_LDAP = args.includes("--mock-ldap");
const MOCK_HOST = argValue("mock-host", "127.0.0.1");
const MOCK_PORT = Number(argValue("mock-port", "3890"));
const MOCK_BASE_DN = argValue("mock-base-dn", "dc=example,dc=local");
const MOCK_BIND_DN = `cn=admin,${MOCK_BASE_DN}`;
const BIG_SIZE = Number(argValue("big-size", String(5 * 1024 * 1024)));

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
  return { status: response.status, json, headers: response.headers };
}

async function login(payload) {
  const result = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ...result, cookie: (result.headers.get("set-cookie") || "").split(";")[0] };
}

// —— 样本构造（首部签名决定嗅探结果，尾部填充随机避免被误判为文本） ——
function sample(headerBytes, totalSize, seeded = true) {
  const bytes = new Uint8Array(totalSize);
  bytes.set(headerBytes, 0);
  let state = seeded ? 0x2545f491 : 0x12345678;
  for (let i = headerBytes.length; i < totalSize; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}
const PDF_HEAD = Array.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", (c) => c.charCodeAt(0));
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00];
const EXE_HEAD = Array.from("MZ", (c) => c.charCodeAt(0));
const TEXT_HEAD = Array.from("Patient name,birth date,department\nZhang San,1990-01-01,Cardiology\n", (c) => c.charCodeAt(0));

async function preview(cookie, fileName, sizeBytes, bytes) {
  const firstBytes = Array.from(bytes.slice(0, 512), (b) => b.toString(16).padStart(2, "0")).join("");
  return request("/api/rules/preview", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName, sizeBytes, firstBytes }),
  });
}

async function submit(cookie, fileName, bytes) {
  const recipients = argValue("recipient-email", "") || process.env.E2E_RECIPIENT_EMAIL || "";
  const search = new URLSearchParams({ fileName, recipients, description: "内容类型防护专项回归" });
  const response = await fetch(`${BASE}/api/applications?${search.toString()}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
    body: bytes,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

const GUARDS = ["normal", "strict", "off"];

async function main() {
  const health = await request("/api/auth/me");
  if (health.status === 0 || (health.status >= 500 && !health.json)) {
    console.error(`平台不可达：${BASE}`);
    process.exit(1);
  }

  let adminCookie = "";
  let originalConfig = null;
  let originalGuard = "normal";
  if (USE_MOCK_LDAP) {
    section("准备：本地兜底管理员 + 临时切 mock LDAP");
    const fallback = await login({ local: true });
    record(fallback.status === 200, "本地兜底管理员登录", `HTTP ${fallback.status} ${fallback.json?.error || ""}`);
    if (fallback.status !== 200) process.exit(1);
    adminCookie = fallback.cookie;
    const config = await request("/api/admin/config", { cookie: adminCookie });
    originalConfig = config.json?.ldap || null;
    originalGuard = config.json?.ldap?.contentTypeGuard || "normal";
    const put = await request("/api/admin/config", {
      method: "PUT",
      cookie: adminCookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ldapName: "Mock_LDAP", ldapHost: MOCK_HOST, ldapPort: MOCK_PORT, ldapLdaps: false, baseDn: MOCK_BASE_DN, bindDn: MOCK_BIND_DN, ldapFilter: "(objectClass=person)", syncIntervalMinutes: 30 }),
    });
    record(put.status === 200, `认证源切到 mock LDAP ${MOCK_HOST}:${MOCK_PORT}`, `HTTP ${put.status} ${put.json?.error || ""}`);
    const adminEmail = ADMIN.includes("@") ? ADMIN : `${ADMIN}@example.local`;
    const requesterEmail = REQUESTER.includes("@") ? REQUESTER : `${REQUESTER}@example.local`;
    const currentRoles = new Map((((await request("/api/admin/config", { cookie: adminCookie })).json?.roles) || []).map((row) => [row.email, row.role]));
    for (const [email, role] of [[adminEmail, "管理员"], [requesterEmail, "发起人"]]) {
      if (currentRoles.get(email) !== role) {
        await request("/api/admin/roles", { method: "POST", cookie: adminCookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ email, displayName: email.split("@")[0], role }) });
      }
    }
    record(true, "平台角色已就绪");
    const requester = await login({ account: REQUESTER, password: credential(REQUESTER, "requester") });
    record(requester.status === 200, `发起人 ${REQUESTER} 登录`, `HTTP ${requester.status} ${requester.json?.error || ""}`);
    if (requester.status !== 200) process.exit(1);
    const recipient = await login({ account: RECIPIENT, password: credential(RECIPIENT, "recipient") });
    record(recipient.status === 200, `收件人 ${RECIPIENT} 登录（自发收会污染收件箱口径回归，改用独立收件人）`, `HTTP ${recipient.status} ${recipient.json?.error || ""}`);
    if (recipient.status !== 200) process.exit(1);
    process.env.E2E_RECIPIENT_EMAIL = recipient.json?.email || `${RECIPIENT}@example.local`;
    await runTests(requester.cookie, adminCookie, "", originalGuard);
    // 还原认证源（不提交 secret：沿用已存储口令）
    if (originalConfig) {
      const restore = await request("/api/admin/config", {
        method: "PUT",
        cookie: adminCookie,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ldapName: originalConfig.ldapName, ldapHost: originalConfig.ldapHost, ldapPort: originalConfig.ldapPort, ldapLdaps: originalConfig.ldapLdaps, baseDn: originalConfig.baseDn, bindDn: originalConfig.bindDn, ldapGatewayUrl: originalConfig.ldapGatewayUrl, ldapFilter: originalConfig.ldapFilter, syncIntervalMinutes: originalConfig.syncIntervalMinutes }),
      });
      record(restore.status === 200, "认证源已还原", `HTTP ${restore.status}`);
    }
  } else {
    const requester = await login({ account: REQUESTER, password: credential(REQUESTER, "requester") });
    if (requester.status !== 200) {
      console.error(`发起人登录失败：HTTP ${requester.status} ${requester.json?.error || ""}`);
      process.exit(1);
    }
    const admin = await login({ account: ADMIN, password: credential(ADMIN, "admin") });
    if (admin.status !== 200) {
      console.error(`管理员登录失败：HTTP ${admin.status} ${admin.json?.error || ""}`);
      process.exit(1);
    }
    const recipient = await login({ account: RECIPIENT, password: credential(RECIPIENT, "recipient") });
    if (recipient.status !== 200) {
      console.error(`收件人登录失败：HTTP ${recipient.status} ${recipient.json?.error || ""}`);
      process.exit(1);
    }
    process.env.E2E_RECIPIENT_EMAIL = recipient.json?.email || `${RECIPIENT}@example.local`;
    await runTests(requester.cookie, admin.cookie, "", "normal");
  }
}

async function runTests(cookie, adminCookie, requesterEmail, originalGuard) {
  try {
    section("TC-01 真 PDF + .pdf：与现状一致，不误伤");
    const pdfBytes = sample(PDF_HEAD, 64 * 1024);
    const p1 = await preview(cookie, "报告.pdf", pdfBytes.byteLength, pdfBytes);
    record(p1.status === 200 && p1.json?.detectedKind === "pdf" && p1.json?.typeMismatch === false && p1.json?.verdict !== "reject",
      "TC-01 预判：识别为 pdf，typeMismatch=false", `verdict=${p1.json?.verdict} kind=${p1.json?.detectedKind} mismatch=${p1.json?.typeMismatch}`);
    const s1 = await submit(cookie, "报告.pdf", pdfBytes);
    record(s1.status === 201 && !String(s1.json?.error || "").includes("格式不正确"),
      "TC-01 提交：不被内容防护拒绝", `HTTP ${s1.status} ${s1.json?.error || s1.json?.id || ""}`);

    section("TC-02/03/07 改后缀 → 拒绝（格式不正确）");
    const s2 = await submit(cookie, "合同.bin", pdfBytes);
    record(s2.status === 403 && String(s2.json?.error || "").includes("格式不正确"), "TC-02 PDF 装进 .bin：提交 403 拒绝", `HTTP ${s2.status} ${s2.json?.error || ""}`);
    const p2 = await preview(cookie, "合同.bin", pdfBytes.byteLength, pdfBytes);
    record(p2.json?.verdict === "reject" && p2.json?.detectedKind === "pdf" && p2.json?.typeMismatch === true,
      "TC-02 预判同判：reject / kind=pdf / mismatch=true", `verdict=${p2.json?.verdict} kind=${p2.json?.detectedKind}`);
    const zipBytes = sample(ZIP_HEAD, 64 * 1024);
    const p3 = await preview(cookie, "表格.bin", zipBytes.byteLength, zipBytes);
    record(p3.json?.verdict === "reject" && p3.json?.detectedKind === "zip-container",
      "TC-03 docx(ZIP) 装进 .bin：reject / kind=zip-container", `verdict=${p3.json?.verdict} kind=${p3.json?.detectedKind}`);
    const s7 = await submit(cookie, "报表.pdf.bin", pdfBytes);
    record(s7.status === 403 && String(s7.json?.error || "").includes("格式不正确"), "TC-07 双扩展名 报表.pdf.bin：按真实末段 bin 判 403", `HTTP ${s7.status} ${s7.json?.error || ""}`);

    section("TC-05/06 可执行/文本伪装 → 拒绝；文本 + .txt 正常");
    const exeBytes = sample(EXE_HEAD, 64 * 1024);
    const p5 = await preview(cookie, "说明.txt", exeBytes.byteLength, exeBytes);
    record(p5.json?.verdict === "reject" && p5.json?.typeMismatch === true, "TC-05 MZ 可执行装进 .txt：reject", `verdict=${p5.json?.verdict} kind=${p5.json?.detectedKind}`);
    // 纯文本样本：全文件都必须是可打印字符，looksLikeText 才会命中
    const textBytes = new Uint8Array(16 * 1024);
    textBytes.set(TEXT_HEAD, 0);
    for (let i = TEXT_HEAD.length; i < textBytes.length; i += 1) textBytes[i] = 0x20 + ((i * 13) % 0x5f);
    const p6a = await preview(cookie, "清单.docx", textBytes.byteLength, textBytes);
    record(p6a.json?.verdict === "reject" && p6a.json?.typeMismatch === true, "TC-06 纯文本装进 .docx：reject", `verdict=${p6a.json?.verdict} kind=${p6a.json?.detectedKind}`);
    const p6b = await preview(cookie, "清单.txt", textBytes.byteLength, textBytes);
    record(p6b.json?.verdict !== "reject" && p6b.json?.typeMismatch === false, "TC-06 对照：纯文本 + .txt 不拒", `verdict=${p6b.json?.verdict} kind=${p6b.json?.detectedKind}`);

    section("TC-04/08 未知类型 → 转人工；预判与提交结论一致");
    const randomBytes = sample([0x00], 64 * 1024, true);
    randomBytes[0] = 0x7a; randomBytes[1] = 0x9f; randomBytes[2] = 0xc3; // 避开已知签名前缀
    const p4 = await preview(cookie, "数据.bin", randomBytes.byteLength, randomBytes);
    record(p4.json?.detectedKind === "unknown" && p4.json?.verdict === "manual" && String(p4.json?.fallbackReason || p4.json?.rejectReason || "").includes("未知"),
      "TC-04 随机字节 .bin：unknown → 转人工", `verdict=${p4.json?.verdict} kind=${p4.json?.detectedKind}`);
    const s4 = await submit(cookie, "数据.bin", randomBytes);
    record(s4.status === 201 && s4.json?.status === "PENDING_APPROVAL", "TC-04 提交：201 转人工（与预判一致）", `HTTP ${s4.status} ${s4.json?.status || s4.json?.error || ""}`);
    record(s4.json?.detectedKind === "unknown", "TC-08 提交落库 detectedKind=unknown（同引擎同签名表）", `kind=${s4.json?.detectedKind} mismatch=${s4.json?.typeMismatch}`);

    section("TC-12 老数据与既有列表不受影响");
    const boot = await request("/api/bootstrap", { cookie });
    record(boot.status === 200 && Array.isArray(boot.json?.applications), "TC-12 bootstrap 正常返回（老记录新列可空不报错）", `HTTP ${boot.status} 条数=${boot.json?.applications?.length ?? "n/a"}`);

    section("TC-09 strict 档：未知类型也拒绝");
    const setStrict = await request("/api/admin/config", { method: "PUT", cookie: adminCookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ contentTypeGuard: "strict" }) });
    record(setStrict.status === 200 && setStrict.json?.contentTypeGuard === "strict", "管理页接口切到 strict", `HTTP ${setStrict.status} ${setStrict.json?.error || ""}`);
    const p9 = await preview(cookie, "数据.bin", randomBytes.byteLength, randomBytes);
    record(p9.json?.verdict === "reject", "TC-09 未知类型预判 = reject", `verdict=${p9.json?.verdict} reason=${p9.json?.rejectReason || ""}`);
    const s9 = await submit(cookie, "数据2.bin", randomBytes);
    record(s9.status === 403, "TC-09 未知类型提交 403", `HTTP ${s9.status} ${s9.json?.error || ""}`);

    section("TC-10 off 档：只记录不拦截，回落到只看后缀");
    const setOff = await request("/api/admin/config", { method: "PUT", cookie: adminCookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ contentTypeGuard: "off" }) });
    record(setOff.status === 200 && setOff.json?.contentTypeGuard === "off", "管理页接口切到 off", `HTTP ${setOff.status} ${setOff.json?.error || ""}`);
    const p10 = await preview(cookie, "合同.bin", pdfBytes.byteLength, pdfBytes);
    record(p10.json?.verdict !== "reject" && p10.json?.typeMismatch === true, "TC-10 预判：不拒但仍标记 mismatch=true", `verdict=${p10.json?.verdict} mismatch=${p10.json?.typeMismatch}`);
    const s10 = await submit(cookie, "合同2.bin", pdfBytes);
    record(s10.status === 201 && s10.json?.typeMismatch === true && s10.json?.detectedKind === "pdf",
      "TC-10 提交：201 且落库保留嗅探结果（kind=pdf/mismatch=true）", `HTTP ${s10.status} kind=${s10.json?.detectedKind} mismatch=${s10.json?.typeMismatch}`);

    section("TC-11 较大文件：嗅探不影响流式上传");
    const bigBytes = sample([0x7a, 0x9f, 0xc3, 0x11], BIG_SIZE, true);
    const s11 = await submit(cookie, "大数据.bin", bigBytes);
    record(s11.status === 201 && s11.json?.sizeBytes === bigBytes.byteLength, `TC-11 ${(BIG_SIZE / 1024 / 1024).toFixed(0)}MB 流式直传成功`, `HTTP ${s11.status} size=${s11.json?.sizeBytes ?? "n/a"}`);
  } finally {
    section("还原：防护档位恢复为运行前配置");
    const restore = await request("/api/admin/config", { method: "PUT", cookie: adminCookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ contentTypeGuard: originalGuard }) });
    record(restore.status === 200, `防护档位已还原为 ${originalGuard}`, `HTTP ${restore.status} ${restore.json?.error || ""}`);
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("执行异常：", error);
  process.exit(1);
});
