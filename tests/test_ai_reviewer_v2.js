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

// Test 1: Standard signal evaluation with base 58% threshold
test('Base Signal Evaluation without Raw Data', () => {
  const sig = {
    symbol: 'ETHUSDT',
    signal: 'LONG',
    score: 7.5,
    marketCapRank: 2,
    gridWidthPct: 3.5,
    scoreReasons: ['Dow & Trendline', 'H1 siêu nén', 'Gold Setup', '4 cản cũ', 'BTC thuận Dow/EMA']
  };
  const evalResult = evaluateSignalWithAI(sig);
  assert(evalResult.winProbability >= 58.0, `Expected WinProb >= 58%, got ${evalResult.winProbability}`);
  assert.strictEqual(evalResult.isApproved, true);
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

// Test 4: Touch Count / Level Freshness
test('Level Freshness: Fresh level (touch 1) gives boost, exhausted level (touch 3) penalizes', () => {
  const sig = {
    symbol: 'NEARUSDT',
    signal: 'SHORT',
    score: 6.5,
    marketCapRank: 25,
    gridWidthPct: 3.5,
    scoreReasons: ['EMA20>EMA50', 'H1 nén vừa', '2 cản cũ']
  };
  const freshEval = evaluateSignalWithAI(sig, { touchCount: 1 });
  const exhaustedEval = evaluateSignalWithAI(sig, { touchCount: 3 });

  assert(freshEval.winProbability > exhaustedEval.winProbability, `Fresh touch (${freshEval.winProbability}) must be higher than exhausted touch (${exhaustedEval.winProbability})`);
  assert(freshEval.reason.includes('FRESH_LEVEL_TOUCH1'), 'Should flag FRESH_LEVEL_TOUCH1');
  assert(exhaustedEval.reason.includes('EXHAUSTED_LEVEL_TOUCH3'), 'Should flag EXHAUSTED_LEVEL_TOUCH3');
});

console.log('=' .repeat(80));
console.log(`📊 TEST RESULTS: ${passed}/${total} TESTS PASSED (${((passed/total)*100).toFixed(1)}%)`);
console.log('=' .repeat(80));

if (passed !== total) process.exit(1);
