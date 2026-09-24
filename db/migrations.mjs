// 迁移执行器（纯 ESM，供应用与 CLI 共用）：把 drizzle/*.sql 按文件名顺序、幂等地应用到一个 SQLite 库。
//
// 为什么是 .mjs 而不是 .ts：`npm run db:migrate` 需要直接 `node scripts/migrate.mjs` 跑，
// 而脚本与 Next 应用必须共用同一份逻辑（单一真相）。写成纯 ESM 两边都能 import，
// 不必依赖 Node 的 TS 类型剥离特性。类型经 JSDoc 表达。
//
// 与旧实现的差别（本次重构的主要收益之一）：
//   旧：迁移清单硬编码在 docker/entrypoint-platform.sh 与 scripts/local-setup.ps1 两处，
//       再用 .transfer-platform-schema-vN 标记文件判断「是否已初始化」。加一个迁移要改两个地方，
//       且标记与清单版本必须同步 —— 这是升级时最容易出事的地方（历史上有 v2…v9 共 8 个分支）。
//   新：清单 = drizzle/ 目录里实际存在的 *.sql；幂等性 = __platform_migrations 表逐条记录。
//       加迁移只需把文件放进 drizzle/，本地与容器行为立刻一致。
//
// 与 drizzle-kit 的关系：drizzle/ 仍是 drizzle-kit 的产物目录，schema 改动照旧 `npm run db:generate`；
// meta/_journal.json 不参与本执行器（只按文件名排序）。历史上 0004 被跳过，执行器对编号不连续不做假设。

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const TRACKING_TABLE = "__platform_migrations";

/**
 * 列出待执行的迁移文件（按文件名排序；零填充编号保证字典序 = 执行顺序）。
 * @param {string} dir
 * @returns {string[]}
 */
export function listMigrationFiles(dir) {
  if (!existsSync(dir)) {
    throw new Error(
      `找不到迁移目录：${dir}。若使用 standalone 产物，请确认 drizzle/ 与 server.js 同级（或设置 MIGRATIONS_DIR）。`,
    );
  }
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * 幂等执行迁移，返回本次实际应用与跳过的文件。
 * @param {import("./sqlite-client.mjs").CompatDatabase} db
 * @param {string} dir
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(db, dir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  /** @type {Set<string>} */
  const applied = new Set(
    /** @type {Array<{name: string}>} */ (db.prepare(`SELECT name FROM ${TRACKING_TABLE}`).all()).map((row) => row.name),
  );

  /** @type {{ applied: string[], skipped: string[] }} */
  const result = { applied: [], skipped: [] };
  for (const name of listMigrationFiles(dir)) {
    if (applied.has(name)) {
      result.skipped.push(name);
      continue;
    }
    const sql = readFileSync(path.join(dir, name), "utf8");
    const insert = db.prepare(`INSERT INTO ${TRACKING_TABLE} (name, applied_at) VALUES (?, ?)`);
    // 单个迁移文件整体在一个事务里：中途失败不会留下半套 schema
    db.transaction(() => {
      db.exec(sql);
      insert.run(name, new Date().toISOString());
    })();
    result.applied.push(name);
  }
  return result;
}

/**
 * 确保目录存在（SQLite 不会自动创建父目录）
 * @param {string} file
 */
export function ensureParentDir(file) {
  mkdirSync(path.dirname(file), { recursive: true });
}
