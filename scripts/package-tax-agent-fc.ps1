$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $workspace 'tax-agent'
$target = Join-Path $workspace ('output/tax-agent/fc-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($name in @('chinatax.mjs', 'monitor.mjs', 'oss-store.mjs')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name)
}
foreach ($name in @('index.js', 'package.json', 'package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $source ('fc/' + $name)) -Destination (Join-Path $target $name)
}
npm ci --omit=dev --prefix $target
if ($LASTEXITCODE -ne 0) { throw '函数依赖安装失败' }
Write-Output $target
