'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Override minimum lock time for fast unit testing
process.env.DIRECTIONAL_MIN_LOCK_MS = '0';

const STATE_FILE = path.join(process.cwd(), 'data', 'directional_circuit_breaker.json');

// Backup existing state file if any
let backup = null;
if (fs.existsSync(STATE_FILE)) {
  backup = fs.readFileSync(STATE_FILE, 'utf8');
}

try {
  // Clear state file for test
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    LONG: { losses: [], lockedUntil: 0, lockedAt: 0, lockReason: '', shadowTrades: [] },
    SHORT: { losses: [], lockedUntil: 0, lockedAt: 0, lockReason: '', shadowTrades: [] }
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

  // Test 2: Reject REAL trades (REAL_PROFIT / REAL_TP)
  const rejectedReal = recordDirectionalShadowOutcome({ symbol: 'BEAMX', signal: 'LONG', outcome: 'REAL_PROFIT', pnlUsd: 1.20, roi: 30 });
  assert.strictEqual(rejectedReal, false, 'Lệnh thật trên sàn (REAL_PROFIT) phải bị từ chối');
  console.log('✅ PASS: Lệnh thật trên sàn (REAL_PROFIT) bị từ chối, không tính vào Shadow recovery');

  // Test 3: Anti-duplication (Sending same symbol 5 times must NOT unlock)
  for (let k = 0; k < 5; k++) {
    const dupRes = recordDirectionalShadowOutcome({ symbol: 'SAME_COIN', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 1.0, roi: 30 });
    assert.strictEqual(dupRes, false, 'Coin trùng lặp không được tính là 5 coin khác nhau');
  }
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Vẫn phải bị khóa vì mới chỉ có 1 coin duy nhất');
  console.log('✅ PASS: Chống trùng lặp Symbol hoạt động chuẩn xác (1 coin gửi 5 lần không bị mở khóa)');

  // Test 4: Direction isolation (SHORT shadow while LONG is locked must NOT affect LONG)
  recordDirectionalShadowOutcome({ symbol: 'SHORT_COIN', signal: 'SHORT', outcome: 'MISSED_TP', pnlUsd: 1.0, roi: 30 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Lệnh Shadow chiều SHORT không được tính vào chiều LONG');
  console.log('✅ PASS: Tách biệt chiều chuẩn xác (Lệnh SHORT không ảnh hưởng đến khóa chiều LONG)');

  // Test 5: Shadow trades 2 to 4 of different coins
  recordDirectionalShadowOutcome({ symbol: 'SHAD2', signal: 'LONG', outcome: 'SAVED_BE', pnlUsd: 0.0, roi: 0 });
  recordDirectionalShadowOutcome({ symbol: 'SHAD3', signal: 'LONG', outcome: 'SAVED_SL', pnlUsd: -0.60, roi: -20 });
  recordDirectionalShadowOutcome({ symbol: 'SHAD4', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 0.70, roi: 23 });
  assert.strictEqual(isDirectionLocked('LONG').isLocked, true, 'Mới có 4 coin khác nhau (SAME_COIN, SHAD2, SHAD3, SHAD4), chưa đủ 5 coin');
  console.log('✅ PASS: 4 coin shadow khác nhau chưa mở khóa');

  // Test 6: 5th distinct coin shadow trade makes total PnL positive -> UNLOCKS!
  const unlocked = recordDirectionalShadowOutcome({ symbol: 'SHAD5', signal: 'LONG', outcome: 'MISSED_TP', pnlUsd: 0.50, roi: 17 });
  assert.strictEqual(unlocked, true, '5 coin khác nhau có tổng PnL dương (+1.60 USD) phải mở khóa');
  assert.strictEqual(isDirectionLocked('LONG').isLocked, false, 'Chiều LONG phải được giải phóng khóa thành công');
  console.log('✅ PASS: Đủ 5 coin shadow khác nhau cùng chiều với PnL dương ổn định -> Tự động mở khóa sớm thành công!');

  // Test 7: Negative scenario on SHORT
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
  console.log('✅ PASS: 5 coin shadow tiếp tục thua lỗ -> Khóa vẫn được duy trì bảo vệ tài khoản');

  // Test 8: Ignored outcomes like BOUNCE_CANCEL or LIMIT_TIMEOUT
  const ignored = recordDirectionalShadowOutcome({ symbol: 'S6', signal: 'SHORT', outcome: 'BOUNCE_CANCEL' });
  assert.strictEqual(ignored, false, 'Lệnh hủy limit không được tính vào đánh giá');
  console.log('✅ PASS: BOUNCE_CANCEL được bỏ qua chuẩn xác');

  // Test 9: Smart Dynamic Extension when 1.5h expires but shadow trades are negative
  const stateRaw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  stateRaw.SHORT.lockedUntil = Date.now() - 1000; // Expired!
  fs.writeFileSync(STATE_FILE, JSON.stringify(stateRaw), 'utf8');

  delete require.cache[require.resolve('../src/trader/directionalCircuitBreaker')];
  const { isDirectionLocked: isLockedAfterExpiry, clearDirectionLock: clearLock2 } = require('../src/trader/directionalCircuitBreaker');

  const expiryStatus = isLockedAfterExpiry('SHORT');
  assert.strictEqual(expiryStatus.isLocked, true, 'Hết 1.5h nhưng shadow đang lỗ -> Phải tự động gia hạn thêm!');
  assert.ok(expiryStatus.remainingMinutes > 30, 'Phải gia hạn thêm ~45 phút');
  console.log('✅ PASS: Hết 1.5h nhưng shadow đang lỗ -> Tự động gia hạn thêm 45 phút thành công!');

  // Test 10: Normal unlock when expired and shadow trades are safe / positive
  clearLock2('SHORT');
  recordDirectionalTradeExit({ symbol: 'COIN8', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN9', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });
  recordDirectionalTradeExit({ symbol: 'COIN10', side: 'SHORT', isWin: false, exitType: 'SL', pnlUsd: -1.5, pnlPercent: -20 });

  const { recordDirectionalShadowOutcome: recShad } = require('../src/trader/directionalCircuitBreaker');
  recShad({ symbol: 'OK1', signal: 'SHORT', outcome: 'MISSED_TP', pnlUsd: 0.80, roi: 25 });

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
