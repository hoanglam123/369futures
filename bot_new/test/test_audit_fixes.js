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

  await test('bot-new: BE @ 50% TP không kích hoạt non ở 40% TP, chỉ khóa BE ở >= 50% TP với đệm phí thực 0.14% giá', async () => {
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
      targetPrice: 2100, // +100 -> 50% TP = 2050
      slPrice: 1950,
      leverage: 10,
      binanceSlOrderId: 'old_sl_1',
    };
    // 40% TP (2040) -> CHƯA đủ 50% TP, không được kéo BE sớm
    const resEarly = await tradeMonitorNew.checkAndApplyFractalTrailingSL(trade, 2040, {
      forceEnable: true,
      forceCheck: true,
      skipSave: true,
      silent: true,
      client: mockClient,
      h1Candles: [],
      retryDelayMs: 1,
    });
    assert.strictEqual(resEarly.moved, false);
    assert.strictEqual(resEarly.reason, 'BELOW_BE_TRIGGER');
    assert.strictEqual(calls.length, 0);

    // 55% TP (2055) -> Đạt ngưỡng >= 50% TP, kéo BE = 2000 * 1.0014 = 2002.8
    const res = await tradeMonitorNew.checkAndApplyFractalTrailingSL(trade, 2055, {
      forceEnable: true,
      forceCheck: true,
      skipSave: true,
      silent: true,
      client: mockClient,
      h1Candles: [], // Chưa có fractal swing -> chỉ chạy Stage 1 BE 50%
      retryDelayMs: 1,
    });
    assert.strictEqual(res.moved, true);
    assert.strictEqual(res.stage, 'BREAKEVEN');
    assert.strictEqual(trade.slMovedToBreakeven, true);
    assert.strictEqual(trade.binanceSlOrderId, '9000000000000000123');
    assert.strictEqual(trade.slPrice, 2002.8, `Expected exact 0.14% fee buffer BE SL 2002.8, got ${trade.slPrice}`);
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

  await test('bot-h4: aiReviewer áp dụng spreadWideMult cho SPREAD_WIDE_DANGER & xuất expectedValueRoi thực tế', async () => {
    const resTight = aiReviewerH4.evaluateSignalWithAI(
      { symbol: 'BTC', signal: 'LONG', score: 9.0, marketCapRank: 1, gridWidthPct: 3.0, targetLevel: 60000, slPct: 2.0, tpPct: 4.0, leverage: 5, scoreReasons: [] },
      { microstructure: { spread: 'SPREAD_TIGHT_SAFE', wall: 'WALL_CLEAR_PATH' } }
    );
    const resWide = aiReviewerH4.evaluateSignalWithAI(
      { symbol: 'BTC', signal: 'LONG', score: 9.0, marketCapRank: 1, gridWidthPct: 3.0, targetLevel: 60000, slPct: 2.0, tpPct: 4.0, leverage: 5, scoreReasons: [] },
      { microstructure: { spread: 'SPREAD_WIDE_DANGER', wall: 'WALL_CLEAR_PATH' } }
    );
    assert.ok(typeof resTight.expectedValueRoi === 'number', 'Phải trả về expectedValueRoi');
    assert.ok(resWide.winProbability < resTight.winProbability, `SPREAD_WIDE_DANGER (${resWide.winProbability}%) phải thấp hơn SPREAD_TIGHT_SAFE (${resTight.winProbability}%)`);

    // Kiểm tra Net EV trừ phí thực 0.12% theo đòn bẩy thực (SL 2%, TP 2% với WinProb thấp -> EV âm -> từ chối)
    const resNegEv = aiReviewerH4.evaluateSignalWithAI(
      { symbol: 'ALT', signal: 'LONG', score: 5.5, marketCapRank: 120, gridWidthPct: 2.0, targetLevel: 1.0, slPct: 3.0, tpPct: 1.5, leverage: 10, scoreReasons: [] },
      { microstructure: { spread: 'SPREAD_WIDE_DANGER', wall: 'WALL_BLOCKING_TARGET' } }
    );
    assert.ok(resNegEv.expectedValueRoi < 0.5, `Kèo R:R 0.5 + wall chặn phải có Net EV < 0.5%, thực tế: ${resNegEv.expectedValueRoi}%`);
    assert.strictEqual(resNegEv.isApproved, false, 'Kèo Net EV âm phải bị từ chối');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PART C: BUSINESS LOGIC UPGRADES (GÓI A Ý 1-2 & GÓI C Ý 1-2)
  // ═══════════════════════════════════════════════════════════════════════════
  const scorerNew = require('../src/services/confluenceScorer');
  const gatekeeperNew = require('../src/services/riskGatekeeper');
  const bounceCancelNew = require('../src/services/bounceCancel');
  const scorerH4 = require('../../src/pp369/confluenceScorer');

  await test('Gói A Ý 1: Đối xứng BTC Uptrend SHORT Veto hoạt động trên CẢ bot-new và bot-h4', async () => {
    const bullBtcTA = {
      aboveEMA200: true,
      regime: 'TRENDING_UP',
      rsi: { '1d': 58, '4h': 60 },
      ema: { e7: 100000, e25: 98000, e99: 94000, e200d: 85000 },
    };
    const altTA = {
      price: 100,
      aboveEMA200: false,
      ema: { e7: 98, e25: 101, e99: 105, e200d: 110 },
      ema1h: { e7: 99, e25: 100.5 },
      rsi: { '4h': 48, '1d': 45 },
      bb: { bandwidth: 5 },
    };

    const resNew = scorerNew.scoreSetup('SOL', 'SHORT', altTA, {}, {}, null, {}, {}, bullBtcTA, null);
    assert.strictEqual(resNew.disqualified, true, 'bot-new phải VETO Altcoin SHORT khi BTC đang TRENDING_UP trên EMA200D');
    assert.ok(resNew.disqualifyReason && resNew.disqualifyReason.includes('BTC'), `Lý do veto phải nhắc BTC: ${resNew.disqualifyReason}`);

    const resH4 = scorerH4.scoreSetup('SOL', 'SHORT', altTA, {}, {}, null, {}, {}, bullBtcTA, null);
    assert.strictEqual(resH4.disqualified, true, 'bot-h4 phải VETO Altcoin SHORT khi BTC đang TRENDING_UP trên EMA200D');
    assert.ok(resH4.disqualifyReason && resH4.disqualifyReason.includes('BTC'), `Lý do veto phải nhắc BTC: ${resH4.disqualifyReason}`);
  });

  await test('Gói A Ý 1: bot-h4 calcTAFromKlines tính và trả về ema1h.e7 / ema1h.e25 đầy đủ', async () => {
    const mk = (n, start, step) => Array.from({ length: n }, (_, i) => ({
      t: i * 3600_000, o: start + i * step, h: start + i * step + 1, l: start + i * step - 1, c: start + i * step + 0.5, v: 1000
    }));
    const ta = scorerH4.calcTAFromKlines('ETH', mk(60, 2000, 2), mk(120, 1800, 3), mk(220, 1200, 4), null);
    assert.ok(ta.ema1h && typeof ta.ema1h.e7 === 'number' && typeof ta.ema1h.e25 === 'number', 'bot-h4 TA phải có ema1h.e7 và ema1h.e25');
    assert.ok(ta.ema && typeof ta.ema.e200d === 'number', 'bot-h4 TA với 220 nến D1 phải tính được EMA200D');
    assert.strictEqual(ta.aboveEMA200, true, 'Giá tăng đều trên EMA200D phải trả aboveEMA200 = true');
  });

  await test('Gói C Ý 1: bounceCancel.addLevelCooldown khóa tái đặt lệnh sau LIMIT Timeout', async () => {
    bounceCancelNew.clearBounceCooldowns();
    bounceCancelNew.addLevelCooldown('TESTCOIN', 123.45, 30 * 60_000);
    assert.strictEqual(bounceCancelNew.isLevelBounceCooldown('TESTCOIN', 123.45), true, 'Mốc vừa bị timeout phải đang trong trạng thái cooldown');
    const activeCds = bounceCancelNew.getBounceCooldowns();
    const entry = activeCds.find(c => c.key === 'TESTCOIN_123.45');
    assert.ok(entry && entry.remainingMins >= 25 && entry.remainingMins <= 30, `Remaining cooldown phải ~30m, thực tế: ${JSON.stringify(entry)}`);
    bounceCancelNew.clearBounceCooldowns();
  });

  await test('Gói C Ý 2: bot-new riskGatekeeper trả expectedValueRoi & chặn kèo Net EV âm sau phí 0.12%', async () => {
    const badEv = gatekeeperNew.evaluateSignal(
      { symbol: 'ALT', signal: 'LONG', targetLevel: 1.0, score: 6.5, marketCapRank: 80, slPct: 4.0, tpPct: 1.0, leverage: 10 },
      { spreadPct: 0.02 }
    );
    assert.ok(typeof badEv.expectedValueRoi === 'number', 'riskGatekeeper phải trả expectedValueRoi');
    assert.ok(badEv.expectedValueRoi < 0.5, `R:R 0.25 phải có Net EV < 0.5%, thực tế: ${badEv.expectedValueRoi}%`);
    assert.strictEqual(badEv.isApproved, false, 'Kèo Net EV âm phải bị Gatekeeper chặn');
  });

  await test('Gói C Ý 2: train_ai_model.py không còn hardcode Telegram Token & giảm trọng số Shadow xuống <= 0.40', async () => {
    const pySrc = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'train_ai_model.py'), 'utf8');
    assert.ok(!pySrc.includes('AAGTEgJNmAegGPmWUgvd3Lpvtbefv-yn6pg'), 'train_ai_model.py không được hardcode Telegram Bot Token');
    assert.ok(!pySrc.includes('1663202780'), 'train_ai_model.py không được hardcode Telegram Chat ID');
    assert.ok(pySrc.includes('0.40') && pySrc.includes('--bot'), 'train_ai_model.py phải giảm trọng số shadow (0.40) và hỗ trợ --bot');
  });

  await test('Đồng bộ Nearby & Top-8 Rotation: getNearbySymbols loại coin thiếu mốc & lưới <1.5%/>30% trên CẢ 2 bot', async () => {
    const streamNew = require('../src/pp369/stream');
    const streamH4 = require('../../src/pp369/stream');
    const syms = ['VALID_NEAR', 'NO_LEVEL', 'NARROW_GRID', 'WIDE_GRID', 'FAR_COIN'];
    const levelCache = {
      VALID_NEAR:  { longEntry: 100, shortEntry: 104, step: 4 },    // grid 4% -> hợp lệ, giá 100.3 cách 0.3% <= 0.5%
      // NO_LEVEL: không có trong cache -> phải bị loại (hết bug đếm ảo 124 coin!)
      NARROW_GRID: { longEntry: 100, shortEntry: 101, step: 1 },    // grid 1% < 1.5% -> phải bị loại
      WIDE_GRID:   { longEntry: 100, shortEntry: 140, step: 40 },   // grid 40% > 30% -> phải bị loại
      FAR_COIN:    { longEntry: 100, shortEntry: 105, step: 5 },    // grid 5% nhưng giá 102.5 cách 2.4% > 0.5% -> loại khi strict=true
    };
    const prices = { VALID_NEAR: 100.3, NO_LEVEL: 50, NARROW_GRID: 100.1, WIDE_GRID: 100.2, FAR_COIN: 102.5 };

    const nearNew = streamNew.getNearbySymbols(syms, levelCache, 0.005, true, prices);
    const nearH4  = streamH4.getNearbySymbols(syms, levelCache, 0.005, true, prices);
    assert.deepStrictEqual(nearNew, ['VALID_NEAR'], `bot-new chỉ được giữ VALID_NEAR, thực tế: ${JSON.stringify(nearNew)}`);
    assert.deepStrictEqual(nearH4,  ['VALID_NEAR'], `bot-h4 chỉ được giữ VALID_NEAR, thực tế: ${JSON.stringify(nearH4)}`);

    // Kiểm tra code rotation & refresh mốc đã đồng bộ ở cả 2 file
    const jobSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'job.js'), 'utf8');
    const h4Src  = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'trader', 'autoTrade.js'), 'utf8');
    assert.ok(jobSrc.includes('POLL_ROTATION_TTL_MS') && jobSrc.includes('prePopulateLevelCache(symbols, getPrices())'), 'bot-new phải có xoay vòng Top 8 và refresh levelCache định kỳ');
    assert.ok(h4Src.includes('POLL_ROTATION_TTL_MS') && h4Src.includes('MAX_SIGNAL_QUEUE_LEN'), 'bot-h4 phải có xoay vòng Top 8 và giới hạn chiều dài signalCheckQueue');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PART D: BOT-NEW AI GATEKEEPER & SHADOW TRACKER SYNC (GÓI 1 & GÓI 2)
  // ═══════════════════════════════════════════════════════════════════════════
  const shadowNew = require('../src/services/shadowTracker');

  await test('Gói 1: riskGatekeeper chặn thưởng Pinbar khi dính hasCriticalRisk, tách rõ Vi phạm/Hỗ trợ & đồng bộ vi cấu trúc M15/Vol', async () => {
    const sig = { symbol: 'LOWCAP', signal: 'LONG', targetLevel: 10.0, score: 8.5, marketCapRank: 250, slPct: 2.0, tpPct: 4.0, leverage: 5 };
    const pinbarH1 = { open: 10.08, close: 10.12, high: 10.15, low: 9.85 };

    // 1. Khi có INTERACTION_STALE_BOUNCE_RUNAWAY (critical risk), H1_REJECT_PINBAR KHÔNG được cộng thưởng (+40% cũ)
    const resCrit = gatekeeperNew.evaluateSignal(sig, {
      candleH1: pinbarH1,
      preEntryBouncePct: 1.8,
      spreadPct: 0.07 // Rank 250 (lowcap threshold 0.08) -> chỉ SPREAD_MEDIUM_CAUTION, không bị phạt oan SPREAD_WIDE_DANGER!
    });
    assert.strictEqual(resCrit.features.spread_slippage, 'SPREAD_MEDIUM_CAUTION', 'Lowcap Rank 250 spread 0.07% phải là CAUTION, không phải DANGER');
    assert.ok(!resCrit.keyFactors.some(f => f.includes('H1_REJECT_PINBAR (+')), `Pinbar không được cộng thưởng khi đang critical risk: ${JSON.stringify(resCrit.keyFactors)}`);
    assert.ok(typeof resCrit.approvalThresholdPct === 'number' && resCrit.approvalThresholdPct >= 30, 'Phải trả approvalThresholdPct động từ mô hình AI');

    // 2. Phát hiện MARUBOZU xả dốc, OPPOSING_WICK_TRAP & VOL_BURST_DANGER
    const marubozuDump = { open: 10.20, high: 10.21, low: 9.95, close: 9.96 };
    const resBurst = gatekeeperNew.evaluateSignal(sig, { candleM15: marubozuDump, m15VolRatio: 3.5 });
    assert.strictEqual(resBurst.features.candle_shape, 'CANDLE_MARUBOZU_DUMP', 'Phải nhận diện CANDLE_MARUBOZU_DUMP');
    assert.strictEqual(resBurst.features.realtime_volume, 'VOL_BURST_DANGER', 'Phải nhận diện VOL_BURST_DANGER');
    assert.strictEqual(resBurst.isApproved, false, 'Marubozu xả dốc + nổ volume phải bị VETO');

    const oppWickCandle = { open: 10.05, close: 10.02, high: 10.30, low: 10.00 };
    const resWick = gatekeeperNew.evaluateSignal(sig, { candleM15: oppWickCandle });
    assert.strictEqual(resWick.features.wick_rejection, 'OPPOSING_WICK_TRAP', 'Râu trên dài >=50% khi LONG phải kích hoạt OPPOSING_WICK_TRAP');

    // 3. Kiểm tra signalEngine.js đã dùng realRank thay vì hardcode isTier1 ? 20 : 100
    const seSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'signalEngine.js'), 'utf8');
    assert.ok(seSrc.includes('rank: realRank') && seSrc.includes('marketCapRank: realRank'), 'signalEngine phải truyền realRank vào riskGatekeeper');
    assert.ok(!seSrc.includes('>= 40% [Risk Gatekeeper]'), 'signalEngine không được in cứng >= 40% trong log AI APPROVED');
  });

  await test('Gói 2: bot-new ShadowTracker hỗ trợ PENDING_LIMIT, BE 50% TP (+0.14%), Fractal Trailing SL & tính USD theo margin/leverage thật', async () => {
    shadowNew.clearActiveShadowsForTest();

    // 1. Chờ khớp Limit (markPrice 102 > entry 100 cho LONG -> PENDING_LIMIT)
    const p1 = shadowNew.registerShadowTrade({
      symbol: 'ETH_TEST',
      direction: 'LONG',
      entryPrice: 100,
      markPrice: 102,
      slPrice: 98,
      tpPrice: 104,
      leverage: 10,
      margin: 20,
      gridWidthPct: 4.0,
      total: 8.5
    }, 'TEST_PENDING_LIMIT');
    assert.strictEqual(p1.status, 'PENDING_LIMIT', 'Giá hiện tại > Entry LONG phải ở trạng thái PENDING_LIMIT');
    assert.strictEqual(p1.isFilled, false);
    assert.strictEqual(shadowNew.isShadowPositionActive('ETH_TEST', 'LONG'), true, 'PENDING_LIMIT phải được tính là active shadow để chống spam');

    // Giá chưa chạm 100 (101) -> chưa khớp, không tính TP/SL
    let res = shadowNew.updateShadowPrices({ ETH_TEST: 101 });
    assert.strictEqual(res.length, 0);

    // Giá chạm 100 -> khớp Limit -> ACTIVE
    res = shadowNew.updateShadowPrices({ ETH_TEST: 100 });
    assert.strictEqual(res.length, 0);
    assert.strictEqual(shadowNew.getActiveShadowPositions()[p1.id].status, 'ACTIVE', 'Chạm Entry 100 phải chuyển sang ACTIVE');

    // Chạm 50% TP (102) -> kích hoạt BE @ 100 * 1.0014 = 100.14
    res = shadowNew.updateShadowPrices({ ETH_TEST: 102.1 });
    assert.strictEqual(res.length, 0);
    const activeAfterBe = shadowNew.getActiveShadowPositions()[p1.id];
    assert.strictEqual(activeAfterBe.isBeTriggered, true, 'Chạm 50% TP phải kích hoạt BE');
    assert.ok(Math.abs(activeAfterBe.slPrice - 100.14) < 1e-6, `SL BE phải có đệm phí 0.14% (100.14), thực tế: ${activeAfterBe.slPrice}`);

    // Kiểm tra Williams Fractal Trailing SL (tạo đáy fractal tại 101.5 -> candidate SL = 101.5 * 0.9985 = 101.34775)
    const now = Date.now();
    const mockCandles = [
      { openTime: now + 1 * 3600_000, open: 102.0, high: 102.5, low: 101.8, close: 102.2 },
      { openTime: now + 2 * 3600_000, open: 102.2, high: 102.4, low: 101.7, close: 101.9 },
      { openTime: now + 3 * 3600_000, open: 101.9, high: 102.1, low: 101.5, close: 102.0 }, // Fractal Low = 101.5
      { openTime: now + 4 * 3600_000, open: 102.0, high: 102.6, low: 101.8, close: 102.5 },
      { openTime: now + 5 * 3600_000, open: 102.5, high: 103.0, low: 102.2, close: 102.8 },
      { openTime: now + 6 * 3600_000, open: 102.8, high: 103.2, low: 102.6, close: 103.1 }, // live candle
    ];
    const trailed = shadowNew.applyFractalTrailingSl(activeAfterBe, mockCandles, 'H1', 3600_000);
    assert.strictEqual(trailed, true, 'Fractal Low 101.5 phải dời SL lên 101.34775');
    assert.ok(Math.abs(activeAfterBe.slPrice - 101.5 * 0.9985) < 1e-4, `SL Fractal không khớp: ${activeAfterBe.slPrice}`);

    // Giá quay về chạm SL trailing 101.30 -> chốt SAVED_BE với lãi USD thực theo margin $20 * 10x!
    res = shadowNew.updateShadowPrices({ ETH_TEST: 101.30 });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].status, 'SAVED_BE', 'Chạm SL sau khi đã BE/Fractal phải đóng là SAVED_BE');
    assert.strictEqual(res[0].outcome, 'SAVED_BE');
    assert.ok(res[0].pnlUsd > 2.5 && res[0].pnlUsd < 2.9, `PnL USD phải tính theo margin $20 * 10x (~+$2.70), thực tế: $${res[0].pnlUsd}`);

    // 2. Test BOUNCE_CANCEL khi giá nảy xa trước khi khớp Limit
    const p2 = shadowNew.registerShadowTrade({
      symbol: 'XRP_TEST',
      direction: 'LONG',
      entryPrice: 1.0,
      markPrice: 1.005,
      slPrice: 0.98,
      tpPrice: 1.04,
      leverage: 5,
      margin: 10,
      gridWidthPct: 4.0,
      total: 8.0
    }, 'TEST_BOUNCE_CANCEL');
    assert.strictEqual(p2.status, 'PENDING_LIMIT');
    res = shadowNew.updateShadowPrices({ XRP_TEST: 1.02 }); // +2.0% >= 1.5% bounceCancelPct
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].status, 'BOUNCE_CANCEL', 'Giá nảy xa >=1.5% trước khi khớp Limit phải hủy BOUNCE_CANCEL');
    assert.strictEqual(res[0].pnlUsd, 0);

    shadowNew.clearActiveShadowsForTest();
  });

  console.log(`\n📊 Audit Regression Summary: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
