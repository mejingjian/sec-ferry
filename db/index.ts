// 数据库入口（唯一）：打开 SQLite 文件、跑迁移、返回 Drizzle 实例。
//
// 与旧实现的差别：
//   旧：从 Cloudflare D1 绑定拿库（`drizzle(env.DB)`），库文件由 workerd 托管在 .wrangler/state
//       之下，位置不透明，备份要连 wrangler 一起搬。
//   新：一个显式的 SQLite 文件（<DATA_DIR>/db/platform.db），进程内单例 + 首次访问即迁移。
//       因此「起服务」不再需要任何外部初始化步骤 —— 本地 `npm run dev`、容器启动都是同一条路径。
//
// 迁移在首次 getDb() 时执行：单进程、单写者模型下这是安全的，且保证「schema 一定先于查询就绪」。
// 已在 __platform_migrations 表里记录过的迁移会被跳过，重复启动无副作用。

import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { ensureParentDir, runMigrations } from "./migrations.mjs";
import { openSqlite, type CompatDatabase } from "./sqlite-client.mjs";
import { dbFile, migrationsDir } from "@/lib/paths";

type PlatformDb = BetterSQLite3Database<typeof schema>;

type Handle = { db: PlatformDb; client: CompatDatabase; file: string };

// 开发模式下模块会被热重载，若把句柄存在模块作用域会重复打开 SQLite 文件（句柄泄漏）。
// 挂到 globalThis 上保证一个进程只有一个连接。
const globalRef = globalThis as unknown as { __transferPlatformDb?: Handle };

function open(): Handle {
  const file = dbFile();
  ensureParentDir(file);
  const client = openSqlite(file);
  const migration = runMigrations(client, migrationsDir());
  if (migration.applied.length) {
    console.log(`[db] 已应用 ${migration.applied.length} 个迁移：${migration.applied.join(", ")}`);
  }
  // ⚠️ 类型断言的原因：CompatDatabase 是 better-sqlite3 `Database` 的结构子集，
  // 只覆盖 Drizzle 驱动实际调用到的成员（prepare/exec/transaction/pragma/close）。
  const db = drizzle(client as unknown as Parameters<typeof drizzle>[0], { schema }) as PlatformDb;
  return { db, client, file };
}

export function getDb(): PlatformDb {
  if (!globalRef.__transferPlatformDb) globalRef.__transferPlatformDb = open();
  return globalRef.__transferPlatformDb.db;
}

/** 原始 SQLite 句柄：健康检查 / 备份等需要直接执行 SQL 的场景 */
export function getSqlite(): CompatDatabase {
  if (!globalRef.__transferPlatformDb) globalRef.__transferPlatformDb = open();
  return globalRef.__transferPlatformDb.client;
}

/** 当前库文件绝对路径（诊断与备份用） */
export function dbFilePath(): string {
  if (!globalRef.__transferPlatformDb) globalRef.__transferPlatformDb = open();
  return globalRef.__transferPlatformDb.file;
}
