/**
 * privacy-mask.js — 隱私遮蔽引擎
 *
 * 支援十餘種敏感資料自動偵測與遮蔽，繁體中文場景特化：
 *   IPv4/IPv6、Email、電話（台灣手機/市話/國際）、
 *   身分證字號、統一編號、信用卡、銀行帳號、
 *   API 金鑰/Token/密碼、以及姓名欄位上下文偵測
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 遮蔽規則定義
//
// 每條規則格式：
//   { id, label, pattern, captureGroup? }
//
//   id          : 唯一識別符
//   label       : 取代後顯示的佔位文字，例如 [電話]
//   pattern     : RegExp（必須含 /g flag；若含 capture group，
//                 captureGroup=1 代表只遮蔽括號內的敏感值，保留前綴）
//   captureGroup: (可選) 只遮蔽第幾個 capture group（1-indexed）
// ─────────────────────────────────────────────────────────────────────────────
const MASK_RULES = [

  // ── 1. IP 位址 ────────────────────────────────────────────────────────────
  {
    id: 'ipv4',
    label: '[IP位址]',
    // 嚴格比對 0-255 範圍。
    // 末尾用 (?![.\d]) 而非 \b：OCR 常把 IP 與後綴文字（如「JP」「:80」）黏在一起，
    // 此時 \b 在「9J」之間不觸發（兩者都是 \w），改用負向前瞻只排除「後面還有數字或點」的情況。
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?![.\d])/g,
  },
  {
    id: 'ipv6',
    label: '[IPv6]',
    // 兩段交替：
    //   Alt-A（起始為十六進位）：要求至少 3 個冒號分隔群組，排除 HH:MM:SS 時間（只有 2 個冒號）
    //     (?<![:\w]) 避免從字串中間切入；(?![:\w]) 確保不緊接更多 hex/冒號
    //   Alt-B（起始為 :: ）：loopback ::1、壓縮 ::ffff:… 等均適用
    //     :: 後可接 0–6 組 hex，不需 \b 因為 : 本身就不是 \w
    pattern: /(?<![0-9a-fA-F])[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){3,7}(?![:\w])|::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![:\w])/g,
  },

  // ── 2. 電子郵件 ───────────────────────────────────────────────────────────
  {
    id: 'email',
    label: '[電子郵件]',
    pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
  },

  // ── 3. 電話號碼 ───────────────────────────────────────────────────────────
  {
    id: 'phone_tw_mobile',
    label: '[電話]',
    // 台灣手機：09XX-XXX-XXX｜09XX.XXX.XXX（OCR 常把橫線誤辨為句點）｜09XXXXXXXX（10位）
    // 分隔符接受 - 、. 、空格，或無分隔
    pattern: /\b09\d{2}[-.\s]?\d{3}[-.\s]?\d{3}(?!\d)/g,
  },
  {
    id: 'phone_tw_landline',
    label: '[電話]',
    // 台灣市話：(02)2XXX-XXXX｜03.XXX.XXXX 等（同樣接受 . 分隔）
    pattern: /(?<!\d)(?:\(0[2-9]\d?\)|0[2-9]\d?)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g,
  },
  {
    id: 'phone_intl',
    label: '[電話]',
    // 國際電話：+886-XXX-XXX-XXXX 或 +1 (555) 555-5555
    pattern: /\+\d{1,3}[-\s]?(?:\(\d{1,4}\)[-\s]?)?\d{1,4}[-\s]?\d{2,4}[-\s]?\d{2,9}/g,
  },

  // ── 4. 身分證 / 護照 ──────────────────────────────────────────────────────
  {
    id: 'tw_id',
    label: '[身分證]',
    // 中華民國身分證：大寫英文字母 + 1或2 + 8位數字（共10碼）
    pattern: /\b[A-Z][12]\d{8}\b/g,
  },
  {
    id: 'tw_passport',
    label: '[護照號碼]',
    // 台灣護照：3碼英文 + 6碼數字
    pattern: /\b[A-Z]{3}\d{6}\b/g,
  },
  {
    id: 'tw_unified_biz',
    label: '[統一編號]',
    // 統一編號（公司行號）：上下文 + 8位數字
    pattern: /(?:統一編號|公司編號|稅籍編號|統編)[:\s]*(\d{8})/g,
    captureGroup: 1,
  },

  // ── 5. 信用卡 / 銀行帳號 ──────────────────────────────────────────────────
  {
    id: 'credit_card',
    label: '[信用卡號]',
    // 16 碼，可含空格或橫線
    pattern: /\b(?:\d{4}[-\s]){3}\d{4}\b|\b\d{16}\b/g,
  },
  {
    id: 'bank_account',
    label: '[銀行帳號]',
    // 台灣銀行帳號通常 10-14 碼，需上下文才觸發
    pattern: /(?:帳號|帳戶|戶號|存款帳號|匯款帳號)[:\s]*(\d{10,16})/g,
    captureGroup: 1,
  },

  // ── 6. API 金鑰 / Token / 密碼 ───────────────────────────────────────────
  {
    id: 'api_key_openai',
    label: '[API金鑰]',
    // OpenAI / Anthropic / Stripe 風格：sk-xxx, pk-xxx, ak-xxx
    pattern: /\b(?:sk|pk|ak|rk)-[a-zA-Z0-9\-_]{20,}\b/g,
  },
  {
    id: 'api_key_bearer',
    label: '[Bearer Token]',
    // HTTP Authorization header 格式
    pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]{10,}={0,2}/gi,
  },
  {
    id: 'api_key_hex',
    label: '[API金鑰]',
    // 32位以上十六進位字串（MD5、SHA、API Key 常見格式）
    // 避免誤判 CSS 色碼（6位）或短數字串
    pattern: /\b[0-9a-f]{32,64}\b/gi,
  },
  {
    id: 'api_key_context',
    label: '[API金鑰]',
    // 上下文觸發：api_key=、token=、secret=、access_token: 等
    pattern: /(?:api[_\-]?key|access[_\-]?token|auth[_\-]?token|secret[_\-]?key|private[_\-]?key|client[_\-]?secret)[=:\s]+["']?([a-zA-Z0-9\-._~+/!@#$%^&*]{8,})["']?/gi,
    captureGroup: 1,
  },
  {
    id: 'password',
    label: '[密碼]',
    // 上下文觸發：password:、密碼:、口令: 等後面的值
    // 排除 [ ] 防止把先前規則產生的佔位符（如 [電話]）再次捕捉成密碼值
    pattern: /(?:password|passwd|pwd|密碼|口令|通行碼)[=:\s]+["']?([^\s\n"',；。！？\[\]]{3,})["']?/gi,
    captureGroup: 1,
  },

  // ── 7. 姓名（繁體中文場景特化）───────────────────────────────────────────
  {
    id: 'tw_name',
    label: '[姓名]',
    // 姓名指示詞後的 2-4 個中文字（非數字、非標點）
    // 常見前綴：姓名、客戶、聯絡人、負責人、申請人、承辦人、收件人、持卡人…
    pattern: /(?:姓名|客戶姓名|客戶|聯絡人|負責人|申請人|承辦人|收件人|寄件人|簽名人|持卡人|訂購人|訂票人|投保人|被保人|代理人)[:\s]*([^\s\d\n，。！？；,]{2,4})/g,
    captureGroup: 1,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 主要遮蔽函式
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// OCR 雜訊正規化
//
// OCR 引擎常把某些字元辨識錯誤，導致格式化 regex 無法命中。
// 在執行遮蔽前先做字元層級的正規化，提高召回率。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 修正常見 OCR 辨識錯誤，傳回正規化後的文字
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeOcrArtifacts(text) {
  return text
    // ── 句號類：間隔號 / 全形句點 → 英文句點（IP 位址最常見）
    .replace(/[·・‧．｡]/g, '.')       // U+00B7 / U+30FB / U+2027 / FF0E / U+FF61

    // ── 連字號類：全形橫線 / em-dash / en-dash → 半形橫線（電話號碼）
    .replace(/[－—–‒―]/g, '-')        // FF0D / 2014 / 2013 / 2012 / 2015

    // ── 全形數字 → 半形數字（0-9）
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))

    // ── 全形大寫英文 → 半形（身分證字首等）
    .replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF21 + 0x41))

    // ── 全形小寫英文 → 半形
    .replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF41 + 0x61))

    // ── 全形 @ → 半形（Email）
    .replace(/＠/g, '@')

    // ── 全形冒號 → 半形冒號
    // 密碼：hunter2 / api_key：xxx 等上下文觸發規則的分隔符用 [=:\s]+ 只認半形 :，
    // 正規化後統一為半形，所有 context 規則都能命中。
    .replace(/：/g, ':')                  // U+FF1A FULLWIDTH COLON → U+003A

    // ── 空格雜訊：電話號碼常被插入多餘空格，連續空格壓縮為一個
    // 注意：不全域壓縮，只針對數字序列間的空格
    .replace(/(\d)[ \t]{1,2}(\d)/g, (_, a, b) => a + b);  // 如「09 12 345 678」→「0912345678」（不跨行）
}

/**
 * 對文字執行隱私遮蔽
 *
 * @param {string} text     - 原始文字
 * @param {string[]} [enabledIds] - 要啟用的規則 id 列表（預設全部啟用）
 * @returns {{ maskedText: string, findings: Array<{id, label, count}> }}
 */
