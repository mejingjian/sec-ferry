#!/usr/bin/env node
// 容器内的 D1 初始化：按顺序把 drizzle/*.sql 应用到本地 D1（即持久卷里的 SQLite）。
//
// 为什么不用 `wrangler d1 migrations apply`：本仓库的 drizzle/ 是 drizzle-kit 的产物，
// 目录结构（含 meta/）与 wrangler 的 migrations 目录约定不同，`d1 execute --file` 才是
// 仓库既有做法（见 scripts/local-setup.ps1）。这里沿用同一方式，并补上「已应用」记录。
//
// 用法：
//   node docker/init-db.mjs --config <wrangler 配置> --db <库名> --persist-to <目录> \
//        --marker <标记文件> --files drizzle/0000_x.sql,drizzle/0001_y.sql
//
// 幂等性：标记文件存在即整体跳过。这是「首次初始化」语义 —— 迁移文件本身不是幂等的
// （CREATE TABLE 重复执行会失败），所以升级 schema 请新增迁移文件并删除标记文件后重启，
// 或按 DOCKER-DEPLOYMENT.md 的升级章节操作。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const { projectRoot } = await import("../scripts/sites-env.mjs");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const configPath = argValue("config");
const databaseName = argValue("db");
const persistTo = argValue("persist-to");
const markerPath = argValue("marker");
const files = argValue("files").split(",").map((item) => item.trim()).filter(Boolean);

for (const [label, value] of [["--config", configPath], ["--db", databaseName], ["--persist-to", persistTo], ["--marker", markerPath]]) {
  if (!value) {
    console.error(`缺少参数 ${label}`);
    process.exit(2);
  }
}
if (!files.length) {
  console.error("缺少参数 --files");
  process.exit(2);
}

const wranglerBin = path.join(projectRoot, "node_modules/wrangler/bin/wrangler.js");
if (!existsSync(wranglerBin)) {
  console.error(`找不到 wrangler：${wranglerBin}`);
  process.exit(1);
}
const resolvedConfig = path.resolve(projectRoot, configPath);
if (!existsSync(resolvedConfig)) {
  console.error(`找不到 wrangler 配置：${resolvedConfig}`);
  process.exit(1);
}

const marker = path.resolve(projectRoot, markerPath);
if (existsSync(marker)) {
  console.log(`数据库已初始化过（${marker}），跳过迁移。`);
  process.exit(0);
}

mkdirSync(path.dirname(marker), { recursive: true });
mkdirSync(path.resolve(projectRoot, persistTo), { recursive: true });

for (const file of files) {
  const sqlFile = path.resolve(projectRoot, file);
  if (!existsSync(sqlFile)) {
    console.error(`迁移文件不存在：${sqlFile}`);
    process.exit(1);
  }
  console.log(`应用迁移 ${file} → ${databaseName}`);
  const result = spawnSync(
    process.execPath,
    [
      wranglerBin, "d1", "execute", databaseName,
      "--local", "--persist-to", path.resolve(projectRoot, persistTo),
      "--config", resolvedConfig,
      "--file", sqlFile,
    ],
    { cwd: projectRoot, stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`迁移失败：${file}`);
    process.exit(result.status ?? 1);
  }
}

writeFileSync(marker, `applied:\n${files.join("\n")}\nat: ${new Date().toISOString()}\n`);
console.log(`数据库初始化完成，共应用 ${files.length} 个迁移。`);
