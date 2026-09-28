#!/usr/bin/env node
// 首次部署引导（bootstrap）：从环境变量直接写入 LDAP 认证源与平台角色，
// 让新部署不必「起容器 → 兜底登录 → 手工点页面」—— 也因此可以进 CI / IaC 无人值守部署。
//
// 写入前会先用给定凭据**真实 bind 一次**：配置写进去却连不上，比写不进去更难排查。
// 写入动作与审计记录（audit_events，哈希链接在既有链之后）同事务提交。
//
// 用法（全部经环境变量传值，避免敏感信息进 shell 历史；值都在 BOOTSTRAP_ 前缀下）：
//   npm run bootstrap                     # 只读：打印将要写入的内容（dry-run）
//   npm run bootstrap -- --yes            # 确认执行（含 bind 验证；验证失败不写库）
//
//   # 容器内执行（环境变量已在容器里，直接叠加 BOOTSTRAP_* 即可）：
//   docker compose exec platform \
//     env BOOTSTRAP_LDAP_HOST=ldap.corp.local \
//         BOOTSTRAP_LDAP_BASE_DN="dc=corp,dc=local" \
//         BOOTSTRAP_LDAP_BIND_DN="cn=readonly,dc=corp,dc=local" \
//         BOOTSTRAP_LDAP_BIND_PASSWORD_FILE=/run/secrets/ldap-bind \
//         BOOTSTRAP_ROLES="zhangsan@example.local:管理员,wangwu@example.local:审批人" \
//     node scripts/bootstrap.mjs --yes
//
// 环境变量：
//   BOOTSTRAP_LDAP_NAME              认证源显示名（默认 Corporate_LDAP）
//   BOOTSTRAP_LDAP_HOST              服务器地址（必填）
//   BOOTSTRAP_LDAP_PORT              端口（默认 ldaps=636 / ldap=389）
//   BOOTSTRAP_LDAP_LDAPS             1/true 使用 LDAPS（默认 false）
//   BOOTSTRAP_LDAP_BASE_DN           Base DN（必填）
//   BOOTSTRAP_LDAP_BIND_DN           绑定 DN（必填）
//   BOOTSTRAP_LDAP_BIND_PASSWORD     绑定口令（与 *_FILE 二选一，优先 FILE）
//   BOOTSTRAP_LDAP_BIND_PASSWORD_FILE 口令文件（取首个非空行；避免口令进环境）
//   BOOTSTRAP_LDAP_FILTER            搜索过滤器（可空，缺省 (objectClass=person)）
//   BOOTSTRAP_SYNC_INTERVAL_MINUTES  自动同步间隔（默认 30，最小 5）
//   BOOTSTRAP_ROLES                  角色清单：`邮箱:角色[,邮箱:角色]`，角色 ∈ 管理员/审批人/审计员/发起人
//
// 注意：
//   * 需要 CONFIG_ENCRYPTION_KEY（口令要加密入库）。
//   * ⚠️ 锁死顺序陷阱与 rekey 相同：若已配置 PLATFORM_ADMIN_EMAILS 且库里**尚无**可用认证源，
//     起容器会被 preflight 拦下（无任何登录路径）。所以要么先跑本脚本再配管理员名单，
//     要么跑完本脚本后立即 up。本脚本会在检测到该组合时显著告警并拒绝只写角色不写认证源的操作。
//   * 建议在平台停止时执行（审计与平台写入同表，避免并发竞争）；探测到平台在运行会告警。

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";
import { encryptSecret, tryDecryptSecret } from "../db/crypto.mjs";
import { auditHash } from "../db/audit-chain.mjs";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const envValue = (name) => (process.env[name] || "").trim();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");

const ROLES = ["管理员", "审批人", "审计员", "发起人"];

function fail(message, ...extra) {
  console.error(`[x] ${message}`);
  for (const line of extra) console.error(`    ${line}`);
  process.exit(1);
}

// ---------- 解析输入 ----------
const plan = {
  ldap: null,
  roles: [],
};

