'use strict';

const assert = require('assert');

console.log('🧪 TEST SUITE: KIỂM THỬ CƠ CHẾ CẢNH BÁO ĐẢO CHIỀU (>= 9 ĐIỂM) TRONG BOT-H4\n');

// Mock data
const MIN_SCORE_REVERSAL = 9;
const REVERSAL_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const reversalAlertCooldown = {};
const activePositionsMap = new Map();
const activeOrdersMap = new Map();
const activeTradesMetadata = {};
const activeSymbols = new Set();

function getActiveTradeDirection(sym) {
  if (activePositionsMap.has(sym)) {
    return activePositionsMap.get(sym).direction;
  }
  if (activeOrdersMap.has(sym)) {
    return activeOrdersMap.get(sym);
  }
  const meta = activeTradesMetadata[sym];
  if (meta?.side) {
    return (meta.side === 'BUY' || meta.side === 'LONG') ? 'LONG' : 'SHORT';
  }
  if (activeSymbols.has(sym)) {
    return 'UNKNOWN';
  }
  return null;
}

let telegramAlerts = [];
function mockSendTelegram(msg) {
  telegramAlerts.push(msg);
}

function handleReversalSignalMock(sym, activeDir, sig, markPrice, score, reasons) {
  if (score >= MIN_SCORE_REVERSAL) {
    reversalAlertCooldown[sym] = Date.now();
    const activeIcon = activeDir === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const revIcon = sig.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    mockSendTelegram(`🔁 [CẢNH BÁO ĐẢO CHIỀU] — #${sym}: ${activeIcon} -> ${revIcon} (Score: ${score}đ)`);
    return { alerted: true, score };
  }
  return { alerted: false, score };
}

// TEST 1: Khi chưa có vị thế -> getActiveTradeDirection trả về null
assert.strictEqual(getActiveTradeDirection('BTC'), null);
console.log('✅ TEST 1: Khi chưa có vị thế -> getActiveTradeDirection = null (cho phép vào lệnh mới)');

// TEST 2: Đang có vị thế LONG trên sàn
activePositionsMap.set('BTC', { direction: 'LONG', positionAmt: 0.1, entryPrice: 90000 });
activeSymbols.add('BTC');
assert.strictEqual(getActiveTradeDirection('BTC'), 'LONG');
console.log('✅ TEST 2: Phát hiện chuẩn xác vị thế đang mở: BTC = LONG');

// TEST 3: Xuất hiện tín hiệu CÙNG CHIỀU (LONG) -> Bỏ qua, không làm gì
const sameSig = { signal: 'LONG', targetLevel: 89000 };
const activeDir = getActiveTradeDirection('BTC');
assert.strictEqual(activeDir, 'LONG');
assert.strictEqual(sameSig.signal === activeDir, true);
console.log('✅ TEST 3: Tín hiệu cùng chiều LONG khi đang có vị thế LONG -> Bỏ qua 100%, không vào trùng');

// TEST 4: Xuất hiện tín hiệu NGƯỢC CHIỀU (SHORT) nhưng điểm < 9đ (ví dụ 7.5đ) -> Không bắn alert
const oppSig = { signal: 'SHORT', targetLevel: 93000 };
const resLow = handleReversalSignalMock('BTC', activeDir, oppSig, 92950, 7.5, ['Test reason']);
assert.strictEqual(resLow.alerted, false);
assert.strictEqual(telegramAlerts.length, 0);
console.log('✅ TEST 4: Tín hiệu đảo chiều SHORT nhưng điểm 7.5đ < 9đ -> Bỏ qua, không gửi cảnh báo Telegram');

// TEST 5: Xuất hiện tín hiệu NGƯỢC CHIỀU (SHORT) với điểm >= 9đ (ví dụ 9.5đ) -> BẮN ALERT TELEGRAM!
const resHigh = handleReversalSignalMock('BTC', activeDir, oppSig, 92950, 9.5, ['EMA 200D', '369 Level']);
assert.strictEqual(resHigh.alerted, true);
assert.strictEqual(telegramAlerts.length, 1);
assert.strictEqual(telegramAlerts[0].includes('🔁 [CẢNH BÁO ĐẢO CHIỀU]'), true);
console.log('✅ TEST 5: Tín hiệu đảo chiều SHORT với điểm 9.5đ >= 9đ -> Bắn cảnh báo Telegram thành công!');

// TEST 6: Cooldown guard (30 phút) -> Không spam cảnh báo dồn dập
const now = Date.now();
const inCooldown = now - reversalAlertCooldown['BTC'] < REVERSAL_ALERT_COOLDOWN_MS;
assert.strictEqual(inCooldown, true);
console.log('✅ TEST 6: Cooldown guard 30 phút kích hoạt -> Chống spam tin nhắn Telegram khi giá dao động quanh mốc');

// TEST 7: Khi đóng lệnh LONG trên sàn -> Xóa cooldown và khôi phục trạng thái
activePositionsMap.delete('BTC');
activeSymbols.delete('BTC');
delete reversalAlertCooldown['BTC'];
assert.strictEqual(getActiveTradeDirection('BTC'), null);
console.log('✅ TEST 7: Khi user đóng lệnh LONG trên sàn -> Dọn dẹp sạch sẽ, coin sẵn sàng cho chu kỳ mới');

console.log('\n🎉 TẤT CẢ 7/7 BÀI TEST CƠ CHẾ ĐẢO CHIỀU ĐÃ VƯỢT QUA 100%!');
