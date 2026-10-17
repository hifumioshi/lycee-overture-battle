# Upload incremental-update files to your own server (only changed files, usually a few hundred KB).
#
# Usage:
#   powershell -File tools/upload-updates.ps1 -Server ubuntu@62.234.140.123
#   powershell -File tools/upload-updates.ps1 -Server ubuntu@62.234.140.123 -RemoteDir '~/updates-dist'
#   powershell -File tools/upload-updates.ps1 -Server ... -All      # upload everything (first deploy)
#
# Requires OpenSSH client (Windows 10 1809+ ships scp/ssh). It will ask for your password.

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteDir = '~/updates-dist',
  [string]$LocalDir = '',
  [switch]$All
)

$ErrorActionPreference = 'Stop'
# NOTE: $PSScriptRoot is NOT available inside param() defaults on Windows PowerShell 5.1,
# so resolve the local folder here in the body instead.
if (-not $LocalDir) { $LocalDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'updates-dist' }
$LocalDir = (Resolve-Path $LocalDir).Path

if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  Write-Host '[!] scp not found. Install OpenSSH Client: Settings - Apps - Optional features.' -ForegroundColor Red
  exit 1
}

# 1) decide which files to upload
$files = @()
if ($All) {
  $files = Get-ChildItem $LocalDir -Recurse -File | ForEach-Object { $_.FullName.Substring($LocalDir.Length + 1) }
} elseif (Test-Path (Join-Path $LocalDir 'upload-list.txt')) {
  $files = Get-Content (Join-Path $LocalDir 'upload-list.txt') | Where-Object { $_.Trim() -ne '' }
} else {
  Write-Host '[!] upload-list.txt not found. Run: npm run pack:update' -ForegroundColor Red
  exit 1
}

$total = 0
$paths = @()
foreach ($f in $files) {
  $abs = Join-Path $LocalDir ($f -replace '/', '\')
  if (Test-Path $abs) {
    $total += (Get-Item $abs).Length
    $paths += $abs
  } else {
    Write-Host "  (skip missing: $f)" -ForegroundColor DarkYellow
  }
}
$sizeText = if ($total -ge 1MB) { '{0:N2} MB' -f ($total / 1MB) } else { '{0:N1} KB' -f ($total / 1KB) }
Write-Host "Uploading $($paths.Count) file(s), total $sizeText -> ${Server}:$RemoteDir" -ForegroundColor Cyan
if ($paths.Count -eq 0) { Write-Host 'Nothing to upload.'; exit 0 }

# 2) create remote directories (scp does not create them)
$dirs = @($RemoteDir)
foreach ($f in $files) {
  $sub = Split-Path ($f -replace '/', '\') -Parent
  if ($sub) { $dirs += "$RemoteDir/$($sub -replace '\\', '/')" }
}
$dirs = $dirs | Sort-Object -Unique
Write-Host 'Creating remote directories...' -ForegroundColor DarkGray
& ssh $Server "mkdir -p $($dirs -join ' ')"
if ($LASTEXITCODE -ne 0) { Write-Host '[!] ssh mkdir failed (check address/password/firewall)' -ForegroundColor Red; exit 1 }

# 3) upload file by file, grouped by directory
foreach ($d in $dirs) {
  $rel = $d.Substring($RemoteDir.Length).TrimStart('/')
  $srcDir = if ($rel) { Join-Path $LocalDir ($rel -replace '/', '\') } else { $LocalDir }
  if (-not (Test-Path $srcDir)) { continue }
  $names = @()
  foreach ($p in $paths) { if ((Split-Path $p -Parent) -eq $srcDir) { $names += $p } }
  if ($names.Count -eq 0) { continue }
  Write-Host "  upload $rel ($($names.Count) file(s))..." -ForegroundColor DarkGray
  & scp @names "${Server}:$d/"
  if ($LASTEXITCODE -ne 0) { Write-Host "[!] upload failed: $rel" -ForegroundColor Red; exit 1 }
}

# 4) verify remote manifest version
Write-Host 'Verifying remote manifest...' -ForegroundColor DarkGray
$localVer = (Get-Content (Join-Path $LocalDir 'manifest.json') -Raw | ConvertFrom-Json).version
$remoteHead = (& ssh $Server "head -c 200 $RemoteDir/manifest.json" | Out-String)
if ($remoteHead -match [regex]::Escape($localVer)) {
  Write-Host "[OK] Done. Remote content version is v$localVer" -ForegroundColor Green
} else {
  Write-Host "[!] Uploaded, but could not confirm the remote version (local is v$localVer). Check manually." -ForegroundColor Yellow
}
