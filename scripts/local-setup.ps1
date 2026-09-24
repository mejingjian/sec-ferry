$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$NodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required." }

if (-not (Test-Path "node_modules")) { npm run install:ci }
npm run build
node ./scripts/prepare-local-config.mjs

$Marker = ".transfer-platform-schema-v9"
$MarkerV8 = ".transfer-platform-schema-v8"
$MarkerV7 = ".transfer-platform-schema-v7"
$MarkerV6 = ".transfer-platform-schema-v6"
$MarkerV5 = ".transfer-platform-schema-v5"
$MarkerV4 = ".transfer-platform-schema-v4"
$MarkerV3 = ".transfer-platform-schema-v3"
$MarkerV2 = ".transfer-platform-schema-v2"
# 持久化目录放在系统 TEMP 下，避免项目超长路径（Roaming/Marvis/workspace/conv_xxx）触发 Windows MAX_PATH 导致 SQLite 打不开
$PersistRoot = Join-Path $env:TEMP "transfer-platform-state"
if (-not (Test-Path (Join-Path $PersistRoot $Marker))) {
  New-Item -ItemType Directory -Force $PersistRoot | Out-Null
  $WranglerArgs = @("d1", "execute", "site-creator-d1", "--local", "--persist-to", $PersistRoot, "--config", "dist/server/wrangler.local.json")
  if (Test-Path (Join-Path $PersistRoot $MarkerV8)) {
    # v8 库（0000-0008）：仅增量应用 0009（内容防伪装 + 归档下线）
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path (Join-Path $PersistRoot $MarkerV7)) {
    # v7 库（0000-0007）：仅增量应用 0008（域账号 LDAP 登录）+ 0009
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path (Join-Path $PersistRoot $MarkerV6)) {
    # 已按 v6 初始化过 0000-0006 的库：仅增量应用 0007（单平台收发改造）+ 0008（LDAP 登录）
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path (Join-Path $PersistRoot $MarkerV5)) {
    # 已按 v5 初始化过 0000-0003 + 0005 的库：仅增量应用 0006（LDAP 搜索过滤器）+ 0007
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0006_ldap_filter.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path (Join-Path $PersistRoot $MarkerV4)) {
    # 已按 v4 初始化过 0000-0003 的库：仅增量应用 0005（LDAP 直连字段）+ 0006 + 0007
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0005_ldap_direct.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0006_ldap_filter.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path (Join-Path $PersistRoot $MarkerV3)) {
    # 已按 v3 初始化过 0000/0001/0002 的库：仅增量应用 0003 + 0005 + 0006 + 0007
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0003_delivery_gateway.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0005_ldap_direct.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0006_ldap_filter.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } elseif (Test-Path $MarkerV2) {
    # 已按旧版初始化过 0000/0001 的库：增量应用 0002 + 0003 + 0005 + 0006 + 0007
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0002_transfer_platform_enhance.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0003_delivery_gateway.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0005_ldap_direct.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0006_ldap_filter.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  } else {
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0000_noisy_human_cannonball.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0001_cloudy_raider.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0002_transfer_platform_enhance.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0003_delivery_gateway.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0005_ldap_direct.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0006_ldap_filter.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0007_unified_transfer.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0008_ldap_login.sql
    node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --file drizzle/0009_content_guard.sql
  }
  New-Item -ItemType File -Force (Join-Path $PersistRoot $Marker) | Out-Null
}

Write-Host "Setup complete. Next: npm run local:start" -ForegroundColor Green
