/**
 * renderer/index.js — 主窗口渲染层逻辑
 *
 * 职责：
 *  1. 触发截图、接收截图结果并绘制到 canvas
 *  2. 在 canvas 上让用户拖拽画矩形（标注）
 *  3. 调用 OCR.space API 识别文字
 *  4. 显示识别结果，支持复制
 */

// ─── OCR API 配置（EasyOCR 本地服务）──────────────────────────
// 调用本地 Python EasyOCR 服务，完全离线、无限次数
// 服务由 main.js 在 Electron 启动时自动开启（ocr_server.py）
let OCR_SERVER_URL = 'http://127.0.0.1:7788';
let ocrServerReady = false;

// 查询主进程确认实际端口，并监听就绪通知
window.api.getOcrServerUrl().then(url => { OCR_SERVER_URL = url; });
window.api.onOcrServerReady((ready) => {
  ocrServerReady = ready;
  if (ready) {
    setStatus('✅ EasyOCR 引擎已就绪');
  } else {
    setStatus('⚠️ OCR 引擎启动超时，请检查 Python 环境');
  }
});

// ─── 翻译 API 配置 ─────────────────────────────────────────────
// 使用 MyMemory 免费翻译 API（无需 API Key，每天 5000 字符）
// 文档：https://mymemory.translated.net/doc/spec.php
const TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';

// ─── 全局状态 ──────────────────────────────────────────────────
const state = {
  originalImage: null,        // 当前截图的 Image 对象
  screenshotDataURL: null,    // 当前截图的 base64 DataURL（用于 OCR）
  annotations: [],            // 所有已完成标注 [{type, ...}]
  activeStroke: null,         // 画笔 / 荧光笔绘制中的临时笔画
  isDrawing: false,
  drawStart: { x: 0, y: 0 },
  ocrText: '',
  maskedText: '',             // 遮蔽後的文字（mask ON 時由 renderOCRResult 寫入）
  translationText: '',        // 当前翻译结果
  privacyMaskOn: false,       // 隱私遮蔽是否啟用
  redoStack: [],              // 撤销后可重做的标注队列
  activeTextInput: null,      // 文字標注進行中的 overlay 資料 { el, x, y, fontSize }
  // ── 工具状态 ──
  currentTool: 'rect',        // rect | pen | highlight | mosaic | line | ellipse | arrow | text
  penColor: '#ff4757',        // 当前颜色
  penSize: 4,                 // 当前笔刷大小
};

// ─── DOM 引用 ──────────────────────────────────────────────────
const canvas      = document.getElementById('main-canvas');
const ctx         = canvas.getContext('2d');
const emptyState  = document.getElementById('empty-state');
const btnCapture    = document.getElementById('btn-capture');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnOpenFile   = document.getElementById('btn-open-file');

const fileInput   = document.getElementById('file-input');
const btnOcr           = document.getElementById('btn-ocr');
const btnClearRect     = document.getElementById('btn-clear-rect');
const btnUndo          = document.getElementById('btn-undo');
const btnRedo          = document.getElementById('btn-redo');
const btnCopy          = document.getElementById('btn-copy');
const btnPrivacyMask      = document.getElementById('btn-privacy-mask');
const privacySummary      = document.getElementById('privacy-summary');
const btnTranslate        = document.getElementById('btn-translate');
const btnCopyTranslation  = document.getElementById('btn-copy-translation');
const langSelect          = document.getElementById('lang-select');
const ocrResult           = document.getElementById('ocr-result');
const translationResult   = document.getElementById('translation-result');
const ocrStatus           = document.getElementById('ocr-status');

// ─── 快捷键设置 UI ─────────────────────────────────────────────
const shortcutWrap = document.getElementById('shortcut-wrap');
const shortcutKey  = document.getElementById('shortcut-key');
let isRecordingShortcut = false;

// 页面加载时从主进程读取当前快捷键
window.api.getShortcut().then(key => { shortcutKey.textContent = key; });

// 主进程通知快捷键已变更（多窗口同步）
window.api.onShortcutChanged(key => { shortcutKey.textContent = key; });

// 点击快捷键区域 → 进入录制模式
shortcutWrap.addEventListener('click', () => {
  if (isRecordingShortcut) return;
  isRecordingShortcut = true;
  shortcutWrap.classList.add('recording');
  shortcutKey.textContent = '…';
  setStatus('⌨️ 请按下新的快捷键组合（ESC 取消）');
});

