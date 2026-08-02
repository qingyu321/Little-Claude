@echo off
setlocal EnableDelayedExpansion
title Claude Code 一键安装向导 (CCSwitch + DeepSeek)
cd /d "%~dp0"

:: ============================================================
::  Claude Code 一键安装脚本
::  整合 Node.js / Git / CCSwitch / Claude Code / DeepSeek
::  基于 B站教程 BV16YRLB7Exd (UP: Yin_Code)
::  适用: Windows 10/11 x64
:: ============================================================

echo.
echo   ╔══════════════════════════════════════════════════╗
echo   ║     Claude Code 一键安装向导                      ║
echo   ║     整合 CCSwitch ^& DeepSeek V4                   ║
echo   ║     适用于 Windows 10/11 x64                      ║
echo   ╚══════════════════════════════════════════════════╝
echo.
echo   本脚本将依次完成:
echo     [1] 检查/安装 Node.js
echo     [2] 配置 npm 国内镜像
echo     [3] 检查/安装 Git
echo     [4] 下载安装 CCSwitch
echo     [5] 安装 Claude Code
echo     [6] 配置 Claude 跳过登录
echo     [7] DeepSeek API 接入指引
echo.
echo   ⚠ 安装过程中可能需要你点击确认，请勿离开。
echo.

pause

:: ============================================================
:: [1] 检查 Node.js
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [1/7] 检查 Node.js 环境...
echo   ─────────────────────────────────────────────
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   ❌ 未检测到 Node.js
    echo.
    echo   正在打开 Node.js 官网下载页...
    echo   请下载 LTS 版本，双击安装，一路 "Next" 即可。
    echo   安装完成后，重新运行本脚本。
    echo.
    start https://npmmirror.com/mirrors/node/v22.18.0/node-v22.18.0-x64.msi
    echo   ⏳ 按任意键退出，安装完 Node.js 后重新运行本脚本...
    pause >nul
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo   ✅ Node.js 已安装: %NODE_VER%

:: ============================================================
:: [2] 配置 npm 国内镜像
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [2/7] 配置 npm 国内镜像...
echo   ─────────────────────────────────────────────
echo.

echo   正在设置 npm 镜像为 npmmirror.com ...
call npm config set registry https://registry.npmmirror.com/ 2>nul
if errorlevel 1 (
    echo   ⚠ 镜像设置失败，将使用默认源（可能较慢）
) else (
    echo   ✅ npm 镜像已设置为国内源
)

:: ============================================================
:: [3] 检查 Git
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [3/7] 检查 Git 环境...
echo   ─────────────────────────────────────────────
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo   ❌ 未检测到 Git
    echo.
    echo   正在打开 Git 官网下载页...
    echo   请下载 Windows 版本，双击安装，一路 "Next" 即可。
    echo   安装完成后，重新运行本脚本。
    echo.
    start https://npmmirror.com/mirrors/git-for-windows/v2.50.0.windows.1/Git-2.50.0-64-bit.exe
    echo   ⏳ 按任意键退出，安装完 Git 后重新运行本脚本...
    pause >nul
    exit /b 1
)

for /f "tokens=*" %%i in ('git --version') do set GIT_VER=%%i
echo   ✅ Git 已安装: %GIT_VER%

:: ============================================================
:: [4] 下载安装 CCSwitch
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [4/7] 下载安装 CCSwitch...
echo   ─────────────────────────────────────────────
echo.

:: 检测 CCSwitch 是否已安装
set "CC_INSTALLED="
if exist "C:\Program Files\CC Switch\CC Switch.exe" set CC_INSTALLED=1
if exist "C:\Program Files (x86)\CC Switch\CC Switch.exe" set CC_INSTALLED=1
if exist "%USERPROFILE%\AppData\Local\Programs\cc-switch\CC Switch.exe" set CC_INSTALLED=1
if exist "%USERPROFILE%\AppData\Local\cc-switch\CC Switch.exe" set CC_INSTALLED=1
if exist "%LOCALAPPDATA%\cc-switch\CC Switch.exe" set CC_INSTALLED=1
:: also check D drive
if exist "D:\soft\CC Switch\CC Switch.exe" set CC_INSTALLED=1

if defined CC_INSTALLED (
    echo   ✅ CCSwitch 已安装（检测到已有文件）
    goto :skip_ccswitch
)

:: 下载 CCSwitch
set "CC_DOWNLOAD_URL=https://github.com/gtsdragon/cc-switch/releases/latest/download/CC-Switch-Windows.msi"
set "CC_FILE=%TEMP%\CC-Switch-Windows.msi"

echo   正在下载 CCSwitch 安装包...
echo   如果下载缓慢，请等待或手动访问 https://ccswitch.io/zh/ 下载
echo.

:: 尝试用 ghproxy 加速（国内用户友好）
echo   尝试国内加速下载...
curl -L -o "%CC_FILE%" "https://ghproxy.com/%CC_DOWNLOAD_URL%" 2>nul
if errorlevel 1 (
    echo   国内加速失败，尝试直连 GitHub...
    curl -L -o "%CC_FILE%" "%CC_DOWNLOAD_URL%" 2>nul
)

if not exist "%CC_FILE%" (
    echo.
    echo   ⚠ 自动下载失败。正在打开 CCSwitch 官网...
    echo   请手动下载 MSI 安装包并安装。
    echo   安装完成后按任意键继续...
    start https://ccswitch.io/zh/
    pause >nul
    goto :skip_ccswitch
)

