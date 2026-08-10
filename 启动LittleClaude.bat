@echo off
setlocal EnableExtensions
title Little Claude Dev Launch
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot cd to project dir
  pause
  exit /b 1
)

echo.
echo ========================================
echo   Little Claude one-click dev launch
echo   Dir: %CD%
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js first.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found. Install it first:
  echo         npm install -g pnpm
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found. Install Rust first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [1/2] First run: pnpm install ...
  echo       This may take a few minutes.
  echo.
  call pnpm install
  if errorlevel 1 (
    echo.
    echo [ERROR] pnpm install failed.
    pause
    exit /b 1
  )
  echo.
  echo [1/2] Dependencies ready.
) else (
  echo [1/2] node_modules found, skip install.
)

echo.
echo [2/2] Starting: pnpm tauri:dev
echo       Dev server: http://localhost:15200
echo       First Rust build can take several minutes.
echo       Keep this window open. Ctrl+C to quit.
echo.

call pnpm tauri:dev
set "EXITCODE=%ERRORLEVEL%"

echo.
echo [DONE] exit code: %EXITCODE%
echo.
pause
exit /b %EXITCODE%