const host = envValue("BOOTSTRAP_LDAP_HOST");
const baseDn = envValue("BOOTSTRAP_LDAP_BASE_DN");
const bindDn = envValue("BOOTSTRAP_LDAP_BIND_DN");
const ldaps = /^1|true$/i.test(envValue("BOOTSTRAP_LDAP_LDAPS"));
const port = Number(envValue("BOOTSTRAP_LDAP_PORT")) || (ldaps ? 636 : 389);
const syncInterval = Math.max(5, Number(envValue("BOOTSTRAP_SYNC_INTERVAL_MINUTES")) || 30);

let bindPassword = "";
const passwordFile = envValue("BOOTSTRAP_LDAP_BIND_PASSWORD_FILE");
if (passwordFile) {
  const abs = path.resolve(passwordFile);
  if (!existsSync(abs)) fail(`口令文件不存在：${abs}`);
  bindPassword =
    readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) || "";
} else {
  bindPassword = envValue("BOOTSTRAP_LDAP_BIND_PASSWORD");
}

if (host) {
  const missing = [!baseDn && "BOOTSTRAP_LDAP_BASE_DN", !bindDn && "BOOTSTRAP_LDAP_BIND_DN", !bindPassword && "BOOTSTRAP_LDAP_BIND_PASSWORD(_FILE)"].filter(Boolean);
  if (missing.length) fail(`要写入 LDAP 认证源，还缺：${missing.join("、")}`);
  plan.ldap = {
    id: "ldap",
    ldapName: envValue("BOOTSTRAP_LDAP_NAME") || "Corporate_LDAP",
    ldapHost: host,
    ldapPort: port,
    ldapLdaps: ldaps ? 1 : 0,
    ldapFilter: envValue("BOOTSTRAP_LDAP_FILTER") || null,
    baseDn,
    bindDn,
    bindPassword,
    syncIntervalMinutes: syncInterval,
    label: `${ldaps ? "ldaps" : "ldap"}://${host}:${port}`,
  };
}

const rolesRaw = envValue("BOOTSTRAP_ROLES");
if (rolesRaw) {
  for (const part of rolesRaw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [email, ...rest] = trimmed.split(":");
    const role = rest.join(":").trim();
    const mail = email.trim().toLowerCase();
    if (!mail.includes("@")) fail(`BOOTSTRAP_ROLES 里的邮箱无效：${mail}`);
    if (!ROLES.includes(role)) fail(`BOOTSTRAP_ROLES 里的角色无效：${role}（可用：${ROLES.join("/")}）`);
    plan.roles.push({ email: mail, role });
  }
}

if (!plan.ldap && !plan.roles.length) {
  fail(
    "没有提供任何要写入的内容。",
    "至少设置 BOOTSTRAP_LDAP_HOST（写认证源）或 BOOTSTRAP_ROLES（写角色）。",
    "变量清单见文件头注释，或查看文档《部署》中 bootstrap 一节。",
  );
}

// ---------- 读取现状 ----------
if (!existsSync(dbFile)) {
  fail(
    `数据库不存在：${dbFile}`,
    "全新部署先启动一次平台（自动迁移），或跑 npm run db:migrate 生成库。",
  );
}

let encryptionKey = (process.env.CONFIG_ENCRYPTION_KEY || "").trim();
if (!encryptionKey) fail("缺少 CONFIG_ENCRYPTION_KEY —— 绑定口令需要加密入库。本地跑请用 npm run bootstrap（自动加载 .env）。");

const db = openSqlite(dbFile);

let current = null;
try {
  current = db.prepare("SELECT * FROM integration_settings WHERE id = 'ldap'").get() || null;
} catch {
  current = null;
}
const currentConfigured = Boolean(current && current.ldapHost && current.encryptedSecret);

