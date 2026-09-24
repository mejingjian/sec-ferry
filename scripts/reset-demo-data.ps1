$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# 与 local-setup.ps1 / local-start.ps1 保持一致
$PersistRoot = Join-Path $env:TEMP "transfer-platform-state"

if (-not (Test-Path "$PersistRoot/.transfer-platform-schema-v3")) {
  Write-Host "尚未初始化本地数据库，请先运行 npm run local:setup" -ForegroundColor Yellow
  exit 1
}

Write-Host "清空演示/测试数据（applications / audit_events / rules / recipients / ldap_users / ldap_sync_runs / integration_settings / role_assignments）..." -ForegroundColor Cyan

$WranglerArgs = @("d1", "execute", "site-creator-d1", "--local", "--persist-to", $PersistRoot, "--config", "dist/server/wrangler.local.json")

foreach ($Table in @("applications", "audit_events", "rules", "recipients", "ldap_users", "ldap_sync_runs", "integration_settings", "role_assignments")) {
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js $WranglerArgs --command "DELETE FROM $Table;"
  if ($LASTEXITCODE -ne 0) { throw "清空 $Table 失败" }
  Write-Host "  已清空 $Table" -ForegroundColor Green
}

Write-Host "数据已清零，当前为干净初始状态。" -ForegroundColor Green
