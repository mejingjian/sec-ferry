#!/usr/bin/env node
// 密钥轮换（rekey）：把库里所有「用 CONFIG_ENCRYPTION_KEY 加密的配置密文」重新加密到新密钥。
//
// 为什么需要它：CONFIG_ENCRYPTION_KEY 用于（a）配置密文加密（LDAP 绑定口令、SMTP 发信口令），
// （b）会话 Cookie 签名。在此之前它**无法更换** —— 换掉之后库里已存的密文全解不开，
// 而这条口令是平台连 LDAP 的唯一凭据，解不开等于没有登录路径。于是「密钥泄漏」只能靠
// 重建整套环境来补救，合规审计也过不去（要求密钥可定期轮换）。
// 本脚本把这件事变成一次可控操作：旧密钥 → 新密钥，全部密文原地重加密。
//
// 用法：
//   npm run rekey                                   # 只读审计：列出密文，判定当前密钥能否解开
//   npm run rekey -- --new-key <64位hex> --yes      # 轮换到指定密钥
//   npm run rekey -- --generate --env-file .env.docker --yes
//                                                   # 生成新密钥、轮换、并写回配置文件
//   npm run rekey -- --old-key <a> --new-key <b> --yes
//                                                   # 双向：库里密文是 a 加密的，要变成 b
//                                                   # （「已经轮换过但环境变量没改」的救援场景）
//
//   npm run rekey -- --fingerprint                  # 只读：打印当前密钥的指纹（比对离线备份用）
//
// 选项：
//   --fingerprint          只打印当前密钥的 SHA-256 指纹后退出（校对两份离线备份是否一致，不显示密钥本身）
//   --old-key <hex>        旧密钥（默认取环境变量 CONFIG_ENCRYPTION_KEY）
//   --old-key-file <path>  从文件读旧密钥（取首个非空行；避免密钥进入 shell 历史）
//   --new-key <hex>        新密钥
//   --new-key-file <path>  从文件读新密钥
//   --generate             随机生成新密钥（推荐：密钥完全不经过命令行参数）
//   --env-file <path>      轮换成功后把新密钥写回该配置文件（先留 .bak）
//   --print-key            即使写了 --env-file 也把新密钥打印出来
//   --no-snapshot          跳过写前快照（磁盘空间紧张时用；**不建议**）
//   --no-probe             跳过「平台是否还在运行」的探测
//   --yes                  确认执行写操作（不写则只做只读审计）
//
// 注意：本脚本不会自动读取 .env；需要时显式传入 --env-file-if-exists 或用 npm 脚本。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";
import { encryptSecret, looksLikeCiphertext, tryDecryptSecret } from "../db/crypto.mjs";
import { auditHash } from "../db/audit-chain.mjs";
import { snapshotDatabase } from "./backup.mjs";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
};

/**
 * 已登记的密文字段。
 *
 * ⚠️ 新增任何「加密存储」的列时**必须**在这里登记。漏登记的后果不是报错，而是**静默**：
 *    该列不会被重加密，轮换后平台读不了它，而本脚本的报告显示「全部成功」。
 *    因此脚本结束前会扫描全库「长得像密文但没登记」的值并告警，作为兜底。
 */
const CIPHERTEXT_TARGETS = [
  { table: "integration_settings", column: "encrypted_secret", label: "LDAP 绑定口令" },
  { table: "integration_settings", column: "smtp_encrypted_secret", label: "SMTP 发信口令" },
];

/** 审计记录里的对象标识：平台在 components/views/AuditView.tsx 的 OBJECT_LABEL 里映射为中文 */
const AUDIT_OBJECT = "SECRET_KEY";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");

