#!/usr/bin/env bash
# ============================================================
#  video-analysis skill —— Git Bash / Linux 一键离线初始化
#  创建 .venv 并从内置 wheelhouse/ 安装全部 Python 依赖，
#  全程零联网。内置 wheels 面向 CPython 3.11 win_amd64；
#  其他平台请改用在线安装（见 USAGE.md §2）。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONUTF8=1

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3.11 >/dev/null 2>&1; then PY=python3.11
  elif command -v python3 >/dev/null 2>&1; then PY=python3
  else PY=python
  fi
fi

echo "[1/2] 使用 $PY 创建虚拟环境 .venv ..."
"$PY" -m venv .venv

if [ -x .venv/Scripts/python.exe ]; then VENV_PY=.venv/Scripts/python.exe
else VENV_PY=.venv/bin/python
fi

echo "[2/2] 从 wheelhouse/ 离线安装依赖（--no-index，不联网）..."
if ! "$VENV_PY" -m pip install --no-index --find-links wheelhouse -r requirements.txt; then
  echo "依赖安装失败：wheelhouse 可能与当前平台不匹配（内置 wheels 为 cp311 win_amd64）。" >&2
  echo "其他平台请改用在线安装：$VENV_PY -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple" >&2
  exit 1
fi

echo
echo "初始化完成。验证就绪："
echo "  $VENV_PY scripts/preflight.py --json"
