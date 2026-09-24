$ErrorActionPreference = "Stop"
# 控制台统一 UTF-8，避免中文提示在 PowerShell 5.1 下显示为乱码
try { [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:FORCE_COLOR = "0" 2>$null

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$NodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw "需要 Node.js 22 或更高版本（本项目使用 Node 内置的 node:sqlite，无需原生模块编译）。" }

if (-not (Test-Path "node_modules")) {
  Write-Host "正在安装依赖（首次运行）…" -ForegroundColor Yellow
  npm install
}

# 数据目录固定在项目内，便于整体备份与搬迁（容器内则为 /data 卷）
if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path $ProjectRoot ".local-data" }
# 生产模式下 Next 的 server.js 不会自己加载 .env（只有 `next dev` 会加载），显式喂进去。
# 已有真实环境变量优先级更高；--env-file-if-exists 在文件不存在时静默跳过（容器里就是这种情况）。
$EnvFile = Join-Path $ProjectRoot ".env"

Write-Host "初始化数据库（幂等执行 drizzle/*.sql）…" -ForegroundColor Cyan
node "--env-file-if-exists=$EnvFile" ./scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { throw "数据库初始化失败" }

Write-Host ""
Write-Host "初始化完成，数据目录：$env:DATA_DIR" -ForegroundColor Green
Write-Host "下一步：npm run local:start" -ForegroundColor Green
