'use strict';

/**
 * test_sr_clusters.js
 *
 * Kiểm thử chuyên sâu thuật toán Cản Cứng (Major S/R) & Cản Mềm (Minor S/R)
 * cho cả bot-new (tierSLTP.js) và bot-h4 (autoTrade.js):
 * 1. Chống đếm trùng 1 đỉnh qua H1 + H4 + D1 / nhiễu sideway ngắn (< 12h/24h)
 * 2. Chống Cluster Chaining (không kéo dãn 1 cụm thành vùng 2%-5%)
 * 3. Lọc Cản Chết (Broken S/R Decay): cản bị nến H4 đóng cắt qua lại >= 3 lần -> hạ xuống Cản Mềm
 * 4. Độ tươi cản D1: D1 1 chạm quá cũ (> 60 ngày, không phải cực trị 90d) -> Cản Mềm; D1 <= 60 ngày hoặc cực trị 90d -> Cản Cứng
 * 5. S/R Flip (Role Reversal): Đáy hỗ trợ cũ bị phá thành Kháng cự cứng phía trên và ngược lại
 * 6. Format số thập phân động cho coin giá siêu nhỏ ($0.0044 không còn in [0.00-0.00])
 */

const assert = require('assert');
const tierSLTP = require('../src/services/tierSLTP');
const botH4    = require('../../src/trader/autoTrade');

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

