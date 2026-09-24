'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), 'data', 'directional_circuit_breaker.json');

// Backup existing state file if any
let backup = null;
if (fs.existsSync(STATE_FILE)) {
  backup = fs.readFileSync(STATE_FILE, 'utf8');
}

try {
  // Clear state file for test
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    LONG: { losses: [], lockedUntil: 0, lockReason: '', shadowTrades: [] },
    SHORT: { losses: [], lockedUntil: 0, lockReason: '', shadowTrades: [] }
  }), 'utf8');

  // Load module fresh
  delete require.cache[require.resolve('../src/trader/directionalCircuitBreaker')];
  const {
    recordDirectionalTradeExit,
    recordDirectionalShadowOutcome,
    isDirectionLocked,
    clearDirectionLock,
    SHADOW_EVAL_COUNT
  } = require('../src/trader/directionalCircuitBreaker');

  console.log('🧪 Testing Directional Circuit Breaker 5-Shadow-Trade Recovery Logic...');

  // Test 1: Record 3 losses -> Triggers lock
  recordDirectionalTradeExit({ symbol: 'COIN1', side: 'LONG', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN2', side: 'LONG', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN3', side: 'LONG', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });

  const status1 = isDirectionLocked('LONG');
  assert.strictEqual(status1.isLocked, true, 'Chiều LONG phải bị khóa sau 3 lệnh thua liên tiếp');
  console.log('✅ PASS: Khóa chiều LONG thành công sau 3 lệnh SL');

  // Test 2: Shadow trades 1 to 4 should NOT unlock yet (needs 5 trades)
  recordDirectionalShadowOutcome({ symbol: 'SHAD1', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 0.60, roi: 20 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Chưa đủ 5 lệnh không được mở');

  recordDirectionalShadowOutcome({ symbol: 'SHAD2', signal: 'LONG', outcome: 'SAVED_BE', pnlUsd: 0.0, roi: 0 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Chưa đủ 5 lệnh không được mở');

  recordDirectionalShadowOutcome({ symbol: 'SHAD3', signal: 'LONG', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Chưa đủ 5 lệnh không được mở (dù có lệnh SL, không reset về 0)');

  recordDirectionalShadowOutcome({ symbol: 'SHAD4', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 0.70, roi: 23 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Chưa đủ 5 lệnh không được mở');
  console.log('✅ PASS: 4 lệnh shadow (bao gồm cả lệnh lỗ) không bị reset về 0 và chưa mở khóa');

  // Test 3: 5th shadow trade makes total PnL = +1.20 USD -> Stable -> UNLOCKS!
  const unlocked = recordDirectionalShadowOutcome({ symbol: 'SHAD5', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 0.50, roi: 17 });
  assert.strictEqual(unlocked, true, '5 lệnh có tổng PnL dương (+1.20 USD) phải mở khóa');
  assert.strictEqual(isDirectionLocked('LONG').isLocked, false, 'Chiều LONG phải được giải phóng khóa thành công');
  console.log('✅ PASS: Đủ 5 lệnh shadow với PnL dương ổn định -> Tự động mở khóa sớm thành công!');

  // Test 4: Negative scenario on SHORT
  recordDirectionalTradeExit({ symbol: 'COIN4', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN5', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN6', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  assert.strictEqual(isDirectionLocked('SHORT').isLocked, true);

  // 5 shadow trades with bad market: 4 SLs, 1 TP -> Total PnL = -1.80 USD
  recordDirectionalShadowOutcome({ symbol: 'S1', signal: 'SHORT', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });
  recordDirectionalShadowOutcome({ symbol: 'S2', signal: 'SHORT', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });
  recordDirectionalShadowOutcome({ symbol: 'S3', signal: 'SHORT', outcome: 'MISSED_TP', pnlUsd: 0.60, roi: 20 });
  recordDirectionalShadowOutcome({ symbol: 'S4', signal: 'SHORT', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });
  const stillLocked = recordDirectionalShadowOutcome({ symbol: 'S5', signal: 'SHORT', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });

  assert.strictEqual(stillLocked, false, 'Tổng PnL âm nặng không được mở khóa');
  assert.strictEqual(isDirectionLocked('SHORT').isLocked, true, 'SHORT vẫn phải tiếp tục bị khóa');
  console.log('✅ PASS: 5 lệnh shadow tiếp tục thua lỗ -> Khóa vẫn được duy trì bảo vệ tài khoản');

  // Test 5: Ignored outcomes like BOUNCE_CANCEL or LIMIT_TIMEOUT
  const ignored = recordDirectionalShadowOutcome({ symbol: 'S6', signal: 'SHORT', outcome: 'BOUNCE_CANCEL' });
  assert.strictEqual(ignored, false, 'Lệnh hủy limit không được tính vào đánh giá');
  console.log('✅ PASS: BOUNCE_CANCEL được bỏ qua chuẩn xác');

  // Test 6: Smart Dynamic Extension when 1.5h expires but shadow trades are negative
  // Manually fast-forward lockedUntil to simulate 1.5h has expired
  const stateRaw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  stateRaw.SHORT.lockedUntil = Date.now() - 1000; // Expired!
  fs.writeFileSync(STATE_FILE, JSON.stringify(stateRaw), 'utf8');

  // Reload cache to sync with simulated file
  delete require.cache[require.resolve('../src/trader/directionalCircuitBreaker')];
  const { isDirectionLocked: isLockedAfterExpiry, clearDirectionLock: clearLock2 } = require('../src/trader/directionalCircuitBreaker');

  const expiryStatus = isLockedAfterExpiry('SHORT');
  assert.strictEqual(expiryStatus.isLocked, true, 'Hết 1.5h nhưng shadow đang lỗ -> Phải tự động gia hạn thêm!');
  assert.ok(expiryStatus.remainingMinutes > 30, 'Phải gia hạn thêm ~45 phút');
  console.log('✅ PASS: Hết 1.5h nhưng shadow đang lỗ -> Tự động gia hạn thêm 45 phút thành công!');

  // Test 7: Normal unlock when expired and shadow trades are safe / positive
  clearLock2('SHORT');
  recordDirectionalTradeExit({ symbol: 'COIN8', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN9', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN10', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });

  // Add 1 positive shadow trade (+0.80 USD)
  const { recordDirectionalShadowOutcome: recShad } = require('../src/trader/directionalCircuitBreaker');
  recShad({ symbol: 'OK1', signal: 'SHORT', outcome: 'MISSED_TP', pnlUsd: 0.80, roi: 25 });

  // Fast forward to expiry
  const stateRaw2 = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  stateRaw2.SHORT.lockedUntil = Date.now() - 1000;
  fs.writeFileSync(STATE_FILE, JSON.stringify(stateRaw2), 'utf8');

  delete require.cache[require.resolve('../src/trader/directionalCircuitBreaker')];
  const { isDirectionLocked: isLockedAfterSafeExpiry } = require('../src/trader/directionalCircuitBreaker');
  const safeExpiryStatus = isLockedAfterSafeExpiry('SHORT');
  assert.strictEqual(safeExpiryStatus.isLocked, false, 'Hết 1.5h và shadow an toàn -> Mở khóa bình thường');
  console.log('✅ PASS: Hết 1.5h và shadow an toàn (+0.80 USD) -> Tự động mở khóa thành công!');

  console.log('\n🎉 ALL DIRECTIONAL CIRCUIT BREAKER TESTS PASSED!');
} finally {
  // Restore original state file
  if (backup !== null) {
    fs.writeFileSync(STATE_FILE, backup, 'utf8');
  } else if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
}
