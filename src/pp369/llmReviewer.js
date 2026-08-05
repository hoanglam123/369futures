'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('./_logger');

const KNOWLEDGE_DIR = path.join(process.cwd(), 'data', 'knowledge');
const LLM_EVALUATIONS_FILE = path.join(process.cwd(), 'data', 'llm_evaluations.jsonl');
const DEFAULT_MODEL = 'gemini-1.5-flash';

let _cachedKnowledge = null;

/**
 * Nạp toàn bộ tài liệu kiến thức trong thư mục data/knowledge/ (.md, .txt, .json)
 */
function loadKnowledgeBase() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
    const files = fs.readdirSync(KNOWLEDGE_DIR);
    const contents = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (['.md', '.txt', '.json'].includes(ext)) {
        const filePath = path.join(KNOWLEDGE_DIR, file);
        const text = fs.readFileSync(filePath, 'utf8');
        contents.push(`=== TÀI LIỆU KÍCH HOẠT: ${file} ===\n${text}`);
      }
    }

    if (contents.length > 0) {
      _cachedKnowledge = contents.join('\n\n');
      log.system(`[Gemini LLM] ✓ Đã nạp ${contents.length} file tài liệu kiến thức từ data/knowledge/`);
    } else {
      _cachedKnowledge = 'Không có tài liệu kiến thức bổ sung.';
      log.warn('[Gemini LLM] Thư mục data/knowledge/ trống. Sử dụng nhận thức mặc định.');
    }
  } catch (err) {
    log.error(`[Gemini LLM] Lỗi đọc tài liệu kiến thức: ${err.message}`);
    _cachedKnowledge = '';
  }
}

// Nạp kiến thức khi load module
loadKnowledgeBase();

let _currentKeyIdx = 0;

