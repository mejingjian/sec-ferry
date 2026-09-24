# 让内网其它机器能访问平台（Windows 防火墙放行）
#
# 为什么需要它：
#   Docker Desktop 会在「域(Domain) / 公用(Public)」网络配置文件下创建两条入站 Block 规则
#   （针对 com.docker.backend.exe），而且没有配套的 Allow 规则。
#   Windows 防火墙里「显式 Block 优先于 Allow」，所以只加一条 8787 的 Allow 是无效的 ——
#   必须同时让开那两条 Block 规则，平台才真的能从别的机器访问。
#
# 用法（必须用「管理员身份」打开 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts/open-lan-access.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/open-lan-access.ps1 -Port 8788
#   powershell -ExecutionPolicy Bypass -File scripts/open-lan-access.ps1 -Revert
#
# -Revert 会删掉本脚本新增的 Allow 规则，并重新启用 Docker Desktop 的 Block 规则。

[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Revert
)

$ErrorActionPreference = "Stop"
$AllowName = "transfer-approval-platform TCP $Port"

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  Write-Host "需要管理员权限：请用「管理员身份」重新打开 PowerShell 再执行本脚本。" -ForegroundColor Red
  exit 1
}

$DockerBlock = Get-NetFirewallRule -DisplayName "Docker Desktop Backend" -ErrorAction SilentlyContinue

if ($Revert) {
  Get-NetFirewallRule -DisplayName $AllowName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if ($DockerBlock) { $DockerBlock | Enable-NetFirewallRule }
  Write-Host "已回滚：删除「$AllowName」，并恢复 Docker Desktop Backend 的 Block 规则。" -ForegroundColor Yellow
  exit 0
}

# 1) 放行本端口入站（域 + 私有；公用网络刻意不放行）
if (Get-NetFirewallRule -DisplayName $AllowName -ErrorAction SilentlyContinue) {
  Write-Host "入站放行规则已存在：$AllowName" -ForegroundColor DarkGray
} else {
  New-NetFirewallRule -DisplayName $AllowName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
  Write-Host "已新增入站放行规则：$AllowName （TCP $Port，Domain/Private）" -ForegroundColor Green
}

# 2) Docker Desktop 的 Block 规则优先于 Allow，必须先让它让开
if ($DockerBlock) {
  $Enabled = $DockerBlock | Where-Object { $_.Enabled -eq "True" }
  if ($Enabled) {
    $Enabled | Disable-NetFirewallRule
    Write-Host "已停用 Docker Desktop Backend 的入站 Block 规则（$($Enabled.Count) 条）。" -ForegroundColor Yellow
    Write-Host "  影响面：本机所有 Docker 已发布端口，在域/私有网络下不再被默认拦截。" -ForegroundColor Yellow
    Write-Host "  要恢复原状： powershell -ExecutionPolicy Bypass -File scripts/open-lan-access.ps1 -Revert" -ForegroundColor Yellow
  } else {
    Write-Host "Docker Desktop Backend 的 Block 规则已处于停用状态。" -ForegroundColor DarkGray
  }
} else {
  Write-Host "未发现 Docker Desktop Backend 规则（没装 Docker Desktop，或规则名已变）。" -ForegroundColor DarkGray
}

# 3) 打印可直接发给同事的访问地址
$Ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.InterfaceAlias -notmatch "vEthernet|Loopback|WSL|Hyper-V" } |
  Sort-Object -Property InterfaceMetric
Write-Host ""
Write-Host "内网访问地址（直接发给同事）：" -ForegroundColor Green
if ($Ips) {
  foreach ($I in $Ips) { Write-Host "  http://$($I.IPAddress):$Port" -ForegroundColor Green }
} else {
  Write-Host "  （未找到内网 IPv4，请用 ipconfig 自行确认）" -ForegroundColor DarkGray
}
