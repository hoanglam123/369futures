'use strict';

/**
 * Microstructure Scanner — PP369
 * Đo đạc Vi Cấu Trúc Sổ Lệnh & Dòng Tiền Tức Thì từ Binance Futures:
 * 1. Bid-Ask Spread & Trượt giá (Spread Guard)
 * 2. Cumulative Volume Delta M1/M5 (CVD Momentum)
 * 3. Tường cản Sổ Lệnh L2 (Orderbook Wall Distance)
 */

const axios = require('axios');

const BINANCE_FAPI_URL = 'https://fapi.binance.com';

// Cache ngắn hạn (5 giây) để tránh spam API Binance
const _microCache = new Map();
const CACHE_TTL_MS = 5000;

function getCached(key) {
  const item = _microCache.get(key);
  if (item && Date.now() - item.time < CACHE_TTL_MS) {
    return item.data;
  }
  return null;
}

function setCache(key, data) {
  _microCache.set(key, { time: Date.now(), data });
}

/**
 * Đo độ dãn Spread giữa giá Bid và Ask tốt nhất (Phân tầng ngưỡng an toàn theo Rank coin)
 * @param {string} sym - Symbol không có hậu tố (e.g. BTC, ETH)
 * @param {number} [rank=999] - Thứ hạng vốn hóa thị trường
 * @returns {Promise<{ spreadPct: number, bidPrice: number, askPrice: number, category: string }>}
 */
