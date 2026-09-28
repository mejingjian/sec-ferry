#!/usr/bin/env node
// 备份：数据库热备 + 隔离区文件镜像 + 保留策略。
//
// 为什么不用 `cp platform.db backup.db`：SQLite 在 WAL 模式下，直接拷主库文件会漏掉
// 尚未 checkpoint 的 -wal 内容，恢复出来的库可能缺最近的写入。`node:sqlite` 提供的
// `backup()` 走 SQLite 官方的在线备份 API，不需要停服、不需要外部 sqlite3 命令行。
//
// 用法：
//   node scripts/backup.mjs                     # 备份到 <DATA_DIR>/backups/
//   node scripts/backup.mjs --no-files          # 只备份数据库（文件量大时更轻）
//   node scripts/backup.mjs --keep 30           # 保留最近 30 份
//   node scripts/backup.mjs --out /mnt/backup   # 指定输出根目录（可挂载到备份盘）
//
// 容器里由 compose 的 backup sidecar 周期性调用（见 docker-compose.yml）。

import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");
const filesDir = process.env.FILES_DIR ? path.resolve(process.env.FILES_DIR) : path.join(dataDir, "files");
const outRoot = argValue("out", path.join(dataDir, "backups"));
const keep = Math.max(1, Number(argValue("keep", "14")) || 14);
const includeFiles = !process.argv.includes("--no-files");

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 递归镜像目录：只复制新增或变更的文件（按 size+mtime 判断），保留既有内容，支持增量累积 */
function mirror(source, target) {
  if (!existsSync(source)) return { copied: 0, skipped: 0 };
  mkdirSync(target, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    if (item.isDirectory()) {
      const nested = mirror(from, to);
      copied += nested.copied;
      skipped += nested.skipped;
      continue;
    }
    let needsCopy = true;
    if (existsSync(to)) {
      const a = statSync(from);
      const b = statSync(to);
      needsCopy = a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) > 1000;
    }
    if (needsCopy) {
      cpSync(from, to);
      copied += 1;
    } else {
      skipped += 1;
    }
  }
  return { copied, skipped };
}

