'use strict';

/**
 * test_roadmap_gap_fixes.js
 *
 * Bộ kiểm thử toàn diện cho 10 hạng mục bổ sung hoàn thiện ROADMAP_UPGRADE_FROM_BOT_H4.md:
 * 1. candleCache: kiểm tra staleness, mergeCandles & Williams Fractal 5 nến
 * 2. bracketManager: Exponential Backoff Retry (retry lỗi mạng, fail-fast lỗi -2021 + restore SL)
 * 3. tradeMonitor: Williams Fractal H1 (35%-70% TP) & M15 (>=70% TP) Trailing SL 1 chiều
 * 4. tierSLTP: Xóa trần SL cứng 3.5% (mở thích ứng ATR tới 6.0%) & Fibonacci Extension 1.272/1.618
 * 5. technicalAnalysis + confluenceScorer: Ma trận Trend 3 Tầng (D1 + H4 + H1) & thưởng đồng thuận
 * 6. riskGatekeeper: Trọng số ML từ ai_rule_config.json, risk_interaction, spread_slippage & khử phạt kép
 * 7. shadowTracker: Lưu đúng leverage / margin / winProbability thật (bỏ hardcode)
 * 8. job.js + dashboard server & UI: Bot Controls (Pause / Shadow Only), Proximity Heatmap, Emergency Close All
 */

process.env.DISABLE_MICROSTRUCTURE_FETCH = 'true';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const candleCache    = require('../src/services/candleCache');
const bracketManager = require('../src/services/bracketManager');
const tradeMonitor   = require('../src/services/tradeMonitor');
const tierSLTP       = require('../src/services/tierSLTP');
const taCollector    = require('../src/collectors/technicalAnalysis');
const scorer         = require('../src/services/confluenceScorer');
const gatekeeper     = require('../src/services/riskGatekeeper');
const shadowTracker  = require('../src/services/shadowTracker');
const job            = require('../src/job');
const { createServer } = require('../src/dashboard/server');

let passed = 0;
let total  = 0;

