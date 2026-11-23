'use strict';

/**
 * Comprehensive Regression Test Suite — Audit Packages 1, 2 & 3 (bot-new & bot-h4)
 *
 * Kiểm chứng toàn bộ các lỗi CRITICAL / HIGH / SECURITY đã sửa ở cả 2 bot:
 *  - bot-new: BE @ 35% TP + H1/M15 Fractal Trailing SL (bỏ TP1/TP2 cũ), One-Way Ratchet,
 *             placeDualBracket TP retry & không còn 'unknown', calcQty liq cap + string roundPrice,
 *             tradeStats dedupe, Dashboard Path Traversal / 405 GET / Bearer Auth, Axios RateLimit interceptor.
 *  - bot-h4:  19-digit orderId JSON precision, SafetyBrake single-position non-freeze,
 *             bracketManager SL rollback, no hardcoded Telegram token, aiReviewer spreadWideMult,
 *             Axios CircuitBreaker interceptor.
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_AI_AUTO_RETRAIN = 'true';
process.env.ENABLE_FRACTAL_TRAILING = 'true';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}\n     -> ${err.message}`);
    failed++;
  }
}

function makeBullishFractalCandles(swingLow) {
  // 7 nến: nến index 3 là đáy Williams Fractal rõ nét (low = swingLow), 2 nến trước & sau cao hơn
  return [
    { openTime: 1, open: swingLow + 4, high: swingLow + 6, low: swingLow + 3, close: swingLow + 5 },
    { openTime: 2, open: swingLow + 3, high: swingLow + 5, low: swingLow + 2, close: swingLow + 4 },
    { openTime: 3, open: swingLow + 2, high: swingLow + 4, low: swingLow + 1.5, close: swingLow + 2.5 },
    { openTime: 4, open: swingLow + 1, high: swingLow + 3, low: swingLow, close: swingLow + 2 },
    { openTime: 5, open: swingLow + 2, high: swingLow + 4, low: swingLow + 1.5, close: swingLow + 3.5 },
    { openTime: 6, open: swingLow + 3, high: swingLow + 6, low: swingLow + 2.5, close: swingLow + 5 },
    { openTime: 7, open: swingLow + 5, high: swingLow + 7, low: swingLow + 4, close: swingLow + 6.5 },
  ];
}

async function run() {
  console.log('\n🧪 Running Dual-Bot Audit Regression Suite (Packages 1-3)...\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // PART A: BOT-NEW
  // ═══════════════════════════════════════════════════════════════════════════
  const bracketNew = require('../src/services/bracketManager');
  const binanceNew = require('../src/services/binanceTrader');
  const tradeMonitorNew = require('../src/services/tradeMonitor');
  const dashNew = require('../src/dashboard/server');
  const rateGuardNew = require('../src/services/rateLimitGuard');

  await test('bot-new: BE @ 35% TP thực thi đặt SL hòa vốn thật lên sàn (không còn bị short-circuit)', async () => {
    const calls = [];
    const mockClient = {
      cancelAlgoOrder: async (sym, id) => { calls.push(['cancel', sym, id]); },
      placeStopOrder: async (sym, side, type, price) => {
        calls.push(['placeStop', sym, side, type, price]);
        return { algoId: '9000000000000000123' };
      },
    };
    const trade = {
      id: 't_be_1',
      symbol: 'ETH',
      direction: 'LONG',
      status: 'active',
      entryFilled: true,
      entryPrice: 2000,
      targetPrice: 2100, // +100 -> 35% TP = 2035
      slPrice: 1950,
      leverage: 10,
      binanceSlOrderId: 'old_sl_1',
    };
    const res = await tradeMonitorNew.checkAndApplyFractalTrailingSL(trade, 2040, {
      forceEnable: true,
      forceCheck: true,
      skipSave: true,
      silent: true,
      client: mockClient,
      h1Candles: [], // Chưa có fractal swing -> chỉ chạy Stage 1 BE 35%
      retryDelayMs: 1,
    });
    assert.strictEqual(res.moved, true);
    assert.strictEqual(res.stage, 'BREAKEVEN');
    assert.strictEqual(trade.slMovedToBreakeven, true);
    assert.strictEqual(trade.binanceSlOrderId, '9000000000000000123');
    assert.ok(trade.slPrice > 2000, `Expected BE SL > 2000, got ${trade.slPrice}`);
    assert.ok(calls.some(c => c[0] === 'cancel' && c[2] === 'old_sl_1'));
    assert.ok(calls.some(c => c[0] === 'placeStop' && c[3] === 'STOP_MARKET'));
  });

  await test('bot-new: One-Way Ratchet không bao giờ kéo SL đi lùi (Fractal không hạ thấp hơn BE SL)', async () => {
    const mockClient = {
      cancelAlgoOrder: async () => {},
      placeStopOrder: async () => ({ algoId: 'sl_new_2' }),
    };
    const trade = {
      id: 't_ratchet_1',
      symbol: 'ETH',
      direction: 'LONG',
      status: 'active',
      entryFilled: true,
      entryPrice: 2000,
      targetPrice: 2100,
      slPrice: 2002, // Đã khóa BE @ 2002
      currentSlPrice: 2002,
      slMovedToBreakeven: true,
      leverage: 10,
      binanceSlOrderId: 'sl_be',
    };
    // Fractal đáy ở 1990 (< 2002) -> phải TỪ CHỐI kéo lùi SL
    const resBad = await tradeMonitorNew.checkAndApplyFractalTrailingSL(trade, 2050, {
      forceEnable: true,
      forceCheck: true,
      skipSave: true,
      silent: true,
      client: mockClient,
      h1Candles: makeBullishFractalCandles(1990),
      retryDelayMs: 1,
    });
    assert.strictEqual(resBad.moved, false);
    assert.strictEqual(resBad.reason, 'NOT_BETTER_THAN_CURRENT_SL');
    assert.strictEqual(trade.slPrice, 2002);

    // Fractal đáy ở 2030 (> 2002) -> phải NÂNG SL lên 2030 * (1 - 0.0015) ≈ 2026.96
    const resGood = await tradeMonitorNew.checkAndApplyFractalTrailingSL(trade, 2060, {
      forceEnable: true,
      forceCheck: true,
      skipSave: true,
      silent: true,
      client: mockClient,
      h1Candles: makeBullishFractalCandles(2030),
      retryDelayMs: 1,
    });
    assert.strictEqual(resGood.moved, true);
    assert.strictEqual(resGood.stage, 'FRACTAL');
    assert.ok(trade.slPrice > 2020 && trade.slPrice < 2030);
    assert.strictEqual(trade.fractalSlPrice, trade.slPrice);
  });

  await test('bot-new: placeDualBracket thực sự retry khi TP fail lần đầu & không gán ID "unknown"', async () => {
    let tpAttempts = 0;
    const mockClient = {
      placeTPAfterEntry: async () => {
        tpAttempts++;
        if (tpAttempts === 1) return null; // Lần 1 trả null -> phải throw để retry!
        return '1234567890123456789';
      },
      placeStopOrder: async () => ({}), // Response rỗng -> phải trả null, KHÔNG trả 'unknown'
    };
    const meta = {};
    const res = await bracketNew.placeDualBracket({
      client: mockClient,
      sym: 'SOL',
      side: 'BUY',
      qty: 1,
      entryPrice: 100,
      targetPrice: 110,
      slPrice: 95,
      meta,
      retryDelayMs: 1,
    });
    assert.strictEqual(tpAttempts, 2, 'TP phải được retry khi lần 1 trả null');
    assert.strictEqual(res.tpOrderId, '1234567890123456789');
    assert.strictEqual(res.slOrderId, null, 'SL lỗi không được gán chuỗi "unknown"');
    assert.notStrictEqual(meta.binanceSlOrderId, 'unknown');
  });

  await test('bot-new: calcQty khóa trần đòn bẩy theo slPct (chống cháy trước SL)', async () => {
    // slPct = 6% -> liqSafeCap = floor(1 / (1.5*0.06 + 0.01)) = floor(1 / 0.10) = 10x
    // Dù minNotional cần 20x, calcQty KHÔNG được nâng đòn bẩy vượt 10x!
    const info = { stepSize: 0.001, minQty: 0.001, minNotional: 100, quantityPrecision: 3, pricePrecision: 2 };
    const res = await binanceNew.calcQty('ALT', 100, 5, info, 6, 8, 6.0);
    assert.ok(res.effectiveLeverage <= 10, `Đòn bẩy ${res.effectiveLeverage}x vượt trần an toàn 10x`);
    // Với balance $8 và max 10x -> max notional $80 < $100 -> phải từ chối (qty=0) thay vì đẩy 25x!
    assert.strictEqual(res.qty, 0);
  });

  await test('bot-new: Dashboard chặn Path Traversal /api/logs & từ chối GET /api/trades/delete (405) & kiểm tra Bearer Auth', async () => {
    const trav = dashNew.apiLogs('/api/logs?date=../../.env');
    assert.ok(trav.error && trav.lines.length === 0, 'Phải chặn path traversal ở /api/logs');

    let status405 = 0;
    const mockRes405 = { writeHead: (code) => { status405 = code; }, end: () => {} };
    dashNew.handleApi({ method: 'GET', url: '/api/trades/delete?id=1', headers: {} }, mockRes405);
    assert.strictEqual(status405, 405, 'GET /api/trades/delete phải trả 405 Method Not Allowed');

    process.env.DASHBOARD_AUTH_TOKEN = 'secret_test_token_369';
    try {
      let status401 = 0;
      const mockRes401 = { writeHead: (code) => { status401 = code; }, end: () => {} };
      dashNew.handleApi({ method: 'GET', url: '/api/health', headers: {} }, mockRes401);
      assert.strictEqual(status401, 401, 'Thiếu Bearer token phải trả 401');
    } finally {
      delete process.env.DASHBOARD_AUTH_TOKEN;
    }
  });

  await test('bot-new: rateLimitGuard Axios Request Interceptor chặn call tới binance.com khi đang bị Ban', async () => {
    const axios = require('axios');
    rateGuardNew.triggerCircuitBreaker(Date.now() + 30_000, 'UnitTest');
    let blocked = false;
    try {
      await axios.get('https://fapi.binance.com/fapi/v1/time', { timeout: 1000 });
    } catch (err) {
      if (err.code === 'EBINANCE_CIRCUIT_OPEN') blocked = true;
    } finally {
      rateGuardNew.resetRateLimitForTest();
    }
    assert.strictEqual(blocked, true, 'Axios request interceptor phải chặn request tới binance.com');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PART B: BOT-H4
  // ═══════════════════════════════════════════════════════════════════════════
  const streamH4 = require('../../src/trader/binanceStream');
  const safetyBrakeH4 = require('../../src/trader/safetyBrake');
  const bracketH4 = require('../../src/trader/bracketManager');
  const aiReviewerH4 = require('../../src/pp369/aiReviewer');

  await test('bot-h4: binanceStream bảo toàn nguyên vẹn orderId 19 chữ số (không mất 3 số cuối)', async () => {
    let captured = null;
    streamH4.clearCallbacks();
    streamH4.onOrderFill((payload) => { captured = payload; });
    const rawMsg = '{"e":"ORDER_TRADE_UPDATE","E":1700000000000,"o":{"s":"ETHUSDT","c":"c1","S":"SELL","ot":"STOP_MARKET","q":"1.5","ap":"2100.5","X":"FILLED","i":9123456789012345678,"ai":9988776655443322119,"z":"1.5","R":true,"cp":true}}';
    streamH4.handleMessage(rawMsg);
    streamH4.clearCallbacks();
    assert.ok(captured, 'Phải nhận được payload fill');
    assert.strictEqual(captured.orderId, '9123456789012345678', 'orderId 19 chữ số phải giữ chính xác dạng string');
    assert.strictEqual(captured.algoId, '9988776655443322119', 'algoId 19 chữ số phải giữ chính xác dạng string');
    assert.strictEqual(captured.closePosition, true);
  });

  await test('bot-h4: SafetyBrake KHÔNG khóa cứng khi đóng 1 vị thế đơn lẻ, nhưng CHẶN khi >= 2 vị thế biến mất', async () => {
    safetyBrakeH4.resetSafetyBrake();
    const singleClose = safetyBrakeH4.evaluateSafetyBrake({
      eligibleTradesCount: 1,
      exchangePositionsCount: 0,
      wouldCloseCount: 1,
    });
    assert.strictEqual(singleClose.tripped, false, 'Đóng 1 vị thế đơn lẻ không được kích hoạt SafetyBrake');

    const massClose = safetyBrakeH4.evaluateSafetyBrake({
      eligibleTradesCount: 2,
      exchangePositionsCount: 0,
      wouldCloseCount: 2,
    });
    assert.strictEqual(massClose.tripped, true, '2 vị thế biến mất cùng lúc phải kích hoạt SafetyBrake');
    safetyBrakeH4.resetSafetyBrake();
  });

  await test('bot-h4: bracketManager tự động Rollback SL cũ khi đặt SL mới thất bại', async () => {
    const placedPrices = [];
    let attempt = 0;
    const mockClient = {
      cancelAlgoOrder: async () => {},
      cancelOrder: async () => {},
      getOpenAlgoOrders: async () => [],
      placeStopOrder: async (sym, side, type, price) => {
        attempt++;
        placedPrices.push(price);
        if (attempt === 1) throw new Error('Simulated Binance timeout');
        return { algoId: 'rollback_sl_999' };
      },
    };
    const meta = { side: 'BUY', currentSlPrice: 1950, tierSlPrice: 1950, slOrderId: 'old_sl_1' };
    const res = await bracketH4.ratchetBreakeven({
      client: mockClient,
      sym: 'ETH',
      meta,
      beSlPrice: 2002,
      currentPrice: 2050,
    });
    assert.strictEqual(res.success, false);
    assert.deepStrictEqual(placedPrices, [2002, 1950], 'Phải gọi đặt lại SL cũ 1950 ngay khi SL mới 2002 lỗi');
    assert.strictEqual(meta.slOrderId, 'rollback_sl_999');
  });

  await test('bot-h4: telegram.js không còn hardcode Live Telegram Bot Token trong mã nguồn', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pp369', 'telegram.js'), 'utf8');
    assert.ok(!src.includes('AAGTEgJNmAegGPmWUgvd3Lpvtbefv-yn6pg'), 'Không được chứa hardcoded Telegram Bot Token');
  });

  await test('bot-h4: aiReviewer áp dụng spreadWideMult cho SPREAD_WIDE_DANGER & xuất expectedValueRoi', async () => {
    const resTight = aiReviewerH4.evaluateSignalWithAI(
      { symbol: 'BTC', signal: 'LONG', score: 9.0, marketCapRank: 1, gridWidthPct: 3.0, targetLevel: 60000, scoreReasons: [] },
      { microstructure: { spread: 'SPREAD_TIGHT_SAFE', wall: 'WALL_CLEAR_PATH' } }
    );
    const resWide = aiReviewerH4.evaluateSignalWithAI(
      { symbol: 'BTC', signal: 'LONG', score: 9.0, marketCapRank: 1, gridWidthPct: 3.0, targetLevel: 60000, scoreReasons: [] },
      { microstructure: { spread: 'SPREAD_WIDE_DANGER', wall: 'WALL_CLEAR_PATH' } }
    );
    assert.ok(typeof resTight.expectedValueRoi === 'number', 'Phải trả về expectedValueRoi');
    assert.ok(resWide.winProbability < resTight.winProbability, `SPREAD_WIDE_DANGER (${resWide.winProbability}%) phải thấp hơn SPREAD_TIGHT_SAFE (${resTight.winProbability}%)`);
  });

  console.log(`\n📊 Audit Regression Summary: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
