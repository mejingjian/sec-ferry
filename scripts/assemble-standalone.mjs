#!/usr/bin/env node
// 组装 standalone 产物：Next 的 `output: "standalone"` 只产出 server.js + 最小 node_modules，
// 静态资源与 public/ 需要手工放到 standalone 目录里（官方文档明确要求）。
//
// 放在 `npm run build` 的尾部执行，好处是：
//   - 本地 `npm start` 与容器里 `node server.js` 走的是完全相同的目录结构；
//   - Dockerfile 只需 COPY .next/standalone 一个目录，不必在容器里再拼装。
//
// 产物结构（.next/standalone/）：
//   server.js            ← 入口
//   .next/static/        ← 前端静态资源
//   public/              ← public/ 原样拷贝
//   node_modules/        ← 被追踪到的最小依赖集
//   drizzle/             ← 迁移文件（供 db/index.ts 启动时执行）

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(projectRoot, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(`未找到 standalone 产物：${standalone}\n请确认 next.config.ts 里设置了 output: "standalone" 并已执行 next build。`);
  process.exit(1);
}

function copyDir(from, to, label) {
  if (!existsSync(from)) {
    console.log(`  跳过 ${label}（源目录不存在：${from}）`);
    return;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  已复制 ${label}`);
}

console.log("组装 standalone 产物：");
copyDir(path.join(projectRoot, ".next", "static"), path.join(standalone, ".next", "static"), ".next/static");
copyDir(path.join(projectRoot, "public"), path.join(standalone, "public"), "public");
// 迁移文件必须与 server.js 同级：db/index.ts 默认从 process.cwd()/drizzle 读取
copyDir(path.join(projectRoot, "drizzle"), path.join(standalone, "drizzle"), "drizzle");

// `next build` 会把仓库根的 .env 一起放进 standalone。产物里不该有密钥（容器构建时靠
// .dockerignore 排除，本地构建则没有这道闸），因此这里统一清掉。
// 配置照旧由外部注入：本地用 `node --env-file-if-exists=.env`（读的是仓库根的 .env），
// 容器用 Compose 的环境变量。
const removedEnv = [];
for (const name of readdirSync(standalone)) {
  if (name === ".env" || name.startsWith(".env.")) {
    rmSync(path.join(standalone, name), { recursive: true, force: true });
    removedEnv.push(name);
  }
}
if (removedEnv.length) console.log(`  已从产物中清除敏感文件：${removedEnv.join(", ")}`);

console.log(`完成。启动：node ${path.relative(projectRoot, path.join(standalone, "server.js")).replace(/\\/g, "/")}`);
