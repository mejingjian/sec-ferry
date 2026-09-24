#!/usr/bin/env node
// 迁移 CLI：`npm run db:migrate`
//
// 应用与 CLI 走的是同一份逻辑（db/migrations.mjs + db/sqlite-client.mjs），因此
// 「本地手动迁移」与「容器启动时自动迁移」不会出现清单不一致。
//
// 用法：
//   node scripts/migrate.mjs                 # 迁移 <DATA_DIR>/db/platform.db
//   DATA_DIR=/tmp/x node scripts/migrate.mjs # 指定数据目录
//   node scripts/migrate.mjs --status        # 只打印已应用/待应用清单，不执行

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMigrationFiles, runMigrations, ensureParentDir } from "../db/migrations.mjs";
import { openSqlite } from "../db/sqlite-client.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");
const migrationsDir = process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : path.join(projectRoot, "drizzle");

if (process.argv.includes("--status")) {
  const all = listMigrationFiles(migrationsDir);
  console.log(`迁移目录：${migrationsDir}`);
  console.log(`共 ${all.length} 个文件：`);
  for (const name of all) console.log(`  - ${name}`);
  if (existsSync(dbFile)) {
    const db = openSqlite(dbFile);
    const applied = new Set(db.prepare("SELECT name FROM __platform_migrations").all().map((row) => row.name));
    db.close();
    const pending = all.filter((name) => !applied.has(name));
    console.log(`已应用 ${applied.size} 个；待应用 ${pending.length} 个${pending.length ? `：${pending.join(", ")}` : ""}`);
  } else {
    console.log(`库文件尚不存在（${dbFile}）；首次运行 db:migrate 会创建`);
  }
  process.exit(0);
}

ensureParentDir(dbFile);
const db = openSqlite(dbFile);
try {
  const result = runMigrations(db, migrationsDir);
  console.log(`数据库：${dbFile}`);
  if (result.applied.length) console.log(`已应用 ${result.applied.length} 个迁移：${result.applied.join(", ")}`);
  if (result.skipped.length) console.log(`跳过 ${result.skipped.length} 个已应用的迁移`);
  if (!result.applied.length && !result.skipped.length) console.log("迁移目录为空，无事可做");
} finally {
  db.close();
}