// ─── 全局键盘快捷键（标注操作）────────────────────────────────
document.addEventListener('keydown', (e) => {
  // 快捷键录制模式时，所有按键都交给录制逻辑处理，不走这里
  if (isRecordingShortcut) return;

  const isMeta = e.metaKey || e.ctrlKey;  // macOS 用 Cmd，Windows/Linux 用 Ctrl

  // Cmd+Z / Ctrl+Z：撤销上一步标注
  if (isMeta && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
    return;
  }

  // Cmd+Shift+Z / Ctrl+Shift+Z：取消撤销（重做）
  if (isMeta && e.key === 'z' && e.shiftKey) {
    e.preventDefault();
    doRedo();
    return;
  }

  // Cmd+D / Ctrl+D：清除所有标注
  if (isMeta && e.key === 'd') {
    e.preventDefault();
    if (state.annotations.length > 0) {
      state.annotations = [];
      state.redoStack = [];
      state.activeStroke = null;
      redrawCanvas();
      updateHistoryBtns();
      setStatus('🗑️ 已清除所有标注');
    }
    return;
  }
});

// 录制模式下监听按键
document.addEventListener('keydown', async (e) => {
  if (!isRecordingShortcut) return;
  e.preventDefault();

  // ESC 取消录制
  if (e.key === 'Escape') {
    cancelRecording();
    return;
  }

  // 把浏览器 KeyboardEvent 转成 Electron accelerator 格式
  const accelerator = buildAccelerator(e);
  if (!accelerator) return;   // 单独按修饰键时忽略，等组合键

  isRecordingShortcut = false;
  shortcutWrap.classList.remove('recording');

  const result = await window.api.changeShortcut(accelerator);
  if (result.ok) {
    shortcutKey.textContent = result.current;
    setStatus(`✅ 快捷键已设为 ${result.current}`);
  } else {
    shortcutKey.textContent = result.current;  // 显示旧值
    setStatus(`⚠️ 快捷键「${accelerator}」注册失败（可能被占用），维持原设定`);
  }
});

function cancelRecording() {
  isRecordingShortcut = false;
  shortcutWrap.classList.remove('recording');
  window.api.getShortcut().then(key => { shortcutKey.textContent = key; });
  setStatus('');
}

/**
 * 把 KeyboardEvent 转成 Electron accelerator 字串
 * 例：Ctrl+Shift+S、F2、Alt+X
 */
function buildAccelerator(e) {
  const parts = [];
  if (e.ctrlKey  || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key;
  // 忽略纯修饰键
  if (['Control','Meta','Alt','Shift'].includes(key)) return null;

  // 功能键
  if (key.startsWith('F') && !isNaN(key.slice(1))) {
    parts.push(key);          // F1–F12
  } else if (key.length === 1) {
    parts.push(key.toUpperCase());
  } else {
    // 特殊键映射
    const map = { ' ':'Space', ArrowUp:'Up', ArrowDown:'Down',
                  ArrowLeft:'Left', ArrowRight:'Right',
                  Enter:'Return', Backspace:'Backspace', Delete:'Delete' };
    if (!map[key]) return null;
    parts.push(map[key]);
  }

  return parts.join('+');
}

// ─── 按钮事件 ──────────────────────────────────────────────────

// 「截取屏幕」：通知主进程开始截图流程
btnCapture.addEventListener('click', () => {
  window.api.startCapture();
});

// 「全屏截图」：截取主显示器全屏
btnFullscreen.addEventListener('click', async () => {
  btnFullscreen.disabled = true;
  setStatus('🖥️ 正在截取全屏…');
  try {
    const dataURL = await window.api.captureFullscreen();
    if (dataURL) {
      loadScreenshot(dataURL);
      setStatus('✅ 全屏截图完成');
    } else {
      setStatus('⚠️ 全屏截图失败，请重试');
    }
  } catch (err) {
    console.error('全屏截图失败:', err);
    setStatus('❌ 全屏截图失败');
  } finally {
    btnFullscreen.disabled = false;
  }
});

// 「开启图片」：触发隐藏的 file input
btnOpenFile.addEventListener('click', () => {
  fileInput.click();
});

// 用户选好档案后：用 FileReader 读成 base64，直接复用 loadScreenshot()
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  // 只接受图片
  if (!file.type.startsWith('image/')) {
    setStatus('⚠️ 请选择图片档案（PNG / JPG / GIF …）');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    loadScreenshot(e.target.result); // DataURL，和截图结果格式完全一样
    setStatus(`📂 已开启：${file.name}`);
  };
  reader.readAsDataURL(file); // 读成 base64 DataURL

  // 清空 input，允许重复选同一个档案
  fileInput.value = '';
});

