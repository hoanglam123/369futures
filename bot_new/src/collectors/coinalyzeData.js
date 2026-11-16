'use strict';

/**
 * Coinalyze API v1 — dữ liệu derivatives tổng hợp đa sàn (MIỄN PHÍ với API key)
 *
 * Đăng ký miễn phí: https://coinalyze.net → lấy API key
 * Rate limit: 40 req/phút (free tier)
 * Tổng hợp từ 15+ sàn: Binance, OKX, Bybit, BitMEX, Deribit...
 *
 * Chiến lược gọi API (tiết kiệm rate limit):
 *   OI + LS: 1 request duy nhất cho TẤT CẢ coins (multi-symbol, max 20/request)
 *   Liquidations: multi-symbol batch theo sàn (1 request/batch-20)
 *   /future-markets: chỉ gọi 1 lần, cache suốt vòng đời process
 *
 * Response format: [{symbol, history:[{t,o,h,l,c}|{t,r,l,s}|{t,l,s}]}]
 * Symbol format:   BTCUSDT_PERP.A (Binance), BTCUSDT.6 (OKX), BTCUSDT_PERP.3 (Bybit)...
 * Timestamp:       POSIX seconds (không phải ms như Binance)
 * Auth:            header "api_key: <key>"
 */

const axios = require('axios');

const BASE    = 'https://api.coinalyze.net/v1';
const TIMEOUT = 12000;
const BATCH   = 20; // max symbols per request

// Cache market objects (process-lifetime — gọi /future-markets 1 lần)
let _marketsCache = null; // raw object array từ API
const _symCache   = {};   // coin → [symbol_strings_for_this_coin]

function isEnabled() {
  const key = process.env.COINALYZE_API_KEY;
  return !!(key && key !== 'your_coinalyze_api_key_here' && key.length > 5);
}

function hdr() {
  return { 'api_key': process.env.COINALYZE_API_KEY, 'User-Agent': 'crypto-news-bot/1.0' };
}

function nowSec()       { return Math.floor(Date.now() / 1000); }
function pastSec(hours) { return Math.floor((Date.now() - hours * 3_600_000) / 1000); }

// Extract history array — KHÔNG fallback sang data[0] nếu không tìm thấy symbol
function _history(data, sym) {
  if (!Array.isArray(data)) return [];
  const entry = data.find(d => d.symbol === sym);
  return entry?.history ?? [];
}

// ─── Market Discovery ─────────────────────────────────────────────────────────

async function _loadMarkets() {
  if (_marketsCache !== null) return _marketsCache;
  try {
    const { data } = await axios.get(`${BASE}/future-markets`, {
      headers: hdr(), timeout: TIMEOUT,
    });
    _marketsCache = Array.isArray(data) ? data : [];
  } catch {
    _marketsCache = [];
  }
  return _marketsCache;
}

// Trả về tất cả USDT perp symbols của một coin (BTC → ['BTCUSDT_PERP.A', 'BTCUSDT.6', ...])
async function _getSymbols(coin) {
  if (_symCache[coin]) return _symCache[coin];
  const markets = await _loadMarkets();
  const syms = markets
    .filter(m => m.base_asset === coin && m.quote_asset === 'USDT' && m.is_perpetual === true)
    .map(m => m.symbol);
  _symCache[coin] = syms.length > 0 ? syms : [`${coin}USDT_PERP.A`]; // fallback: Binance
  return _symCache[coin];
}

// ─── Open Interest History ─────────────────────────────────────────────────────
// Dùng Binance symbol (PERP.A) — lớn nhất, ~40% thị phần BTC futures.
// Batch tất cả coins vào 1 request (tiết kiệm rate limit).
// OI candle fields: {t, o, h, l, c} — c = OI cuối nến (USD với convert_to_usd=true)

async function getCoinalyzeOI(coins = ['BTC', 'ETH'], lookbackHours = 4) {
  if (!isEnabled()) return {};
  const results = {};
  const to   = nowSec();
  const from = pastSec(lookbackHours + 1);

  // Build symbol list (Binance proxy cho mỗi coin)
  const symMap = {}; // BTCUSDT_PERP.A → BTC
  coins.forEach(c => { symMap[`${c}USDT_PERP.A`] = c; });
  const symList = Object.keys(symMap);

  // Batch request (max BATCH symbols/request)
  for (let i = 0; i < symList.length; i += BATCH) {
    const batch  = symList.slice(i, i + BATCH);
    const symStr = batch.join(',');
    try {
      const { data } = await axios.get(`${BASE}/open-interest-history`, {
        params: { symbols: symStr, interval: '1hour', from, to, convert_to_usd: 'true' },
        headers: hdr(), timeout: TIMEOUT,
      });

      for (const sym of batch) {
        const coin    = symMap[sym];
        const candles = _history(data, sym);
        if (candles.length < 2) continue;

        const sorted = [...candles].sort((a, b) => a.t - b.t);
        const prev   = parseFloat(sorted[0].c) / 1e6;                 // → triệu USD
        const curr   = parseFloat(sorted[sorted.length - 1].c) / 1e6;
        if (!prev) continue;

        const changePct = (curr - prev) / prev * 100;
        results[coin] = {
          current: curr, prev, changePct,
          trend: changePct > 1.5 ? 'RISING' : changePct < -1.5 ? 'FALLING' : 'STABLE',
          source: 'coinalyze',
        };
      }
    } catch { /* silent fail per batch */ }
  }

  return results;
}

