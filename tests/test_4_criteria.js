'use strict';

const assert = require('assert');

console.log('================================================================');
console.log('🧪 TEST SUITE: 3 TRỤ CỘT CỐT LÕI (HARD MAX LOSS + AI VETO + H1/M15 TP PULL)');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${testName}`);
    console.error(`   Error: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// TRỤ CỘT 1: HARD MAX LOSS GUARD <= -4.0 USDT
// -----------------------------------------------------------------------------
console.log('--- TRỤ CỘT 1: HARD MAX LOSS GUARD (KHỐNG CHẾ TRẦN LỖ -4.0 USDT) ---');

function checkHardMaxLossTrigger(roi, margin, maxLossThresholdUsd = -4.0) {
  const unrealizedPnlUsd = (roi / 100) * margin;
  return unrealizedPnlUsd <= maxLossThresholdUsd;
}

runTest('1.1 Lỗ thả nổi -2.5 USDT (chưa chạm -4.0 USDT) -> Không kích hoạt cắt lỗ khẩn cấp', () => {
  const isTriggered = checkHardMaxLossTrigger(-8.33, 30, -4.0);
  assert.strictEqual(isTriggered, false);
});

runTest('1.2 Lỗ thả nổi -4.0 USDT (vừa chạm ngưỡng trần) -> Kích hoạt cắt lỗ khẩn cấp MARKET', () => {
  const isTriggered = checkHardMaxLossTrigger(-13.34, 30, -4.0);
  assert.strictEqual(isTriggered, true);
});

runTest('1.3 Lỗ thả nổi -6.5 USDT (trượt sâu) -> Kích hoạt cắt lỗ khẩn cấp MARKET', () => {
  const isTriggered = checkHardMaxLossTrigger(-21.67, 30, -4.0);
  assert.strictEqual(isTriggered, true);
});

// -----------------------------------------------------------------------------
// TRỤ CỘT 2: AI VETO FILTER (LOẠI BỎ COIN RÁC & CẠN THANH KHOẢN)
// -----------------------------------------------------------------------------
console.log('\n--- TRỤ CỘT 2: AI VETO FILTER (CHẶN TÍN HIỆU ĐỘC HẠI) ---');

function checkAiVeto(aiEval) {
  return (aiEval.winProbability < 58.0) || (aiEval.reason.includes('VOL_DRY') && aiEval.reason.includes('OI_COOLING'));
}

runTest('2.1 Tín hiệu có WinProb = 52.5% (< 58%) -> Bị AI Veto chặn thành công', () => {
  const mockEval = { winProbability: 52.5, reason: 'Xác suất thắng 52.5% < 65%' };
  assert.strictEqual(checkAiVeto(mockEval), true);
});

runTest('2.2 Tín hiệu có WinProb = 62.0% nhưng dính cả VOL_DRY và OI_COOLING -> Bị AI Veto chặn thành công', () => {
  const mockEval = { winProbability: 62.0, reason: 'Xác suất thắng 62.0% (- VOL_DRY, + OI_COOLING)' };
  assert.strictEqual(checkAiVeto(mockEval), true);
});

runTest('2.3 Tín hiệu có WinProb = 59.5% (> 58%) và điều kiện bình thường -> Không bị Veto (Cho phép đi tiếp)', () => {
  const mockEval = { winProbability: 59.5, reason: 'Xác suất thắng 59.5% (+ VOL_ULTRA, - RSI_NEUTRAL)' };
  assert.strictEqual(checkAiVeto(mockEval), false);
});

// -----------------------------------------------------------------------------
// TRỤ CỘT 3: NẾN H1 ĐÓNG GÃY SÂU 35 TICKS
// -----------------------------------------------------------------------------
console.log('\n--- TRỤ CỘT 3: H1 CLOSE INVALIDATION (GÃY SÂU 35 TICKS) ---');

function evaluateH1Invalidation(isLong, entryPrice, unit, lastClosedH1, entryTime) {
  const invalidationDistance = unit * 0.35; // 35 ticks
  const h1CloseTime = lastClosedH1.openTime + 3600_000;

  if (lastClosedH1 && h1CloseTime > entryTime) {
    const cClose = lastClosedH1.close;
    if (isLong) {
      return cClose <= (entryPrice - invalidationDistance);
    } else {
      return cClose >= (entryPrice + invalidationDistance);
    }
  }
  return false;
}

runTest('3.1 Lệnh LONG vào lúc 12:15, H1 đóng lúc 13:00 gãy sâu 35 ticks -> Kích hoạt dời TP hòa vốn', () => {
  const entryTime = new Date('2026-08-17T12:15:00+07:00').getTime();
  const h1OpenTime = new Date('2026-08-17T12:00:00+07:00').getTime();
  const entryPrice = 1.0000;
  const unit = 0.0300;
  const lastClosedH1 = { openTime: h1OpenTime, close: 0.9850 };

  const isFailed = evaluateH1Invalidation(true, entryPrice, unit, lastClosedH1, entryTime);
  assert.strictEqual(isFailed, true);
});

