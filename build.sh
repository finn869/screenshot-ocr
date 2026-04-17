#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# build.sh — 一键打包脚本
#
# 完成后会在 dist/ 目录生成：
#   macOS  → dist/截图OCR-1.0.0.dmg（含 .app）
#   Windows → dist/截图OCR Setup 1.0.0.exe
#   Linux  → dist/截图OCR-1.0.0.AppImage
# ─────────────────────────────────────────────────────────────────
set -e

echo "📦 Step 1: 安装 Node 依赖…"
npm install

echo ""
echo "🐍 Step 2: 用 PyInstaller 打包 OCR 服务…"
echo "   （首次运行会安装 pyinstaller，约需 1~2 分钟）"

# 找到可用的 python3
PYTHON=$(command -v python3 || command -v python)
if [ -z "$PYTHON" ]; then
  echo "❌ 找不到 Python，请先安装 Python 3"
  exit 1
fi
echo "   使用 Python: $PYTHON ($($PYTHON --version))"

# 确保 pyinstaller 已安装（用 python -m pip 避免 PATH 问题）
$PYTHON -m pip install pyinstaller --quiet 2>/dev/null || \
$PYTHON -m pip install pyinstaller --quiet --break-system-packages 2>/dev/null || \
$PYTHON -m pip install pyinstaller --quiet --user 2>/dev/null

# 用 python -m PyInstaller 调用（不依赖 PATH 里的 pyinstaller 命令）
$PYTHON -m PyInstaller ocr_server.py \
  --onefile \
  --name ocr_server \
  --distpath build-python \
  --clean \
  --noconfirm \
  --hidden-import easyocr \
  --hidden-import flask \
  --hidden-import PIL \
  --collect-all easyocr

echo ""
echo "⚡️ Step 3: 用 electron-builder 打包 Electron 应用…"
npx electron-builder --mac  # 改成 --win 或 --linux 可跨平台打包

echo ""
echo "✅ 打包完成！检查 dist/ 目录："
ls -lh dist/ 2>/dev/null || echo "（dist/ 目录未找到，请检查错误）"
