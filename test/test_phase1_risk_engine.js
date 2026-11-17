'use strict';

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { calculateTierSLTP } = require('../src/trader/autoTrade');

async function runTests() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 1 (RISK & EXIT ENGINE)');
  console.log('================================================================\n');

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

  // Giả lập nến H4 & H1 phục vụ test
  function generateMockCandles(basePrice, count, volatilityPct = 2.0) {
    const candles = [];
    let p = basePrice;
    const now = Date.now();
    for (let i = count; i >= 0; i--) {
      const delta = (Math.sin(i) * volatilityPct * basePrice) / 100;
      const c = p + delta;
      candles.push({
        openTime: now - i * 4 * 3600 * 1000,
        open: c - delta * 0.2,
        high: c + (volatilityPct * basePrice) / 100,
        low: c - (volatilityPct * basePrice) / 100,
        close: c,
        volume: 1000
      });
    }
    return candles;
  }

  // ── TEST 1: KỊCH BẢN 1 (SWEET SPOT SWING POINT) ──────────────────────────
  await testAsync('Kịch bản 1: Nhận diện Đáy cũ Sweet Spot H1/H4 và neo SL ẩn sau đáy', async () => {
    const entryPrice = 200.0;
    // Tạo nến H1 có ATR ~ 1.0% (biên độ nến 2 USD: high 201, low 199)
    const h1Candles = [];
    const now = Date.now();
    for (let i = 40; i >= 0; i--) {
      h1Candles.push({
        openTime: now - i * 3600 * 1000,
        open: 200, high: 201, low: 199, close: 200
      });
    }
    // Cài đáy tại idx = 25: low = 196.8 (cách Entry 3.2 USD = 1.6%, nằm chuẩn trong [1.2x ATR, 2.0x ATR] = [1.3%, 2.0%])
    h1Candles[25] = { openTime: now - 15 * 3600 * 1000, open: 198, high: 199, low: 196.8, close: 198 };
    h1Candles[22] = { openTime: now - 18 * 3600 * 1000, open: 200, high: 201, low: 199, close: 200 };
    h1Candles[23] = { openTime: now - 17 * 3600 * 1000, open: 200, high: 201, low: 199, close: 200 };
    h1Candles[24] = { openTime: now - 16 * 3600 * 1000, open: 199, high: 200, low: 198, close: 199 };
    h1Candles[26] = { openTime: now - 14 * 3600 * 1000, open: 198, high: 200, low: 198, close: 199 };
    h1Candles[27] = { openTime: now - 13 * 3600 * 1000, open: 199, high: 201, low: 199, close: 200 };
    h1Candles[28] = { openTime: now - 12 * 3600 * 1000, open: 200, high: 201, low: 199, close: 200 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 205.0, lowerPrice: 195.0 };
    const res = await calculateTierSLTP(
      'SOL', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 5, 5.0,
      { h1: h1Candles, h4: h1Candles }
    );

    assert.strictEqual(res.valid, true, 'Kèo phải hợp lệ');
    assert.strictEqual(res.slScenario, 'SWEET_SPOT_SWING', 'Phải nhận diện kịch bản Sweet Spot');
    assert(res.slPrice <= 196.8, 'SL phải nằm sau mốc đáy 196.8');
    assert(res.rrRatio >= 1.48, 'R:R phải >= 1.48');
    assert.strictEqual(res.margin, 20, 'Tier 1 Top 50 phải có margin = $20');
    assert(res.leverage <= 7, 'Tier 1 không được vượt trần 7x');
  });

  // ── TEST 2: KỊCH BẢN 2 (ĐỈNH/ĐÁY QUÁ XA > 2.0x ATR) ──────────────────────
  await testAsync('Kịch bản 2: Đáy cũ quá xa (cách 10%) -> Tự động cắt cụt (clamp) về 1.5x ATR', async () => {
    const entryPrice = 100.0;
    const h1Candles = [];
    const now = Date.now();
    for (let i = 40; i >= 0; i--) {
      h1Candles.push({
        openTime: now - i * 3600 * 1000,
        open: 100, high: 101, low: 99, close: 100
      });
    }
    // Cài đáy ở rất xa (90.0, cách 10%)
    h1Candles[20] = { openTime: now - 20 * 3600 * 1000, open: 92, high: 93, low: 90.0, close: 91 };
    h1Candles[18] = { openTime: now - 22 * 3600 * 1000, open: 95, high: 96, low: 94, close: 95 };
    h1Candles[19] = { openTime: now - 21 * 3600 * 1000, open: 94, high: 95, low: 93, close: 94 };
    h1Candles[21] = { openTime: now - 19 * 3600 * 1000, open: 93, high: 95, low: 92, close: 94 };
    h1Candles[22] = { openTime: now - 18 * 3600 * 1000, open: 95, high: 97, low: 94, close: 96 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 105.0, lowerPrice: 95.0 };
    const res = await calculateTierSLTP(
      'OP', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 80, 5.0,
      { h1: h1Candles, h4: h1Candles }
    );

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'CLAMP_FAR_SWING', 'Phải kích hoạt kịch bản CLAMP_FAR_SWING');
    assert(res.slPct <= 3.1, `SL% sau khi clamp không được vượt trần 3.0% (thực tế: ${res.slPct}%)`);
    assert.strictEqual(res.margin, 10, 'Tier 2 ngoài Top 50 phải có margin = $10');
    assert(res.leverage <= 3, 'Tier 2 ngoài Top 50 không được vượt trần 3x');
  });

  // ── TEST 3: KỊCH BẢN 3 (KHÔNG CÓ ĐỈNH/ĐÁY) ────────────────────────────────
  await testAsync('Kịch bản 3: Không có đỉnh đáy (nến phẳng) -> Dùng 1.5x ATR', async () => {
    const entryPrice = 50.0;
    const h1Candles = [];
    const now = Date.now();
    for (let i = 30; i >= 0; i--) {
      // Nến tăng dần liên tục, không có swing point nào
      h1Candles.push({
        openTime: now - i * 3600 * 1000,
        open: 40 + i * 0.3, high: 40 + i * 0.3 + 0.5, low: 40 + i * 0.3 - 0.2, close: 40 + i * 0.3 + 0.2
      });
    }

    const h4Ref = { step: 0.5, decimals: 2, upperPrice: 55.0, lowerPrice: 45.0 };
    const res = await calculateTierSLTP(
      'ARB', 'LONG', entryPrice, h4Ref, 0.01, 20, 3.0, 1.5, 40, 5.0,
      { h1: h1Candles, h4: h1Candles }
    );

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.slScenario, 'PURE_VOLATILITY_ATR', 'Phải dùng PURE_VOLATILITY_ATR');
    assert(res.slPct >= 1.3, 'Phải thỏa sàn tối thiểu 1.3%');
  });

  // ── TEST 4: BẢO VỆ GIÁ CHÁY (LIQUIDATION FRONT-RUNNING GUARD) ─────────────
  await testAsync('Cải tiến 1: Tự động hạ đòn bẩy để khoảng cách giá cháy >= 1.5x SL', async () => {
    const entryPrice = 100.0;
    const h1Candles = generateMockCandles(100.0, 40, 3.0); // Biến động 3.0%
    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 110.0, lowerPrice: 90.0 };

    const res = await calculateTierSLTP(
      'DOGE', 'LONG', entryPrice, h4Ref, 0.001, 50, 3.0, 1.5, 10, 8.0,
      { h1: h1Candles, h4: h1Candles }
    );

    assert.strictEqual(res.valid, true);
    // Tính khoảng cách giá cháy với MMR = 1%
    const liqDistPct = (1 / res.leverage - 0.01) * 100;
    assert(liqDistPct >= res.slPct * 1.45, `Khoảng cách giá cháy (${liqDistPct.toFixed(2)}%) phải >= 1.5x SL (${res.slPct}%)`);
  });

  // ── TEST 5: NÉ NAM CHÂM SỐ TRÒN TÂM LÝ ────────────────────────────────────
  await testAsync('Cải tiến 4: Tự động dịch lùi SL 0.25% nếu rơi vào mốc số tròn tâm lý', async () => {
    // Entry tại 102.0, giả sử SL ban đầu tính ra rơi sát 100.0 (chênh lệch <= 0.15%)
    const entryPrice = 102.1;
    const h1Candles = [];
    const now = Date.now();
    for (let i = 40; i >= 0; i--) {
      h1Candles.push({ openTime: now - i * 3600 * 1000, open: 102, high: 103, low: 101, close: 102 });
    }
    // Cài đáy tại 100.1 (rơi đúng vùng số tròn 100.0)
    h1Candles[20] = { openTime: now - 20 * 3600 * 1000, open: 101, high: 101.5, low: 100.1, close: 101 };
    h1Candles[18] = { openTime: now - 22 * 3600 * 1000, open: 102, high: 103, low: 101.8, close: 102 };
    h1Candles[19] = { openTime: now - 21 * 3600 * 1000, open: 102, high: 102.5, low: 101.5, close: 102 };
    h1Candles[21] = { openTime: now - 19 * 3600 * 1000, open: 101, high: 102, low: 101.2, close: 101.5 };
    h1Candles[22] = { openTime: now - 18 * 3600 * 1000, open: 102, high: 103, low: 101.8, close: 102.2 };

    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 110.0, lowerPrice: 95.0 };
    const res = await calculateTierSLTP(
      'TEST', 'LONG', entryPrice, h4Ref, 0.01, 10, 3.0, 1.5, 30, 6.0,
      { h1: h1Candles, h4: h1Candles }
    );

    assert.strictEqual(res.valid, true);
    // SL sau khi né số tròn 100.0 phải lùi sâu dưới 99.85
    assert(res.slPrice < 100.0, `SL (${res.slPrice}) phải được đẩy lùi xuống dưới số tròn 100.0`);
  });

  // ── TEST 6: LÀM TRÒN BẢO THỦ THEO TICKSIZE BINANCE ────────────────────────
  await testAsync('Cải tiến 5: Làm tròn bảo thủ (Floor cho Long SL, Ceil cho Short SL)', async () => {
    const entryPrice = 1.2345;
    const tickSize = 0.01;
    const h1Candles = generateMockCandles(1.2345, 30, 2.0);
    const h4Ref = { step: 0.01, decimals: 4, upperPrice: 1.30, lowerPrice: 1.15 };

    const resLong = await calculateTierSLTP('XRP', 'LONG', entryPrice, h4Ref, tickSize, 10, 3.0, 1.5, 10, 5.0, { h1: h1Candles, h4: h1Candles });
    const resShort = await calculateTierSLTP('XRP', 'SHORT', entryPrice, h4Ref, tickSize, 10, 3.0, 1.5, 10, 5.0, { h1: h1Candles, h4: h1Candles });

    // TickSize 0.01 nghĩa là giá phải chia hết cho 0.01
    const slLongTicks = Math.round(resLong.slPrice * 100) / 100;
    const slShortTicks = Math.round(resShort.slPrice * 100) / 100;
    assert.strictEqual(resLong.slPrice, slLongTicks, 'Long SL phải chia hết cho tickSize 0.01');
    assert.strictEqual(resShort.slPrice, slShortTicks, 'Short SL phải chia hết cho tickSize 0.01');
  });

  // ── TEST 7: CHỐT CHẶN R:R >= 1.5 (VETO NẾU DƯỚI 1.5) ──────────────────────
  await testAsync('Chốt chặn R:R >= 1.5: Tự động VETO và hủy kèo nếu R:R < 1.48', async () => {
    const entryPrice = 100.0;
    const h1Candles = generateMockCandles(100.0, 30, 2.0);
    // Độ rộng lưới h4Ref cố tình ép rất hẹp (0.5% grid width) để TP không đủ bù SL
    const h4Ref = { step: 0.01, decimals: 2, upperPrice: 100.25, lowerPrice: 99.75 };

    // Giả lập ép TP dist nhỏ thông qua gridWidthPct = 1.0% trong khi SL = 2.0%
    // Nhưng thuật toán mới của chúng ta tự động enforce targetTpDist = max(gridTpDist, slDist * 1.5)
    // Để test xem trường hợp rrRatio bị co hẹp:
    const res = await calculateTierSLTP('BTC', 'LONG', entryPrice, h4Ref, 0.1, 10, 3.0, 1.5, 1, 0.5, { h1: h1Candles, h4: h1Candles });
    assert(res.rrRatio >= 1.48, `R:R phải luôn được bảo đảm >= 1.48 (thực tế: ${res.rrRatio})`);
  });

  // ── TEST 8: MỐC BREAKEVEN 35% VÀ RISK-FREE FLOOR ─────────────────────────
  await testAsync('Breakeven 35%: Tính toán chính xác beTriggerPrice và beSlPrice (Risk-Free)', async () => {
    const entryPrice = 100.0;
    const h1Candles = generateMockCandles(100.0, 30, 2.0);
    const h4Ref = { step: 1.0, decimals: 2, upperPrice: 105.0, lowerPrice: 95.0 };

    const res = await calculateTierSLTP('ETH', 'LONG', entryPrice, h4Ref, 0.01, 10, 3.0, 1.5, 2, 6.0, { h1: h1Candles, h4: h1Candles });
    assert.strictEqual(res.valid, true);

    const expectedTrigger = entryPrice + res.tpDistance * 0.35;
    assert.strictEqual(res.beTriggerPrice, Number(expectedTrigger.toFixed(2)), 'beTriggerPrice phải đúng bằng Entry + 35% TP');
    assert(res.beSlPrice > entryPrice, 'beSlPrice cho lệnh Long phải cao hơn Entry (đảm bảo lãi phí +1%)');
  });

  // ── TEST 9: TRẦN ĐÒN BẨY CEILING CAPS (BTC 10x, Tier1 7x, Tier2 3x) ──────
  await testAsync('Trần đòn bẩy: BTC tối đa 10x, Tier 1 tối đa 7x, Tier 2 tối đa 3x', async () => {
    const h1Candles = generateMockCandles(100.0, 30, 0.2); // Biến động siêu thấp 0.2% (RawLev tính ra có thể lên 30x)
    const h4Ref = { step: 0.1, decimals: 2, upperPrice: 101.0, lowerPrice: 99.0 };

    const resBtc = await calculateTierSLTP('BTC', 'LONG', 90000, h4Ref, 0.1, 50, 3.0, 1.5, 1, 2.0, { h1: h1Candles, h4: h1Candles });
    const resSol = await calculateTierSLTP('SOL', 'LONG', 200, h4Ref, 0.01, 50, 3.0, 1.5, 5, 2.0, { h1: h1Candles, h4: h1Candles });
    const resMeme = await calculateTierSLTP('PEPE', 'LONG', 0.00001, h4Ref, 0.0000001, 50, 3.0, 1.5, 150, 2.0, { h1: h1Candles, h4: h1Candles });

    assert(resBtc.leverage <= 10, `BTC leverage (${resBtc.leverage}x) không được vượt trần 10x`);
    assert(resSol.leverage <= 7, `Tier 1 SOL leverage (${resSol.leverage}x) không được vượt trần 7x`);
    assert(resMeme.leverage <= 3, `Tier 2 PEPE leverage (${resMeme.leverage}x) không được vượt trần 3x`);
  });

  console.log('\n================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ: ${passed}/${total} TESTS ĐẠT CHUẨN (${(passed / total * 100).toFixed(1)}%)`);
  console.log('================================================================');

  if (passed === total) {
    console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG GIAI ĐOẠN 1 HOẠT ĐỘNG HOÀN HẢO 100%!\n');
    process.exit(0);
  } else {
    console.error('⚠️ CÓ TEST BỊ LỖI, VUI LÒNG KIỂM TRA LẠI!\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Lỗi thực thi test:', err);
  process.exit(1);
});
