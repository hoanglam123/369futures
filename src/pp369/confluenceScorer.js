'use strict';

/**
 * Confluence Scorer — Chấm điểm tín hiệu 4 Tầng Chuẩn bot_new (0 - 10đ)
 * 
 * Tầng 1: Phân tầng Danh mục Coin & Quy mô Vốn (Tier 1 Top 50 vs Tier 2 Altcoins)
 * Tầng 2: Hard Filters (BB Bandwidth < 2%, Funding Rate cực đoan, BTC Headwind Veto, Cross-Signal)
 * Tầng 3: Deterministic Confluence Scoring (TA 4h/1D, Whale, Derivatives, Sentiment, PP369 Grid)
 * Tầng 4: Phối hợp AI Reviewer (Chốt chặn điểm cứng >= 7.0đ Tier 1, >= 8.5đ Tier 2)
 * Tầng 5: Dynamic ATR Leverage Capping (BTC/ETH 10x, Tier 1 7x, Tier 2 3x, Volatile 2x)
 */

const BTC_ETH = new Set(['BTC', 'ETH']);

const CORE_TOP50_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK',
  'SUI', 'APT', 'NEAR', 'ICP', 'SHIB', 'DOT', 'BCH', 'UNI', 'LTC', 'PEPE',
  'FET', 'POL', 'RENDER', 'XLM', 'AAVE', 'TAO', 'TIA', 'INJ', 'SEI', 'STX',
  'FIL', 'ARB', 'OP', 'KAS', 'ATOM', 'WIF', 'BONK', 'FLOKI', 'RUNE', 'FTM',
  'MKR', 'IMX', 'GRT', 'ALGO', 'SAND', 'MANA', 'THETA', 'JUP', 'ENA', 'PENDLE'
]);

/**
 * Kiểm tra symbol có thuộc Top 50 (Tier 1) hay không.
 */
function isTop50Symbol(symbol) {
  if (!symbol) return false;
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  if (BTC_ETH.has(cleanSym) || CORE_TOP50_SYMBOLS.has(cleanSym)) return true;
  try {
    const { getMarketCapRank } = require('./core');
    if (typeof getMarketCapRank === 'function') {
      const rank = getMarketCapRank(cleanSym);
      return rank <= 50;
    }
  } catch (_) {}
  return false;
}

// ─── TÍNH TOÁN ĐÒN BẨY ĐỘNG THEO ATR 4H & TRẦN AN TOÀN ──────────────────────────

/**
 * Tính max leverage dựa trên ATR (volatility thực tế), tier coin, verdict và regime.
 *
 * ATR-based cap:
 *   < 0.8%   → 10x (BTC/ETH thị trường ổn định)
 *   0.8-1.5% → 7x
 *   1.5-2.5% → 5x
 *   2.5-4%   → 3x
 *   > 4%     → 2x (altcoin biến động mạnh)
 *
 * Hard ceiling caps:
 *   BTC/ETH → 10x | Tier 1 (Top 50) → 7x | Tier 2 (Altcoins) → 3x
 *
 * Điều chỉnh thêm:
 *   Regime VOLATILE → hard cap 2x
 *   Verdict CAUTIOUS → giảm thêm 2x
 */
function calcMaxLeverage(ta, verdict, symbol) {
  const atrPct = ta?.atrPct;
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');

  // Base từ ATR
  let maxLev;
  if (!atrPct || atrPct <= 0) maxLev = 3;
  else if (atrPct < 0.8)      maxLev = 10;
  else if (atrPct < 1.5)      maxLev = 7;
  else if (atrPct < 2.5)      maxLev = 5;
  else if (atrPct < 4.0)      maxLev = 3;
  else                         maxLev = 2;

  // Coin tier hard ceiling
  if (BTC_ETH.has(cleanSym)) {
    maxLev = Math.min(maxLev, 10);
  } else if (isTop50Symbol(cleanSym)) {
    maxLev = Math.min(maxLev, 7);
  } else {
    maxLev = Math.min(maxLev, 3);
  }

  // Regime VOLATILE → hard cap 2x (giá có thể spike xuyên SL)
  if (ta?.regime === 'VOLATILE') {
    maxLev = Math.min(maxLev, 2);
  }

  // CAUTIOUS → giảm thêm (signal yếu, không nên dùng leverage cao)
  if (verdict === 'CAUTIOUS') {
    maxLev = Math.max(1, maxLev - 2);
  }

  return maxLev;
}

