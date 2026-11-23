'use strict';

/**
 * candleCache.js — Bộ nhớ đệm nến sâu đa khung thời gian (H1, H4, D1) cho bot-new.
 *
 * Tái sử dụng 100% bộ nhớ đệm trên đĩa của bot-h4 (data/*_history_cache.json)
 * - Tốc độ nạp vào RAM: 0ms
 * - Tiêu thụ REST API weight Binance: 0 weight
 * - Tự động bổ sung qua Binance Futures REST API nếu gặp coin mới chưa có trong cache
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('./logger');
const { isIpBanned } = require('./rateLimitGuard');

const CACHE_MAX_H1 = 300; // 300 nến H1 ≈ 12.5 ngày
const CACHE_MAX_H4 = 300; // 300 nến H4 ≈ 50 ngày
const CACHE_MAX_D1 = 180; // 180 nến D1 ≈ 6 tháng

// Tìm đường dẫn thư mục data dùng chung
function resolveSharedDataDir() {
  const candidates = [
    path.resolve(process.cwd(), 'data'),
    path.resolve(__dirname, '../../../data'),
    path.resolve(__dirname, '../../data')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'h1_history_cache.json'))) {
      return dir;
    }
  }
  return candidates[0];
}

const SHARED_DATA_DIR = resolveSharedDataDir();
const HIST_CACHE_FILE_H1 = path.join(SHARED_DATA_DIR, 'h1_history_cache.json');
const HIST_CACHE_FILE_H4 = path.join(SHARED_DATA_DIR, 'h4_history_cache.json');
const HIST_CACHE_FILE_D1 = path.join(SHARED_DATA_DIR, 'd1_history_cache.json');

const _h1HistCache = {};
const _h4HistCache = {};
const _d1HistCache = {};

function loadDiskCache(filePath, maxCount, targetCache) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return;
    const items = data.items || data;
    for (const [sym, val] of Object.entries(items)) {
      if (!val) continue;
      const candles = Array.isArray(val) ? val : (Array.isArray(val.candles) ? val.candles : []);
      if (candles.length > 0) {
        targetCache[sym] = {
          yearStart: val.yearStart || 0,
          candles: candles.slice(-maxCount),
          cursor: val.cursor || (candles[candles.length - 1].openTime + 60000)
        };
      }
    }
  } catch (err) {
    log.warn(`[CandleCache] Lỗi nạp cache từ ${path.basename(filePath)}: ${err.message}`);
  }
}

// Nạp cache ban đầu từ đĩa
loadDiskCache(HIST_CACHE_FILE_H1, CACHE_MAX_H1, _h1HistCache);
loadDiskCache(HIST_CACHE_FILE_H4, CACHE_MAX_H4, _h4HistCache);
loadDiskCache(HIST_CACHE_FILE_D1, CACHE_MAX_D1, _d1HistCache);

log.system(`[PP369] [369] ✓ Đã nạp cache nến từ đĩa máy chủ: ${Object.keys(_h1HistCache).length} coin H1, ${Object.keys(_h4HistCache).length} coin H4, ${Object.keys(_d1HistCache).length} coin D1.`);

/**
 * Fetch klines từ Binance Futures REST API
 */