function maskText(text, enabledIds = null) {
  if (!text) return { maskedText: text, findings: [] };

  const findings = [];
  // 先正規化 OCR 雜訊，再執行遮蔽
  let result = normalizeOcrArtifacts(text);

  for (const rule of MASK_RULES) {
    // 若有白名單，只執行指定規則
    if (enabledIds && !enabledIds.includes(rule.id)) continue;

    // 重置 lastIndex（g flag 的 stateful 特性）
    rule.pattern.lastIndex = 0;

    // 計算命中次數並執行取代
    let count = 0;

    if (rule.captureGroup) {
      // 有 capture group：只遮蔽括號內的部分，保留前綴
      result = result.replace(rule.pattern, (match, ...args) => {
        const groups = args.slice(0, rule.captureGroup);
        const captured = groups[rule.captureGroup - 1];
        if (!captured) return match; // 安全保護
        count++;
        return match.replace(captured, rule.label);
      });
    } else {
      result = result.replace(rule.pattern, () => {
        count++;
        return rule.label;
      });
    }

    if (count > 0) {
      // 合併相同 label 的統計（例如多條電話規則合計）
      const existing = findings.find(f => f.label === rule.label);
      if (existing) {
        existing.count += count;
      } else {
        findings.push({ id: rule.id, label: rule.label, count });
      }
    }
  }

  return { maskedText: result, findings };
}

