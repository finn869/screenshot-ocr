"""
ocr_server.py — 本地 EasyOCR HTTP 服务
替换原 OCR.space 云端 API，完全离线、无限次数

启动方式：
  python ocr_server.py

依赖：
  pip install easyocr flask pillow numpy

端口：7788（可通过环境变量 OCR_PORT 修改）
"""

import os
import io
import base64
import logging

import numpy as np
from PIL import Image
from flask import Flask, request, jsonify
import easyocr

# ─── 配置 ───────────────────────────────────────────────────────────
PORT = int(os.environ.get('OCR_PORT', 7788))
# 支持语言：简体中文 + 英文（中英混排场景必须同时加载）
LANGUAGES = ['ch_sim', 'en']
# GPU 加速（如果没有 CUDA 或 MPS，保持 False）
USE_GPU = False

# ─── 日志 ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='[OCR-Server] %(asctime)s %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

# ─── 初始化 EasyOCR（启动时只加载一次，避免每次请求重新加载模型）───
log.info('正在初始化 EasyOCR（首次运行会下载模型，约需 1-2 分钟）…')
reader = easyocr.Reader(LANGUAGES, gpu=USE_GPU)
log.info('EasyOCR 初始化完成，服务就绪')

# ─── Flask App ──────────────────────────────────────────────────────
app = Flask(__name__)


@app.route('/health', methods=['GET'])
def health():
    """健康检查，Electron 用来确认服务已启动"""
    return jsonify({'status': 'ok', 'engine': 'easyocr'})


@app.route('/ocr', methods=['POST'])
def ocr():
    """
    接受 JSON: { "base64Image": "<data:image/...;base64,...>" }
    返回 JSON: { "success": true, "text": "识别结果" }
              或 { "success": false, "error": "错误信息" }
    """
    try:
        payload = request.get_json(force=True, silent=True)
        if not payload or 'base64Image' not in payload:
            return jsonify({'success': False, 'error': '缺少 base64Image 字段'}), 400

        b64 = payload['base64Image']

        # 移除 data URL 前缀（如 "data:image/png;base64,"）
        if ',' in b64:
            b64 = b64.split(',', 1)[1]

        # base64 → PIL Image → numpy array
        img_bytes = base64.b64decode(b64)
        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        img_array = np.array(img)

        log.info('收到 OCR 请求，图片尺寸: %dx%d', img.width, img.height)

        # EasyOCR 识别
        # detail=0: 只返回文字，不返回坐标和置信度
        # paragraph=True: 自动合并同行文字块
        results = reader.readtext(
            img_array,
            detail=0,
            paragraph=True,
        )

        text = '\n'.join(results)
        log.info('识别完成，共 %d 个文字块，%d 个字符', len(results), len(text.replace('\n', '')))

        return jsonify({'success': True, 'text': text})

    except Exception as e:
        log.error('OCR 处理失败: %s', str(e), exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    log.info('启动 EasyOCR 服务，监听 http://127.0.0.1:%d', PORT)
    # threaded=True 支持并发请求；use_reloader=False 防止模型被重复加载
    app.run(host='127.0.0.1', port=PORT, debug=False,
            threaded=True, use_reloader=False)