// 「OCR 识别」：调用 OCR API
btnOcr.addEventListener('click', runOCR);

// 「清除标注」：清空全部标注与历史
btnClearRect.addEventListener('click', () => {
  state.annotations = [];
  state.redoStack = [];
  state.activeStroke = null;
  redrawCanvas();
  updateHistoryBtns();
});

// 「撤销」按钮
btnUndo.addEventListener('click', doUndo);

// 「重做」按钮
btnRedo.addEventListener('click', doRedo);

// 「复制」（识别结果区）：mask ON 時複製遮蔽文字，OFF 時複製正規化原文
btnCopy.addEventListener('click', () => {
  if (!state.ocrText) return;
  // 遮蔽模式：複製含 [佔位符] 的遮蔽純文字；一般模式：複製正規化後的原始文字
  const textToCopy = (state.privacyMaskOn && state.maskedText)
    ? state.maskedText
    : state.ocrText;
  navigator.clipboard.writeText(textToCopy).then(() => {
    btnCopy.textContent = '✅ 已複製';
    setTimeout(() => { btnCopy.textContent = '📋 複製'; }, 2000);
  }).catch(err => console.error('复制失败:', err));
});

// 「🛡️ 隱私遮蔽」：切換遮蔽 / 原文顯示
btnPrivacyMask.addEventListener('click', () => {
  if (!state.ocrText) return;
  state.privacyMaskOn = !state.privacyMaskOn;

  if (state.privacyMaskOn) {
    btnPrivacyMask.classList.add('active');
    btnPrivacyMask.textContent = '🛡️ 顯示原文';
    renderOCRResult(state.ocrText, true);
    setStatus('🛡️ 隱私遮蔽已啟用');
  } else {
    btnPrivacyMask.classList.remove('active');
    btnPrivacyMask.textContent = '🛡️ 隱私遮蔽';
    renderOCRResult(state.ocrText, false);
    setStatus('🔓 已還原原始文字');
  }
});

// 「复制」（翻译结果区）：仅复制翻译文字
btnCopyTranslation.addEventListener('click', () => {
  if (!state.translationText) return;
  navigator.clipboard.writeText(state.translationText).then(() => {
    btnCopyTranslation.textContent = '✅ 已复制';
    setTimeout(() => { btnCopyTranslation.textContent = '📋 复制'; }, 2000);
  }).catch(err => console.error('复制翻译失败:', err));
});

// 「翻译」：调用翻译 API（仅通过按钮触发，不随语言切换自动执行）
btnTranslate.addEventListener('click', runTranslation);

// ─── 接收截图结果 ──────────────────────────────────────────────
// 主进程把裁剪好的图片 DataURL 发过来
window.api.onScreenshotResult((dataURL) => {
  loadScreenshot(dataURL);
});