function getApiKeys() {
  const raw = process.env.GEMINI_API_KEY || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

/**
 * Đánh giá bối cảnh tín hiệu bằng Gemini LLM API (Hỗ trợ Xoay vòng Multi-Key)
 *
 * @param {object} sig - Signal object from core.js / autoTrade.js
 * @returns {Promise<object>} { winProbability: number, isApproved: boolean, verdict: string, detailedReason: string, keyFactors: string[] }
 */
async function evaluateSignalWithGemini(sig) {
  const keys = getApiKeys();
  if (keys.length === 0) {
    log.warn('[Gemini LLM] Thiếu GEMINI_API_KEY trong file .env — bỏ qua đánh giá LLM.');
    return {
      winProbability: 50,
      isApproved: false,
      verdict: 'SKIPPED_NO_KEY',
      detailedReason: 'Chưa cấu hình GEMINI_API_KEY trong .env',
      keyFactors: [],
    };
  }

  if (_cachedKnowledge == null) loadKnowledgeBase();

  const sym = sig.symbol || sig.sym || 'UNKNOWN';
  const signal = sig.signal || 'LONG';
  const score = sig.score ?? 0;
  const targetLevel = sig.targetLevel ?? 0;
  const rank = sig.marketCapRank ?? 999;
  const gridWidthPct = sig.gridWidthPct ?? 3.5;
  const scoreReasons = Array.isArray(sig.scoreReasons) ? sig.scoreReasons.join('\n• ') : String(sig.scoreReasons || '');

  const promptText = `
Hãy đóng vai làm một Chuyên gia Quản trị Rủi ro và Senior Trader Futures chuyên sâu về Phương Pháp 369.
Hãy đánh giá bối cảnh tín hiệu giao dịch dưới đây và đưa ra nhận xét chuyên sâu:

--- BỐI CẢNH TÍN HIỆU ---
- Coin: ${sym}USDT (${signal})
- Mốc Entry: $${targetLevel}
- Điểm Thuật Toán (Score): ${score}đ
- Xếp hạng Vốn hóa (MarketCap Rank): ${rank}
- Biên độ bước giá (Grid Width %): ${gridWidthPct.toFixed(2)}%
- Chi tiết các tiêu chí thuật toán:
• ${scoreReasons}

--- YÊU CẦU ĐÁNH GIÁ ---
Dựa trên TÀI LIỆU KẾT CẤU KHIẾN THỨC và các nguyên tắc giao dịch dưới đây, hãy chấm điểm Xác suất thắng (winProbability từ 0 đến 100%) và kết luận có NÊN ĐẶT LỆNH hay KHÔNG.

Vui lòng trả về duy nhất 1 chuỗi JSON chuẩn theo cấu trúc sau (KHÔNG dùng markdown codeblock hay câu dẫn thừa):
{
  "winProbability": 75.5,
  "isApproved": true,
  "verdict": "APPROVE",
  "detailedReason": "Lý do chi tiết ngắn gọn 2-3 câu bằng tiếng Việt dựa trên tài liệu kiến thức",
  "keyFactors": ["Ưu điểm 1", "Điểm yếu 1"]
}
`;

  const systemInstructionText = `
BẠN LÀ MỘT TRÍ TUỆ NHÂN TẠO CHUYÊN GIA GIAO DỊCH FUTURES 369.
Nhiệm vụ duy nhất của bạn là thẩm định tín hiệu giao dịch và đưa ra nhận xét trung thực, khắt khe dựa trên Bộ Tài Liệu Kiến Thức được cung cấp dưới đây:

${_cachedKnowledge}
`;

  let lastErr = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIdx = (_currentKeyIdx + attempt) % keys.length;
    const currentApiKey = keys[keyIdx];

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${currentApiKey}`;
      const payload = {
        systemInstruction: {
          parts: [{ text: systemInstructionText }]
        },
        contents: [
          {
            parts: [{ text: promptText }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      };

      const res = await axios.post(url, payload, { timeout: 15000 });
      const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText) {
        throw new Error('Gemini API không trả về nội dung.');
      }

      // Xoay vòng key cho lượt gọi tiếp theo
      _currentKeyIdx = (_currentKeyIdx + 1) % keys.length;

      const parsed = JSON.parse(rawText.trim());
      return {
        winProbability: parseFloat(parsed.winProbability || 50),
        isApproved: Boolean(parsed.isApproved ?? (parsed.winProbability >= 65)),
        verdict: String(parsed.verdict || (parsed.winProbability >= 65 ? 'APPROVE' : 'REJECT')),
        detailedReason: String(parsed.detailedReason || 'Không có mô tả.'),
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors : [],
      };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const errMsg = err.response?.data?.error?.message || err.message;
      if (status === 429 || status === 403 || status === 400 || errMsg.includes('QUOTA') || errMsg.includes('EXHAUSTED')) {
        log.warn(`[Gemini LLM] Key #${keyIdx + 1} kiệt token (${status || 'Limit'}): ${errMsg}. Tự động xoay sang Key tiếp theo...`);
        continue;
      }
      break;
    }
  }

  const errMsg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Tất cả API keys đều bị kiệt quota';
  log.error(`[Gemini LLM] Thất bại đánh giá ${sym}: ${errMsg}`);
  return {
    winProbability: 50,
    isApproved: false,
    verdict: 'ERROR',
    detailedReason: `Lỗi Gemini API: ${errMsg}`,
    keyFactors: [],
  };
}

/**
 * Log LLM evaluation result to data/llm_evaluations.jsonl for shadow testing
 */
function recordLLMEvaluation(sig, llmEval) {
  try {
    const record = {
      timestamp: Date.now(),
      symbol: sig.symbol || sig.sym,
      signal: sig.signal,
      targetLevel: sig.targetLevel,
      score: sig.score,
      winProbability: llmEval.winProbability,
      isApprovedByLLM: llmEval.isApproved,
      verdict: llmEval.verdict,
      detailedReason: llmEval.detailedReason,
      keyFactors: llmEval.keyFactors,
      marketCapRank: sig.marketCapRank || null,
      gridWidthPct: sig.gridWidthPct || null,
      scoreReasons: sig.scoreReasons || [],
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFile(LLM_EVALUATIONS_FILE, line, 'utf8', (err) => {
      if (err) log.error(`[Gemini LLM] Lỗi ghi file llm_evaluations.jsonl: ${err.message}`);
    });
  } catch (err) {
    log.error(`[Gemini LLM] Lỗi ghi log đánh giá LLM: ${err.message}`);
  }
}

module.exports = {
  loadKnowledgeBase,
  evaluateSignalWithGemini,
  recordLLMEvaluation,
};
