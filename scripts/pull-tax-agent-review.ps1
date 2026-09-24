param([string]$Profile = 'tax-fc-ak')

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bucket = 'tax-law-agent-1555315958533569-cn-beijing'
$prefix = "oss://$bucket/tax-agent/v1"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $workspace "output/tax-agent/cloud-review-$stamp"
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null

function Copy-OssObject([string]$source, [string]$destination) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  $arguments = @('--profile', $Profile, 'oss', 'cp', $source, $destination, '--cli-non-interactive')
  & aliyun @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "OSS 下载失败：$source" }
}

$reportFile = Join-Path $target 'cloud-latest.json'
Copy-OssObject "$prefix/reports/latest.json" $reportFile
$cloud = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $cloud.pending -or $cloud.pending.Count -gt 100) { throw '云端待审核清单格式或数量异常' }

foreach ($item in $cloud.pending) {
  $id = [string]$item.id
  $hash = [string]$item.hash
  if ($id -notmatch '^chinatax-[0-9]{4,16}$' -or $hash -notmatch '^[a-f0-9]{64}$') { throw '云端资料身份或版本校验值无效' }
  Copy-OssObject "$prefix/records/$id.json" (Join-Path $target "records/$id.json")
  $versionDir = Join-Path $target "versions/$id/$hash"
  New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
  $versionPrefix = "$prefix/versions/$id/$hash"
  Copy-OssObject "$versionPrefix/metadata.json" (Join-Path $versionDir 'metadata.json')
  $metadata = Get-Content -LiteralPath (Join-Path $versionDir 'metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $attachments = if ($null -eq $metadata.attachments) { @() } else { @($metadata.attachments) }
  if ($attachments.Count -gt 50) { throw "$id：附件数量异常" }
  foreach ($name in @('source.html', 'source.txt', 'review.md')) {
    Copy-OssObject "$versionPrefix/$name" (Join-Path $versionDir $name)
  }
  foreach ($attachment in $attachments) {
    $name = [string]$attachment.file
    if ($name -notmatch '^attachment-[1-9][0-9]*\.(pdf|docx?|xlsx?|zip)$') { throw "$id：附件文件名无效" }
    Copy-OssObject "$versionPrefix/$name" (Join-Path $versionDir $name)
  }
}

& node (Join-Path $workspace 'tax-agent/export-review.mjs') $target
if ($LASTEXITCODE -ne 0) { throw '云端审核包核验失败；请勿据此审核' }
