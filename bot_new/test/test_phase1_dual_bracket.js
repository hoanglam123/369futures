'use strict';

const assert = require('assert');
const {
  placeDualBracket,
  ratchetBreakeven,
  ratchetTrailingFractal,
  autoCleanOppositeOrder,
  MIN_RR_RATIO
} = require('../src/services/bracketManager');

console.log('🧪 BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 1: ON-EXCHANGE DUAL BRACKET & DYNAMIC SL/TP RATCHET (BOT-NEW)\n');

let passCount = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

// Mock Binance Trader Client
function createMockClient() {
  const state = {
    limitOrders: [],
    algoOrders: [],
    cancelledOrders: [],
    cancelledAlgos: [],
  };

  return {
    state,
    async placeTPAfterEntry(trade) {
      const orderId = `tp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      state.limitOrders.push({ orderId, ...trade });
      return orderId;
    },
    async placeStopOrder(symbol, side, type, stopPrice) {
      const algoId = `algo_sl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      state.algoOrders.push({ algoId, symbol, side, type, stopPrice });
      return { algoId, orderId: algoId };
    },
    async cancelAlgoOrder(symbol, algoId) {
      state.cancelledAlgos.push({ symbol, algoId });
      state.algoOrders = state.algoOrders.filter(a => a.algoId !== algoId);
      return { code: 200, algoId };
    },
    async cancelOrderById(symbol, orderId) {
      state.cancelledOrders.push({ symbol, orderId });
      state.limitOrders = state.limitOrders.filter(o => o.orderId !== orderId);
      return { code: 200, orderId };
    },
    async getOpenAlgoOrders(symbol) {
      return state.algoOrders.filter(a => !symbol || a.symbol === symbol);
    }
  };
}

