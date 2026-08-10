<#
.SYNOPSIS
    Build the frontend hot-update package for Little Claude (免重装升级).
    Produces:
      web-dist/web-dist-v<version>.zip   — dist/ 内容 + manifest.json（zip 条目无目录前缀）
      web-dist/latest.json               — 检查清单（版本/直链/SHA256/rustChanged）

.DESCRIPTION
    Workflow for a hot-update release (frontend-only changes):
      1. powershell -ExecutionPolicy Bypass -File scripts\make-web-update.ps1
      2. Upload web-dist/web-dist-v<version>.zip as an asset of the GitHub
         release v<version> (zipUrl below must match the asset download URL).
      3. Commit web-dist/latest.json to the repo root (NOT as a release asset —
         raw.githubusercontent + jsdelivr CDN serve it for the in-app checker).
      4. Done — the app picks it up on its next auto-check (10 min) or via
         Settings > 检查更新.

    If the release also contains Rust (engine) changes, pass -RustChanged:
      the app then shows "Download installer" instead of hot-updating.

.PARAMETER Version
    Override the package version (default: tauri.conf.json version).

.PARAMETER RustChanged
    Set rustChanged=true in latest.json (engine changes → installer path).

.PARAMETER SkipBuild
    Re-package from an existing dist/ (after a manual pnpm build).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make-web-update.ps1

.NOTES
    zip layout: entries are relative (index.html at root) — the Rust extractor
    joins entry names directly under the version dir (no prefix stripping).
    manifest.json inside the zip MUST match the version the app was told to
    apply (integrity gate before the atomic pointer switch).
#>
param(
  [string]$Version,
  [switch]$RustChanged,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 1. Version (default: tauri.conf.json)
if (-not $Version) {
    $conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $Version = $conf.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+') {
    throw "invalid version: $Version (expect X.Y.Z)"
}

# 2. Frontend build
if (-not $SkipBuild) {
    Write-Host "==> pnpm build (frontend production)..." -ForegroundColor Cyan
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit $LASTEXITCODE)" }
}

# 3. Write integrity manifest into dist/
$distDir = Join-Path $root "dist"
if (-not (Test-Path (Join-Path $distDir "index.html"))) {
    throw "missing $distDir\index.html — run without -SkipBuild first"
}
$manifest = @{
    version     = $Version
    rustChanged = [bool]$RustChanged
} | ConvertTo-Json -Compress
# UTF-8 无 BOM（PowerShell 5.1 的 Set-Content -Encoding utf8 会写 BOM）
[System.IO.File]::WriteAllText((Join-Path $distDir "manifest.json"), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# 4. Zip dist/ → web-dist/web-dist-v<version>.zip（条目相对路径，无 dist/ 前缀）
$outDir = Join-Path $root "web-dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$zipPath = Join-Path $outDir "web-dist-v$Version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

# 手动建条目：强制 zip 条目用正斜杠（.NET CreateFromDirectory 在 Windows
# 上写反斜杠，zip crate 在 macOS 会把 "assets\a.js" 当单一文件名 → 解压损坏）
function New-ZipFromDirectory([string]$sourceDir, [string]$zipPath) {
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem $sourceDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($sourceDir.Length + 1).Replace('\', '/')
            $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
            $in = [System.IO.File]::OpenRead($_.FullName)
            try {
                $out = $entry.Open()
                try { $in.CopyTo($out) } finally { $out.Dispose() }
            } finally { $in.Dispose() }
        }
    } finally {
        $zip.Dispose()
    }
}
New-ZipFromDirectory $distDir $zipPath

# 5. SHA256
$hash = Get-FileHash $zipPath -Algorithm SHA256
$sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)

# 6. latest.json（检查清单；前端多源读取：raw → jsdelivr → ghproxy）
$releaseUrl = "https://github.com/qingyu321/Little-Claude/releases/tag/v$Version"
$zipUrl = "https://github.com/qingyu321/Little-Claude/releases/download/v$Version/web-dist-v$Version.zip"
$latest = @{
    version     = $Version
    zipUrl      = $zipUrl
    sha256      = $hash.Hash.ToLowerInvariant()
    rustChanged = [bool]$RustChanged
    releaseUrl  = $releaseUrl
} | ConvertTo-Json -Compress
$latestPath = Join-Path $outDir "latest.json"
[System.IO.File]::WriteAllText($latestPath, $latest, (New-Object System.Text.UTF8Encoding($false)))

# 7. Report
Write-Host ""
Write-Host "Hot-update package ready:" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host "  Size  : $sizeKB KB"
Write-Host "  SHA256: $($hash.Hash.ToLowerInvariant())"
Write-Host ""
Write-Host "Upload steps:" -ForegroundColor Yellow
Write-Host "  1. Create GitHub release v$Version (tag v$Version) and attach:"
Write-Host "       $([System.IO.Path]::GetFileName($zipPath))"
Write-Host "  2. Commit web-dist\latest.json to the repo ROOT as latest.json:"
Write-Host "       $latestPath"
Write-Host "     (plain file in the repo — NOT a release asset; keep it updated"
Write-Host "      for every hot-update release, overwrite each time)"
Write-Host "  3. Users see the update on their next auto-check (or Settings > 检查更新)"
