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

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, mtime: statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const entry of entries.slice(keepCount)) {
    rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function main() {
  if (!existsSync(dbFile)) {
    console.error(`数据库不存在，跳过备份：${dbFile}`);
    process.exit(1);
  }

  const stamp = timestamp();
  const started = Date.now();
  mkdirSync(outRoot, { recursive: true });

  // 1) 数据库热备
  const dbOutDir = path.join(outRoot, "db");
  mkdirSync(dbOutDir, { recursive: true });
  const dbOut = path.join(dbOutDir, `platform-${stamp}.db`);
  await backup(new DatabaseSync(dbFile, { readOnly: true }), dbOut);
  const dbSize = statSync(dbOut).size;

  // 2) 隔离区文件镜像（可关闭）
  let fileStat = { copied: 0, skipped: 0 };
  if (includeFiles) {
    // 镜像到「最新一份」目录而非每份快照：文件体积远大于数据库，
    // 累积多份快照会迅速吃满磁盘；去重式镜像 + 定期整目录同步到备份介质即可。
    fileStat = mirror(filesDir, path.join(outRoot, "files"));
  }

  const removed = prune(dbOutDir, "platform-", keep);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    [
      `备份完成（${seconds}s）`,
      `  数据库：${dbOut}（${(dbSize / 1024 / 1024).toFixed(2)} MB）`,
      includeFiles ? `  文件  ：镜像新增/更新 ${fileStat.copied} 个，未变更 ${fileStat.skipped} 个` : "  文件  ：已跳过（--no-files）",
      removed ? `  清理  ：删除 ${removed} 份超出保留数量的旧数据库备份` : "  清理  ：无需清理",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
