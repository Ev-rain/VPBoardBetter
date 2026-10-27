$ErrorActionPreference = 'Stop'
$root = 'D:\study\project\XcpcBoard'
$port = 8787
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$shotsDir = Join-Path $root 'shots'
New-Item -ItemType Directory -Force -Path $shotsDir | Out-Null

$srv = $null
try {
  $srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -PassThru -WindowStyle Hidden
  Write-Output "server pid=$($srv.Id)"
} catch {
  Write-Output "server start failed: $($_.Exception.Message)"
}

$up = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { Start-Sleep -Milliseconds 250 }
}
Write-Output "server up=$up"

$shots = @(
  @{ n = 'empty';       q = '' },
  @{ n = 'full_t0';     q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=0' },
  @{ n = 'full_mid';    q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=7200' },
  @{ n = 'full_freeze'; q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=15000' },
  @{ n = 'full_end';    q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=18000' },
  @{ n = 'h3_freeze';   q = 'demo=fixtures/icpc_50th_nanjing&mode=3h&t=8700' },
  @{ n = 'panel_my';    q = 'demo=fixtures/icpc_50th_nanjing&mode=3h&t=4320&panel=my&my=A0101' },
  @{ n = 'panel_record';q = 'demo=fixtures/icpc_50th_nanjing&mode=3h&t=4320&panel=record&my=A0101' },
  @{ n = 'panel_data';  q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=7200&panel=data' },
  @{ n = 'panel_help';  q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=7200&panel=help' },
  @{ n = 'panel_team';  q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=15000&panel=team&team=A0101' },
  @{ n = 'panel_qoj';   q = 'demo=fixtures/icpc_50th_nanjing&mode=full&t=7200&panel=qoj' }
)

foreach ($s in $shots) {
  $url = "http://127.0.0.1:$port/index.html?$($s.q)"
  $out = Join-Path $shotsDir "$($s.n).png"
  if (Test-Path $out) { Remove-Item $out -Force }
  $errFile = Join-Path $shotsDir "$($s.n).err.txt"
  $outFile = Join-Path $shotsDir "$($s.n).out.txt"
  $args = @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', "--user-data-dir=$root\.edge-profile",
    '--window-size=1440,900', '--virtual-time-budget=9000',
    "--screenshot=$out", $url
  )
  $ErrorActionPreference = 'Continue'
  $p = Start-Process -FilePath $edge -ArgumentList $args -Wait -PassThru -RedirectStandardError $errFile -RedirectStandardOutput $outFile
  $ErrorActionPreference = 'Stop'
  if (Test-Path $out) {
    Write-Output ("shot {0} ok {1} bytes" -f $s.n, (Get-Item $out).Length)
  } else {
    Write-Output ("shot {0} MISSING (exit {1})" -f $s.n, $p.ExitCode)
  }
}

if ($srv) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue; Write-Output 'server stopped' }
