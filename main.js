/**
 * main.js — Electron 主进程
 *
 * 功能：
 *  - globalShortcut 快捷键（预设 F1，可从渲染层修改）
 *  - 多显示器支持：截取所有屏幕，overlay 各屏独立覆盖
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  globalShortcut,
  dialog,
  nativeImage,
  Tray,
  Menu,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');

// ─── EasyOCR Python 服务 ────────────────────────────────────────
const OCR_SERVER_PORT = 7788;
let ocrServerProcess = null;

/**
 * 启动本地 EasyOCR Python 服务
 *
 * 打包后（app.isPackaged = true）：
 *   使用 PyInstaller 生成的独立二进制，路径在 process.resourcesPath/ocr_server
 *
 * 开发时（npm start）：
 *   使用系统 python3 直接运行 ocr_server.py
 */
function startOcrServer() {
  let cmd, args;

  if (app.isPackaged) {
    // ── 打包后：使用内嵌的独立二进制 ────────────────────────────
    const binaryName = process.platform === 'win32' ? 'ocr_server.exe' : 'ocr_server';
    cmd  = path.join(process.resourcesPath, binaryName);
    args = [];
    console.log('[OCR] 使用内嵌二进制:', cmd);
  } else {
    // ── 开发模式：使用系统 Python ──────────────────────────────
    cmd  = process.platform === 'win32' ? 'python' : 'python3';
    args = [path.join(__dirname, 'ocr_server.py')];
    console.log('[OCR] 开发模式，使用 python3 ocr_server.py');
  }

  console.log('[OCR] 正在启动 EasyOCR 服务…');

  ocrServerProcess = spawn(cmd, args, {
    env: { ...process.env, OCR_PORT: String(OCR_SERVER_PORT) },
    // detached: false 确保主进程退出时子进程也被终止
  });

  ocrServerProcess.stdout.on('data', (data) => {
    console.log('[OCR-Server]', data.toString().trim());
  });

  ocrServerProcess.stderr.on('data', (data) => {
    // EasyOCR 会把模型加载进度打到 stderr，正常现象
    console.log('[OCR-Server]', data.toString().trim());
  });

  ocrServerProcess.on('exit', (code) => {
    console.log(`[OCR] 服务已退出，代码: ${code}`);
    ocrServerProcess = null;
  });

  ocrServerProcess.on('error', (err) => {
    console.error('[OCR] 无法启动 Python 进程:', err.message);
    console.error('[OCR] 请确认已执行：pip install -r requirements.txt');
  });
}

/**
 * 终止 OCR 服务进程
 */
function stopOcrServer() {
  if (ocrServerProcess) {
    console.log('[OCR] 正在关闭 EasyOCR 服务…');
    ocrServerProcess.kill();
    ocrServerProcess = null;
  }
}

/**
 * 检查 OCR 服务是否就绪（轮询 /health，最多等 60 秒）
 * @returns {Promise<boolean>}
 */
async function waitForOcrServer(maxWaitMs = 60000, intervalMs = 1000) {
  const url = `http://127.0.0.1:${OCR_SERVER_PORT}/health`;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        console.log('[OCR] 服务已就绪 ✓');
        return true;
      }
    } catch (_) {
      // 服务尚未启动，继续等待
    }
    await sleep(intervalMs);
  }

  console.warn('[OCR] 等待超时，服务可能尚未就绪');
  return false;
}

// 渲染层查询 OCR 服务地址（供 renderer 层使用）
ipcMain.handle('get-ocr-server-url', () => `http://127.0.0.1:${OCR_SERVER_PORT}`);

// ─── 全局变量 ──────────────────────────────────────────────────
let mainWindow     = null;
let tray           = null;   // 系统托盘图标
let captureWindows = [];   // 每个显示器各一个 overlay 窗口
let currentShortcut = 'F1';

// 防止 capture-done / capture-cancel 被多个 overlay 重复触发
let isCapturing = false;

