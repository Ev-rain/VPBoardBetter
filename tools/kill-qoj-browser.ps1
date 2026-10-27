param(
  [Parameter(Mandatory = $true)][string]$Profile
)

$killed = 0
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if ($cmd -and $cmd.Contains($Profile)) {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      $killed++
    } catch { }
  }
}
Write-Output ("killed=" + $killed)
