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
//
// 结构说明：解析（planBootstrap，纯函数）与执行（runBootstrap）分开导出，
// 供 scripts/test-bootstrap.mjs 直接在进程内回归 —— 不必派生 node 子进程，
// 在受宿主安全策略限制的环境里也能跑。（直接执行本文件 = CLI，行为见上。）

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";
import { encryptSecret, tryDecryptSecret } from "../db/crypto.mjs";
import { auditHash } from "../db/audit-chain.mjs";

const ROLES = ["管理员", "审批人", "审计员", "发起人"];

/** 预期内的失败（参数缺失、凭据被拒、写入回滚…）：CLI 打印后退出 1，测试直接断言。 */
export class BootstrapError extends Error {
  constructor(message, extra = []) {
    super(message);
    this.name = "BootstrapError";
    this.extra = extra;
  }
}

/**
 * 解析环境变量得到写入计划（纯函数：不碰数据库、不做网络请求）。
 * @param {Record<string, string|undefined>} env
 * @returns {{ ldap: null | { id: string, ldapName: string, ldapHost: string, ldapPort: number,
 *   ldapLdaps: 0|1, ldapFilter: string|null, baseDn: string, bindDn: string, bindPassword: string,
 *   syncIntervalMinutes: number, label: string }, roles: Array<{ email: string, role: string }> }}
 */
export function planBootstrap(env) {
  const envValue = (name) => (env[name] || "").trim();
  const plan = { ldap: null, roles: [] };

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
    if (!existsSync(abs)) throw new BootstrapError(`口令文件不存在：${abs}`);
    bindPassword =
      readFileSync(abs, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#")) || "";
  } else {
    bindPassword = envValue("BOOTSTRAP_LDAP_BIND_PASSWORD");
  }

  if (host) {
    const missing = [
      !baseDn && "BOOTSTRAP_LDAP_BASE_DN",
      !bindDn && "BOOTSTRAP_LDAP_BIND_DN",
      !bindPassword && "BOOTSTRAP_LDAP_BIND_PASSWORD(_FILE)",
    ].filter(Boolean);
    if (missing.length) throw new BootstrapError(`要写入 LDAP 认证源，还缺：${missing.join("、")}`);
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
      if (!mail.includes("@")) throw new BootstrapError(`BOOTSTRAP_ROLES 里的邮箱无效：${mail}`);
      if (!ROLES.includes(role)) throw new BootstrapError(`BOOTSTRAP_ROLES 里的角色无效：${role}（可用：${ROLES.join("/")}）`);
      plan.roles.push({ email: mail, role });
    }
  }

  if (!plan.ldap && !plan.roles.length) {
    throw new BootstrapError(
      "没有提供任何要写入的内容。",
      [
        "至少设置 BOOTSTRAP_LDAP_HOST（写认证源）或 BOOTSTRAP_ROLES（写角色）。",
        "变量清单见文件头注释，或查看文档《部署》中 bootstrap 一节。",
      ],
    );
  }

  return plan;
}

/**
 * 执行引导：读现状 → 打印计划 →（--yes 时）bind 验证 → 同事务写入 + 审计。
 * @param {{ argv?: string[], env?: Record<string, string|undefined>, log?: (line: string) => void }} options
 * @returns {Promise<number>} 退出码（0 成功；失败一律抛 BootstrapError）
 */