function testSync(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ [PASS] ${total}. ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ [FAIL] ${total}. ${name}\n   ${e.stack || e.message}`);
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`✅ [PASS] ${total}. ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ [FAIL] ${total}. ${name}\n   ${e.stack || e.message}`);
  }
}

function makeFractalCandles(lows, highs) {
  const base = Date.now() - lows.length * 3600_000;
  return lows.map((l, i) => ({
    openTime: base + i * 3600_000,
    open: (l + highs[i]) / 2,
    high: highs[i],
    low: l,
    close: (l + highs[i]) / 2,
    volume: 1000
  }));
}

(async () => {
  console.log('================================================================');
  console.log('🧪 KIỂM THỬ TOÀN DIỆN 10 HẠNG MỤC HOÀN THIỆN ROADMAP BOT-NEW');
  console.log('================================================================\n');

  // ── 1. candleCache staleness, merge & Williams Fractal ────────────────────
  testSync('candleCache: isCacheStale + mergeCandles + getRecentFractalSwing', () => {
    const now = Date.now();
    const fresh = [{ openTime: now - 30 * 60_000, open: 100, high: 101, low: 99, close: 100 }];
    const stale = [{ openTime: now - 3 * 3600_000, open: 100, high: 101, low: 99, close: 100 }];
    assert.strictEqual(candleCache.isCacheStale(fresh, 2 * 3600_000, now), false);
    assert.strictEqual(candleCache.isCacheStale(stale, 2 * 3600_000, now), true);

    const merged = candleCache.mergeCandles(
      [{ openTime: 1000, close: 1 }, { openTime: 2000, close: 2 }],
      [{ openTime: 2000, close: 2.5 }, { openTime: 3000, close: 3 }],
      10
    );
    assert.strictEqual(merged.length, 3);
    assert.strictEqual(merged[1].close, 2.5, 'Phải ghi đè nến trùng openTime bằng dữ liệu mới hơn');

    // Williams Fractal 5 nến Swing Low tại index 3 (low=101.0); index 6 là nến đang chạy (bị bỏ qua)
    const longCandles = makeFractalCandles(
      [105, 104, 103, 101, 102, 103, 95],
      [107, 106, 105, 103, 104, 105, 104]
    );
    const swingLow = candleCache.getRecentFractalSwing(longCandles, true);
    assert(swingLow && swingLow.price === 101, `Swing Low phải là 101 (bỏ nến cuối 95), thực tế: ${JSON.stringify(swingLow)}`);

    // Williams Fractal 5 nến Swing High tại index 3 (high=112)
    const shortCandles = makeFractalCandles(
      [100, 102, 104, 106, 104, 102, 101],
      [106, 108, 110, 112, 109, 107, 120]
    );
    const swingHigh = candleCache.getRecentFractalSwing(shortCandles, false);
    assert(swingHigh && swingHigh.price === 112, `Swing High phải là 112 (bỏ nến cuối 120), thực tế: ${JSON.stringify(swingHigh)}`);
  });

  // ── 2. bracketManager Exponential Backoff Retry ───────────────────────────
  await testAsync('bracketManager: Retry backoff cho lỗi mạng & fail-fast lỗi -2021', async () => {
    let attempts = 0;
    const val = await bracketManager.withRetryBackoff(async () => {
      attempts++;
      if (attempts < 3) throw new Error('ETIMEDOUT network glitch');
      return 'OK';
    }, { maxRetries: 2, baseDelayMs: 5, label: 'TestTransient' });
    assert.strictEqual(val, 'OK');
    assert.strictEqual(attempts, 3, 'Phải thử đúng 3 lần (1 gốc + 2 retry)');

    let deterministicAttempts = 0;
    const mockClient = {
      cancelAlgoOrder: async () => ({}),
      getOpenAlgoOrders: async () => ([]),
      placeStopOrder: async (sym, side, type, price) => {
        if (price === 105) {
          deterministicAttempts++;
          throw new Error('Binance API: Order would immediately trigger.');
        }
        return { algoId: 'RESTORED_SL_999' };
      }
    };
    const meta = { direction: 'LONG', slPrice: 95, currentSlPrice: 95, binanceSlOrderId: 'OLD_1' };
    const res = await bracketManager.ratchetTrailingFractal({
      client: mockClient,
      sym: 'SOL',
      meta,
      newTrailingSlPrice: 105,
      currentPrice: null, // bỏ qua guard trước để ép gọi xuống Binance
      retryDelayMs: 5,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(deterministicAttempts, 1, 'Lỗi -2021 KHÔNG được retry vô ích');
    assert.strictEqual(meta.binanceSlOrderId, 'RESTORED_SL_999', 'Phải khôi phục lại SL cũ sau khi đặt mới thất bại');
  });

  // ── 3. tradeMonitor Williams Fractal H1 & M15 Trailing SL ─────────────────
  await testAsync('tradeMonitor: Williams Fractal H1 (35%-70% TP) & M15 (>=70% TP) Trailing SL', async () => {
    const placedOrders = [];
    const mockClient = {
      cancelAlgoOrder: async () => ({}),
      getOpenAlgoOrders: async () => ([]),
      placeStopOrder: async (sym, side, type, price) => {
        placedOrders.push({ sym, side, type, price });
        return { algoId: `FRAC_${placedOrders.length}` };
      }
    };

    const trade = {
      id: 't_frac_1',
      symbol: 'SOL',
      direction: 'LONG',
      entryPrice: 100,
      targetPrice: 120,
      slPrice: 96,
      currentSlPrice: 96,
      leverage: 5,
      entryFilled: true,
      status: 'active',
      binanceSlOrderId: 'SL_INIT',
    };

    // 3a. Chưa đủ 35% TP (giá 105 = 25% TP) -> không dời
    const r0 = await tradeMonitor.checkAndApplyFractalTrailingSL(trade, 105, {
      client: mockClient, forceCheck: true, skipSave: true
    });
    assert.strictEqual(r0.moved, false);
    assert.strictEqual(r0.reason, 'BELOW_35PCT_TRIGGER');

    // 3b. Đạt 50% TP (giá 110) -> dùng H1 Williams Fractal (đáy 104 -> đệm 0.15% = 103.844)
    const h1Candles = makeFractalCandles(
      [106, 105, 104.5, 104, 105, 106, 107],
      [108, 107, 106.5, 106, 107, 109, 111]
    );
    const r1 = await tradeMonitor.checkAndApplyFractalTrailingSL(trade, 110, {
      client: mockClient, h1Candles, forceCheck: true, skipSave: true, retryDelayMs: 5
    });
    assert.strictEqual(r1.moved, true, `Phải dời SL theo H1 Fractal: ${JSON.stringify(r1)}`);
    assert.strictEqual(r1.tf, 'H1');
    assert.strictEqual(trade.fractalTf, 'H1_FRACTAL');
    assert(trade.slPrice > 103 && trade.slPrice < 104, `SL H1 phải ~103.844, thực tế: ${trade.slPrice}`);

    // 3c. Đạt 80% TP (giá 116) -> chuyển sang siết M15 Williams Fractal (đáy 111 -> đệm 0.15% = 110.8335)
    const m15Candles = makeFractalCandles(
      [113, 112, 111.5, 111, 112, 113, 114],
      [115, 114, 113.5, 113, 114, 116, 117]
    );
    const r2 = await tradeMonitor.checkAndApplyFractalTrailingSL(trade, 116, {
      client: mockClient, m15Candles, forceCheck: true, skipSave: true, retryDelayMs: 5
    });
    assert.strictEqual(r2.moved, true, `Phải siết SL theo M15 Fractal: ${JSON.stringify(r2)}`);
    assert.strictEqual(r2.tf, 'M15');
    assert.strictEqual(trade.fractalTf, 'M15_FRACTAL');
    assert(trade.slPrice > 110 && trade.slPrice < 111, `SL M15 phải ~110.8335, thực tế: ${trade.slPrice}`);
    assert.strictEqual(placedOrders.length, 2);

    // 3d. One-way ratchet: đáy mới thấp hơn SL hiện tại (108 < 110.83) -> tuyệt đối không hạ SL
    const worseM15 = makeFractalCandles(
      [110, 109, 108.5, 108, 109, 110, 111],
      [112, 111, 110.5, 110, 111, 112, 113]
    );
    const r3 = await tradeMonitor.checkAndApplyFractalTrailingSL(trade, 116, {
      client: mockClient, m15Candles: worseM15, forceCheck: true, skipSave: true
    });
    assert.strictEqual(r3.moved, false);
    assert.strictEqual(r3.reason, 'NOT_BETTER_THAN_CURRENT_SL');
  });

  // ── 4. tierSLTP: Adaptive ATR Ceiling (> 3.5%) & Fibonacci Extension TP ───
  await testAsync('tierSLTP: Xóa trần cứng 3.5% theo ATR & hỗ trợ Fibonacci Extension TP', async () => {
    // Tạo nến H4 biến động cao (ATR ~ 2.5%), có đáy Swing Low bảo vệ tại 95.5 (cách entry 100 là 4.5% > 3.5% cũ)
    const highVolH4 = [];
    for (let i = 0; i < 30; i++) {
      const isLowPivot = (i === 15);
      highVolH4.push({
        openTime: i * 14400_000,
        open: 99.5,
        high: 101.2,
        low: isLowPivot ? 95.5 : 98.7,
        close: 100.0
      });
    }
    const res = await tierSLTP.calculateTierSLTP(
      'ALTCOIN', 'LONG', 100.0,
      { step: 30, decimals: 2 }, 0.01, 10, 3.0, 1.5, 120, null,
      { h1: highVolH4, h4: highVolH4, d1: [] }
    );
    assert.strictEqual(res.valid, true, `Setup biến động cao phải hợp lệ: ${res.reason}`);
    assert(res.slPct > 3.5 && res.slPct <= 6.0, `SL thích ứng ATR phải vượt trần cứng 3.5% cũ (tới 6.0%), thực tế: ${res.slPct}%`);

    // Kiểm tra nhánh Fibonacci Extension 1.272/1.618 khi grid step quá lớn (> 3.0 R:R) và không có cản trên
    const waveH1 = [];
    for (let i = 0; i < 24; i++) {
      const p = 98 + (i / 23) * 4; // low24=97.5, high24=102.5 -> wave=5 -> 1.618 ext từ 97.5 = 105.59 (dist ~5.39%)
      waveH1.push({ openTime: i * 3600_000, open: p, high: p + 0.5, low: p - 0.5, close: p });
    }
    const resFib = await tierSLTP.calculateTierSLTP(
      'FIBTEST', 'LONG', 100.0,
      { step: 30, decimals: 2 }, 0.01, 10, 3.0, 1.5, 100, null,
      { h1: waveH1, h4: waveH1, d1: [] }
    );
    assert.strictEqual(resFib.valid, true);
    assert(resFib.tpAnchorType === 'FIB_EXT_1272' || resFib.tpAnchorType === 'FIB_EXT_1618',
      `Phải chọn Fibonacci Extension TP, thực tế: ${resFib.tpAnchorType}`);
  });

  // ── 5. technicalAnalysis + confluenceScorer: Ma trận 3 Tầng D1 + H4 + H1 ──
  testSync('technicalAnalysis + confluenceScorer: Tầng 3 H1 EMA & Thưởng đồng thuận 3 tầng', () => {
    const mk = (n, start, step) => Array.from({ length: n }, (_, i) => ({
      t: i * 3600_000, o: start + i * step, h: start + i * step + 1, l: start + i * step - 1, c: start + i * step + 0.5, v: 100
    }));
    const ta = taCollector.calcTAFromKlines('BTC', mk(60, 100, 1), mk(120, 80, 0.7), mk(210, 50, 0.6), null);
    assert(ta.ema1h && typeof ta.ema1h.e7 === 'number' && typeof ta.ema1h.e25 === 'number', 'TA phải trả ema1h.e7 và ema1h.e25');
    assert(ta.candleH1 && typeof ta.candleH1.close === 'number', 'TA phải trả candleH1');

    const resAligned = scorer.scoreSetup('BTC', 'LONG', {
      price: 100,
      aboveEMA200: true,
      ema: { e7: 98, e25: 95, e99: 90, e200d: 85 },
      ema1h: { e7: 99, e25: 97 },
      bb: { bandwidth: 5 },
      rsi: { '4h': 50, '1d': 50 },
    }, {}, {}, null, {}, {}, null, null);
    assert(resAligned.reasons.some(r => r.includes('EMA 1H LONG')), 'Phải có điểm Tầng 3 H1 EMA');
    assert(resAligned.reasons.some(r => r.includes('Hợp lưu 3 Tầng Trend D1+H4+H1')), 'Phải có thưởng hợp lưu 3 tầng D1+H4+H1');
  });

  // ── 6. riskGatekeeper: ML weights + risk_interaction + spread + dedup ─────
  testSync('riskGatekeeper: Trọng số ML thực, risk_interaction, spread_slippage & khử phạt kép', () => {
    const sig = { symbol: 'BTC', signal: 'LONG', targetLevel: 90000, score: 8.5, marketCapRank: 1 };

    // 6a. Stale Bounce Runaway Interaction
    const resStale = gatekeeper.evaluateSignal(sig, { preEntryBouncePct: 1.8 });
    assert.strictEqual(resStale.riskInteraction, 'INTERACTION_STALE_BOUNCE_RUNAWAY');
    assert(resStale.totalSamples > 0, 'Phải nạp số mẫu thực từ ai_rule_config.json');

    // 6b. Puncture Runaway Interaction (H1 + M15 cùng đâm thủng sâu) -> VETO
    const deepCandle = { open: 90100, high: 90150, low: 88000, close: 88200 };
    const resPunct = gatekeeper.evaluateSignal(sig, { candleH1: deepCandle, candleM15: deepCandle });
    assert.strictEqual(resPunct.riskInteraction, 'INTERACTION_PUNCTURE_RUNAWAY');
    assert.strictEqual(resPunct.isApproved, false, 'H1+M15 đâm thủng sâu phải bị VETO');

    // 6c. Wide Spread Danger -> VETO
    const resSpread = gatekeeper.evaluateSignal(sig, { spreadPct: 0.15 });
    assert.strictEqual(resSpread.features.spread_slippage, 'SPREAD_WIDE_DANGER');
    assert.strictEqual(resSpread.isApproved, false, 'Spread giãn quá rộng phải bị VETO');

    // 6d. Dedup Pinbar H1 & M15: không nhân đôi cả 2
    const pinbar = { open: 90100, close: 90150, high: 90200, low: 89800 };
    const resDualPin = gatekeeper.evaluateSignal(sig, { candleH1: pinbar, candleM15: pinbar });
    const resH1Pin   = gatekeeper.evaluateSignal(sig, { candleH1: pinbar });
    assert.strictEqual(resDualPin.winProbability, resH1Pin.winProbability, 'H1+M15 cùng Pinbar phải khử trùng lặp (không cộng dồn 2 lần)');
  });

  // ── 7. shadowTracker: Thông số thật (leverage, margin, winProbability) ────
  testSync('shadowTracker: Lưu đúng leverage, margin và winProbability thật', () => {
    shadowTracker.clearActiveShadowsForTest();
    const sh = shadowTracker.registerShadowTrade({
      symbol: 'ETH',
      direction: 'SHORT',
      entryPrice: 3000,
      slPrice: 3090,
      tpPrice: 2820,
      leverage: 7,
      margin: 25.5,
      winProbability: 0.342,
      total: 8.2
    }, 'TEST_REAL_FIELDS');
    assert.strictEqual(sh.leverage, 7);
    assert.strictEqual(sh.margin, 25.5);
    assert.strictEqual(sh.winProbability, 34.2);
    shadowTracker.clearActiveShadowsForTest();
  });

  // ── 8. Dashboard API (Controls, Heatmap, Emergency) + UI HTML ─────────────
  await testAsync('Dashboard API & UI: Bot Controls, Proximity Heatmap, Emergency Close All & HTML Panels', async () => {
    const PORT = 3901;
    const srv = createServer(PORT);
    await new Promise(r => setTimeout(r, 150));

    const call = (urlPath, method = 'GET', body = null) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, path: urlPath, method,
        headers: body ? { 'Content-Type': 'application/json' } : {}
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, raw: data }); }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

    try {
      const ctrl1 = await call('/api/bot-controls', 'POST', { scanPaused: true, shadowOnlyMode: true });
      assert.strictEqual(ctrl1.status, 200);
      assert.strictEqual(ctrl1.body.scanPaused, true);
      assert.strictEqual(ctrl1.body.shadowOnlyMode, true);
      assert.strictEqual(job.isScanPaused(), true);
      assert.strictEqual(job.isShadowOnlyMode(), true);

      // Reset về trạng thái mặc định
      await call('/api/bot-controls', 'POST', { scanPaused: false, shadowOnlyMode: false });
      assert.strictEqual(job.isScanPaused(), false);
      assert.strictEqual(job.isShadowOnlyMode(), false);

      const hm = await call('/api/proximity-heatmap');
      assert.strictEqual(hm.status, 200);
      assert(Array.isArray(hm.body.items), 'Heatmap phải trả về mảng items');

      const resetFg = await call('/api/btc-flash-guard/reset', 'POST', {});
      assert.strictEqual(resetFg.status, 200);
      assert.strictEqual(resetFg.body.ok, true);

      const emg = await call('/api/emergency/close-all', 'POST', {});
      assert.strictEqual(emg.status, 200);
      assert.strictEqual(emg.body.ok, true);
      assert(Array.isArray(emg.body.errors), 'Emergency API phải trả mảng errors (đã fix closePosition -> placeMarketClose)');

      const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8');
      assert(html.includes('id="tab-guards"'), 'index.html phải có tab Bảo vệ & Shadow');
      assert(html.includes('/api/circuit-breaker'), 'index.html phải gọi /api/circuit-breaker');
      assert(html.includes('/api/btc-flash-guard'), 'index.html phải gọi /api/btc-flash-guard');
      assert(html.includes('/api/shadow-trades'), 'index.html phải gọi /api/shadow-trades');
      assert(html.includes('/api/proximity-heatmap'), 'index.html phải gọi /api/proximity-heatmap');
      assert(html.includes('/api/emergency/close-all'), 'index.html phải có nút Emergency Close All');
    } finally {
      srv.close();
    }
  });

  console.log('\n================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ ROADMAP GAP FIXES: ${passed}/${total} PASS (${((passed / total) * 100).toFixed(0)}%)`);
  console.log('================================================================');
  process.exit(passed === total ? 0 : 1);
})();
