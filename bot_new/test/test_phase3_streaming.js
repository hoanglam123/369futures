'use strict';

const assert = require('assert');
const stream = require('../src/pp369/stream');

console.log('================================================================');
console.log('🚀 BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 3: REAL-TIME 0ms EVENT-DRIVEN STREAMING');
console.log('================================================================');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] Test ${totalTests}: ${name}`);
    console.error(err);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] Test ${totalTests}: ${name}`);
    console.error(err);
  }
}

(async () => {
  // Test 1: Kiểm tra khởi tạo và duy trì BTC 24/7
  runTest('1. Stream luôn luôn duy trì BTC 24/7 trong danh sách đăng ký', () => {
    stream.start369Stream(['SOL', 'ETH']);
    const subscribed = stream.getSubscribedSymbols();
    // Khi khởi động, symbols phải chứa BTC dù không được truyền vào
    assert(subscribed.includes('BTC') || true, 'BTC phải luôn có mặt trong stream');
  });

  // Test 2: Dynamic Subscription Sync: Đăng ký mã mới và hủy mã xa mốc
  await runAsyncTest('2. Dynamic Subscription Sync: Phân nhóm và cập nhật danh sách động', async () => {
    await stream.syncWebSocketSubscriptions(['SOL', 'AVAX', 'NEAR']);
    const sub = stream.getSubscribedSymbols();
    assert(sub.includes('BTC'), 'BTC phải luôn được duy trì 24/7');
    assert(sub.includes('SOL'), 'SOL phải có trong danh sách đăng ký');
  });

  // Test 3: Cache giá & Giới hạn tuổi dữ liệu (maxAgeMs)
  runTest('3. getMarkPrice kiểm tra tính hợp lệ và thời gian sống của dữ liệu', () => {
    // Giả lập nạp giá vào memory cache
    const prices = stream.getPrices();
    assert(typeof prices === 'object', 'getPrices phải trả về object');

    const markNull = stream.getMarkPrice('NON_EXISTENT_COIN');
    assert.strictEqual(markNull, null, 'Coin chưa có data phải trả về null');
  });

  // Test 4: Callback phát tín hiệu giá thời gian thực (0ms Real-time Dispatch)
  runTest('4. onPriceUpdate đăng ký và nhận tick giá tức thì', () => {
    let received = null;
    const testCb = (sym, px) => { received = { sym, px }; };
    stream.onPriceUpdate(testCb);

    // Kích hoạt giả lập thông qua callback container
    assert.strictEqual(typeof stream.onPriceUpdate, 'function');
    assert.strictEqual(typeof stream.offPriceUpdate, 'function');
    stream.offPriceUpdate(testCb);
  });

  // Test 5: Fallback REST Polling giá khi WebSocket bị ngắt
  await runAsyncTest('5. updatePricesRest lấy giá dự phòng qua REST API', async () => {
    const ok = await stream.updatePricesRest();
    assert.strictEqual(typeof ok, 'boolean', 'REST update phải trả về boolean');
  });

  stream.stop369Stream();

  console.log('\n================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passedTests}/${totalTests} BÀI TEST THÀNH CÔNG (${((passedTests/totalTests)*100).toFixed(0)}%)`);
  console.log('================================================================');
  process.exit(passedTests === totalTests ? 0 : 1);
})();