// 锁死顺序陷阱检测（见文件头）：只写角色、不提供认证源，而管理员名单已配置且库里没有可用认证源
const adminEmails = (process.env.PLATFORM_ADMIN_EMAILS || "").trim();
if (!plan.ldap && !currentConfigured && adminEmails) {
  fail(
    "检测到锁死组合：PLATFORM_ADMIN_EMAILS 已配置，但库里没有任何可用的 LDAP 认证源。",
    "此时平台启动后没有任何登录路径（兜底管理员仅在名单未配置时生效）。",
    "处理：本次把 BOOTSTRAP_LDAP_HOST 一并写入，或先清空 PLATFORM_ADMIN_EMAILS。",
  );
}

const platformRunning = await (async () => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || "8787"}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
})();

// ---------- 打印计划 ----------
console.log("首次部署引导（bootstrap）");
console.log(`  数据库              = ${dbFile}`);
console.log(`  管理员名单          = ${adminEmails ? `已配置（${adminEmails.split(",").length} 个）` : "未配置（兜底管理员生效，联调态）"}`);
console.log(`  现有认证源          = ${currentConfigured ? `已配置（${current.ldapHost}，本次将被覆盖）` : "未配置"}`);
console.log(`  平台运行状态        = ${platformRunning ? "⚠️ 8787 端口有平台在运行（建议停机后执行，避免审计并发）" : "未检测到"}`);
console.log("");
if (plan.ldap) {
  console.log("将要写入的 LDAP 认证源：");
  console.log(`  名称      = ${plan.ldap.ldapName}`);
  console.log(`  地址      = ${plan.ldap.label}`);
  console.log(`  LDAPS     = ${plan.ldap.ldapLdaps ? "是" : "否"}`);
  console.log(`  Base DN   = ${plan.ldap.baseDn}`);
  console.log(`  绑定 DN   = ${plan.ldap.bindDn}`);
  console.log(`  绑定口令  = ${"*".repeat(Math.min(bindPassword.length, 8))}（${bindPassword.length} 字符，加密入库）`);
  console.log(`  过滤器    = ${plan.ldap.ldapFilter || "（缺省 (objectClass=person)）"}`);
  console.log(`  同步间隔  = ${plan.ldap.syncIntervalMinutes} 分钟`);
}
if (plan.roles.length) {
  console.log("将要写入的平台角色：");
  for (const item of plan.roles) console.log(`  ${item.email} → ${item.role}`);
}
console.log("");

if (!hasFlag("--yes")) {
  console.log("[i] 以上是 dry-run 计划，未写入任何数据。确认无误后追加 --yes 执行。");
  db.close();
  process.exit(0);
}

// ---------- bind 验证（写认证源时必做；--skip-verify 仅限确认网络不可达的场景） ----------
if (plan.ldap && !hasFlag("--skip-verify")) {
  console.log(`正在用给定凭据验证 bind（${plan.ldap.label}）…`);
  try {
    const { Client } = await import("ldapts");
    // ⚠️ tlsOptions 只能随 ldaps 一起传：ldapts 一旦收到 tlsOptions，明文 ldap:// 也会按
    // TLS socket 建连，直接挂到 connectTimeout（实测如此）。这正是平台连接层分开传的原因。
    const client = new Client({
      url: `${ldaps ? "ldaps" : "ldap"}://${host}:${port}`,
      timeout: 10_000,
      connectTimeout: 10_000,
      ...(ldaps ? { tlsOptions: { rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== "false" } } : {}),
    });
    try {
      await client.bind(bindDn, bindPassword);
    } finally {
      await client.unbind().catch(() => {});
    }
    console.log("  [OK] bind 成功。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Invalid Credentials|invalidDnCredentials|data 52e|49/i.test(message)) {
      fail("bind 失败：凭据被拒绝（绑定 DN 或口令不正确）。未写入任何数据。");
    }
    fail(`bind 失败：${message}`, "未写入任何数据。若确认是网络暂时不可达且你接受风险，可加 --skip-verify 跳过验证。");
  }
}

