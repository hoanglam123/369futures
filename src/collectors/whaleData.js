'use strict';

/**
 * Thu thập dữ liệu cá voi từ Binance Futures (nguồn chính):
 *
 * 1. Binance Futures aggTrades  — lọc lệnh lớn theo startTime (lookback window)
 *    Notional = price × qty; m=true → buyer maker → seller aggressor → SELL
 *
 * 2. Binance Taker Flow         — cumulative delta tất cả lệnh futures (retail + whale)
 *
 * 3. Binance Force Orders       — thanh lý cưỡng bức (không thể ẩn)
 *
 * 4. Coinalyze Liquidations     — thanh lý tổng hợp 15+ sàn khi có API Key
 *
 * Phân cấp cá voi:
 *   RETAIL_LARGE : $1M – $5M
 *   WHALE        : $5M – $20M
 *   INSTITUTION  : >$20M
 */

const axios = require('axios');
const { getCoinalyzeLiquidations, isEnabled: coinalyzeEnabled } = require('./coinalyzeData');

const BINANCE_FUTURES = 'https://fapi.binance.com';
const OKX             = 'https://www.okx.com';
const HEADERS         = { 'User-Agent': 'crypto-news-bot/1.0' };
const TIMEOUT         = 15000;

const TIER1 = 1_000_000;   // retail lớn / prop nhỏ ($1M+)
const TIER2 = 5_000_000;   // whale thực sự ($5M+)
const TIER3 = 20_000_000;  // institution / quỹ lớn ($20M+)

function tierOf(n) {
  if (n >= TIER3) return 'INSTITUTION';
  if (n >= TIER2) return 'WHALE';
  return 'RETAIL_LARGE';
}

function fmtM(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

// ─── Binance Futures Large Trades ────────────────────────────────────────────

async function getBinanceLargeTrades(symbols = ['BTC', 'ETH'], lookbackHours = 4, minNotional = TIER1) {
  const startTime = Date.now() - lookbackHours * 3_600_000;
  const results = {};

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      const { data } = await axios.get(`${BINANCE_FUTURES}/fapi/v1/aggTrades`, {
        params: { symbol: `${sym}USDT`, startTime, limit: 1000 },
        headers: HEADERS, timeout: TIMEOUT,
      });

      const stats = { buyVol: 0, sellVol: 0, buyCount: 0, sellCount: 0, notableEvents: [] };
      const tiers = {
        RETAIL_LARGE: { buyVol: 0, sellVol: 0 },
        WHALE:        { buyVol: 0, sellVol: 0 },
        INSTITUTION:  { buyVol: 0, sellVol: 0 },
      };

      for (const t of (data || [])) {
        const notional = parseFloat(t.p) * parseFloat(t.q);
        if (notional < minNotional) continue;

        const side = t.m ? 'SELL' : 'BUY';
        const tier = tierOf(notional);

        if (side === 'BUY') { stats.buyVol += notional; stats.buyCount++; tiers[tier].buyVol += notional; }
        else                { stats.sellVol += notional; stats.sellCount++; tiers[tier].sellVol += notional; }

        stats.notableEvents.push({ side, notional, tier, ts: t.T });
      }

      const total = stats.buyVol + stats.sellVol;
      if (!total) return;

      const buyPct = stats.buyVol / total * 100;
      results[sym] = {
        ...stats,
        buyPct,
        sellPct: 100 - buyPct,
        tiers,
        bias: buyPct > 60 ? 'WHALE_BUY' : buyPct < 40 ? 'WHALE_SELL' : 'WHALE_NEUTRAL',
        notableEvents: stats.notableEvents.sort((a, b) => b.notional - a.notional).slice(0, 5),
        source: 'binance_futures',
        lookbackHours,
        minNotional,
      };
    } catch { /* silent fail per symbol */ }
  }));

  return results;
}

// ─── Binance Futures Liquidations ────────────────────────────────────────────

async function getBinanceLiquidations(symbols = ['BTC', 'ETH'], lookbackHours = 4) {
  const startTime = Date.now() - lookbackHours * 3_600_000;
  const results = {};

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      const { data } = await axios.get(`${BINANCE_FUTURES}/fapi/v1/allForceOrders`, {
        params: { symbol: `${sym}USDT`, startTime, limit: 1000 },
        headers: HEADERS, timeout: TIMEOUT,
      });
      if (!Array.isArray(data) || !data.length) return;

      let longLiqVol = 0, shortLiqVol = 0;
      const largeLiqs = [];

      for (const liq of data) {
        const notional = parseFloat(liq.averagePrice) * parseFloat(liq.executedQty);
        if (!notional) continue;

        if (liq.side === 'SELL') longLiqVol  += notional;
        else                     shortLiqVol += notional;

        if (notional >= 500_000) {
          largeLiqs.push({
            type:     liq.side === 'SELL' ? 'LONG_LIQ' : 'SHORT_LIQ',
            notional, ts: liq.time,
          });
        }
      }

      const totalLiq = longLiqVol + shortLiqVol;
      if (!totalLiq) return;

      results[sym] = {
        longLiqVol, shortLiqVol, totalLiq,
        dominant: longLiqVol > shortLiqVol ? 'LONG_SQUEEZE' : 'SHORT_SQUEEZE',
        largeLiqs: largeLiqs.sort((a, b) => b.notional - a.notional).slice(0, 3),
        lookbackHours,
      };
    } catch { /* silent fail per symbol */ }
  }));

  return results;
}