const hr = () => console.log("-".repeat(72));
const timestamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};
const maskKey = (key) => (key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`);

function keyFromFile(file) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new Error(`密钥文件不存在：${abs}`);
  const line = readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#"));
  if (!line) throw new Error(`密钥文件里没有可用的内容：${abs}`);
  return line;
}

/** 与 scripts/preflight.mjs 保持同一套校验口径 —— 两处判据不一致会让「自检通过但轮换失败」 */
function validateKey(key, label) {
  if (!key) return `${label}为空`;
  if (key.length < 32) return `${label}长度不足（${key.length} 字符，要求 >= 32）`;
  if (/^(changeme|change-me|placeholder|your[-_]?key|xxx+|<.*>)/i.test(key) || /^0+$/.test(key)) {
    return `${label}看起来仍是文档里的占位符`;
  }
  if (key === "local-dev-session-secret-do-not-use-in-prod") return `${label}是代码里的开发兜底值`;
  return null;
}

// ---------- 解析密钥 ----------
let oldKey = (argValue("old-key") || "").trim();
if (!oldKey && argValue("old-key-file")) oldKey = keyFromFile(argValue("old-key-file"));
const oldKeyFromEnv = !argValue("old-key") && !argValue("old-key-file");
if (!oldKey) oldKey = (process.env.CONFIG_ENCRYPTION_KEY || "").trim();

let newKey = (argValue("new-key") || "").trim();
if (!newKey && argValue("new-key-file")) newKey = keyFromFile(argValue("new-key-file"));
const generated = hasFlag("--generate");
if (generated) newKey = randomBytes(32).toString("hex");

const envFile = argValue("env-file");
const writeMode = Boolean(newKey);

// ---------- 指纹模式 ----------
// 用途：离线备份的密钥是否和线上仍在用的那把一致 —— 直接比对密钥本身有复制错位的风险，
// 指纹（SHA-256 前 16 位）足以判定「是不是同一把」，又不会把密钥显示在屏幕上。
if (hasFlag("--fingerprint")) {
  if (!oldKey) {
    console.log("[x] 未提供密钥。用环境变量 CONFIG_ENCRYPTION_KEY 或 --old-key / --old-key-file 指定。");
    process.exit(1);
  }
  const keyError = validateKey(oldKey, "当前密钥");
  if (keyError) {
    console.log(`[x] ${keyError}`);
    process.exit(1);
  }
  const fingerprint = createHash("sha256").update(oldKey, "utf8").digest("hex").slice(0, 16).toUpperCase();
  console.log("密钥指纹（SHA-256 前 16 位，与离线备份上的记录比对即可确认是否同一把密钥）：");
  console.log(`  ${fingerprint.match(/.{4}/g).join("-")}`);
  process.exit(0);
}

console.log("密钥轮换（rekey）");
console.log(`  数据目录            = ${dataDir}`);
console.log(`  数据库              = ${dbFile}${existsSync(dbFile) ? "" : "（不存在）"}`);
console.log(`  旧密钥              = ${oldKey ? maskKey(oldKey) : "未提供"}${oldKeyFromEnv && oldKey ? "（来自环境变量 CONFIG_ENCRYPTION_KEY）" : ""}`);
console.log(`  新密钥              = ${newKey ? `${maskKey(newKey)}${generated ? "（本次随机生成）" : ""}` : "未提供（仅做只读审计）"}`);
console.log(`  配置文件            = ${envFile ? path.resolve(envFile) : "（未指定，不会改动任何文件）"}`);

if (!existsSync(dbFile)) {
  console.log("\n数据库不存在，没有可轮换的密文。");
  console.log("若这是全新部署，先启动一次平台（会执行迁移），或跑 npm run db:migrate。");
  process.exit(0);
}

// 旧密钥是必需品：没有它一个密文都解不开，也就无从重加密
const oldKeyError = validateKey(oldKey, "旧密钥");
if (oldKeyError) {
  console.log(`\n[x] ${oldKeyError}`);
  console.log("    轮换必须知道「现有密文是用哪把密钥加密的」。若它已丢失，");
  console.log("    只能二选一：找回旧密钥，或清空认证源后用兜底管理员重新配置（见 npm run admin:inspect）。");
  process.exit(1);
}

const db = openSqlite(dbFile);

// ---------- 1) 清点密文 ----------
/**
 * 收集所有已登记字段上的密文。
 * 用 rowid 定位待更新行：integration_settings 的 id 是文本主键，但 rowid 同样存在，
 * 且 UPDATE 时用 rowid 不需要假设业务主键的取值。
 */
function collectRegistered() {
  const items = [];
  for (const target of CIPHERTEXT_TARGETS) {
    let rows = [];
    let error = null;
    try {
      rows = db
        .prepare(`SELECT rowid AS rid, "${target.column}" AS value FROM "${target.table}" WHERE "${target.column}" IS NOT NULL AND "${target.column}" <> ''`)
        .all();
    } catch (e) {
      error = (e && e.message) || String(e);
    }
    items.push({ ...target, rows, error });
  }
  return items;
}

/**
 * 兜底：扫描全库「长得像密文但没登记」的文本值。
 * 只用于告警 —— 漏登记不会让本脚本报错，只会在轮换后表现为「某个配置读不出来」，很难定位。
 */
function scanUnregistered() {
  const registered = new Set(CIPHERTEXT_TARGETS.map((target) => `${target.table}.${target.column}`));
  const found = [];
  let tables = [];
  try {
    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
  } catch {
    return found;
  }
  // LIKE 前缀（24 个任意字符 + '.'）是 SQL 层的粗筛，命中后再用正则精确判定，避免误报
  const coarse = `${"_".repeat(24)}.%`;
  for (const table of tables) {
    let columns = [];
    try {
      columns = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all();
    } catch {
      continue;
    }
    for (const column of columns) {
      const name = column.name;
      if (registered.has(`${table}.${name}`)) continue;
      try {
        const samples = db
          .prepare(`SELECT "${name}" AS value FROM "${table}" WHERE "${name}" LIKE ? LIMIT 20`)
          .all(coarse);
        const hits = samples.filter((row) => looksLikeCiphertext(row.value)).length;
        if (hits) found.push({ table, column: name, samples: hits });
      } catch {
        // 列类型不支持 LIKE（如 BLOB）等情况，跳过
      }
    }
  }
  return found;
}

console.log("\n密文清单：");
const registered = collectRegistered();
let decryptable = 0;
let undecryptable = 0;
const plan = [];

for (const target of registered) {
  if (target.error) {
    console.log(`  [!]    ${target.label}（${target.table}.${target.column}）：读取失败 — ${target.error}`);
    continue;
  }
  if (!target.rows.length) {
    console.log(`  [-]    ${target.label}：无密文`);
    continue;
  }
  for (const row of target.rows) {
    const result = await tryDecryptSecret(row.value, oldKey);
    if (result.ok) {
      decryptable += 1;
      plan.push({ ...target, rowid: row.rid, plaintext: result.value });
      console.log(`  [OK]   ${target.label}（rowid=${row.rid}）：密文 ${String(row.value).length} 字符，可解开（明文 ${result.value.length} 字符）`);
    } else {
      undecryptable += 1;
      console.log(`  [x]    ${target.label}（rowid=${row.rid}）：${result.error}`);
    }
  }
}

const unregistered = scanUnregistered();
if (unregistered.length) {
  console.log("\n[!] 发现未登记的密文形状字段（本脚本不会处理它们）：");
  for (const item of unregistered) {
    console.log(`      ${item.table}.${item.column}（${item.samples} 个样本）`);
  }
  console.log("      若这些字段确实由本平台的加密口径产生，请把它们加入 CIPHERTEXT_TARGETS，否则它们不会被轮换。");
}

console.log(
  `\n合计：可解开 ${decryptable} 处，解不开 ${undecryptable} 处（共 ${plan.length + undecryptable} 处密文）。`,
);

if (!writeMode) {
  hr();
  if (undecryptable > 0) {
    console.log("[x] 有密文无法用当前密钥解开 —— 平台现在多半也读不出这些配置。");
    console.log("    常见原因是「换了密钥但没重加密」，或库里混有更早期密钥加密的数据。");
    console.log("    处理方式：用**加密它们的那把密钥**作为 --old-key 跑一次轮换（见文件头示例）。");
    db.close();
    process.exit(1);
  }
  console.log("[i] 只读审计完成，未改动任何数据。");
  console.log("    要执行轮换，请追加 --new-key <hex>（或 --generate）与 --yes，例如：");
  console.log("      npm run rekey -- --generate --env-file .env.docker --yes");
  db.close();
  process.exit(0);
}

// ---------- 2) 新密钥校验 ----------
const newKeyError = validateKey(newKey, "新密钥");
if (newKeyError) {
  console.log(`\n[x] ${newKeyError}`);
  db.close();
  process.exit(1);
}
if (newKey === oldKey) {
  console.log("\n[x] 新密钥与旧密钥相同，轮换没有意义。");
  db.close();
  process.exit(1);
}
if (!plan.length) {
  console.log("\n[i] 库里没有任何已登记的密文，无需轮换。");
  if (envFile) console.log("    若你只是想把新密钥写进配置文件，直接改那个文件即可（本脚本不代替它）。");
  db.close();
  process.exit(0);
}
if (!hasFlag("--yes")) {
  hr();
  console.log(`[i] 将要执行：把 ${plan.length} 处密文从旧密钥重新加密到新密钥。`);
  console.log("    这是一个**不可逆**操作（原密文将被覆盖），请追加 --yes 确认。");
  console.log("    执行前会自动生成一份可校验的数据库快照作为退路。");
  db.close();
  process.exit(0);
}

// ---------- 3) 探测平台是否仍在运行 ----------
// 平台进程会把解出来的口令缓存在内存里，并在下次保存配置时**用旧密钥**重新加密 ——
// 那会在轮换后再写入一份旧密钥密文。所以轮换前必须先停平台。
let platformRunning = false;
if (!hasFlag("--no-probe")) {
  const port = process.env.PORT || "8787";
  const url = `http://127.0.0.1:${port}/healthz`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    platformRunning = response.ok;
  } catch {
    platformRunning = false;
  }
}