async function getSpreadMetrics(sym, rank = 999) {
  const cacheKey = `spread_${sym}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get(`${BINANCE_FAPI_URL}/fapi/v1/bookTicker?symbol=${sym}USDT`, { timeout: 1500 });
    const data = res.data;
    const bidPrice = parseFloat(data.bidPrice);
    const askPrice = parseFloat(data.askPrice);

    if (bidPrice <= 0 || askPrice <= 0) {
      return { spreadPct: 0.02, bidPrice, askPrice, category: 'SPREAD_TIGHT_SAFE' };
    }

    const spreadPct = ((askPrice - bidPrice) / bidPrice) * 100;
    
    // 🛡️ PHÂN TẦNG ĐỘNG THEO RANK COIN (Adaptive Spread Guard):
    // - Top 50: Cực kỳ khắt khe (> 0.04% là VETO) vì top coin thanh khoản luôn dày
    // - Rank 51-150: Tiêu chuẩn (> 0.06% là VETO)
    // - Lowcap (> 150): Nới lỏng nhẹ (> 0.08% mới VETO) vì biên độ nến rộng hơn
    let dangerTh = 0.060;
    let cautionTh = 0.035;
    if (rank <= 50) {
      dangerTh = 0.040;
      cautionTh = 0.025;
    } else if (rank <= 150) {
      dangerTh = 0.060;
      cautionTh = 0.035;
    } else {
      dangerTh = 0.080;
      cautionTh = 0.045;
    }

    let category = 'SPREAD_TIGHT_SAFE';
    if (spreadPct > dangerTh) {
      category = 'SPREAD_WIDE_DANGER'; // Độ dãn spread nguy hiểm, trượt giá lớn
    } else if (spreadPct > cautionTh) {
      category = 'SPREAD_MEDIUM_CAUTION'; // Độ dãn vừa phải
    }

    const result = { spreadPct: parseFloat(spreadPct.toFixed(4)), bidPrice, askPrice, category, dangerTh, cautionTh };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    // Fallback an toàn nếu API lỗi
    return { spreadPct: 0.02, bidPrice: 0, askPrice: 0, category: 'SPREAD_TIGHT_SAFE', dangerTh: 0.06, cautionTh: 0.035 };
  }
}

/**
 * Đo xung lực dòng lệnh Taker M1/M5 (Cumulative Volume Delta)
 * @param {string} sym - Symbol
 * @param {string} side - LONG hoặc SHORT
 * @returns {Promise<{ takerBuyRatio: number, cvdCategory: string }>}
 */
async function getCvdMomentum(sym, side = 'LONG') {
  const cacheKey = `cvd_${sym}`;
  const cached = getCached(cacheKey);
  if (cached) return formatCvdForSide(cached, side);

  try {
    const res = await axios.get(`${BINANCE_FAPI_URL}/fapi/v1/aggTrades?symbol=${sym}USDT&limit=300`, { timeout: 1800 });
    const trades = res.data || [];

    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5 phút gần nhất
    let takerBuyVol = 0;
    let takerSellVol = 0;

    for (const t of trades) {
      if (now - t.T > windowMs) continue;
      const qty = parseFloat(t.q);
      if (t.m) {
        // isBuyerMaker = true -> Người bán đặt lệnh thị trường (Taker Sell)
        takerSellVol += qty;
      } else {
        // isBuyerMaker = false -> Người mua đặt lệnh thị trường (Taker Buy)
        takerBuyVol += qty;
      }
    }

    const totalVol = takerBuyVol + takerSellVol;
    const takerBuyRatio = totalVol > 0 ? (takerBuyVol / totalVol) : 0.50;

    const baseData = { takerBuyRatio, takerBuyVol, takerSellVol, totalVol };
    setCache(cacheKey, baseData);
    return formatCvdForSide(baseData, side);
  } catch (err) {
    return { takerBuyRatio: 0.50, cvdCategory: 'CVD_NEUTRAL' };
  }
}

function formatCvdForSide(baseData, side) {
  const ratio = baseData.takerBuyRatio;
  const isLong = side === 'LONG' || side === 'BUY';

  let cvdCategory = 'CVD_NEUTRAL';
  if (isLong) {
    if (ratio >= 0.58) cvdCategory = 'CVD_SURGE_ALIGNED';       // Taker Buy áp đảo thuận hướng Long
    else if (ratio <= 0.42) cvdCategory = 'CVD_DIVERGENCE_OPPOSING'; // Taker Sell ép xả ngược hướng Long
  } else {
    if (ratio <= 0.42) cvdCategory = 'CVD_SURGE_ALIGNED';       // Taker Sell áp đảo thuận hướng Short
    else if (ratio >= 0.58) cvdCategory = 'CVD_DIVERGENCE_OPPOSING'; // Taker Buy hấp thụ ngược hướng Short
  }

  return {
    takerBuyRatio: parseFloat(ratio.toFixed(3)),
    cvdCategory
  };
}

/**
 * Quét tường cản sổ lệnh Orderbook L2 từ Entry đến TP
 * @param {string} sym - Symbol
 * @param {number} entryPrice - Giá vào lệnh
 * @param {number} tpPrice - Giá chốt lời kỳ vọng
 * @param {string} side - Hướng lệnh (LONG / SHORT)
 * @returns {Promise<{ wallCategory: string, wallPrice: number|null, wallNotionalUsd: number }>}
 */
async function getOrderbookWall(sym, entryPrice, tpPrice, side = 'LONG') {
  const cacheKey = `depth_${sym}`;
  let depth = getCached(cacheKey);

  if (!depth) {
    try {
      const res = await axios.get(`${BINANCE_FAPI_URL}/fapi/v1/depth?symbol=${sym}USDT&limit=50`, { timeout: 1500 });
      depth = res.data;
      setCache(cacheKey, depth);
    } catch (err) {
      return { wallCategory: 'WALL_CLEAR_PATH', wallPrice: null, wallNotionalUsd: 0 };
    }
  }

  const isLong = side === 'LONG' || side === 'BUY';
  const bids = (depth?.bids || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), notional: parseFloat(p) * parseFloat(q) }));
  const asks = (depth?.asks || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), notional: parseFloat(p) * parseFloat(q) }));

  if (isLong) {
    // Với lệnh LONG: Đường tới TP là các nấc giá ASK phía trên entryPrice
    const opposingAsks = asks.filter(a => a.price > entryPrice && a.price <= (tpPrice || entryPrice * 1.025));
    const avgNotional = asks.length > 0 ? (asks.reduce((s, a) => s + a.notional, 0) / asks.length) : 1;

    // Tìm bức tường cản chặn đường tới TP (khối lượng >= 4.0x trung bình)
    const bigWall = opposingAsks.find(a => a.notional >= avgNotional * 4.0 && a.notional >= 50_000);
    if (bigWall) {
      return { wallCategory: 'WALL_OPPOSING_BLOCK', wallPrice: bigWall.price, wallNotionalUsd: Math.round(bigWall.notional) };
    }

    // Kiểm tra xem phía sau Entry (Bid) có tường dày đỡ giá không
    const supportingBids = bids.filter(b => b.price < entryPrice && b.price >= entryPrice * 0.985);
    const avgBidNotional = bids.length > 0 ? (bids.reduce((s, b) => s + b.notional, 0) / bids.length) : 1;
    const supportWall = supportingBids.find(b => b.notional >= avgBidNotional * 3.0 && b.notional >= 40_000);
    if (supportWall) {
      return { wallCategory: 'WALL_SUPPORT_SHIELD', wallPrice: supportWall.price, wallNotionalUsd: Math.round(supportWall.notional) };
    }
  } else {
    // Với lệnh SHORT: Đường tới TP là các nấc giá BID phía dưới entryPrice
    const opposingBids = bids.filter(b => b.price < entryPrice && b.price >= (tpPrice || entryPrice * 0.975));
    const avgNotional = bids.length > 0 ? (bids.reduce((s, b) => s + b.notional, 0) / bids.length) : 1;

    const bigWall = opposingBids.find(b => b.notional >= avgNotional * 4.0 && b.notional >= 50_000);
    if (bigWall) {
      return { wallCategory: 'WALL_OPPOSING_BLOCK', wallPrice: bigWall.price, wallNotionalUsd: Math.round(bigWall.notional) };
    }

    const supportingAsks = asks.filter(a => a.price > entryPrice && a.price <= entryPrice * 1.015);
    const avgAskNotional = asks.length > 0 ? (asks.reduce((s, a) => s + a.notional, 0) / asks.length) : 1;
    const supportWall = supportingAsks.find(a => a.notional >= avgAskNotional * 3.0 && a.notional >= 40_000);
    if (supportWall) {
      return { wallCategory: 'WALL_SUPPORT_SHIELD', wallPrice: supportWall.price, wallNotionalUsd: Math.round(supportWall.notional) };
    }
  }

  return { wallCategory: 'WALL_CLEAR_PATH', wallPrice: null, wallNotionalUsd: 0 };
}

/**
 * Quét toàn diện Vi Cấu Trúc Sổ Lệnh (Chạy song song trong < 500ms)
 * @param {string} sym
 * @param {number} entryPrice
 * @param {number} tpPrice
 * @param {string} side
 * @param {number} [rank=999]
 * @returns {Promise<{ spreadMetrics: object, cvdMetrics: object, wallMetrics: object }>}
 */
async function scanMicrostructure(sym, entryPrice = 0, tpPrice = 0, side = 'LONG', rank = 999) {
  try {
    const [spreadMetrics, cvdMetrics, wallMetrics] = await Promise.all([
      getSpreadMetrics(sym, rank),
      getCvdMomentum(sym, side),
      getOrderbookWall(sym, entryPrice, tpPrice, side)
    ]);

    return {
      spread: spreadMetrics.category,
      spreadPct: spreadMetrics.spreadPct,
      cvd: cvdMetrics.cvdCategory,
      takerBuyRatio: cvdMetrics.takerBuyRatio,
      wall: wallMetrics.wallCategory,
      wallPrice: wallMetrics.wallPrice,
      wallNotionalUsd: wallMetrics.wallNotionalUsd
    };
  } catch (err) {
    return {
      spread: 'SPREAD_TIGHT_SAFE',
      spreadPct: 0.02,
      cvd: 'CVD_NEUTRAL',
      takerBuyRatio: 0.50,
      wall: 'WALL_CLEAR_PATH',
      wallPrice: null,
      wallNotionalUsd: 0
    };
  }
}

module.exports = {
  getSpreadMetrics,
  getCvdMomentum,
  getOrderbookWall,
  scanMicrostructure
};
