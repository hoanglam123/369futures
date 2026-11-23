'use strict';

/**
 * tierSLTP.js — Thuật toán toán học xác định Stop Loss 3 tầng, Smart Anchored TP,
 * Bypass Cản Yếu và Chốt Chặn R:R >= 1.48 cho bot-new.
 *
 * 100% tất định (Deterministic), 0ms, không phụ thuộc AI, triệt tiêu ảo giác số học.
 */

const {
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  calculateATR,
  findSwingPoints
} = require('./candleCache');
const { log } = require('./logger');

/**
 * Gom cụm các điểm xoay (Swing Points) thành các Vùng Cản Cụm (Cluster Zones)
 */
function buildClusterZones(points, toleranceRatio = 0.005) {
  if (!points || !Array.isArray(points) || points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let currentGroup = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const pt = sorted[i];
    const groupMin = currentGroup[0].price;
    const groupMax = currentGroup[currentGroup.length - 1].price;
    const avgPrice = (groupMin + groupMax) / 2;

    const tol = Math.max(avgPrice * toleranceRatio, avgPrice * 0.002);
    if (pt.price - groupMax <= tol) {
      currentGroup.push(pt);
    } else {
      clusters.push(summarizeClusterZone(currentGroup));
      currentGroup = [pt];
    }
  }
  if (currentGroup.length > 0) {
    clusters.push(summarizeClusterZone(currentGroup));
  }

  return clusters;
}

function summarizeClusterZone(group) {
  const prices = group.map(p => p.price);
  const zoneMin = Math.min(...prices);
  const zoneMax = Math.max(...prices);
  const zoneMid = prices.reduce((sum, p) => sum + p, 0) / prices.length;

  const d1Points = group.filter(p => p.timeframe === 'D1');
  const h4Points = group.filter(p => p.timeframe === 'H4');
  const h1Points = group.filter(p => p.timeframe === 'H1');

  const d1Touches = d1Points.length;
  const h4Touches = h4Points.length;
  const h1Touches = h1Points.length;
  const touches = Math.max(d1Touches, h4Touches, h1Touches, group.length);

  const highestTf = d1Touches > 0 ? 'D1' : (h4Touches > 0 ? 'H4' : 'H1');
  const isMajor = d1Touches > 0 || h4Touches >= 2 || touches >= 3;

  return {
    zoneMin,
    zoneMax,
    zoneMid,
    touches,
    timeframe: highestTf,
    isMajor,
    pointsCount: group.length
  };
}

/**
 * Né Nam Châm Số Tròn Tâm Lý (Psychological Round Number Evasion)
 */
function evadeRoundNumber(price, isLong) {
  if (!price || price <= 0 || isNaN(price)) return price;
  const mag = Math.pow(10, Math.floor(Math.log10(price)));
  let stepR;
  if (price >= 1000) stepR = 500;
  else if (price >= 100) stepR = 50;
  else if (price >= 10) stepR = 5;
  else if (price >= 1) stepR = 0.5;
  else if (price >= 0.1) stepR = 0.05;
  else stepR = mag;

  const nearestRound = Math.round(price / stepR) * stepR;
  const diffPct = Math.abs(price - nearestRound) / price;
  if (diffPct <= 0.0015) {
    return isLong ? price * (1 - 0.0025) : price * (1 + 0.0025);
  }
  return price;
}

/**
 * Làm tròn giá SL bảo thủ theo tickSize Binance:
 * - Long: Làm tròn xuống (Math.floor) để SL nằm xa hơn
 * - Short: Làm tròn lên (Math.ceil) để SL nằm xa hơn
 */
function roundSlConservative(slPrice, tickSize, isLong) {
  if (!tickSize || tickSize <= 0 || isNaN(tickSize)) return slPrice;
  const inv = 1 / tickSize;
  const rounded = isLong
    ? Math.floor(slPrice * inv + 1e-9) / inv
    : Math.ceil(slPrice * inv - 1e-9) / inv;
  return Number(rounded.toFixed(8));
}

/**
 * Làm tròn giá TP bảo thủ theo tickSize Binance:
 * - Long: Làm tròn xuống (Math.floor) để dễ chạm TP
 * - Short: Làm tròn lên (Math.ceil) để dễ chạm TP
 */
