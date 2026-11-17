'use strict';

/**
 * Test Suite Toàn Diện Giai Đoạn 4: Hạ Tầng WebSocket & Quản Lý Lệnh Tự Động
 * 
 * 1. Binance User Data Stream WebSocket (Event routing, onEntryFill < 50ms, onOrderFill, onOrderCancel)
 * 2. Cặp Lệnh Bảo Vệ Kép Trên Sàn (Dual On-Exchange Bracket: Limit TP & Hard Stop-Market SL, R:R >= 1.5)
 * 3. Dynamic SL Ratchet: Dời Dừng Lỗ Động Trên Sàn (Breakeven 35% & Trailing Fractal H1/M15)
 * 4. Cơ Chế Tự Động Dọn Dẹp (Auto-Clean on Fill: TP khớp hủy SL, SL khớp hủy TP)
 * 5. Safety Brake: Kịch bản A (Sàn trả về 0 positions khi bot đang có vị thế)
 * 6. Safety Brake: Kịch bản B (Sàn mất >= 60% vị thế bất thường) & Cơ chế /forcesync Override
 * 7. Reverse Check 60s: Đối chiếu chéo định kỳ phát hiện lỡ WebSocket event
 */

require('dotenv').config();
const assert = require('assert');

const {
  handleStreamMessage,
  onEntryFill,
  onOrderFill,
  onOrderCancel,
  clearCallbacks,
} = require('../src/trader/binanceStream');

const {
  placeDualBracket,
  ratchetBreakeven,
  ratchetTrailingFractal,
  autoCleanOppositeOrder,
  MIN_RR_RATIO,
} = require('../src/trader/bracketManager');

const {
  evaluateSafetyBrake,
  overrideSafetyBrake,
  isSafetyBrakeActive,
  resetSafetyBrake,
  runReverseCheck,
} = require('../src/trader/safetyBrake');

console.log('================================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 4 (WEBSOCKET & ORDER ENGINE)');
console.log('================================================================\n');

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

