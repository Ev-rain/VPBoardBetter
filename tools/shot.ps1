# 单张 UI 截图：起本地服务 -> 无头 Edge 打开 URL -> 截图 -> 关服务
# 用法: powershell -ExecutionPolicy Bypass -File tools\shot.ps1 -Query "demo=fixtures/icpc_50th_nanjing&mode=full&t=18000" -Name medal -Height 2400
param(
  [string]$Query = 'demo=fixtures/icpc_50th_nanjing',
  [string]$Name = 'shot',
  [int]$Height = 900,
  [int]$Width = 1440
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
$shots = Join-Path $root 'shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$out = Join-Path $shots ($Name + '.png')

$server = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
  for ($i = 0; $i -lt 40; $i++) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { break } } catch { }
    Start-Sleep -Milliseconds 150
  }
  $url = 'http://127.0.0.1:8787/index.html?' + $Query
  $edgeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    "--user-data-dir=$root\.edge-profile", "--window-size=$Width,$Height",
    '--virtual-time-budget=9000', "--screenshot=$out", $url)
  $p = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -Wait -RedirectStandardError (Join-Path $env:TEMP 'edge_shot.err') -RedirectStandardOutput (Join-Path $env:TEMP 'edge_shot.out')
  if (Test-Path $out) { Write-Output ("shot {0} ok {1} bytes" -f $Name, (Get-Item $out).Length) } else { Write-Output "shot $Name FAILED" }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
