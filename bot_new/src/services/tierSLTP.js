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

const EPOCH_MS_THRESHOLD = 1_000_000_000_000;
const D1_FRESH_MAX_AGE_MS = 60 * 24 * 3600 * 1000; // Cản D1 1 chạm chỉ tính là Cản Cứng nếu trong <= 60 ngày gần nhất (hoặc cực trị 90d)

/**
 * Đếm số lần chạm ĐỘC LẬP theo thời gian (chống đếm trùng 1 đỉnh qua H1+H4+D1 hoặc 1 đợt sideway ngắn).
 */
function countDistinctTouches(points, minSepMs) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const timed = points.filter(p => typeof p.time === 'number' && p.time >= EPOCH_MS_THRESHOLD);
  if (timed.length === 0) {
    // Dữ liệu mock/không có epoch timestamp: đếm số điểm riêng biệt (theo idx nếu có)
    const keys = new Set(points.map((p, i) => (p.idx != null ? `${p.timeframe || ''}_${p.idx}` : `${p.timeframe || ''}_${p.price}_${i}`)));
    return keys.size;
  }
  const sorted = [...timed].sort((a, b) => a.time - b.time);
  let count = 1;
  let lastT = sorted[0].time;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - lastT >= minSepMs) {
      count++;
      lastT = sorted[i].time;
    }
  }
  return count;
}

/**
 * Kiểm tra số lần nến H4 đóng cửa xuyên qua lại vùng cản sau khi hình thành (lọc "Cản chết").
 * Nếu giá đóng nến cắt qua lại >= 3 lần trong 30 ngày gần nhất -> cản đã mất hiệu lực, hạ xuống Cản Mềm.
 */
function countZoneCrossings(zoneMin, zoneMax, formationTime, h4Candles) {
  if (!Array.isArray(h4Candles) || h4Candles.length < 4) return 0;
  const recent = h4Candles.slice(-180); // ~30 ngày H4
  const lowerBound = zoneMin * 0.9985;
  const upperBound = zoneMax * 1.0015;
  let crossings = 0;
  let lastSide = 0; // -1: dưới cụm, +1: trên cụm

  for (const c of recent) {
    if (formationTime >= EPOCH_MS_THRESHOLD && typeof c.openTime === 'number' && c.openTime >= EPOCH_MS_THRESHOLD) {
      if (c.openTime <= formationTime) continue;
    }
    const close = c.close;
    if (close > upperBound) {
      if (lastSide === -1) crossings++;
      lastSide = 1;
    } else if (close < lowerBound) {
      if (lastSide === 1) crossings++;
      lastSide = -1;
    }
  }
  return crossings;
}

/**
 * Gom cụm các điểm xoay (Swing Points) thành các Vùng Cản Cụm (Cluster Zones).
 * - Chống Cluster Chaining: so với tâm cụm (zoneMid) VÀ giới hạn bề rộng tối đa của 1 vùng cản.
 * - Hỗ trợ đếm chạm độc lập theo thời gian, độ tươi D1, và lọc cản đã bị xuyên phá nhiều lần.
 */