export async function runBootstrap({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const hasFlag = (flag) => argv.includes(flag);

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(projectRoot, ".local-data");
  const dbFile = env.DB_FILE ? path.resolve(env.DB_FILE) : path.join(dataDir, "db", "platform.db");

  // ---------- 解析输入 ----------
  const plan = planBootstrap(env);

  // ---------- 前置校验 ----------
  if (!existsSync(dbFile)) {
    throw new BootstrapError(
      `数据库不存在：${dbFile}`,
      ["全新部署先启动一次平台（自动迁移），或跑 npm run db:migrate 生成库。"],
    );
  }

  const encryptionKey = (env.CONFIG_ENCRYPTION_KEY || "").trim();
  if (!encryptionKey) {
    throw new BootstrapError("缺少 CONFIG_ENCRYPTION_KEY —— 绑定口令需要加密入库。本地跑请用 npm run bootstrap（自动加载 .env）。");
  }

  const db = openSqlite(dbFile);
  try {
    // ---------- 读取现状 ----------
    let current = null;
    try {
      current = db.prepare("SELECT ldap_host, encrypted_secret FROM integration_settings WHERE id = 'ldap'").get() || null;
    } catch {
      current = null;
    }
    // ⚠️ 原生 SQLite 行对象用的是 snake_case 列名（不是 drizzle 的 camelCase）。
    // 这里读错过的后果不是报错，而是「库里明明配了认证源」被一直判成未配置：
    // ① 锁死陷阱检测误伤 —— 已配好认证源、只想补一个角色也会被拒绝；
    // ② 覆盖留痕丢失 —— 审计 detail 不标注「覆盖原配置」。
    const currentConfigured = Boolean(current?.ldap_host && current?.encrypted_secret);

    // 锁死顺序陷阱（见文件头）：只写角色、不提供认证源，而管理员名单已配置且库里没有可用认证源
    const adminEmails = (env.PLATFORM_ADMIN_EMAILS || "").trim();
    if (!plan.ldap && !currentConfigured && adminEmails) {
      throw new BootstrapError(
        "检测到锁死组合：PLATFORM_ADMIN_EMAILS 已配置，但库里没有任何可用的 LDAP 认证源。",
        [
          "此时平台启动后没有任何登录路径（兜底管理员仅在名单未配置时生效）。",
          "处理：本次把 BOOTSTRAP_LDAP_HOST 一并写入，或先清空 PLATFORM_ADMIN_EMAILS。",
        ],
      );
    }

    const platformRunning = await (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(`http://127.0.0.1:${env.PORT || "8787"}/healthz`, { signal: controller.signal });
        clearTimeout(timer);
        return response.ok;
      } catch {
        return false;
      }
    })();

    // ---------- 打印计划 ----------
    log("首次部署引导（bootstrap）");
    log(`  数据库              = ${dbFile}`);
    log(`  管理员名单          = ${adminEmails ? `已配置（${adminEmails.split(",").length} 个）` : "未配置（兜底管理员生效，联调态）"}`);
    log(`  现有认证源          = ${currentConfigured ? `已配置（${current.ldap_host}，本次将被覆盖）` : "未配置"}`);
    log(`  平台运行状态        = ${platformRunning ? "⚠️ 8787 端口有平台在运行（建议停机后执行，避免审计并发）" : "未检测到"}`);
    log("");
    if (plan.ldap) {
      log("将要写入的 LDAP 认证源：");
      log(`  名称      = ${plan.ldap.ldapName}`);
      log(`  地址      = ${plan.ldap.label}`);
      log(`  LDAPS     = ${plan.ldap.ldapLdaps ? "是" : "否"}`);
      log(`  Base DN   = ${plan.ldap.baseDn}`);
      log(`  绑定 DN   = ${plan.ldap.bindDn}`);
      log(`  绑定口令  = ${"*".repeat(Math.min(plan.ldap.bindPassword.length, 8))}（${plan.ldap.bindPassword.length} 字符，加密入库）`);
      log(`  过滤器    = ${plan.ldap.ldapFilter || "（缺省 (objectClass=person)）"}`);
      log(`  同步间隔  = ${plan.ldap.syncIntervalMinutes} 分钟`);
    }
    if (plan.roles.length) {
      log("将要写入的平台角色：");
      for (const item of plan.roles) log(`  ${item.email} → ${item.role}`);
    }
    log("");

    if (!hasFlag("--yes")) {
      log("[i] 以上是 dry-run 计划，未写入任何数据。确认无误后追加 --yes 执行。");
      return 0;
    }

    // ---------- bind 验证（写认证源时必做；--skip-verify 仅限确认网络不可达的场景） ----------
    if (plan.ldap && !hasFlag("--skip-verify")) {
      log(`正在用给定凭据验证 bind（${plan.ldap.label}）…`);
      try {
        const { Client } = await import("ldapts");
        // ⚠️ tlsOptions 只能随 ldaps 一起传：ldapts 一旦收到 tlsOptions，明文 ldap:// 也会按
        // TLS socket 建连，直接挂到 connectTimeout（实测如此）。这正是平台连接层分开传的原因。
        const client = new Client({
          url: plan.ldap.label,
          timeout: 10_000,
          connectTimeout: 10_000,
          ...(plan.ldap.ldapLdaps ? { tlsOptions: { rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED !== "false" } } : {}),
        });
        try {
          await client.bind(plan.ldap.bindDn, plan.ldap.bindPassword);
        } finally {
          await client.unbind().catch(() => {});
        }
        log("  [OK] bind 成功。");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Invalid Credentials|invalidDnCredentials|data 52e|49/i.test(message)) {
          throw new BootstrapError("bind 失败：凭据被拒绝（绑定 DN 或口令不正确）。未写入任何数据。");
        }
        throw new BootstrapError(`bind 失败：${message}`, [
          "未写入任何数据。若确认是网络暂时不可达且你接受风险，可加 --skip-verify 跳过验证。",
        ]);
      }
    }

    // ---------- 事务写入 ----------
    const appendAudit = async (entries) => {
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
    };

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
      throw new BootstrapError(`写入失败，已回滚，数据库保持原状：${error instanceof Error ? error.message : String(error)}`);
    }

    log("");
    log("[已执行] 配置已写入并提交（审计留痕：操作者「运维 CLI（部署引导）」）。");
    log("接下来：");
    if (!plan.ldap || !currentConfigured) log("  * 启动/重启平台后，用管理员账号登录「LDAP 与权限」页点一次「同步用户」，用户数据即可进入平台。");
    log("  * 确认登录正常后再配置 PLATFORM_ADMIN_EMAILS 收紧兜底入口（顺序反了会被 preflight 拦下）。");
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      // 已关闭 / 从未打开成功
    }
  }
}

// ---------- CLI 入口（被 import 时不执行） ----------
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runBootstrap()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof BootstrapError) {
        console.error(`[x] ${error.message}`);
        for (const line of error.extra) console.error(`    ${line}`);
        process.exit(1);
      }
      console.error(`[x] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
