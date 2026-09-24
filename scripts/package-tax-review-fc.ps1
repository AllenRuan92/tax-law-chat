$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $workspace 'tax-agent'
$target = Join-Path $workspace ('output/tax-agent/review-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($name in @('chinatax.mjs', 'store.mjs', 'oss-store.mjs', 'review-decision.mjs', 'bailian.mjs', 'review-api.mjs')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name)
}
New-Item -ItemType Directory -Path (Join-Path $target 'lib') -Force | Out-Null
foreach ($name in @('knowledge.js', 'md5.js', 'config.js')) {
  Copy-Item -LiteralPath (Join-Path $workspace ('lib/' + $name)) -Destination (Join-Path $target 'lib')
}
Copy-Item -LiteralPath (Join-Path $source 'review-fc/index.js') -Destination (Join-Path $target 'index.js')
Copy-Item -LiteralPath (Join-Path $source 'fc/package.json') -Destination (Join-Path $target 'package.json')
Copy-Item -LiteralPath (Join-Path $source 'fc/package-lock.json') -Destination (Join-Path $target 'package-lock.json')
# Packaged modules live at one level, so rewrite only their relative sibling imports.
$entry = Join-Path $target 'index.js'
$content = Get-Content -LiteralPath $entry -Raw
$content = $content.Replace("'../oss-store.mjs'", "'./oss-store.mjs'").Replace("'../review-api.mjs'", "'./review-api.mjs'")
Set-Content -LiteralPath $entry -Value $content -NoNewline -Encoding utf8
$publisher = Join-Path $target 'bailian.mjs'
$content = (Get-Content -LiteralPath $publisher -Raw).Replace("'../lib/knowledge.js'", "'./lib/knowledge.js'")
Set-Content -LiteralPath $publisher -Value $content -NoNewline -Encoding utf8
npm ci --omit=dev --prefix $target
if ($LASTEXITCODE -ne 0) { throw '审核函数依赖安装失败' }
Write-Output $target