// ─── Canvas 多工具交互 ─────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (!state.originalImage) return;
  if (state.currentTool === 'text') return; // 文字工具由 click 事件處理

  state.isDrawing = true;
  state.drawStart = getCanvasPos(e);

  // 画笔 / 荧光笔：mousedown 时初始化笔画
  if (state.currentTool === 'pen' || state.currentTool === 'highlight') {
    state.activeStroke = {
      type: state.currentTool,
      points: [state.drawStart],
      color: state.penColor,
      size: state.penSize,
    };
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!state.isDrawing) return;
  const pos = getCanvasPos(e);

  if (state.currentTool === 'pen' || state.currentTool === 'highlight') {
    // 追加点并实时重绘
    state.activeStroke.points.push(pos);
    redrawCanvas();

  } else if (state.currentTool === 'line') {
    // 直線：實時預覽虛線
    redrawCanvas();
    ctx.save();
    ctx.strokeStyle = state.penColor;
    ctx.lineWidth = state.penSize;
    ctx.lineCap = 'round';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(state.drawStart.x, state.drawStart.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.restore();

  } else if (state.currentTool === 'ellipse') {
    // 橢圓：實時預覽虛線框
    const cx = (state.drawStart.x + pos.x) / 2;
    const cy = (state.drawStart.y + pos.y) / 2;
    const rx = Math.abs(pos.x - state.drawStart.x) / 2;
    const ry = Math.abs(pos.y - state.drawStart.y) / 2;
    redrawCanvas();
    ctx.save();
    ctx.strokeStyle = state.penColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (rx > 0 && ry > 0) ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

  } else if (state.currentTool === 'arrow') {
    // 箭頭：實時預覽完整箭頭（實線，更直觀）
    redrawCanvas();
    ctx.save();
    drawArrowShape(ctx,
      state.drawStart.x, state.drawStart.y,
      pos.x, pos.y,
      state.penColor, state.penSize);
    ctx.restore();

  } else {
    // 矩形 / 马赛克：重绘 + 虚线预览框
    const w = pos.x - state.drawStart.x;
    const h = pos.y - state.drawStart.y;
    redrawCanvas();
    ctx.save();
    ctx.strokeStyle = state.penColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(state.drawStart.x, state.drawStart.y, w, h);
    ctx.restore();
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  const pos = getCanvasPos(e);

  if (state.currentTool === 'pen' || state.currentTool === 'highlight') {
    // 笔画至少要有 2 个点才保存
    if (state.activeStroke && state.activeStroke.points.length > 1) {
      state.annotations.push(state.activeStroke);
      state.redoStack = [];   // 新标注后清空重做队列
    }
    state.activeStroke = null;

  } else if (state.currentTool === 'line') {
    // 直線：記錄起終點
    const dist = Math.hypot(pos.x - state.drawStart.x, pos.y - state.drawStart.y);
    if (dist > 5) {
      state.annotations.push({
        type: 'line',
        x1: state.drawStart.x, y1: state.drawStart.y,
        x2: pos.x, y2: pos.y,
        color: state.penColor,
        size: state.penSize,
      });
      state.redoStack = [];
    }

  } else if (state.currentTool === 'ellipse') {
    // 橢圓：記錄中心點與半徑
    const rx = Math.abs(pos.x - state.drawStart.x) / 2;
    const ry = Math.abs(pos.y - state.drawStart.y) / 2;
    if (rx > 3 && ry > 3) {
      state.annotations.push({
        type: 'ellipse',
        cx: (state.drawStart.x + pos.x) / 2,
        cy: (state.drawStart.y + pos.y) / 2,
        rx, ry,
        color: state.penColor,
      });
      state.redoStack = [];
    }

  } else if (state.currentTool === 'arrow') {
    // 箭頭：記錄起終點與筆刷大小
    const dist = Math.hypot(pos.x - state.drawStart.x, pos.y - state.drawStart.y);
    if (dist > 8) {
      state.annotations.push({
        type: 'arrow',
        x1: state.drawStart.x, y1: state.drawStart.y,
        x2: pos.x, y2: pos.y,
        color: state.penColor,
        size: state.penSize,
      });
      state.redoStack = [];
    }

  } else {
    // 矩形 / 马赛克：统一为左上角 + 正数宽高
    const x = Math.min(state.drawStart.x, pos.x);
    const y = Math.min(state.drawStart.y, pos.y);
    const w = Math.abs(pos.x - state.drawStart.x);
    const h = Math.abs(pos.y - state.drawStart.y);
    if (w > 5 && h > 5) {
      state.annotations.push({ type: state.currentTool, x, y, w, h, color: state.penColor });
      state.redoStack = [];   // 新标注后清空重做队列
    }
  }
  redrawCanvas();
  updateHistoryBtns();
});

canvas.addEventListener('mouseleave', () => {
  if (state.isDrawing) {
    state.isDrawing = false;
    if (state.activeStroke) {
      if (state.activeStroke.points.length > 1) {
        state.annotations.push(state.activeStroke);
        state.redoStack = []; // 新标注后清空重做队列
      }
      state.activeStroke = null;
    }
    redrawCanvas();
    updateHistoryBtns();
  }
});

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 加载截图：把 DataURL 渲染到 canvas，重置状态
 */