function fmtM(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

// ─── TẦNG 2: HARD FILTERS (BỘ LỌC CỨNG TIÊN QUYẾT) ────────────────────────────

/**
 * Kiểm tra các tiêu chuẩn cứng. Vi phạm 1 tiêu chí → DISQUALIFIED ngay lập tức!
 */
function checkHardFilters(symbol, direction, ta, fundingRates, whaleData, btcTA) {
  const isLong = direction === 'LONG';
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');

  // ① BB Bandwidth < 2%: sideway squeeze, thị trường nén bế tắc, cấm vào đón đầu
  if (ta?.bb?.bandwidth != null && ta.bb.bandwidth < 2.0) {
    return `BB Bandwidth ${ta.bb.bandwidth.toFixed(2)}% < 2% → sideway squeeze`;
  }

  // ② Funding rate cực đoan
  let fundingRate = null;
  if (typeof fundingRates === 'number') {
    fundingRate = fundingRates;
  } else if (fundingRates?.binance) {
    fundingRate = fundingRates.binance[cleanSym] ?? fundingRates.binance[symbol];
  } else if (fundingRates && fundingRates[cleanSym] != null) {
    fundingRate = fundingRates[cleanSym];
  }

  if (fundingRate != null) {
    if (isLong && fundingRate > 0.0010) { // > +0.10% / 8h
      return `Funding +${(fundingRate * 100).toFixed(4)}%/8h > 0.10% → long crowded`;
    }
    if (!isLong && fundingRate < -0.0005) { // < -0.05% / 8h
      return `Funding ${(fundingRate * 100).toFixed(4)}%/8h < -0.05% → short crowded`;
    }
  }

  // ③ Cross-signal phân kỳ (OKX vs Binance ngược chiều)
  const cs = whaleData?.crossSignals?.[cleanSym] || whaleData?.crossSignals?.[symbol];
  if (cs?.verdict === 'PHÂN KỲ/TRUNG TÍNH') {
    return `Cross-signal PHÂN KỲ (OKX ↔ Binance ngược chiều)`;
  }

  // ④ Áp lực BTC Downtrend (BTC Headwind Veto)
  // Nếu BTC nằm dưới EMA200 1D, nến 4h xu hướng giảm mạnh (regime = TRENDING_DOWN) và RSI 1D > 35
  // → CẤM TUYỆT ĐỐI MỌI LỆNH LONG TRÊN ALTCOIN (ngoại trừ BTC và ETH)
  if (isLong && cleanSym !== 'BTC' && cleanSym !== 'ETH' && btcTA) {
    const btcRsi1d = btcTA.rsi?.['1d'] ?? 50;
    if (btcTA.aboveEMA200 === false && btcTA.regime === 'TRENDING_DOWN' && btcRsi1d > 35) {
      return `BTC dưới EMA200D + TRENDING_DOWN (RSI1D=${btcRsi1d.toFixed(0)}) — CẤM LONG ALTCOIN`;
    }
  }

  return null; // Đạt tất cả tiêu chuẩn lọc cứng
}

// ─── CHỈ BÁO KỸ THUẬT THUẦN TÚY (DETERMINISTIC TA) ─────────────────────────────

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0,  d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const k12 = 2/13, k26 = 2/27, k9 = 2/10;
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b) / 26;
  for (let i = 12; i < 26; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
  }

  const macdLine = [];
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    macdLine.push(e12 - e26);
  }
  if (macdLine.length < 9) return null;

  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b) / 9;
  const sigLine = [sig];
  for (let i = 9; i < macdLine.length; i++) {
    sig = macdLine[i] * k9 + sig * (1 - k9);
    sigLine.push(sig);
  }

  const n = macdLine.length - 1;
  const currM = macdLine[n], currS = sigLine[n];
  const prevM = macdLine[n - 1], prevS = sigLine[n - 1];
  return {
    macd: currM, signal: currS, histogram: currM - currS,
    trend: currM > currS ? 'BULLISH' : 'BEARISH',
    crossover: prevM < prevS && currM >= currS ? 'GOLDEN_CROSS' :
               prevM > prevS && currM <= currS ? 'DEATH_CROSS' : null,
  };
}

function calcBB(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2) / period);
  const curr  = closes[closes.length - 1];
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  return {
    upper, middle: mean, lower,
    bandwidth: mult * 2 * std / (mean || 1) * 100,
    pctB: (upper === lower) ? 50 : (curr - lower) / (upper - lower) * 100,
  };
}