// ─── Taker Flow: Binance primary, OKX fallback ────────────────────────────────

async function getBinanceTakerFlow(symbols = ['BTC', 'ETH'], lookbackHours = 4) {
  const limit   = Math.max(1, Math.ceil(lookbackHours));
  const results = {};

  await Promise.allSettled(symbols.map(async (sym) => {
    let rows = null;

    try {
      const { data } = await axios.get(`${BINANCE_FUTURES}/futures/data/takerlongshortRatio`, {
        params: { symbol: `${sym}USDT`, period: '1h', limit },
        headers: HEADERS, timeout: TIMEOUT,
      });
      if (data?.length) {
        rows = data.map(r => ({ buyVol: parseFloat(r.buyVol), sellVol: parseFloat(r.sellVol) }));
      }
    } catch { /* fall through to OKX */ }

    if (!rows) {
      try {
        const { data } = await axios.get(`${OKX}/api/v5/rubik/stat/taker-volume`, {
          params: { ccy: sym, instType: 'CONTRACTS', period: '1H', limit },
          headers: HEADERS, timeout: TIMEOUT,
        });
        if (data.data?.length) {
          rows = data.data.map(r => ({ buyVol: parseFloat(r[1]), sellVol: parseFloat(r[2]) }));
        }
      } catch { /* silent fail */ }
    }

    if (!rows?.length) return;

    let buyVol = 0, sellVol = 0;
    for (const row of rows) {
      buyVol  += row.buyVol  || 0;
      sellVol += row.sellVol || 0;
    }

    const total = buyVol + sellVol;
    if (!total) return;

    const buyPct = buyVol / total * 100;
    results[sym] = {
      buyVol,
      sellVol,
      buyPct,
      sellPct: 100 - buyPct,
      bias: buyPct > 58 ? 'BUY_PRESSURE' : buyPct < 42 ? 'SELL_PRESSURE' : 'NEUTRAL',
      lookbackHours: limit,
    };
  }));

  return results;
}

function getCrossSignal(sym, takerFlow, binanceLarge) {
  const signals = [];

  const tf = takerFlow?.[sym];
  if (tf) signals.push(tf.bias === 'BUY_PRESSURE' ? 1 : tf.bias === 'SELL_PRESSURE' ? -1 : 0);

  const bn = binanceLarge?.[sym];
  if (bn) signals.push(bn.bias === 'WHALE_BUY' ? 1 : bn.bias === 'WHALE_SELL' ? -1 : 0);

  if (!signals.length) return null;
  const sum     = signals.reduce((a, b) => a + b, 0);
  const bullish = signals.filter(s => s === 1).length;
  const bearish = signals.filter(s => s === -1).length;

  if (sum === 2)  return { verdict: 'XÁC NHẬN MUA', strength: bullish, total: signals.length };
  if (sum === -2) return { verdict: 'XÁC NHẬN BÁN', strength: bearish, total: signals.length };
  if (sum === 1)  return { verdict: 'NGHIÊNG VỀ MUA', strength: bullish, total: signals.length };
  if (sum === -1) return { verdict: 'NGHIÊNG VỀ BÁN', strength: bearish, total: signals.length };

  const actualDivergence = signals.length >= 2 &&
    signals.some(s => s > 0) && signals.some(s => s < 0);
  if (actualDivergence) return { verdict: 'PHÂN KỲ/TRUNG TÍNH', strength: 0, total: signals.length };
  return { verdict: 'TRUNG TÍNH', strength: 0, total: signals.length };
}

// ─── Main Whale Data Collector ────────────────────────────────────────────────

async function getWhaleData(symbols = ['BTC', 'ETH', 'SOL'], lookbackHours = 4) {
  const [flowResult, binanceLargeResult, liqResult, cgLiqResult] = await Promise.allSettled([
    getBinanceTakerFlow(symbols, lookbackHours),
    getBinanceLargeTrades(symbols, lookbackHours),
    getBinanceLiquidations(symbols, lookbackHours),
    coinalyzeEnabled() ? getCoinalyzeLiquidations(symbols, lookbackHours) : Promise.resolve({}),
  ]);

  const takerFlow        = flowResult.status === 'fulfilled'         ? flowResult.value        : {};
  const binanceLarge     = binanceLargeResult.status === 'fulfilled' ? binanceLargeResult.value : {};
  const binanceLiqs      = liqResult.status === 'fulfilled'          ? liqResult.value          : {};
  const czLiqs           = cgLiqResult.status === 'fulfilled'        ? cgLiqResult.value        : {};

  const liquidations     = Object.keys(czLiqs).length > 0
    ? { ...binanceLiqs, ...czLiqs }
    : binanceLiqs;

  const crossSignals = {};
  for (const sym of new Set([...Object.keys(takerFlow), ...Object.keys(binanceLarge)])) {
    const cs = getCrossSignal(sym, takerFlow, binanceLarge);
    if (cs) crossSignals[sym] = cs;
  }

  return { takerFlow, binanceLarge, crossSignals, liquidations, fmtM };
}

module.exports = {
  getWhaleData,
  getBinanceTakerFlow,
  getBinanceLargeTrades,
  getBinanceLiquidations,
  getCrossSignal,
  fmtM
};