// ─── 创建系统托盘 ──────────────────────────────────────────────
function createTray() {
  // 尝试加载托盘图标，找不到就用空白图标兜底
  let trayIcon;
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // 生成一个 16×16 的纯色占位图标（PNG 格式）
    trayIcon = nativeImage.createEmpty();
  }

  // macOS 建议使用 Template image（黑白图标会自动适配深色/浅色模式）
  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('截图 OCR 工具');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow(),
    },
    {
      label: `截图 (${currentShortcut})`,
      click: () => triggerCapture(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 单击托盘图标显示/隐藏主窗口（Windows / Linux 常见交互）
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
}

// 显示并聚焦主窗口（不存在则重建）
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// 更新托盘菜单中的快捷键显示
function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow(),
    },
    {
      label: `截图 (${currentShortcut})`,
      click: () => triggerCapture(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

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
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,   // 允许跨域 fetch（OCR API）
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // mainWindow.webContents.openDevTools();

  // ── 关闭时隐藏到托盘，而非退出 ──────────────────────────────
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();   // 阻止真正关闭
      mainWindow.hide();         // 隐藏到托盘
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App 生命周期 ──────────────────────────────────────────────
app.whenReady().then(async () => {
  // macOS：阻止 Dock 显示（可选，像 Snipaste 一样纯托盘驻留）
  // 如果你希望 Dock 中也保留图标，把下面这行注释掉
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  // 先启动 OCR 服务（后台非阻塞），再建立托盘和窗口
  startOcrServer();
  createTray();        // 托盘先建，快捷键触发不依赖主窗口

  createMainWindow();
  registerShortcut(currentShortcut);     // 启动时注册快捷键

  // 后台等待服务就绪，就绪后通知渲染层
  waitForOcrServer().then(ready => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ocr-server-ready', ready);
    }
  });
});

// window-all-closed 不退出——让托盘保持存活
app.on('window-all-closed', () => {
  // 什么都不做，保持后台运行
  // 真正退出通过托盘菜单的「退出」项触发
});

app.on('activate', () => {
  // macOS 点击 Dock 图标时恢复主窗口（若 Dock 可见）
  if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
});

// 退出前取消注册，避免系统级别的快捷键残留；同时关闭 OCR 服务
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopOcrServer();
});

// ─── 快捷键注册 ────────────────────────────────────────────────
/**
 * 注册全局截图快捷键
 * @param {string} key  Electron accelerator 格式，如 'F1'、'Ctrl+Shift+X'
 * @returns {boolean}   是否注册成功
 */
function registerShortcut(key) {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(key, () => triggerCapture());
    if (!ok) console.warn('[Shortcut] 注册失败（可能被其他程序占用）:', key);
    return ok;
  } catch (e) {
    console.error('[Shortcut] 无效的快捷键格式:', key, e.message);
    return false;
  }
}

// ─── 截图主流程 ────────────────────────────────────────────────
/**
 * 触发截图（快捷键 或 按钮）
 *
 * 多显示器策略：
 *   macOS 不允许单个窗口横跨多个独立 Space/Display，
 *   因此为「每个显示器各建立一个独立 overlay 窗口」。
 *   用户在哪个屏幕拖拽选区，那个窗口就负责截图；
 *   确认后关闭所有 overlay 窗口并回传裁剪图。
 */