function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = klines.slice(1).map((k, i) => Math.max(
    k.h - k.l,
    Math.abs(k.h - klines[i].c),
    Math.abs(k.l - klines[i].c)
  ));
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3) {
  if (!closes || closes.length < rsiPeriod + stochPeriod + kPeriod) return null;
  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    rsiSeries.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
  }
  if (rsiSeries.length < stochPeriod + kPeriod) return null;

  const stoch = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const slice = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const minR = Math.min(...slice), maxR = Math.max(...slice);
    stoch.push(maxR === minR ? 0 : (rsiSeries[i] - minR) / (maxR - minR) * 100);
  }
  if (stoch.length < kPeriod) return null;
  const k = stoch.slice(-kPeriod).reduce((a, b) => a + b) / kPeriod;
  return { k, signal: k > 80 ? 'OVERBOUGHT' : k < 20 ? 'OVERSOLD' : 'NEUTRAL' };
}

function clusterSR(klines, lookback = 90, tolerance = 0.005) {
  const recent = (klines || []).slice(-lookback);
  if (recent.length < 8) return { support: [], resistance: [], supportTouches: [], resistanceTouches: [] };
  const price = recent[recent.length - 1].c;

  const pivots = [];
  for (let i = 3; i < recent.length - 3; i++) {
    const h = recent[i].h, l = recent[i].l;
    if (h > recent[i-1].h && h > recent[i-2].h && h > recent[i-3].h &&
        h > recent[i+1].h && h > recent[i+2].h && h > recent[i+3].h) pivots.push(h);
    if (l < recent[i-1].l && l < recent[i-2].l && l < recent[i-3].l &&
        l < recent[i+1].l && l < recent[i+2].l && l < recent[i+3].l) pivots.push(l);
  }
  if (!pivots.length) return { support: [], resistance: [], supportTouches: [], resistanceTouches: [] };

  const sorted = [...pivots].sort((a, b) => a - b);
  const clusters = [];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const mid = cluster.reduce((a, b) => a + b) / cluster.length;
    if (Math.abs(sorted[i] - mid) / (mid || 1) <= tolerance) {
      cluster.push(sorted[i]);
    } else {
      clusters.push(cluster);
      cluster = [sorted[i]];
    }
  }
  clusters.push(cluster);

  const levels = clusters.map(c => ({
    price: c.reduce((a, b) => a + b) / c.length,
    touches: c.length,
  }));

  const resistance = levels
    .filter(l => l.price > price * 1.001)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  const support = levels
    .filter(l => l.price < price * 0.999)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);

  return {
    resistance: resistance.map(l => l.price),
    support: support.map(l => l.price),
    resistanceTouches: resistance.map(l => l.touches),
    supportTouches: support.map(l => l.touches),
  };
}

function analyzeVolume(klines, period = 20) {
  if (!klines || !klines.length) return { ratio: 1, label: 'bình thường' };
  const curr = klines[klines.length - 1].v;
  const slice = klines.slice(-period);
  const avg = slice.reduce((a, b) => a + b.v, 0) / (slice.length || 1);
  const ratio = avg > 0 ? curr / avg : 1.0;
  return {
    ratio,
    label: ratio > 2.5 ? 'SPIKE RẤT CAO' : ratio > 1.5 ? 'cao' :
           ratio < 0.5 ? 'RẤT THẤP'      : ratio < 0.8 ? 'thấp' : 'bình thường',
  };
}

function detectRegime(k1d, bb4h) {
  if (!k1d || k1d.length < 10) return 'RANGING';
  if (bb4h?.bandwidth > 12) return 'VOLATILE';

  const recent = k1d.slice(-10);
  let hhhl = 0, lhll = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].h > recent[i - 1].h && recent[i].l > recent[i - 1].l) hhhl++;
    if (recent[i].h < recent[i - 1].h && recent[i].l < recent[i - 1].l) lhll++;
  }

  if (hhhl >= 5) return 'TRENDING_UP';
  if (lhll >= 5) return 'TRENDING_DOWN';
  return 'RANGING';
}

function normalizeKlines(rawKlines) {
  if (!Array.isArray(rawKlines)) return [];
  return rawKlines.map(k => ({
    t: k.t ?? k.openTime ?? 0,
    o: k.o ?? k.open ?? 0,
    h: k.h ?? k.high ?? 0,
    l: k.l ?? k.low ?? 0,
    c: k.c ?? k.close ?? 0,
    v: k.v ?? k.volume ?? 0,
  }));
}

