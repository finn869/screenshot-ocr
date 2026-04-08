/**
 * renderer/index.js — 主窗口渲染层逻辑
 *
 * 职责：
 *  1. 触发截图、接收截图结果并绘制到 canvas
 *  2. 在 canvas 上让用户拖拽画矩形（标注）
 *  3. 调用 OCR.space API 识别文字
 *  4. 显示识别结果，支持复制
 */

// ─── OCR API 配置 ──────────────────────────────────────────────
// 使用 OCR.space 免费 API
// 免费 key「helloworld」每天限 25,000 次，适合 Demo
// 建议去 https://ocr.space/ocrapi 申请私人免费 key（更稳定）
const OCR_API_KEY = 'REMOVED';
const OCR_API_URL = 'https://api.ocr.space/parse/base64';
const OCR_LANGUAGE = 'chs'; // chs = 简体中文, eng = 英文, auto = 自动

// ─── 全局状态 ──────────────────────────────────────────────────
const state = {
  originalImage: null,     // 当前截图的 Image 对象
  screenshotDataURL: null, // 当前截图的 base64 DataURL（用于 OCR）
  rects: [],               // 用户在图上画的矩形列表 [{x, y, w, h}]
  isDrawing: false,        // 是否正在拖拽画矩形
  drawStart: { x: 0, y: 0 }, // 拖拽起点
  ocrText: '',             // 上次 OCR 识别的完整文字
};

// ─── DOM 引用 ──────────────────────────────────────────────────
const canvas      = document.getElementById('main-canvas');
const ctx         = canvas.getContext('2d');
const emptyState  = document.getElementById('empty-state');
const btnCapture  = document.getElementById('btn-capture');
const btnOcr      = document.getElementById('btn-ocr');
const btnClearRect= document.getElementById('btn-clear-rect');
const btnCopy     = document.getElementById('btn-copy');
const ocrResult   = document.getElementById('ocr-result');
const ocrStatus   = document.getElementById('ocr-status');

// ─── 按钮事件 ──────────────────────────────────────────────────

// 「截取屏幕」：通知主进程开始截图流程
btnCapture.addEventListener('click', () => {
  window.api.startCapture();
});

// 「OCR 识别」：调用 OCR API
btnOcr.addEventListener('click', runOCR);

// 「清除矩形」：清空所有标注框
btnClearRect.addEventListener('click', () => {
  state.rects = [];
  redrawCanvas();
});

// 「复制全部」：把 OCR 文字写入剪贴板
btnCopy.addEventListener('click', () => {
  if (!state.ocrText) return;
  navigator.clipboard.writeText(state.ocrText).then(() => {
    btnCopy.textContent = '✅ 已复制！';
    setTimeout(() => { btnCopy.textContent = '📋 复制全部'; }, 2000);
  }).catch(err => {
    console.error('复制失败:', err);
  });
});

// ─── 接收截图结果 ──────────────────────────────────────────────
// 主进程把裁剪好的图片 DataURL 发过来
window.api.onScreenshotResult((dataURL) => {
  loadScreenshot(dataURL);
});

// ─── Canvas 画矩形（拖拽交互）──────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (!state.originalImage) return;
  state.isDrawing = true;
  state.drawStart = getCanvasPos(e);
});

canvas.addEventListener('mousemove', (e) => {
  if (!state.isDrawing) return;
  const cur = getCanvasPos(e);
  const w = cur.x - state.drawStart.x;
  const h = cur.y - state.drawStart.y;

  // 重绘已有内容，再叠加「预览中的矩形」
  redrawCanvas();
  ctx.save();
  ctx.strokeStyle = '#ff4757';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(state.drawStart.x, state.drawStart.y, w, h);
  ctx.restore();
});

canvas.addEventListener('mouseup', (e) => {
  if (!state.isDrawing) return;
  state.isDrawing = false;

  const cur = getCanvasPos(e);
  // 统一为左上角坐标 + 正数宽高（支持反向拖拽）
  const x = Math.min(state.drawStart.x, cur.x);
  const y = Math.min(state.drawStart.y, cur.y);
  const w = Math.abs(cur.x - state.drawStart.x);
  const h = Math.abs(cur.y - state.drawStart.y);

  // 忽略太小的框
  if (w > 8 && h > 8) {
    state.rects.push({ x, y, w, h });
  }
  redrawCanvas();
});