function loadScreenshot(dataURL) {
  removeTextInput();            // 清除進行中的文字輸入
  state.screenshotDataURL = dataURL;
  state.annotations = [];
  state.redoStack = [];
  state.activeStroke = null;
  state.ocrText = '';
  state.maskedText = '';
  state.translationText = '';

  const img = new Image();
  img.onload = () => {
    state.originalImage = img;

    // 自适应 canvas 宽度（不超过容器）
    const container = document.getElementById('canvas-wrap');
    const maxW = container.clientWidth - 32; // 留 padding
    const scale = Math.min(1, maxW / img.width);

    canvas.width  = Math.round(img.width  * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.dataset.scale = scale; // 供矩形坐标计算使用（此处未用，scale=1时一致）

    redrawCanvas();

    // 显示 canvas，隐藏空状态提示
    emptyState.style.display = 'none';
    canvas.style.display = 'block';

    // 启用相关按钮
    btnOcr.disabled = false;
    btnClearRect.disabled = false;

    // 清空上次 OCR / 翻译结果
    ocrResult.innerHTML = '<p class="placeholder-text">截图完成，点击「OCR 识别」开始识别…</p>';
    translationResult.innerHTML = '<p class="placeholder-text">翻译结果将显示在这里…</p>';
    btnCopy.disabled = true;
    btnTranslate.disabled = true;
    btnCopyTranslation.disabled = true;
    // 重置隱私遮蔽
    state.privacyMaskOn = false;
    btnPrivacyMask.disabled = true;
    btnPrivacyMask.classList.remove('active');
    privacySummary.style.display = 'none';
    setStatus('');
  };
  img.src = dataURL;
}

/**
 * 重绘 canvas：原图 → 依序重播所有标注 → 绘制中的笔画
 */
function redrawCanvas() {
  if (!state.originalImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.originalImage, 0, 0, canvas.width, canvas.height);
  state.annotations.forEach(ann => drawAnnotation(ann));
  if (state.activeStroke) drawAnnotation(state.activeStroke);
}

/**
 * 绘制单一标注（rect / pen / highlight / mosaic）
 */
function drawAnnotation(ann) {
  ctx.save();

  switch (ann.type) {

    case 'rect':
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      break;

    case 'pen':
      if (ann.points.length < 2) break;
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y);
      ctx.stroke();
      break;

    case 'highlight':
      if (ann.points.length < 2) break;
      ctx.globalAlpha = 0.38;         // 半透明
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.size * 4;   // 荧光笔比画笔宽
      ctx.lineCap = 'square';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y);
      ctx.stroke();
      break;

    case 'line':
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.size;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ann.x1, ann.y1);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();
      break;

    case 'ellipse':
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.ellipse(ann.cx, ann.cy, ann.rx, ann.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;

    case 'arrow':
      drawArrowShape(ctx, ann.x1, ann.y1, ann.x2, ann.y2, ann.color, ann.size);
      break;

    case 'text': {
      const lineHeight = ann.fontSize * 1.4;
      ctx.font = `bold ${ann.fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif`;
      ctx.fillStyle = ann.color;
      ctx.textBaseline = 'top';
      ctx.setLineDash([]);
      ann.content.split('\n').forEach((line, i) => {
        ctx.fillText(line, ann.x, ann.y + i * lineHeight);
      });
      break;
    }

    case 'mosaic':
      drawMosaic(ann.x, ann.y, ann.w, ann.h);
      break;
  }

  ctx.restore();
}

/**
 * 箭頭繪製輔助函式（供 drawAnnotation 和 mousemove 預覽共用）
 * 畫法：線段 + 填色箭頭三角形
 */
function drawArrowShape(ctx, x1, y1, x2, y2, color, lineWidth) {
  const headLen   = Math.max(14, lineWidth * 5); // 箭頭長度隨筆刷縮放
  const headAngle = Math.PI / 6;                 // 30°，合計 60° 開口
  const angle     = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = lineWidth;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.setLineDash([]);

  // 線段：終點縮進 headLen*0.8，讓箭頭根部不溢出
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x2 - headLen * 0.8 * Math.cos(angle),
    y2 - headLen * 0.8 * Math.sin(angle),
  );
  ctx.stroke();

  // 箭頭三角形（填充）
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - headAngle),
    y2 - headLen * Math.sin(angle - headAngle),
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + headAngle),
    y2 - headLen * Math.sin(angle + headAngle),
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * 马赛克：把选区切成 blockSize×blockSize 小格，每格填平均色
 * 从 originalImage 取色，确保叠加多个标注时不会互相影响
 */