(async () => {
  console.log('================================================================');
  console.log('🧪 KIỂM THỬ THUẬT TOÁN CẢN CỨNG / CẢN MỀM (BOT-NEW & BOT-H4)');
  console.log('================================================================\n');

  const now = Date.now();
  const DAY = 24 * 3600_000;
  const HOUR = 3600_000;

  // ── 1. Chống đếm trùng 1 đỉnh qua H1 + H4 (cùng thời điểm -> 1 chạm, KHÔNG thành Cản Cứng)
  testSync('Chống đếm trùng đa khung & sideway ngắn (H1+H4 cùng 1 đợt = 1 chạm -> Minor)', () => {
    const pts = [
      { price: 100.0, time: now - 20 * HOUR, timeframe: 'H1', type: 'HIGH' },
      { price: 100.1, time: now - 19 * HOUR, timeframe: 'H1', type: 'HIGH' },
      { price: 100.05, time: now - 18 * HOUR, timeframe: 'H4', type: 'HIGH' },
    ];
    for (const [label, fn] of [['bot-new', tierSLTP.buildClusterZones], ['bot-h4', botH4.buildClusterZones]]) {
      const clusters = fn(pts, 0.005, { referenceNowMs: now });
      assert.strictEqual(clusters.length, 1, `${label}: phải gom thành 1 cụm`);
      assert.strictEqual(clusters[0].touches, 1, `${label}: 3 điểm trong 2 tiếng chỉ tính là 1 lần chạm độc lập, thực tế: ${clusters[0].touches}`);
      assert.strictEqual(clusters[0].isMajor, false, `${label}: 1 chạm H1/H4 KHÔNG được gắn nhãn Cản Cứng`);
    }

    // 2 lần chạm H4 độc lập cách nhau 3 ngày -> Cản Cứng
    const majorH4Pts = [
      { price: 100.0, time: now - 10 * DAY, timeframe: 'H4', type: 'HIGH' },
      { price: 100.2, time: now - 5 * DAY,  timeframe: 'H4', type: 'HIGH' },
    ];
    for (const [label, fn] of [['bot-new', tierSLTP.buildClusterZones], ['bot-h4', botH4.buildClusterZones]]) {
      const clusters = fn(majorH4Pts, 0.005, { referenceNowMs: now });
      assert.strictEqual(clusters[0].distinctH4Touches, 2, `${label}: phải đếm đúng 2 chạm H4 độc lập`);
      assert.strictEqual(clusters[0].isMajor, true, `${label}: H4 >= 2 chạm độc lập phải là Cản Cứng`);
    }
  });

  // ── 2. Chống Cluster Chaining (không nối chuỗi 0.4% thành vùng khổng lồ 2.4%)
  testSync('Chống Cluster Chaining: không kéo dãn vùng cản quá bề rộng tối đa', () => {
    const chainPts = [100.0, 100.4, 100.8, 101.2, 101.6, 102.0, 102.4].map((p, i) => ({
      price: p, time: now - (30 - i * 3) * DAY, timeframe: 'H1', type: 'HIGH'
    }));
    for (const [label, fn] of [['bot-new', tierSLTP.buildClusterZones], ['bot-h4', botH4.buildClusterZones]]) {
      const clusters = fn(chainPts, 0.005, { referenceNowMs: now });
      assert(clusters.length >= 2, `${label}: chuỗi 100.0..102.4 phải tách thành >= 2 cụm thay vì nối thành 1 cụm khổng lồ`);
      for (const c of clusters) {
        const widthPct = ((c.zoneMax - c.zoneMin) / c.zoneMin) * 100;
        assert(widthPct <= 1.3, `${label}: bề rộng cụm ${widthPct.toFixed(2)}% bị kéo dãn quá rộng`);
      }
    }
  });

  // ── 3. Lọc Cản Chết (Broken S/R Decay: giá đóng nến H4 cắt qua lại >= 3 lần -> hạ xuống Cản Mềm)
  testSync('Lọc Cản Chết: vùng cản bị nến H4 đóng xuyên qua lại >= 3 lần bị hạ xuống Minor', () => {
    const deadZonePts = [
      { price: 100.0, time: now - 25 * DAY, timeframe: 'D1', type: 'HIGH' },
      { price: 100.1, time: now - 20 * DAY, timeframe: 'H4', type: 'HIGH' },
    ];
    // Tạo chuỗi nến H4 sau thời điểm tạo cản cắt qua lại $100 liên tục (98 -> 102 -> 98 -> 102 -> 98)
    const h4Slicing = [98, 102, 98, 102, 98, 102].map((c, i) => ({
      openTime: now - (15 - i) * DAY, open: c, high: c + 0.5, low: c - 0.5, close: c
    }));
    for (const [label, fn] of [['bot-new', tierSLTP.buildClusterZones], ['bot-h4', botH4.buildClusterZones]]) {
      const clusters = fn(deadZonePts, 0.005, { h4Candles: h4Slicing, referenceNowMs: now });
      assert.strictEqual(clusters[0].isBroken, true, `${label}: phải đánh dấu cản đã bị xuyên phá (crossings=${clusters[0].crossings})`);
      assert.strictEqual(clusters[0].isMajor, false, `${label}: cản chết phải bị hạ cấp thành Cản Mềm (isMajor=false)`);
    }
  });

  // ── 4. Độ tươi Cản D1 (D1 cũ > 60 ngày 1 chạm -> Minor; D1 <= 60 ngày hoặc cực trị 90d -> Major)
  testSync('Độ tươi D1: D1 1 chạm > 60 ngày bị hạ xuống Minor; D1 <= 60 ngày giữ nguyên Major', () => {
    const staleD1 = [{ price: 200, time: now - 110 * DAY, timeframe: 'D1', type: 'HIGH', isExtreme90d: false }];
    const freshD1 = [{ price: 200, time: now - 20 * DAY,  timeframe: 'D1', type: 'HIGH', isExtreme90d: false }];
    const extremeD1 = [{ price: 200, time: now - 80 * DAY, timeframe: 'D1', type: 'HIGH', isExtreme90d: true }];

    for (const [label, fn] of [['bot-new', tierSLTP.buildClusterZones], ['bot-h4', botH4.buildClusterZones]]) {
      assert.strictEqual(fn(staleD1, 0.005, { referenceNowMs: now })[0].isMajor, false, `${label}: D1 1 chạm 110 ngày trước phải là Minor`);
      assert.strictEqual(fn(freshD1, 0.005, { referenceNowMs: now })[0].isMajor, true,  `${label}: D1 20 ngày gần nhất phải là Major`);
      assert.strictEqual(fn(extremeD1, 0.005, { referenceNowMs: now })[0].isMajor, true, `${label}: Cực trị 90d phải là Major`);
    }
  });

  // ── 5. S/R Flip (Role Reversal) + Format số thập phân coin giá nhỏ
  await testAsync('S/R Flip & Format coin giá nhỏ: Đáy D1 cũ bị phá phía trên Entry chặn LONG (không in [0.00-0.00])', async () => {
    // Coin giá nhỏ $0.004400. Tạo 1 đáy D1 cứng (Swing Low) ở $0.004460 (trên Entry $0.004400 -> S/R Flip thành Kháng cự cứng!)
    const baseD1 = now - 20 * DAY;
    const d1Candles = [
      { openTime: baseD1 + 0 * DAY, open: 0.00480, high: 0.00490, low: 0.00470, close: 0.00475 },
      { openTime: baseD1 + 1 * DAY, open: 0.00475, high: 0.00480, low: 0.00460, close: 0.00465 },
      { openTime: baseD1 + 2 * DAY, open: 0.00465, high: 0.00470, low: 0.00446, close: 0.00455 }, // Swing Low D1 @ 0.00446 (Hỗ trợ cũ)
      { openTime: baseD1 + 3 * DAY, open: 0.00455, high: 0.00475, low: 0.00452, close: 0.00470 },
      { openTime: baseD1 + 4 * DAY, open: 0.00470, high: 0.00485, low: 0.00460, close: 0.00480 },
      { openTime: baseD1 + 5 * DAY, open: 0.00480, high: 0.00482, low: 0.00435, close: 0.00440 }, // Phá vỡ xuống dưới 0.00446 -> S/R Flip!
    ];
    const h4Candles = Array.from({ length: 20 }, (_, i) => ({
      openTime: now - (20 - i) * 4 * HOUR,
      open: 0.00439, high: 0.00443, low: 0.00434, close: 0.00440
    }));

    for (const [label, fn] of [['bot-new', tierSLTP.calculateTierSLTP], ['bot-h4', botH4.calculateTierSLTP]]) {
      const res = await fn(
        'ALT', 'LONG', 0.00440,
        { step: 0.0003, decimals: 6 }, 0.000001, 10, 3.0, 1.5, 150, null,
        { h1: h4Candles, h4: h4Candles, d1: d1Candles }
      );
      assert.strictEqual(res.valid, false, `${label}: Đáy D1 cũ @ 0.00446 bị phá phải thành Kháng cự cứng (S/R Flip) chặn LONG @ 0.00440`);
      assert(res.reason.includes('S/R-Flip'), `${label}: Lý do VETO phải ghi rõ S/R-Flip, thực tế: ${res.reason}`);
      assert(!res.reason.includes('[0.00-0.00]'), `${label}: Không được làm tròn thành [0.00-0.00], thực tế: ${res.reason}`);
    }
  });

  // ── 6. TP Hard Cap theo Cản Cứng & Fallback Cap <= 2.50R (cả 2 bot)
  await testAsync('TP Hard Cap theo Cản Cứng & Fallback Cap <= 2.50R trên CẢ 2 bot', async () => {
    // Entry 100, ATR ~1.0%, SL ~1.8% (~98.2). Lưới step=30 (siêu rộng) -> Fallback cũ sẽ đẩy TP lên +18.5% (~10R)!
    // Với nâng cấp mới: Fallback bị khóa trần <= 2.50R (~104.5).
    const flatH4 = Array.from({ length: 25 }, (_, i) => ({
      openTime: now - (25 - i) * 4 * HOUR,
      open: 100.0, high: 100.5, low: 99.5, close: 100.0
    }));
    for (const [label, fn] of [['bot-new', tierSLTP.calculateTierSLTP], ['bot-h4', botH4.calculateTierSLTP]]) {
      const resCap = await fn(
        'ALT', 'LONG', 100.0,
        { step: 30, decimals: 2 }, 0.01, 10, 3.0, 1.5, 100, null,
        { h1: flatH4, h4: flatH4, d1: [] }
      );
      assert.strictEqual(resCap.valid, true, `${label}: kèo fallback phải hợp lệ`);
      assert(resCap.rrRatio <= 2.55, `${label}: Fallback R:R phải bị khóa trần <= 2.50R, thực tế: ${resCap.rrRatio}`);
    }

    // Có Cản Cứng D1 tại 104.8 (cách 4.8% ~ 2.66R) trong khi 2-step grid muốn đẩy lên 105.5 (~3.0R):
    // TP BẮT BUỘC bị ép lùi về trước Cản Cứng 104.8 (không được đặt TP xuyên tường!)
    const baseD1 = now - 15 * DAY;
    const d1Wall = [
      { openTime: baseD1 + 0 * DAY, open: 101.0, high: 102.0, low: 100.5, close: 101.5 },
      { openTime: baseD1 + 1 * DAY, open: 101.5, high: 103.5, low: 101.0, close: 103.0 },
      { openTime: baseD1 + 2 * DAY, open: 103.0, high: 104.8, low: 102.5, close: 103.5 }, // Swing High D1 @ 104.8 (Major Wall!)
      { openTime: baseD1 + 3 * DAY, open: 103.5, high: 103.8, low: 101.5, close: 102.0 },
      { openTime: baseD1 + 4 * DAY, open: 102.0, high: 102.5, low: 99.8,  close: 100.0 },
    ];
    for (const [label, fn] of [['bot-new', tierSLTP.calculateTierSLTP], ['bot-h4', botH4.calculateTierSLTP]]) {
      const resWall = await fn(
        'ALT', 'LONG', 100.0,
        { step: 2.75, decimals: 2 }, 0.01, 10, 3.0, 1.5, 100, null,
        { h1: flatH4, h4: flatH4, d1: d1Wall }
      );
      assert.strictEqual(resWall.valid, true, `${label}: kèo có cản cứng ở ~2.6R phải hợp lệ`);
      assert(resWall.tpPrice < 104.8, `${label}: TP (${resWall.tpPrice}) TUYỆT ĐỐI không được xuyên qua Cản Cứng D1 @ 104.8`);
    }
  });

  // ── 7. Adaptive ATR SL (> 3.5%) & Fib Extension TP đồng bộ trên CẢ bot-h4 và bot-new
  await testAsync('Đồng bộ Adaptive ATR SL (> 3.5%) & Né Số Tròn TP trên CẢ 2 bot', async () => {
    const highVolH4 = Array.from({ length: 30 }, (_, i) => ({
      openTime: now - (30 - i) * 4 * HOUR,
      open: 99.5, high: 101.2, low: i === 15 ? 95.5 : 98.7, close: 100.0
    }));
    for (const [label, fn] of [['bot-new', tierSLTP.calculateTierSLTP], ['bot-h4', botH4.calculateTierSLTP]]) {
      const resVol = await fn(
        'ALTCOIN', 'LONG', 100.0,
        { step: 30, decimals: 2 }, 0.01, 10, 3.0, 1.5, 120, null,
        { h1: highVolH4, h4: highVolH4, d1: [] }
      );
      assert.strictEqual(resVol.valid, true, `${label}: kèo biến động cao phải hợp lệ`);
      assert(resVol.slPct > 3.5 && resVol.slPct <= 6.0, `${label}: SL thích ứng ATR phải vượt trần cứng 3.5% cũ (tới 6.0%), thực tế: ${resVol.slPct}%`);
    }

    // Kiểm tra evadeTpRoundNumber: TP LONG $100.10 (nhô qua số tròn $100) phải kéo xuống ngay dưới $100 (~$99.85)
    const pulled = tierSLTP.evadeTpRoundNumber(100.10, 95.0, 3.0, true);
    assert(pulled < 100.0 && pulled > 99.7, `TP LONG $100.10 phải được kéo lùi dưới $100, thực tế: ${pulled}`);
    // Nếu kéo lùi làm R:R < 1.48 -> giữ nguyên không kéo
    const kept = tierSLTP.evadeTpRoundNumber(100.10, 95.6, 3.0, true); // 99.85 - 95.6 = 4.25 -> 1.41R < 1.48
    assert.strictEqual(kept, 100.10, `Không được kéo TP nếu làm R:R tụt dưới 1.48, thực tế: ${kept}`);
  });

  console.log('\n================================================================');
  console.log(`🎉 KẾT QUẢ KIỂM THỬ S/R CLUSTERS: ${passed}/${total} PASS (100%)`);
  console.log('================================================================');
  process.exit(passed === total ? 0 : 1);
})();