/**
 * Tính toán toàn bộ thông số TA từ các tập nến k1h, k4h, k1d, k1w
 */
function calcTAFromKlines(symbol, raw1h, raw4h, raw1d, raw1w) {
  const k4h = normalizeKlines(raw4h);
  if (!k4h || k4h.length === 0) return null;

  const k1h = normalizeKlines(raw1h);
  const k1d = normalizeKlines(raw1d);
  const k1w = normalizeKlines(raw1w);

  const c4h = k4h.map(k => k.c);
  const c1h = k1h.length ? k1h.map(k => k.c) : null;
  const c1d = k1d.length ? k1d.map(k => k.c) : null;
  const price = c4h[c4h.length - 1];

  const ema7    = calcEMA(c4h, 7);
  const ema25   = calcEMA(c4h, 25);
  const ema99   = calcEMA(c4h, 99);
  const ema200d = c1d ? calcEMA(c1d, 200) : null;

  let trend = 'SIDEWAY';
  if (ema7 && ema25) {
    if (price > ema7 && ema7 > ema25 && (!ema99 || ema25 > ema99)) trend = 'TĂNG MẠNH';
    else if (price > ema7 && ema7 > ema25) trend = 'TĂNG';
    else if (price < ema7 && ema7 < ema25 && (!ema99 || ema25 < ema99)) trend = 'GIẢM MẠNH';
    else if (price < ema7 && ema7 < ema25) trend = 'GIẢM';
  }
  const aboveEMA200 = ema200d != null ? price > ema200d : null;

  const rsi4h = calcRSI(c4h, 14);
  const rsi1h = c1h ? calcRSI(c1h, 14) : null;
  const rsi1d = c1d ? calcRSI(c1d, 14) : null;

  const macd4h   = calcMACD(c4h);
  const bb4h     = calcBB(c4h, 20, 2);
  const atr4h    = calcATR(k4h, 14);
  const stochRSI = c4h.length >= 60 ? calcStochRSI(c4h, 14, 14, 3) : null;

  const { support, resistance, supportTouches, resistanceTouches } =
    k1d.length >= 20 ? clusterSR(k1d, 90) : clusterSR(k4h, 60);

  const { support: support4h, resistance: resistance4h,
          supportTouches: support4hTouches, resistanceTouches: resistance4hTouches } =
    clusterSR(k4h, 60, 0.003);

  let weeklyPivot = null;
  if (k1w && k1w.length >= 2) {
    const pw = k1w[k1w.length - 2];
    weeklyPivot = { high: pw.h, low: pw.l };
  }

  const regime = detectRegime(k1d, bb4h);
  const vol = analyzeVolume(k4h, 20);

  return {
    symbol, price, trend, aboveEMA200,
    rsi: { '1h': rsi1h, '4h': rsi4h, '1d': rsi1d },
    ema: { e7: ema7, e25: ema25, e99: ema99, e200d: ema200d },
    macd: macd4h,
    bb: bb4h,
    atr: atr4h,
    atrPct: atr4h && price > 0 ? (atr4h / price * 100) : null,
    stochRSI,
    support, resistance, supportTouches, resistanceTouches,
    support4h, resistance4h, support4hTouches, resistance4hTouches,
    weeklyPivot, regime,
    volume: vol,
    oi: null,
  };
}

// ─── TẦNG 3: BỘ CHẤM ĐIỂM HỢP LƯU ĐỊNH LƯỢNG (0 - 10đ) ─────────────────────────

