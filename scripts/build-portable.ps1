<#
.SYNOPSIS
    Build the single-file portable EXE for Little Claude (Windows).
    Produces: dist-portable/LittleClaude-v<version>-Portable.exe

.DESCRIPTION
    The output EXE is fully self-contained:
      - Frontend assets embedded in the binary (no extraction, no temp files)
      - JS obfuscated at build time (control flow / string array / dead code)
      - No installer, no admin rights, double-click to run
    NOT bundled (by design, installed from the in-app Settings page / OS):
      - Claude CLI (Settings > Prerequisites, one-click install)
      - Node.js (auto-downloaded by the CLI installer when missing)
      - WebView2 runtime (Win10 20H2+ ships it; the app checks at startup
        and prompts with a download link if missing)

.PARAMETER SkipFrontend
    Skip `pnpm tauri build` and re-package from an existing
    src-tauri/target/release/tokenicode.exe (after a manual cargo build).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1

.NOTES
    Requires: pnpm + Node, Rust MSVC toolchain, WebView2 SDK headers
    (tauri-cli pulls them automatically).
#>
param([switch]$SkipFrontend)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 1. Full build: obfuscated frontend (beforeBuildCommand) + Rust release.
#    --no-bundle: no NSIS/MSI installer — the raw exe IS the portable app.
if (-not $SkipFrontend) {
    Write-Host "==> pnpm tauri build --no-bundle (frontend obfuscation + Rust release)..." -ForegroundColor Cyan
    pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "==> Skipping build (-SkipFrontend), packaging existing exe..." -ForegroundColor Cyan
}

# 2. Version from tauri.conf.json
$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = $conf.version

# 3. Collect + rename the portable exe
$exe = "src-tauri\target\release\little-claude.exe"
if (-not (Test-Path $exe)) { throw "missing $exe — run without -SkipFrontend first" }

$outDir = "dist-portable"
New-Item -ItemType Directory -Force $outDir | Out-Null
$dest = Join-Path $outDir "LittleClaude-v$version-Portable.exe"
Copy-Item $exe $dest -Force

# 4. Checksum + report
$item = Get-Item $dest
$hash = Get-FileHash $dest -Algorithm SHA256
$sizeMB = [math]::Round($item.Length / 1MB, 1)

Write-Host ""
Write-Host "Portable EXE ready:" -ForegroundColor Green
Write-Host "  $dest"
Write-Host "  Size  : $sizeMB MB"
Write-Host "  SHA256: $($hash.Hash)"
Write-Host ""
Write-Host "Distribute this single file. Notes:" -ForegroundColor Yellow
Write-Host "  - First run may show SmartScreen (unsigned) - More info > Run anyway"
Write-Host "  - Claude CLI / Node.js: install from Settings > Prerequisites"
Write-Host "  - WebView2: Win10 20H2+ built-in; app prompts if missing"
