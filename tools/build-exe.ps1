# 生成 VPBoardBetter.exe（零依赖：.NET Framework 自带的 csc.exe）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-exe.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'VPBoardBetter.exe'
$ico = Join-Path $root 'tools\launcher\app.ico'
$png = Join-Path $root 'tools\launcher\app.png'
$src = Join-Path $root 'tools\launcher\Program.cs'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

# 1. 图标：把 balloon.svg 渲染成透明 PNG，再打包成多尺寸 ico
$edge = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge -and (Test-Path (Join-Path $root 'assets\balloon.svg'))) {
  $profile = Join-Path $env:TEMP ('vpb-icon-' + $PID)
  $svg = 'file:///' + ((Join-Path $root 'assets\balloon.svg') -replace '\\', '/')
  & $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 `
    --force-device-scale-factor=1 --window-size=512,512 --virtual-time-budget=1500 `
    "--user-data-dir=$profile" "--screenshot=$png" $svg | Out-Null
  Start-Sleep -Milliseconds 300
  Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue

  $py = $env:VPB_PYTHON
  if (-not $py) {
    $bundled = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\*\dependencies\python\python.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bundled) { $py = $bundled.FullName }
  }
  if (-not $py) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source }
  }
  if ($py -and (Test-Path $png)) {
    & $py -c "from PIL import Image; im=Image.open(r'$png').convert('RGBA'); im.save(r'$ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
  }
}

$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Management.dll',
  "/out:$out", (Join-Path $root 'tools\launcher\Program.cs'))
if (Test-Path $ico) { $cscArgs = @('/win32icon:' + $ico) + $cscArgs }
$manifest = Join-Path $root 'tools\launcher\app.manifest'
if (Test-Path $manifest) { $cscArgs = @('/win32manifest:' + $manifest) + $cscArgs }
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc 失败，退出码 $LASTEXITCODE" }
Write-Host "生成 $out（$([Math]::Round((Get-Item $out).Length / 1KB, 1)) KB）"
