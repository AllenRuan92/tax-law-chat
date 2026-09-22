$ErrorActionPreference = 'Stop'
$taxRoot = Split-Path -Parent $PSScriptRoot
$taxOutput = Join-Path $taxRoot 'output'
New-Item -ItemType Directory -Force -Path $taxOutput | Out-Null
$taxZip = Join-Path $taxOutput ('tax-law-upload-proxy-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
Compress-Archive -LiteralPath (Join-Path $taxRoot 'fc/code/index.js'), (Join-Path $taxRoot 'fc/code/package.json') -DestinationPath $taxZip
Write-Output $taxZip
