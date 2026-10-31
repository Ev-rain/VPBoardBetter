# 生成 VPBoardBetter.exe（自绘窗口 + WebView2 宿主，用 .NET Framework 自带的 csc.exe 编译）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-exe.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'VPBoardBetter.exe'
$src = Join-Path $root 'tools\launcher\Host.cs'
$ico = Join-Path $root 'tools\launcher\app.ico'
$manifest = Join-Path $root 'tools\launcher\app.manifest'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

# WebView2 的托管程序集 + 加载器：从本机已有的 SDK 目录里找一套齐全的版本
$sdkDirs = @(
  (Join-Path $env:ProgramFiles 'Microsoft Office\root\Office16\ADDINS\Microsoft Power Query for Excel Integrated\bin'),
  (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Windows Performance Toolkit'),
  (Join-Path ${env:ProgramFiles(x86)} 'ASUS\ASUS Member Center'),
  (Join-Path $env:ProgramFiles 'DeskBox')
)
$core = $null
$forms = $null
$loader = $null
foreach ($dir in $sdkDirs) {
  $c = Join-Path $dir 'Microsoft.Web.WebView2.Core.dll'
  $f = Join-Path $dir 'Microsoft.Web.WebView2.WinForms.dll'
  $l = Join-Path $dir 'WebView2Loader.dll'
  if ((Test-Path $c) -and (Test-Path $f) -and (Test-Path $l)) { $core = $c; $forms = $f; $loader = $l; break }
}
if (-not $core) { throw "找不到 Microsoft.Web.WebView2.Core.dll / WinForms.dll / WebView2Loader.dll（需要 WebView2 SDK）" }
Write-Host ("WebView2 SDK: " + $core)

# 运行期需要的三个 DLL 放到 exe 旁边
foreach ($dll in @($core, $forms, $loader)) {
  Copy-Item $dll (Join-Path $root (Split-Path $dll -Leaf)) -Force
}

$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Management.dll',
  ('/r:' + $core), ('/r:' + $forms),
  ('/out:' + $out), $src)
if (Test-Path $ico) { $cscArgs = @('/win32icon:' + $ico) + $cscArgs }
if (Test-Path $manifest) { $cscArgs = @('/win32manifest:' + $manifest) + $cscArgs }
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc 失败，退出码 $LASTEXITCODE" }
Write-Host ("生成 " + $out + "（" + [Math]::Round((Get-Item $out).Length / 1KB, 1) + " KB）")
