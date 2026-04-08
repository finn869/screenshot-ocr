/**
 * capture/overlay.js — 全屏截图选区逻辑
 *
 * 职责：
 *  1. 接收主进程发来的全屏截图（base64）
 *  2. 铺满 canvas 显示，叠加半透明暗色遮罩
 *  3. 监听鼠标拖拽，实时绘制选框（选区内露出原图）
 *  4. 鼠标释放后，用 canvas 裁剪选区并返回给主进程
 *  5. ESC 键取消
 */

// ─── DOM 引用 ──────────────────────────────────────────────────
const canvas    = document.getElementById('overlay-canvas');
const ctx       = canvas.getContext('2d');
const sizeLabel = document.getElementById('size-label');

// ─── 状态 ──────────────────────────────────────────────────────
let bgImage    = null;   // 全屏截图的 Image 对象
let isDrawing  = false;
let startX     = 0;
let startY     = 0;

// ─── 接收主进程初始化数据 ──────────────────────────────────────
window.api.onInitOverlay(({ imageData, width, height }) => {
  canvas.width  = width;
  canvas.height = height;

  const img = new Image();
  img.onload = () => {
    bgImage = img;
    // 初始渲染：全暗遮罩，无选框
    drawScene(0, 0, 0, 0, false);
  };
  img.src = imageData;
});

// ─── 键盘：ESC 取消 ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.api.captureCancel();
  }
});

// ─── 鼠标按下：记录起点 ────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  isDrawing = true;
  startX    = e.clientX;
  startY    = e.clientY;
});

// ─── 鼠标移动：实时更新选框 ───────────────────────────────────
canvas.addEventListener('mousemove', (e) => {
  if (!isDrawing || !bgImage) return;

  const w = e.clientX - startX;
  const h = e.clientY - startY;
  drawScene(startX, startY, w, h, true);
  updateSizeLabel(e.clientX, e.clientY, Math.abs(w), Math.abs(h));
});

// ─── 鼠标释放：裁剪并返回 ─────────────────────────────────────
canvas.addEventListener('mouseup', (e) => {
  if (!isDrawing || !bgImage) return;
  isDrawing = false;
  sizeLabel.style.display = 'none';

  // 计算最终选区（支持反向拖拽）
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);

  // 选区太小则取消
  if (w < 10 || h < 10) {
    window.api.captureCancel();
    return;
  }

  // 用离屏 canvas 裁剪选区
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width  = w;
  cropCanvas.height = h;
  const cropCtx = cropCanvas.getContext('2d');

  // 从全屏截图中裁出选区
  cropCtx.drawImage(bgImage, x, y, w, h, 0, 0, w, h);

  const croppedDataURL = cropCanvas.toDataURL('image/png');

  // 传回主进程
  window.api.captureDone(croppedDataURL);
});

// ─── 辅助函数 ──────────────────────────────────────────────────

/**
 * 绘制整个 overlay 场景：
 *   背景图 → 半透明遮罩 → 露出选区 → 选框边线 → 角标线
 *
 * @param {number} sx     拖拽起点 X
 * @param {number} sy     拖拽起点 Y
 * @param {number} sw     宽度（可为负数，支持反向拖拽）
 * @param {number} sh     高度（可为负数）
 * @param {boolean} hasSelection  是否有选区
 */
function drawScene(sx, sy, sw, sh, hasSelection) {
  if (!bgImage) return;

  // 1. 绘制全屏截图
  ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);

  // 2. 叠加半透明黑色遮罩（整屏）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!hasSelection || (sw === 0 && sh === 0)) return;

  // 3. 计算实际矩形坐标（左上 + 正数宽高）
  const rx = sw < 0 ? sx + sw : sx;
  const ry = sh < 0 ? sy + sh : sy;
  const rw = Math.abs(sw);
  const rh = Math.abs(sh);

  // 4. 选区内清除遮罩（透明），再画回原图
  ctx.clearRect(rx, ry, rw, rh);
  ctx.drawImage(bgImage, rx, ry, rw, rh, rx, ry, rw, rh);

  // 5. 选框蓝色边线
  ctx.save();
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();

  // 6. 四个角的 L 形角标（增强视觉感）
  const cornerLen = Math.min(16, rw / 4, rh / 4);
  ctx.save();
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';

  // 左上
  drawCorner(rx, ry, cornerLen, 1, 1);
  // 右上
  drawCorner(rx + rw, ry, cornerLen, -1, 1);
  // 左下
  drawCorner(rx, ry + rh, cornerLen, 1, -1);
  // 右下
  drawCorner(rx + rw, ry + rh, cornerLen, -1, -1);

  ctx.restore();
}

/**
 * 在指定角点绘制 L 形角标
 * dx/dy = ±1 控制方向
 */
function drawCorner(cx, cy, len, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(cx + dx * len, cy);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx, cy + dy * len);
  ctx.stroke();
}

/**
 * 更新跟随鼠标的尺寸提示标签位置和文字
 */
function updateSizeLabel(mouseX, mouseY, w, h) {
  sizeLabel.style.display = 'block';
  sizeLabel.textContent   = `${w} × ${h}`;

  // 标签跟随鼠标，稍微偏移避免遮住选框角
  const offsetX = 12;
  const offsetY = 16;
  let lx = mouseX + offsetX;
  let ly = mouseY + offsetY;

  // 超出右边界时翻转
  if (lx + 90 > canvas.width) lx = mouseX - 90;
  // 超出下边界时翻转
  if (ly + 24 > canvas.height) ly = mouseY - 28;

  sizeLabel.style.left = lx + 'px';
  sizeLabel.style.top  = ly + 'px';
}