// 鼠标离开 canvas 时也要结束绘制
canvas.addEventListener('mouseleave', () => {
  if (state.isDrawing) {
    state.isDrawing = false;
    redrawCanvas();
  }
});

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 加载截图：把 DataURL 渲染到 canvas，重置状态
 */
function loadScreenshot(dataURL) {
  state.screenshotDataURL = dataURL;
  state.rects = [];
  state.ocrText = '';

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

    // 清空上次 OCR 结果
    ocrResult.innerHTML = '<p class="placeholder-text">截图完成，点击「OCR 识别」开始识别…</p>';
    btnCopy.disabled = true;
    setStatus('');
  };
  img.src = dataURL;
}

/**
 * 重绘 canvas：先画原图，再叠加所有已保存的矩形
 */
function redrawCanvas() {
  if (!state.originalImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.originalImage, 0, 0, canvas.width, canvas.height);

  state.rects.forEach((rect, index) => {
    // 矩形边框
    ctx.save();
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    // 左上角数字标签（背景 + 文字）
    const labelText = String(index + 1);
    const labelW = 20;
    const labelH = 18;
    const lx = rect.x;
    const ly = rect.y - labelH;

    ctx.fillStyle = '#ff4757';
    ctx.fillRect(lx, ly < 0 ? rect.y : ly, labelW, labelH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, lx + 4, (ly < 0 ? rect.y : ly) + labelH / 2);
    ctx.restore();
  });
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
 * 调用 OCR.space API 识别文字
 * 使用 fetch（renderer 层直接调用，需要 webSecurity: false）
 */
async function runOCR() {
  if (!state.screenshotDataURL) return;

  btnOcr.disabled = true;
  btnOcr.textContent = '识别中…';
  setStatus('🔄 正在调用 OCR API，请稍候…');
  ocrResult.innerHTML = '<p class="placeholder-text">识别中，请稍候…</p>';

  try {
    // OCR.space 接受完整的 data URL（包含前缀）
    const base64WithPrefix = state.screenshotDataURL;

    // 用 URLSearchParams 构建表单请求体
    const body = new URLSearchParams();
    body.append('base64Image', base64WithPrefix);
    body.append('language', OCR_LANGUAGE);
    body.append('apikey', OCR_API_KEY);
    body.append('isOverlayRequired', 'false');
    body.append('detectOrientation', 'true');
    body.append('scale', 'true');        // 提高小图识别精度
    body.append('isTable', 'false');

    const response = await fetch(OCR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`HTTP 错误 ${response.status}`);
    }

    const data = await response.json();

    // OCR.space 的错误字段
    if (data.IsErroredOnProcessing) {
      const errMsg = Array.isArray(data.ErrorMessage)
        ? data.ErrorMessage.join('; ')
        : (data.ErrorMessage || 'OCR 处理失败');
      throw new Error(errMsg);
    }

    // 提取识别文字
    const parsedText = data.ParsedResults?.[0]?.ParsedText || '';

    if (!parsedText.trim()) {
      ocrResult.innerHTML = '<p class="placeholder-text">⚠️ 未识别到文字（图片可能太模糊或无文字）</p>';
      setStatus('⚠️ 未识别到文字');
    } else {
      state.ocrText = parsedText;
      renderOCRResult(parsedText);
      setStatus(`✅ 识别完成，共 ${parsedText.replace(/\s/g, '').length} 个字符`);
      btnCopy.disabled = false;
    }

  } catch (err) {
    console.error('OCR 识别失败:', err);
    ocrResult.innerHTML = `<p class="error-text">❌ 识别失败：${escapeHtml(err.message)}<br><small>请检查网络连接或 API Key 是否有效</small></p>`;
    setStatus('❌ 识别失败');
  } finally {
    btnOcr.disabled = false;
    btnOcr.textContent = '🔍 OCR 识别';
  }
}

/**
 * 把 OCR 结果按行渲染到右侧面板
 * 每行都是可选中文字，方便用户自行复制局部内容
 */
function renderOCRResult(text) {
  const lines = text.split('\n');
  const html = lines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => `<div class="ocr-line">${escapeHtml(line)}</div>`)
    .join('');

  ocrResult.innerHTML = html || '<p class="placeholder-text">无内容</p>';
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
