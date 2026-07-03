$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$archiveRoot = Join-Path $repoRoot "archive\review\2026-06-repo-cleanup"

$dirs = @(
  "OLD SITE BEFORE BRUTALISM",
  "Charms Web Tools\Image Tools\Noise Studio\Old Noise Studio Versions",
  "Charms Web Tools\Image Tools\Noise Studio\Saves",
  "Charms Web Tools\Image Tools\Background Remover\Old Background Remover Versions",
  "Charms Web Tools\Image Tools\Image Corruption\Old Image Corruption",
  "Charms Web Tools\Venge Modding\BEFORE BRUTAL UPDATE",
  "Charms Web Tools\Venge Modding\Modding Repository V2 (Official)\OLD PURPLE SITE",
  "Charms Web Tools\Extra Stuff Not on display"
)

New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null

$moved = @()
$missing = @()

foreach ($rel in $dirs) {
  $source = Join-Path $repoRoot $rel
  if (-not (Test-Path -LiteralPath $source)) {
    $missing += $rel
    continue
  }

  $parentRel = Split-Path -Parent $rel
  $destParent = if ([string]::IsNullOrWhiteSpace($parentRel)) {
    $archiveRoot
  } else {
    Join-Path $archiveRoot $parentRel
  }

  New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  Move-Item -LiteralPath $source -Destination $destParent
  $moved += $rel
}

Write-Host "Moved:"
$moved | ForEach-Object { Write-Host " - $_" }

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "Missing:"
  $missing | ForEach-Object { Write-Host " - $_" }
}