async function triggerCapture() {
  if (captureWindows.length > 0) return;  // 已在截图中，忽略重复触发
  if (!mainWindow) return;

  isCapturing = true;
  mainWindow.hide();
  await sleep(250);   // 等待主窗口隐藏动画

  // ── 1. 获取所有显示器 ────────────────────────────────────────
  const allDisplays = screen.getAllDisplays();

  // ── 2. 截取所有屏幕（每个 source 对应一个显示器）────────────
  // thumbnailSize 设为足够大，确保 Retina 屏幕也能全分辨率截取
  const maxPxW = Math.max(...allDisplays.map(d => Math.round(d.bounds.width  * d.scaleFactor)));
  const maxPxH = Math.max(...allDisplays.map(d => Math.round(d.bounds.height * d.scaleFactor)));

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxPxW, height: maxPxH },
    });
  } catch (err) {
    console.error('[Capture] desktopCapturer 失败:', err);
    restoreMainWindow();
    return;
  }

  if (!sources || sources.length === 0) {
    console.error('[Capture] 找不到任何屏幕源');
    restoreMainWindow();
    return;
  }

  // ── 3. 为每个显示器建立独立 overlay 窗口 ─────────────────────
  for (let i = 0; i < allDisplays.length; i++) {
    const display = allDisplays[i];

    // 匹配该显示器对应的截图 source
    // display_id 是最可靠的匹配方式（Electron 13+ 支持）
    const source = sources.find(s => s.display_id === String(display.id))
                || sources[i]      // fallback：按顺序对应
                || sources[0];     // 最后兜底

    const win = new BrowserWindow({
      x:      display.bounds.x,
      y:      display.bounds.y,
      width:  display.bounds.width,
      height: display.bounds.height,
      frame:       false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable:   false,
      movable:     false,
      // macOS：让窗口出现在全部 Desktop（不受 Space 限制）
      ...(process.platform === 'darwin' ? { visibleOnAllWorkspaces: true, fullscreenable: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile(path.join(__dirname, 'capture', 'overlay.html'));

    // 每个 overlay 只接收自己这块屏幕的截图（坐标从 0,0 开始）
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('init-overlay', {
        screensData: [{
          imageData: source.thumbnail.toDataURL(),
          x:      0,
          y:      0,
          width:  display.bounds.width,
          height: display.bounds.height,
        }],
        totalWidth:  display.bounds.width,
        totalHeight: display.bounds.height,
      });
    });

    captureWindows.push(win);
  }
}

// ─── IPC 处理器 ────────────────────────────────────────────────

// 渲染层截图按钮
ipcMain.handle('start-capture', () => triggerCapture());

// 任一 overlay 截图完成 → 关闭所有 overlay，回传截图给主窗口
ipcMain.handle('capture-done', (event, croppedDataURL) => {
  if (!isCapturing) return;        // 防止重复触发
  isCapturing = false;
  closeAllCaptureWindows();
  mainWindow.webContents.send('screenshot-result', croppedDataURL);
  restoreMainWindow();
});

// 任一 overlay 取消截图 → 关闭所有 overlay
ipcMain.handle('capture-cancel', () => {
  if (!isCapturing) return;
  isCapturing = false;
  closeAllCaptureWindows();
  restoreMainWindow();
});

// 渲染层请求修改快捷键
ipcMain.handle('change-shortcut', (event, newKey) => {
  const ok = registerShortcut(newKey);
  if (ok) {
    currentShortcut = newKey;
    if (mainWindow) mainWindow.webContents.send('shortcut-changed', newKey);
    updateTrayMenu();   // 同步更新托盘菜单显示
  }
  return { ok, current: currentShortcut };
});

// 渲染层查询当前快捷键
ipcMain.handle('get-shortcut', () => currentShortcut);

// ─── 全屏截图（主显示器）──────────────────────────────────────
ipcMain.handle('capture-fullscreen', async () => {
  const primary = screen.getPrimaryDisplay();
  const pixelW  = Math.round(primary.bounds.width  * primary.scaleFactor);
  const pixelH  = Math.round(primary.bounds.height * primary.scaleFactor);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: pixelW, height: pixelH },
    });
  } catch (err) {
    console.error('[Fullscreen] getSources 失败:', err);
    return null;
  }

  // 优先匹配 display_id，否则取第一个
  const source = sources.find(s => s.display_id === String(primary.id)) || sources[0];
  if (!source) return null;

  return source.thumbnail.toDataURL();
});

// ─── 另存為 PNG / JPG ──────────────────────────────────────────
ipcMain.handle('save-file', async (event, pngDataURL) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '另存為',
    defaultPath: `screenshot-${Date.now()}`,
    filters: [
      { name: 'PNG 圖片', extensions: ['png'] },
      { name: 'JPEG 圖片', extensions: ['jpg', 'jpeg'] },
    ],
  });

  if (canceled || !filePath) return { ok: false };

  try {
    const ni  = nativeImage.createFromDataURL(pngDataURL);
    const ext = path.extname(filePath).toLowerCase();
    const buf = (ext === '.jpg' || ext === '.jpeg') ? ni.toJPEG(92) : ni.toPNG();
    await fs.promises.writeFile(filePath, buf);
    return { ok: true, filePath };
  } catch (err) {
    console.error('[SaveFile] 寫入失敗:', err);
    return { ok: false, error: err.message };
  }
});

// ─── 工具函数 ──────────────────────────────────────────────────

// 关闭所有 overlay 窗口
function closeAllCaptureWindows() {
  captureWindows.forEach(win => {
    if (!win.isDestroyed()) win.close();
  });
  captureWindows = [];
}

// 显示并聚焦主窗口
function restoreMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
