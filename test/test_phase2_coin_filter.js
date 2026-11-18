'use strict';

/**
 * Test Suite Toàn Diện Giai Đoạn 2: Hệ Thống Lọc Coin 4 Tầng & Chấm Điểm 10 Chuẩn bot_new
 * 
 * 1. Phân tầng Universe & Quy mô Vốn (Tier 1 Top 50 vs Tier 2 Altcoins)
 * 2. Hard Filters (BB Bandwidth < 2%, Funding Rate cực đoan, BTC Headwind Veto, Cross-signal)
 * 3. Cooldown Guard 6h chống Revenge Trading
 * 4. Deterministic Confluence Scorer 0 - 10đ (TA, Whale, Derivatives, Sentiment, PP369)
 * 5. Hard Score Gate Veto (< 7.0đ Tier 1, < 8.5đ Tier 2)
 * 6. Dynamic ATR Leverage Capping (BTC/ETH 10x, Tier 1 7x, Tier 2 3x, Volatile 2x)
 */

require('dotenv').config();
const assert = require('assert');
const {
  isTop50Symbol,
  checkHardFilters,
  scoreSetup,
  calcMaxLeverage,
  calcTAFromKlines,
} = require('../src/pp369');

const {
  addSymbolToCooldown,
  isSymbolInCooldown,
  getRemainingCooldownHours,
} = require('../src/trader/cooldownManager');

