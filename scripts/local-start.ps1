$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:FORCE_COLOR = "0" 2>$null

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path $ProjectRoot ".local-data" }
$ServerEntry = ".next/standalone/server.js"
# 生产模式下 Next 的 server.js 不会自己加载 .env（只有 `next dev` 会加载），显式喂进去。
# 已有真实环境变量优先级更高；--env-file-if-exists 在文件不存在时静默跳过（容器里就是这种情况）。
$EnvFile = Join-Path $ProjectRoot ".env"

# 产物缺失或源码更新才重建：next build 会清空 .next，服务运行中重建会打断正在服务的实例
$NeedsBuild = -not (Test-Path $ServerEntry)
if (-not $NeedsBuild) {
  $BuiltAt = (Get-Item $ServerEntry).LastWriteTimeUtc
  $SourceDirs = @("app", "lib", "components", "db", "hooks", "scripts") | Where-Object { Test-Path $_ }
  $Newest = Get-ChildItem -Path $SourceDirs -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".ts", ".tsx", ".css", ".js", ".mjs", ".json") -and $_.FullName -notmatch "\\\.next\\" } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($Newest -and $Newest.LastWriteTimeUtc -gt $BuiltAt) {
    Write-Host "检测到源文件变更（$($Newest.Name)），重新构建…" -ForegroundColor Yellow
    $NeedsBuild = $true
  }
}
if ($NeedsBuild) {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "构建失败" }
}

# 迁移是幂等的：每次启动都跑一遍，新增的 drizzle/*.sql 会自动补上
node "--env-file-if-exists=$EnvFile" ./scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { throw "数据库迁移失败" }

$env:PORT = "8787"
# 默认监听所有网卡：内网同事用本机 IP 就能访问。只想本机可访问就设 $env:HOSTNAME = "127.0.0.1"。
if (-not $env:HOSTNAME) { $env:HOSTNAME = "0.0.0.0" }

# 挑一个真实内网 IPv4 打印出来，方便把地址直接发给同事（取不到就退回本机回环）
$LanIp = $null
try {
  $LanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.InterfaceAlias -notmatch "vEthernet|Loopback|WSL|Hyper-V" } |
    Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress
} catch {}
if ($LanIp) {
  $AccessUrl = "http://${LanIp}:$($env:PORT)（内网，可直接发给同事） / http://127.0.0.1:$($env:PORT)（本机）"
} else {
  $AccessUrl = "http://127.0.0.1:$($env:PORT)"
}
Write-Host "启动平台：$AccessUrl （数据目录 $env:DATA_DIR）" -ForegroundColor Green
node "--env-file-if-exists=$EnvFile" $ServerEntry
