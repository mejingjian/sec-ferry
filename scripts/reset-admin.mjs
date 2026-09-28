#!/usr/bin/env node
// 应急诊断与恢复工具（break-glass）。
//
// 为什么需要它：配置了 PLATFORM_ADMIN_EMAILS 之后，本地兜底登录会立即失效，
// 界面只剩「LDAP 域账号」一条登录路径。一旦出现下面任一情况，管理页就进不去了 ——
// 连改配置都做不到：
//   * LDAP 服务器不可达或证书/防火墙变更
//   * 加密密钥变更，导致库里已存的绑定口令解不开
//   * 绑定用的服务账号被域控禁用
// 本脚本**不依赖服务进程**，直接读写数据目录里的 SQLite，所以哪怕平台已经起不来，
// 也依然可用。
//
// 用法：
//   node scripts/reset-admin.mjs                        # 诊断（默认，只读，不改任何东西）
//   node scripts/reset-admin.mjs --clear-ldap --yes     # 清空 LDAP 认证源配置
//   node scripts/reset-admin.mjs --grant a@corp.local   # 把该邮箱设为管理员
//   node scripts/reset-admin.mjs --revoke a@corp.local  # 移除该邮箱的角色
//
// 注意：本脚本不会自动读取 .env；需要时显式传入：
//   node --env-file-if-exists=.env scripts/reset-admin.mjs
//
// 锁死后的完整恢复顺序见 DOCKER-DEPLOYMENT.md「锁死后如何恢复」一节。

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
/** 收集某个 flag 的全部取值（支持 `--grant a --grant b` 这种重复写法） */
const collectAll = (f) =>
  args.reduce((out, a, i) => {
    if (a === f && args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[i + 1]);
    return out;
  }, []);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");

const now = () => new Date().toISOString();
const hr = () => console.log("-".repeat(72));