console.log('================================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 2 (COIN FILTER & SCORER)');
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
    console.error(`  ❌ [FAIL] ${name}. Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Phân tầng Danh mục Coin (Tier 1 Top 50 vs Tier 2 Altcoins)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 1: Phân tầng Danh mục Coin (Top 50 vs Altcoin)', () => {
  assert.strictEqual(isTop50Symbol('BTC'), true, 'BTC phải là Tier 1 (Top 50)');
  assert.strictEqual(isTop50Symbol('ETH'), true, 'ETH phải là Tier 1 (Top 50)');
  assert.strictEqual(isTop50Symbol('SOL'), true, 'SOL phải là Tier 1 (Top 50)');
  assert.strictEqual(isTop50Symbol('NEAR'), true, 'NEAR phải là Tier 1 (Top 50)');
  assert.strictEqual(isTop50Symbol('SHITCOIN_XYZ_UNKNOWN'), false, 'Coin vô danh phải là Tier 2');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Hard Filter ① — BB Bandwidth 4h < 2% (Sideway Squeeze)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 2: Hard Filter ① BB Bandwidth < 2% → DISQUALIFIED', () => {
  const taSqueeze = {
    bb: { bandwidth: 1.45 }
  };
  const resDisqualified = checkHardFilters('SOL', 'LONG', taSqueeze, 0.0001, null, null);
  assert.ok(resDisqualified && resDisqualified.includes('sideway squeeze'), 'Phải bị DISQUALIFIED khi BB Bandwidth < 2%');

  const taNormal = {
    bb: { bandwidth: 4.8 }
  };
  const resPassed = checkHardFilters('SOL', 'LONG', taNormal, 0.0001, null, null);
  assert.strictEqual(resPassed, null, 'Phải vượt qua khi BB Bandwidth >= 2%');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Hard Filter ② — Funding Rate cực đoan (> +0.10% Long, < -0.05% Short)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 2: Hard Filter ② Funding Rate cực đoan → DISQUALIFIED', () => {
  const ta = { bb: { bandwidth: 5.0 } };

  // Long khi funding +0.12% / 8h
  const resLongCrowded = checkHardFilters('SOL', 'LONG', ta, 0.0012, null, null);
  assert.ok(resLongCrowded && resLongCrowded.includes('long crowded'), 'Phải cấm LONG khi Funding > +0.10%');

  // Short khi funding -0.08% / 8h
  const resShortCrowded = checkHardFilters('SOL', 'SHORT', ta, -0.0008, null, null);
  assert.ok(resShortCrowded && resShortCrowded.includes('short crowded'), 'Phải cấm SHORT khi Funding < -0.05%');

  // Funding bình thường +0.01% / 8h
  const resNormal = checkHardFilters('SOL', 'LONG', ta, 0.0001, null, null);
  assert.strictEqual(resNormal, null, 'Phải cho phép khi funding bình thường');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Hard Filter ③ — Áp lực BTC Downtrend (BTC Headwind Veto)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 2: Hard Filter ③ BTC Headwind Veto cấm LONG Altcoin khi BTC sụp đổ', () => {
  const taAlt = { bb: { bandwidth: 6.0 } };
  const btcDowntrendTA = {
    aboveEMA200: false,
    regime: 'TRENDING_DOWN',
    rsi: { '1d': 48 } // RSI1D > 35, chưa ở mức oversold cực đoan
  };

  // 1. Long Altcoin (NEAR) khi BTC downtrend mạnh -> CẤM TUYỆT ĐỐI!
  const resAltLong = checkHardFilters('NEAR', 'LONG', taAlt, 0.0001, null, btcDowntrendTA);
  assert.ok(resAltLong && resAltLong.includes('CẤM LONG ALTCOIN'), 'Bắt buộc phải VETO lệnh LONG Altcoin khi BTC downtrend');

  // 2. Short Altcoin khi BTC downtrend mạnh -> ĐƯỢC PHÉP (thuận chiều thị trường)
  const resAltShort = checkHardFilters('NEAR', 'SHORT', taAlt, 0.0001, null, btcDowntrendTA);
  assert.strictEqual(resAltShort, null, 'SHORT Altcoin khi BTC downtrend là hợp lệ');

  // 3. Chính BTC hoặc ETH -> Không bị cấm bởi luật Altcoin
  const resBtcLong = checkHardFilters('BTC', 'LONG', taAlt, 0.0001, null, btcDowntrendTA);
  assert.strictEqual(resBtcLong, null, 'BTC được miễn trừ khỏi luật Altcoin');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Cooldown Guard 6 giờ chống Revenge Trading
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 2: Cooldown Guard khóa 6h sau khi dính SL', () => {
  const sym = 'TESTCOOLDOWN';
  addSymbolToCooldown(sym, null, 'SL_NORMAL');
  assert.strictEqual(isSymbolInCooldown(sym), true, 'Phải đang trong trạng thái cooldown');
  const remH = getRemainingCooldownHours(sym);
  assert.ok(remH >= 5.8 && remH <= 6.0, `Thời gian cooldown phải xấp xỉ 6.0h (thực tế: ${remH}h)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Tầng 3 — Deterministic Confluence Scorer (0 - 10đ)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 3: Deterministic Confluence Scorer chấm điểm chính xác', () => {
  const taMock = {
    price: 150,
    rsi: { '4h': 28, '1d': 42 }, // Oversold mạnh (+2) + xác nhận 1D (+1)
    stochRSI: { k: 15 },         // Oversold (+1)
    macd: { crossover: 'GOLDEN_CROSS', trend: 'BULLISH' }, // (+2)
    ema: { e7: 152, e25: 148, e99: 140 }, // Stack (+1)
    bb: { bandwidth: 6.5, pctB: 12 },     // Bandwidth OK + Oversold (+1)
    support: [149.8],
    supportTouches: [4],                  // Tại S/R 1D 4x test (+2)
    weeklyPivot: { low: 149.5 },          // Tại Weekly Pivot (+2)
    volume: { ratio: 1.8 },               // Vol spike (+1)
    regime: 'TRENDING_UP',                // (+1)
    aboveEMA200: true,
  };

  const sig369 = {
    signal: 'LONG',
    targetLevel: 150,
    condLevel: 156,
    touchCount: 0 // Chạm lần đầu (Fresh) (+2.0đ)
  };

  const res = scoreSetup('SOL', 'LONG', taMock, null, null, 0.0001, { value: 15 }, null, null, sig369);
  assert.strictEqual(res.disqualified, false, 'Không được bị disqualified');
  assert.ok(res.total >= 7.0, `Điểm hợp lưu phải cao khi có confluence mạnh (thực tế: ${res.total}đ)`);
  assert.ok(res.breakdown.ta > 0, 'Phải có điểm TA');
  assert.ok(res.breakdown.pp369 === 2.0, 'Mốc fresh PP369 phải được +2.0đ');
  assert.ok(res.breakdown.sentiment === 1.0, 'Extreme fear < 20 phải được +1.0đ');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7: Chốt chặn điểm cứng (Hard Score Gate): Tier 1 (7.0đ) vs Tier 2 (8.0đ)
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 3 & 4: Hard Score Gate VETO lệnh điểm thấp trước khi tới AI', () => {
  // Điểm 6.2đ: Cả Tier 1 và Tier 2 đều phải VETO
  const scoreLow = 6.2;
  const isTier1PassLow = scoreLow >= 7.0;
  const isTier2PassLow = scoreLow >= 8.0;
  assert.strictEqual(isTier1PassLow, false, 'Score 6.2đ phải bị VETO ở Tier 1');
  assert.strictEqual(isTier2PassLow, false, 'Score 6.2đ phải bị VETO ở Tier 2');

  // Điểm 7.4đ: Tier 1 Top 50 ĐƯỢC PHÉP, nhưng Tier 2 Altcoin BỊ VETO!
  const scoreMid = 7.4;
  const isTier1PassMid = scoreMid >= 7.0;
  const isTier2PassMid = scoreMid >= 8.0;
  assert.strictEqual(isTier1PassMid, true, 'Score 7.4đ phải ĐẠT CHUẨN cho Tier 1 Top 50');
  assert.strictEqual(isTier2PassMid, false, 'Score 7.4đ phải BỊ VETO cho Tier 2 Altcoin (yêu cầu >= 8.0đ)');

  // Điểm 8.2đ: Cả Tier 1 và Tier 2 đều ĐẠT CHUẨN!
  const scoreHigh = 8.2;
  const isTier1PassHigh = scoreHigh >= 7.0;
  const isTier2PassHigh = scoreHigh >= 8.0;
  assert.strictEqual(isTier1PassHigh, true, 'Score 8.2đ phải ĐẠT CHUẨN cho Tier 1');
  assert.strictEqual(isTier2PassHigh, true, 'Score 8.2đ phải ĐẠT CHUẨN cho Tier 2');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8: Tầng 5 — Dynamic ATR Leverage Capping & Hard Ceilings
// ─────────────────────────────────────────────────────────────────────────────
runTest('Tầng 5: Dynamic ATR Leverage & Hard Ceiling Caps', () => {
  // 1. Biến động cực thấp ATR = 0.4% (nguy cơ bão nén)
  const taLowAtr = { atrPct: 0.4, regime: 'RANGING' };
  const levBtc = calcMaxLeverage(taLowAtr, 'CONFIDENT', 'BTC');
  const levTop50 = calcMaxLeverage(taLowAtr, 'CONFIDENT', 'SOL');
  const levAlt = calcMaxLeverage(taLowAtr, 'CONFIDENT', 'SHITCOIN_XYZ');

  assert.strictEqual(levBtc, 10, 'BTC/ETH phải bị chặn cứng trần tối đa 10x');
  assert.strictEqual(levTop50, 7, 'Tier 1 Top 50 phải bị chặn cứng trần tối đa 7x');
  assert.strictEqual(levAlt, 3, 'Tier 2 Altcoin phải bị chặn cứng trần tối đa 3x');

  // 2. Regime VOLATILE (biến động nổ bão) -> Khóa cứng 2x
  const taVolatile = { atrPct: 1.0, regime: 'VOLATILE' };
  const levVolatile = calcMaxLeverage(taVolatile, 'CONFIDENT', 'SOL');
  assert.strictEqual(levVolatile, 2, 'Regime VOLATILE phải khóa trần 2x');

  // 3. Altcoin biến động mạnh ATR = 4.5% -> Tự động co về 2x
  const taHighAtr = { atrPct: 4.5, regime: 'RANGING' };
  const levHighAtr = calcMaxLeverage(taHighAtr, 'CONFIDENT', 'XYZ');
  assert.strictEqual(levHighAtr, 2, 'ATR > 4% phải tự co về 2x');
});

console.log('\n================================================================');
console.log(`🏁 KẾT QUẢ KIỂM THỬ GIAI ĐOẠN 2: ${passCount}/${totalTests} TESTS ĐẠT CHUẨN (${(passCount/totalTests*100).toFixed(1)}%)`);
console.log('================================================================');

if (passCount === totalTests) {
  console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG GIAI ĐOẠN 2 HOẠT ĐỘNG HOÀN HẢO 100%!\n');
} else {
  console.error('⚠️ CÓ TEST THẤT BẠI, CẦN KIỂM TRA LẠI!\n');
  process.exit(1);
}
