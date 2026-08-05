'use strict';

require('dotenv').config();
const { loadKnowledgeBase, evaluateSignalWithGemini } = require('../src/pp369');

async function test() {
  console.log('=== TEST GEMINI LLM REVIEWER ===');
  loadKnowledgeBase();

  const mockSig = {
    symbol: 'JASMY',
    signal: 'LONG',
    targetLevel: 0.004122,
    score: 6.8,
    marketCapRank: 120,
    gridWidthPct: 7.28,
    scoreReasons: [
      "[Xu hướng H4/H1] Dow & Trendline LONG hoàn hảo H1 3 ngày & EMA20>EMA50 (+2.0đ)",
      "[Biến động H1/M15] H1 siêu nén: 1.25% <= 4.10% (+0.5đ) | M15 siêu nén: 0.45% <= 2.10% (+0.5đ)",
      "[RSI H1] Quá bán cực đại: RSI H1 25.40 <= 30 (+1.0)",
      "[Tương quan dòng tiền L/S] Đồng thuận tuyệt đối (Gold Setup): Cá voi Long 62.1% & Retail Short 58.4% (+1.5đ)",
      "[Price Action S/R] H4: 3 cản cũ (+0.4đ) | D1: 1 cản cũ (+0.6đ)",
      "[Funding Rate] Short Crowded (Squeeze): Funding Rate -0.0250% (+1.0đ)"
    ]
  };

  console.log('\n--> Gửi tín hiệu thử nghiệm sang Gemini API...');
  const res = await evaluateSignalWithGemini(mockSig);
  console.log('\nKẾT QUẢ TRẢ VỀ TỪ GEMINI LLM:');
  console.log(JSON.stringify(res, null, 2));
}

test();
