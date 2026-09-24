#!/usr/bin/env node
// 清空演示/测试数据（保留 schema 与迁移记录）。
//
// 用途：跑完回归脚本后把库恢复成干净初始状态，或交付前清理测试痕迹。
// 用法：
//   node scripts/reset-demo-data.mjs            # 交互确认后清空
//   node scripts/reset-demo-data.mjs --yes      # 免确认（脚本/CI 用）

import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "../db/sqlite-client.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, ".local-data");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "db", "platform.db");

// 业务数据表（不动 __platform_migrations）
const TABLES = [
  "applications",
  "application_recipients",
  "audit_events",
  "rules",
  "ldap_users",
  "ldap_sync_runs",
  "integration_settings",
  "role_assignments",
  "download_deliveries",
  "download_events",
  "login_attempts",
];

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`将清空 ${dbFile} 中的业务数据（保留 schema），确认？输入 yes 继续：`);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("已取消。");
    process.exit(0);
  }
}

const db = openSqlite(dbFile);
try {
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of TABLES) {
    try {
      const result = db.prepare(`DELETE FROM ${table}`).run();
      console.log(`  已清空 ${table}（${result.changes} 行）`);
    } catch (error) {
      // 表不存在（例如旧库尚未迁移到该版本）不视为失败
      console.log(`  跳过 ${table}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
  console.log("数据已清零，当前为干净初始状态。");
} finally {
  db.close();
}
