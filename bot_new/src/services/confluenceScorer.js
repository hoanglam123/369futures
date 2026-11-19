'use strict';

/**
 * Confluence Scorer — chấm điểm tín hiệu deterministic (không dùng AI để tính toán).
 *
 * Nguyên tắc:
 *   1. Hard filter trước — vi phạm 1 điều kiện → DISQUALIFIED ngay, không chấm tiếp
 *   2. Chấm từng nhóm tín hiệu độc lập (TA, Whale, Derivatives, Sentiment, PP369)
 *   3. Tổng hợp → verdict + confidence %
 *
 * Kết quả được nhúng vào prompt Gemini để AI chỉ viết narrative,
 * không tự tính toán lại (tránh hallucination số liệu).
 */

const { score369Method } = require('../pp369');

// ─── Leverage calculator ──────────────────────────────────────────────────────

const BTC_ETH = new Set(['BTC', 'ETH']);
const TOP20   = new Set(['BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'TON', 'DOT', 'SUI', 'APT', 'ATOM', 'NEAR', 'ICP']);

/**
 * Tính max leverage dựa trên ATR (volatility thực tế), tier coin, verdict và regime.
 *
 * Công thức:
 *   ATR% = biến động thực mỗi nến 4h → SL đặt tại 1x ATR → leverage phải đủ nhỏ
 *   để SL chỉ mất tối đa ~5% vốn: maxLev ≈ 5 / atrPct (capped theo tier)
 *
 * ATR-based cap:
 *   < 0.8%   → 10x (BTC/ETH thị trường ổn định)
 *   0.8-1.5% → 7x
 *   1.5-2.5% → 5x
 *   2.5-4%   → 3x
 *   > 4%     → 2x (altcoin biến động mạnh)
 *
 * Coin tier cap (hard ceiling bất kể ATR):
 *   BTC/ETH → 10x | Top 20 → 5x | Altcoin → 3x
 *
 * Điều chỉnh thêm:
 *   Regime VOLATILE → hard cap 2x
 *   Verdict CAUTIOUS → giảm thêm 2x
 */
function calcMaxLeverage(ta, verdict, symbol) {
  const atrPct = ta?.atrPct;

  // Base từ ATR
  let maxLev;
  if (!atrPct || atrPct <= 0) maxLev = 3;      // không có data → thận trọng
  else if (atrPct < 0.8)      maxLev = 10;
  else if (atrPct < 1.5)      maxLev = 7;
  else if (atrPct < 2.5)      maxLev = 5;
  else if (atrPct < 4)        maxLev = 3;
  else                         maxLev = 2;

  // Coin tier hard ceiling
  if (BTC_ETH.has(symbol))      maxLev = Math.min(maxLev, 10);
  else if (TOP20.has(symbol))   maxLev = Math.min(maxLev, 5);
  else                           maxLev = Math.min(maxLev, 3);

  // Regime VOLATILE → không quá 2x (giá có thể spike xuyên SL)
  if (ta?.regime === 'VOLATILE') maxLev = Math.min(maxLev, 2);

  // CAUTIOUS → giảm thêm (signal yếu, không nên dùng leverage cao)
  if (verdict === 'CAUTIOUS') maxLev = Math.max(1, maxLev - 2);

  return maxLev;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtM(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

// ─── Hard disqualifiers ───────────────────────────────────────────────────────

function checkHardFilters(symbol, direction, ta, fundingRates, whaleData, btcTA) {
  const isLong = direction === 'LONG';

  // ① BB Bandwidth < 2%: sideway squeeze, chờ breakout
  if (ta?.bb?.bandwidth != null && ta.bb.bandwidth < 2) {
    return `BB Bandwidth ${ta.bb.bandwidth.toFixed(2)}% < 2% → sideway squeeze`;
  }

  // ③ Funding rate quá cao/thấp
  const fundingRate = fundingRates?.binance?.[symbol];
  if (fundingRate != null) {
    if (isLong && fundingRate > 0.001) {
      return `Funding +${(fundingRate * 100).toFixed(4)}%/8h > 0.10% → long crowded`;
    }
    if (!isLong && fundingRate < -0.0005) {
      return `Funding ${(fundingRate * 100).toFixed(4)}%/8h < -0.05% → short crowded`;
    }
  }

  // ④ Cross-signal phân kỳ (OKX vs Binance ngược chiều)
  const cs = whaleData?.crossSignals?.[symbol];
  if (cs?.verdict === 'PHÂN KỲ/TRUNG TÍNH') {
    return `Cross-signal PHÂN KỲ (OKX ↔ Binance ngược chiều)`;
  }

  // ⑤ BTC downtrend mạnh → không LONG altcoin (ngoại lệ: BTC oversold cực đoan RSI1D ≤ 35)
  if (isLong && symbol !== 'BTC' && symbol !== 'ETH' && btcTA) {
    const btcRsi1d = btcTA.rsi?.['1d'] ?? 50;
    if (btcTA.aboveEMA200 === false && btcTA.regime === 'TRENDING_DOWN' && btcRsi1d > 35) {
      return `BTC dưới EMA200D + TRENDING_DOWN (RSI1D=${btcRsi1d.toFixed(0)}) — không LONG altcoin`;
    }
  }

  return null; // pass all filters
}

// ─── TA scoring ───────────────────────────────────────────────────────────────

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

  // S/R 1D cluster (gần nhất + touch count)
  const srLevels  = isLong ? (ta.support    || []) : (ta.resistance    || []);
  const srTouches = isLong ? (ta.supportTouches || []) : (ta.resistanceTouches || []);
  if (srLevels.length && price) {
    const closest = srLevels[0];
    const distPct = Math.abs(price - closest) / price * 100;
    const touches = srTouches[0] || 1;
    const touchBonus = touches >= 3 ? 1 : 0;
    if (distPct < 0.5) {
      const base = ta.patterns?.length ? 2 : 1;
      score += base + touchBonus;
      const note = ta.patterns?.length ? `+ ${ta.patterns[0].split(' ')[0]}` : '';
      reasons.push(`Tại S/R 1D ${distPct.toFixed(1)}% ${note} ${touches}x test (+${base + touchBonus})`);
    } else if (distPct < 1.5) {
      score += 1;
      reasons.push(`Gần S/R 1D (${distPct.toFixed(1)}%, ${touches}x test) (+1)`);
    }
  }

  // S/R 4H cluster — mức thực chiến ngắn hạn (tolerance chặt hơn 1D)
  const sr4hLevels  = isLong ? (ta.support4h    || []) : (ta.resistance4h    || []);
  const sr4hTouches = isLong ? (ta.support4hTouches || []) : (ta.resistance4hTouches || []);
  if (sr4hLevels.length && price) {
    const closest4h = sr4hLevels[0];
    const distPct4h = Math.abs(price - closest4h) / price * 100;
    const touches4h = sr4hTouches[0] || 1;
    if (distPct4h < 0.3) {
      score += 2;
      reasons.push(`Tại S/R 4H ${distPct4h.toFixed(1)}% (${touches4h}x test) (+2)`);
      // Bonus nếu 4H trùng 1D (±0.5%) → confluence 2 khung cực mạnh
      if (srLevels.length && Math.abs(closest4h - srLevels[0]) / closest4h < 0.005) {
        score += 1;
        reasons.push('4H + 1D S/R confluence cùng vùng (+1)');
      }
    } else if (distPct4h < 0.8) {
      score += 1;
      reasons.push(`Gần S/R 4H (${distPct4h.toFixed(1)}%, ${touches4h}x test) (+1)`);
    }
  }

  // Weekly pivot proximity (mạnh nhất — institution reference)
  if (ta.weeklyPivot && price) {
    const wp = isLong ? ta.weeklyPivot.low : ta.weeklyPivot.high;
    const distPct = Math.abs(price - wp) / price * 100;
    if (distPct < 0.8) {
      score += 2;
      reasons.push(`Tại Weekly Pivot ${isLong ? 'Low' : 'High'} (${distPct.toFixed(1)}%) (+2)`);
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

  // OI divergence (giá tăng nhưng OI giảm = tín hiệu yếu)
  // Cần e25 defined để tránh `price > 0` luôn true khi ema data thiếu
  if (ta.oi?.change24h != null && isLong) {
    if (ta.oi.change24h < -5 && e25 && price > e25) {
      score -= 2;
      reasons.push(`OI giảm ${ta.oi.change24h.toFixed(1)}% + giá tăng = divergence bearish (-2)`);
    }
  }

  // EMA 200D bias penalty — không block cứng để không bỏ lỡ bounce/reversal
  // Chỉ trừ điểm khi RSI 1D chưa ở mức extreme (>35 / <65), tức là chưa có dấu hiệu reversal rõ
  if (ta?.aboveEMA200 !== null && ta?.aboveEMA200 !== undefined) {
    const rsi1d = ta.rsi?.['1d'] ?? 50;
    if (isLong && !ta.aboveEMA200 && rsi1d > 35) {
      score -= 2;
      reasons.push(`Dưới EMA200D (RSI1D=${rsi1d.toFixed(0)}) — bearish bias (-2)`);
    } else if (!isLong && ta.aboveEMA200 && rsi1d < 65) {
      score -= 2;
      reasons.push(`Trên EMA200D (RSI1D=${rsi1d.toFixed(0)}) — bullish bias (-2)`);
    }
  }

  // Regime bonus: tín hiệu cùng chiều regime được cộng thêm
  if (ta.regime) {
    if (isLong && ta.regime === 'TRENDING_UP')    { score += 1; reasons.push('Regime TRENDING_UP + LONG (+1)'); }
    if (!isLong && ta.regime === 'TRENDING_DOWN') { score += 1; reasons.push('Regime TRENDING_DOWN + SHORT (+1)'); }
    if (ta.regime === 'VOLATILE')                 { score -= 1; reasons.push('Regime VOLATILE — rủi ro cao (-1)'); }
  }

  return { score, reasons };
}

// ─── Whale scoring ────────────────────────────────────────────────────────────

function scoreWhale(symbol, direction, whaleData) {
  if (!whaleData) return { score: 0, reasons: [] };
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  // OKX Taker Flow
  const tf = whaleData.takerFlow?.[symbol];
  if (tf) {
    if (isLong && tf.bias === 'BUY_PRESSURE')       { score += 1; reasons.push(`OKX Taker Flow BUY ${tf.buyPct.toFixed(1)}% (+1)`); }
    else if (!isLong && tf.bias === 'SELL_PRESSURE') { score += 1; reasons.push(`OKX Taker Flow SELL ${tf.sellPct.toFixed(1)}% (+1)`); }
  }

  // Binance large trades
  const bn = whaleData.binanceLarge?.[symbol];
  if (bn) {
    if (isLong && bn.bias === 'WHALE_BUY')       { score += 1; reasons.push(`BN large trades WHALE_BUY ${bn.buyPct.toFixed(0)}% (+1)`); }
    else if (!isLong && bn.bias === 'WHALE_SELL') { score += 1; reasons.push('BN large trades WHALE_SELL (+1)'); }

    // Tier bonuses
    const whl = bn.tiers?.WHALE;
    const ins = bn.tiers?.INSTITUTION;
    if (whl && whl.buyVol + whl.sellVol > 0) {
      if (isLong && whl.buyVol > whl.sellVol)       { score += 1; reasons.push(`WHALE $5M-$20M BUY ${fmtM(whl.buyVol)} (+1)`); }
      else if (!isLong && whl.sellVol > whl.buyVol) { score += 1; reasons.push(`WHALE $5M-$20M SELL ${fmtM(whl.sellVol)} (+1)`); }
    }
    if (ins && ins.buyVol + ins.sellVol > 0) {
      if (isLong && ins.buyVol > ins.sellVol)       { score += 2; reasons.push(`INSTITUTION ≥$20M BUY ${fmtM(ins.buyVol)} (+2) ⚡`); }
      else if (!isLong && ins.sellVol > ins.buyVol) { score += 2; reasons.push(`INSTITUTION ≥$20M SELL ${fmtM(ins.sellVol)} (+2) ⚡`); }
    }
  }

  // Cross-signal xác nhận
  const cs = whaleData.crossSignals?.[symbol];
  if (cs) {
    if (isLong && cs.verdict === 'XÁC NHẬN MUA')       { score += 1; reasons.push('Cross-signal XÁC NHẬN MUA (+1)'); }
    else if (!isLong && cs.verdict === 'XÁC NHẬN BÁN') { score += 1; reasons.push('Cross-signal XÁC NHẬN BÁN (+1)'); }
  }

  // Liquidations — mạnh nhất, không thể ẩn
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

// ─── Derivatives scoring ──────────────────────────────────────────────────────

function scoreDerivatives(symbol, direction, derivatives) {
  const d = derivatives?.[symbol];
  if (!d) return { score: 0, reasons: [] };
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  // Binance OI trend
  if (d.oi) {
    if (isLong && d.oi.trend === 'RISING')        { score += 1; reasons.push(`OI RISING +${d.oi.changePct.toFixed(1)}% xác nhận LONG (+1)`); }
    else if (!isLong && d.oi.trend === 'RISING')  { score += 1; reasons.push(`OI RISING +${d.oi.changePct.toFixed(1)}% (vốn short mới +1)`); }
    else if (isLong && d.oi.trend === 'FALLING')  { score -= 1; reasons.push('OI FALLING khi LONG (-1)'); }
  }

  // L/S contrarian
  const ls = d.lsSignal;
  if (ls) {
    if (isLong && ls.contrarian === 'CONTRARIAN_LONG')       { score += 1; reasons.push(`Retail quá SHORT → contrarian LONG (+1)`); }
    else if (!isLong && ls.contrarian === 'CONTRARIAN_SHORT') { score += 1; reasons.push(`Retail quá LONG → contrarian SHORT (+1)`); }

    if (ls.divergence) {
      if (isLong && d.topTrader?.longPct > 50)       { score += 1; reasons.push('Top trader LONG vs retail SHORT (+1)'); }
      else if (!isLong && d.topTrader?.longPct < 50) { score += 1; reasons.push('Top trader SHORT vs retail LONG (+1)'); }
    }
  }

  return { score, reasons };
}

// ─── Sentiment scoring ────────────────────────────────────────────────────────

function scoreSentiment(direction, fearGreed, social) {
  const isLong = direction === 'LONG';
  let score = 0;
  const reasons = [];

  // Fear & Greed contrarian
  const val = fearGreed?.value;
  if (val != null) {
    if (isLong && val < 20)       { score += 1; reasons.push(`Fear&Greed ${val} extreme fear → contrarian LONG (+1)`); }
    else if (!isLong && val > 80) { score += 1; reasons.push(`Fear&Greed ${val} extreme greed → contrarian SHORT (+1)`); }
    else if (isLong && val > 80)  { score -= 1; reasons.push(`Fear&Greed ${val} greed cao → LONG rủi ro (-1)`); }
    else if (!isLong && val < 20) { score -= 1; reasons.push(`Fear&Greed ${val} fear cao → SHORT rủi ro (-1)`); }
  }

  // Reddit contrarian
  if (social) {
    if (isLong && social.sentiment === 'BEARISH')       { score += 1; reasons.push('Reddit BEARISH + LONG = contrarian (+1)'); }
    else if (!isLong && social.sentiment === 'BULLISH') { score += 1; reasons.push('Reddit BULLISH + SHORT = contrarian (+1)'); }
  }

  return { score, reasons };
}

// ─── Main scoring function ────────────────────────────────────────────────────

function scoreSetup(symbol, direction, ta, whaleData, derivatives, fundingRates, fearGreed, social, btcTA, signal369) {
  // Hard disqualifiers — fail fast
  const disqualifyReason = checkHardFilters(symbol, direction, ta, fundingRates, whaleData, btcTA);
  if (disqualifyReason) {
    return {
      symbol, direction,
      disqualified: true, disqualifyReason,
      total: 0, verdict: 'DISQUALIFIED', confidence: 0,
      breakdown: {}, reasons: [],
    };
  }

  const taResult     = scoreTechnical(ta, direction);
  const whaleResult  = scoreWhale(symbol, direction, whaleData);
  const derivResult  = scoreDerivatives(symbol, direction, derivatives);
  const sentResult   = scoreSentiment(direction, fearGreed, social);
  const result369    = score369Method(signal369, direction);

  // Giờ UTC: Bỏ hình phạt thời gian theo yêu cầu chiến lược (timePenalty = 0)
  const timePenalty = 0;
  const timeReasons = [];

  // BTC headwind: LONG altcoin khi BTC đang TRENDING_DOWN → -1 (áp dụng cả ETH)
  let btcPenalty = 0;
  const btcReasons = [];
  if (direction === 'LONG' && symbol !== 'BTC' && btcTA) {
    const btcRsi1d = btcTA.rsi?.['1d'] ?? 50;
    if (btcTA.regime === 'TRENDING_DOWN' && btcRsi1d > 35) {
      btcPenalty = -1;
      btcReasons.push(`BTC TRENDING_DOWN (RSI1D=${btcRsi1d.toFixed(0)}) — headwind LONG altcoin (-1)`);
    }
  }

  const total = Math.max(0,
    taResult.score + whaleResult.score + derivResult.score + sentResult.score +
    result369.score + timePenalty + btcPenalty
  );

  let verdict, confidence;
  if (total < 5)       { verdict = 'NO_SETUP';         confidence = 0;  }
  else if (total <= 6) { verdict = 'CAUTIOUS';         confidence = 55; }
  else if (total <= 8) { verdict = 'CONFIDENT';        confidence = 70; }
  else if (total <= 10){ verdict = 'BEST_OPPORTUNITY'; confidence = 85; }
  else                 { verdict = 'BEST_OPPORTUNITY'; confidence = 90; }

  const maxLeverage = calcMaxLeverage(ta, verdict, symbol);

  return {
    symbol, direction,
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

// Score tất cả coin × cả 2 chiều, trả về sorted by score desc
function scoreAllSetups(symbols, taReport, whaleData, derivatives, fundingRates, fearGreed, social, signals369Map = {}) {
  const btcTA = taReport?.['BTC'] ?? null;
  const results = [];
  for (const sym of (symbols || [])) {
    const ta = taReport?.[sym];
    if (!ta) continue;
    const sig369 = signals369Map[sym] ?? null;
    for (const dir of ['LONG', 'SHORT']) {
      results.push(scoreSetup(sym, dir, ta, whaleData, derivatives, fundingRates, fearGreed, social, btcTA, sig369));
    }
  }
  return results.sort((a, b) => b.total - a.total);
}

// Format scores thành text ngắn gọn để nhúng vào AI prompt
function formatScoresForPrompt(scores) {
  if (!scores?.length) return '';

  const lines = ['\n[ĐIỂM TÍN HIỆU — ĐÃ TÍNH BỞI CODE, KHÔNG TÍNH LẠI]'];
  lines.push('Verdict: BEST_OPPORTUNITY≥9đ | CONFIDENT 7-8đ | CAUTIOUS 5-6đ | NO_SETUP<5đ | DISQUALIFIED=lọc cứng');
  lines.push('');

  // Group by symbol
  const bySymbol = {};
  for (const s of scores) {
    if (!bySymbol[s.symbol]) bySymbol[s.symbol] = [];
    bySymbol[s.symbol].push(s);
  }

  for (const [sym, setups] of Object.entries(bySymbol)) {
    lines.push(`${sym}:`);
    for (const s of setups) {
      if (s.disqualified) {
        lines.push(`  ${s.direction}: LOẠI — ${s.disqualifyReason}`);
      } else {
        const verdictStr = s.verdict === 'NO_SETUP' ? 'NO_SETUP' :
          s.verdict === 'CAUTIOUS' ? `CAUTIOUS (${s.confidence}%)` :
          s.verdict === 'CONFIDENT' ? `CONFIDENT (${s.confidence}%)` :
          `BEST_OPPORTUNITY (${s.confidence}%)`;
        const levNote = s.maxLeverage ? ` | MaxLev: ${s.maxLeverage}x` : '';
        lines.push(`  ${s.direction}: ${s.total}đ [${verdictStr}${levNote}]`);
        lines.push(`    TA=${s.breakdown.ta} | Whale=${s.breakdown.whale} | Deriv=${s.breakdown.derivatives} | Sentiment=${s.breakdown.sentiment}${s.breakdown.pp369 ? ` | PP369=${s.breakdown.pp369}` : ''}${s.breakdown.timePenalty ? ` | Time=${s.breakdown.timePenalty}` : ''}${s.breakdown.btcPenalty ? ` | BTC=${s.breakdown.btcPenalty}` : ''}`);
        if (s.reasons.length) {
          lines.push(`    Tín hiệu: ${s.reasons.join(' | ')}`);
        }
      }
    }
  }

  return lines.join('\n');
}

module.exports = { scoreSetup, scoreAllSetups, formatScoresForPrompt };