function drawMosaic(x, y, w, h) {
  const blockSize = 10;

  // 离屏 canvas 取原图像素
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.drawImage(state.originalImage, 0, 0, canvas.width, canvas.height);

  for (let bx = x; bx < x + w; bx += blockSize) {
    for (let by = y; by < y + h; by += blockSize) {
      const bw = Math.min(blockSize, x + w - bx);
      const bh = Math.min(blockSize, y + h - by);
      if (bw <= 0 || bh <= 0) continue;

      const data = tmpCtx.getImageData(bx, by, bw, bh).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
      }
      ctx.fillStyle = `rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

/**
 * 获取鼠标相对于 canvas 的坐标
 */
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(e.clientX - rect.left),
    y: Math.round(e.clientY - rect.top),
  };
}

// ─── OCR 识别 ──────────────────────────────────────────────────

/**
 * 调用本地 EasyOCR 服务识别文字
 * 请求本机 Python Flask 服务（ocr_server.py），完全离线无限次
 */
async function runOCR() {
  if (!state.screenshotDataURL) return;

  btnOcr.disabled = true;
  btnOcr.classList.add('translating');
  btnOcr.textContent = '🔍 识别中…';
  setStatus('🔄 正在本地 EasyOCR 识别，请稍候…');
  ocrResult.innerHTML = '<p class="placeholder-text">识别中，请稍候…</p>';

  try {
    const response = await fetch(`${OCR_SERVER_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Image: state.screenshotDataURL }),
    });

    if (!response.ok) {
      throw new Error(`本地服务返回 HTTP ${response.status}，请确认 ocr_server.py 正在运行`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'EasyOCR 处理失败');
    }

    const parsedText = data.text || '';

    if (!parsedText.trim()) {
      ocrResult.innerHTML = '<p class="placeholder-text">⚠️ 未识别到文字（图片可能太模糊或无文字）</p>';
      setStatus('⚠️ 未识别到文字');
    } else {
      // 正規化 OCR 雜訊（間隔號→句點、全形字元→半形 等），確保複製與遮蔽都拿到乾淨文字
      state.ocrText = window.privacyMask
        ? window.privacyMask.normalizeOcrArtifacts(parsedText)
        : parsedText;
      state.maskedText = '';
      state.privacyMaskOn = false;
      btnPrivacyMask.classList.remove('active');
      btnPrivacyMask.textContent = '🛡️ 隱私遮蔽';
      privacySummary.style.display = 'none';
      renderOCRResult(state.ocrText, false);
      setStatus(`✅ 識別完成，共 ${parsedText.replace(/\s/g, '').length} 個字元（EasyOCR）`);
      btnCopy.disabled = false;
      btnTranslate.disabled = false;
      btnPrivacyMask.disabled = false;
    }

  } catch (err) {
    console.error('OCR 识别失败:', err);
    const hint = err.message.includes('fetch') || err.message.includes('Failed')
      ? '请确认已启动 ocr_server.py，或等待 EasyOCR 引擎初始化完成'
      : '请检查 Python 环境与依赖';
    ocrResult.innerHTML =
      `<p class="error-text">❌ 识别失败：${escapeHtml(err.message)}<br><small>${hint}</small></p>`;
    setStatus('❌ 识别失败');
  } finally {
    btnOcr.disabled = false;
    btnOcr.classList.remove('translating');
    btnOcr.textContent = '🔍 OCR 识别';
  }
}

/**
 * 把 OCR 结果按行渲染到右侧面板
 * 每行都是可选中文字，方便用户自行复制局部内容
 * @param {string} text - 原始文字
 * @param {boolean} [masked=false] - 是否顯示隱私遮蔽版本
 */
function renderOCRResult(text, masked = false) {
  let displayText = text;

  if (masked && window.privacyMask) {
    const { maskedText, findings } = window.privacyMask.maskText(text);
    displayText = maskedText;
    state.maskedText = maskedText;   // 供複製按鈕使用
    renderPrivacySummary(findings);
  } else {
    state.maskedText = '';
    privacySummary.style.display = 'none';
  }

  const lines = displayText.split('\n');
  const html = lines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const lineHtml = masked && window.privacyMask
        ? window.privacyMask.toHighlightedHtml(line)
        : escapeHtml(line);
      return `<div class="ocr-line">${lineHtml}</div>`;
    })
    .join('');

  ocrResult.innerHTML = html || '<p class="placeholder-text">无内容</p>';
}

/**
 * 顯示隱私遮蔽摘要（偵測到多少種、多少筆敏感資料）
 * @param {Array<{label, count}>} findings
 */
function renderPrivacySummary(findings) {
  if (!findings || findings.length === 0) {
    privacySummary.style.display = 'block';
    privacySummary.innerHTML =
      '<span class="privacy-summary-none">✅ 未偵測到敏感資料</span>';
    return;
  }

  const chips = findings
    .map(f => `<span class="privacy-chip">${escapeHtml(f.label.slice(1, -1))} ×${f.count}</span>`)
    .join('');

  privacySummary.style.display = 'block';
  privacySummary.innerHTML =
    `<span class="privacy-summary-label">已遮蔽：</span>${chips}`;
}