function buildClusterZones(points, toleranceRatio = 0.005, opts = {}) {
  if (!points || !Array.isArray(points) || points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let currentGroup = [sorted[0]];
  let groupSum = sorted[0].price;

  for (let i = 1; i < sorted.length; i++) {
    const pt = sorted[i];
    const groupMin = currentGroup[0].price;
    const groupMid = groupSum / currentGroup.length;

    const tol = Math.max(groupMid * toleranceRatio, groupMid * 0.002);
    const maxZoneWidth = groupMin * Math.max(0.008, toleranceRatio * 2.5);

    if (Math.abs(pt.price - groupMid) <= tol && (pt.price - groupMin) <= maxZoneWidth) {
      currentGroup.push(pt);
      groupSum += pt.price;
    } else {
      clusters.push(summarizeClusterZone(currentGroup, opts));
      currentGroup = [pt];
      groupSum = pt.price;
    }
  }
  if (currentGroup.length > 0) {
    clusters.push(summarizeClusterZone(currentGroup, opts));
  }

  return clusters;
}

function summarizeClusterZone(group, opts = {}) {
  const prices = group.map(p => p.price);
  const zoneMin = Math.min(...prices);
  const zoneMax = Math.max(...prices);
  const zoneMid = prices.reduce((sum, p) => sum + p, 0) / prices.length;

  const d1Points = group.filter(p => p.timeframe === 'D1');
  const h4Points = group.filter(p => p.timeframe === 'H4');
  const h1Points = group.filter(p => p.timeframe === 'H1');

  const distinctD1 = countDistinctTouches(d1Points, 72 * 3600_000);
  const distinctH4 = countDistinctTouches(h4Points, 24 * 3600_000);
  const distinctH1 = countDistinctTouches(h1Points, 12 * 3600_000);
  const distinctAll = countDistinctTouches(group, 12 * 3600_000);

  const refNowMs = opts.referenceNowMs || Date.now();
  const hasFreshD1 = d1Points.some(p => {
    if (p.isExtreme90d) return true;
    if (!p.time || p.time < EPOCH_MS_THRESHOLD) return true; // mock test không dùng epoch
    return (refNowMs - p.time) <= D1_FRESH_MAX_AGE_MS;
  });

  // Kiểm tra cản chết (bị nến H4 đóng xuyên qua lại >= 3 lần sau khi hình thành)
  const validTimes = group.map(p => p.time).filter(t => typeof t === 'number' && t >= EPOCH_MS_THRESHOLD);
  const formationTime = validTimes.length > 0 ? Math.min(...validTimes) : 0;
  const crossings = opts.h4Candles ? countZoneCrossings(zoneMin, zoneMax, formationTime, opts.h4Candles) : 0;
  const isBroken = crossings >= 3;

  const highestTf = d1Points.length > 0 ? 'D1' : (h4Points.length > 0 ? 'H4' : 'H1');

  // Cản Cứng (Major S/R) chuẩn Price Action:
  // - D1 còn hiệu lực (<= 60 ngày gần nhất hoặc cực trị 90d) hoặc D1 >= 2 chạm độc lập
  // - HOẶC H4 >= 2 chạm độc lập (cách nhau >= 24h)
  // - HOẶC H1 >= 3 chạm độc lập (cách nhau >= 12h)
  // - VÀ chưa bị giá đóng nến xuyên phá qua lại >= 3 lần
  const rawMajor = (distinctD1 >= 2) || hasFreshD1 || (distinctH4 >= 2) || (distinctH1 >= 3);
  const isMajor = !isBroken && rawMajor;

  const highCount = group.filter(p => p.type === 'HIGH').length;
  const lowCount  = group.filter(p => p.type === 'LOW').length;

  return {
    zoneMin,
    zoneMax,
    zoneMid,
    touches: distinctAll,
    distinctD1Touches: distinctD1,
    distinctH4Touches: distinctH4,
    distinctH1Touches: distinctH1,
    timeframe: highestTf,
    isMajor,
    isBroken,
    crossings,
    dominantType: highCount >= lowCount ? 'HIGH' : 'LOW',
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
 * Né Số Tròn Tâm Lý cho TP (Front-running Psychological Round Numbers):
 * Nếu TP rơi ngay sát hoặc vừa nhô qua mốc số tròn lớn ([-0.05%, +0.30%]),
 * kéo TP lùi nhẹ (-0.15%) về phía an toàn để khớp sớm trước tường xả/hút, miễn R:R vẫn >= 1.48.
 */
function evadeTpRoundNumber(tpPrice, entryPrice, slDist, isLong) {
  if (!tpPrice || tpPrice <= 0 || !entryPrice || !slDist || slDist <= 0 || isNaN(tpPrice)) return tpPrice;
  const mag = Math.pow(10, Math.floor(Math.log10(tpPrice)));
  let stepR;
  if (tpPrice >= 1000) stepR = 500;
  else if (tpPrice >= 100) stepR = 50;
  else if (tpPrice >= 10) stepR = 5;
  else if (tpPrice >= 1) stepR = 0.5;
  else if (tpPrice >= 0.1) stepR = 0.05;
  else stepR = mag;

  const nearestRound = Math.round(tpPrice / stepR) * stepR;
  if (nearestRound <= 0) return tpPrice;

  let candidate = null;
  if (isLong) {
    const rel = (tpPrice - nearestRound) / nearestRound;
    if (rel >= -0.0005 && rel <= 0.0030) {
      candidate = nearestRound * (1 - 0.0015);
    }
  } else {
    const rel = (nearestRound - tpPrice) / nearestRound;
    if (rel >= -0.0005 && rel <= 0.0030) {
      candidate = nearestRound * (1 + 0.0015);
    }
  }

  if (candidate != null) {
    const newDist = isLong ? (candidate - entryPrice) : (entryPrice - candidate);
    if (newDist > 0 && (newDist / slDist) >= 1.48) {
      return candidate;
    }
  }
  return tpPrice;
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

  // 3. Quét cấu trúc Swing S/R hợp nhất (hỗ trợ S/R Flip, chống đếm trùng đa khung & lọc cản chết)
  const allSwingPoints = [];

  if (h1Candles && h1Candles.length >= 7) {
    const swH1 = findSwingPoints(h1Candles.slice(-300), 3, 3);
    for (const pt of (swH1.lowPoints || []))  allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H1', type: 'LOW' });
    for (const pt of (swH1.highPoints || [])) allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H1', type: 'HIGH' });
  }

  if (h4Candles && h4Candles.length >= 5) {
    const swH4 = findSwingPoints(h4Candles.slice(-150), 2, 2);
    for (const pt of (swH4.lowPoints || []))  allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H4', type: 'LOW' });
    for (const pt of (swH4.highPoints || [])) allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H4', type: 'HIGH' });
  }

  if (d1Candles && d1Candles.length >= 5) {
    const d1Slice = d1Candles.slice(-180);
    const d1Recent90 = d1Slice.slice(-90);
    const max90d = d1Recent90.length ? Math.max(...d1Recent90.map(c => c.high)) : null;
    const min90d = d1Recent90.length ? Math.min(...d1Recent90.map(c => c.low)) : null;
    const swD1 = findSwingPoints(d1Slice, 2, 2);
    for (const pt of (swD1.lowPoints || [])) {
      allSwingPoints.push({
        price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'D1', type: 'LOW',
        isExtreme90d: min90d != null && Math.abs(pt.price - min90d) <= min90d * 0.002
      });
    }
    for (const pt of (swD1.highPoints || [])) {
      allSwingPoints.push({
        price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'D1', type: 'HIGH',
        isExtreme90d: max90d != null && Math.abs(pt.price - max90d) <= max90d * 0.002
      });
    }
  }

  // Mốc thời gian tham chiếu hiện tại theo nến mới nhất (hỗ trợ chuẩn cả live lẫn backtest)
  const latestCandleTs = Math.max(
    h1Candles.length ? (h1Candles[h1Candles.length - 1].openTime || 0) : 0,
    h4Candles.length ? (h4Candles[h4Candles.length - 1].openTime || 0) : 0,
    d1Candles.length ? (d1Candles[d1Candles.length - 1].openTime || 0) : 0
  );
  const referenceNowMs = latestCandleTs >= EPOCH_MS_THRESHOLD ? latestCandleTs : Date.now();

  const tolRatio = atrVal > 0 ? Math.max(0.003, (atrVal / entryPrice) * 0.20) : 0.005;
  const unifiedClusters = buildClusterZones(allSwingPoints, tolRatio, { h4Candles, referenceNowMs });

  // S/R Flip: Cụm nằm dưới Entry là Support (kể cả đỉnh cũ bị phá); cụm nằm trên Entry là Resistance (kể cả đáy cũ bị phá)
  const supportClusters = unifiedClusters
    .filter(c => c.zoneMax < entryPrice * 0.999)
    .map(c => ({ ...c, isRoleFlipped: c.dominantType === 'HIGH' }))
    .sort((a, b) => b.zoneMax - a.zoneMax);

  const resistanceClusters = unifiedClusters
    .filter(c => c.zoneMin > entryPrice * 1.001)
    .map(c => ({ ...c, isRoleFlipped: c.dominantType === 'LOW' }))
    .sort((a, b) => a.zoneMin - b.zoneMin);

  const protectiveClusters = isLong ? supportClusters : resistanceClusters;

  // 4. MÔ HÌNH HYBRID SL 3 TẦNG THÔNG MINH (Thích ứng ATR, lọc bỏ Cản Chết & ưu tiên Cản Cứng)
  let rawSL = null;
  let slScenario = 'PURE_VOLATILITY_ATR';
  let matchedSwing = null;

  // Sàn & Trần thích ứng ATR:
  // - Sàn: max(baseMin, min(3.5%, 1.5 * ATR)) và >= 1.2 * ATR
  // - Trần: max(3.5%, min(6.0%, 3.0 * ATR))
  const minSlPct = Math.max(baseMinSlPct, Math.min(3.5, 1.5 * atrPct));
  const adaptiveMaxSlPct = Math.max(3.5, Math.min(6.0, 3.0 * atrPct));

  const minSafeDistPct = Math.max(minSlPct, 1.2 * atrPct);
  const maxSafeDistPct = Math.min(adaptiveMaxSlPct, Math.max(3.5, 2.0 * atrPct));

  // Buffer sau cản thích ứng theo ATR: 0.20% (BTC/coin đầm) -> tối đa 0.50% (Altcoin biến động mạnh)
  const slBufferPct = Math.min(0.005, Math.max(0.002, (atrPct / 100) * 0.15));
  const slBuffer = entryPrice * slBufferPct;

  // Lọc bỏ hoàn toàn "Cản Chết" (isBroken === true) khỏi ứng viên đặt SL
  const validProtectiveClusters = protectiveClusters.filter(c => !c.isBroken);

  const pickProtectiveCluster = (pool, minPct, maxPct) => {
    // Pass 1: Ưu tiên Cản Cứng (isMajor) trước để chống quét râu H1 yếu
    for (const c of pool) {
      if (!c.isMajor) continue;
      const distPct = isLong
        ? ((entryPrice - c.zoneMin) / entryPrice) * 100
        : ((c.zoneMax - entryPrice) / entryPrice) * 100;
      if (distPct >= minPct && distPct <= maxPct) return c;
    }
    // Pass 2: Fallback sang cản thường còn hiệu lực (!isBroken)
    for (const c of pool) {
      if (c.isMajor) continue;
      const distPct = isLong
        ? ((entryPrice - c.zoneMin) / entryPrice) * 100
        : ((c.zoneMax - entryPrice) / entryPrice) * 100;
      if (distPct >= minPct && distPct <= maxPct) return c;
    }
    return null;
  };

  // TẦNG 1: CẢN SWEET SPOT H1 / H4 GẦN
  const h1h4ProtectiveClusters = validProtectiveClusters.filter(c => c.timeframe === 'H1' || c.timeframe === 'H4');
  const tier1Cluster = pickProtectiveCluster(h1h4ProtectiveClusters, minSafeDistPct, maxSafeDistPct);
  if (tier1Cluster) {
    matchedSwing = isLong ? tier1Cluster.zoneMin : tier1Cluster.zoneMax;
    rawSL = isLong ? (tier1Cluster.zoneMin - slBuffer) : (tier1Cluster.zoneMax + slBuffer);
    slScenario = 'SWEET_SPOT_SWING';
  }

  // TẦNG 2: CẢN D1 TẦM TRUNG (LỊCH SỬ 6 THÁNG)
  if (!rawSL) {
    const d1ProtectiveClusters = validProtectiveClusters.filter(c => c.timeframe === 'D1');
    const maxD1DistPct = Math.min(adaptiveMaxSlPct, Math.max(4.0, 2.2 * atrPct));
    const tier2Cluster = pickProtectiveCluster(d1ProtectiveClusters, minSafeDistPct, maxD1DistPct);
    if (tier2Cluster) {
      matchedSwing = isLong ? tier2Cluster.zoneMin : tier2Cluster.zoneMax;
      rawSL = isLong ? (tier2Cluster.zoneMin - slBuffer) : (tier2Cluster.zoneMax + slBuffer);
      slScenario = 'TIER2_D1_SWING';
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
          const candidateSL = fib786 + slBuffer;
          const fibDistPct = ((candidateSL - entryPrice) / entryPrice) * 100;
          if (fibDistPct >= minSafeDistPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        } else {
          const fib786 = high24 - 0.786 * waveDelta;
          const candidateSL = fib786 - slBuffer;
          const fibDistPct = ((entryPrice - candidateSL) / entryPrice) * 100;
          if (fibDistPct >= minSafeDistPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        }
      }
    }

    if (!rawSL) {
      const goldenDistPct = Math.min(Math.max(1.618 * atrPct, minSafeDistPct), Math.min(adaptiveMaxSlPct, 3.5));
      rawSL = isLong
        ? (entryPrice * (1 - goldenDistPct / 100.0))
        : (entryPrice * (1 + goldenDistPct / 100.0));
      slScenario = validProtectiveClusters.length > 0 ? 'CLAMP_FAR_SWING' : 'PURE_VOLATILITY_ATR';
    }
  }

  // Kẹp an toàn thích ứng theo ATR (Safety Bounds: minSafeDistPct .. adaptiveMaxSlPct [3.5% - 6.0%])
  const floorPct = Math.min(minSafeDistPct, adaptiveMaxSlPct);
  const maxCeilingPct = adaptiveMaxSlPct;
  let slDist = Math.abs(entryPrice - rawSL);
  if (slDist < entryPrice * (floorPct / 100.0)) {
    slDist = entryPrice * (floorPct / 100.0);
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
        const flipTag = c.isRoleFlipped ? ' S/R-Flip' : '';
        return {
          valid: false,
          reason: `RR_BLOCKED_BY_MAJOR_SR (Cản cứng ${c.timeframe}${flipTag} [${c.zoneMin.toFixed(decimals)}-${c.zoneMax.toFixed(decimals)}] (${c.touches} chạm) chặn tại R:R = ${blockedRR.toFixed(2)} < 1.48)`,
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

  // 5.2. Xác định Mốc TP Mục Tiêu (ưu tiên Cản Cứng isMajor trước, tránh chốt non tại râu H1 yếu)
  let rawTP = null;
  let tpAnchorType = 'STANDARD_RR';

  // Pass 1: Ưu tiên Cản Cứng (isMajor) gần nhất trong [1.48R, 2.50R]
  for (const c of opposingClusters) {
    if (!c.isMajor) continue;
    const frontRunPrice = isLong
      ? (c.zoneMin - entryPrice * 0.002)
      : (c.zoneMax + entryPrice * 0.002);
    const dist = Math.abs(entryPrice - frontRunPrice);
    const candRR = dist / slDist;
    if (candRR >= 1.48 && candRR <= 2.50) {
      rawTP = frontRunPrice;
      tpAnchorType = `${c.timeframe}_SR_ANCHOR`;
      break;
    }
  }

  // Pass 2: Nếu không có Cản Cứng trong [1.48R, 2.50R], xét cản thường còn hiệu lực (!isBroken) đạt >= targetTpRatio
  if (!rawTP) {
    for (const c of opposingClusters) {
      if (c.isMajor || c.isBroken) continue;
      const frontRunPrice = isLong
        ? (c.zoneMin - entryPrice * 0.002)
        : (c.zoneMax + entryPrice * 0.002);
      const dist = Math.abs(entryPrice - frontRunPrice);
      const candRR = dist / slDist;
      if (candRR >= Math.max(1.48, targetTpRatio) && candRR <= 2.50) {
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
    // Khóa trần Fallback tối đa 2.50R để tránh step rộng đẩy TP lên 5R-7R làm hỏng mốc BE 50% TP
    const fallbackDist = Math.min(Math.max(idealTpDist, step * 0.618), slDist * 2.50);
    rawTP = isLong ? (entryPrice + fallbackDist) : (entryPrice - fallbackDist);
    tpAnchorType = 'FALLBACK_RATIO';
  }

  // 5.3. HARD CAP THEO CẢN CỨNG ĐẦU TIÊN: Tuyệt đối không đặt TP xuyên qua phía sau bức tường Cản Cứng!
  const firstMajorWall = opposingClusters.find(c => c.isMajor);
  if (firstMajorWall) {
    const wallFrontRun = isLong
      ? (firstMajorWall.zoneMin - entryPrice * 0.002)
      : (firstMajorWall.zoneMax + entryPrice * 0.002);
    const tpOvershootsWall = isLong ? (rawTP > wallFrontRun) : (rawTP < wallFrontRun);
    if (tpOvershootsWall) {
      rawTP = wallFrontRun;
      tpAnchorType = `${firstMajorWall.timeframe}_MAJOR_WALL_CAP`;
    }
  }

  // 5.4. Né Số Tròn Tâm Lý cho TP (Front-running trước tường xả/hút số tròn, chỉ áp dụng nếu giữ R:R >= 1.48)
  rawTP = evadeTpRoundNumber(rawTP, entryPrice, slDist, isLong);

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

  // 6. THIẾT LẬP MỐC BREAKEVEN 50% TP (mặc định 50% thay vì 35% để chống quét râu non) VÀ ĐỆM PHÍ THỰC 0.14% GIÁ
  const beTriggerRatio = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));
  const fractalTriggerDist = finalTpDist * beTriggerRatio;
  const beTriggerPrice = isLong ? (entryPrice + fractalTriggerDist) : (entryPrice - fractalTriggerDist);
  const beFeeBuffer = entryPrice * 0.0014; // Đệm phí round-trip thực tế 0.14% giá (độc lập với đòn bẩy)
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
  countDistinctTouches,
  countZoneCrossings,
  evadeRoundNumber,
  evadeTpRoundNumber,
  roundSlConservative,
  roundTpConservative,
  getDecimals,
  getStep
};
