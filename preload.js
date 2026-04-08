/**
 * preload.js — 主进程与渲染进程的安全桥接层
 *
 * 使用 contextBridge 把特定的 ipcRenderer 方法暴露给渲染层，
 * 渲染层只能调用这里明确暴露的 API，无法直接访问 Node.js 或 Electron 内部。
 *
 * 这个文件同时服务于：
 *   - renderer/index.html（主窗口）
 *   - capture/overlay.html（截图选区窗口）
 *
 * 两个页面各自只会用到其中一部分 API。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── 主窗口用 ─────────────────────────────────────────────────

  /**
   * 通知主进程开始截图流程
   * 主窗口点击「截图」按钮时调用
   */
  startCapture: () => ipcRenderer.invoke('start-capture'),

  /**
   * 监听截图完成事件
   * 主进程把裁剪好的图发过来时触发
   * @param {(dataURL: string) => void} callback
   */
  onScreenshotResult: (callback) => {
    ipcRenderer.on('screenshot-result', (event, dataURL) => callback(dataURL));
  },

  // ── Overlay 窗口用 ────────────────────────────────────────────

  /**
   * 监听初始化数据（全屏截图 + 尺寸）
   * overlay 加载完成后主进程会发这条消息
   * @param {(payload: { imageData: string, width: number, height: number }) => void} callback
   */
  onInitOverlay: (callback) => {
    ipcRenderer.on('init-overlay', (event, payload) => callback(payload));
  },

  /**
   * 截图完成，把裁剪后的图片 dataURL 传给主进程
   * @param {string} croppedDataURL
   */
  captureDone: (croppedDataURL) => ipcRenderer.invoke('capture-done', croppedDataURL),

  /**
   * 取消截图（按 ESC 或选区太小）
   */
  captureCancel: () => ipcRenderer.invoke('capture-cancel'),

});
