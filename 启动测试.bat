@echo off
setlocal EnableExtensions
title TOKENICODE Dev Launch
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot cd to project dir
  pause
  exit /b 1
)

echo.
echo ========================================
echo   TOKENICODE one-click dev launch
echo   Dir: %CD%
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js first.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found. Install Rust first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [1/2] First run: npm install ...
  echo       This may take a few minutes.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Try: pnpm install
    pause
    exit /b 1
  )
  echo.
  echo [1/2] Dependencies ready.
) else (
  echo [1/2] node_modules found, skip install.
)

echo.
echo [2/2] Starting: npm run tauri dev
echo       Dev server: http://localhost:14200
echo       First Rust build can take several minutes.
echo       Keep this window open. Ctrl+C to quit.
echo.

call npm run tauri dev
set "EXITCODE=%ERRORLEVEL%"

echo.
echo [DONE] exit code: %EXITCODE%
echo.
echo Temp launcher files (delete after testing):
echo   launch-dev.bat  /  this bat file
echo   _TEMP_launch_readme.txt
echo.
pause
exit /b %EXITCODE%
