'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { isIpBanned } = require('../services/rateLimitGuard');
const { fetchH1Historical, fetchH4Historical, fetchD1Historical } = require('../services/candleCache');

const BINANCE   = 'https://fapi.binance.com';
const OKX       = 'https://www.okx.com';
const HEADERS   = { 'User-Agent': 'crypto-news-bot/1.0' };
const BAR_MAP   = { '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' }; // OKX format
const STABLECOINS = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USDP','FRAX','USDD','GUSD','PYUSD','USDS','USDE','USDX','SUSD']);

// ─── Tối ưu RAM: Dùng chung cache 1h/4h/1d trực tiếp từ candleCache.js (0 bản sao trùng lặp!) ───
// Chỉ giữ riêng cache đĩa nhẹ cho khung tuần 1w (52 nến, tối đa 80 coin nóng trong RAM)
const DATA_DIR = path.resolve(__dirname, '../../data');
const W1_CACHE_FILE = path.join(DATA_DIR, 'w1_history_cache.json');
const W1_MAX_KEEP = 52;
const W1_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const W1_RAM_MAX_COINS = 80;
const _w1Cache = new Map(); // sym -> { candles, cursor }

function toCompactW1(k) {
  return {
    t: k.t ?? k.openTime,
    o: k.o ?? k.open,
    h: k.h ?? k.high,
    l: k.l ?? k.low,
    c: k.c ?? k.close,
    v: k.v ?? k.volume ?? 0,
  };
}

function toBotNewCandle(k) {
  const t = k.t ?? k.openTime;
  const o = k.o ?? k.open;
  const h = k.h ?? k.high;
  const l = k.l ?? k.low;
  const c = k.c ?? k.close;
  const v = k.v ?? k.volume ?? 0;
  return {
    t, o, h, l, c, v,
    openTime: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  };
}

function loadW1DiskCache() {
  try {
    if (!fs.existsSync(W1_CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(W1_CACHE_FILE, 'utf8'));
    const items = raw.items || raw;
    if (!items || typeof items !== 'object') return;
    for (const [sym, item] of Object.entries(items)) {
      if (_w1Cache.size >= W1_RAM_MAX_COINS) break;
      if (item && Array.isArray(item.candles) && item.candles.length > 0) {
        const compact = item.candles.slice(-W1_MAX_KEEP).map(toCompactW1);
        _w1Cache.set(sym, {
          candles: compact,
          cursor: compact[compact.length - 1].t,
        });
      }
    }
  } catch (_) {}
}

loadW1DiskCache();

let _w1SaveTimeout = null;
function scheduleSaveW1DiskCache() {
  if (_w1SaveTimeout) return;
  _w1SaveTimeout = setTimeout(() => {
    _w1SaveTimeout = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const prunedItems = {};
      for (const [sym, item] of _w1Cache.entries()) {
        if (item && Array.isArray(item.candles) && item.candles.length > 0) {
          const sliced = item.candles.slice(-W1_MAX_KEEP);
          prunedItems[sym] = {
            candles: sliced,
            cursor: sliced[sliced.length - 1].t,
          };
        }
      }
      fs.writeFileSync(W1_CACHE_FILE, JSON.stringify({ items: prunedItems }), 'utf8');
    } catch (_) {}
  }, 1500);
  if (typeof _w1SaveTimeout.unref === 'function') _w1SaveTimeout.unref();
}

function setW1CacheBounded(sym, entry) {
  if (_w1Cache.has(sym)) _w1Cache.delete(sym);
  while (_w1Cache.size >= W1_RAM_MAX_COINS) {
    const oldest = _w1Cache.keys().next().value;
    if (!oldest) break;
    _w1Cache.delete(oldest);
  }
  _w1Cache.set(sym, entry);
}

