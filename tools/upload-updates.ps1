# 把增量更新文件上传到自己的服务器（只传新变化的部分，通常几百 KB）
#
# 用法：
#   powershell -File tools/upload-updates.ps1 -Server ubuntu@62.234.140.123
#   powershell -File tools/upload-updates.ps1 -Server ubuntu@62.234.140.123 -RemoteDir '~/updates-dist'
#   powershell -File tools/upload-updates.ps1 -Server ... -All     # 强制全量上传（第一次部署用得上）
#
# 依赖 Windows 自带的 OpenSSH（Win10 1809+ 默认带 scp/ssh）。第一次连接会问 yes/no，再输密码。

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteDir = '~/updates-dist',
  [string]$LocalDir = "$PSScriptRoot\..\updates-dist",
  [switch]$All
)

$ErrorActionPreference = 'Stop'
$LocalDir = (Resolve-Path $LocalDir).Path

if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  Write-Host '✗ 找不到 scp：请在「设置 → 应用 → 可选功能」里安装 OpenSSH 客户端' -ForegroundColor Red
  exit 1
}

# 1. 决定要传哪些文件
$files = @()
if ($All) {
  $files = Get-ChildItem $LocalDir -Recurse -File | ForEach-Object { $_.FullName.Substring($LocalDir.Length + 1) }
} elseif (Test-Path (Join-Path $LocalDir 'upload-list.txt')) {
  $files = Get-Content (Join-Path $LocalDir 'upload-list.txt') | Where-Object { $_.Trim() -ne '' }
} else {
  Write-Host '✗ 找不到 upload-list.txt，请先运行：npm run pack:update' -ForegroundColor Red
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
    Write-Host "  (跳过不存在的文件：$f)" -ForegroundColor DarkYellow
  }
}
$sizeText = if ($total -ge 1MB) { '{0:N2} MB' -f ($total / 1MB) } else { '{0:N1} KB' -f ($total / 1KB) }
Write-Host "准备上传 $($paths.Count) 个文件，共 $sizeText → $Server`:$RemoteDir" -ForegroundColor Cyan
if ($paths.Count -eq 0) { Write-Host '没有需要上传的文件。'; exit 0 }

# 2. 在服务器上建好目录（scp 不会自动建多级目录）
$dirs = @($RemoteDir)
foreach ($f in $files) {
  $sub = Split-Path ($f -replace '/', '\') -Parent
  if ($sub) { $dirs += "$RemoteDir/$($sub -replace '\\', '/')" }
}
$dirs = $dirs | Sort-Object -Unique
Write-Host '在服务器上创建目录…' -ForegroundColor DarkGray
& ssh $Server "mkdir -p $($dirs -join ' ')"
if ($LASTEXITCODE -ne 0) { Write-Host '✗ ssh 建目录失败（检查地址/密码/防火墙）' -ForegroundColor Red; exit 1 }

# 3. 逐个上传（按目录分组，保留相对路径）
foreach ($d in $dirs) {
  $rel = $d.Substring($RemoteDir.Length).TrimStart('/')
  $srcDir = if ($rel) { Join-Path $LocalDir ($rel -replace '/', '\') } else { $LocalDir }
  if (-not (Test-Path $srcDir)) { continue }
  $names = @()
  foreach ($p in $paths) { if ((Split-Path $p -Parent) -eq $srcDir) { $names += $p } }
  if ($names.Count -eq 0) { continue }
  Write-Host "  上传 $rel ($($names.Count) 个)…" -ForegroundColor DarkGray
  & scp @names "$Server`:$d/"
  if ($LASTEXITCODE -ne 0) { Write-Host "✗ 上传失败：$rel" -ForegroundColor Red; exit 1 }
}

# 4. 校验服务器上的清单版本
Write-Host '校验服务器上的清单…' -ForegroundColor DarkGray
$localVer = (Get-Content (Join-Path $LocalDir 'manifest.json') -Raw | ConvertFrom-Json).version
$remoteVer = (& ssh $Server "head -c 200 $RemoteDir/manifest.json" | Out-String)
if ($remoteVer -match [regex]::Escape($localVer)) {
  Write-Host "✓ 上传完成，服务器上的内容版本已是 v$localVer" -ForegroundColor Green
} else {
  Write-Host "⚠ 上传完成，但没能确认服务器清单版本（本地是 v$localVer），请手动检查一次" -ForegroundColor Yellow
}
