'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const {
  registerShadowTrade,
  updateShadowPrices,
  getActiveShadowPositions,
  getShadowStats,
  clearActiveShadowsForTest
} = require('../src/services/shadowTracker');

const { createServer } = require('../src/dashboard/server');

console.log('================================================================');
console.log('🚀 BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 5: SHADOW PNL TRACKER & REAL-TIME DASHBOARD');
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
  // ── 1. SHADOW PNL TRACKER: ĐĂNG KÝ VÀ THEO DÕI VỊ THẾ ẢO ───────────────────
  runTest('1. ShadowTracker: Đăng ký lệnh bị VETO vào danh sách Active Shadow', () => {
    clearActiveShadowsForTest();
    const vetoedSetup = {
      symbol: 'BTC',
      direction: 'LONG',
      entryPrice: 90000,
      slPrice: 88000,
      tpPrice: 94000,
      total: 8.5
    };

    const shadow = registerShadowTrade(vetoedSetup, 'VETO_GATEKEEPER_TEST');
    assert(shadow, 'Phải tạo thành công Shadow trade');
    assert.strictEqual(shadow.symbol, 'BTC');
    assert.strictEqual(shadow.status, 'ACTIVE');

    const actives = getActiveShadowPositions();
    assert(actives[shadow.id], 'Vị thế ảo phải có mặt trong danh sách active');
  });

  runTest('2. ShadowTracker: Giá chạm SL ảo -> Ghi nhận SAVED_SL (AI cứu thua $3.00 USD)', () => {
    const vetoedSol = {
      symbol: 'SOL_TEST',
      direction: 'LONG',
      entryPrice: 190.0,
      slPrice: 186.0,
      tpPrice: 200.0,
      total: 7.5
    };

    const shadow = registerShadowTrade(vetoedSol, 'VETO_RR_TOO_LOW');
    assert(shadow, 'Tạo shadow trade cho SOL_TEST');

    // Giả lập giá rơi xuống 185.0 (dưới SL 186.0)
    const resolved = updateShadowPrices({ SOL_TEST: 185.0 });
    assert(resolved.length > 0, 'Phải có vị thế ảo được chốt kết quả');
    const closed = resolved.find(r => r.symbol === 'SOL_TEST');
    assert(closed, 'SOL_TEST phải được đóng');
    assert.strictEqual(closed.status, 'SAVED_SL', 'Trạng thái phải là SAVED_SL');
  });

  runTest('3. ShadowTracker: Giá chạm TP ảo -> Ghi nhận MISSED_TP (AI bỏ lỡ cơ hội)', () => {
    const vetoedNear = {
      symbol: 'NEAR_TEST',
      direction: 'LONG',
      entryPrice: 5.0,
      slPrice: 4.8,
      tpPrice: 5.5,
      total: 8.0
    };

    const shadow = registerShadowTrade(vetoedNear, 'VETO_GATEKEEPER_PINBAR');
    assert(shadow, 'Tạo shadow trade cho NEAR_TEST');

    // Giả lập giá tăng vọt lên 5.6 (vượt TP 5.5)
    const resolved = updateShadowPrices({ NEAR_TEST: 5.6 });
    const closed = resolved.find(r => r.symbol === 'NEAR_TEST');
    assert(closed, 'NEAR_TEST phải được đóng');
    assert.strictEqual(closed.status, 'MISSED_TP', 'Trạng thái phải là MISSED_TP');
  });

  runTest('4. ShadowTracker: getShadowStats thống kê tỷ lệ Veto chính xác và Net USD', () => {
    const stats = getShadowStats();
    assert(typeof stats.vetoAccuracyPct === 'number', 'Tỷ lệ accuracy phải là số');
    assert(typeof stats.netSavedUsd === 'number', 'Net USD phải là số');
    assert(typeof stats.totalSavedSl === 'number');
    assert(typeof stats.totalMissedTp === 'number');
  });

  // ── 2. REAL-TIME DASHBOARD SERVER API ENDPOINTS ────────────────────────────
  await runAsyncTest('5. Dashboard Server: Kiểm tra các API Phase 4 & Phase 5', async () => {
    const PORT = 3899;
    const server = createServer(PORT);

    await new Promise(r => setTimeout(r, 200));

    function fetchEndpoint(urlPath, method = 'GET', body = null) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: PORT,
          path: urlPath,
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {}
        }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch (e) { resolve({ status: res.statusCode, raw: data }); }
          });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    }

    // 1. /api/circuit-breaker
    const resCb = await fetchEndpoint('/api/circuit-breaker');
    assert.strictEqual(resCb.status, 200);
    assert(resCb.body.LONG !== undefined && resCb.body.SHORT !== undefined, 'Phải trả về status LONG và SHORT');

    // 2. /api/btc-flash-guard
    const resFlash = await fetchEndpoint('/api/btc-flash-guard');
    assert.strictEqual(resFlash.status, 200);
    assert(resFlash.body.activeFlash !== undefined, 'Phải trả về activeFlash');

    // 3. /api/cooldowns
    const resCd = await fetchEndpoint('/api/cooldowns');
    assert.strictEqual(resCd.status, 200);

    // 4. /api/shadow-trades
    const resShadow = await fetchEndpoint('/api/shadow-trades');
    assert.strictEqual(resShadow.status, 200);
    assert(resShadow.body.stats !== undefined, 'Phải có stats của Shadow Tracker');

    // 5. POST /api/circuit-breaker/unlock
    const resUnlock = await fetchEndpoint('/api/circuit-breaker/unlock', 'POST', { side: 'LONG' });
    assert.strictEqual(resUnlock.status, 200);
    assert.strictEqual(resUnlock.body.ok, true);

    server.close();
  });

  console.log('\n================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passedTests}/${totalTests} BÀI TEST THÀNH CÔNG (${((passedTests/totalTests)*100).toFixed(0)}%)`);
  console.log('================================================================');
  process.exit(passedTests === totalTests ? 0 : 1);
})();