function prune(root, prefix, keepCount) {
  if (!existsSync(root)) return 0;
  const entries = readdirSync(root)
    // 只统计数据库备份本体：否则 -shm/-wal 副产物会各自占掉一个保留名额
    .filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    .map((name) => ({ name, mtime: statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const entry of entries.slice(keepCount)) {
    rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 备份产物校验：光看「命令没报错」不等于备份可用。
 * 进程若在写入过程中被杀（容器重建 / 宿主重启），会留下 0 字节或半成品文件，
 * 而它照样能被保留策略当成一份有效备份占位 —— 需要恢复时才发现是空的。
 * 因此这里强制：非空 + SQLite 文件头 + 完整性检查通过 + 迁移表存在。
 *
 * 校验在临时副本上进行：直接在备份目录打开会生成 -shm/-wal 副产物污染备份；
 * 若备份输出目录本身只读，原地打开还会误判失败。
 */
function verifyBackup(file) {
  const size = statSync(file).size;
  if (size === 0) throw new Error("备份产物为 0 字节");

  const head = Buffer.alloc(16);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString("latin1") !== "SQLite format 3\u0000") throw new Error("不是有效的 SQLite 文件头");

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "backup-verify-"));
  try {
    const tmpFile = path.join(tmpDir, "copy.db");
    copyFileSync(file, tmpFile);
    const db = new DatabaseSync(tmpFile, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA quick_check").get();
      const verdict = String(Object.values(row)[0] ?? "").toLowerCase();
      if (verdict !== "ok") throw new Error(`完整性检查未通过：${verdict || "(无返回)"}`);
      const table = db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='__platform_migrations'")
        .get();
      if (!table.c) throw new Error("缺少 __platform_migrations 表，疑似空库或半成品");
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return size;
}

/**
 * 生成一份**已校验**的数据库快照，返回产物路径与字节数。
 *
 * 任何「改动前先留退路」的流程（定期备份、密钥轮换）都应调用本函数，而不是各自
 * `copyFileSync` —— WAL 模式下直接拷主库文件会漏掉尚未 checkpoint 的写入，
 * 恢复时才发现在最需要的那一次备份里少了最近的变更。走 SQLite 官方在线备份 API
 * 可以不停服拿到一致快照。
 *
 * 导出以便 `scripts/rekey.mjs` 复用：轮换密钥属于不可逆操作，同样要求写前有可校验的退路。
 *
 * @param {{ source?: string, outDir: string, prefix?: string }} options
 * @returns {Promise<{ file: string, size: number }>}
 */
export async function snapshotDatabase({ source = dbFile, outDir, prefix = "platform-" }) {
  if (!existsSync(source)) throw new Error(`数据库不存在，无法快照：${source}`);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${prefix}${timestamp()}.db`);
  await backup(new DatabaseSync(source, { readOnly: true }), file);
  try {
    return { file, size: verifyBackup(file) };
  } catch (error) {
    // 不合格的产物当场删除：留着会占掉保留名额，还在最需要的时候伪装成一份可用备份
    rmSync(file, { force: true });
    throw new Error(`数据库快照校验失败，已删除该产物：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 巡检历史备份：删掉确定无意义的 0 字节产物与校验留下的副产物，其余不合法产物只告警不删
 * （非空但不合法的文件可能是别的原因造成的，交人工判断，不做自动销毁）。
 */
function sweepEmptyBackups(root) {
  if (!existsSync(root)) return { removed: 0, suspect: [] };
  const removed = [];
  const suspect = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    // 校验副产物：-shm 可直接删；-wal 仅在 0 字节时删（非空意味着可能有未合并数据，保守处理）
    if (/^platform-.*\.db-shm$/.test(name)) {
      rmSync(full, { force: true });
      removed.push(name);
      continue;
    }
    if (/^platform-.*\.db-wal$/.test(name)) {
      if (statSync(full).size === 0) {
        rmSync(full, { force: true });
        removed.push(name);
      } else {
        suspect.push(name);
      }
      continue;
    }
    if (!/^platform-.*\.db$/.test(name)) continue;
    if (statSync(full).size === 0) {
      rmSync(full, { force: true });
      removed.push(name);
      continue;
    }
    try {
      verifyBackup(full);
    } catch {
      suspect.push(name);
    }
  }
  return { removed: removed.length, suspect };
}

async function main() {
  if (!existsSync(dbFile)) {
    console.error(`数据库不存在，跳过备份：${dbFile}`);
    process.exit(1);
  }

  const started = Date.now();
  mkdirSync(outRoot, { recursive: true });

  // 1) 数据库热备（写完立即校验，不合格的产物当场删除并让本次备份失败）
  const dbOutDir = path.join(outRoot, "db");
  const snapshot = await snapshotDatabase({ outDir: dbOutDir });
  const dbOut = snapshot.file;
  const dbSize = snapshot.size;

  // 2) 隔离区文件镜像（可关闭）
  let fileStat = { copied: 0, skipped: 0 };
  if (includeFiles) {
    // 镜像到「最新一份」目录而非每份快照：文件体积远大于数据库，
    // 累积多份快照会迅速吃满磁盘；去重式镜像 + 定期整目录同步到备份介质即可。
    fileStat = mirror(filesDir, path.join(outRoot, "files"));
  }

  // 3) 清理：先前遗留的空产物 + 超出保留数量的旧备份
  const sweep = sweepEmptyBackups(dbOutDir);
  const removed = prune(dbOutDir, "platform-", keep);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    [
      `备份完成（${seconds}s）`,
      `  数据库：${dbOut}（${(dbSize / 1024 / 1024).toFixed(2)} MB，已校验可打开）`,
      includeFiles ? `  文件  ：镜像新增/更新 ${fileStat.copied} 个，未变更 ${fileStat.skipped} 个` : "  文件  ：已跳过（--no-files）",
      `  清理  ：${[
        sweep.removed ? `删除历史空产物 ${sweep.removed} 份` : "",
        removed ? `删除超期备份 ${removed} 份` : "",
      ].filter(Boolean).join("；") || "无需清理"}`,
      sweep.suspect.length ? `  ⚠️ 告警：${sweep.suspect.length} 份历史备份未通过校验，请人工确认：${sweep.suspect.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
  );
}

// 只有「被直接执行」时才跑备份主流程。被其它脚本 import 时（scripts/rekey.mjs 复用
// snapshotDatabase）不应产生副作用 —— 否则一次密钥轮换会顺手多做一份全量备份。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