/**
 * 取得所有規則的 id 與顯示名稱，供 UI 建立勾選清單使用
 *
 * @returns {Array<{id, label, name}>}
 */
function getRuleList() {
  // 去重（同 label 的多條規則合為一個 UI 項目）
  const seen = new Set();
  const list = [];
  for (const rule of MASK_RULES) {
    if (seen.has(rule.label)) continue;
    seen.add(rule.label);

    // 找出同 label 的所有 ids
    const ids = MASK_RULES.filter(r => r.label === rule.label).map(r => r.id);
    list.push({ ids, label: rule.label, name: _labelToName(rule.label) });
  }
  return list;
}

/**
 * 將 [XXX] 格式 label 轉成易讀名稱
 */
function _labelToName(label) {
  const nameMap = {
    '[IP位址]':     'IP 位址',
    '[IPv6]':       'IPv6 位址',
    '[電子郵件]':   '電子郵件',
    '[電話]':       '電話號碼',
    '[身分證]':     '身分證字號',
    '[護照號碼]':   '護照號碼',
    '[統一編號]':   '統一編號',
    '[信用卡號]':   '信用卡號',
    '[銀行帳號]':   '銀行帳號',
    '[API金鑰]':    'API 金鑰',
    '[Bearer Token]': 'Bearer Token',
    '[密碼]':       '密碼',
    '[姓名]':       '姓名（上下文）',
  };
  return nameMap[label] || label;
}

// ─────────────────────────────────────────────────────────────────────────────
// 高亮輸出：將遮蔽佔位符包成 <span class="masked-token"> 以利 CSS 高亮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 將 maskedText 中的 [XXX] 佔位符包成可高亮的 span
 *
 * @param {string} maskedText
 * @returns {string} HTML 字串（已做 XSS 轉義）
 */
function toHighlightedHtml(maskedText) {
  // 先做基礎 HTML 轉義
  const escaped = maskedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 把 [XXX] 佔位符包成 span
  return escaped.replace(/\[([^\]]+)\]/g, (_, inner) => {
    return `<span class="masked-token" title="${inner}">[${inner}]</span>`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 匯出（Electron renderer 用 window 全域，不用 ES module）
// ─────────────────────────────────────────────────────────────────────────────
window.privacyMask = { maskText, getRuleList, toHighlightedHtml, normalizeOcrArtifacts };
