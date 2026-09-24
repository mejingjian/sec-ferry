# 停止本地开发/预览服务（Next 的 dev 或 standalone server）。
#
# 旧的停止脚本针对 workerd / wrangler；重构后运行时是普通 Node 进程，
# 因此改为「按命令行识别本项目的 node 进程 + 按端口兜底」。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/stop-dev-server.ps1 [-Port 8787]
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Continue"

Write-Output "=== 停止本项目的 node 服务进程 ==="
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'standalone\\server\.js|standalone/server\.js|next[\\/]dist[\\/]bin[\\/]next' }
  if (-not $procs) { Write-Output "  未发现运行中的本项目服务进程" }
  foreach ($p in $procs) {
    Write-Output ("  停止 PID=" + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
  }
} catch {
  Write-Output ("  进程查询失败：" + $_.Exception.Message)
}

Write-Output "=== 兜底：释放端口 $Port ==="
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Output "  端口 $Port 未被占用"
} else {
  foreach ($listener in $listeners) {
    $ownerPid = $listener.OwningProcess
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    Write-Output ("  端口 $Port 由 PID=$ownerPid（" + ($proc.ProcessName) + "）占用，正在停止")
    Stop-Process -Id $ownerPid -Force -ErrorAction Continue
  }
}

Start-Sleep -Seconds 1
$left = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($left) { Write-Output "  仍在监听，请手工排查" } else { Write-Output "  端口已释放" }
Write-Output "DONE"
