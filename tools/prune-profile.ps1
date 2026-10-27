param([Parameter(Mandatory = $true)][string]$Profile)

# 启动前清理 Edge/Chromium 的可再生数据：组件缓存、崩溃转储、GPU/着色器缓存、
# 语音/拼写数据、钱包/购物等。只保留 Default\Local Storage 等真正的用户数据。
$cacheDirs = @(
  'ProvenanceData',
  'ProvenanceDataTensors',
  'component_crx_cache',
  'WidevineCdm',
  'Edge Entity Extraction',
  'Crashpad',
  'Edge Wallet',
  'Edge Shopping',
  'Subresource Filter',
  'GrShaderCache',
  'ShaderCache',
  'BrowserMetrics',
  'EdgeLanguageDetectionModel',
  'CertificateRevocation',
  'OptimizationHints',
  'Safe Browsing',
  'OnDeviceHeadSuggestModel',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'Speech Recognition',
  'hyphen-data',
  'ZxcvbnData',
  'Typosquatting',
  'Default\Cache',
  'Default\Code Cache',
  'Default\GPUCache',
  'Default\DawnGraphiteCache',
  'Default\DawnWebGPUCache',
  'Default\Service Worker\CacheStorage'
)

$freed = 0.0
foreach ($name in $cacheDirs) {
  $path = Join-Path $Profile $name
  if (-not (Test-Path $path)) { continue }
  try {
    $size = (Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $path)) { $freed += ($size / 1MB) }
  } catch { }
}

# Chromium 的单实例锁：上次进程被强杀时可能残留，会让新进程以为已有实例而直接退出。
foreach ($lock in @('SingletonLock','SingletonCookie','SingletonSocket','lockfile')) {
  $lp = Join-Path $Profile $lock
  if (Test-Path $lp) { Remove-Item $lp -Force -ErrorAction SilentlyContinue }
}

[math]::Round($freed, 1)
