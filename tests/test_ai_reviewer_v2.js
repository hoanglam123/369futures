'use strict';

const assert = require('assert');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

console.log('=' .repeat(80));
console.log('🧪 RUNNING AI REVIEWER V2.0 (RAW MARKET METRICS) TEST SUITE');
console.log('=' .repeat(80));

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${err.message}`);
  }
}

// Test 1: Standard MAJORS signal — verify model runs and produces consistent output
// NOTE: Sau khi xóa MAJORS_* penalty và knowledge blending, VOL_ULTRA đã được dữ liệu thực calibrate lại:
// N=600 mẫu cho thấy VOL_ULTRA có WinRate ~56% (< 62.3% prior) → x0.91 penalty là đúng.
// WinProb 57.7% < threshold 60% cho ETHUSDT Rank=2 → isApproved=false là kết quả hợp lý từ dữ liệu.
test('Base Signal Evaluation without Raw Data', () => {
  const sig = {
    symbol: 'ETHUSDT',
    signal: 'LONG',
    score: 7.5,
    marketCapRank: 2,
    gridWidthPct: 3.5,
    timestamp: new Date('2026-09-07T09:00:00+07:00').getTime(),
    scoreReasons: ['Dow & Trendline', 'H1 siêu nén', 'Gold Setup', '4 cản cũ', 'BTC thuận Dow/EMA']
  };
  const evalResult = evaluateSignalWithAI(sig);
  // Kiểm tra model hoạt động đúng và output hợp lệ
  assert(evalResult.winProbability >= 5.0 && evalResult.winProbability <= 95.0,
    `WinProb ${evalResult.winProbability} ngoài range [5, 95]`);
  assert(typeof evalResult.isApproved === 'boolean', 'isApproved phải là boolean');
  // ETHUSDT với setup tốt đạt ngưỡng phê duyệt Majors (>= 50.0%) và isApproved = true
  assert(evalResult.winProbability >= 50.0, `WinProb ${evalResult.winProbability} quá thấp cho setup tốt`);
  assert.strictEqual(evalResult.isApproved, true, 'Setup ETH tốt phải được duyệt (isApproved = true)');
});


// Test 2: Candlestick Geometry — Pinbar Hammer Boost
test('Candlestick Geometry: Pinbar Hammer Rejection Boosts Win Probability', () => {
  const sig = {
    symbol: 'SOLUSDT',
    signal: 'LONG',
    score: 6.5,
    marketCapRank: 5,
    gridWidthPct: 3.2,
    scoreReasons: ['EMA20<EMA50', 'H1 nén vừa', '2 cản cũ']
  };
  const baseEval = evaluateSignalWithAI(sig);

  const rawMarketData = {
    lastM15: {
      open: 140.0,
      high: 141.0,
      low: 135.0,
      close: 139.5, // lower wick = 139.5 - 135 = 4.5; total range = 6.0; ratio = 75%
      volume: 10000
    }
  };
  const pinbarEval = evaluateSignalWithAI(sig, rawMarketData);
  assert(pinbarEval.winProbability > baseEval.winProbability, `Pinbar should boost WinProb (${pinbarEval.winProbability} > ${baseEval.winProbability})`);
  assert(pinbarEval.reason.includes('CANDLE_PINBAR_HAMMER'), 'Should flag CANDLE_PINBAR_HAMMER');
});

// Test 3: Candlestick Geometry — Marubozu Dump Veto
test('Candlestick Geometry: Marubozu Dump Triggers Strong AI Veto Penalty', () => {
  const sig = {
    symbol: 'DOGEUSDT',
    signal: 'LONG',
    score: 6.0,
    marketCapRank: 8,
    gridWidthPct: 3.0,
    scoreReasons: ['EMA20<EMA50', '2 cản cũ']
  };
  const rawMarketData = {
    lastM15: {
      open: 0.125,
      high: 0.1255,
      low: 0.118,
      close: 0.1182, // Bearish solid body dumping through support
      volume: 50000
    }
  };
  const dumpEval = evaluateSignalWithAI(sig, rawMarketData);
  assert(dumpEval.winProbability < 50.0, `Marubozu dump should lower WinProb < 50%, got ${dumpEval.winProbability}`);
  assert.strictEqual(dumpEval.isApproved, false);
  assert(dumpEval.reason.includes('CANDLE_MARUBOZU_DUMP'), 'Should flag CANDLE_MARUBOZU_DUMP');
});

// Test 4: Autonomous Features — BTC Storm Penalty and M15 Sideway Boost
test('Autonomous Features: BTC Storm penalizes, M15 Sideway structure boosts Win Probability', () => {
  const baseSig = {
    symbol: 'NEARUSDT',
    signal: 'SHORT',
    score: 6.5,
    marketCapRank: 25,
    gridWidthPct: 3.5,
    scoreReasons: ['EMA20>EMA50', 'H1 nén vừa', '2 cản cũ', 'BTC đi ngang/trung tính (ADX=18.0)']
  };
  const baseEval = evaluateSignalWithAI(baseSig);

  const stormSig = {
    ...baseSig,
    scoreReasons: ['EMA20>EMA50', 'H1 nén vừa', '2 cản cũ', 'BTC bão giá: M15 biến động 1.2% > 1.0%']
  };
  const stormEval = evaluateSignalWithAI(stormSig);

  const m15AlignedSig = {
    ...baseSig,
    scoreReasons: ['H1 Sideway nhưng M15 có cấu trúc SHORT hoàn chỉnh (LH + LL M15)', 'H1 nén vừa', '2 cản cũ']
  };
  const m15AlignedEval = evaluateSignalWithAI(m15AlignedSig);

  assert(stormEval.winProbability < baseEval.winProbability, `Storm WinProb (${stormEval.winProbability}) must be lower than base (${baseEval.winProbability})`);
  assert(m15AlignedEval.winProbability > baseEval.winProbability, `M15 Aligned WinProb (${m15AlignedEval.winProbability}) must be higher than base (${baseEval.winProbability})`);
});

console.log('=' .repeat(80));
console.log(`📊 TEST RESULTS: ${passed}/${total} TESTS PASSED (${((passed/total)*100).toFixed(1)}%)`);
console.log('=' .repeat(80));

if (passed !== total) process.exit(1);
