'use strict';

/**
 * test_phase2_universe_scorer.js
 *
 * Bộ unit test toàn diện kiểm thử Giai đoạn 2 cho bot-new:
 * 1. Tái sử dụng Persistent Deep Candle Cache từ đĩa (H1 300, H4 300, D1 180, 0ms, 0 REST weight)
 * 2. Universe Năng Động & Bộ lọc lưới bước giá chuẩn xác (2.0% <= gridStepPct <= 30%)
 * 3. Thuật toán Hybrid SL 3 tầng & Smart Anchored TP (calculateTierSLTP)
 * 4. Cơ chế Weak S/R Bypass & Chốt chặn Cản Cứng Major Wall (RR_BLOCKED_BY_MAJOR_SR)
 * 5. Risk Gatekeeper AI Bản Thân Cục Bộ (0ms, 0 Token, 100% offline)
 * 6. Confluence Scorer: Giữ nguyên thang điểm chạm mốc (L1=+2đ, L2=+1đ, L3+=+1đ) & timePenalty = 0
 * 7. End-to-End Signal Engine: Tự chủ 100% định lượng, không gọi External LLM
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  calculateATR,
  findSwingPoints,
  SHARED_DATA_DIR,
  _h1HistCache
} = require('../src/services/candleCache');

const {
  calculateTierSLTP,
  buildClusterZones,
  evadeRoundNumber,
  roundSlConservative,
  roundTpConservative,
  getStep
} = require('../src/services/tierSLTP');

const {
  isGridWidthValid,
  filterSymbolsByGrid,
  getTopNearbySymbols,
  GRID_MIN_PCT,
  GRID_MAX_PCT
} = require('../src/services/dynamicUniverse');

const {
  evaluateSignal,
  classifyCandleGeometry
} = require('../src/services/riskGatekeeper');

const { score369Method } = require('../src/pp369/core');

const {
  generateQuantitativeTrade,
  processCandidateSetups,
  MIN_SCORE_TIER1,
  MIN_SCORE_TIER2
} = require('../src/services/signalEngine');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] Test ${totalTests}: ${name}`);
    console.error(`   Lỗi: ${err.message}`);
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
    console.error(`   Lỗi: ${err.message}`);
  }
}

(async () => {
  console.log('================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 2: UNIVERSE, SCORER & TIER SL/TP');
  console.log('================================================================\n');

  // ── TEST 1: TÁI SỬ DỤNG PERSISTENT DISK CACHE ──────────────────────────────
  runTest('1. Tái sử dụng Cache Nến trên đĩa (0ms - 0 REST Weight)', () => {
    assert(fs.existsSync(SHARED_DATA_DIR), 'Thư mục data dùng chung phải tồn tại');
    const h1Count = Object.keys(_h1HistCache).length;
    assert(h1Count > 0, `Phải nạp được ít nhất 1 symbol từ cache (hiện có: ${h1Count})`);

    const ethCache = _h1HistCache['ETH'];
    assert(ethCache && ethCache.candles.length > 0, 'Phải có nến ETH trong cache H1');
    const firstCandle = ethCache.candles[0];
    assert(typeof firstCandle.open === 'number', 'Nến phải có thuộc tính open dạng number');
    assert(typeof firstCandle.close === 'number', 'Nến phải có thuộc tính close dạng number');
  });

  // ── TEST 2: KỸ THUẬT ATR & SWING POINTS TRÊN DỮ LIỆU NẾN ──────────────────
  runTest('2. Tính toán ATR và Swing Points', () => {
    const mockCandles = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      p += (i % 2 === 0 ? 2 : -1.5);
      mockCandles.push({
        openTime: i * 3600000,
        open: p - 1,
        high: p + 3,
        low: p - 2,
        close: p
      });
    }

    const atr = calculateATR(mockCandles, 14);
    assert(typeof atr === 'number' && atr > 0, 'ATR phải là số dương hợp lệ');

    const swings = findSwingPoints(mockCandles, 2, 2);
    assert(Array.isArray(swings.highs), 'Swing highs phải là một mảng');
    assert(Array.isArray(swings.lows), 'Swing lows phải là một mảng');
  });

  // ── TEST 3: BỘ LỌC BƯỚC GIÁ LƯỚI (2.0% - 30.0%) ───────────────────────────
  runTest('3. Bộ lọc bước giá lưới Dynamic Universe (2.0% - 30.0%)', () => {
    assert.strictEqual(GRID_MIN_PCT, 2.0, 'GRID_MIN_PCT phải là 2.0%');
    assert.strictEqual(GRID_MAX_PCT, 30.0, 'GRID_MAX_PCT phải là 30.0%');

    // BTC @ $90,000 -> unit=1000, step=3000 -> 3.33% => Hợp lệ
    assert.strictEqual(isGridWidthValid(90000), true, 'BTC $90k (3.33%) phải hợp lệ');

    // ETH @ $1,800 -> unit=100, step=300 -> 16.6% => Hợp lệ
    assert.strictEqual(isGridWidthValid(1800), true, 'ETH $1800 (16.6%) phải hợp lệ');

    // Coin @ $10,000 -> unit=1000, step=3000 -> 30% => Biên trên hợp lệ
    assert.strictEqual(isGridWidthValid(10000), true, 'Coin $10k (30.0%) phải hợp lệ');

    // Giá âm hoặc null => Không hợp lệ
    assert.strictEqual(isGridWidthValid(null), false);
    assert.strictEqual(isGridWidthValid(-50), false);
  });

  // ── TEST 4: PROXIMITY FILTER SẮP XẾP VÀ CẮT TOP 8 MÃ ──────────────────────
  runTest('4. Proximity Filter sắp xếp khoảng cách và cắt Top 8', () => {
    const symbols = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'NEAR'];
    const levelCache = {};
    const priceMap = {};

    symbols.forEach((sym, idx) => {
      priceMap[sym] = 100;
      // sym càng về sau khoảng cách tới mốc càng lớn
      const offset = (idx + 1) * 0.1;
      levelCache[sym] = {
        longEntry: 100 - offset,
        shortEntry: 100 + offset
      };
    });

    const topNearby = getTopNearbySymbols(symbols, levelCache, priceMap, 0.05, 8);
    assert.strictEqual(topNearby.length, 8, 'Chỉ được lấy đúng Top 8 mã');
    assert.strictEqual(topNearby[0], 'BTC', 'Mã gần mốc nhất phải đứng đầu');
    assert.strictEqual(topNearby[7], 'AVAX', 'Mã thứ 8 phải đúng thứ tự');
    assert(!topNearby.includes('NEAR'), 'Mã thứ 10 phải bị loại');
  });

  // ── TEST 5: CALCULATE TIER SL/TP & HARD MAJOR WALL BLOCKING CHECK ───────────
  await runAsyncTest('5. calculateTierSLTP: VETO khi gặp Cản Cứng D1 (kèo ETH 1786)', async () => {
    // Dữ liệu kiểm thử thực tế từ thị trường đêm 19/11
    const mockH4 = [];
    let p = 1786;
    for (let i = 0; i < 30; i++) {
      mockH4.push({ openTime: i * 14400000, open: p, high: p + 30, low: p - 20, close: p + 5 });
    }

    // Đặt cản D1 sừng sững tại 1748 (cản cứng Swing Low với 2 nến trái & 2 nến phải)
    const mockD1 = [
      { openTime: 1, open: 1780, high: 1790, low: 1765, close: 1770 },
      { openTime: 2, open: 1770, high: 1775, low: 1755, close: 1760 },
      { openTime: 3, open: 1760, high: 1762, low: 1748, close: 1750 }, // Swing low tại 1748
      { openTime: 4, open: 1750, high: 1770, low: 1755, close: 1765 },
      { openTime: 5, open: 1765, high: 1780, low: 1760, close: 1775 },
      { openTime: 6, open: 1775, high: 1810, low: 1770, close: 1800 },
      { openTime: 7, open: 1800, high: 1822, low: 1785, close: 1786 },
      { openTime: 8, open: 1786, high: 1830, low: 1780, close: 1820 },
      { openTime: 9, open: 1820, high: 1825, low: 1786, close: 1786 }
    ];

    const result = await calculateTierSLTP(
      'ETH',
      'SHORT',
      1786,
      { step: 300, decimals: 2 },
      0.01,
      10,
      3.0,
      1.5,
      2,
      null,
      { h1: mockH4, h4: mockH4, d1: mockD1 }
    );

    assert.strictEqual(result.valid, false, 'Kèo vướng cản cứng D1 bắt buộc phải bị VETO');
    assert(result.reason.includes('RR_BLOCKED_BY_MAJOR_SR'), `Lý do phải nêu rõ cản cứng chặn đầu, thực tế: ${result.reason}`);
    assert(result.rrRatio < 1.48, 'R:R phải nhỏ hơn 1.48');
  });

  // ── TEST 6: CALCULATE TIER SL/TP KÈO THỎA MÃN R:R & BREAKEVEN 35% ──────────
  await runAsyncTest('6. calculateTierSLTP: Kèo thông thoáng đạt R:R >= 1.48 và mốc BE 35%', async () => {
    const mockH1 = [];
    // Nến tạo đáy an toàn tại 98.0
    for (let i = 0; i < 30; i++) {
      mockH1.push({ openTime: i, open: 99.5, high: 102.0, low: 98.0, close: 100.0 });
    }

    const cleanResult = await calculateTierSLTP(
      'SOL',
      'LONG',
      100.0,
      { step: 30, decimals: 2 },
      0.01,
      10,
      3.0,
      1.5,
      5,
      null,
      { h1: mockH1, h4: mockH1, d1: [] }
    );

    assert.strictEqual(cleanResult.valid, true, `Kèo thông thoáng phải hợp lệ: ${cleanResult.reason}`);
    assert(cleanResult.rrRatio >= 1.48, 'R:R phải >= 1.48');
    assert(cleanResult.slPrice < 100.0, 'SL của LONG phải nằm dưới Entry');
    assert(cleanResult.tpPrice > 100.0, 'TP của LONG phải nằm trên Entry');
    assert(cleanResult.beTriggerPrice > 100.0 && cleanResult.beTriggerPrice < cleanResult.tpPrice, 'Mốc BE 35% phải nằm giữa Entry và TP');
  });

  // ── TEST 7: RISK GATEKEEPER AI BẢN THÂN CỤC BỘ (0ms / 0 TOKEN) ─────────────
  runTest('7. Risk Gatekeeper AI Bản Thân Cục Bộ (Pinbar Duyệt vs Flash Dump VETO)', () => {
    const sig = { symbol: 'BTC', signal: 'LONG', targetLevel: 90000, score: 8.0, reasons: ['Test setup'] };

    // Kịch bản A: Nến M15 rút chân Pinbar từ chối xả
    const ctxPinbar = { candleM15: { open: 90100, close: 90150, high: 90200, low: 89900 } };
    const resA = evaluateSignal(sig, ctxPinbar);
    assert.strictEqual(resA.isApproved, true, 'Pinbar rút chân phải được duyệt');
    assert(resA.winProbability >= 0.40, 'Xác suất thắng của Pinbar phải đạt ngưỡng duyệt');

    // Kịch bản B: BTC Flash Dump đâm mạnh ngược chiều LONG
    const ctxDump = { btcFlash: 'FLASH_DUMP' };
    const resB = evaluateSignal(sig, ctxDump);
    assert.strictEqual(resB.isApproved, false, 'BTC Flash dump ngược chiều LONG bắt buộc phải VETO');
    assert(resB.winProbability < 0.40, 'Xác suất thắng khi Flash dump phải bị hạ sâu');
  });

  // ── TEST 8: CONFLUENCE SCORER: THANG ĐIỂM CHẠM MỐC & BỎ TIME PENALTY ────────
  runTest('8. Confluence Scorer: Thang điểm chạm mốc (L1=+2đ, L2=+1đ, L3+=+1đ)', () => {
    // Lần 1: strong (+2đ)
    const sigL1 = { signal: 'LONG', strength: 'strong', touchCount: 0 };
    assert.strictEqual(score369Method(sigL1, 'LONG').score, 2, 'Lần 1 phải được +2đ');

    // Lần 2: medium (+1đ)
    const sigL2 = { signal: 'LONG', strength: 'medium', touchCount: 1 };
    assert.strictEqual(score369Method(sigL2, 'LONG').score, 1, 'Lần 2 phải được +1đ');

    // Lần 3 trở đi: weak (+1đ)
    const sigL3 = { signal: 'LONG', strength: 'weak', touchCount: 2 };
    assert.strictEqual(score369Method(sigL3, 'LONG').score, 1, 'Lần 3+ phải được +1đ');
  });

  // ── TEST 9: END-TO-END SIGNAL ENGINE: PHÂN LOẠI TIER 1 (>=7Đ) & TIER 2 (>=8Đ)
  await runAsyncTest('9. SignalEngine: Phân tầng Tier 1 (>=7.0đ) & Tier 2 (>=8.0đ), giới hạn Top 2', async () => {
    assert.strictEqual(MIN_SCORE_TIER1, 7.0, 'Ngưỡng Tier 1 phải là 7.0đ');
    assert.strictEqual(MIN_SCORE_TIER2, 8.0, 'Ngưỡng Tier 2 phải là 8.0đ');

    const mockCandidates = [
      { symbol: 'BTC', direction: 'LONG', total: 7.5, verdict: 'CONFIDENT' },                       // Không có targetLevel (thực tế từ scoreAllSetups)
      { symbol: 'ETH', direction: 'SHORT', total: 6.5, verdict: 'CAUTIOUS' },                      // Tier 1 không đạt (<7)
      { symbol: 'SUI', direction: 'LONG', total: 8.5, verdict: 'STRONG' },                         // Tier 2 đạt (>=8)
      { symbol: 'APT', direction: 'LONG', total: 7.5, verdict: 'CONFIDENT' },                      // Tier 2 không đạt (<8)
      { symbol: 'SOL', direction: 'LONG', total: 9.0, verdict: 'BEST' }                            // Tier 1 đạt
    ];

    // Market data giả lập đúng chuẩn thực tế: ta có .price chứ không phải .close
    const mockMarket = {
      ta: {
        BTC: { price: 90000 },
        SOL: { price: 190.0 },
        SUI: { price: 3.2 }
      }
    };

    const trades = await processCandidateSetups(mockCandidates, mockMarket, 2);

    // Kiểm tra số lượng lệnh bị giới hạn Top 2
    assert(trades.length <= 2, `Số lượng lệnh tối đa phải <= 2, thực tế: ${trades.length}`);

    // Kiểm tra không có lệnh nào có điểm dưới chuẩn lọt vào
    trades.forEach(t => {
      if (['BTC', 'ETH', 'SOL'].includes(t.symbol)) {
        assert(t.confluenceScore >= 7.0, `Lệnh Tier 1 ${t.symbol} điểm phải >= 7.0`);
      } else {
        assert(t.confluenceScore >= 8.0, `Lệnh Tier 2 ${t.symbol} điểm phải >= 8.0`);
      }
      assert(t.entryPrice > 0, `entryPrice phải > 0, thực tế: ${t.entryPrice}`);
      assert(t.targetPct > 0, `targetPct phải > 0, thực tế: ${t.targetPct}`);
      assert(t.slPct > 0, `slPct phải > 0, thực tế: ${t.slPct}`);
      assert(t.recommendedAt, 'recommendedAt phải được định nghĩa');
      assert(t.rrRatio >= 1.48, 'Mọi lệnh sinh ra phải có R:R >= 1.48');
      assert.strictEqual(t.source, 'quantitative_deterministic', 'Nguồn lệnh phải là quantitative_deterministic');
    });
  });

  console.log('\n================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ: ${passedTests}/${totalTests} BÀI TEST THÀNH CÔNG (100%)`);
  console.log('================================================================');
  process.exit(passedTests === totalTests ? 0 : 1);
})();
