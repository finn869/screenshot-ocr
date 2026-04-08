/**
 * capture/overlay.js — 全屏截图选区（支持移动 + 调整大小）
 *
 * 三个阶段：
 *   idle     → 等待拖拽
 *   drawing  → 正在拖拽画初始选区
 *   selected → 选区已建立，可移动 / 调整大小 / 确认
 */

// ─── DOM ──────────────────────────────────────────────────────
const canvas     = document.getElementById('overlay-canvas');
const ctx        = canvas.getContext('2d');
const sizeLabel  = document.getElementById('size-label');
const hintBar    = document.getElementById('hint-bar');
const confirmBtn = document.getElementById('confirm-btn');

// ─── 常量 ─────────────────────────────────────────────────────
const HANDLE_R  = 5;   // 控制点半径（像素）
const HANDLE_HIT = 10; // 控制点点击热区（比视觉稍大，更好点击）

// 8 个控制点名称（顺时针）
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];

// ─── 状态 ─────────────────────────────────────────────────────
let phase = 'idle';          // 'idle' | 'drawing' | 'selected'
let bgImage = null;

// 当前选区（始终保持 x/y 为左上角、w/h 为正数）
let sel = { x: 0, y: 0, w: 0, h: 0 };

// 拖拽起点（drawing 阶段）
let drawStart = { x: 0, y: 0 };

// 移动 / 缩放操作时的快照
let dragType   = null;  // 'move' | handle名称
let dragOrigin = null;  // 鼠标按下时的坐标
let selSnapshot = null; // 鼠标按下时的选区快照

// ─── 初始化 ───────────────────────────────────────────────────
window.api.onInitOverlay(({ imageData, width, height }) => {
  canvas.width  = width;
  canvas.height = height;

  const img = new Image();
  img.onload = () => {
    bgImage = img;
    render();
  };
  img.src = imageData;
});

// ─── 键盘 ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { window.api.captureCancel(); return; }
  if (e.key === 'Enter' && phase === 'selected') confirmCapture();
});

// ─── 确认按钮 ─────────────────────────────────────────────────
confirmBtn.addEventListener('click', confirmCapture);

// ─── 鼠标事件 ─────────────────────────────────────────────────
canvas.addEventListener('mousedown', onMouseDown);
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mouseup',   onMouseUp);

function onMouseDown(e) {
  const pos = { x: e.clientX, y: e.clientY };

  if (phase === 'idle' || phase === 'drawing') {
    // 开始新选区
    phase = 'drawing';
    drawStart = pos;
    sel = { x: pos.x, y: pos.y, w: 0, h: 0 };
    hideConfirmBtn();
    return;
  }

  if (phase === 'selected') {
    const handle = getHandleAt(pos.x, pos.y);

    if (handle) {
      // 点到控制点 → 缩放模式
      dragType    = handle;
      dragOrigin  = pos;
      selSnapshot = { ...sel };
    } else if (isInsideSel(pos.x, pos.y)) {
      // 点到选区内部 → 移动模式
      dragType    = 'move';
      dragOrigin  = pos;
      selSnapshot = { ...sel };
    } else {
      // 点到选区外部 → 重新画
      phase = 'drawing';
      drawStart = pos;
      sel = { x: pos.x, y: pos.y, w: 0, h: 0 };
      hideConfirmBtn();
    }
  }
}

function onMouseMove(e) {
  const pos = { x: e.clientX, y: e.clientY };

  if (phase === 'drawing') {
    // 实时更新选区大小
    sel = normalizeRect(drawStart.x, drawStart.y,
                        pos.x - drawStart.x, pos.y - drawStart.y);
    updateSizeLabel(pos.x, pos.y, sel.w, sel.h);
    render();
    return;
  }

  if (phase === 'selected') {
    if (dragType === 'move') {
      // 整体移动
      const dx = pos.x - dragOrigin.x;
      const dy = pos.y - dragOrigin.y;
      sel.x = clamp(selSnapshot.x + dx, 0, canvas.width  - sel.w);
      sel.y = clamp(selSnapshot.y + dy, 0, canvas.height - sel.h);
      updateConfirmBtnPos();
      render();

    } else if (dragType) {
      // 缩放（根据拖拽的控制点调整对应边）
      applyHandleDrag(pos);
      updateSizeLabel(pos.x, pos.y, sel.w, sel.h);
      updateConfirmBtnPos();
      render();

    } else {
      // 悬停时更新光标样式
      const handle = getHandleAt(pos.x, pos.y);
      if (handle) {
        canvas.style.cursor = getCursorForHandle(handle);
      } else if (isInsideSel(pos.x, pos.y)) {
        canvas.style.cursor = 'move';
      } else {
        canvas.style.cursor = 'crosshair';
      }
    }
  }
}

function onMouseUp(e) {
  if (phase === 'drawing') {
    const pos = { x: e.clientX, y: e.clientY };
    sel = normalizeRect(drawStart.x, drawStart.y,
                        pos.x - drawStart.x, pos.y - drawStart.y);

    if (sel.w < 5 || sel.h < 5) {
      // 选区太小，重置
      phase = 'idle';
      render();
      return;
    }

    // 进入 selected 阶段
    phase = 'selected';
    hintBar.textContent = '拖动移动 · 拖动控制点调整大小 · Enter 或双击确认 · ESC 取消';
    sizeLabel.style.display = 'none';
    updateConfirmBtnPos();
    render();
    return;
  }

  if (phase === 'selected' && dragType) {
    dragType    = null;
    dragOrigin  = null;
    selSnapshot = null;
    sizeLabel.style.display = 'none';
    canvas.style.cursor = 'move';
    updateConfirmBtnPos();
  }
}

