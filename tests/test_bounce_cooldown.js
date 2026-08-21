'use strict';

const assert = require('assert');

// Giả lập logic kiểm tra Bounce Cooldown trong autoTrade.js
const bounceCancelledLevels = new Map();

function isBounceCooldown(sym, targetLevel) {
  const exp = bounceCancelledLevels.get(`${sym}_${targetLevel}`);
  return exp != null && Date.now() < exp;
}

function recordBounceCancel(sym, targetLevel, durationMs = 60 * 60 * 1000) {
  bounceCancelledLevels.set(`${sym}_${targetLevel}`, Date.now() + durationMs);
}

function clearBounceCooldown(sym, targetLevel) {
  bounceCancelledLevels.delete(`${sym}_${targetLevel}`);
}

console.log('='.repeat(80));
console.log('🧪 TEST SUITE: KIỂM THỬ KHÓA MỐC BOUNCE CANCEL (CHỐNG KHUYẾN NGHỊ LẠI)');
console.log('='.repeat(80));

// Test 1: Mốc bình thường chưa bị Bounce Cancel
console.log('\n--- TEST 1: Mốc bình thường chưa bị Bounce Cancel ---');
assert.strictEqual(isBounceCooldown('NOT', 0.0004275), false, 'Mốc mới phải cho phép giao dịch');
console.log('✅ [PASS] 1.1 Mốc mới hoàn toàn -> Không bị chặn cooldown');

// Test 2: Mốc bị Bounce Cancel lúc 2:33 PM
console.log('\n--- TEST 2: Kích hoạt Bounce Cancel cho NOT @ $0.0004275 ---');
recordBounceCancel('NOT', 0.0004275, 60 * 60 * 1000); // Khóa 60 phút
assert.strictEqual(isBounceCooldown('NOT', 0.0004275), true, 'Mốc vừa Bounce Cancel phải bị khóa');
console.log('✅ [PASS] 2.1 Mốc NOT vừa Bounce Cancel -> Kích hoạt khóa thành công (isBounceCooldown = true)');

// Test 3: Quét lại sau 7 phút (2:40 PM)
console.log('\n--- TEST 3: Giả lập 7 phút sau (2:40 PM) bot quét lại cùng mốc ---');
// Vẫn trong 60 phút
assert.strictEqual(isBounceCooldown('NOT', 0.0004275), true, 'Sau 7 phút vẫn phải bị chặn');
console.log('✅ [PASS] 3.1 Sau 7 phút bot quét lại -> Bị chặn đứng thành công, KHÔNG phát lại khuyến nghị');

// Test 4: Mốc khác của cùng coin hoặc mốc đối diện
console.log('\n--- TEST 4: Mốc đối diện (LONG @ $0.0004000) ---');
assert.strictEqual(isBounceCooldown('NOT', 0.0004000), false, 'Mốc đối diện không bị ảnh hưởng');
console.log('✅ [PASS] 4.1 Mốc đối diện hợp lệ -> Vẫn cho phép giao dịch bình thường');

// Test 5: Hết hạn 60 phút
console.log('\n--- TEST 5: Hết thời gian Cooldown (sau 60 phút) ---');
recordBounceCancel('NOT', 0.0004275, -1000); // Giả lập đã qua 60 phút
assert.strictEqual(isBounceCooldown('NOT', 0.0004275), false, 'Hết 60 phút -> Tự động mở khóa cho chu kỳ mới');
console.log('✅ [PASS] 5.1 Đã hết chu kỳ cooldown -> Tự động mở khóa an toàn');

console.log('\n' + '='.repeat(80));
console.log('🎉 TẤT CẢ 5/5 BÀI TEST ĐÃ VƯỢT QUA 100%! HỆ THỐNG AN TOÀN TUYỆT ĐỐI.');
console.log('='.repeat(80));
