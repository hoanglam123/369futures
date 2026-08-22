'use strict';

const assert = require('assert');
const {
  checkTurnoverGuard,
  isTurnoverBlocked,
  setMockVolume24h,
  setMockMarketCapData
} = require('../src/pp369/turnoverGuard');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

function runTurnoverGuardTests() {
  console.log('='.repeat(80));
  console.log('🧪 TEST SUITE: ABNORMAL TURNOVER GUARD (MARKETCAP < 100M & VOL 24H > 8%)');
  console.log('='.repeat(80));

  let passed = 0;
  let total = 0;

  function it(desc, fn) {
    total++;
    try {
      fn();
      console.log(`✅ [PASS] ${desc}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${desc}: ${err.message}`);
    }
  }

  // Cấu hình mock MarketCap & Rank cho các kịch bản kiểm thử
  setMockMarketCapData({
    'BTC': 1_500_000_000_000, // 1.5 Trillion USD (Top 1)
    'SOL': 90_000_000_000,     // 90 Billion USD (Top 5)
    'SUI': 6_000_000_000,      // 6 Billion USD (Top 25)
    'RVN': 58_000_000,         // 58 Million USD (< 100M Low-Cap)
    'JASMY': 85_000_000,       // 85 Million USD (< 100M Low-Cap)
    'SAFE_COIN': 45_000_000    // 45 Million USD (< 100M Low-Cap)
  }, {
    'BTC': 1,
    'SOL': 5,
    'SUI': 25,
    'RVN': 350,
    'JASMY': 220,
    'SAFE_COIN': 400
  });

  // --- TRƯỜNG HỢP 1: LOW-CAP CÓ VOLUME 24H ĐỘT BIẾN > 8% (NHƯ MÃ RVN) ---
  it('1. Low-Cap (RVN: MC $58M, Vol $5.17M ~ 8.9% > 8%) -> DỪNG GIAO DỊCH (isBlocked = true)', () => {
    setMockVolume24h('RVN', 5_170_000); // 5.17M USDT
    const res = checkTurnoverGuard('RVN');
    assert.strictEqual(res.isBlocked, true, 'RVN phải bị chặn do Turnover 8.9% > 8%');
    assert.strictEqual(res.isLowCap, true, 'RVN phải là Low-Cap (< 100M)');
    assert(res.turnoverRatioPct > 8.0, 'Tỷ lệ Turnover phải > 8%');
    assert(res.reason.includes('DỪNG GIAO DỊCH'), 'Lý do phải ghi rõ DỪNG GIAO DỊCH');
    assert.strictEqual(isTurnoverBlocked('RVN'), true);
  });

  // --- TRƯỜNG HỢP 2: LOW-CAP CÓ VOLUME 24H BÌNH THƯỜNG <= 8% ---
  it('2. Low-Cap (SAFE_COIN: MC $45M, Vol $1.8M ~ 4.0% <= 8%) -> CHO PHÉP TRADE (isBlocked = false)', () => {
    setMockVolume24h('SAFE_COIN', 1_800_000); // 1.8M USDT (4% MC)
    const res = checkTurnoverGuard('SAFE_COIN');
    assert.strictEqual(res.isBlocked, false, 'SAFE_COIN phải an toàn vì Turnover 4% <= 8%');
    assert.strictEqual(res.isLowCap, true, 'SAFE_COIN là Low-Cap');
    assert(res.turnoverRatioPct <= 8.0, 'Tỷ lệ Turnover phải <= 8%');
    assert.strictEqual(isTurnoverBlocked('SAFE_COIN'), false);
  });

  // --- TRƯỜNG HỢP 3: COIN TOP / MID-CAP (BTC, SOL, SUI) -> THANH KHOẢN AN TOÀN ---
  it('3. Top-Cap (BTC: MC $1.5T, Vol $35B ~ 2.3%) -> KHÔNG BỊ CHẶN (An toàn)', () => {
    setMockVolume24h('BTC', 35_000_000_000); // 35 Tỷ USDT
    const res = checkTurnoverGuard('BTC');
    assert.strictEqual(res.isBlocked, false, 'BTC không bao giờ bị chặn');
    assert.strictEqual(res.isLowCap, false, 'BTC không phải Low-Cap');
    assert.strictEqual(isTurnoverBlocked('BTC'), false);
  });

  it('4. Mid-Cap (SUI: MC $6B, Vol $800M ~ 13.3%) -> KHÔNG BỊ CHẶN (Vì MC > 100M, Orderbook sâu)', () => {
    setMockVolume24h('SUI', 800_000_000); // 800M USDT
    const res = checkTurnoverGuard('SUI');
    assert.strictEqual(res.isBlocked, false, 'SUI là Mid-Cap Top 25 không bị chặn bởi bộ lọc low-cap');
    assert.strictEqual(res.isLowCap, false, 'SUI không phải Low-Cap');
  });

  // --- TRƯỜNG HỢP 5: COIN NGOÀI TOP KHÔNG CÓ TRONG CACHE (UNRANKED LOW-CAP) VỚI VOL LỚN ---
  it('5. Coin Unranked ngoài Top (UNKNOWN_COIN) có Vol 24H lớn ($7M) -> Tự động nhận diện Low-Cap & Chặn', () => {
    setMockVolume24h('UNKNOWN_COIN', 7_000_000); // 7M USDT
    const res = checkTurnoverGuard('UNKNOWN_COIN');
    assert.strictEqual(res.isBlocked, true, 'Coin unranked ngoài top có volume lớn phải bị chặn');
    assert.strictEqual(res.isLowCap, true, 'Coin unranked ngoài top là Low-Cap');
  });

  // --- TRƯỜNG HỢP 6: TÍCH HỢP AI REVIEWER VETO KHI DÍNH TURNOVER GUARD ---
  it('6. AI Reviewer tự động VETO tín hiệu khi coin dính Turnover Guard (WinProb < 58%)', () => {
    setMockVolume24h('RVN', 5_170_000); // 5.17M USDT
    const sig = {
      symbol: 'RVN',
      signal: 'SHORT',
      score: 6.5,
      scoreReasons: ['RSI quá mua', 'Volume bùng nổ'],
      marketCapRank: 350,
      gridWidthPct: 3.5,
      targetLevel: 0.0185
    };
    const rawData = {
      touchCount: 1,
      btcFlashPump: false,
      btcFlashDump: false
    };

    const aiEval = evaluateSignalWithAI(sig, rawData);
    assert.strictEqual(aiEval.isApproved, false, 'AI phải VETO tín hiệu RVN do dính Turnover Guard');
    assert(aiEval.winProbability < 58.0, `WinProb phải bị ép xuống < 58% (Thực tế: ${aiEval.winProbability}%)`);
    assert(aiEval.reason.includes('TURNOVER_RISK_BLOCKED') || aiEval.keyFactors.some(k => k.includes('TURNOVER_RISK_BLOCKED')), 'Phải chứa cờ TURNOVER_RISK_BLOCKED');
  });

  console.log('='.repeat(80));
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passed}/${total} TESTS ĐẠT (${((passed / total) * 100).toFixed(0)}% PASS)`);
  console.log('='.repeat(80));
}

runTurnoverGuardTests();
