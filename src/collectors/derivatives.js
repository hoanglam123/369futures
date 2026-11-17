'use strict';

/**
 * Thu thập dữ liệu derivatives — OI history + Long/Short ratio
 *
 * Nguồn dữ liệu:
 *   1. Coinalyze (nếu có COINALYZE_API_KEY) — tổng hợp 15+ sàn
 *   2. Binance Futures — primary
 *   3. Bybit — fallback
 *
 * Tín hiệu OI & L/S:
 *   - OI tăng + giá tăng = vốn mới vào (bullish confirmation)
 *   - OI giảm + giá tăng = short squeeze (kém bền)
 *   - Retail quá lệch (>55% Long / Short) → Contrarian signal
 */

const axios = require('axios');
const { getCoinalyzeOI, getCoinalyzeLSRatio, isEnabled: coinalyzeEnabled } = require('./coinalyzeData');

const BINANCE = 'https://fapi.binance.com';
const BYBIT   = 'https://api.bybit.com';
const HEADERS = { 'User-Agent': 'crypto-news-bot/1.0' };
const TIMEOUT = 12000;

async function getOIHistory(symbol, lookbackHours = 4) {
  try {
    const { data } = await axios.get(`${BINANCE}/futures/data/openInterestHist`, {
      params: { symbol: `${symbol}USDT`, period: '1h', limit: lookbackHours + 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    if (!Array.isArray(data) || data.length < 2) return null;

    const current = parseFloat(data[data.length - 1].sumOpenInterestValue) / 1e6;
    const prev    = parseFloat(data[0].sumOpenInterestValue) / 1e6;
    if (!prev) return null;

    const changePct = (current - prev) / prev * 100;
    return {
      current,
      prev,
      changePct,
      trend: changePct > 1.5 ? 'RISING' : changePct < -1.5 ? 'FALLING' : 'STABLE',
      source: 'binance',
    };
  } catch { return null; }
}

async function getGlobalLongShort(symbol) {
  try {
    const { data } = await axios.get(`${BINANCE}/futures/data/globalLongShortAccountRatio`, {
      params: { symbol: `${symbol}USDT`, period: '1h', limit: 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    const d = Array.isArray(data) ? data[0] : null;
    if (!d) return null;
    const longPct  = parseFloat(d.longAccount)  * 100;
    const shortPct = parseFloat(d.shortAccount) * 100;
    if (isNaN(longPct)) return null;
    return { longPct, shortPct, ratio: parseFloat(d.longShortRatio), source: 'binance' };
  } catch { return null; }
}

async function getTopTraderLongShort(symbol) {
  try {
    const { data } = await axios.get(`${BINANCE}/futures/data/topLongShortAccountRatio`, {
      params: { symbol: `${symbol}USDT`, period: '1h', limit: 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    const d = Array.isArray(data) ? data[0] : null;
    if (!d) return null;
    const longPct  = parseFloat(d.longAccount)  * 100;
    const shortPct = parseFloat(d.shortAccount) * 100;
    if (isNaN(longPct)) return null;
    return { longPct, shortPct, ratio: parseFloat(d.longShortRatio), source: 'binance' };
  } catch { return null; }
}

function interpretLS(retail, topTrader) {
  if (!retail) return null;

  const retailBias = retail.longPct > 55 ? 'LONG_HEAVY' :
                     retail.longPct < 45 ? 'SHORT_HEAVY' : 'BALANCED';

  const contrarian = retailBias === 'SHORT_HEAVY' ? 'CONTRARIAN_LONG' :
                     retailBias === 'LONG_HEAVY'  ? 'CONTRARIAN_SHORT' : 'NEUTRAL';

  const divergence = topTrader != null && (
    (retail.longPct > 50 && topTrader.longPct < 50) ||
    (retail.longPct < 50 && topTrader.longPct > 50)
  );

  const topBias = !topTrader ? null :
    topTrader.longPct > 55 ? 'TOP_LONG' :
    topTrader.longPct < 45 ? 'TOP_SHORT' : 'TOP_NEUTRAL';

  return { retailBias, contrarian, topBias, divergence };
}

async function getBybitOI(symbol, lookbackHours = 4) {
  try {
    const { data } = await axios.get(`${BYBIT}/v5/market/open-interest`, {
      params: { category: 'linear', symbol: `${symbol}USDT`, intervalTime: '1h', limit: lookbackHours + 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    const list = data?.result?.list;
    if (!list || list.length < 2) return null;

    const sorted = [...list].sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    const prev = parseFloat(sorted[0].openInterest) / 1e6;
    const curr = parseFloat(sorted[sorted.length - 1].openInterest) / 1e6;
    if (!prev) return null;

    const changePct = (curr - prev) / prev * 100;
    return {
      current: curr, prev, changePct,
      trend: changePct > 1.5 ? 'RISING' : changePct < -1.5 ? 'FALLING' : 'STABLE',
      source: 'bybit',
    };
  } catch { return null; }
}

async function getBybitLongShort(symbol) {
  try {
    const { data } = await axios.get(`${BYBIT}/v5/market/account-ratio`, {
      params: { category: 'linear', symbol: `${symbol}USDT`, period: '1h', limit: 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    const d = data?.result?.list?.[0];
    if (!d) return null;
    const longPct = parseFloat(d.buyRatio) * 100;
    if (isNaN(longPct)) return null;
    return { longPct, shortPct: 100 - longPct, ratio: longPct / (100 - longPct), source: 'bybit' };
  } catch { return null; }
}

// ─── Main Derivatives Collector ───────────────────────────────────────────────

async function getDerivatives(symbols = ['BTC', 'ETH'], lookbackHours = 4) {
  const results = {};

  let czOI = {}, czLS = {};
  if (coinalyzeEnabled()) {
    [czOI, czLS] = await Promise.all([
      getCoinalyzeOI(symbols, lookbackHours),
      getCoinalyzeLSRatio(symbols),
    ]);
  }

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      let oi = czOI[sym] ?? null;
      if (!oi) {
        oi = await getOIHistory(sym, lookbackHours);
        if (!oi) oi = await getBybitOI(sym, lookbackHours);
      }

      let retail = czLS[sym] ?? null;
      if (!retail) {
        retail = await getGlobalLongShort(sym);
        if (!retail) retail = await getBybitLongShort(sym);
      }

      const topTrader = await getTopTraderLongShort(sym);
      if (!oi && !retail) return;

      results[sym] = {
        oi,
        retail,
        topTrader,
        lsSignal: interpretLS(retail, topTrader),
      };
    } catch { /* silent fail per symbol */ }
  }));

  return results;
}

module.exports = {
  getDerivatives,
  getOIHistory,
  getGlobalLongShort,
  getTopTraderLongShort,
  interpretLS
};