// ---------- 事务写入 ----------
async function appendAudit(entries) {
  // 审计与业务写入同事务。哈希链必须逐条衔接，因此顺序处理。
  let previousHash = null;
  try {
    const previous = db.prepare("SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1").get();
    previousHash = previous ? previous.hash : null;
  } catch {
    return; // 审计表不存在（很旧的库）：不阻断写入
  }
  for (const entry of entries) {
    const at = new Date().toISOString();
    const hash = await auditHash({ previousHash, at, actorId: "cli:bootstrap", action: entry.action, objectId: entry.objectId, result: "SUCCESS", detail: entry.detail });
    db.prepare(
      `INSERT INTO audit_events (id, at, actor_id, actor_email, actor_display, action, object_id, result, detail, previous_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), at, "cli:bootstrap", null, "运维 CLI（部署引导）", entry.action, entry.objectId, "SUCCESS", entry.detail, previousHash, hash);
    previousHash = hash;
  }
}

try {
  db.exec("BEGIN IMMEDIATE");

  if (plan.ldap) {
    const encrypted = await encryptSecret(plan.ldap.bindPassword, encryptionKey);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO integration_settings
         (id, ldap_name, ldap_host, ldap_port, ldap_ldaps, ldap_filter, base_dn, bind_dn, encrypted_secret, sync_interval_minutes, updated_at)
       VALUES ('ldap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ldap_name = excluded.ldap_name, ldap_host = excluded.ldap_host, ldap_port = excluded.ldap_port,
         ldap_ldaps = excluded.ldap_ldaps, ldap_filter = excluded.ldap_filter, base_dn = excluded.base_dn,
         bind_dn = excluded.bind_dn, encrypted_secret = excluded.encrypted_secret,
         sync_interval_minutes = excluded.sync_interval_minutes, updated_at = excluded.updated_at`,
    ).run(
      plan.ldap.ldapName,
      plan.ldap.ldapHost,
      plan.ldap.ldapPort,
      plan.ldap.ldapLdaps,
      plan.ldap.ldapFilter,
      plan.ldap.baseDn,
      plan.ldap.bindDn,
      encrypted,
      plan.ldap.syncIntervalMinutes,
      now,
    );
    // 写入后立即回读解密校验：口令存进去却解不开（密钥口径不一致）是最坏的情况
    const row = db.prepare("SELECT encrypted_secret FROM integration_settings WHERE id = 'ldap'").get();
    const echoed = await tryDecryptSecret(row.encrypted_secret, encryptionKey);
    if (!echoed.ok || echoed.value !== plan.ldap.bindPassword) {
      throw new Error("认证源口令写入后回读校验失败（加密/解密口径不一致？）");
    }
    await appendAudit([
      { action: "部署引导写入 LDAP 配置", objectId: "LDAP", detail: `直连 ${plan.ldap.label}；绑定 DN ${plan.ldap.bindDn}${currentConfigured ? "（覆盖原配置）" : ""}` },
    ]);
  }

  if (plan.roles.length) {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO role_assignments (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    );
    const auditEntries = [];
    for (const item of plan.roles) {
      upsert.run(item.email, item.email, item.role, now, now);
      auditEntries.push({ action: "配置平台角色", objectId: item.email, detail: item.role });
    }
    await appendAudit(auditEntries);
  }

  db.exec("COMMIT");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // 事务可能已自动回滚
  }
  fail(`写入失败，已回滚，数据库保持原状：${error instanceof Error ? error.message : String(error)}`);
}

console.log("");
console.log("[已执行] 配置已写入并提交（审计留痕：操作者「运维 CLI（部署引导）」）。");
console.log("接下来：");
if (!plan.ldap || !currentConfigured) console.log("  * 启动/重启平台后，用管理员账号登录「LDAP 与权限」页点一次「同步用户」，用户数据即可进入平台。");
console.log("  * 确认登录正常后再配置 PLATFORM_ADMIN_EMAILS 收紧兜底入口（顺序反了会被 preflight 拦下）。");
db.close();
