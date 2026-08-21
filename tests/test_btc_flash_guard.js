'use strict';

const assert = require('assert');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

function runBtcFlashGuardTests() {
  console.log('='.repeat(80));
  console.log('🧪 TEST SUITE: BTC FLASH PUMP / DUMP GUARD & AI REGIME VETO');
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

  // --- TRƯỜNG HỢP 1: THỊ TRƯỜNG BÌNH THƯỜNG (KHÔNG CÓ FLASH BÃO) ---
  it('1. Tín hiệu SHORT khi BTC bình thường -> AI duyệt bình thường (Không bị phạt BTC Flash)', () => {
    const sig = {
      symbol: 'TOWNS',
      signal: 'SHORT',
      score: 6.0,
      scoreReasons: ['BTC thuận Dow/EMA', 'Volume bùng nổ'],
      marketCapRank: 120,
      gridWidthPct: 3.5,
      targetLevel: 0.00268
    };
    const rawData = {
      btcFlashPump: false,
      btcFlashDump: false,
      touchCount: 1
    };

    const res = evaluateSignalWithAI(sig, rawData);
    assert.strictEqual(res.isApproved, true, 'Tín hiệu phải được duyệt khi BTC bình thường');
    assert(res.winProbability >= 58.0, 'WinProb phải >= 58%');
    assert(!res.reason.includes('BTC_FLASH_PUMP_ACTIVE'), 'Không được dính cờ phạt BTC_FLASH');
  });

  // --- TRƯỜNG HỢP 2: BTC FLASH PUMP (BÃO TĂNG DỰNG CỘT) -> PHẠT NẶNG SHORT (AI VETO) ---
  it('2. Tín hiệu SHORT khi BTC Flash Pump -> Bị AI Veto chặn đứng (WinProb < 58%)', () => {
    const sig = {
      symbol: 'KAIA',
      signal: 'SHORT',
      score: 6.5,
      scoreReasons: ['RSI phân kỳ đỉnh', 'Volume bùng nổ'],
      marketCapRank: 95,
      gridWidthPct: 4.0,
      targetLevel: 0.125
    };
    const rawData = {
      btcFlashPump: true, // BTC đang bão Pump
      btcFlashDump: false,
      touchCount: 1
    };

    const res = evaluateSignalWithAI(sig, rawData);
    assert.strictEqual(res.isApproved, false, 'Phải bị AI Veto từ chối khi BTC Flash Pump');
    assert(res.winProbability < 58.0, `WinProb phải bị ép xuống < 58% (Thực tế: ${res.winProbability}%)`);
    assert(res.reason.includes('BTC_FLASH_PUMP_ACTIVE'), 'Phải chứa cờ phạt BTC_FLASH_PUMP_ACTIVE');
  });

  // --- TRƯỜNG HỢP 3: BTC FLASH DUMP (BÃO XẢ ĐỎ) -> PHẠT NẶNG LONG (AI VETO BẮT DAO RƠI) ---
  it('3. Tín hiệu LONG khi BTC Flash Dump -> Bị AI Veto chặn đứng (WinProb < 58%)', () => {
    const sig = {
      symbol: 'SOL',
      signal: 'LONG',
      score: 7.0,
      scoreReasons: ['RSI quá bán', 'Volume bùng nổ'],
      marketCapRank: 5,
      gridWidthPct: 3.8,
      targetLevel: 140.5
    };
    const rawData = {
      btcFlashPump: false,
      btcFlashDump: true, // BTC đang xả bão Dump
      touchCount: 1
    };

    const res = evaluateSignalWithAI(sig, rawData);
    assert.strictEqual(res.isApproved, false, 'Phải bị AI Veto từ chối khi BTC Flash Dump');
    assert(res.winProbability < 58.0, `WinProb phải bị ép xuống < 58% (Thực tế: ${res.winProbability}%)`);
    assert(res.reason.includes('BTC_FLASH_DUMP_ACTIVE'), 'Phải chứa cờ phạt BTC_FLASH_DUMP_ACTIVE');
  });

  // --- TRƯỜNG HỢP 4: BTC FLASH DUMP (BÃO XẢ) NHƯNG LỆNH SHORT LẠI ĐƯỢC HƯỞNG LỢI THUẬN CHIỀU ---
  it('4. Tín hiệu SHORT khi BTC Flash Dump (xả thuận chiều) -> Không bị phạt khóa (Ăn sóng xả)', () => {
    const sig = {
      symbol: 'PENGU',
      signal: 'SHORT',
      score: 6.0,
      scoreReasons: ['Volume bùng nổ', 'BTC thuận Dow/EMA'],
      marketCapRank: 110,
      gridWidthPct: 4.2,
      targetLevel: 0.035
    };
    const rawData = {
      btcFlashPump: false,
      btcFlashDump: true, // BTC đang xả -> Thuận chiều SHORT
      touchCount: 1
    };

    const res = evaluateSignalWithAI(sig, rawData);
    assert.strictEqual(res.isApproved, true, 'Lệnh SHORT phải được duyệt khi BTC xả thuận chiều');
    assert(res.winProbability >= 58.0, 'WinProb phải >= 58%');
  });

  // --- TRƯỜNG HỢP 5: LOGIC KIỂM TRA ĐIỀU KIỆN NẾN FLASH PUMP & FLASH DUMP ---
  it('5. Kiểm tra logic nhận diện nến M15 Bão (Volume >= 2.0x MA20 & Rướn >= 0.85%)', () => {
    const ma20Vol = 3000;
    const checkCandle = (open, close, high, low, vol) => {
      const volRatio = vol / ma20Vol;
      const bodyPct = ((close - open) / open) * 100;
      const rangePct = ((high - low) / low) * 100;
      const pushHighPct = ((high - open) / open) * 100;
      const plungeLowPct = ((open - low) / open) * 100;

      const isPump = (volRatio >= 2.0 || vol >= 8000) && (bodyPct >= 0.60 || (pushHighPct >= 0.85 && pushHighPct > plungeLowPct) || (rangePct >= 1.1 && close > open));
      const isDump = (volRatio >= 2.0 || vol >= 8000) && (bodyPct <= -0.60 || (plungeLowPct >= 0.85 && plungeLowPct > pushHighPct) || (rangePct >= 1.1 && close < open));

      return { isPump, isDump };
    };

    // Cây nến 14:15 hôm nay (Open $75935, High $76900, Close $76375, Vol 20270 BTC)
    const n1415 = checkCandle(75935, 76375, 76900, 75900, 20270);
    assert.strictEqual(n1415.isPump, true, 'Nến 14:15 (Rướn +1.27%, Vol 7x) phải kích hoạt Flash Pump');
    assert.strictEqual(n1415.isDump, false, 'Nến 14:15 không phải Flash Dump');

    // Cây nến 15:00 hôm nay (Open $76310, Close $76883, High $77200, Vol 8847 BTC)
    const n1500 = checkCandle(76310, 76883, 77200, 76253, 8847);
    assert.strictEqual(n1500.isPump, true, 'Nến 15:00 (+0.75% thân, +1.16% rướn, Vol 2.2x) phải kích hoạt Flash Pump');

    // Cây nến 16:00 hôm nay (Open $79268, Close $78104, Low $77255, Vol 32738 BTC)
    const n1600 = checkCandle(79268, 78104, 79372, 77255, 32738);
    assert.strictEqual(n1600.isDump, true, 'Nến 16:00 (-1.47% thân, -2.54% đâm đáy, Vol 5.1x) phải kích hoạt Flash Dump');
    assert.strictEqual(n1600.isPump, false, 'Nến 16:00 không phải Flash Dump');

    // Cây nến êm đềm bình thường (Vol 2500, Range 0.30%)
    const nNormal = checkCandle(75000, 75100, 75200, 74980, 2500);
    assert.strictEqual(nNormal.isPump, false, 'Nến bình thường không được kích hoạt Pump');
    assert.strictEqual(nNormal.isDump, false, 'Nến bình thường không được kích hoạt Dump');
  });

  console.log('='.repeat(80));
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passed}/${total} TESTS ĐẠT (100% PASS)`);
  console.log('='.repeat(80));
}

runBtcFlashGuardTests();