/**
 * 更新底部状态栏文字（5 秒后自动清空）
 */
function setStatus(msg) {
  ocrStatus.textContent = msg;
  if (msg) {
    clearTimeout(ocrStatus._timer);
    ocrStatus._timer = setTimeout(() => {
      ocrStatus.textContent = '';
    }, 6000);
  }
}

// ─── 工具面板交互 ──────────────────────────────────────────────

// 工具按钮：点击切换 currentTool，更新 active 样式
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // 切換工具前，提交進行中的文字輸入（有內容則儲存，無則取消）
    if (state.activeTextInput) commitTextInput();

    state.currentTool = btn.dataset.tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // 更新 canvas 光标
    const cursorMap = { mosaic: 'cell', text: 'text' };
    canvas.style.cursor = cursorMap[state.currentTool] || 'crosshair';
  });
});

// 颜色色块：点击切换 penColor，更新 active 样式，同步拾色器
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.dataset.color) return; // 跳過拾色器 label（由 input 事件處理）
    state.penColor = btn.dataset.color;
    colorPickerInput.value = btn.dataset.color; // 同步拾色器顯示
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// 自訂顏色拾色器
const colorPickerInput = document.getElementById('color-picker');
const colorPickerLabel = document.getElementById('color-picker-label');

colorPickerInput.addEventListener('input', (e) => {
  state.penColor = e.target.value;
  colorPickerLabel.style.background = e.target.value;
  document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
  colorPickerLabel.classList.add('active');
});

// 大小按钮：点击切换 penSize，更新 active 样式
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.penSize = Number(btn.dataset.size);
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ─── 文字標注工具 ──────────────────────────────────────────────

// canvas 點擊時（僅 text 工具）：在點擊位置建立浮動輸入框
canvas.addEventListener('click', (e) => {
  if (state.currentTool !== 'text' || !state.originalImage) return;
  const pos = getCanvasPos(e);
  createTextInput(pos.x, pos.y);
});

/**
 * 在 canvas 座標 (canvasX, canvasY) 處建立浮動 <textarea>
 * Enter 確認、Shift+Enter 換行、ESC 取消、blur 確認
 */
function createTextInput(canvasX, canvasY) {
  // 若已有進行中的輸入框，先提交它
  if (state.activeTextInput) commitTextInput();

  const rect     = canvas.getBoundingClientRect();
  const screenX  = rect.left + canvasX;
  const screenY  = rect.top  + canvasY;
  const fontSize = Math.max(12, state.penSize * 4); // 2→8→12 | 4→16 | 8→32

  const ta = document.createElement('textarea');
  ta.className = 'text-annotation-input';
  ta.style.left     = `${screenX}px`;
  ta.style.top      = `${screenY}px`;
  ta.style.fontSize = `${fontSize}px`;
  ta.style.color    = state.penColor;
  ta.style.borderColor = state.penColor;
  ta.rows = 1;
  document.body.appendChild(ta);
  ta.focus();

  state.activeTextInput = { el: ta, x: canvasX, y: canvasY, fontSize };

  // Enter 確認（Shift+Enter 換行）
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // 避免觸發全域 Cmd+Z 等快捷鍵
    if (ev.key === 'Escape') {
      removeTextInput();
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      commitTextInput();
    }
  });

  // 自動高度（隨文字行數增長）
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });

  // blur 確認（點擊其他地方時自動提交）
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      if (state.activeTextInput && state.activeTextInput.el === ta) {
        commitTextInput();
      }
    }, 150);
  });
}

/**
 * 確認文字輸入：若有內容則儲存標注，之後移除 overlay
 */
function commitTextInput() {
  if (!state.activeTextInput) return;
  const { el, x, y, fontSize } = state.activeTextInput;
  const content = el.value.trim();
  removeTextInput(); // 先移除（設 state.activeTextInput = null），再 push
  if (content) {
    state.annotations.push({ type: 'text', x, y, content, color: state.penColor, fontSize });
    state.redoStack = [];
    redrawCanvas();
    updateHistoryBtns();
  }
}

/**
 * 取消並移除文字輸入 overlay
 */
function removeTextInput() {
  if (!state.activeTextInput) return;
  state.activeTextInput.el.remove();
  state.activeTextInput = null;
}