async function fetchBinanceKlines(symbol, interval, startTimeMs = null, limit = 500) {
  if (isIpBanned()) return [];
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const params = { symbol: `${cleanSym}USDT`, interval, limit };
  if (startTimeMs != null) params.startTime = startTimeMs;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (isIpBanned()) return [];
      const res = await axios.get(url, { params, timeout: 10000 });
      return (res.data || []).map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
        takerBuyBaseVolume: parseFloat(c[9] || 0)
      }));
    } catch (err) {
      if (attempt === 2) {
        log.warn(`[CandleCache] Không thể tải nến Binance ${cleanSym} [${interval}]: ${err.message}`);
        return [];
      }
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

// Tự động lưu cache ra đĩa (debounce 1.5s) để coin mới chỉ phải tải từ Binance ĐÚNG 1 LẦN
const _saveTimers = {};
function scheduleSaveDiskCache(key, filePath, maxCount, sourceMap) {
  if (_saveTimers[key]) return;
  _saveTimers[key] = setTimeout(() => {
    _saveTimers[key] = null;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const items = {};
      for (const [sym, val] of Object.entries(sourceMap)) {
        if (val && Array.isArray(val.candles) && val.candles.length > 0) {
          items[sym] = {
            yearStart: val.yearStart || 0,
            candles: val.candles.slice(-maxCount),
            cursor: val.candles[val.candles.length - 1].openTime,
          };
        }
      }
      fs.writeFileSync(filePath, JSON.stringify({ items }), 'utf8');
    } catch (err) {
      log.warn(`[CandleCache] Lỗi ghi ${path.basename(filePath)}: ${err.message}`);
    }
  }, 1500);
}

async function fetchH1Historical(symbol) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  if (_h1HistCache[cleanSym]?.candles?.length >= 15) {
    return _h1HistCache[cleanSym].candles;
  }
  const raw = await fetchBinanceKlines(cleanSym, '1h', null, CACHE_MAX_H1);
  if (raw && raw.length > 0) {
    _h1HistCache[cleanSym] = { candles: raw.slice(-CACHE_MAX_H1) };
    scheduleSaveDiskCache('H1', HIST_CACHE_FILE_H1, CACHE_MAX_H1, _h1HistCache);
    return _h1HistCache[cleanSym].candles;
  }
  return [];
}

async function fetchH4Historical(symbol) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  if (_h4HistCache[cleanSym]?.candles?.length >= 15) {
    return _h4HistCache[cleanSym].candles;
  }
  const raw = await fetchBinanceKlines(cleanSym, '4h', null, CACHE_MAX_H4);
  if (raw && raw.length > 0) {
    _h4HistCache[cleanSym] = { candles: raw.slice(-CACHE_MAX_H4) };
    scheduleSaveDiskCache('H4', HIST_CACHE_FILE_H4, CACHE_MAX_H4, _h4HistCache);
    return _h4HistCache[cleanSym].candles;
  }
  return [];
}

async function fetchD1Historical(symbol) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  if (_d1HistCache[cleanSym]?.candles?.length >= 10) {
    return _d1HistCache[cleanSym].candles;
  }
  const raw = await fetchBinanceKlines(cleanSym, '1d', null, CACHE_MAX_D1);
  if (raw && raw.length > 0) {
    _d1HistCache[cleanSym] = { candles: raw.slice(-CACHE_MAX_D1) };
    scheduleSaveDiskCache('D1', HIST_CACHE_FILE_D1, CACHE_MAX_D1, _d1HistCache);
    return _d1HistCache[cleanSym].candles;
  }
  return [];
}

/**
 * Tính ATR (Average True Range)
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const trVal = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    tr.push(trVal);
  }
  if (tr.length < period) return null;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/**
 * Tìm các đỉnh/đáy xoay chiều (Swing Points)
 */
function findSwingPoints(candles, leftStrength = 3, rightStrength = 3) {
  const highs = [];
  const lows = [];
  if (!candles || candles.length < leftStrength + rightStrength + 1) {
    return { highs, lows };
  }

  for (let i = leftStrength; i < candles.length - rightStrength; i++) {
    const c = candles[i];

    let isHigh = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].high > c.high) { isHigh = false; break; }
      }
    }
    if (isHigh) highs.push(c.high);

    let isLow = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].low < c.low) { isLow = false; break; }
      }
    }
    if (isLow) lows.push(c.low);
  }

  return { highs, lows };
}

module.exports = {
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  fetchBinanceKlines,
  calculateATR,
  findSwingPoints,
  SHARED_DATA_DIR,
  _h1HistCache,
  _h4HistCache,
  _d1HistCache
};