function floorToInterval(tsMs, intervalMs, interval = '') {
  if (interval === '1w') {
    // Nến 1w của Binance mở vào Thứ Hai 00:00 UTC (epoch 1970-01-01 là Thứ Năm -> dịch +3 ngày về Thứ Hai)
    const MONDAY_OFFSET_MS = 3 * 24 * 60 * 60 * 1000;
    return Math.floor((tsMs + MONDAY_OFFSET_MS) / intervalMs) * intervalMs - MONDAY_OFFSET_MS;
  }
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

// ─── Klines trực tiếp: Binance Futures trước, OKX fallback ───────────────────

async function fetchKlinesDirect(symbol, interval, limit, startTimeMs = null) {
  const bnInterval = interval.toLowerCase();
  const cleanSym = symbol.replace(/USDT$/, '');

  // 1. Binance Futures klines (ưu tiên nếu IP không bị hạ nhiệt/khóa)
  if (!isIpBanned()) {
    try {
      const params = { symbol: `${cleanSym}USDT`, interval: bnInterval, limit: Math.min(limit, 1500) };
      if (startTimeMs != null) params.startTime = startTimeMs;
      const { data } = await axios.get(`${BINANCE}/fapi/v1/klines`, {
        params,
        headers: HEADERS,
        timeout: 12000,
      });
      if (Array.isArray(data) && data.length > 0) {
        return data.map(k => toBotNewCandle({
          t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
          l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
        }));
      }
    } catch { /* fall through to OKX */ }
  }

  // 2. OKX fallback
  try {
    const params = { instId: `${cleanSym}-USDT-SWAP`, bar: BAR_MAP[interval] || interval, limit: Math.min(limit, 300) };
    if (startTimeMs != null) params.after = startTimeMs;
    const { data } = await axios.get(`${OKX}/api/v5/market/candles`, {
      params,
      headers: HEADERS,
      timeout: 12000,
    });
    return (data.data ?? []).reverse().map(k => toBotNewCandle({
      t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
    }));
  } catch {
    return [];
  }
}

// ─── Klines thông minh: Dùng chung trực tiếp candleCache (1h/4h/1d) + W1 nhẹ ──

async function getKlines(symbol, interval, limit) {
  const bnInterval = interval.toLowerCase();
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');

  // 1h / 4h / 1d: Đọc trực tiếp từ candleCache.js (0 bản sao RAM trùng lặp, tái sử dụng đĩa nóng bot-h4)
  if (bnInterval === '1h' || bnInterval === '4h' || bnInterval === '1d') {
    let shared = null;
    if (bnInterval === '1h') shared = await fetchH1Historical(cleanSym).catch(() => null);
    else if (bnInterval === '4h') shared = await fetchH4Historical(cleanSym).catch(() => null);
    else shared = await fetchD1Historical(cleanSym).catch(() => null);

    if (Array.isArray(shared) && shared.length > 0) {
      return shared.slice(-limit).map(toBotNewCandle);
    }
    return fetchKlinesDirect(cleanSym, bnInterval, limit);
  }

  if (bnInterval !== '1w') {
    return fetchKlinesDirect(cleanSym, bnInterval, limit);
  }

  // Khung 1w (52 nến, siêu nhẹ): cache LRU 80 coin
  const currentIntervalStart = floorToInterval(Date.now(), W1_INTERVAL_MS, '1w');
  const cached = _w1Cache.get(cleanSym);

  if (!cached || !Array.isArray(cached.candles) || cached.candles.length === 0) {
    const raw = await fetchKlinesDirect(cleanSym, '1w', Math.max(limit, W1_MAX_KEEP));
    if (raw && raw.length > 0) {
      const closed = raw.filter(c => c.t < currentIntervalStart).map(toCompactW1).slice(-W1_MAX_KEEP);
      if (closed.length > 0) {
        setW1CacheBounded(cleanSym, { candles: closed, cursor: closed[closed.length - 1].t });
        scheduleSaveW1DiskCache();
      }
      return raw.slice(-limit);
    }
    return raw || [];
  }

  const candles = cached.candles;
  const lastTime = candles[candles.length - 1].t;
  if (lastTime + W1_INTERVAL_MS >= currentIntervalStart) {
    return candles.slice(-limit).map(toBotNewCandle);
  }

  const missingFrom = lastTime + W1_INTERVAL_MS;
  const missingCount = Math.max(1, Math.ceil((currentIntervalStart - missingFrom) / W1_INTERVAL_MS));
  try {
    const missingBatch = await fetchKlinesDirect(cleanSym, '1w', Math.min(W1_MAX_KEEP, missingCount + 3), missingCount >= W1_MAX_KEEP ? null : missingFrom);
    if (missingBatch && missingBatch.length > 0) {
      const closedNew = missingBatch.filter(c => c.t < currentIntervalStart && c.t > lastTime).map(toCompactW1);
      if (closedNew.length > 0) {
        const merged = [...candles, ...closedNew].slice(-W1_MAX_KEEP);
        setW1CacheBounded(cleanSym, { candles: merged, cursor: merged[merged.length - 1].t });
        scheduleSaveW1DiskCache();
        return merged.slice(-limit).map(toBotNewCandle);
      }
    }
  } catch (_) {}

  return candles.slice(-limit).map(toBotNewCandle);
}

const _oiCache = new Map();
const _lsCache = new Map();
const _fullTaCache = new Map();
const TA_MEM_TTL_MS = 5 * 60 * 1000; // 5 phút RAM cache chống gọi lặp Binance
const TA_MEM_MAX_SIZE = 80;          // Tối đa 80 coin nóng trong RAM

function setBoundedCache(map, key, data, maxSize = TA_MEM_MAX_SIZE) {
  const now = Date.now();
  if (map.has(key)) map.delete(key);
  if (map.size >= maxSize) {
    for (const [k, v] of map.entries()) {
      if (now - v.ts >= TA_MEM_TTL_MS) map.delete(k);
    }
    while (map.size >= maxSize) {
      const oldest = map.keys().next().value;
      if (!oldest) break;
      map.delete(oldest);
    }
  }
  map.set(key, { ts: now, data });
}

// Dọn rác RAM định kỳ mỗi 10 phút (.unref() để không giữ tiến trình test/CLI)
const _taPruneTimer = setInterval(() => {
  const now = Date.now();
  for (const m of [_oiCache, _lsCache, _fullTaCache]) {
    for (const [k, v] of m.entries()) {
      if (now - v.ts >= TA_MEM_TTL_MS * 2) m.delete(k);
    }
  }
}, 10 * 60 * 1000);
if (typeof _taPruneTimer.unref === 'function') _taPruneTimer.unref();

async function getOI(symbol) {
  const cached = _oiCache.get(symbol);
  if (cached && (Date.now() - cached.ts < TA_MEM_TTL_MS)) return cached.data;

  // 1. Binance primary (bỏ qua nếu IP đang hạ nhiệt/khóa)
  if (!isIpBanned()) {
    try {
      const [oiRes, priceRes, histRes] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/openInterest`, {
          params: { symbol: `${symbol}USDT` }, timeout: 8000,
        }),
        axios.get(`${BINANCE}/fapi/v1/premiumIndex`, {
          params: { symbol: `${symbol}USDT` }, timeout: 8000,
        }),
        axios.get(`${BINANCE}/futures/data/openInterestHist`, {
          params: { symbol: `${symbol}USDT`, period: '1h', limit: 25 }, timeout: 6000,
        }).catch(() => null),
      ]);
      const oi    = parseFloat(oiRes.data?.openInterest);
      const price = parseFloat(priceRes.data?.markPrice);
      let change24h = null;
      const hist = Array.isArray(histRes?.data) ? histRes.data : [];
      if (hist.length >= 2) {
        const firstOi = parseFloat(hist[0]?.sumOpenInterestValue || hist[0]?.sumOpenInterest || 0);
        const lastOi  = parseFloat(hist[hist.length - 1]?.sumOpenInterestValue || hist[hist.length - 1]?.sumOpenInterest || 0);
        if (firstOi > 0 && lastOi > 0) {
          change24h = parseFloat(((lastOi - firstOi) / firstOi * 100).toFixed(2));
        }
      }
      if (oi && price) {
        const result = { valueMil: oi * price / 1e6, change24h };
        setBoundedCache(_oiCache, symbol, result);
        return result;
      }
    } catch { /* fall through to OKX */ }
  }

  // 2. OKX fallback
  try {
    const { data } = await axios.get(`${OKX}/api/v5/public/open-interest`, {
      params: { instType: 'SWAP', instId: `${symbol}-USDT-SWAP` },
      headers: HEADERS, timeout: 8000,
    });
    const oiUsd = parseFloat(data.data?.[0]?.oiUsd);
    if (!oiUsd) return null;
    const result = { valueMil: oiUsd / 1e6, change24h: null };
    setBoundedCache(_oiCache, symbol, result);
    return result;
  } catch { return null; }
}

async function getLongShort(symbol) {
  const cached = _lsCache.get(symbol);
  if (cached && (Date.now() - cached.ts < TA_MEM_TTL_MS)) return cached.data;

  // 1. Binance primary (bỏ qua nếu IP đang hạ nhiệt/khóa)
  if (!isIpBanned()) {
    try {
      const { data } = await axios.get(`${BINANCE}/futures/data/globalLongShortAccountRatio`, {
        params: { symbol: `${symbol}USDT`, period: '1h', limit: 1 },
        timeout: 8000,
      });
      const d = data?.[0];
      if (d) {
        const longPct  = parseFloat(d.longAccount)  * 100;
        const shortPct = parseFloat(d.shortAccount) * 100;
        const ratio    = parseFloat(d.longShortRatio);
        if (!isNaN(longPct) && !isNaN(shortPct)) {
          const result = { longPct, shortPct, ratio };
          setBoundedCache(_lsCache, symbol, result);
          return result;
        }
      }
    } catch { /* fall through to OKX */ }
  }

  // 2. OKX fallback
  try {
    const { data } = await axios.get(`${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio`, {
      params: { ccy: symbol, period: '1H', limit: 1 },
      headers: HEADERS, timeout: 8000,
    });
    const d = data.data?.[0];
    if (!d) return null;
    const ratio = parseFloat(d[1]);
    if (isNaN(ratio) || ratio <= 0) return null;
    const longPct  = ratio / (1 + ratio) * 100;
    const shortPct = 100 - longPct;
    const result = { longPct, shortPct, ratio };
    setBoundedCache(_lsCache, symbol, result);
    return result;
  } catch { return null; }
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
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
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const k12 = 2/13, k26 = 2/27, k9 = 2/10;
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b) / 26;
  for (let i = 12; i < 26; i++) e12 = closes[i] * k12 + e12 * (1 - k12);

  const macdLine = [], sigLine = [];
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    macdLine.push(e12 - e26);
  }
  if (macdLine.length < 9) return null;

  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b) / 9;
  sigLine.push(sig);
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
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2) / period);
  const curr  = closes[closes.length - 1];
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  return {
    upper, middle: mean, lower,
    bandwidth: mult * 2 * std / mean * 100,
    pctB: (curr - lower) / (upper - lower) * 100,
  };
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = klines.slice(1).map((k, i) => Math.max(
    k.h - k.l,
    Math.abs(k.h - klines[i].c),
    Math.abs(k.l - klines[i].c)
  ));
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3) {
  if (closes.length < rsiPeriod + stochPeriod + kPeriod) return null;
  // Build RSI series
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

// Cluster-based S/R: gom các pivot trong vùng ±0.5% thành cụm,
// sort theo số lần test (touch count) → mức nào bị test nhiều = mạnh nhất
function clusterSR(klines, lookback = 90, tolerance = 0.005) {
  const recent = klines.slice(-lookback);
  if (recent.length < 8) return { support: [], resistance: [], supportTouches: [], resistanceTouches: [] };
  const price = recent[recent.length - 1].c;

  // Thu thập tất cả swing high/low (3 nến mỗi bên → chặt hơn, ít noise hơn)
  const pivots = [];
  for (let i = 3; i < recent.length - 3; i++) {
    const h = recent[i].h, l = recent[i].l;
    if (h > recent[i-1].h && h > recent[i-2].h && h > recent[i-3].h &&
        h > recent[i+1].h && h > recent[i+2].h && h > recent[i+3].h) pivots.push(h);
    if (l < recent[i-1].l && l < recent[i-2].l && l < recent[i-3].l &&
        l < recent[i+1].l && l < recent[i+2].l && l < recent[i+3].l) pivots.push(l);
  }
  if (!pivots.length) return { support: [], resistance: [], supportTouches: [], resistanceTouches: [] };

  // Cluster các pivot gần nhau (±tolerance)
  const sorted = [...pivots].sort((a, b) => a - b);
  const clusters = [];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const mid = cluster.reduce((a, b) => a + b) / cluster.length;
    if (Math.abs(sorted[i] - mid) / mid <= tolerance) {
      cluster.push(sorted[i]);
    } else {
      clusters.push(cluster);
      cluster = [sorted[i]];
    }
  }
  clusters.push(cluster);

  // Mỗi cluster → centroid + touch count
  const levels = clusters.map(c => ({
    price: c.reduce((a, b) => a + b) / c.length,
    touches: c.length,
  }));

  // Resistance: trên giá hiện tại, ưu tiên gần nhất
  const resistance = levels
    .filter(l => l.price > price * 1.001)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  // Support: dưới giá hiện tại, ưu tiên gần nhất
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
  if (!klines.length) return { ratio: 1, label: 'bình thường' };
  const curr = klines[klines.length - 1].v;
  const avg  = klines.slice(-period).map(k => k.v).reduce((a, b) => a + b) / period;
  const ratio = curr / avg;
  return {
    ratio,
    label: ratio > 2.5 ? 'SPIKE RẤT CAO' : ratio > 1.5 ? 'cao' :
           ratio < 0.5 ? 'RẤT THẤP'      : ratio < 0.8 ? 'thấp' : 'bình thường',
  };
}

function detectCandlePattern(klines) {
  const n = klines.length - 1;
  const k  = klines[n], p = klines[n - 1], p2 = klines[n - 2];
  const body    = Math.abs(k.c - k.o);
  const range   = k.h - k.l;
  const upwick  = k.h - Math.max(k.o, k.c);
  const downwick = Math.min(k.o, k.c) - k.l;
  const patterns = [];

  // Doji
  if (body < range * 0.1) patterns.push('DOJI (do dự)');
  // Hammer
  if (downwick > body * 2 && upwick < body * 0.5 && k.c > k.o) patterns.push('HAMMER (đảo chiều tăng)');
  // Shooting star
  if (upwick > body * 2 && downwick < body * 0.5 && k.c < k.o) patterns.push('SHOOTING STAR (đảo chiều giảm)');
  // Engulfing bullish
  if (p.c < p.o && k.c > k.o && k.o < p.c && k.c > p.o) patterns.push('BULLISH ENGULFING');
  // Engulfing bearish
  if (p.c > p.o && k.c < k.o && k.o > p.c && k.c < p.o) patterns.push('BEARISH ENGULFING');
  // 3 white soldiers
  if (k.c > k.o && p.c > p.o && p2.c > p2.o && k.c > p.c && p.c > p2.c) patterns.push('3 WHITE SOLDIERS (tăng mạnh)');
  // 3 black crows
  if (k.c < k.o && p.c < p.o && p2.c < p2.o && k.c < p.c && p.c < p2.c) patterns.push('3 BLACK CROWS (giảm mạnh)');

  return patterns;
}

// ─── Market regime detection ─────────────────────────────────────────────────
// Dùng 10 nến 1D gần nhất để nhận biết xu hướng thị trường:
// TRENDING_UP   : ≥5/9 nến có HH+HL (higher high & higher low)
// TRENDING_DOWN : ≥5/9 nến có LH+LL (lower high & lower low)
// VOLATILE      : BB Bandwidth 4h > 12% (biến động mạnh, rủi ro cao)
// RANGING       : còn lại (dao động ngang)

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

// ─── Full TA for one symbol ───────────────────────────────────────────────────

/**
 * Pure TA calculation from pre-fetched klines (synchronous).
 * Used by both getFullTA() (live) and backtest scripts.
 * Returns identical object to getFullTA() but with oi/ls = null.
 */
function calcTAFromKlines(symbol, k1h, k4h, k1d, k1w) {
  if (!k4h || k4h.length === 0) return null;

  const c4h = k4h.map(k => k.c);
  const c1h = k1h?.map(k => k.c);
  const c1d = k1d?.map(k => k.c);
  const price = c4h[c4h.length - 1];

  // EMAs (4h + daily 200 + 1h cho Ma trận Trend 3 Tầng D1-H4-H1)
  const ema7    = calcEMA(c4h, 7);
  const ema25   = calcEMA(c4h, 25);
  const ema99   = calcEMA(c4h, 99);
  const ema200d = c1d ? calcEMA(c1d, 200) : null;
  const ema7_1h  = c1h ? calcEMA(c1h, 7) : null;
  const ema25_1h = c1h ? calcEMA(c1h, 25) : null;
  const lastK1h  = (k1h && k1h.length > 0) ? k1h[k1h.length - 1] : null;
  const candleH1 = lastK1h ? { openTime: lastK1h.t, open: lastK1h.o, high: lastK1h.h, low: lastK1h.l, close: lastK1h.c, volume: lastK1h.v } : null;

  // Trend
  let trend = 'SIDEWAY';
  if (ema7 && ema25) {
    if (price > ema7 && ema7 > ema25 && (!ema99 || ema25 > ema99)) trend = 'TĂNG MẠNH';
    else if (price > ema7 && ema7 > ema25) trend = 'TĂNG';
    else if (price < ema7 && ema7 < ema25 && (!ema99 || ema25 < ema99)) trend = 'GIẢM MẠNH';
    else if (price < ema7 && ema7 < ema25) trend = 'GIẢM';
  }
  const aboveEMA200 = ema200d != null ? price > ema200d : null;

  // RSI
  const rsi4h = calcRSI(c4h, 14);
  const rsi1h = c1h ? calcRSI(c1h, 14) : null;
  const rsi1d = c1d ? calcRSI(c1d, 14) : null;
  const rsiSignal = rsi4h == null ? null :
    rsi4h >= 75 ? 'OVERBOUGHT NẶNG' : rsi4h >= 65 ? 'OVERBOUGHT' :
    rsi4h <= 25 ? 'OVERSOLD NẶNG'   : rsi4h <= 35 ? 'OVERSOLD'   : 'TRUNG TÍNH';

  // MACD, BB, ATR, StochRSI
  const macd4h   = calcMACD(c4h);
  const bb4h     = calcBB(c4h, 20, 2);
  const atr4h    = calcATR(k4h, 14);
  const stochRSI = c4h.length >= 60 ? calcStochRSI(c4h, 14, 14, 3) : null;

  // S&R: cluster-based 1D (90 nến = ~3 tháng), sort theo touch count
  const { support, resistance, supportTouches, resistanceTouches } =
    k1d ? clusterSR(k1d, 90) : clusterSR(k4h, 60);

  // S&R: cluster-based 4H (60 nến = ~10 ngày) — mức thực chiến ngắn hạn
  const { support: support4h, resistance: resistance4h,
          supportTouches: support4hTouches, resistanceTouches: resistance4hTouches } =
    clusterSR(k4h, 60, 0.003);

  // Weekly pivot: high/low của tuần hoàn chỉnh gần nhất
  let weeklyPivot = null;
  if (k1w && k1w.length >= 2) {
    const pw = k1w[k1w.length - 2];
    weeklyPivot = { high: pw.h, low: pw.l };
  }

  const regime      = detectRegime(k1d, bb4h);
  const vol         = analyzeVolume(k4h, 20);
  const patterns    = k4h.length >= 5 ? detectCandlePattern(k4h) : [];
  const priceChange4h = c4h.length >= 2
    ? (price - c4h[c4h.length - 2]) / c4h[c4h.length - 2] * 100 : null;

  return {
    symbol, price, trend, aboveEMA200, priceChange4h,
    rsi: { '1h': rsi1h, '4h': rsi4h, '1d': rsi1d },
    rsiSignal,
    ema: { e7: ema7, e25: ema25, e99: ema99, e200d: ema200d },
    ema1h: { e7: ema7_1h, e25: ema25_1h },
    candleH1,
    macd: macd4h,
    bb: bb4h,
    atr: atr4h,
    atrPct: atr4h ? atr4h / price * 100 : null,
    stochRSI,
    support, resistance, supportTouches, resistanceTouches,
    support4h, resistance4h, support4hTouches, resistance4hTouches,
    weeklyPivot, regime,
    volume: vol, patterns,
    oi: null, ls: null, topLS: null,
  };
}

async function getFullTA(symbol) {
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  const cached = _fullTaCache.get(cleanSym);
  if (cached && (Date.now() - cached.ts < TA_MEM_TTL_MS)) {
    return cached.data;
  }

  const [k1h, k4h, k1d, k1w] = await Promise.all([
    getKlines(cleanSym, '1h', 100).catch(() => null),
    getKlines(cleanSym, '4h', 200).catch(() => null),
    getKlines(cleanSym, '1d', 220).catch(() => null),
    getKlines(cleanSym, '1w', 52).catch(() => null),
  ]);
  const ta = calcTAFromKlines(cleanSym, k1h, k4h, k1d, k1w);
  if (!ta) return null;

  // OKX/Binance supplementary data (cached 5p, fail gracefully)
  const [oi, ls] = await Promise.all([
    getOI(cleanSym).catch(() => null),
    getLongShort(cleanSym).catch(() => null),
  ]);
  ta.oi    = oi;
  ta.ls    = ls;
  ta.topLS = null;

  setBoundedCache(_fullTaCache, cleanSym, ta);
  return ta;
}

// ─── Batch (Giãn cách từng nhóm 4 coin để không gây tăng vọt IP Weight) ──────

async function getTAReport(symbols) {
  const { log } = require('../services/logger');
  const report = {};
  const BATCH_SIZE = 4;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    if (isIpBanned()) break;
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async sym => {
      try {
        const ta = await getFullTA(sym);
        if (ta) report[sym] = ta;
      } catch (e) {
        log.warn(`TA[${sym}] lỗi`, { error: e.message });
      }
    }));
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return report;
}

module.exports = { getTAReport, getFullTA, calcTAFromKlines, STABLECOINS, detectRegime, clusterSR };
