#!/usr/bin/env bash
# 审批平台容器入口：准备配置 → 初始化数据库 → 以 workerd 启动平台。
# 之所以要 workerd 而不是 Node 服务器：应用代码通过 Worker 绑定拿环境
# （env.BUCKET / env.PLATFORM_ADMIN_EMAILS …），只有 Worker 运行时会注入这些绑定。
set -euo pipefail

PERSIST_DIR="${PERSIST_DIR:-/data/state}"
CONFIG_DIR="${CONFIG_DIR:-/data/config}"
SITES_RUNTIME_ROOT="${SITES_RUNTIME_ROOT:-/data/runtime}"
PORT="${PORT:-8787}"
export PERSIST_DIR CONFIG_DIR SITES_RUNTIME_ROOT PORT

cd /app
mkdir -p "$PERSIST_DIR" "$CONFIG_DIR" "$SITES_RUNTIME_ROOT"

echo "[entrypoint] 准备运行时配置（加密密钥、交付网关地址、环境变量注入）…"
node docker/prepare-runtime-config.mjs --role platform

echo "[entrypoint] 初始化数据库（标记文件存在则跳过）…"
node docker/init-db.mjs \
  --config dist/server/wrangler.local.json \
  --db site-creator-d1 \
  --persist-to "$PERSIST_DIR" \
  --marker "$PERSIST_DIR/.transfer-platform-schema-v9" \
  --files drizzle/0000_noisy_human_cannonball.sql,drizzle/0001_cloudy_raider.sql,drizzle/0002_transfer_platform_enhance.sql,drizzle/0003_delivery_gateway.sql,drizzle/0005_ldap_direct.sql,drizzle/0006_ldap_filter.sql,drizzle/0007_unified_transfer.sql,drizzle/0008_ldap_login.sql,drizzle/0009_content_guard.sql

echo "[entrypoint] 启动平台：workerd，端口 ${PORT}，持久卷 ${PERSIST_DIR}"
exec node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config dist/server/wrangler.local.json \
  --local \
  --persist-to "$PERSIST_DIR" \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --inspector-port 0