// ─── Long/Short Ratio ─────────────────────────────────────────────────────────
// LS candle fields: {t, r, l, s}
//   l = longPct (e.g. 63.22 → đã là %, không phải fraction)
//   s = shortPct, r = ratio

async function getCoinalyzeLSRatio(coins = ['BTC', 'ETH']) {
  if (!isEnabled()) return {};
  const results = {};
  const to   = nowSec();
  const from = pastSec(2);

  const symMap = {};
  coins.forEach(c => { symMap[`${c}USDT_PERP.A`] = c; });
  const symList = Object.keys(symMap);

  for (let i = 0; i < symList.length; i += BATCH) {
    const batch  = symList.slice(i, i + BATCH);
    const symStr = batch.join(',');
    try {
      const { data } = await axios.get(`${BASE}/long-short-ratio-history`, {
        params: { symbols: symStr, interval: '1hour', from, to },
        headers: hdr(), timeout: TIMEOUT,
      });

      for (const sym of batch) {
        const coin   = symMap[sym];
        const rows   = _history(data, sym);
        if (!rows.length) continue;

        const latest  = rows[rows.length - 1];
        const longPct = parseFloat(latest.l ?? 0); // đã là % (e.g. 63.22)
        if (!longPct) continue;

        results[coin] = {
          longPct,
          shortPct: 100 - longPct,
          ratio:    longPct / (100 - longPct),
          source:   'coinalyze',
        };
      }
    } catch { /* silent fail per batch */ }
  }

  return results;
}

// ─── Liquidations (tổng hợp đa sàn) ──────────────────────────────────────────
// Liq candle fields: {t, l, s}
//   l = longLiqVol (USD), s = shortLiqVol (USD) với convert_to_usd=true
// Tổng hợp TẤT CẢ exchange symbols qua /future-markets → bao gồm OKX, Bybit, BitMEX...

async function getCoinalyzeLiquidations(coins = ['BTC', 'ETH'], lookbackHours = 4) {
  if (!isEnabled()) return {};

  const to   = nowSec();
  const from = pastSec(lookbackHours);

  // Khám phá tất cả symbol cho từng coin từ /future-markets
  const symsByCoin = {};
  await Promise.allSettled(coins.map(async (coin) => {
    symsByCoin[coin] = await _getSymbols(coin);
  }));

  // Flat list [{coin, sym}, ...]
  const pairs = Object.entries(symsByCoin)
    .flatMap(([coin, syms]) => syms.map(sym => ({ coin, sym })));

  const accum = {}; // coin → {longLiqVol, shortLiqVol}

  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch  = pairs.slice(i, i + BATCH);
    const symStr = batch.map(p => p.sym).join(',');
    try {
      const { data } = await axios.get(`${BASE}/liquidation-history`, {
        params: { symbols: symStr, interval: '1hour', from, to, convert_to_usd: 'true' },
        headers: hdr(), timeout: TIMEOUT,
      });

      for (const { coin, sym } of batch) {
        const rows = _history(data, sym); // trả [] nếu symbol không có trong response
        if (!rows.length) continue;

        let longVol = 0, shortVol = 0;
        for (const r of rows) {
          longVol  += parseFloat(r.l ?? 0);
          shortVol += parseFloat(r.s ?? 0);
        }
        if (!longVol && !shortVol) continue;

        if (!accum[coin]) accum[coin] = { longLiqVol: 0, shortLiqVol: 0 };
        accum[coin].longLiqVol  += longVol;
        accum[coin].shortLiqVol += shortVol;
      }
    } catch { /* silent fail per batch */ }
  }

  const results = {};
  for (const [coin, a] of Object.entries(accum)) {
    const totalLiq = a.longLiqVol + a.shortLiqVol;
    if (!totalLiq) continue;
    results[coin] = {
      longLiqVol:  a.longLiqVol,
      shortLiqVol: a.shortLiqVol,
      totalLiq,
      dominant:    a.longLiqVol > a.shortLiqVol ? 'LONG_SQUEEZE' : 'SHORT_SQUEEZE',
      largeLiqs:   [],
      lookbackHours,
      source:      'coinalyze',
    };
  }

  return results;
}

module.exports = { getCoinalyzeOI, getCoinalyzeLSRatio, getCoinalyzeLiquidations, isEnabled };