// 1. TA Scoring (Tối đa 3.5đ)
function scoreTechnical(ta, direction) {
  if (!ta) return { score: 0, reasons: [] };
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];
  const price = ta.price;

  // RSI 4h
  const rsi4h = ta.rsi?.['4h'];
  if (rsi4h != null) {
    if (isLong) {
      if (rsi4h < 30)      { score += 2; reasons.push(`RSI4h ${rsi4h.toFixed(0)} oversold nặng (+2)`); }
      else if (rsi4h < 40) { score += 1; reasons.push(`RSI4h ${rsi4h.toFixed(0)} oversold (+1)`); }
    } else {
      if (rsi4h > 70)      { score += 2; reasons.push(`RSI4h ${rsi4h.toFixed(0)} overbought nặng (+2)`); }
      else if (rsi4h > 60) { score += 1; reasons.push(`RSI4h ${rsi4h.toFixed(0)} overbought (+1)`); }
    }
  }

  // RSI 1D xác nhận
  const rsi1d = ta.rsi?.['1d'];
  if (rsi1d != null) {
    if (isLong && rsi1d < 45)       { score += 1; reasons.push(`RSI1D ${rsi1d.toFixed(0)} xác nhận LONG (+1)`); }
    else if (!isLong && rsi1d > 55) { score += 1; reasons.push(`RSI1D ${rsi1d.toFixed(0)} xác nhận SHORT (+1)`); }
  }

  // StochRSI 4h
  const stoch = ta.stochRSI?.k;
  if (stoch != null) {
    if (isLong && stoch < 20)       { score += 1; reasons.push(`StochRSI K=${stoch.toFixed(0)} oversold (+1)`); }
    else if (!isLong && stoch > 80) { score += 1; reasons.push(`StochRSI K=${stoch.toFixed(0)} overbought (+1)`); }
  }

  // MACD 4h
  if (ta.macd) {
    const { trend, crossover } = ta.macd;
    if (isLong) {
      if (crossover === 'GOLDEN_CROSS') { score += 2; reasons.push('MACD GOLDEN_CROSS (+2)'); }
      else if (trend === 'BULLISH')     { score += 1; reasons.push('MACD BULLISH trend (+1)'); }
    } else {
      if (crossover === 'DEATH_CROSS') { score += 2; reasons.push('MACD DEATH_CROSS (+2)'); }
      else if (trend === 'BEARISH')    { score += 1; reasons.push('MACD BEARISH trend (+1)'); }
    }
  }

  // EMA 4h stack
  const { e7, e25, e99 } = ta.ema || {};
  if (e7 && e25 && price) {
    if (isLong) {
      if (e99 && price > e7 && e7 > e25 && e25 > e99) { score += 2; reasons.push('EMA stack LONG hoàn toàn (+2)'); }
      else if (price > e7 && e7 > e25)                 { score += 1; reasons.push('EMA partial LONG (+1)'); }
    } else {
      if (e99 && price < e7 && e7 < e25 && e25 < e99) { score += 2; reasons.push('EMA stack SHORT hoàn toàn (+2)'); }
      else if (price < e7 && e7 < e25)                 { score += 1; reasons.push('EMA partial SHORT (+1)'); }
    }
  }

  // S/R 1D cluster
  const srLevels  = isLong ? (ta.support    || []) : (ta.resistance    || []);
  const srTouches = isLong ? (ta.supportTouches || []) : (ta.resistanceTouches || []);
  if (srLevels.length && price) {
    const closest = srLevels[0];
    const distPct = Math.abs(price - closest) / price * 100;
    const touches = srTouches[0] || 1;
    const touchBonus = touches >= 3 ? 1 : 0;
    if (distPct < 0.5) {
      score += 1 + touchBonus;
      reasons.push(`Tại S/R 1D (${distPct.toFixed(1)}%, ${touches}x test) (+${1 + touchBonus})`);
    } else if (distPct < 1.5) {
      score += 1;
      reasons.push(`Gần S/R 1D (${distPct.toFixed(1)}%, ${touches}x test) (+1)`);
    }
  }

  // S/R 4H cluster
  const sr4hLevels  = isLong ? (ta.support4h    || []) : (ta.resistance4h    || []);
  const sr4hTouches = isLong ? (ta.support4hTouches || []) : (ta.resistance4hTouches || []);
  if (sr4hLevels.length && price) {
    const closest4h = sr4hLevels[0];
    const distPct4h = Math.abs(price - closest4h) / price * 100;
    const touches4h = sr4hTouches[0] || 1;
    if (distPct4h < 0.3) {
      score += 2;
      reasons.push(`Tại S/R 4H (${distPct4h.toFixed(1)}%, ${touches4h}x test) (+2)`);
    } else if (distPct4h < 0.8) {
      score += 1;
      reasons.push(`Gần S/R 4H (${distPct4h.toFixed(1)}%, ${touches4h}x test) (+1)`);
    }
  }

  // Weekly pivot proximity
  if (ta.weeklyPivot && price) {
    const wp = isLong ? ta.weeklyPivot.low : ta.weeklyPivot.high;
    const distPct = Math.abs(price - wp) / price * 100;
    if (distPct < 0.8) {
      score += 2;
      reasons.push(`Tại Weekly Pivot (${distPct.toFixed(1)}%) (+2)`);
    } else if (distPct < 2.0) {
      score += 1;
      reasons.push(`Gần Weekly Pivot (${distPct.toFixed(1)}%) (+1)`);
    }
  }

  // Volume spike
  if (ta.volume?.ratio > 1.5) {
    score += 1;
    reasons.push(`Volume ${ta.volume.ratio.toFixed(1)}x bình thường (+1)`);
  }

  // BB %B cực đoan
  if (ta.bb?.pctB != null) {
    if (isLong && ta.bb.pctB < 15)       { score += 1; reasons.push(`BB %B=${ta.bb.pctB.toFixed(0)}% oversold (+1)`); }
    else if (!isLong && ta.bb.pctB > 85) { score += 1; reasons.push(`BB %B=${ta.bb.pctB.toFixed(0)}% overbought (+1)`); }
  }

  // EMA 200D bias penalty
  if (ta?.aboveEMA200 !== null && ta?.aboveEMA200 !== undefined) {
    const rsi1dVal = ta.rsi?.['1d'] ?? 50;
    if (isLong && !ta.aboveEMA200 && rsi1dVal > 35) {
      score -= 2;
      reasons.push(`Dưới EMA200D (RSI1D=${rsi1dVal.toFixed(0)}) — bearish bias (-2)`);
    } else if (!isLong && ta.aboveEMA200 && rsi1dVal < 65) {
      score -= 2;
      reasons.push(`Trên EMA200D (RSI1D=${rsi1dVal.toFixed(0)}) — bullish bias (-2)`);
    }
  }

  // Regime bonus
  if (ta.regime) {
    if (isLong && ta.regime === 'TRENDING_UP')    { score += 1; reasons.push('Regime TRENDING_UP + LONG (+1)'); }
    if (!isLong && ta.regime === 'TRENDING_DOWN') { score += 1; reasons.push('Regime TRENDING_DOWN + SHORT (+1)'); }
    if (ta.regime === 'VOLATILE')                 { score -= 1; reasons.push('Regime VOLATILE — rủi ro cao (-1)'); }
  }

  return { score, reasons };
}