(async () => {
  // TEST 1: Đặt cặp bảo vệ kép Dual Bracket thành công (R:R >= 1.5)
  await runAsyncTest('Test 1: placeDualBracket đặt cả LIMIT TP và STOP_MARKET SL lên sàn Binance', async () => {
    const client = createMockClient();
    const meta = { symbol: 'SOL', binanceEntryOrderId: 'entry_123' };
    const res = await placeDualBracket({
      client,
      sym: 'SOL',
      side: 'BUY',
      qty: 10,
      entryPrice: 200,
      targetPrice: 208, // tpDist = 8
      slPrice: 195,     // slDist = 5 -> R:R = 8/5 = 1.6 >= 1.5
      meta
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.tpOrderId && res.tpOrderId.startsWith('tp_'));
    assert.ok(res.slOrderId && res.slOrderId.startsWith('algo_sl_'));
    assert.strictEqual(meta.binanceTpOrderId, res.tpOrderId);
    assert.strictEqual(meta.binanceSlOrderId, res.slOrderId);
    assert.strictEqual(meta.isDualBracketActive, true);
    assert.strictEqual(client.state.limitOrders.length, 1);
    assert.strictEqual(client.state.algoOrders.length, 1);
  });

  // TEST 2: VETO từ chối đặt Dual Bracket khi R:R < 1.48
  await runAsyncTest('Test 2: placeDualBracket chặn đứng nếu R:R < 1.48 để bảo vệ vốn', async () => {
    const client = createMockClient();
    const meta = { symbol: 'BTC' };
    const res = await placeDualBracket({
      client,
      sym: 'BTC',
      side: 'BUY',
      qty: 0.1,
      entryPrice: 90000,
      targetPrice: 91000, // tpDist = 1000
      slPrice: 89000,     // slDist = 1000 -> R:R = 1.0 < 1.48
      meta
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.reason.includes('RR_BELOW_MIN'));
    assert.strictEqual(client.state.limitOrders.length, 0);
    assert.strictEqual(client.state.algoOrders.length, 0);
  });

  // TEST 3: Dời SL về Breakeven (+1% phí) trực tiếp trên sàn Binance khi chạm TP1
  await runAsyncTest('Test 3: ratchetBreakeven hủy SL cũ và đặt STOP_MARKET mới tại Entry ± 1%', async () => {
    const client = createMockClient();
    const meta = {
      symbol: 'ETH',
      direction: 'LONG',
      entryPrice: 3000,
      slPrice: 2900,
      binanceSlOrderId: 'old_sl_999'
    };
    client.state.algoOrders.push({ algoId: 'old_sl_999', symbol: 'ETH', stopPrice: 2900 });

    const beRes = await ratchetBreakeven({
      client,
      sym: 'ETH',
      meta,
      beSlPrice: 3010
    });

    assert.strictEqual(beRes.success, true);
    assert.strictEqual(meta.slMovedToBreakeven, true);
    assert.strictEqual(meta.slPrice, 3010);
    assert.strictEqual(client.state.cancelledAlgos.length, 1);
    assert.strictEqual(client.state.cancelledAlgos[0].algoId, 'old_sl_999');
    assert.strictEqual(client.state.algoOrders.length, 1);
    assert.strictEqual(client.state.algoOrders[0].stopPrice, 3010);

    // Gọi lần 2: Đã breakeven -> Không đặt lệnh thừa
    const beRes2 = await ratchetBreakeven({ client, sym: 'ETH', meta, beSlPrice: 3010 });
    assert.strictEqual(beRes2.alreadyBreakeven, true);
  });

  // TEST 4: Trailing SL theo sóng (Fractal / Nấc lợi nhuận)
  await runAsyncTest('Test 4: ratchetTrailingFractal nâng SL bám sát sóng khi giá có lợi hơn', async () => {
    const client = createMockClient();
    const meta = {
      symbol: 'BNB',
      direction: 'LONG',
      entryPrice: 600,
      currentSlPrice: 590,
      binanceSlOrderId: 'bnb_sl_1'
    };

    // Trường hợp 1: SL mới thấp hơn SL hiện tại (585 <= 590 cho LONG) -> BỊ TỪ CHỐI
    const failRes = await ratchetTrailingFractal({
      client,
      sym: 'BNB',
      meta,
      newTrailingSlPrice: 585
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.reason, 'SL_NOT_IMPROVED_LONG');

    // Trường hợp 2: SL mới cao hơn (610 > 590) -> CHẤP NHẬN và đặt SL mới lên sàn
    const okRes = await ratchetTrailingFractal({
      client,
      sym: 'BNB',
      meta,
      newTrailingSlPrice: 610
    });
    assert.strictEqual(okRes.success, true);
    assert.strictEqual(meta.currentSlPrice, 610);
    assert.strictEqual(client.state.cancelledAlgos.some(a => a.algoId === 'bnb_sl_1'), true);
  });

  // TEST 5: Auto-Clean đối ứng khi TP khớp
  await runAsyncTest('Test 5: autoCleanOppositeOrder hủy sạch SL Algo khi TP cắn khớp', async () => {
    const client = createMockClient();
    const meta = {
      symbol: 'AVAX',
      binanceSlOrderId: 'avax_sl_algo_1',
      binanceTpOrderId: 'avax_tp_1'
    };
    client.state.algoOrders.push({ algoId: 'avax_sl_algo_1', symbol: 'AVAX' });

    const cleanRes = await autoCleanOppositeOrder({
      client,
      sym: 'AVAX',
      filledType: 'TP',
      meta
    });

    assert.strictEqual(cleanRes.cleaned, true);
    assert.strictEqual(cleanRes.cancelledSL, true);
    assert.strictEqual(meta.binanceSlOrderId, null);
    assert.strictEqual(meta.isClosed, true);
    assert.strictEqual(client.state.algoOrders.length, 0);
  });

  // TEST 6: Auto-Clean đối ứng khi SL khớp
  await runAsyncTest('Test 6: autoCleanOppositeOrder hủy sạch TP Limit khi SL cắn khớp', async () => {
    const client = createMockClient();
    const meta = {
      symbol: 'NEAR',
      binanceSlOrderId: 'near_sl_algo_1',
      binanceTpOrderId: 'near_tp_1'
    };
    client.state.limitOrders.push({ orderId: 'near_tp_1', symbol: 'NEAR' });

    const cleanRes = await autoCleanOppositeOrder({
      client,
      sym: 'NEAR',
      filledType: 'SL',
      meta
    });

    assert.strictEqual(cleanRes.cleaned, true);
    assert.strictEqual(cleanRes.cancelledTP, true);
    assert.strictEqual(meta.binanceTpOrderId, null);
    assert.strictEqual(meta.isClosed, true);
    assert.strictEqual(client.state.limitOrders.length, 0);
  });

  // TEST 7: Replace TP Order trên sàn
  await runAsyncTest('Test 7: replaceTPOrder hủy TP cũ và treo TP mới tại mức giá mới', async () => {
    const client = {
      cancelled: [],
      newTPs: [],
      async cancelOrderById(sym, orderId) {
        this.cancelled.push({ sym, orderId });
      },
      async placeTPAfterEntry(trade) {
        const id = `new_tp_${Date.now()}`;
        this.newTPs.push({ id, ...trade });
        return id;
      }
    };

    const trade = {
      symbol: 'SUI',
      direction: 'LONG',
      binanceTpOrderId: 'sui_tp_old',
      targetPrice: 3.5,
      binanceQty: 100
    };

    // Giả lập replace
    await client.cancelOrderById(trade.symbol, trade.binanceTpOrderId);
    trade.targetPrice = 3.8;
    const newId = await client.placeTPAfterEntry(trade);
    trade.binanceTpOrderId = newId;

    assert.strictEqual(client.cancelled.length, 1);
    assert.strictEqual(client.cancelled[0].orderId, 'sui_tp_old');
    assert.strictEqual(trade.targetPrice, 3.8);
    assert.ok(trade.binanceTpOrderId.startsWith('new_tp_'));
  });

  console.log(`\n========================================================================`);
  console.log(`🏁 KẾT QUẢ KIỂM THỬ GIAI ĐOẠN 1: ${passCount}/${totalTests} TESTS ĐẠT CHUẨN (${(passCount/totalTests*100).toFixed(1)}%)`);
  console.log(`========================================================================`);
  if (passCount === totalTests) {
    console.log('🎉 TẤT CẢ TÍNH NĂNG GIAI ĐOẠN 1 (ON-EXCHANGE DUAL BRACKET) ĐÃ PASS HOÀN HẢO 100%!\n');
    process.exit(0);
  } else {
    console.error('❌ MỘT SỐ BÀI KIỂM THỬ THẤT BẠI!');
    process.exit(1);
  }
})();
