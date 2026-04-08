/**
 * main.js — Electron 主进程
 *
 * 职责：
 *  1. 创建主窗口（renderer/index.html）
 *  2. 处理截图流程：隐藏主窗口 → 截全屏 → 弹出 overlay → 接收裁剪坐标 → 回传给渲染层
 *  3. 通过 ipcMain 与渲染层通信
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
} = require('electron');
const path = require('path');

// ─── 全局窗口引用 ──────────────────────────────────────────────
let mainWindow = null;    // 主窗口
let captureWindow = null; // 截图选区 overlay 窗口

// ─── 创建主窗口 ────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f1a',
    title: '截图 OCR 工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 安全隔离：渲染层无法直接用 Node API
      nodeIntegration: false,   // 禁止渲染层直接 require()
      webSecurity: false,       // 允许渲染层 fetch 跨域（OCR API）
                                // ⚠️ 生产环境应改为 true 并配置 CSP
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发调试时取消注释
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App 生命周期 ──────────────────────────────────────────────
app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  // macOS 惯例：关闭所有窗口时不退出 app
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // macOS：点击 Dock 图标时重新创建窗口
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// ─── IPC: 开始截图流程 ─────────────────────────────────────────
//
// 流程：
//   渲染层点"截图" → invoke('start-capture')
//   → 隐藏主窗口
//   → desktopCapturer 截全屏
//   → 打开全屏 overlay 窗口
//   → 把全屏图传给 overlay
//
ipcMain.handle('start-capture', async () => {
  // 1. 先隐藏主窗口（避免截到自己）
  mainWindow.hide();
  await sleep(250); // 等窗口动画完成

  // 2. 获取主屏幕逻辑尺寸
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;

  // 3. 截取全屏（thumbnailSize 指定输出分辨率）
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
  } catch (err) {
    console.error('desktopCapturer 失败:', err);
    mainWindow.show();
    return;
  }

  if (!sources || sources.length === 0) {
    console.error('找不到屏幕源');
    mainWindow.show();
    return;
  }

  // 取第一个屏幕（主屏）转为 base64
  const fullScreenDataURL = sources[0].thumbnail.toDataURL();

  // 4. 创建全屏 overlay 窗口
  captureWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,          // 无边框
    alwaysOnTop: true,     // 始终在最前
    skipTaskbar: true,     // 不在任务栏显示
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  captureWindow.loadFile(path.join(__dirname, 'capture', 'overlay.html'));

  // 5. 页面加载完成后，把全屏截图发给 overlay
  captureWindow.webContents.once('did-finish-load', () => {
    captureWindow.webContents.send('init-overlay', {
      imageData: fullScreenDataURL,
      width,
      height,
    });
  });
});

// ─── IPC: overlay 完成选区，传来裁剪后的图 ─────────────────────
//
// overlay.js 在 mouseup 时裁剪好图片，通过此 channel 回传给主进程
// 主进程再把截图转发给主窗口渲染层
//
ipcMain.handle('capture-done', (event, croppedDataURL) => {
  closeCaptureWindow();
  mainWindow.show();
  mainWindow.focus();
  // 把裁剪好的截图发给主窗口
  mainWindow.webContents.send('screenshot-result', croppedDataURL);
});

// ─── IPC: 取消截图（按 ESC 或选区太小）────────────────────────
ipcMain.handle('capture-cancel', () => {
  closeCaptureWindow();
  mainWindow.show();
  mainWindow.focus();
});

// ─── 工具函数 ──────────────────────────────────────────────────
function closeCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
    captureWindow = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