echo   ✅ 下载完成，正在启动安装程序...
echo   请在弹出的安装向导中点击 Next → Install → Finish
echo.
msiexec /i "%CC_FILE%" /passive

:skip_ccswitch
echo   ✅ CCSwitch 步骤完成

:: ============================================================
:: [5] 安装 Claude Code
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [5/7] 安装 Claude Code...
echo   ─────────────────────────────────────────────
echo.

where claude >nul 2>nul
if not errorlevel 1 (
    for /f "tokens=*" %%i in ('claude --version 2^>nul') do set CC_VER=%%i
    echo   ✅ Claude Code 已安装: !CC_VER!
    goto :skip_claude_install
)

echo   正在通过 npm 安装 Claude Code...
echo   这可能需要 1-3 分钟，请耐心等待...
echo.

call npm install -g @anthropic-ai/claude-code
if errorlevel 1 (
    echo.
    echo   ❌ 安装失败。常见原因：
    echo      1. npm 权限不足 - 请以管理员身份运行本脚本
    echo      2. 网络问题 - 请检查网络连接
    echo.
    echo   按任意键退出...
    pause >nul
    exit /b 1
)

echo   ✅ Claude Code 安装完成

:: 验证安装
where claude >nul 2>nul
if not errorlevel 1 (
    for /f "tokens=*" %%i in ('claude --version 2^>nul') do echo   版本: %%i
)

:skip_claude_install

:: ============================================================
:: [6] 配置 Claude 跳过登录
:: ============================================================
echo.
echo   ─────────────────────────────────────────────
echo   [6/7] 配置 Claude 跳过登录...
echo   ─────────────────────────────────────────────
echo.

set "CLAUDE_JSON=%USERPROFILE%\.claude.json"

:: 使用 PowerShell 处理 JSON（批处理不擅长 JSON 操作）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$path = '%CLAUDE_JSON%'; " ^
    "if (-not (Test-Path $path)) { " ^
    "    '{}' | Out-File -FilePath $path -Encoding UTF8; " ^
    "    Write-Host '  已创建 .claude.json 文件'; " ^
    "} " ^
    "try { " ^
    "    $json = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json; " ^
    "} catch { " ^
    "    $json = @{}; " ^
    "    Write-Host '  ⚠ JSON 格式有问题，将重建文件'; " ^
    "} " ^
    "if (-not (Get-Member -InputObject $json -Name 'hasCompletedOnboarding' -MemberType NoteProperty)) { " ^
    "    $json | Add-Member -NotePropertyName 'hasCompletedOnboarding' -NotePropertyValue $true -Force; " ^
    "    $json | ConvertTo-Json -Depth 10 | Out-File -FilePath $path -Encoding UTF8; " ^
    "    Write-Host '  ✅ 已添加 hasCompletedOnboarding: true'; " ^
    "} else { " ^
    "    $json.hasCompletedOnboarding = $true; " ^
    "    $json | ConvertTo-Json -Depth 10 | Out-File -FilePath $path -Encoding UTF8; " ^
    "    Write-Host '  ✅ hasCompletedOnboarding 已确认为 true'; " ^
    "}"

if errorlevel 1 (
    echo   ⚠ JSON 自动配置失败。请手动操作：
    echo      1. 打开文件管理器
    echo      2. 在地址栏输入: %USERPROFILE%
    echo      3. 找到 .claude.json 文件
    echo      4. 用记事本打开，确保其中有: "hasCompletedOnboarding": true
    echo         （注意逗号！如果上一行末尾没有逗号要加上英文逗号）
)
echo.

:: ============================================================
:: [7] DeepSeek API 接入指引
:: ============================================================
echo   ─────────────────────────────────────────────
echo   [7/7] DeepSeek API 接入指引
echo   ─────────────────────────────────────────────
echo.
echo   🔑 请按以下步骤获取 DeepSeek API Key:
echo.
echo      1. 打开 DeepSeek 官网: https://platform.deepseek.com
echo      2. 注册/登录 → 点击左侧 "API Keys"
echo      3. 点击 "创建 API Key" → 输入名称 → 创建
echo      4. ⚠ 立即复制保存 Key！关闭后无法再次查看
echo      5. 打开 CCSwitch (开始菜单搜索 CC Switch)
echo      6. 点击右下角 + 号 → 选择 DeepSeek 预设
echo      7. 填入 API Key → 所有模型改为: deepseek-v4-pro[1m]
echo         (带 [1m] 表示 100万上下文，不加则默认 128K)
echo      8. 点击 添加 按钮
echo.
echo   🎉 配置完毕！在命令行输入 claude 即可启动。
echo      输入 /model 可查看/切换已配置的模型。
echo.

:: ============================================================
:: 最终检查
:: ============================================================
echo   ═══════════════════════════════════════════════
echo   ✅ 安装完成！环境检查:
echo   ═══════════════════════════════════════════════
echo.
echo     Node.js : %NODE_VER%
echo     Git     : %GIT_VER%
where claude >nul 2>nul && for /f "tokens=*" %%i in ('claude --version 2^>nul') do echo     Claude  : %%i
echo     CCSwitch: 请从开始菜单启动
echo.
echo   ⚠ 若还未配置 DeepSeek API Key，请参考上方 [7/7] 指引
echo.
echo   按任意键退出...
pause >nul
exit /b 0
