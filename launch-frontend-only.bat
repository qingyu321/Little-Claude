@echo off
setlocal EnableExtensions
title TOKENICODE Frontend Only
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot cd to project dir
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
  echo First run: npm install ...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo Starting Vite at http://localhost:14200
echo NOTE: browser preview has NO Tauri backend.
echo For full app, double-click: launch-dev.bat
echo.

start "" "http://localhost:14200"
call npm run dev

pause
