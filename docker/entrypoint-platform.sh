#!/bin/sh
# 审批平台容器入口：迁移数据库 → 启动 Next standalone 服务器。
#
# 只有两件事，因为重构后不再需要「准备运行时配置」这一步：
# 环境变量直接来自容器环境，应用自己读 process.env（旧架构要在启动时凭空生成
# wrangler.local.json 把变量塞进 Worker 绑定，那会破坏「不可变镜像」原则）。
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PORT="${PORT:-8787}"
export DATA_DIR PORT

cd /app
mkdir -p "$DATA_DIR/db" "$DATA_DIR/files" "$DATA_DIR/backups"

echo "[entrypoint] 迁移数据库（幂等，已应用的会跳过）…"
node scripts/migrate.mjs

echo "[entrypoint] 启动平台：端口 ${PORT}，数据目录 ${DATA_DIR}"
exec node server.js