// 2. Whale & Liquidations Scoring
function scoreWhale(symbol, direction, whaleData) {
  if (!whaleData) return { score: 0, reasons: [] };
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  const tf = whaleData.takerFlow?.[symbol];
  if (tf) {
    if (isLong && tf.bias === 'BUY_PRESSURE')       { score += 1; reasons.push(`OKX Taker Flow BUY ${tf.buyPct?.toFixed(1)}% (+1)`); }
    else if (!isLong && tf.bias === 'SELL_PRESSURE') { score += 1; reasons.push(`OKX Taker Flow SELL ${tf.sellPct?.toFixed(1)}% (+1)`); }
  }

  const bn = whaleData.binanceLarge?.[symbol];
  if (bn) {
    if (isLong && bn.bias === 'WHALE_BUY')       { score += 1; reasons.push(`BN large trades WHALE_BUY (+1)`); }
    else if (!isLong && bn.bias === 'WHALE_SELL') { score += 1; reasons.push(`BN large trades WHALE_SELL (+1)`); }

    const whl = bn.tiers?.WHALE;
    const ins = bn.tiers?.INSTITUTION;
    if (whl && (whl.buyVol + whl.sellVol > 0)) {
      if (isLong && whl.buyVol > whl.sellVol)       { score += 1; reasons.push(`WHALE $5M-$20M BUY ${fmtM(whl.buyVol)} (+1)`); }
      else if (!isLong && whl.sellVol > whl.buyVol) { score += 1; reasons.push(`WHALE $5M-$20M SELL ${fmtM(whl.sellVol)} (+1)`); }
    }
    if (ins && (ins.buyVol + ins.sellVol > 0)) {
      if (isLong && ins.buyVol > ins.sellVol)       { score += 2; reasons.push(`INSTITUTION ≥$20M BUY ${fmtM(ins.buyVol)} (+2) ⚡`); }
      else if (!isLong && ins.sellVol > ins.buyVol) { score += 2; reasons.push(`INSTITUTION ≥$20M SELL ${fmtM(ins.sellVol)} (+2) ⚡`); }
    }
  }

  const cs = whaleData.crossSignals?.[symbol];
  if (cs) {
    if (isLong && cs.verdict === 'XÁC NHẬN MUA')       { score += 1; reasons.push('Cross-signal XÁC NHẬN MUA (+1)'); }
    else if (!isLong && cs.verdict === 'XÁC NHẬN BÁN') { score += 1; reasons.push('Cross-signal XÁC NHẬN BÁN (+1)'); }
  }

  const liq = whaleData.liquidations?.[symbol];
  if (liq && liq.totalLiq > 0) {
    const longPct  = liq.longLiqVol  / liq.totalLiq * 100;
    const shortPct = liq.shortLiqVol / liq.totalLiq * 100;
    if (isLong && liq.dominant === 'SHORT_SQUEEZE' && shortPct > 65) {
      score += 2;
      reasons.push(`SHORT_SQUEEZE ${fmtM(liq.shortLiqVol)} (${shortPct.toFixed(0)}% short liq) (+2) ⚡`);
    } else if (!isLong && liq.dominant === 'LONG_SQUEEZE' && longPct > 65) {
      score += 2;
      reasons.push(`LONG_SQUEEZE ${fmtM(liq.longLiqVol)} (${longPct.toFixed(0)}% long liq) (+2) ⚡`);
    }
  }

  return { score, reasons };
}

