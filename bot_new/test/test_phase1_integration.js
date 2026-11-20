'use strict';

const assert = require('assert');
const binanceTrader = require('../src/services/binanceTrader');
const bracketManager = require('../src/services/bracketManager');

console.log('🧪 KIỂM THỬ TÍCH HỢP GIAI ĐOẠN 1 MỞ RỘNG (BOT-NEW INTEGRATION SUITE)\n');

let pass = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

(async () => {
  // Test 1: minNotional bumping in calcQty logic
  test('Test 1: Kiểm tra logic làm tròn qty luôn >= minNotional sàn (Fix LTC notional < 20)', () => {
    const entryPrice = 42.9;
    const minNotional = 20;
    const leverage = 2;
    const sizeUsdt = 10;
    const notional = sizeUsdt * leverage; // 20
    const rawQty = notional / entryPrice; // 0.466200466...
    const step = 0.001;
    const decimals = 3;
    let qty = parseFloat((Math.floor(rawQty / step) * step).toFixed(decimals)); // 0.466
    assert.strictEqual(qty * entryPrice < minNotional, true); // 0.466 * 42.9 = 19.9914 < 20

    // Bump check logic
    if (qty > 0 && (qty * entryPrice) < minNotional) {
      qty = parseFloat((qty + step).toFixed(decimals));
    }
    assert.strictEqual(qty, 0.467);
    assert.strictEqual(qty * entryPrice >= minNotional, true); // 0.467 * 42.9 = 20.0343 >= 20
  });

  // Test 2: Formatting stopPrice using tickSize
  test('Test 2: Kiểm tra định dạng triggerPrice bằng tickSize (0.1 cho BTC, 0.01 cho LTC)', () => {
    // BTC: tickSize = 0.1
    const btcTick = 0.1;
    const btcPrice = 62341.168;
    const roundedBtc = Math.round(btcPrice / btcTick) * btcTick;
    const decBtc = Math.max(0, Math.round(-Math.log10(btcTick)));
    const btcStr = roundedBtc.toFixed(decBtc);
    assert.strictEqual(btcStr, '62341.2');

    // LTC: tickSize = 0.01
    const ltcTick = 0.01;
    const ltcPrice = 41.5649;
    const roundedLtc = Math.round(ltcPrice / ltcTick) * ltcTick;
    const decLtc = Math.max(0, Math.round(-Math.log10(ltcTick)));
    const ltcStr = roundedLtc.toFixed(decLtc);
    assert.strictEqual(ltcStr, '41.56');
  });

  // Test 3: Bracket Manager placeDualBracket with meta enrichment
  await testAsync('Test 3: placeDualBracket gán đầy đủ binanceTpOrderId và binanceSlOrderId vào trade metadata', async () => {
    const mockClient = {
      async placeTPAfterEntry(t) { return 'tp_order_999'; },
      async placeStopOrder(sym, side, type, sl) { return { algoId: 'algo_sl_888' }; }
    };
    const trade = { symbol: 'LTC', direction: 'LONG', binanceEntryOrderId: 45373775558 };
    const res = await bracketManager.placeDualBracket({
      client: mockClient,
      sym: 'LTC',
      side: 'BUY',
      qty: 0.468,
      entryPrice: 42.73,
      targetPrice: 47.37,
      slPrice: 41.56,
      meta: trade
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(trade.binanceTpOrderId, 'tp_order_999');
    assert.strictEqual(trade.binanceSlOrderId, 'algo_sl_888');
    assert.strictEqual(trade.isDualBracketActive, true);
  });

  // Test 4: Dynamic Ratchet Breakeven when TP1 is reached
  await testAsync('Test 4: ratchetBreakeven dời SL về Entry + 1% phí an toàn', async () => {
    let cancelled = null;
    let newPlaced = null;
    const mockClient = {
      async cancelAlgoOrder(sym, id) { cancelled = id; },
      async placeStopOrder(sym, side, type, px) {
        newPlaced = { sym, side, type, px };
        return { algoId: 'algo_sl_be_111' };
      },
      async getOpenAlgoOrders() { return []; }
    };
    const trade = {
      symbol: 'LTC',
      direction: 'LONG',
      binanceSlOrderId: 'algo_sl_888',
      slPrice: 41.56,
      entryPrice: 42.73
    };
    const res = await bracketManager.ratchetBreakeven({
      client: mockClient,
      sym: 'LTC',
      meta: trade,
      beSlPrice: 43.16 // Entry + 1%
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(cancelled, 'algo_sl_888');
    assert.strictEqual(trade.binanceSlOrderId, 'algo_sl_be_111');
    assert.strictEqual(trade.slPrice, 43.16);
    assert.strictEqual(trade.slMovedToBreakeven, true);
  });

  // Test 5: Dynamic Ratchet Trailing SL when TP2 is reached (Profit Lock)
  await testAsync('Test 5: ratchetTrailingFractal nâng SL khóa lãi tại TP1', async () => {
    let cancelled = null;
    let newPlaced = null;
    const mockClient = {
      async cancelAlgoOrder(sym, id) { cancelled = id; },
      async placeStopOrder(sym, side, type, px) {
        newPlaced = { sym, side, type, px };
        return { algoId: 'algo_sl_tp2_lock' };
      },
      async getOpenAlgoOrders() { return []; }
    };
    const trade = {
      symbol: 'LTC',
      direction: 'LONG',
      binanceSlOrderId: 'algo_sl_be_111',
      slPrice: 43.16,
      currentSlPrice: 43.16
    };
    const res = await bracketManager.ratchetTrailingFractal({
      client: mockClient,
      sym: 'LTC',
      meta: trade,
      newTrailingSlPrice: 45.08, // TP1 price
      label: 'TP2 Profit Lock'
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(cancelled, 'algo_sl_be_111');
    assert.strictEqual(trade.binanceSlOrderId, 'algo_sl_tp2_lock');
    assert.strictEqual(trade.slPrice, 45.08);
  });

  // Test 6: Auto-clean opposite order when SL or TP fills
  await testAsync('Test 6: autoCleanOppositeOrder dọn dẹp sạch sẽ khi TP hoặc SL khớp', async () => {
    const cancelledOrders = [];
    const cancelledAlgos = [];
    const mockClient = {
      async cancelOrderById(sym, id) { cancelledOrders.push(id); },
      async cancelAlgoOrder(sym, id) { cancelledAlgos.push(id); },
      async getOpenAlgoOrders() { return []; }
    };
    const trade = {
      symbol: 'LTC',
      binanceTpOrderId: 'tp_123',
      binanceSlOrderId: 'sl_algo_456'
    };
    // TP hit -> SL Algo must be cancelled
    await bracketManager.autoCleanOppositeOrder({
      client: mockClient,
      sym: 'LTC',
      filledType: 'TP',
      meta: trade
    });
    assert.strictEqual(trade.binanceSlOrderId, null);
    assert.deepStrictEqual(cancelledAlgos, ['sl_algo_456']);
  });

  // Test 7: Fix BTC limit order calculation (auto-bump leverage to cover minQty 0.001 BTC @ $62k x5 while keeping margin ~5%)
  await testAsync('Test 7: calcQty tự động nâng đòn bẩy cho BTC để giữ đúng ký quỹ 5% (Fix qty=0 trên coin giá cao)', async () => {
    const btcInfo = {
      quantityPrecision: 3,
      pricePrecision: 1,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5
    };
    const entryPrice = 62126.2;
    const leverage = 5;
    const balance = 88.90;

    // Test trường hợp tự tính từ % balance: 88.90 * 5% = 4.45 -> min 5 USDT
    // 5 USDT * 5x = 25 notional < 62.13 notional tối thiểu của 0.001 BTC -> tự bump leverage lên >= 13x
    const res = await binanceTrader.calcQty('BTC', entryPrice, leverage, btcInfo, null, balance);
    assert.strictEqual(res.qty, 0.001);
    assert.strictEqual(res.sizeUsdt, 5); // Bảo toàn ký quỹ 5% (~5 USDT)
    assert.strictEqual(res.effectiveLeverage >= 13, true); // Nâng từ 5x lên >= 13x
    assert.strictEqual(res.qty * entryPrice >= 5, true);
  });

  // Test 8: calcQty ưu tiên TRADE_SIZE_PCT=5% bảo toàn tỷ trọng vốn
  await testAsync('Test 8: calcQty ưu tiên TRADE_SIZE_PCT=5% bảo toàn tỷ trọng vốn (5 USDT thay vì hardcode 20 USDT)', async () => {
    const btcInfo = {
      quantityPrecision: 3,
      pricePrecision: 1,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5
    };
    const entryPrice = 62126.2;
    const leverage = 5;
    const balance = 88.90;
    const targetMargin = 20;

    const res = await binanceTrader.calcQty('BTC', entryPrice, leverage, btcInfo, targetMargin, balance);
    assert.strictEqual(res.qty, 0.001);
    assert.strictEqual(res.sizeUsdt, 5); // 5% của 88.90 là 4.45 USDT, min là 5 USDT
    assert.strictEqual(res.qty * entryPrice >= 5, true);
  });

  // Test 9: calcQty khi số dư thực sự không đủ cho 1 lot tối thiểu (kể cả kịch trần 50x)
  await testAsync('Test 9: calcQty trả về qty=0 khi số dư không đủ ký quỹ tối thiểu cho 1 lot BTC kể cả khi nâng đòn bẩy 50x', async () => {
    const btcInfo = {
      quantityPrecision: 3,
      pricePrecision: 1,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5
    };
    const entryPrice = 62126.2;
    const leverage = 5;
    const smallBalance = 1.00; // 1 lot BTC @ 50x cần 62.13 / 50 = 1.25 USDT > 1.00 USDT balance

    const res = await binanceTrader.calcQty('BTC', entryPrice, leverage, btcInfo, null, smallBalance);
    assert.strictEqual(res.qty, 0);
  });

  console.log(`\n========================================================================`);
  console.log(`🏁 KẾT QUẢ KIỂM THỬ: ${pass}/${total} TESTS ĐẠT CHUẨN (${(pass/total*100).toFixed(1)}%)`);
  console.log(`========================================================================`);
  process.exit(pass === total ? 0 : 1);
})();