function roundTpConservative(tpPrice, tickSize, isLong) {
  if (!tickSize || tickSize <= 0 || isNaN(tickSize)) return tpPrice;
  const inv = 1 / tickSize;
  const rounded = isLong
    ? Math.floor(tpPrice * inv + 1e-9) / inv
    : Math.ceil(tpPrice * inv - 1e-9) / inv;
  return Number(rounded.toFixed(8));
}

function getDecimals(price) {
  if (price >= 100) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  if (price >= 0.2) return 4;
  if (price >= 0.1) return 5;
  if (price >= 0.02) return 5;
  if (price >= 0.01) return 6;
  return 8;
}

function getBaseUnit(price) {
  if (price >= 10000) return 1000;
  if (price >= 1000) return 100;
  if (price >= 100) return 10;
  if (price >= 10) return 1;
  if (price >= 1) return 0.1;
  if (price >= 0.2) return 0.01;
  if (price >= 0.02) return 0.001;
  if (price >= 0.002) return 0.0001;
  return 0.00001;
}

function getStep(price) {
  const unit = getBaseUnit(price);
  return Math.round(3 * unit * 1e8) / 1e8;
}

/**
 * Tính toán Stop Loss, Take Profit, Đòn bẩy và Tỷ lệ R:R
 */
async function calculateTierSLTP(
  symbol,
  side,
  entryPrice,
  h4Ref = null,
  tickSize = null,
  maxExchangeLeverage = 10,
  targetLossUSD = 3.0,
  tpRatio = 1.5,
  rank = null,
  gridWidthPct = null,
  customKlines = null,
  customMargin = null
) {
  const isLong = (side === 'LONG' || side === 'BUY');
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const isTier1 = (cleanSym === 'BTC' || cleanSym === 'ETH' || (typeof rank === 'number' && rank <= 50));

  const tier1Margin = parseFloat(process.env.TRADE_AMOUNT_TIER1 || process.env.TRADE_AMOUNT || '20');
  const tier2Margin = parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10');
  const standardMargin = (typeof customMargin === 'number' && customMargin > 0)
    ? customMargin
    : (isTier1 ? tier1Margin : tier2Margin);

  const baseMinSlPct = isTier1 ? 1.3 : 1.8;
  const decimals = h4Ref?.decimals || getDecimals(entryPrice);
  const defaultTickSize = Math.pow(10, -decimals);
  const effTickSize = (typeof tickSize === 'number' && tickSize > 0) ? tickSize : defaultTickSize;

  // 1. Tải nến lịch sử H1, H4, D1
  let h1Candles = [];
  let h4Candles = [];
  let d1Candles = [];
  if (customKlines && customKlines.h1 && customKlines.h4) {
    h1Candles = customKlines.h1;
    h4Candles = customKlines.h4;
    d1Candles = customKlines.d1 || [];
  } else {
    const [resH1, resH4, resD1] = await Promise.all([
      fetchH1Historical(cleanSym).catch(() => []),
      fetchH4Historical(cleanSym).catch(() => []),
      fetchD1Historical(cleanSym).catch(() => [])
    ]);
    h1Candles = resH1 || [];
    h4Candles = resH4 || [];
    d1Candles = resD1 || [];
  }

  // 2. Tính ATR
  let atrVal = null;
  if (h4Candles && h4Candles.length >= 15) {
    atrVal = calculateATR(h4Candles, 14);
  }
  if (!atrVal && h1Candles && h1Candles.length >= 15) {
    const atrH1 = calculateATR(h1Candles, 14);
    if (atrH1) atrVal = atrH1 * 2.0;
  }
  if (!atrVal || atrVal <= 0) {
    atrVal = entryPrice * 0.02;
  }
  const atrPct = (atrVal / entryPrice) * 100;

  // 3. Quét cấu trúc Swing S/R
  const allSupportPoints = [];
  const allResistancePoints = [];

  if (h1Candles && h1Candles.length >= 7) {
    const swH1 = findSwingPoints(h1Candles.slice(-300), 3, 3);
    for (const p of swH1.lows) allSupportPoints.push({ price: p, timeframe: 'H1', type: 'LOW' });
    for (const p of swH1.highs) allResistancePoints.push({ price: p, timeframe: 'H1', type: 'HIGH' });
  }

  if (h4Candles && h4Candles.length >= 5) {
    const swH4 = findSwingPoints(h4Candles.slice(-150), 2, 2);
    for (const p of swH4.lows) allSupportPoints.push({ price: p, timeframe: 'H4', type: 'LOW' });
    for (const p of swH4.highs) allResistancePoints.push({ price: p, timeframe: 'H4', type: 'HIGH' });
  }

  if (d1Candles && d1Candles.length >= 5) {
    const swD1 = findSwingPoints(d1Candles.slice(-180), 2, 2);
    for (const p of swD1.lows) allSupportPoints.push({ price: p, timeframe: 'D1', type: 'LOW' });
    for (const p of swD1.highs) allResistancePoints.push({ price: p, timeframe: 'D1', type: 'HIGH' });
  }

  const tolRatio = atrVal > 0 ? Math.max(0.003, (atrVal / entryPrice) * 0.20) : 0.005;
  const supportClusters = buildClusterZones(allSupportPoints, tolRatio);
  const resistanceClusters = buildClusterZones(allResistancePoints, tolRatio);

  const protectiveClusters = isLong
    ? supportClusters.filter(c => c.zoneMax < entryPrice * 0.999).sort((a, b) => b.zoneMax - a.zoneMax)
    : resistanceClusters.filter(c => c.zoneMin > entryPrice * 1.001).sort((a, b) => a.zoneMin - b.zoneMin);

  // 4. MÔ HÌNH HYBRID SL 3 TẦNG THÔNG MINH (Kẹp thích ứng theo ATR, xóa trần cứng 3.5% mù quáng)
  let rawSL = null;
  let slScenario = 'PURE_VOLATILITY_ATR';
  let matchedSwing = null;

  // Sàn & Trần thích ứng ATR chuẩn Roadmap:
  // - Sàn: max(baseMin, min(3.5%, 1.8 * ATR))
  // - Trần: max(3.5%, min(6.0%, 3.0 * ATR))
  const minSlPct = Math.max(baseMinSlPct, Math.min(3.5, 1.8 * atrPct));
  const adaptiveMaxSlPct = Math.max(3.5, Math.min(6.0, 3.0 * atrPct));

  const minSafeDistPct = Math.max(minSlPct, 1.2 * atrPct);
  const maxSafeDistPct = Math.min(adaptiveMaxSlPct, Math.max(3.5, 2.0 * atrPct));

  // TẦNG 1: CẢN SWEET SPOT H1 / H4 GẦN
  const h1h4ProtectiveClusters = protectiveClusters.filter(c => c.timeframe === 'H1' || c.timeframe === 'H4');
  for (const c of h1h4ProtectiveClusters) {
    const distPct = isLong
      ? ((entryPrice - c.zoneMin) / entryPrice) * 100
      : ((c.zoneMax - entryPrice) / entryPrice) * 100;

    if (distPct >= minSlPct && distPct <= maxSafeDistPct) {
      matchedSwing = isLong ? c.zoneMin : c.zoneMax;
      rawSL = isLong ? (c.zoneMin - entryPrice * 0.002) : (c.zoneMax + entryPrice * 0.002);
      slScenario = 'SWEET_SPOT_SWING';
      break;
    }
  }

  // TẦNG 2: CẢN D1 TẦM TRUNG (LỊCH SỬ 6 THÁNG)
  if (!rawSL) {
    const d1ProtectiveClusters = protectiveClusters.filter(c => c.timeframe === 'D1');
    const maxD1DistPct = Math.min(adaptiveMaxSlPct, Math.max(4.0, 2.2 * atrPct));
    for (const c of d1ProtectiveClusters) {
      const distPct = isLong
        ? ((entryPrice - c.zoneMin) / entryPrice) * 100
        : ((c.zoneMax - entryPrice) / entryPrice) * 100;

      if (distPct >= minSlPct && distPct <= maxD1DistPct) {
        matchedSwing = isLong ? c.zoneMin : c.zoneMax;
        rawSL = isLong ? (c.zoneMin - entryPrice * 0.002) : (c.zoneMax + entryPrice * 0.002);
        slScenario = 'TIER2_D1_SWING';
        break;
      }
    }
  }

  // TẦNG 3: CẢN ĐỘNG FIBONACCI
  const recentH1 = (h1Candles && h1Candles.length >= 12) ? h1Candles.slice(-24) : [];
  if (!rawSL) {
    if (recentH1.length >= 12) {
      const high24 = Math.max(...recentH1.map(c => c.high));
      const low24 = Math.min(...recentH1.map(c => c.low));
      const waveDelta = high24 - low24;
      const wavePct = (waveDelta / entryPrice) * 100;

      if (waveDelta > 0 && wavePct >= 1.5 && wavePct >= 1.2 * atrPct) {
        if (!isLong) {
          const fib786 = low24 + 0.786 * waveDelta;
          const candidateSL = fib786 + (entryPrice * 0.002);
          const fibDistPct = ((candidateSL - entryPrice) / entryPrice) * 100;
          if (fibDistPct >= minSlPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        } else {
          const fib786 = high24 - 0.786 * waveDelta;
          const candidateSL = fib786 - (entryPrice * 0.002);
          const fibDistPct = ((entryPrice - candidateSL) / entryPrice) * 100;
          if (fibDistPct >= minSlPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        }
      }
    }

    if (!rawSL) {
      const goldenDistPct = Math.min(Math.max(1.618 * atrPct, minSlPct), Math.min(adaptiveMaxSlPct, 3.2));
      rawSL = isLong
        ? (entryPrice * (1 - goldenDistPct / 100.0))
        : (entryPrice * (1 + goldenDistPct / 100.0));
      slScenario = protectiveClusters.length > 0 ? 'CLAMP_FAR_SWING' : 'PURE_VOLATILITY_ATR';
    }
  }

  // Kẹp an toàn thích ứng theo ATR (Safety Bounds: minSlPct .. adaptiveMaxSlPct [3.5% - 6.0%])
  const maxCeilingPct = adaptiveMaxSlPct;
  let slDist = Math.abs(entryPrice - rawSL);
  if (slDist < entryPrice * (minSlPct / 100.0)) {
    slDist = entryPrice * (minSlPct / 100.0);
    rawSL = isLong ? (entryPrice - slDist) : (entryPrice + slDist);
  } else if (slDist > entryPrice * (maxCeilingPct / 100.0)) {
    slDist = entryPrice * (maxCeilingPct / 100.0);
    rawSL = isLong ? (entryPrice - slDist) : (entryPrice + slDist);
  }

  rawSL = evadeRoundNumber(rawSL, isLong);
  slDist = Math.abs(entryPrice - rawSL);

  const finalSlPrice = roundSlConservative(rawSL, effTickSize, isLong);
  slDist = Math.abs(entryPrice - finalSlPrice);
  const finalSlPct = (slDist / entryPrice) * 100;

  // Tính đòn bẩy an toàn
  const mmr = 0.01;
  const maxSafeLevForLiq = 1.0 / (1.5 * (finalSlPct / 100.0) + mmr);

  let rawLevAtr;
  if (!atrPct || atrPct <= 0) rawLevAtr = 3;
  else if (atrPct < 0.8) rawLevAtr = 10;
  else if (atrPct < 1.5) rawLevAtr = 7;
  else if (atrPct < 2.5) rawLevAtr = 5;
  else if (atrPct < 4.0) rawLevAtr = 3;
  else rawLevAtr = 2;

  const hardCeilingLev = (cleanSym === 'BTC' || cleanSym === 'ETH')
    ? 10
    : (isTier1 ? 7 : 3);

  const maxRiskLev = (standardMargin > 0 && finalSlPct > 0)
    ? Math.floor((targetLossUSD * 1.25) / (standardMargin * (finalSlPct / 100.0)))
    : hardCeilingLev;

  let effectiveLeverage = Math.min(
    rawLevAtr,
    Math.floor(maxSafeLevForLiq),
    hardCeilingLev,
    Math.max(1, maxRiskLev),
    maxExchangeLeverage || 20
  );
  effectiveLeverage = Math.max(1, Math.floor(effectiveLeverage));

  // 5. TÍNH TOÁN TP THÔNG MINH
  const step = h4Ref?.step || getStep(entryPrice);
  const effGridWidth = (typeof gridWidthPct === 'number' && gridWidthPct > 0)
    ? gridWidthPct
    : (((step * 10) / entryPrice) * 100);

  const targetTpRatio = (typeof tpRatio === 'number' && tpRatio > 0) ? tpRatio : 1.50;
  const minRequiredTpDist = slDist * 1.48;
  const idealTpDist = slDist * targetTpRatio;

  const opposingClusters = isLong
    ? resistanceClusters.filter(c => c.zoneMin > entryPrice * 1.001).sort((a, b) => a.zoneMin - b.zoneMin)
    : supportClusters.filter(c => c.zoneMax < entryPrice * 0.999).sort((a, b) => b.zoneMax - a.zoneMax);

  // 5.1. Hard Major Wall Blocking Check: Chỉ VETO khi cản cứng (Major S/R) chặn trước R:R < 1.48
  for (const c of opposingClusters) {
    const rawDistToWall = isLong ? (c.zoneMin - entryPrice) : (entryPrice - c.zoneMax);

    if (rawDistToWall < minRequiredTpDist) {
      if (c.isMajor) {
        const frontRunPrice = isLong ? (c.zoneMin - entryPrice * 0.002) : (c.zoneMax + entryPrice * 0.002);
        const distToWall = Math.max(0, Math.abs(entryPrice - frontRunPrice));
        const blockedRR = distToWall / slDist;
        const finalTpPriceFail = roundTpConservative(frontRunPrice, effTickSize, isLong);
        return {
          valid: false,
          reason: `RR_BLOCKED_BY_MAJOR_SR (Cản cứng ${c.timeframe} [${c.zoneMin.toFixed(2)}-${c.zoneMax.toFixed(2)}] chặn tại R:R = ${blockedRR.toFixed(2)} < 1.48)`,
          rrRatio: parseFloat(blockedRR.toFixed(2)),
          slPrice: finalSlPrice,
          tpPrice: finalTpPriceFail,
          slDistance: slDist,
          tpDistance: distToWall,
          slPct: parseFloat(finalSlPct.toFixed(2)),
          tpPct: parseFloat(((distToWall / entryPrice) * 100).toFixed(2)),
          leverage: effectiveLeverage,
          margin: standardMargin
        };
      }
      // Nếu là Minor S/R: Kích hoạt Weak S/R Bypass để tìm cản phía sau
    }
  }

  // 5.2. Xác định Mốc TP Mục Tiêu
  let rawTP = null;
  let tpAnchorType = 'STANDARD_RR';

  for (const c of opposingClusters) {
    const frontRunPrice = isLong
      ? (c.zoneMin - entryPrice * 0.002)
      : (c.zoneMax + entryPrice * 0.002);
    const dist = Math.abs(entryPrice - frontRunPrice);
    const candRR = dist / slDist;

    if (candRR >= 1.48 && candRR <= 2.50) {
      if (c.isMajor || candRR >= targetTpRatio) {
        rawTP = frontRunPrice;
        tpAnchorType = `${c.timeframe}_SR_ANCHOR`;
        break;
      }
    }
  }

  if (!rawTP && step > 0) {
    const gridTarget1 = isLong ? (entryPrice + step) : (entryPrice - step);
    const frontRunGrid1 = isLong ? (gridTarget1 - entryPrice * 0.002) : (gridTarget1 + entryPrice * 0.002);
    const distGrid1 = Math.abs(entryPrice - frontRunGrid1);
    const rrGrid1 = distGrid1 / slDist;

    if (rrGrid1 >= 1.48 && rrGrid1 <= 2.50) {
      rawTP = frontRunGrid1;
      tpAnchorType = '369_GRID_ANCHOR';
    } else if (rrGrid1 < 1.48) {
      const gridTarget2 = isLong ? (entryPrice + 2 * step) : (entryPrice - 2 * step);
      const frontRunGrid2 = isLong ? (gridTarget2 - entryPrice * 0.002) : (gridTarget2 + entryPrice * 0.002);
      const distGrid2 = Math.abs(entryPrice - frontRunGrid2);
      const rrGrid2 = distGrid2 / slDist;
      if (rrGrid2 >= 1.48 && rrGrid2 <= 3.0) {
        rawTP = frontRunGrid2;
        tpAnchorType = '369_GRID_2STEP_ANCHOR';
      }
    }
  }

  // 5.2b. Fibonacci Extension 1.272 / 1.618 trên sóng H1 gần nhất (khi vùng cản/lưới 369 trống)
  if (!rawTP && recentH1.length >= 12) {
    const high24 = Math.max(...recentH1.map(c => c.high));
    const low24  = Math.min(...recentH1.map(c => c.low));
    const waveDelta = high24 - low24;
    if (waveDelta > 0) {
      for (const ext of [1.272, 1.618]) {
        const fibTarget = isLong
          ? (low24 + ext * waveDelta) - entryPrice * 0.002
          : (high24 - ext * waveDelta) + entryPrice * 0.002;
        const distFib = isLong ? (fibTarget - entryPrice) : (entryPrice - fibTarget);
        const rrFib = slDist > 0 ? (distFib / slDist) : 0;
        if (distFib > 0 && rrFib >= 1.48 && rrFib <= 3.0) {
          rawTP = fibTarget;
          tpAnchorType = ext === 1.272 ? 'FIB_EXT_1272' : 'FIB_EXT_1618';
          break;
        }
      }
    }
  }

  if (!rawTP) {
    const fallbackDist = Math.max(idealTpDist, step * 0.618);
    rawTP = isLong ? (entryPrice + fallbackDist) : (entryPrice - fallbackDist);
    tpAnchorType = 'FALLBACK_RATIO';
  }

  const finalTpPrice = roundTpConservative(rawTP, effTickSize, isLong);
  const finalTpDist = Math.abs(entryPrice - finalTpPrice);
  const finalTpPct = (finalTpDist / entryPrice) * 100;
  const rrRatio = slDist > 0 ? (finalTpDist / slDist) : 0;

  if (rrRatio < 1.48) {
    return {
      valid: false,
      reason: `RR_BELOW_1.5 (R:R = ${rrRatio.toFixed(2)} < 1.5 — Không đạt tỷ lệ lời/lỗ)`,
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      slPrice: finalSlPrice,
      tpPrice: finalTpPrice,
      slDistance: slDist,
      tpDistance: finalTpDist,
      slPct: parseFloat(finalSlPct.toFixed(2)),
      tpPct: parseFloat(finalTpPct.toFixed(2)),
      leverage: effectiveLeverage,
      margin: standardMargin
    };
  }

  // 6. THIẾT LẬP MỐC BREAKEVEN 35% VÀ RISK-FREE FLOOR
  const fractalTriggerDist = finalTpDist * 0.35;
  const beTriggerPrice = isLong ? (entryPrice + fractalTriggerDist) : (entryPrice - fractalTriggerDist);
  const beFeeBuffer = (0.01 / effectiveLeverage) * entryPrice;
  const beSlPrice = isLong ? (entryPrice + beFeeBuffer) : (entryPrice - beFeeBuffer);

  return {
    valid: true,
    slPrice: finalSlPrice,
    tpPrice: finalTpPrice,
    beTriggerPrice: parseFloat(beTriggerPrice.toFixed(decimals)),
    beSlPrice: parseFloat(beSlPrice.toFixed(decimals)),
    slDistance: slDist,
    slPct: parseFloat(finalSlPct.toFixed(2)),
    tpDistance: finalTpDist,
    tpPct: parseFloat(finalTpPct.toFixed(2)),
    minSlPct: minSlPct,
    atrPct: parseFloat(atrPct.toFixed(2)),
    slScenario: slScenario,
    tpAnchorType: tpAnchorType,
    matchedSwing: matchedSwing,
    leverage: effectiveLeverage,
    margin: standardMargin,
    targetLossUSD: targetLossUSD,
    tpRatio: parseFloat(rrRatio.toFixed(2)),
    gridWidthPct: effGridWidth,
    rrRatio: parseFloat(rrRatio.toFixed(2))
  };
}

module.exports = {
  calculateTierSLTP,
  buildClusterZones,
  evadeRoundNumber,
  roundSlConservative,
  roundTpConservative,
  getDecimals,
  getStep
};
