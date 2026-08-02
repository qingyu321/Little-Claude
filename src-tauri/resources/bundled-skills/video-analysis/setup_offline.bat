@echo off
rem ============================================================
rem  video-analysis skill —— Windows 一键离线初始化
rem  创建 .venv 并从内置 wheelhouse/ 安装全部 Python 依赖，
rem  全程零联网。内置 wheels 面向 CPython 3.11 win_amd64。
rem ============================================================
setlocal
set PYTHONUTF8=1
cd /d "%~dp0"

rem 优先使用 Python 3.11（与内置 wheels 匹配），其次任意 Python 3
set PY=
where py >nul 2>nul && (
  py -3.11 -c "import sys" >nul 2>nul && set PY=py -3.11
)
if not defined PY (
  where py >nul 2>nul && set PY=py -3
)
if not defined PY set PY=python

echo [1/2] 使用 %PY% 创建虚拟环境 .venv ...
%PY% -m venv .venv
if errorlevel 1 (
  echo 创建虚拟环境失败：请确认已安装 Python 3.10+（64 位）且在 PATH 中。
  exit /b 1
)

echo [2/2] 从 wheelhouse\ 离线安装依赖（--no-index，不联网）...
.venv\Scripts\python.exe -m pip install --no-index --find-links wheelhouse -r requirements.txt
if errorlevel 1 (
  echo 依赖安装失败：wheelhouse 可能与当前 Python 版本不匹配（内置 wheels 为 cp311 win_amd64）。
  echo 其他版本请改用在线安装：.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  exit /b 1
)

echo.
echo 初始化完成。验证就绪：
echo   .venv\Scripts\python.exe scripts\preflight.py --json
endlocal
