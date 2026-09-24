# Stop the local dev server (wrangler dev + workerd) launched with elevated token.
# ASCII only, run elevated via UAC.
$ErrorActionPreference = "Continue"

Write-Output "=== Stopping workerd.exe ==="
taskkill /F /IM workerd.exe 2>&1 | ForEach-Object { Write-Output $_ }

Write-Output "=== Stopping wrangler node processes ==="
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'wrangler' }
  foreach ($p in $procs) {
    Write-Output ("Stopping node PID=" + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
  }
} catch {
  Write-Output ("CIM query failed: " + $_.Exception.Message)
}

Start-Sleep -Seconds 1
Write-Output "=== Remaining workerd processes ==="
$left = Get-Process -Name workerd -ErrorAction SilentlyContinue
if ($left) { $left | ForEach-Object { Write-Output ("  still alive PID=" + $_.Id) } } else { Write-Output "  none - all stopped" }
Write-Output "DONE"