/**
 * HTML 特殊字符转义（防 XSS）
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 翻译 ──────────────────────────────────────────────────────

/**
 * 调用 MyMemory 翻译 API
 * 文档：https://mymemory.translated.net/doc/spec.php
 * 免费额度：5000 字符 / 天（无需 API Key）
 */
async function runTranslation() {
  const text = state.ocrText.trim();
  if (!text) return;

  const langPair = langSelect.value;          // 例：zh|en
  const [srcLang, tgtLang] = langPair.split('|');

  btnTranslate.disabled = true;
  btnTranslate.classList.add('translating');
  btnTranslate.textContent = '🌐 翻译中…';
  setStatus('🔄 正在翻译，请稍候…');
  translationResult.innerHTML = '<p class="placeholder-text">翻译中，请稍候…</p>';

  try {
    // MyMemory 每次最多 500 字符，超长时分段翻译
    const chunks = splitText(text, 450);
    const translated = [];

    for (const chunk of chunks) {
      const url = `${TRANSLATE_API_URL}?q=${encodeURIComponent(chunk)}&langpair=${srcLang}|${tgtLang}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP 错误 ${response.status}`);
      }

      const data = await response.json();

      // responseStatus 200 或 "200" 均为成功
      if (String(data.responseStatus) !== '200') {
        const errMsg = data.responseDetails || '翻译服务返回错误';
        throw new Error(errMsg);
      }

      const result = data.responseData?.translatedText;
      if (!result) throw new Error('翻译结果为空');

      // MyMemory 有时会在结果里附上 "MYMEMORY WARNING" 提示，移除掉
      translated.push(result.replace(/MYMEMORY WARNING:.*$/i, '').trim());
    }

    const fullTranslation = translated.join('\n');
    state.translationText = fullTranslation;
    renderTranslationResult(fullTranslation, langPair);

    const charCount = fullTranslation.replace(/\s/g, '').length;
    setStatus(`✅ 翻译完成（${charCount} 字符）`);
    btnCopyTranslation.disabled = false;

  } catch (err) {
    console.error('翻译失败:', err);
    translationResult.innerHTML =
      `<p class="error-text">❌ 翻译失败：${escapeHtml(err.message)}<br>
       <small>请检查网络连接，或稍后重试（免费 API 每天限 5000 字符）</small></p>`;
    setStatus('❌ 翻译失败');
  } finally {
    btnTranslate.disabled = false;
    btnTranslate.classList.remove('translating');
    btnTranslate.textContent = '🌐 翻译';
  }
}

/**
 * 把翻译结果按行渲染到翻译面板
 */
function renderTranslationResult(text, langPair) {
  const [src, tgt] = langPair.split('|');
  const langLabel = {
    'zh': '中文', 'en': '英文', 'ja': '日文', 'ko': '韩文', 'fr': '法文',
  };
  const label = `${langLabel[src] || src} → ${langLabel[tgt] || tgt}`;

  const lines = text.split('\n');
  const linesHtml = lines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => `<div class="translate-line">${escapeHtml(line)}</div>`)
    .join('');

  translationResult.innerHTML =
    `<div class="translate-meta">${escapeHtml(label)}</div>` +
    (linesHtml || '<p class="placeholder-text">无内容</p>');
}

// ─── 撤销 / 重做 ───────────────────────────────────────────────

/** 撤销最后一步标注 */
function doUndo() {
  if (state.annotations.length === 0) return;
  const last = state.annotations.pop();
  state.redoStack.push(last);
  redrawCanvas();
  updateHistoryBtns();
  setStatus(`↩ 已撤销（剩余 ${state.annotations.length} 个标注）`);
}

/** 重做上一次撤销的标注 */
function doRedo() {
  if (state.redoStack.length === 0) return;
  const ann = state.redoStack.pop();
  state.annotations.push(ann);
  redrawCanvas();
  updateHistoryBtns();
  setStatus(`↪ 已重做（共 ${state.annotations.length} 个标注）`);
}

/** 同步撤销 / 重做按钮的可用状态 */
function updateHistoryBtns() {
  btnUndo.disabled = state.annotations.length === 0;
  btnRedo.disabled = state.redoStack.length === 0;
}

/**
 * 将长文本按指定字符数分割成数组
 * 尽量在换行符处分割，保持语义完整
 */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) chunks.push(current.trim());
      // 单行超长时强制截断
      let remaining = line;
      while (remaining.length > maxLen) {
        chunks.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
      }
      current = remaining;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
