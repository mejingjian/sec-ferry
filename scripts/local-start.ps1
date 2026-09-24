$ErrorActionPreference = "Stop"
# wrangler 输出 UTF-8 中文，PowerShell 5.1 默认按 ANSI/GBK 解码会显示为乱码，统一切换为 UTF-8
try { [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:FORCE_COLOR = "0" 2>$null
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# 持久化目录放在系统 TEMP 下，与 local-setup.ps1 保持一致，避免超长路径导致 SQLite 打不开
$PersistRoot = Join-Path $env:TEMP "transfer-platform-state"

# 已初始化判定：兼容历史标记版本（此前只认 v4，迁移升到 0005/0006/0007/0008 后必然误报未初始化）
$Markers = @(
  ".transfer-platform-schema-v9", ".transfer-platform-schema-v8", ".transfer-platform-schema-v7", ".transfer-platform-schema-v6",
  ".transfer-platform-schema-v5", ".transfer-platform-schema-v4", ".transfer-platform-schema-v3", ".transfer-platform-schema-v2"
)
$Initialized = $false
foreach ($Marker in $Markers) { if (Test-Path (Join-Path $PersistRoot $Marker)) { $Initialized = $true; break } }
if (-not $Initialized) {
  Write-Host "尚未初始化本地数据库，请先运行 npm run local:setup" -ForegroundColor Yellow
  exit 1
}

# 构建新鲜度：产物缺失或源文件比产物新才重建。
# 只有确实过期才 build —— vinext build 会先清空 dist，服务运行中重建会把 8787 打断成 502。
$DistEntry = "dist/server/wrangler.json"
$NeedsBuild = -not (Test-Path $DistEntry)
if (-not $NeedsBuild) {
  $BuiltAt = (Get-Item $DistEntry).LastWriteTimeUtc
  $SourceDirs = @("app", "lib", "components", "db", "hooks") | Where-Object { Test-Path $_ }
  $Sources = Get-ChildItem -Path $SourceDirs -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".ts", ".tsx", ".css", ".js", ".mjs", ".json") }
  $Newest = $Sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($Newest -and $Newest.LastWriteTimeUtc -gt $BuiltAt) {
    Write-Host "检测到源文件变更（$($Newest.Name)），重新构建…" -ForegroundColor Yellow
    $NeedsBuild = $true
  }
}
if ($NeedsBuild) { npm run build }

node ./scripts/prepare-local-config.mjs
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --config dist/server/wrangler.local.json --local --persist-to $PersistRoot --ip 127.0.0.1 --port 8787 --inspector-port 0
