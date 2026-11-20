'use strict';

const assert = require('assert');
const { scoreSetup, calcTAFromKlines } = require('../src/pp369/confluenceScorer');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('================================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ TREND 3 TẦNG & AI REVIEWER STREAMLINED');
console.log('================================================================\n');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Confluence Scorer - Đánh giá Xu hướng 3 Tầng (D1 + H4 + H1)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Confluence Scorer: Nhận diện và cộng điểm đầy đủ Ma trận Trend 3 Tầng', () => {
  const taMock = {
    price: 105,
    aboveEMA200: true, // D1: Trên EMA200 (+1đ)
    regime: 'TRENDING_UP', // D1: Regime Uptrend (+1đ)
    ema: { e7: 102, e25: 98, e99: 90 }, // H4: EMA stack full LONG (105 > 102 > 98 > 90) (+2đ)
    ema1h: { e7: 104, e25: 101, e99: 95 }, // H1: EMA stack H1 full LONG (105 > 104 > 101 > 95) (+1đ)
    rsi: { '4h': 45, '1d': 50 },
    bb: { bandwidth: 5.0, pctB: 50 },
    support: [95],
    supportTouches: [2]
  };

  const sig369 = { signal: 'LONG', targetLevel: 98, touchCount: 0 };
  const res = scoreSetup('SOL', 'LONG', taMock, null, null, null, null, null, null, sig369);

  assert.strictEqual(res.disqualified, false);
  const reasonsStr = res.reasons.join(' ');
  assert.ok(reasonsStr.includes('Trên EMA200D dài hạn (+1)'), 'Phải có điểm D1');
  assert.ok(reasonsStr.includes('Regime 1D TRENDING_UP (+1)'), 'Phải có điểm Regime D1');
  assert.ok(reasonsStr.includes('EMA 4H stack LONG hoàn toàn (+2)'), 'Phải có điểm H4');
  assert.ok(reasonsStr.includes('EMA 1H stack LONG ngắn hạn (+1)'), 'Phải có điểm H1');
  assert.ok(reasonsStr.includes('HỢP LƯU XU HƯỚNG 3 TẦNG: D1 + H4 + H1 đồng thuận (+1)'), 'Phải có điểm thưởng hợp lưu 3 tầng');
  assert.ok(res.total >= 8.0, `Điểm hợp lưu siêu sóng phải cao (thực tế: ${res.total}đ)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: AI Reviewer - Bỏ hẳn turnover_guard (Không chặn coin Volume cao)
// ─────────────────────────────────────────────────────────────────────────────
runTest('AI Reviewer: Đã gỡ bỏ hoàn toàn turnover_guard, coin high volume không bị phạt', () => {
  const sig = {
    symbol: 'PEPEUSDT',
    signal: 'LONG',
    score: 8.5,
    targetLevel: 0.00001,
    marketCapRank: 180,
    gridWidthPct: 3.5,
    scoreReasons: ['Tại S/R 1D', 'EMA stack LONG']
  };

  // Giả lập coin có turnover cực cao (Vol gấp nhiều lần Market Cap)
  const rawMarketData = {
    symbol: 'PEPE',
    targetLevel: 0.00001,
    isTurnoverBlocked: true, // Cờ cũ của turnoverGuard
    currM15: { open: 0.00001005, high: 0.0000101, low: 0.0000100, close: 0.00001002 }
  };

  const evalResult = evaluateSignalWithAI(sig, rawMarketData);
  assert.ok(!evalResult.keyFactors.some(k => k.includes('turnover_guard')), 'Không được chứa turnover_guard trong keyFactors');
  assert.notStrictEqual(evalResult.vetoCategory, 'TURNOVER_RISK_BLOCKED', 'Không được bị veto bởi turnover_guard');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: AI Reviewer - Lệnh Limit tiếp cận mốc không bị phạt thiếu râu rút chân
// ─────────────────────────────────────────────────────────────────────────────
runTest('AI Reviewer: Lệnh Limit đón đầu tiếp cận mốc tự nhiên (HOLD_OR_HOVER) là baseline 1.00', () => {
  const sig = {
    symbol: 'BTCUSDT',
    signal: 'LONG',
    score: 8.0,
    targetLevel: 90000,
    marketCapRank: 1,
    gridWidthPct: 2.5,
    scoreReasons: ['Tại S/R 4H']
  };

  // Nến đang chạy tiến sát mốc Limit (chưa chạm đáy, chưa rút chân)
  const rawMarketData = {
    targetLevel: 90000,
    currH1: { open: 90500, high: 90550, low: 90050, close: 90100 }, // Chưa rút râu
    currM15: { open: 90200, high: 90250, low: 90050, close: 90100 }
  };

  const evalResult = evaluateSignalWithAI(sig, rawMarketData);
  assert.ok(evalResult.winProbability >= 50.0, `Xác suất lệnh limit chuẩn phải cao (thực tế: ${evalResult.winProbability}%)`);
  assert.ok(!evalResult.reason.includes('CANDLE_MARUBOZU_DUMP'), 'Không được phạt marubozu dump oan');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: AI Reviewer - Tiêu chí trùng lặp (Nhóm 1, 2, 5) đã được bỏ khỏi multiplier
// ─────────────────────────────────────────────────────────────────────────────
runTest('AI Reviewer: Bỏ các tiêu chí trùng lặp (trend, rsi, volume, oi, funding) khỏi nhân dồn hệ số', () => {
  const sig = {
    symbol: 'SOLUSDT',
    signal: 'LONG',
    score: 7.5,
    targetLevel: 150,
    marketCapRank: 5,
    gridWidthPct: 3.0,
    scoreReasons: ['Ngược/Mâu thuẫn', 'Volume bùng nổ']
  };

  const evalResult = evaluateSignalWithAI(sig, null);
  // Các nhãn thuộc nhóm đã bỏ: 'trend', 'rsi', 'volume' (chỉ báo nến cũ), 'funding', 'oi_change', 'ls_flow'
  const deprecatedValues = ['TREND_CONFLICT', 'RSI_EXTREME', 'RSI_NEAR', 'FUNDING_DANGER', 'OI_SURGE', 'LS_DIVERGENCE'];
  const hasDeprecatedFactors = evalResult.keyFactors.some(k => 
    deprecatedValues.some(dv => k.includes(dv))
  );
  assert.strictEqual(hasDeprecatedFactors, false, 'Các tiêu chí trùng lặp không được tác động nhân multiplier');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: AI Reviewer - risk_interaction vẫn bảo vệ khi có bão hợp lưu thực sự
// ─────────────────────────────────────────────────────────────────────────────
runTest('AI Reviewer: risk_interaction vẫn kích hoạt Veto khi có bão kép nảy xa + bão BTC', () => {
  const sig = {
    symbol: 'ALTUSDT',
    signal: 'LONG',
    score: 8.0,
    targetLevel: 1.0,
    marketCapRank: 160,
    gridWidthPct: 3.0,
    scoreReasons: ['Tại S/R 1D']
  };

  // Nảy cực xa (>= 3.0%) kết hợp bão BTC
  const rawMarketData = {
    targetLevel: 1.0,
    maxRecentBouncePct: 3.5, // Nảy cực xa
    btcM15Pct: 1.8 // Bão BTC giật mạnh > 1.0%
  };

  const evalResult = evaluateSignalWithAI(sig, rawMarketData);
  assert.strictEqual(evalResult.isApproved, false, 'Phải Veto kèo nguy hiểm kép');
  assert.ok(
    evalResult.vetoCategory === 'INTERACTION_STALE_BOUNCE_RUNAWAY' || evalResult.reason.includes('STALE_BOUNCE') || evalResult.winProbability < evalResult.threshold,
    'Phải nhận diện được rủi ro nảy quá xa kết hợp bão BTC'
  );
});

console.log('\n================================================================');
console.log('🏁 KẾT QUẢ KIỂM THỬ: TẤT CẢ 5/5 TESTS ĐẠT CHUẨN (100.0%)');
console.log('================================================================');
