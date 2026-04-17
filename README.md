# 截图 OCR · Screenshot OCR

> 截图即识字 — 框选任意区域，文字即刻提取  
> Select any area on screen, text is extracted instantly.

**版本 Version:** v0.1.0 · **平台 Platform:** macOS（Windows/Linux 即将支持）

---

## 功能 Features

| 功能 | Feature |
|------|---------|
| 区域截图，拖拽选区 | Area screenshot with drag selection |
| 多显示器支持 | Multi-monitor support |
| EasyOCR 本地识别，无需联网 | Local OCR via EasyOCR, works offline |
| 全局快捷键，随时唤起 | Global shortcut, trigger from anywhere |
| 常驻系统托盘，后台运行 | Lives in system tray, always running |
| 识别结果一键复制 | One-click copy of OCR results |
| 截图标注（矩形框选） | Annotation with rectangle overlays |

---

## 安装 Installation

从 [Releases](../../releases) 下载最新的 `.dmg`（macOS）或 `.exe`（Windows），安装后直接双击打开，无需额外配置。

Download the latest `.dmg` (macOS) or `.exe` (Windows) from [Releases](../../releases). Double-click to install — no setup required.

---

## 使用方式 Usage

1. 启动后应用自动常驻系统托盘 / App runs in the system tray after launch
2. 按 **F1**（默认快捷键）启动截图模式 / Press **F1** (default) to start capture
3. 拖拽选取要识别的区域 / Drag to select the area you want to recognize
4. 文字自动出现在面板中，点击复制 / Recognized text appears in the panel — click to copy

> 快捷键可在主窗口设置中自定义。  
> The shortcut key can be customized in the main window settings.

---

## 开发者指南 Developer Guide

### 环境需求 Requirements

- Node.js 18+
- Python 3.8+
- pip packages: `pip install -r requirements.txt`

### 本地开发 Local development

```bash
git clone <repo-url>
cd screenshot-ocr
npm install
pip install -r requirements.txt
npm start
```

### 打包发布 Build for distribution

```bash
chmod +x build.sh
./build.sh
```

完成后 `dist/` 目录内会生成安装包。  
The installer will be generated in the `dist/` directory.

| 平台 Platform | 输出 Output |
|--------------|------------|
| macOS | `dist/截图OCR-x.x.x.dmg` |
| Windows | `dist/截图OCR Setup x.x.x.exe` |
| Linux | `dist/截图OCR-x.x.x.AppImage` |

---

## 技术栈 Tech Stack

- **Electron** — 跨平台桌面框架 / Cross-platform desktop framework
- **EasyOCR** — 本地 AI 文字识别 / Local AI-powered OCR
- **Flask** — Python OCR 微服务 / Python OCR microservice
- **PyInstaller** — Python 打包为独立二进制 / Packages Python into standalone binary

---

## 路线图 Roadmap

- [ ] Windows / Linux 正式支持 / Official Windows & Linux support
- [ ] 截图历史记录 / Screenshot history
- [ ] 自定义 OCR 语言包 / Custom OCR language packs
- [ ] 云端同步 / Cloud sync

---

## 许可 License

MIT
