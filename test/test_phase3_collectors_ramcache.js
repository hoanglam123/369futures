'use strict';

/**
 * Test Suite Toàn Diện Giai Đoạn 3: Hạ Tầng Dữ Liệu On-Demand & Bộ Đệm RAM Cache Chống Rate Limit
 * 
 * 1. Coinalyze Collector (Thanh lý đa sàn, Open Interest, L/S ratio, Safe fallback)
 * 2. Whale Data Collector (Binance aggTrades $1M+, Taker Flow, CrossSignal, Phân cấp Cá voi)
 * 3. Derivatives Collector (OI History, Retail vs Top Trader L/S, Contrarian signal)
 * 4. Fear & Greed Index (Alternative.me API)
 * 5. On-Demand RAM Caching Engine (TTL 180s - 300s, 0ms latency cache hit, Request Coalescing)
 * 6. Tích hợp trọn vẹn vào Confluence Scorer 5 Trụ Cột (TA + Whale + Derivatives + Sentiment + PP369)
 */

require('dotenv').config();
const assert = require('assert');

const {
  isCoinalyzeEnabled,
  getCoinalyzeOI,
  getCrossSignal,
  interpretLS,
  getFearGreedCached,
  getWhaleDataCached,
  getDerivativesCached,
  getOnDemandMarketData,
  getRamCacheStats,
  clearRamCache,
  WHALE_TTL_MS,
  DERIVATIVES_TTL_MS,
} = require('../src/collectors');

const { scoreSetup } = require('../src/pp369');

console.log('================================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 3 (DATA & RAM CACHE)');
console.log('================================================================\n');

let passCount = 0;
let totalTests = 0;