if (platformRunning) {
  console.log(`\n[!] 探测到 ${process.env.PORT || "8787"} 端口上的平台**仍在运行**。`);
  console.log("    正在运行的进程会继续用旧密钥工作，并可能在下次保存配置时写入旧密钥密文，");
  console.log("    导致轮换结果被污染。强烈建议先停掉平台再执行。");
  console.log("    （容器部署：docker compose stop platform）");
}

// ---------- 4) 写前快照 ----------
let snapshot = null;
if (!hasFlag("--no-snapshot")) {
  try {
    snapshot = await snapshotDatabase({ outDir: path.join(dataDir, "backups", "db"), prefix: "platform-prerekey-" });
    console.log(`\n快照已生成：${snapshot.file}（${(snapshot.size / 1024 / 1024).toFixed(2)} MB，已校验可打开）`);
  } catch (error) {
    console.log(`\n[x] 写前快照失败，已中止轮换：${(error && error.message) || error}`);
    console.log("    轮换不可逆，没有可用的退路时不应动手。磁盘满或备份目录只读是常见原因。");
    db.close();
    process.exit(1);
  }
} else {
  console.log("\n[!] --no-snapshot：跳过写前快照。轮换不可逆，请确认你已有其它退路。");
}

// ---------- 5) 事务内重加密 ----------
// 全部解密成功 → 逐个重加密并回读校验 → 写审计 → 提交。
// 任一步失败都整体回滚，不留「一半新密钥一半旧密钥」的库 —— 那种状态比不轮换更难恢复。
async function appendRekeyAudit(detail) {
  let previousHash = null;
  try {
    const previous = db.prepare("SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1").get();
    previousHash = previous ? previous.hash : null;
  } catch {
    return null; // 审计表不存在（很旧的库）：不阻断轮换本身
  }
  const at = new Date().toISOString();
  const actorId = "cli:rekey";
  const action = "轮换服务端加密密钥";
  const result = "SUCCESS";
  const objectId = AUDIT_OBJECT;
  const hash = await auditHash({ previousHash, at, actorId, action, objectId, result, detail });
  db.prepare(
    `INSERT INTO audit_events (id, at, actor_id, actor_email, actor_display, action, object_id, result, detail, previous_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), at, actorId, null, "运维 CLI（宿主机直连）", action, objectId, result, detail, previousHash, hash);
  return hash;
}

let auditTrailHash = null;
try {
  db.exec("BEGIN IMMEDIATE");
  for (const item of plan) {
    const ciphertext = await encryptSecret(item.plaintext, newKey);
    // 写回前先自校验：确认新密文能被新密钥解回原文。加密本身不会失败，
    // 但「写进去却解不开」是最坏的情况，所以在提交前验证。
    const echoed = await tryDecryptSecret(ciphertext, newKey);
    if (!echoed.ok || echoed.value !== item.plaintext) {
      throw new Error(`重加密自校验失败（${item.table}.${item.column} rowid=${item.rowid}）：${echoed.ok ? "回读内容不一致" : echoed.error}`);
    }
    db.prepare(`UPDATE "${item.table}" SET "${item.column}" = ? WHERE rowid = ?`).run(ciphertext, item.rowid);
  }
  // 审计与变更同事务提交：避免出现「改了但没记录」——密钥轮换正是最需要留痕的操作
  auditTrailHash = await appendRekeyAudit(
    JSON.stringify({ rotated: plan.length, targets: CIPHERTEXT_TARGETS.map((t) => `${t.table}.${t.column}`), generated, snapshot: snapshot ? path.basename(snapshot.file) : null }),
  );
  db.exec("COMMIT");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // 事务可能已自动回滚
  }
  console.log(`\n[x] 轮换失败，已回滚，数据库保持原状：${(error && error.message) || error}`);
  if (snapshot) console.log(`    快照仍在：${snapshot.file}`);
  db.close();
  process.exit(1);
}

console.log(`\n[已执行] ${plan.length} 处密文已用新密钥重新加密并提交。`);
if (auditTrailHash) console.log(`         审计留痕：${auditTrailHash.slice(0, 12)}…（对象 SECRET_KEY，操作者「运维 CLI（宿主机直连）」）`);

// ---------- 6) 提交后复核 ----------
// 刚才是「写入前」的校验，这里用库里实际存着的值再验一遍：
// 万一提交环节出问题（例如磁盘故障），这一步会立刻发现。
let verifyFailed = 0;
for (const item of plan) {
  const row = db.prepare(`SELECT "${item.column}" AS value FROM "${item.table}" WHERE rowid = ?`).get(item.rowid);
  const withNew = await tryDecryptSecret(row?.value, newKey);
  const withOld = await tryDecryptSecret(row?.value, oldKey);
  const ok = withNew.ok && withNew.value === item.plaintext && !withOld.ok;
  if (!ok) {
    verifyFailed += 1;
    console.log(`  [x] 复核未通过：${item.table}.${item.column} rowid=${item.rowid}（新密钥可解=${withNew.ok}，旧密钥仍可解=${withOld.ok}）`);
  }
}
if (verifyFailed) {
  console.log(`\n[!] 复核发现 ${verifyFailed} 处异常。请用快照回退：${snapshot ? snapshot.file : "（本次未生成快照）"}`);
  db.close();
  process.exit(1);
}
console.log(`         复核通过：${plan.length} 处密文均「新密钥可解、旧密钥不可解」。`);

db.close();

// ---------- 7) 可选：写回配置文件 ----------
let envUpdated = null;
if (envFile) {
  try {
    const abs = path.resolve(envFile);
    if (!existsSync(abs)) throw new Error(`配置文件不存在：${abs}`);
    const before = readFileSync(abs, "utf8");
    const backupPath = `${abs}.bak-${timestamp()}`;
    copyFileSync(abs, backupPath);
    // 只替换值，保留原有的行尾（\r 由 [^\r\n]* 之外的部分保留）
    const pattern = /^(CONFIG_ENCRYPTION_KEY=)[^\r\n]*/m;
    const after = pattern.test(before)
      ? before.replace(pattern, `$1${newKey}`)
      : `${before.replace(/\s*$/, "")}\nCONFIG_ENCRYPTION_KEY=${newKey}\n`;
    writeFileSync(abs, after);
    envUpdated = { abs, backupPath, replaced: pattern.test(before) };
    console.log(`\n[已执行] 新密钥已写入配置文件：${abs}（原文件备份为 ${path.basename(backupPath)}）`);
  } catch (error) {
    console.log(`\n[!] 配置文件更新失败：${(error && error.message) || error}`);
    console.log("    密文已经轮换完成，请手动把新密钥写入运行环境的 CONFIG_ENCRYPTION_KEY。");
  }
}

// ---------- 8) 交付新密钥 ----------
if (!envUpdated || hasFlag("--print-key")) {
  hr();
  console.log("新密钥（请立刻保存到离线密码管理器，离开此屏后不再显示）：");
  console.log(newKey);
}

// ---------- 9) 后续步骤 ----------
hr();
console.log("接下来必须按顺序做完这三步，否则平台会读不出配置：");
console.log("  1. 停掉平台 —— 正在运行的进程仍持有旧密钥（若已探测到它还在跑，现在就去停）");
if (envUpdated) {
  console.log(`  2. 确认运行环境加载了新的 CONFIG_ENCRYPTION_KEY（已写入 ${envUpdated.abs}）`);
} else {
  console.log("  2. 把新密钥写入运行环境的 CONFIG_ENCRYPTION_KEY（容器：.env.docker；本地：.env）");
}
console.log("  3. 重启平台，用域账号登录并在「LDAP 与权限」页确认认证源正常（能连上即轮换成功）");
console.log("");
console.log("另有两点：");
console.log("  * 会话 Cookie 也由这把密钥签名 —— 轮换后所有人会被登出，需要重新登录（预期行为）。");
console.log("  * 确认平台一切正常之后再销毁旧密钥；在此之前建议保留离线副本。");
if (snapshot) console.log(`  * 本次写前快照：${snapshot.file}`);
