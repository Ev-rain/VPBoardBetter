# 关闭本地服务：结束监听指定端口的进程
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "[i] 端口 $port 上没有在运行的服务。"
  exit 0
}
foreach ($c in $conns) {
  try {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
    Write-Host "[ok] 已结束进程 $($c.OwningProcess)"
  } catch {
    Write-Host "[x] 结束进程 $($c.OwningProcess) 失败: $($_.Exception.Message)"
  }
}
Write-Host "[i] 已关闭。要重新打开，双击 VPBoardBetter.exe 即可。"
