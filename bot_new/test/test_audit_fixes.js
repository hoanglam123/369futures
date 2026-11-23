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

  console.log(`\n📊 Audit Regression Summary: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