// ---------- 环境侧信息 ----------
const encKey = (process.env.CONFIG_ENCRYPTION_KEY || "").trim();
const adminEmails = (process.env.PLATFORM_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const approverEmails = (process.env.PLATFORM_APPROVER_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

console.log("环境侧：");
console.log(`  DATA_DIR                 = ${dataDir}`);
console.log(`  DB_FILE                  = ${dbFile}${existsSync(dbFile) ? `（${(statSync(dbFile).size / 1024).toFixed(0)} KB）` : "（不存在）"}`);
console.log(`  CONFIG_ENCRYPTION_KEY    = ${encKey ? `已配置（${encKey.length} 字符）` : "未配置"}`);
console.log(`  PLATFORM_ADMIN_EMAILS    = ${adminEmails.length ? adminEmails.join(", ") : "（空 -> 联调态，允许不校验密码的登录）"}`);
console.log(`  PLATFORM_APPROVER_EMAILS = ${approverEmails.length ? approverEmails.join(", ") : "（空）"}`);

if (!existsSync(dbFile)) {
  console.log("\n数据库不存在，没有可诊断的内容。");
  console.log("若这是全新部署，先启动一次平台（会执行迁移），或跑 npm run db:migrate。");
  process.exit(0);
}

const { openSqlite } = await import("../db/sqlite-client.mjs");
const db = openSqlite(dbFile);

// ---------- 库内状态 ----------
console.log("\n库内状态：");

let migrationCount = null;
try {
  migrationCount = db.prepare("SELECT COUNT(*) AS c FROM __platform_migrations").get().c;
} catch {
  migrationCount = null;
}

let ldap = null;
try {
  ldap = db
    .prepare("SELECT * FROM integration_settings WHERE id = 'ldap'")
    .get();
} catch {
  ldap = null;
}

let roleRows = [];
try {
  roleRows = db.prepare("SELECT email, display_name, role FROM role_assignments").all();
} catch {
  roleRows = [];
}

let userCount = null;
try {
  userCount = db.prepare("SELECT COUNT(*) AS c FROM ldap_users").get().c;
} catch {
  userCount = null;
}

console.log(`  已应用迁移               = ${migrationCount ?? "（读不到迁移表）"}`);
console.log(`  LDAP 用户目录            = ${userCount ?? "（读不到）"} 人`);
console.log(
  `  认证源（ldap）           = ${
    ldap && ldap.ldap_host
      ? `${ldap.ldap_host}:${ldap.ldap_port ?? 389}${ldap.ldap_ldaps ? " (LDAPS)" : ""}`
      : "未配置"
  }`,
);
if (ldap) {
  console.log(`    base_dn                = ${ldap.base_dn || "（空）"}`);
  console.log(`    bind_dn                = ${ldap.bind_dn || "（空）"}`);
  console.log(`    绑定口令密文            = ${ldap.encrypted_secret ? `${String(ldap.encrypted_secret).length} 字符（已加密）` : "无"}`);
  console.log(`    最后更新                = ${ldap.updated_at || "（无）"}`);
}
console.log(`  角色分配                 = ${roleRows.length} 条`);
for (const r of roleRows) {
  console.log(`    - ${r.role.padEnd(4)} ${r.email}${r.display_name ? `（${r.display_name}）` : ""}`);
}

// ---------- 结论：现在到底能不能登进去 ----------
hr();
console.log("登录路径诊断：");
const paths = [];
if (adminEmails.length === 0) {
  paths.push("本地兜底管理员 / 自声明邮箱登录（联调态：不校验密码，任何人都能进）");
}
if (ldap && ldap.ldap_host && ldap.bind_dn) {
  const adminRole = roleRows.filter((r) => r.role === "管理员").map((r) => r.email);
  if (adminRole.length) {
    paths.push(`LDAP 域账号 + 域密码（当前管理员：${adminRole.join(", ")}）`);
  } else {
    paths.push("LDAP 域账号 + 域密码（注意：role_assignments 里没有任何「管理员」，进去也看不到管理页）");
  }
}

if (paths.length === 0) {
  console.log("  [x] 当前没有任何可用的登录路径 —— 平台处于锁死状态。");
  console.log("");
  console.log("  恢复步骤（任选其一）：");
  console.log("    方案 A（推荐，不动数据）：临时把 PLATFORM_ADMIN_EMAILS 置空后重启平台，");
  console.log("      用兜底管理员进入「LDAP 与权限」页重新配置认证源，配好后再把它填回来。");
  console.log("    方案 B：先执行 `node scripts/reset-admin.mjs --clear-ldap --yes` 清掉坏配置，");
  console.log("      再按方案 A 重启。适合认证源配置本身已经无法修复的情况。");
  console.log("    方案 C：若怀疑是密钥变更导致口令解不开，用旧密钥跑一次 rekey 把密文重新加密。");
} else {
  console.log("  [OK] 至少存在一条登录路径：");
  for (const p of paths) console.log("       - " + p);
}
hr();

// ---------- 写操作 ----------
let changed = false;

if (hasFlag("--clear-ldap")) {
  if (!hasFlag("--yes")) {
    console.log("\n--clear-ldap 会清空认证源配置（主机/端口/DN/口令密文）。请追加 --yes 确认执行。");
  } else {
    try {
      db.prepare("DELETE FROM integration_settings WHERE id = 'ldap'").run();
      console.log("\n[已执行] 已清空 LDAP 认证源配置。");
      console.log("  注意：现在需要重启平台，并用兜底管理员（要求 PLATFORM_ADMIN_EMAILS 为空）重新配置认证源。");
      changed = true;
    } catch (e) {
      console.log(`\n[失败] 清空认证源出错：${(e && e.message) || e}`);
    }
  }
}

for (const [flag, role] of [
  ["--grant", "管理员"],
  ["--revoke", null],
]) {
  for (const email of collectAll(flag)) {
    try {
      const existing = db.prepare("SELECT email FROM role_assignments WHERE email = ?").get(email);
      if (role === null) {
        if (existing) {
          db.prepare("DELETE FROM role_assignments WHERE email = ?").run(email);
          console.log(`\n[已执行] 已移除 ${email} 的角色配置。`);
        } else {
          console.log(`\n[跳过] ${email} 本来就没有角色配置。`);
        }
      } else if (existing) {
        db.prepare("UPDATE role_assignments SET role = ?, updated_at = ? WHERE email = ?").run(role, now(), email);
        console.log(`\n[已执行] 已把 ${email} 的角色更新为「${role}」。`);
      } else {
        db.prepare(
          "INSERT INTO role_assignments (email, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(email, email.split("@")[0], role, now(), now());
        console.log(`\n[已执行] 已把 ${email} 设为「${role}」。`);
      }
      changed = true;
    } catch (e) {
      console.log(`\n[失败] 处理 ${email} 出错：${(e && e.message) || e}`);
    }
  }
}

db.close();

if (changed) {
  console.log("\n提示：直接改库后，已登录的会话不会立即生效；必要时重启平台，或让对应用户重新登录。");
  console.log("      改库前请先备份：npm run backup");
}
