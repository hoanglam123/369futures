'use strict';

/**
 * Thu thập dữ liệu derivatives — OI history + Long/Short ratio
 *
 * Thứ tự ưu tiên nguồn dữ liệu:
 *   1. Coinglass (nếu có COINGLASS_API_KEY) — tổng hợp đa sàn, chính xác nhất
 *   2. Binance (fapi.binance.com) — miễn phí, nhưng bị chặn 451 trên US VM
 *   3. Bybit (api.bybit.com) — fallback miễn phí, không bị geo-block
 *
 * Giải thích tín hiệu OI:
 *   OI tăng + giá tăng = vốn mới vào (bullish confirmation)
 *   OI giảm + giá tăng = short squeeze (không bền, thận trọng)
 *   OI tăng + giá giảm = short mới mở (bearish confirmation)
 *   OI giảm + giá giảm = long bị thanh lý / de-leveraging
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

    const current = parseFloat(data[data.length - 1].sumOpenInterestValue) / 1e6; // → triệu USD
    const prev    = parseFloat(data[0].sumOpenInterestValue) / 1e6;
    if (!prev) return null;

    const changePct = (current - prev) / prev * 100;
    return {
      current,
      prev,
      changePct,
      trend: changePct > 1.5 ? 'RISING' : changePct < -1.5 ? 'FALLING' : 'STABLE',
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
    return { longPct, shortPct, ratio: parseFloat(d.longShortRatio) };
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
    return { longPct, shortPct, ratio: parseFloat(d.longShortRatio) };
  } catch { return null; }
}

function interpretLS(retail, topTrader) {
  if (!retail) return null;

  // Retail bias
  const retailBias = retail.longPct > 55 ? 'LONG_HEAVY' :
                     retail.longPct < 45 ? 'SHORT_HEAVY' : 'BALANCED';

  // Contrarian: retail short nhiều → bullish; retail long nhiều → bearish
  const contrarian = retailBias === 'SHORT_HEAVY' ? 'CONTRARIAN_LONG' :
                     retailBias === 'LONG_HEAVY'  ? 'CONTRARIAN_SHORT' : 'NEUTRAL';

  // Divergence: retail và top trader ngược chiều nhau
  const divergence = topTrader != null && (
    (retail.longPct > 50 && topTrader.longPct < 50) ||
    (retail.longPct < 50 && topTrader.longPct > 50)
  );

  const topBias = !topTrader ? null :
    topTrader.longPct > 55 ? 'TOP_LONG' :
    topTrader.longPct < 45 ? 'TOP_SHORT' : 'TOP_NEUTRAL';

  return { retailBias, contrarian, topBias, divergence };
}

// ─── Bybit fallback (free, no geo-block) ──────────────────────────────────────

async function getBybitOI(symbol, lookbackHours = 4) {
  try {
    const { data } = await axios.get(`${BYBIT}/v5/market/open-interest`, {
      params: { category: 'linear', symbol: `${symbol}USDT`, intervalTime: '1h', limit: lookbackHours + 1 },
      headers: HEADERS, timeout: TIMEOUT,
    });
    const list = data?.result?.list;
    if (!list || list.length < 2) return null;

    const sorted = [...list].sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    // openInterest for linear USDT perps is in USD value
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getDerivatives(symbols = ['BTC', 'ETH'], lookbackHours = 4) {
  const results = {};

  // Coinalyze: single batch call for all symbols (priority source)
  let czOI = {}, czLS = {};
  if (coinalyzeEnabled()) {
    [czOI, czLS] = await Promise.all([
      getCoinalyzeOI(symbols, lookbackHours),
      getCoinalyzeLSRatio(symbols),
    ]);
  }

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      // OI: Coinalyze → Binance → Bybit
      let oi = czOI[sym] ?? null;
      if (!oi) {
        oi = await getOIHistory(sym, lookbackHours);
        if (!oi) oi = await getBybitOI(sym, lookbackHours);
      }

      // Retail L/S ratio: Coinalyze → Binance → Bybit
      let retail = czLS[sym] ?? null;
      if (!retail) {
        retail = await getGlobalLongShort(sym);
        if (!retail) retail = await getBybitLongShort(sym);
      }

      // Top trader L/S (Binance only — no direct Bybit/Coinglass equivalent)
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

module.exports = { getDerivatives };