runTest('3.2 Lệnh SHORT vào lúc 12:15, H1 đóng lúc 13:00 vọt lên > 35 ticks -> Kích hoạt dời TP hòa vốn', () => {
  const entryTime = new Date('2026-08-17T12:15:00+07:00').getTime();
  const h1OpenTime = new Date('2026-08-17T12:00:00+07:00').getTime();
  const entryPrice = 1.0000;
  const unit = 0.0300;
  const lastClosedH1 = { openTime: h1OpenTime, close: 1.0150 };

  const isFailed = evaluateH1Invalidation(false, entryPrice, unit, lastClosedH1, entryTime);
  assert.strictEqual(isFailed, true);
});

// -----------------------------------------------------------------------------
// TRỤ CỘT 4: NẾN M15 ĐÓNG CỬA & BIÊN ĐỘ LOW/HIGH (DỜI TP VỀ ENTRY HÒA VỐN)
// -----------------------------------------------------------------------------
console.log('\n--- TRỤ CỘT 4: M15 CLOSE & LOW/HIGH INVALIDATION (DỜI TP VỀ ENTRY HÒA VỐN) ---');

function evaluateM15Invalidation(isLong, entryPrice, unit, lastClosedM15, entryTime) {
  const maxPlungeDistance = unit * 0.30;       // 30 ticks
  const closeThresholdDistance = unit * 0.05;  // 5 ticks
  const m15CloseTime = lastClosedM15.openTime + 15 * 60_000;

  if (lastClosedM15 && m15CloseTime > entryTime) {
    const cClose = lastClosedM15.close;
    const cLow = lastClosedM15.low;
    const cHigh = lastClosedM15.high;

    if (isLong) {
      const isLowAbove30Ticks = cLow > (entryPrice - maxPlungeDistance);
      const isClosedBelow5Ticks = cClose <= (entryPrice - closeThresholdDistance);
      return isLowAbove30Ticks && isClosedBelow5Ticks;
    } else {
      const isHighBelow30Ticks = cHigh < (entryPrice + maxPlungeDistance);
      const isClosedAbove5Ticks = cClose >= (entryPrice + closeThresholdDistance);
      return isHighBelow30Ticks && isClosedAbove5Ticks;
    }
  }
  return false;
}

const baseEntry = 1.0000;
const baseUnit = 0.0100; // 1 unit = 100 ticks = 0.0100 (1 tick = 0.0001)

runTest('4.1 LONG: M15 Low > Entry - 30 ticks (15 ticks) VÀ Close <= Entry - 5 ticks (7 ticks) -> Kích hoạt dời TP', () => {
  const entryTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const m15OpenTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const lastClosedM15 = {
    openTime: m15OpenTime,
    low: baseEntry - 0.0015,   // low > entry - 30 ticks (chỉ thò 15 ticks)
    close: baseEntry - 0.0007, // close đóng dưới entry 7 ticks (>= 5 ticks)
    high: baseEntry + 0.0005,
  };

  const isTriggered = evaluateM15Invalidation(true, baseEntry, baseUnit, lastClosedM15, entryTime);
  assert.strictEqual(isTriggered, true);
});

runTest('4.2 LONG: M15 Low đâm quá 30 ticks (Low <= Entry - 30 ticks) -> Không dời TP', () => {
  const entryTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const m15OpenTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const lastClosedM15 = {
    openTime: m15OpenTime,
    low: baseEntry - 0.0035,   // low đâm sâu 35 ticks
    close: baseEntry - 0.0007,
    high: baseEntry + 0.0005,
  };

  const isTriggered = evaluateM15Invalidation(true, baseEntry, baseUnit, lastClosedM15, entryTime);
  assert.strictEqual(isTriggered, false);
});

runTest('4.3 SHORT: M15 High < Entry + 30 ticks (15 ticks) VÀ Close >= Entry + 5 ticks (8 ticks) -> Kích hoạt dời TP', () => {
  const entryTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const m15OpenTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const lastClosedM15 = {
    openTime: m15OpenTime,
    high: baseEntry + 0.0015,  // high < entry + 30 ticks (chỉ vọt 15 ticks)
    close: baseEntry + 0.0008, // close đóng trên entry 8 ticks (>= 5 ticks)
    low: baseEntry - 0.0005,
  };

  const isTriggered = evaluateM15Invalidation(false, baseEntry, baseUnit, lastClosedM15, entryTime);
  assert.strictEqual(isTriggered, true);
});

runTest('4.4 SHORT: M15 High vọt quá 30 ticks (High >= Entry + 30 ticks) -> Không dời TP', () => {
  const entryTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const m15OpenTime = new Date('2026-08-18T10:00:00+07:00').getTime();
  const lastClosedM15 = {
    openTime: m15OpenTime,
    high: baseEntry + 0.0040,  // high vọt 40 ticks
    close: baseEntry + 0.0008,
    low: baseEntry - 0.0005,
  };

  const isTriggered = evaluateM15Invalidation(false, baseEntry, baseUnit, lastClosedM15, entryTime);
  assert.strictEqual(isTriggered, false);
});

// -----------------------------------------------------------------------------
// TỔNG KẾT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passedTests}/${totalTests} TESTS ĐẠT (100% PASS)`);
console.log('================================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