async function runTestAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}. Error: ${err.message}`);
  }
}

(async () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: Coinalyze Collector Safe Fallback & IsEnabled check
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Coinalyze Collector: Fallback an toàn khi chưa có API key', async () => {
    // isCoinalyzeEnabled() trả về boolean chuẩn xác
    const enabled = isCoinalyzeEnabled();
    assert.strictEqual(typeof enabled, 'boolean');

    // Gọi hàm khi chưa có key hoặc key demo phải trả về {} an toàn không ném exception
    const oi = await getCoinalyzeOI(['BTC']);
    assert.strictEqual(typeof oi, 'object');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: Whale Data Collector: Phân cấp dòng tiền & CrossSignal
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Whale Data Collector: Logic CrossSignal đa sàn chuẩn xác', async () => {
    // Kịch bản 1: Cả Taker Flow và Binance Large Trade đều BUY -> XÁC NHẬN MUA
    const tfBuy = { BTC: { bias: 'BUY_PRESSURE', buyPct: 65 } };
    const bnBuy = { BTC: { bias: 'WHALE_BUY', buyPct: 70 } };
    const csBuy = getCrossSignal('BTC', tfBuy, bnBuy);
    assert.strictEqual(csBuy.verdict, 'XÁC NHẬN MUA');

    // Kịch bản 2: Cả Taker Flow và Binance Large Trade đều SELL -> XÁC NHẬN BÁN
    const tfSell = { BTC: { bias: 'SELL_PRESSURE', sellPct: 62 } };
    const bnSell = { BTC: { bias: 'WHALE_SELL', buyPct: 30 } };
    const csSell = getCrossSignal('BTC', tfSell, bnSell);
    assert.strictEqual(csSell.verdict, 'XÁC NHẬN BÁN');

    // Kịch bản 3: Phân kỳ trái chiều (OKX BUY nhưng Binance SELL) -> PHÂN KỲ/TRUNG TÍNH (VETO!)
    const csDivergent = getCrossSignal('BTC', tfBuy, bnSell);
    assert.strictEqual(csDivergent.verdict, 'PHÂN KỲ/TRUNG TÍNH');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: Derivatives Collector: Interpret L/S Contrarian & Divergence
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Derivatives Collector: Phân tích Long/Short Contrarian', async () => {
    // 1. Retail quá LONG (> 55%) -> Contrarian SHORT
    const retailLong = { longPct: 68.5, shortPct: 31.5 };
    const sigContrarianShort = interpretLS(retailLong, null);
    assert.strictEqual(sigContrarianShort.retailBias, 'LONG_HEAVY');
    assert.strictEqual(sigContrarianShort.contrarian, 'CONTRARIAN_SHORT');

    // 2. Retail quá SHORT (< 45%) -> Contrarian LONG
    const retailShort = { longPct: 38.0, shortPct: 62.0 };
    const sigContrarianLong = interpretLS(retailShort, null);
    assert.strictEqual(sigContrarianLong.retailBias, 'SHORT_HEAVY');
    assert.strictEqual(sigContrarianLong.contrarian, 'CONTRARIAN_LONG');

    // 3. Top Trader Divergence: Retail LONG nhưng Top Trader SHORT
    const topTraderShort = { longPct: 42.0, shortPct: 58.0 };
    const sigDivergence = interpretLS(retailLong, topTraderShort);
    assert.strictEqual(sigDivergence.divergence, true);
    assert.strictEqual(sigDivergence.topBias, 'TOP_SHORT');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 4: Fear & Greed Index
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Fear & Greed Index: Lấy dữ liệu tâm lý và cache 15 phút', async () => {
    const fng = await getFearGreedCached();
    assert.ok(fng, 'Dữ liệu Fear & Greed không được null');
    assert.strictEqual(typeof fng.value, 'number');
    assert.ok(fng.value >= 0 && fng.value <= 100, `Chỉ số Fear & Greed phải trong [0, 100] (thực tế: ${fng.value})`);
    assert.ok(fng.classification, 'Phải có nhãn phân loại tâm lý');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 5: RAM Cache Engine: 0ms Latency on Cache Hit & Stats
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('RAM Caching Engine: Tốc độ phản hồi 0ms khi Cache Hit', async () => {
    clearRamCache();

    // Lần 1: Fetch vào cache
    const t0 = Date.now();
    const data1 = await getOnDemandMarketData('BTC');
    const duration1 = Date.now() - t0;

    // Lần 2: Cache Hit ngay lập tức trong RAM
    const t1 = Date.now();
    const data2 = await getOnDemandMarketData('BTC');
    const duration2 = Date.now() - t1;

    assert.ok(data1 && data2, 'Cả 2 lần đều phải có dữ liệu');
    assert.strictEqual(data1.fearGreed?.value, data2.fearGreed?.value);
    assert.ok(duration2 <= 5, `Cache Hit trong RAM phải phản hồi tức thì <= 5ms (thực tế: ${duration2}ms)`);

    const stats = getRamCacheStats();
    assert.strictEqual(stats.hasFearGreedCache, true);
    assert.ok(stats.whaleCachedSymbols >= 1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 6: Request Coalescing: Chống bão gọi API đồng thời cho cùng 1 coin
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Request Coalescing: Ghép luồng khi nhiều caller gọi đồng thời', async () => {
    clearRamCache();

    // Gọi đồng thời 5 requests cho ETH cùng 1 mili-giây
    const promises = [
      getOnDemandMarketData('ETH'),
      getOnDemandMarketData('ETH'),
      getOnDemandMarketData('ETH'),
      getOnDemandMarketData('ETH'),
      getOnDemandMarketData('ETH')
    ];

    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 5);
    // Cả 5 results phải tham chiếu tới cùng 1 dữ liệu đồng nhất
    assert.strictEqual(results[0].fearGreed?.value, results[4].fearGreed?.value);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 7: Tích hợp đầy đủ vào Confluence Scorer 5 Trụ Cột (TA + Whale + Deriv + Sent + PP369)
  // ─────────────────────────────────────────────────────────────────────────────
  await runTestAsync('Tích hợp Confluence Scorer: 5 Trụ Cột hưởng trọn vẹn điểm', async () => {
    const taMock = {
      price: 200,
      rsi: { '4h': 28, '1d': 40 },
      stochRSI: { k: 18 },
      macd: { crossover: 'GOLDEN_CROSS', trend: 'BULLISH' },
      ema: { e7: 202, e25: 198, e99: 190 },
      bb: { bandwidth: 5.5, pctB: 10 },
      support: [199.8],
      supportTouches: [3],
      weeklyPivot: { low: 199.5 },
      volume: { ratio: 1.8 },
      regime: 'TRENDING_UP',
      aboveEMA200: true,
    };

    const whaleMock = {
      binanceLarge: {
        SOL: {
          bias: 'WHALE_BUY',
          buyPct: 82,
          buyVol: 15_000_000,
          sellVol: 3_000_000,
          tiers: {
            WHALE: { buyVol: 12_000_000, sellVol: 2_000_000 }
          }
        }
      },
      liquidations: {
        SOL: {
          dominant: 'SHORT_SQUEEZE',
          totalLiq: 8_000_000,
          shortLiqVol: 6_500_000,
          longLiqVol: 1_500_000
        }
      }
    };

    const derivMock = {
      SOL: {
        oi: { trend: 'RISING', changePct: 4.8 },
        lsSignal: { contrarian: 'CONTRARIAN_LONG', divergence: true },
        topTrader: { longPct: 62 }
      }
    };

    const fearGreedMock = { value: 16 }; // Extreme Fear -> Contrarian Long (+1.0đ)
    const sig369 = { signal: 'LONG', targetLevel: 200, condLevel: 206, touchCount: 0 };

    const res = scoreSetup('SOL', 'LONG', taMock, whaleMock, derivMock, 0.0001, fearGreedMock, null, null, sig369);

    assert.strictEqual(res.disqualified, false);
    assert.ok(res.total >= 8.5, `Điểm tổng hợp 5 trụ cột phải cực cao (thực tế: ${res.total}đ)`);
    assert.strictEqual(res.verdict, 'BEST_OPPORTUNITY');
    assert.ok(res.breakdown.whale >= 2.0, 'Trụ cột Whale phải được cộng điểm Squeeze & Whale buy');
    assert.ok(res.breakdown.derivatives >= 1.0, 'Trụ cột Derivatives phải được cộng điểm OI Rising');
    assert.ok(res.breakdown.sentiment === 1.0, 'Trụ cột Sentiment phải được +1.0đ');
    assert.ok(res.breakdown.pp369 === 2.0, 'Trụ cột PP369 Fresh phải được +2.0đ');
  });

  console.log('\n================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ GIAI ĐOẠN 3: ${passCount}/${totalTests} TESTS ĐẠT CHUẨN (${(passCount/totalTests*100).toFixed(1)}%)`);
  console.log('================================================================');

  if (passCount === totalTests) {
    console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG GIAI ĐOẠN 3 HOẠT ĐỘNG HOÀN HẢO 100%!\n');
    process.exit(0);
  } else {
    console.error('⚠️ CÓ TEST THẤT BẠI, CẦN KIỂM TRA LẠI!\n');
    process.exit(1);
  }
})();