// 3. Derivatives Scoring
function scoreDerivatives(symbol, direction, derivatives) {
  const d = derivatives?.[symbol];
  if (!d) return { score: 0, reasons: [] };
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  if (d.oi) {
    if (isLong && d.oi.trend === 'RISING')        { score += 1.0; reasons.push(`OI RISING +${d.oi.changePct?.toFixed(1)}% (+1.0)`); }
    else if (!isLong && d.oi.trend === 'RISING')  { score += 1.0; reasons.push(`OI RISING (vốn short mới) (+1.0)`); }
    else if (isLong && d.oi.trend === 'FALLING')  { score -= 1.0; reasons.push('OI FALLING khi LONG (-1.0)'); }
  }

  const ls = d.lsSignal;
  if (ls) {
    if (isLong && ls.contrarian === 'CONTRARIAN_LONG')       { score += 1.0; reasons.push('Retail quá SHORT → contrarian LONG (+1.0)'); }
    else if (!isLong && ls.contrarian === 'CONTRARIAN_SHORT') { score += 1.0; reasons.push('Retail quá LONG → contrarian SHORT (+1.0)'); }

    if (ls.divergence) {
      if (isLong && d.topTrader?.longPct > 50)       { score += 1.0; reasons.push('Top trader LONG vs retail SHORT (+1.0)'); }
      else if (!isLong && d.topTrader?.longPct < 50) { score += 1.0; reasons.push('Top trader SHORT vs retail LONG (+1.0)'); }
    }
  }

  return { score, reasons };
}

// 4. Sentiment Scoring
function scoreSentiment(direction, fearGreed, social) {
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  const val = fearGreed?.value;
  if (val != null) {
    if (isLong && val < 20)       { score += 1.0; reasons.push(`Fear&Greed ${val} extreme fear → contrarian LONG (+1.0)`); }
    else if (!isLong && val > 80) { score += 1.0; reasons.push(`Fear&Greed ${val} extreme greed → contrarian SHORT (+1.0)`); }
    else if (isLong && val > 80)  { score -= 1.0; reasons.push(`Fear&Greed ${val} greed cao → LONG rủi ro (-1.0)`); }
    else if (!isLong && val < 20) { score -= 1.0; reasons.push(`Fear&Greed ${val} fear cao → SHORT rủi ro (-1.0)`); }
  }

  if (social) {
    if (isLong && social.sentiment === 'BEARISH')       { score += 1.0; reasons.push('Social BEARISH + LONG = contrarian (+1.0)'); }
    else if (!isLong && social.sentiment === 'BULLISH') { score += 1.0; reasons.push('Social BULLISH + SHORT = contrarian (+1.0)'); }
  }

  return { score, reasons };
}

// 5. PP369 Reaction Grid Scoring (Tối đa 2.0đ)
function score369Reaction(sig369, direction) {
  if (!sig369 || sig369.signal === 'NONE' || sig369.signal !== direction) {
    return { score: 0, reasons: [] };
  }
  const touch = typeof sig369.touchCount === 'number' ? sig369.touchCount : 0;
  let score = 0.5;
  if (touch === 0) {
    score = 2.0; // Chạm lần 1 (Fresh - Chưa ai khai thác)
  } else if (touch === 1) {
    score = 1.0; // Lần 2
  } else {
    score = 0.5; // Lần 3 trở lên (cản mòn)
  }
  const lan = touch + 1;
  const reasons = [`[PP369] ${direction} lần ${lan} tại $${sig369.targetLevel} (+${score}đ)`];
  return { score, reasons };
}

