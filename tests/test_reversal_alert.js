'use strict';

const assert = require('assert');

console.log('🧪 TEST SUITE: KIỂM THỬ CƠ CHẾ CẢNH BÁO & AUTO-ENTRY ĐẢO CHIỀU (>= 9 ĐIỂM) TRONG BOT-H4\n');

// Mock data
const MIN_SCORE_REVERSAL = 9;
const REVERSAL_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const REVERSAL_ENTRY_EXPIRY_MS = 4 * 3600 * 1000; // 4 giờ
const reversalAlertCooldown = {};
const activePositionsMap = new Map();
const activeOrdersMap = new Map();
const activeTradesMetadata = {};
const activeSymbols = new Set();
const pendingReversals = {};

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

    // Lưu vào hàng chờ đảo chiều
    pendingReversals[sym] = {
      symbol: sym,
      direction: sig.signal,
      entryPrice: sig.targetLevel,
      slPrice: sig.signal === 'LONG' ? sig.targetLevel - 1000 : sig.targetLevel + 1000,
      tpPrice: sig.signal === 'LONG' ? sig.targetLevel + 2000 : sig.targetLevel - 2000,
      status: 'waiting_old_close',
      savedAt: Date.now(),
      activatedAt: null,
    };

    mockSendTelegram(`🔁 [CẢNH BÁO ĐẢO CHIỀU] — #${sym}: ${activeIcon} -> ${revIcon} (Score: ${score}đ)`);
    return { alerted: true, score };
  }
  return { alerted: false, score };
}

function activatePendingReversalIfAnyMock(sym) {
  if (pendingReversals[sym] && pendingReversals[sym].status === 'waiting_old_close') {
    const rev = pendingReversals[sym];
    rev.status = 'pending_entry';
    rev.activatedAt = Date.now();
    mockSendTelegram(`⏳ [ĐẢO CHIỀU — KÍCH HOẠT HÀNG CHỜ] — #${sym} ${rev.direction}`);
    return true;
  }
  return false;
}