// 双击确认
canvas.addEventListener('dblclick', e => {
  if (phase === 'selected' && isInsideSel(e.clientX, e.clientY)) {
    confirmCapture();
  }
});

// ─── 确认截图 ─────────────────────────────────────────────────
function confirmCapture() {
  if (!bgImage || sel.w < 1 || sel.h < 1) return;

  // 用离屏 canvas 裁剪选区
  const crop = document.createElement('canvas');
  crop.width  = sel.w;
  crop.height = sel.h;
  crop.getContext('2d').drawImage(bgImage, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);

  window.api.captureDone(crop.toDataURL('image/png'));
}

// ─── 渲染 ─────────────────────────────────────────────────────
function render() {
  if (!bgImage) return;

  // 1. 绘制全屏背景图
  ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);

  // 2. 全屏半透明暗色遮罩
  ctx.fillStyle = 'rgba(0,0,0,0.48)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if ((phase === 'drawing' || phase === 'selected') && sel.w > 0 && sel.h > 0) {
    // 3. 选区内：清除遮罩，露出原图
    ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
    ctx.drawImage(bgImage, sel.x, sel.y, sel.w, sel.h, sel.x, sel.y, sel.w, sel.h);

    // 4. 选区边框
    ctx.save();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    ctx.restore();

    if (phase === 'selected') {
      // 5. 绘制 8 个控制点
      drawHandles();
    } else {
      // 6. 绘制中的 L 形角标
      drawCorners();
    }
  }
}

// 8 个控制点（白色填充圆圈 + 蓝色边框）
function drawHandles() {
  const positions = getHandlePositions();
  HANDLES.forEach(name => {
    const p = positions[name];
    ctx.save();
    ctx.fillStyle   = '#ffffff';
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
}

// 拖拽进行中时的 L 形角标
function drawCorners() {
  const len = Math.min(14, sel.w / 4, sel.h / 4);
  ctx.save();
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  drawCornerL(sel.x,          sel.y,          len,  1,  1);
  drawCornerL(sel.x + sel.w,  sel.y,          len, -1,  1);
  drawCornerL(sel.x,          sel.y + sel.h,  len,  1, -1);
  drawCornerL(sel.x + sel.w,  sel.y + sel.h,  len, -1, -1);
  ctx.restore();
}

function drawCornerL(cx, cy, len, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(cx + dx * len, cy);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx, cy + dy * len);
  ctx.stroke();
}

// ─── 控制点辅助 ───────────────────────────────────────────────

// 计算 8 个控制点坐标
function getHandlePositions() {
  const { x, y, w, h } = sel;
  const mx = x + w / 2, my = y + h / 2;
  return {
    nw: { x,      y      }, n:  { x: mx,    y      }, ne: { x: x+w,  y      },
    e:  { x: x+w, y: my  },
    se: { x: x+w, y: y+h }, s:  { x: mx,    y: y+h }, sw: { x,       y: y+h },
    w:  { x,      y: my  },
  };
}

// 检查某坐标是否命中某个控制点
function getHandleAt(px, py) {
  const pos = getHandlePositions();
  for (const name of HANDLES) {
    const p = pos[name];
    if (Math.abs(px - p.x) <= HANDLE_HIT && Math.abs(py - p.y) <= HANDLE_HIT) {
      return name;
    }
  }
  return null;
}

// 根据控制点名称返回对应光标样式
function getCursorForHandle(name) {
  return { nw:'nw-resize', n:'n-resize', ne:'ne-resize', e:'e-resize',
           se:'se-resize', s:'s-resize', sw:'sw-resize', w:'w-resize' }[name] || 'crosshair';
}

// 拖拽控制点时更新选区（根据方向只改对应的边）
function applyHandleDrag(pos) {
  const dx = pos.x - dragOrigin.x;
  const dy = pos.y - dragOrigin.y;
  const s  = { ...selSnapshot };

  let { x, y, w, h } = s;

  if (dragType.includes('n')) { y = s.y + dy; h = s.h - dy; }
  if (dragType.includes('s')) { h = s.h + dy; }
  if (dragType.includes('w')) { x = s.x + dx; w = s.w - dx; }
  if (dragType.includes('e')) { w = s.w + dx; }

  // 防止宽高变成负数（翻转时重新正规化）
  sel = normalizeRect(x, y, w, h);
}

// ─── 工具函数 ─────────────────────────────────────────────────

// 把任意 w/h（含负数）转成左上角坐标 + 正数宽高
function normalizeRect(x, y, w, h) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

function isInsideSel(px, py) {
  return px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

// 更新「确认截图」按钮位置（跟着选区右下角）
function updateConfirmBtnPos() {
  const btnW = 110, btnH = 34, margin = 8;
  let left = sel.x + sel.w + margin;
  let top  = sel.y + sel.h + margin;

  // 超出右边界
  if (left + btnW > canvas.width)  left = sel.x + sel.w - btnW;
  // 超出下边界
  if (top  + btnH > canvas.height) top  = sel.y - btnH - margin;

  confirmBtn.style.left    = left + 'px';
  confirmBtn.style.top     = top  + 'px';
  confirmBtn.style.display = 'flex';
}

function hideConfirmBtn() {
  confirmBtn.style.display = 'none';
}

// 更新跟随鼠标的尺寸标签
function updateSizeLabel(mx, my, w, h) {
  sizeLabel.style.display = 'block';
  sizeLabel.textContent   = `${Math.round(w)} × ${Math.round(h)}`;
  let lx = mx + 12, ly = my + 16;
  if (lx + 90 > canvas.width)  lx = mx - 90;
  if (ly + 24 > canvas.height) ly = my - 28;
  sizeLabel.style.left = lx + 'px';
  sizeLabel.style.top  = ly + 'px';
}