// ─── TỔNG HỢP TOÀN BỘ ĐIỂM HỢP LƯU (SCORE SETUP 0 - 10đ) ────────────────────────

/**
 * Chấm điểm toàn diện cho một tín hiệu PP369.
 */
function scoreSetup(symbol, direction, ta, whaleData, derivatives, fundingRates, fearGreed, social, btcTA, signal369) {
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');

  // 1. Tầng 2: Hard disqualifiers — fail fast
  const disqualifyReason = checkHardFilters(cleanSym, direction, ta, fundingRates, whaleData, btcTA);
  if (disqualifyReason) {
    return {
      symbol: cleanSym, direction,
      disqualified: true, disqualifyReason,
      total: 0, verdict: 'DISQUALIFIED', confidence: 0,
      breakdown: {}, reasons: [disqualifyReason],
    };
  }

  // 2. Chấm từng nhóm
  const taResult    = scoreTechnical(ta, direction);
  const whaleResult = scoreWhale(cleanSym, direction, whaleData);
  const derivResult = scoreDerivatives(cleanSym, direction, derivatives);
  const sentResult  = scoreSentiment(direction, fearGreed, social);
  const result369   = score369Reaction(signal369, direction);

  // 3. Giờ UTC thấp thanh khoản (0:00 - 7:00 UTC)
  const utcHour = new Date().getUTCHours();
  const timePenalty = (utcHour >= 0 && utcHour < 7) ? -1.0 : 0;
  const timeReasons = timePenalty ? [`UTC ${utcHour}h thanh khoản thấp (-1.0)`] : [];

  // 4. BTC Headwind penalty: LONG altcoin khi BTC đang TRENDING_DOWN → -1.0đ đến -2.0đ
  let btcPenalty = 0;
  const btcReasons = [];
  if (direction === 'LONG' && cleanSym !== 'BTC' && btcTA) {
    const btcRsi1d = btcTA.rsi?.['1d'] ?? 50;
    if (btcTA.regime === 'TRENDING_DOWN' && btcRsi1d > 35) {
      btcPenalty = -1.5;
      btcReasons.push(`BTC TRENDING_DOWN (RSI1D=${btcRsi1d.toFixed(0)}) — headwind LONG altcoin (-1.5)`);
    }
  }

  // Tổng điểm thô (0.0 - 10.0đ)
  const rawTotal = (
    taResult.score + whaleResult.score + derivResult.score +
    sentResult.score + result369.score + timePenalty + btcPenalty
  );
  const total = Number(Math.max(0, Math.min(10.0, rawTotal)).toFixed(1));

  // Phân cấp Verdict và Độ tin cậy
  let verdict, confidence;
  if (total < 5.0)        { verdict = 'NO_SETUP';         confidence = 0;  }
  else if (total < 7.0)   { verdict = 'CAUTIOUS';         confidence = 55; }
  else if (total < 8.5)   { verdict = 'CONFIDENT';        confidence = 70; }
  else                    { verdict = 'BEST_OPPORTUNITY'; confidence = 85; }

  const maxLeverage = calcMaxLeverage(ta, verdict, cleanSym);

  return {
    symbol: cleanSym, direction,
    disqualified: false, disqualifyReason: null,
    total, verdict, confidence, maxLeverage,
    breakdown: {
      ta:          taResult.score,
      whale:       whaleResult.score,
      derivatives: derivResult.score,
      sentiment:   sentResult.score,
      pp369:       result369.score,
      timePenalty,
      btcPenalty,
    },
    reasons: [
      ...taResult.reasons,
      ...whaleResult.reasons,
      ...derivResult.reasons,
      ...sentResult.reasons,
      ...result369.reasons,
      ...timeReasons,
      ...btcReasons,
    ],
  };
}

module.exports = {
  isTop50Symbol,
  calcMaxLeverage,
  checkHardFilters,
  calcRSI,
  calcEMA,
  calcMACD,
  calcBB,
  calcATR,
  calcStochRSI,
  clusterSR,
  analyzeVolume,
  detectRegime,
  calcTAFromKlines,
  scoreTechnical,
  scoreWhale,
  scoreDerivatives,
  scoreSentiment,
  score369Reaction,
  scoreSetup,
};