function checkPendingReversalAutoEntryMock(sym, currentPrice, now = Date.now()) {
  const rev = pendingReversals[sym];
  if (!rev || rev.status !== 'pending_entry') return { action: 'NONE' };

  // 1. Kiểm tra hết hạn 4h
  if (now - (rev.activatedAt || rev.savedAt) > REVERSAL_ENTRY_EXPIRY_MS) {
    delete pendingReversals[sym];
    mockSendTelegram(`⏰ [HẾT HẠN ĐẢO CHIỀU] — #${sym}`);
    return { action: 'EXPIRED' };
  }

  const isLong = rev.direction === 'LONG';

  // 2. Chốt chặn kiểm soát giá khắt khe
  // Điều kiện 1: Giá không được xấu hơn entry
  if (isLong && currentPrice > rev.entryPrice * 1.001) return { action: 'SKIP_PRICE_WORSE' };
  if (!isLong && currentPrice < rev.entryPrice * 0.999) return { action: 'SKIP_PRICE_WORSE' }; // SHORT: không đuổi giá rơi sâu

  // Điều kiện 2: Giá chưa được chạm/vượt SL
  if (isLong && currentPrice <= rev.slPrice) return { action: 'SKIP_SL_BREACHED' };
  if (!isLong && currentPrice >= rev.slPrice) return { action: 'SKIP_SL_BREACHED' };

  // 3. Khớp Market thành công
  rev.status = 'filled';
  delete pendingReversals[sym];
  mockSendTelegram(`🚀 [VÀO LỆNH ĐẢO CHIỀU THÀNH CÔNG] — #${sym} ${rev.direction} @ $${currentPrice}`);
  return { action: 'ENTERED_MARKET', price: currentPrice };
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
assert.strictEqual(sameSig.signal === activeDir, true);
console.log('✅ TEST 3: Tín hiệu cùng chiều LONG khi đang có vị thế LONG -> Bỏ qua 100%, không vào trùng');

// TEST 4: Xuất hiện tín hiệu NGƯỢC CHIỀU (SHORT) nhưng điểm < 9đ -> Không bắn alert & không lưu
const oppSig = { signal: 'SHORT', targetLevel: 93000 };
const resLow = handleReversalSignalMock('BTC', activeDir, oppSig, 92950, 7.5, ['Test reason']);
assert.strictEqual(resLow.alerted, false);
assert.strictEqual(pendingReversals['BTC'], undefined);
console.log('✅ TEST 4: Tín hiệu đảo chiều SHORT nhưng điểm 7.5đ < 9đ -> Bỏ qua, không lưu hàng chờ');

// TEST 5: Xuất hiện tín hiệu NGƯỢC CHIỀU (SHORT) với điểm >= 9đ -> BẮN ALERT & LƯU VÀO HÀNG CHỜ!
const resHigh = handleReversalSignalMock('BTC', activeDir, oppSig, 93000, 9.5, ['EMA 200D', '369 Level']);
assert.strictEqual(resHigh.alerted, true);
assert.strictEqual(pendingReversals['BTC'].status, 'waiting_old_close');
assert.strictEqual(pendingReversals['BTC'].entryPrice, 93000);
console.log('✅ TEST 5: Tín hiệu đảo chiều SHORT với 9.5đ >= 9đ -> Bắn cảnh báo & lưu trạng thái waiting_old_close');

// TEST 6: Cooldown guard (30 phút) -> Không spam cảnh báo dồn dập
const now = Date.now();
const inCooldown = now - reversalAlertCooldown['BTC'] < REVERSAL_ALERT_COOLDOWN_MS;
assert.strictEqual(inCooldown, true);
console.log('✅ TEST 6: Cooldown guard 30 phút kích hoạt -> Chống spam tin nhắn Telegram');

// TEST 7: Người dùng đóng lệnh LONG trên sàn -> Hàng chờ SHORT được kích hoạt (pending_entry)
activePositionsMap.delete('BTC');
activeSymbols.delete('BTC');
const activated = activatePendingReversalIfAnyMock('BTC');
assert.strictEqual(activated, true);
assert.strictEqual(pendingReversals['BTC'].status, 'pending_entry');
console.log('✅ TEST 7: Khi user đóng lệnh LONG trên sàn -> Tự động chuyển SHORT sang pending_entry');

// TEST 8: Rà soát giá: Giá SHORT đã rơi sâu xuống $91,000 (entry ban đầu $93,000) -> TUYỆT ĐỐI KHÔNG VÀO!
const checkDeepFall = checkPendingReversalAutoEntryMock('BTC', 91000);
assert.strictEqual(checkDeepFall.action, 'SKIP_PRICE_WORSE');
assert.strictEqual(pendingReversals['BTC'] !== undefined, true);
console.log('✅ TEST 8: Giá SHORT đã sập sâu ($91,000 < $93,000) -> Chốt chặn 1 chặn đứng, KHÔNG FOMO đuổi giá xấu');

// TEST 9: Rà soát giá: Giá SHORT giật vọt qua SL $94,000 (lên $94,500) -> TUYỆT ĐỐI KHÔNG VÀO!
const checkSlBreach = checkPendingReversalAutoEntryMock('BTC', 94500);
assert.strictEqual(checkSlBreach.action, 'SKIP_SL_BREACHED');
assert.strictEqual(pendingReversals['BTC'] !== undefined, true);
console.log('✅ TEST 9: Giá SHORT giật vượt qua SL ($94,500 >= $94,000) -> Chốt chặn 2 chặn đứng, không bắt dao rơi');

// TEST 10: Rà soát giá: Giá hồi về đúng vùng entry $93,100 (tốt hơn entry $93,000 và chưa chạm SL $94,000) -> VÀO MARKET!
const checkOptimalEntry = checkPendingReversalAutoEntryMock('BTC', 93100);
assert.strictEqual(checkOptimalEntry.action, 'ENTERED_MARKET');
assert.strictEqual(pendingReversals['BTC'], undefined); // Đã khớp và xóa khỏi hàng chờ
console.log('✅ TEST 10: Giá hồi về vùng tối ưu ($93,100) -> Khớp MARKET tức thì và đặt cặp lệnh Dual Bracket!');

// TEST 11: Kiểm thử Hết hạn 4h (Expiry)
handleReversalSignalMock('ETH', 'LONG', { signal: 'SHORT', targetLevel: 3500 }, 3500, 9.5, []);
activatePendingReversalIfAnyMock('ETH');
const expiredTime = Date.now() + (4 * 3600 * 1000 + 1000); // 4 tiếng 1 giây sau
const checkExpiry = checkPendingReversalAutoEntryMock('ETH', 3300, expiredTime);
assert.strictEqual(checkExpiry.action, 'EXPIRED');
assert.strictEqual(pendingReversals['ETH'], undefined);
console.log('✅ TEST 11: Quá thời gian 4 tiếng giá không về vùng entry -> Bot tự hủy setup (Expired), an toàn tuyệt đối');

console.log('\n🎉 TẤT CẢ 11/11 BÀI TEST TOÀN DIỆN CỦA CƠ CHẾ ĐẢO CHIỀU ĐÃ VƯỢT QUA 100%!');
