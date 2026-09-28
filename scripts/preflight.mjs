#!/usr/bin/env node
// 启动前自检（preflight）：把「配置问题」提前到启动那一刻，而不是埋到运行期。
//
// 为什么需要它：平台原先在配置缺失时**照常启动**。忘配密钥、或把管理员名单配上了
// 却没配认证源，都不会在启动时报错 —— 直到使用者登录失败、或保存认证源报错才发现，
// 而那时最容易被误判成「代码坏了」。
//
// 用法：
//   node scripts/preflight.mjs                 # 检查；发现问题以非 0 退出
//   node scripts/preflight.mjs --warn-only     # 只告警不阻断（排查时用）
//   SKIP_PREFLIGHT=1 node server.js            # 完全跳过（紧急绕过）
//
// 容器里由 docker/entrypoint-platform.sh 在「迁移之后、启动服务之前」调用。

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_PREFLIGHT === "1") {
  console.log("[preflight] SKIP_PREFLIGHT=1，跳过启动前自检。");
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const warnOnly = process.argv.includes("--warn-only");

const errors = [];
const warnings = [];
const notes = [];
const err = (title, detail, fix) => errors.push({ title, detail, fix });
const warn = (title, detail, fix) => warnings.push({ title, detail, fix });

// ---------- 1) 加密密钥 ----------
const key = (process.env.CONFIG_ENCRYPTION_KEY || "").trim();
if (!key) {
  err(
    "CONFIG_ENCRYPTION_KEY 未配置",
    "它同时用于会话签名与 LDAP 绑定口令的加密。缺失时平台仍会启动，但登录、保存认证源都会失败。",
    "生成并写入配置文件：openssl rand -hex 32",
  );
} else if (key.length < 32) {
  err(
    `CONFIG_ENCRYPTION_KEY 长度不足（当前 ${key.length} 字符，要求 >= 32）`,
    "过短的密钥不足以安全地加密 LDAP 绑定口令。",
    "重新生成：openssl rand -hex 32",
  );
} else if (/^(changeme|change-me|placeholder|your[-_]?key|xxx+|<.*>)/i.test(key) || /^0+$/.test(key)) {
  err(
    "CONFIG_ENCRYPTION_KEY 看起来仍是文档里的占位符",
    "示例值一旦被直接使用，等于没有加密。",
    "重新生成：openssl rand -hex 32",
  );
} else {
  notes.push(`加密密钥已配置（${key.length} 字符）`);
}

// ---------- 2) 数据目录可写 ----------
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");
try {
  mkdirSync(path.join(dataDir, "db"), { recursive: true });
  mkdirSync(path.join(dataDir, "files"), { recursive: true });
  mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  accessSync(dataDir, constants.W_OK);
  notes.push(`数据目录可写（${dataDir}）`);
} catch (e) {
  err(
    `数据目录不可写：${dataDir}`,
    String((e && e.message) || e),
    "检查卷挂载与权限。容器里应为 /data；注意只读根文件系统下只有 /data 与 tmpfs 可写。",
  );
}

// ---------- 3) 登录路径（最容易把运维锁死的地方）----------
const adminEmails = (process.env.PLATFORM_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (adminEmails.length === 0) {
  warn(
    "未配置 PLATFORM_ADMIN_EMAILS —— 平台处于「联调态」",
    "此时登录页填一个邮箱、不校验密码即可进入，本地兜底管理员入口也处于开启状态。",
    "生产环境必须填写它（逗号分隔），例如 PLATFORM_ADMIN_EMAILS=admin@corp.local",
  );
} else {
  notes.push(`管理员名单已配置（${adminEmails.length} 个）`);

  if (!existsSync(dbFile)) {
    warn(
      `管理员名单已配置，但数据库尚不存在（${dbFile}）`,
      "全新部署时这是正常的初始状态：应先留空 PLATFORM_ADMIN_EMAILS 启动、配好认证源后再填回来。",
      "若这是已有数据的部署，请立刻确认数据卷是否正确挂载 —— 否则可能正对着一个空库运行。",
    );
  } else {
    let row = null;
    let readFailed = null;
    try {
      const { openSqlite } = await import("../db/sqlite-client.mjs");
      const db = openSqlite(dbFile);
      try {
        row = db
          .prepare("SELECT ldap_host, bind_dn, encrypted_secret FROM integration_settings WHERE id = 'ldap'")
          .get();
      } catch {
        row = null; // 表还不存在（尚未迁移）
      }
      db.close();
    } catch (e) {
      readFailed = String((e && e.message) || e);
    }

    if (readFailed) {
      warn("无法读取认证源配置（打开数据库失败）", readFailed, "确认库文件与进程权限。");
    } else if (!row || !row.ldap_host || !row.bind_dn) {
      err(
        "已配置管理员名单，但 LDAP 认证源尚未配置 —— 当前没有任何登录路径",
        "配置 PLATFORM_ADMIN_EMAILS 会立即禁用本地兜底登录，只剩 LDAP 一条路；此时认证源为空，等于把所有人挡在门外。",
        "二选一：① 先临时清空 PLATFORM_ADMIN_EMAILS 启动，用兜底管理员进入并配好认证源，再填回来；" +
          "② 设 SKIP_PREFLIGHT=1 绕过自检，或用 node scripts/reset-admin.mjs（见文档「锁死后如何恢复」）。",
      );
    } else if (!row.encrypted_secret) {
      warn(
        "LDAP 认证源缺少绑定口令密文",
        "可能只填了主机与绑定 DN，没有填口令。",
        "到管理页「LDAP 与权限」补齐绑定帐号密码。",
      );
    } else {
      notes.push("LDAP 认证源已配置");
    }
  }
}

// ---------- 输出 ----------
console.log("[preflight] 通过项：");
for (const n of notes) console.log("  [OK]   " + n);

if (warnings.length) {
  console.log("\n[preflight] 警告（不阻断启动）：");
  for (const w of warnings) {
    console.log("  [!]    " + w.title);
    if (w.detail) console.log("         " + w.detail);
    if (w.fix) console.log("         -> " + w.fix);
  }
}

if (errors.length) {
  console.log("\n" + "-".repeat(72));
  console.log(`[preflight] 发现 ${errors.length} 个会阻断正常使用的问题：`);
  errors.forEach((e, i) => {
    console.log(`\n  ${i + 1}. ${e.title}`);
    if (e.detail) console.log("     " + e.detail);
    if (e.fix) console.log("     -> " + e.fix);
  });
  console.log("-".repeat(72));
  if (warnOnly) {
    console.log("[preflight] --warn-only：仅告警，继续启动。\n");
    process.exit(0);
  }
  console.log("[preflight] 已阻止启动。确认配置无误后可用 SKIP_PREFLIGHT=1 绕过。\n");
  process.exit(1);
}

console.log("\n[preflight] 自检通过。\n");
