# 隐藏启动器：由 launch.vbs 以隐藏窗口调用，负责起本地服务并打开 Edge 应用窗口。
# 窗口尺寸/位置由 Chromium 在“创建窗口时”应用（--window-size/--window-position），
# 所以不会出现“先按旧尺寸显示、再被改大小”的跳动。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port/"
$log = Join-Path $root '_server.log'
$errLog = Join-Path $root '_server.err'
$trace = Join-Path $root '_launch.log'
$profile = Join-Path $root '.app-profile'

function Log([string]$m) {
  try { Add-Content -Path $trace -Value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) -Encoding UTF8 } catch { }
}

Log "启动器开始（端口 $port）"

function Test-Port([int]$p) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $p)
    $c.Close()
    return $true
  } catch { return $false }
}

function Show-Message([string]$text, [string]$title) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', 'Warning')
  } catch { }
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

if (-not (Test-Port $port)) {
  Log '服务没在跑，启动 node'
  $node = Find-Node
  Log ('node = ' + $node)
  if (-not $node) {
    Show-Message "没有找到 Node.js。请先安装 https://nodejs.org/ 再运行 start.bat。" "VP Board Better"
    exit 1
  }
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $errLog | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Port $port); $i++) { Start-Sleep -Milliseconds 500 }
}

if (-not (Test-Port $port)) {
  $detail = ''
  if (Test-Path $log) { $detail = (Get-Content $log -Tail 8 -ErrorAction SilentlyContinue) -join "`r`n" }
  if (Test-Path $errLog) { $detail += "`r`n" + ((Get-Content $errLog -Tail 8 -ErrorAction SilentlyContinue) -join "`r`n") }
  Show-Message ("本地服务没有起来（端口 $port）。`r`n日志：$root\_server.log`r`n`r`n" + $detail) "VP Board Better"
  exit 1
}

$edge = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# 已有窗口：直接切到前面，不再新开（按 .app-profile + --app 认进程，再看是否已有主窗口；不依赖标题）
$existing = $null
foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('--app=', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                 $_.CommandLine.IndexOf('.app-profile', [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
  $gp = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) { $existing = $gp; break }
}
if ($existing) {
  Log '应用窗口已在运行，切到前台'
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate($existing.Id)
  } catch { }
  exit 0
}

# 上一次的浏览器进程还赖着（窗口已关但进程没退），先清掉，否则新参数会被转发给旧进程
$stale = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('.app-profile', [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($stale.Count -gt 0) {
  Log ('清理残留浏览器进程 ' + $stale.Count + ' 个')
  foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

# 独立配置目录：Edge 在默认目录里会恢复它自己的窗口状态并忽略 --window-size（实测恒为 1050x999）
if (-not (Test-Path $profile)) {
  Log '首次创建应用配置目录'
  New-Item -ItemType Directory -Path (Join-Path $profile 'Default') -Force | Out-Null
  # 把默认配置里的 localStorage 迁过来，避免丢掉“我的队伍 / QOJ 关联 / 上次比赛”
  $src = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default\Local Storage\leveldb'
  $dst = Join-Path $profile 'Default\Local Storage\leveldb'
  if (Test-Path $src) {
    try {
      New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue }
      Copy-Item -Path $src -Destination $dst -Recurse -Force -ErrorAction Stop
      Remove-Item -Path (Join-Path $dst 'LOCK') -Force -ErrorAction SilentlyContinue
      Log '已迁移旧配置里的 localStorage'
    } catch { Log ('迁移 localStorage 失败: ' + $_.Exception.Message) }
  }
}


# Clean regenerable Edge caches before every launch (components, crashpad, wallet/shopping,
# GPU/shader caches). Without this .app-profile grows to hundreds of MB in a few runs.
# Keeps Default\Local Storage (my team / QOJ links / last contest).
try {
  $pruneScript = Join-Path $PSScriptRoot 'prune-profile.ps1'
  if (Test-Path $pruneScript) {
    $freed = & $pruneScript -Profile $profile
    if ($freed -gt 0) { Log ('已清理配置缓存: ' + [math]::Round($freed, 1) + ' MB') }
  }
} catch { Log ('清理配置缓存失败: ' + $_.Exception.Message) }

# 上次关窗时的尺寸与位置（页面通过 POST /api/window 写进 _window.json）
$winW = 1400; $winH = 860; $winX = 150; $winY = 90
$winFile = Join-Path $root '_window.json'
if (Test-Path $winFile) {
  try {
    $o = Get-Content $winFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($o.w -ge 640 -and $o.w -le 8000) { $winW = [int]$o.w }
    if ($o.h -ge 480 -and $o.h -le 5000) { $winH = [int]$o.h }
    if ($null -ne $o.x -and $null -ne $o.y -and [Math]::Abs([int]$o.x) -lt 20000 -and [Math]::Abs([int]$o.y) -lt 20000) {
      $winX = [int]$o.x; $winY = [int]$o.y
    }
  } catch { }
}

$edgeArgs = @(
  "--app=$url",
  "--window-size=$winW,$winH",
  "--window-position=$winX,$winY",
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',

  '--disable-sync',

  '--disable-component-update',

  '--disable-background-networking',

  '--disable-breakpad',

  '--disable-domain-reliability',

  '--no-pings',

  '--disable-features=Translate,MediaRouter,EdgeShoppingAssistant,msEdgeWallet'
)

Log ('启动 Edge: size ' + $winW + 'x' + $winH + ' @ ' + $winX + ',' + $winY)
if ($edge) {
  try {
    Start-Process -FilePath $edge -ArgumentList $edgeArgs -ErrorAction Stop | Out-Null
  } catch {
    Log ('启动 Edge 失败: ' + $_.Exception.Message)
    Start-Process $url | Out-Null
  }
} else {
  Log '没找到 Edge，用默认浏览器'
  Start-Process $url | Out-Null
}