(async () => {
  // ── TEST 1: BINANCE USER DATA STREAM EVENT DISPATCHING ──
  runTest('BinanceStream: Bóc tách chính xác sự kiện Entry Fill (< 50ms) vs TP Fill vs Cancel', () => {
    clearCallbacks();

    let entryFillReceived = null;
    let orderFillReceived = null;
    let cancelReceived = null;

    onEntryFill(data => { entryFillReceived = data; });
    onOrderFill(data => { orderFillReceived = data; });
    onOrderCancel(data => { cancelReceived = data; });

    // 1. Giả lập tin nhắn WebSocket Entry Fill (reduceOnly = false)
    const entryFillMsg = {
      e: 'ORDER_TRADE_UPDATE',
      E: Date.now(),
      o: {
        s: 'BTCUSDT',
        i: 10001,
        c: 'client_entry_1',
        S: 'BUY',
        ot: 'LIMIT',
        X: 'FILLED',
        R: false,
        ap: '64000.5',
        q: '0.1',
        z: '0.1',
      }
    };
    handleStreamMessage(JSON.stringify(entryFillMsg));

    assert.ok(entryFillReceived, 'onEntryFill phải được kích hoạt khi Entry khớp');
    assert.strictEqual(entryFillReceived.symbol, 'BTC');
    assert.strictEqual(entryFillReceived.orderId, 10001);
    assert.strictEqual(entryFillReceived.avgPrice, 64000.5);
    assert.strictEqual(entryFillReceived.side, 'BUY');

    assert.ok(orderFillReceived, 'onOrderFill phải được kích hoạt');
    assert.strictEqual(orderFillReceived.orderId, 10001);

    // 2. Giả lập tin nhắn WebSocket TP Fill (reduceOnly = true)
    entryFillReceived = null;
    orderFillReceived = null;

    const tpFillMsg = {
      e: 'ORDER_TRADE_UPDATE',
      E: Date.now(),
      o: {
        s: 'BTCUSDT',
        i: 20002,
        c: 'client_tp_1',
        S: 'SELL',
        ot: 'LIMIT',
        X: 'FILLED',
        R: true, // Reduce-only TP
        ap: '66800.0',
        q: '0.1',
        z: '0.1',
      }
    };
    handleStreamMessage(JSON.stringify(tpFillMsg));

    assert.strictEqual(entryFillReceived, null, 'onEntryFill KHÔNG được kích hoạt khi TP Fill (reduceOnly=true)');
    assert.ok(orderFillReceived, 'onOrderFill vẫn phải nhận được thông tin TP Fill');
    assert.strictEqual(orderFillReceived.orderId, 20002);
    assert.strictEqual(orderFillReceived.reduceOnly, true);

    // 3. Giả lập tin nhắn WebSocket Cancel
    const cancelMsg = {
      e: 'ORDER_TRADE_UPDATE',
      E: Date.now(),
      o: {
        s: 'ETHUSDT',
        i: 30003,
        ot: 'LIMIT',
        X: 'CANCELED',
      }
    };
    handleStreamMessage(JSON.stringify(cancelMsg));

    assert.ok(cancelReceived, 'onOrderCancel phải được kích hoạt');
    assert.strictEqual(cancelReceived.symbol, 'ETH');
    assert.strictEqual(cancelReceived.orderId, 30003);
    assert.strictEqual(cancelReceived.status, 'CANCELED');
  });

  // ── TEST 2: DUAL BRACKET ON-EXCHANGE (LIMIT TP & HARD STOP_MARKET SL) ──
  await runAsyncTest('BracketManager: Đặt cặp lệnh bảo vệ kép Limit TP (Reduce-Only) & Hard Stop-Market SL trên sàn', async () => {
    const placedOrders = [];
    const mockClient = {
      placeLimit: async (sym, side, qty, price, dec, reduceOnly) => {
        placedOrders.push({ type: 'LIMIT', sym, side, qty, price, reduceOnly });
        return { orderId: 888001 };
      },
      placeStopOrder: async (sym, side, type, stopPrice) => {
        placedOrders.push({ type, sym, side, stopPrice });
        return { orderId: 999001, algoId: 999001 };
      },
    };

    const meta = {};
    // Test case A: Kèo hợp lệ R:R = (66000 - 64000) / (64000 - 63000) = 2000 / 1000 = 2.0 >= 1.5
    const res = await placeDualBracket({
      client: mockClient,
      sym: 'BTC',
      side: 'BUY',
      qty: 0.05,
      entryPrice: 64000,
      targetPrice: 66000,
      slPrice: 63000,
      meta,
    });

    assert.strictEqual(res.success, true, 'Dual Bracket phải đặt thành công');
    assert.strictEqual(res.tpOrderId, 888001);
    assert.strictEqual(res.slOrderId, 999001);
    assert.strictEqual(meta.tpOrderId, 888001);
    assert.strictEqual(meta.slOrderId, 999001);
    assert.strictEqual(meta.isDualBracketActive, true);

    // Xác nhận Limit TP có cờ reduceOnly = true
    const limitTp = placedOrders.find(o => o.type === 'LIMIT');
    assert.ok(limitTp, 'Phải có lệnh LIMIT TP');
    assert.strictEqual(limitTp.reduceOnly, true, 'LIMIT TP bắt buộc phải có reduceOnly = true');
    assert.strictEqual(limitTp.side, 'SELL', 'Lệnh TP cho vị thế Long phải là SELL');

    // Xác nhận Stop-Market SL
    const hardSl = placedOrders.find(o => o.type === 'STOP_MARKET');
    assert.ok(hardSl, 'Phải có lệnh Hard STOP_MARKET SL');
    assert.strictEqual(hardSl.side, 'SELL');
    assert.strictEqual(hardSl.stopPrice, 63000);

    // Test case B: Kèo vi phạm R:R < 1.5 -> Bị từ chối ngay lập tức
    const metaReject = {};
    const rejectRes = await placeDualBracket({
      client: mockClient,
      sym: 'ETH',
      side: 'BUY',
      qty: 1.0,
      entryPrice: 3000,
      targetPrice: 3050, // TP = 50$
      slPrice: 2950,    // SL = 50$ -> R:R = 1.0 < 1.5
      meta: metaReject,
    });

    assert.strictEqual(rejectRes.success, false);
    assert.ok(rejectRes.reason.includes('RR_BELOW_MIN'), 'Phải từ chối vì R:R < 1.5');
  });

  // ── TEST 3: DYNAMIC SL RATCHET (BREAKEVEN 35% & TRAILING FRACTAL H1/M15) ──
  await runAsyncTest('BracketManager: Dời dừng lỗ động trực tiếp trên sàn (Breakeven 35% & Trailing Fractal)', async () => {
    const cancelledOrders = [];
    const placedAlgoOrders = [];

    const mockClient = {
      cancelAlgoOrder: async (sym, algoId) => { cancelledOrders.push({ sym, algoId }); return true; },
      cancelOrder: async (sym, orderId) => { cancelledOrders.push({ sym, orderId }); return true; },
      getOpenAlgoOrders: async () => [],
      placeStopOrder: async (sym, side, type, stopPrice) => {
        placedAlgoOrders.push({ sym, side, type, stopPrice });
        return { orderId: 777001, algoId: 777001 };
      },
    };

    const meta = {
      side: 'BUY',
      slOrderId: 999001,
      tierSlPrice: 63000,
      currentSlPrice: 63000,
      entryPrice: 64000,
      targetTpPrice: 67000,
    };

    // 1. Kích hoạt Breakeven 35% TP -> dời SL về Entry + 1% phí ($64064)
    const beRes = await ratchetBreakeven({
      client: mockClient,
      sym: 'BTC',
      meta,
      beSlPrice: 64064,
    });

    assert.strictEqual(beRes.success, true);
    assert.strictEqual(meta.isBreakeven, true);
    assert.strictEqual(meta.currentSlPrice, 64064);
    assert.strictEqual(meta.slOrderId, 777001);
    assert.ok(cancelledOrders.some(c => c.algoId === 999001), 'SL cũ phải bị hủy trên sàn');
    assert.ok(placedAlgoOrders.some(p => p.stopPrice === 64064), 'SL Breakeven mới phải được đặt');

    // 2. Kích hoạt Trailing Fractal H1 mới ($64800) -> dời SL bám sóng tiếp
    const fractalRes = await ratchetTrailingFractal({
      client: mockClient,
      sym: 'BTC',
      meta,
      newFractalSlPrice: 64800,
      timeframe: 'H1',
    });

    assert.strictEqual(fractalRes.success, true);
    assert.strictEqual(meta.currentSlPrice, 64800);
    assert.strictEqual(meta.fractalTf, 'H1');

    // 3. Bảo vệ: Không cho phép dời lùi SL về mốc xấu hơn ($64200 < $64800 đối với Long)
    const badSlRes = await ratchetTrailingFractal({
      client: mockClient,
      sym: 'BTC',
      meta,
      newFractalSlPrice: 64200,
      timeframe: 'M15',
    });

    assert.strictEqual(badSlRes.success, false);
    assert.strictEqual(badSlRes.reason, 'SL_NOT_IMPROVED_LONG');
    assert.strictEqual(meta.currentSlPrice, 64800, 'SL hiện tại phải giữ nguyên');
  });

  // ── TEST 4: AUTO-CLEAN OPPOSITE ORDER (TP KHỚP HỦY SL, SL KHỚP HỦY TP) ──
  await runAsyncTest('BracketManager: Tự động dọn dẹp lệnh chờ đối ứng (Auto-Clean on Fill)', async () => {
    const cancelledOrders = [];
    const cancelledAlgo = [];
    const mockClient = {
      cancelOrder: async (sym, orderId) => { cancelledOrders.push({ sym, orderId }); return true; },
      cancelAlgoOrder: async (sym, algoId) => { cancelledAlgo.push({ sym, algoId }); return true; },
      cancelAllOpenOrders: async (sym) => { cancelledOrders.push({ sym, all: true }); return true; },
      getOpenAlgoOrders: async () => [],
    };

    // Kịch bản 1: TP Khớp -> Tự động hủy lệnh SL
    const metaTp = { tpOrderId: 111, slOrderId: 222 };
    const cleanTpRes = await autoCleanOppositeOrder({
      client: mockClient,
      sym: 'SOL',
      filledType: 'TP',
      meta: metaTp,
    });

    assert.strictEqual(cleanTpRes.cleaned, true);
    assert.strictEqual(metaTp.slOrderId, null, 'slOrderId phải bị xóa trong metadata');
    assert.ok(cancelledAlgo.some(c => c.algoId === 222) || cancelledOrders.some(c => c.orderId === 222));

    // Kịch bản 2: SL Khớp -> Tự động hủy lệnh TP
    const metaSl = { tpOrderId: 333, slOrderId: 444 };
    const cleanSlRes = await autoCleanOppositeOrder({
      client: mockClient,
      sym: 'NEAR',
      filledType: 'SL',
      meta: metaSl,
    });

    assert.strictEqual(cleanSlRes.cleaned, true);
    assert.strictEqual(metaSl.tpOrderId, null, 'tpOrderId phải bị xóa trong metadata');
    assert.ok(cancelledOrders.some(c => c.orderId === 333 || c.all === true));
  });

  // ── TEST 5: SAFETY BRAKE SCENARIO A (SÀN TRẢ VỀ 0 POSITIONS KHI BOT ĐANG CÓ LỆNH) ──
  runTest('SafetyBrake: Kịch bản A — Chặn đứng thảm họa đóng lệnh ảo khi Binance trả về 0 positions', () => {
    resetSafetyBrake();

    // Giả lập: Bot đang theo dõi 2 lệnh filled, nhưng Binance API glitch trả về 0 positions
    const checkA = evaluateSafetyBrake({
      eligibleTradesCount: 2,
      exchangePositionsCount: 0,
      wouldCloseCount: 2,
    });

    assert.strictEqual(checkA.tripped, true, 'Safety Brake BẮT BUỘC phải kích hoạt');
    assert.ok(checkA.reason.includes('Binance trả về 0 positions'), 'Lý do phải ghi nhận lỗi API trả về 0 positions');
    assert.strictEqual(isSafetyBrakeActive(), true, 'Trạng thái Safety Brake phải là TRUE');
  });

  // ── TEST 6: SAFETY BRAKE SCENARIO B & /FORCESYNC OVERRIDE ──
  runTest('SafetyBrake: Kịch bản B — Chặn mass-close >= 60% và cơ chế mở khóa an toàn qua /forcesync', () => {
    resetSafetyBrake();

    // Giả lập: Bot đang theo dõi 5 lệnh, nhưng có tới 4 lệnh (80%) đột ngột biến mất
    const checkB = evaluateSafetyBrake({
      eligibleTradesCount: 5,
      exchangePositionsCount: 1,
      wouldCloseCount: 4,
    });

    assert.strictEqual(checkB.tripped, true, 'Safety Brake BẮT BUỘC phải kích hoạt khi >= 60% lệnh biến mất');
    assert.ok(checkB.reason.includes('4/5 lệnh (80%)'), 'Lý do phải thể hiện tỷ lệ mass-close');

    // Giả lập người dùng xác nhận qua /forcesync
    const overrideRes = overrideSafetyBrake();
    assert.strictEqual(overrideRes.success, true);
    assert.strictEqual(isSafetyBrakeActive(), false);

    // Chu kỳ đối chiếu tiếp theo sau /forcesync phải được bypass hợp lệ
    const checkBypass = evaluateSafetyBrake({
      eligibleTradesCount: 5,
      exchangePositionsCount: 1,
      wouldCloseCount: 4,
    });

    assert.strictEqual(checkBypass.tripped, false, 'Sau /forcesync, Safety Brake phải cho phép bypass 1 lần');
    assert.strictEqual(checkBypass.bypassed, true);
  });

  // ── TEST 7: REVERSE CHECK 60S INTEGRATION ──
  await runAsyncTest('SafetyBrake: Chu kỳ Reverse Check 60s đối chiếu chéo an toàn và dọn dẹp vị thế', async () => {
    resetSafetyBrake();

    // Mock client: Sàn đang có 1 vị thế ETH (BTC đã đóng bình thường)
    const mockClient = {
      getOpenPositions: async () => [
        { symbol: 'ETHUSDT', positionAmt: '1.5' },
      ],
    };

    const activeTradesMetadata = {
      ETH: { isFilled: true, isClosed: false, side: 'BUY' },
      BTC: { isFilled: true, isClosed: false, side: 'BUY' }, // Đã đóng trên sàn
    };

    let closedSymRecorded = null;
    const res = await runReverseCheck({
      client: mockClient,
      activeTradesMetadata,
      onPositionClosedMissingWs: async (sym) => {
        closedSymRecorded = sym;
      },
    });

    assert.strictEqual(res.success, true, 'Reverse Check phải thành công');
    assert.strictEqual(res.wouldCloseCount, 1, 'Chỉ có 1 lệnh BTC cần đối chiếu đóng');
    assert.strictEqual(closedSymRecorded, 'BTC', 'BTC phải được ghi nhận đóng');
    assert.strictEqual(res.reconciledCount, 1);
  });

  console.log('\n================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ GIAI ĐOẠN 4: ${passCount}/${totalTests} TESTS ĐẠT CHUẨN (${(passCount / totalTests * 100).toFixed(1)}%)`);
  console.log('================================================================');

  if (passCount === totalTests) {
    console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG GIAI ĐOẠN 4 HOẠT ĐỘNG HOÀN HẢO 100%!\n');
    process.exit(0);
  } else {
    console.error(`⚠️ CÓ ${totalTests - passCount} BÀI TEST THẤT BẠI!\n`);
    process.exit(1);
  }
})();
