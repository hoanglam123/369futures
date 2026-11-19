'use strict';

/**
 * TEST SUITE TOÀN DIỆN: FIBONACCI HYBRID SL 3 TẦNG, S/R & 369 GRID ANCHORED TP,
 * WEAK S/R BYPASS VÀ PERSISTENT DEEP CANDLE CACHE (ROADMAP_FIBONACCI_HYBRID_SL_TP.md)
 */

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  calculateTierSLTP,
  buildClusterZones,
} = require('../src/trader/autoTrade');

const {
  CACHE_MAX_H1,
  CACHE_MAX_H4,
  CACHE_MAX_D1,
} = require('../src/pp369/core');

async function runTests() {
  console.log('========================================================================');
  console.log('🧪 KIỂM THỬ TOÀN DIỆN: ROADMAP FIBONACCI HYBRID SL 3 TẦNG & SMART TP');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.message}`);
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.message}`);
    }
  }

  // Helper tạo mock candles
  function makeCandles(count, basePrice, spread = 0.5, intervalHours = 1) {
    const candles = [];
    const now = Date.now();
    for (let i = count; i >= 0; i--) {
      candles.push({
        openTime: now - i * intervalHours * 3600 * 1000,
        open: basePrice,
        high: basePrice + spread,
        low: basePrice - spread,
        close: basePrice,
        volume: 1000
      });
    }
    return candles;
  }

  // ── TEST 1: THÔNG SỐ PERSISTENT DEEP CACHE ──────────────────────────────
  test('Test 1: Kích thước Persistent Deep Cache chuẩn hóa H1=300, H4=300, D1=180', () => {
    assert.strictEqual(CACHE_MAX_H1, 300, 'CACHE_MAX_H1 phải là 300 nến (~12.5 ngày)');
    assert.strictEqual(CACHE_MAX_H4, 300, 'CACHE_MAX_H4 phải là 300 nến (~50 ngày)');
    assert.strictEqual(CACHE_MAX_D1, 180, 'CACHE_MAX_D1 phải là 180 nến (~6 tháng)');
  });

  // ── TEST 2: THUẬT TOÁN NHÓM VÙNG CẢN CỤM (CLUSTER ZONES) ───────────────
  test('Test 2: Nhóm các điểm xoay gần nhau vào Cluster Zone [zoneMin, zoneMax] và đếm touches', () => {
    // 3 điểm chạm gần mốc 10.0 (9.95, 10.02, 10.05) trên H4
    const points = [
      { price: 9.95, timeframe: 'H4', type: 'HIGH' },
      { price: 10.02, timeframe: 'H4', type: 'HIGH' },
      { price: 10.05, timeframe: 'H4', type: 'HIGH' },
      { price: 12.00, timeframe: 'H1', type: 'HIGH' }, // 1 điểm biệt lập ở xa
    ];

    const clusters = buildClusterZones(points, 0.01);
    assert.strictEqual(clusters.length, 2, 'Phải tạo thành đúng 2 cụm cản');

    const c1 = clusters[0];
    assert.strictEqual(c1.zoneMin, 9.95);
    assert.strictEqual(c1.zoneMax, 10.05);
    assert.strictEqual(c1.touches, 3);
    assert.strictEqual(c1.isMajor, true, 'H4 có >= 2 lần phản ứng phải là Major S/R');

    const c2 = clusters[1];
    assert.strictEqual(c2.zoneMin, 12.00);
    assert.strictEqual(c2.touches, 1);
    assert.strictEqual(c2.isMajor, false, 'H1 có 1 lần phản ứng phải là Minor S/R');
  });

  // ── TEST 3: TẦNG 1 - CẢN SWEET SPOT H1/H4 ──────────────────────────────
  await testAsync('Test 3: Tầng 1 - Cản Sweet Spot H1/H4 trong [1.2x ATR, 2.0x ATR] <= 3.5%', async () => {
    const entryPrice = 100.0;
    const h1 = makeCandles(40, 100, 1.0, 1);
    // Tạo swing low tại nến 25 với low = 98.0 (cách 2.0% ~ 1.5x ATR)
    h1[25] = { openTime: Date.now() - 15 * 3600 * 1000, open: 99, high: 99.5, low: 98.0, close: 98.5 };
    h1[24] = { openTime: Date.now() - 16 * 3600 * 1000, open: 100, high: 100.5, low: 99.2, close: 99.5 };
    h1[26] = { openTime: Date.now() - 14 * 3600 * 1000, open: 99, high: 100.5, low: 99.0, close: 100 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 105.0, lowerPrice: 95.0 };
    const res = await calculateTierSLTP('SOL', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 5, 5.0, {
      h1, h4: h1, d1: []
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'SWEET_SPOT_SWING');
    // SL phải nép sau swing low 98.0 - buffer 0.2% = 97.80
    assert(res.slPrice <= 98.0, `SL (${res.slPrice}) phải nép sau cản 98.0`);
    assert(res.rrRatio >= 1.48);
  });

  // ── TEST 4: TẦNG 2 - CẢN D1 TẦM TRUNG (LỊCH SỬ 6 THÁNG) ────────────────
  await testAsync('Test 4: Tầng 2 - Cản D1 Tầm Trung khi H1/H4 không có cản gần (khoảng cách <= 4.0%)', async () => {
    const entryPrice = 50.0;
    // H1 không có cản gần (nến phẳng quanh 50)
    const h1 = makeCandles(30, 50, 0.3, 1);
    const h4 = makeCandles(30, 50, 0.3, 4);

    // D1 có cản swing low ở 48.2 (cách 3.6% <= 4.0%)
    const d1 = makeCandles(30, 50, 0.5, 24);
    d1[15] = { openTime: Date.now() - 15 * 24 * 3600 * 1000, open: 49, high: 49.5, low: 48.2, close: 49 };
    d1[14] = { openTime: Date.now() - 16 * 24 * 3600 * 1000, open: 50, high: 50.5, low: 49.5, close: 50 };
    d1[16] = { openTime: Date.now() - 14 * 24 * 3600 * 1000, open: 50, high: 50.5, low: 49.5, close: 50 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 55.0, lowerPrice: 45.0 };
    const res = await calculateTierSLTP('SUI', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 40, 5.0, {
      h1, h4, d1
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'TIER2_D1_SWING', 'Phải kích hoạt Tầng 2 Cản D1');
    assert(res.slPrice <= 48.2, `SL (${res.slPrice}) phải nép sau cản D1 48.2`);
    assert(res.slPct <= 4.0, `SL% (${res.slPct}%) không được vượt trần 4.0% của D1`);
  });

  // ── TEST 5: TẦNG 3A - FIBONACCI RETRACEMENT 0.786 TRÊN SÓNG H1 ────────
  await testAsync('Test 5: Tầng 3A - Fibonacci Retracement 0.786 khi đỉnh/đáy ở xa', async () => {
    const entryPrice = 10.0;
    // H1 có sóng đẩy từ low 9.6 lên high 10.4 trong 24 nến gần nhất (delta = 0.8, 8% biên độ)
    // Giả lập SHORT tại entry 10.0:
    // Fib 0.786 = 9.6 + 0.786 * 0.8 = 10.2288
    // SL nép sau Fib 0.786 + 0.2% buffer = 10.2288 + 0.02 = 10.2488 (~2.49% SL)
    const h1 = makeCandles(30, 10.0, 0.05, 1);
    const now = Date.now();
    h1[12] = { openTime: now - 18 * 3600 * 1000, open: 9.65, high: 9.7, low: 9.6, close: 9.65 };
    h1[20] = { openTime: now - 10 * 3600 * 1000, open: 10.3, high: 10.4, low: 10.2, close: 10.35 };

    // Không có cản cũ trên H4/D1 (giá đang ở vùng mới)
    const h4 = makeCandles(20, 10.0, 0.05, 4);
    const d1 = makeCandles(20, 10.0, 0.05, 24);

    const h4Ref = { step: 0.2, decimals: 3, upperPrice: 11.0, lowerPrice: 9.0 };
    const res = await calculateTierSLTP('ICNT', 'SHORT', entryPrice, h4Ref, 0.001, 20, 3.0, 1.5, 120, 5.0, {
      h1, h4, d1
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'TIER3A_FIBONACCI_0786', 'Phải kích hoạt Tầng 3A Fibonacci');
    assert(res.slPrice >= 10.22, `SHORT SL (${res.slPrice}) phải nằm trên mốc Fib 0.786`);
    assert(res.slPct <= 3.5, `SL% (${res.slPct}%) phải được khóa gọn dưới 3.5%`);
    assert(res.rrRatio >= 1.48);
  });

  // ── TEST 6: TẦNG 3B - FIBONACCI GOLDEN ATR (FALLBACK KHI SÓNG PHẲNG) ───
  await testAsync('Test 6: Tầng 3B - Fibonacci Golden ATR (1.618x ATR) khi nến phẳng', async () => {
    const entryPrice = 20.0;
    // Nến biến động cực thấp, không có sóng đẩy rõ ràng
    const h1 = makeCandles(30, 20.0, 0.05, 1);
    const h4 = makeCandles(20, 20.0, 0.05, 4);
    const d1 = [];

    const h4Ref = { step: 0.5, decimals: 2, upperPrice: 22.0, lowerPrice: 18.0 };
    const res = await calculateTierSLTP('FLAT', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 60, 5.0, {
      h1, h4, d1
    });

    assert.strictEqual(res.valid, true);
    assert(res.slPct >= 1.8, `Tier 2 coin SL% (${res.slPct}%) phải đạt sàn 1.8%`);
    assert(res.slPct <= 3.0, `SL% (${res.slPct}%) phải nằm trong trần Golden ATR 3.0%`);
  });

  // ── TEST 7: SMART TP - FRONT-RUNNING NEO CẢN ĐỐI DIỆN ──────────────────
  await testAsync('Test 7: Smart TP - Front-Running nép trước cản đối diện 0.2%', async () => {
    const entryPrice = 100.0;
    const h1 = makeCandles(40, 100, 1.0, 1);
    // Cài đáy SL tại 98.0 (SL = 97.80 -> slDist = 2.2)
    h1[25] = { openTime: Date.now() - 15 * 3600 * 1000, open: 99, high: 99.5, low: 98.0, close: 98.5 };
    h1[24] = { openTime: Date.now() - 16 * 3600 * 1000, open: 100, high: 100.5, low: 99.2, close: 99.5 };
    h1[26] = { openTime: Date.now() - 14 * 3600 * 1000, open: 99, high: 100.5, low: 99.0, close: 100 };

    // Cài kháng cự Major trên D1 tại 104.5 (cách 4.5% -> R:R ~ 2.0)
    const d1 = makeCandles(30, 100, 0.5, 24);
    d1[10] = { openTime: Date.now() - 10 * 24 * 3600 * 1000, open: 104, high: 104.5, low: 103, close: 104 };
    d1[9] = { openTime: Date.now() - 11 * 24 * 3600 * 1000, open: 102, high: 103, low: 101, close: 102 };
    d1[11] = { openTime: Date.now() - 9 * 24 * 3600 * 1000, open: 103, high: 103.5, low: 102, close: 103 };

    const h4Ref = { step: 2.0, decimals: 2, upperPrice: 110.0, lowerPrice: 90.0 };
    const res = await calculateTierSLTP('SOL', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 5, 5.0, {
      h1, h4: h1, d1
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.tpAnchorType, 'D1_SR_ANCHOR', 'TP phải neo vào cản D1');
    // Front-running 0.2%: 104.5 - (100 * 0.002) = 104.30
    assert(res.tpPrice <= 104.35 && res.tpPrice >= 104.25, `TP (${res.tpPrice}) phải front-run trước 104.5`);
    assert(res.rrRatio >= 1.8, `R:R (${res.rrRatio}) phải đạt chuẩn cản lớn`);
  });

  // ── TEST 8: WEAK S/R BYPASS (BỎ QUA CẢN YẾU ĐỂ KHÔNG REJECT OAN) ────────
  await testAsync('Test 8: Weak S/R Bypass - Bỏ qua cản yếu H1 1x để không reject oan uổng', async () => {
    const entryPrice = 100.0;
    const h1 = makeCandles(40, 100, 0.8, 1);
    // SL tại 98.0 (slDist = 2.2)
    h1[25] = { openTime: Date.now() - 15 * 3600 * 1000, open: 99, high: 99.5, low: 98.0, close: 98.5 };
    h1[24] = { openTime: Date.now() - 16 * 3600 * 1000, open: 100, high: 100.5, low: 99.2, close: 99.5 };
    h1[26] = { openTime: Date.now() - 14 * 3600 * 1000, open: 99, high: 100.5, low: 99.0, close: 100 };

    // Tạo 1 cản yếu H1 (touches = 1) ở rất gần: 101.0 (chỉ cách 1.0%, R:R = 1.0/2.2 = 0.45 < 1.48)
    h1[10] = { openTime: Date.now() - 30 * 3600 * 1000, open: 100.5, high: 101.0, low: 100, close: 100.5 };
    h1[9] = { openTime: Date.now() - 31 * 3600 * 1000, open: 100, high: 100.2, low: 99.5, close: 100 };
    h1[11] = { openTime: Date.now() - 29 * 3600 * 1000, open: 100, high: 100.2, low: 99.5, close: 100 };

    // Không có cản cứng H4 chặn đầu, step 369 = 4.0 (mốc 104.0)
    const h4 = makeCandles(20, 100, 0.5, 4);
    const h4Ref = { step: 4.0, decimals: 2, upperPrice: 108.0, lowerPrice: 92.0 };

    const res = await calculateTierSLTP('BYPASS', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 30, 5.0, {
      h1, h4, d1: []
    });

    // Thuật toán PHẢI BYPASS cản yếu 101.0 và vươn tới mốc R:R >= 1.48
    assert.strictEqual(res.valid, true, 'Kèo KHÔNG được bị reject bởi cản yếu H1');
    assert(res.tpPrice >= 103.2, `TP (${res.tpPrice}) phải vượt qua cản yếu 101.0 để đạt R:R >= 1.48`);
    assert(res.rrRatio >= 1.48);
  });

  // ── TEST 9: HARD MAJOR WALL BLOCKING VETO ──────────────────────────────
  await testAsync('Test 9: Hard Major Wall VETO - Chặn đứng kèo nếu Bức tường Cản Cứng D1 cản đường', async () => {
    const entryPrice = 100.0;
    const h1 = makeCandles(40, 100, 1.0, 1);
    // SL tại 97.5 (slDist = 2.5, minRequiredTpDist = 2.5 * 1.48 = 3.70)
    h1[25] = { openTime: Date.now() - 15 * 3600 * 1000, open: 98, high: 98.5, low: 97.5, close: 98 };
    h1[24] = { openTime: Date.now() - 16 * 3600 * 1000, open: 99, high: 99.5, low: 98.5, close: 99 };
    h1[26] = { openTime: Date.now() - 14 * 3600 * 1000, open: 99, high: 99.5, low: 98.5, close: 99 };

    // BỨC TƯỜNG CẢN CỨNG D1 (Major Wall) nằm ngay tại 101.5 (cách 1.5% < 3.70%)
    const d1 = makeCandles(30, 100, 0.5, 24);
    d1[10] = { openTime: Date.now() - 10 * 24 * 3600 * 1000, open: 101, high: 101.5, low: 100, close: 101 };
    d1[9] = { openTime: Date.now() - 11 * 24 * 3600 * 1000, open: 100, high: 100.5, low: 99, close: 100 };
    d1[11] = { openTime: Date.now() - 9 * 24 * 3600 * 1000, open: 100, high: 100.5, low: 99, close: 100 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 105.0, lowerPrice: 95.0 };
    const res = await calculateTierSLTP('WALL', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 30, 5.0, {
      h1, h4: h1, d1
    });

    assert.strictEqual(res.valid, false, 'Phải VETO lệnh vì bị bức tường cản cứng D1 chặn đầu');
    assert(res.reason.includes('RR_BLOCKED_BY_MAJOR_SR'), `Lý do phải là RR_BLOCKED_BY_MAJOR_SR (thực tế: ${res.reason})`);
  });

  // ── TEST 10: TÁI HIỆN CA THỰC CHIẾN SOLV (LONG) & ICNT (SHORT) ──────────
  await testAsync('Test 10: Tái hiện ca SOLV - Bắt trúng Cản D1 2 tháng trước thay vì bị kẹp 3.5%', async () => {
    // SOLV: Entry tại $0.004100
    // Trong lịch sử 2 tháng trước (nến ngày), hỗ trợ D1 cứng nằm ở $0.003895 - $0.003946
    // Kháng cự đối diện thực tế tại $0.004358
    const entryPrice = 0.004100;
    const h1 = makeCandles(50, 0.004050, 0.00002, 1);
    const h4 = makeCandles(40, 0.004050, 0.00002, 4);

    const d1 = makeCandles(60, 0.004050, 0.00002, 24);
    // Tạo cụm đáy D1 2 tháng trước tại 0.003940 (cách ~3.9%):
    d1[45] = { openTime: Date.now() - 45 * 24 * 3600 * 1000, open: 0.0040, high: 0.00402, low: 0.003940, close: 0.0040 };
    d1[44] = { openTime: Date.now() - 46 * 24 * 3600 * 1000, open: 0.00405, high: 0.00407, low: 0.004000, close: 0.00405 };
    d1[46] = { openTime: Date.now() - 44 * 24 * 3600 * 1000, open: 0.00405, high: 0.00407, low: 0.004000, close: 0.00405 };

    // Kháng cự D1 thực tế tại 0.004358 (tương ứng gợi ý của Claude: TP1 0.004358)
    d1[10] = { openTime: Date.now() - 10 * 24 * 3600 * 1000, open: 0.0043, high: 0.004358, low: 0.0042, close: 0.0043 };

    const h4Ref = { step: 0.0003, decimals: 6, upperPrice: 0.0044, lowerPrice: 0.0038 };
    const res = await calculateTierSLTP('SOLV', 'LONG', entryPrice, h4Ref, 0.000001, 20, 3.0, 1.5, 200, 7.3, {
      h1, h4, d1
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'TIER2_D1_SWING', 'SOLV phải tìm ra cản D1 thực tế thay vì rơi vào vùng mù 3.5%');
    assert(res.slPrice <= 0.003940, `SL (${res.slPrice}) phải nép sau cản D1 thực tế $0.003940`);
    assert(res.slPct <= 4.0, 'SL% không được vượt quá 4.0%');
    assert.strictEqual(res.tpAnchorType, 'D1_SR_ANCHOR', 'TP phải neo vào cản D1 0.004358');
    assert(res.tpPrice >= 0.004340 && res.tpPrice <= 0.004358, `TP (${res.tpPrice}) phải front-run trước 0.004358`);
    assert(res.rrRatio >= 1.48, 'R:R phải >= 1.48');
  });

  console.log('\n========================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ: ${passed}/${total} TESTS ĐẠT CHUẨN (${((passed / total) * 100).toFixed(1)}%)`);
  console.log('========================================================================');
  if (passed === total) {
    console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG FIBONACCI HYBRID SL & TP ĐÃ PASS HOÀN HẢO 100%!');
  } else {
    console.error('⚠️ CÓ TEST THẤT BẠI!');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
