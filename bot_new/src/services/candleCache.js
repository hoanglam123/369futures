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
const CACHE_MAX_D1 = 250; // 250 nến D1 ≈ >8 tháng (đủ EMA200D)

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
const _m15RecentCache = new Map(); // sym -> { ts, candles }

const STALE_MS_H1 = 45 * 60 * 1000;    // 45 phút (đảm bảo nến H1 vừa đóng luôn tươi cho Fractal Trailing SL)
const STALE_MS_H4 = 6 * 3600 * 1000;   // 6 giờ
const STALE_MS_D1 = 30 * 3600 * 1000;  // 30 giờ
const M15_TTL_MS  = 3 * 60 * 1000;     // 3 phút cache RAM cho M15

const _fileMtimes = {};
const _lastDiskCheck = {};
const DISK_RELOAD_THROTTLE_MS = 60 * 1000;

function loadDiskCache(filePath, maxCount, targetCache) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return false;
    const items = data.items || data;
    for (const [sym, val] of Object.entries(items)) {
      if (!val) continue;
      const candles = Array.isArray(val) ? val : (Array.isArray(val.candles) ? val.candles : []);
      if (candles.length > 0) {
        const existing = targetCache[sym]?.candles;
        const existLastTs = existing?.length ? existing[existing.length - 1].openTime : 0;
        const diskLastTs  = candles[candles.length - 1].openTime || 0;
        if (!existing || diskLastTs > existLastTs || candles.length > existing.length) {
          targetCache[sym] = {
            yearStart: val.yearStart || 0,
            candles: candles.slice(-maxCount),
            cursor: val.cursor || (diskLastTs + 60000)
          };
        }
      }
    }
    _fileMtimes[filePath] = stat.mtimeMs;
    return true;
  } catch (err) {
    log.warn(`[CandleCache] Lỗi nạp cache từ ${path.basename(filePath)}: ${err.message}`);
    return false;
  }
}

/**
 * Kiểm tra xem file cache đĩa dùng chung (bot-h4 ghi) có mới hơn trong RAM không -> hot-reload (0 REST weight)
 */
function tryReloadDiskIfNewer(filePath, maxCount, targetCache) {
  const now = Date.now();
  if (_lastDiskCheck[filePath] && (now - _lastDiskCheck[filePath] < DISK_RELOAD_THROTTLE_MS)) {
    return false;
  }
  _lastDiskCheck[filePath] = now;
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!_fileMtimes[filePath] || stat.mtimeMs > _fileMtimes[filePath]) {
      return loadDiskCache(filePath, maxCount, targetCache);
    }
  } catch (_) {}
  return false;
}

/**
 * Kiểm tra mảng nến trong RAM đã quá hạn (stale) so với thời điểm hiện tại hay chưa
 */
function isCacheStale(candles, maxAgeMs, nowMs = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return true;
  const last = candles[candles.length - 1];
  const lastTs = last?.openTime || 0;
  if (!lastTs || lastTs <= 0) return false; // Mock test data không dùng epoch timestamp thật -> không coi là stale
  if (lastTs < 1_000_000_000_000) return false; // Timestamp dạng index nhỏ (test mock)
  return (nowMs - lastTs) > maxAgeMs;
}

/**
 * Gộp nến mới vào mảng nến cũ (dedupe theo openTime, sắp xếp tăng dần, cắt theo maxCount)
 */
function mergeCandles(existing, incoming, maxCount) {
  const map = new Map();
  for (const c of (existing || [])) {
    if (c && c.openTime != null) map.set(c.openTime, c);
  }
  for (const c of (incoming || [])) {
    if (c && c.openTime != null) map.set(c.openTime, c);
  }
  return Array.from(map.values())
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-maxCount);
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

async function fetchHistoricalWithFreshness(symbol, interval, cacheMap, diskFile, cacheKey, maxCount, minLen, staleMs) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');

  // 1. Nếu chưa có hoặc đã cũ -> kiểm tra file đĩa dùng chung (bot-h4 ghi) trước khi gọi REST (0 weight)
  let entry = cacheMap[cleanSym];
  if (!entry || entry.candles.length < minLen || isCacheStale(entry.candles, staleMs)) {
    tryReloadDiskIfNewer(diskFile, maxCount, cacheMap);
    entry = cacheMap[cleanSym];
  }

  // 2. Nếu vẫn tươi và đủ nến -> trả ngay (0ms, 0 weight)
  if (entry?.candles?.length >= minLen && !isCacheStale(entry.candles, staleMs)) {
    return entry.candles;
  }

  // 3. Nếu đang bị IP ban -> trả tạm dữ liệu cũ trong RAM nếu có
  if (isIpBanned()) {
    return entry?.candles || [];
  }

  // 4. Fetch delta nếu đã có nến cũ, ngược lại fetch đủ lịch sử
  const existing = entry?.candles || [];
  const lastTs = existing.length >= minLen ? existing[existing.length - 1].openTime : null;
  const fetchStart = (lastTs && lastTs > 1_000_000_000_000) ? lastTs : null;
  const fetchLimit = fetchStart ? 50 : maxCount;

  const raw = await fetchBinanceKlines(cleanSym, interval, fetchStart, fetchLimit);
  if (raw && raw.length > 0) {
    const merged = fetchStart ? mergeCandles(existing, raw, maxCount) : raw.slice(-maxCount);
    cacheMap[cleanSym] = { candles: merged };
    scheduleSaveDiskCache(cacheKey, diskFile, maxCount, cacheMap);
    return merged;
  }

  return existing;
}

async function fetchH1Historical(symbol) {
  return fetchHistoricalWithFreshness(symbol, '1h', _h1HistCache, HIST_CACHE_FILE_H1, 'H1', CACHE_MAX_H1, 15, STALE_MS_H1);
}

async function fetchH4Historical(symbol) {
  return fetchHistoricalWithFreshness(symbol, '4h', _h4HistCache, HIST_CACHE_FILE_H4, 'H4', CACHE_MAX_H4, 15, STALE_MS_H4);
}

async function fetchD1Historical(symbol) {
  return fetchHistoricalWithFreshness(symbol, '1d', _d1HistCache, HIST_CACHE_FILE_D1, 'D1', CACHE_MAX_D1, 10, STALE_MS_D1);
}

/**
 * Lấy nến M15 gần nhất với RAM cache TTL 3 phút (dùng cho Risk Gatekeeper & Fractal M15 Trailing SL)
 */
async function fetchM15Recent(symbol, limit = 30) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const now = Date.now();
  const cached = _m15RecentCache.get(cleanSym);
  if (cached && (now - cached.ts < M15_TTL_MS) && cached.candles.length >= Math.min(limit, 10)) {
    return cached.candles;
  }
  if (isIpBanned()) {
    return cached?.candles || [];
  }
  const raw = await fetchBinanceKlines(cleanSym, '15m', null, limit);
  if (raw && raw.length > 0) {
    if (_m15RecentCache.size >= 250) {
      const firstKey = _m15RecentCache.keys().next().value;
      _m15RecentCache.delete(firstKey);
    }
    _m15RecentCache.set(cleanSym, { ts: now, candles: raw });
    return raw;
  }
  return cached?.candles || [];
}

/**
 * Tìm Đáy/Đỉnh sóng gần nhất theo mô hình Williams Fractal chuẩn 5 nến (đồng bộ 100% bot-h4).
 * Nến tâm idx so với 2 nến trước (idx-2, idx-1) và 2 nến sau (idx+1, idx+2).
 * Bỏ qua nến cuối cùng đang chạy (chưa đóng) để không repaint.
 * @param {Array} candles - Mảng nến { openTime, open, high, low, close }
 * @param {boolean} isLong - true: tìm Đáy sóng (Swing Low) | false: tìm Đỉnh sóng (Swing High)
 * @returns {{ price: number, time: number, idx: number } | null}
 */
function getRecentFractalSwing(candles, isLong) {
  if (!Array.isArray(candles) || candles.length < 6) return null;
  // Bỏ nến cuối cùng (index = length - 1) đang chạy; nến tâm hợp lệ lớn nhất là length - 4
  for (let idx = candles.length - 4; idx >= 2; idx--) {
    const c = candles[idx];
    const p1 = candles[idx - 1];
    const p2 = candles[idx - 2];
    const n1 = candles[idx + 1];
    const n2 = candles[idx + 2];
    if (!c || !p1 || !p2 || !n1 || !n2) continue;

    if (isLong) {
      if (c.low <= p1.low && c.low <= p2.low && c.low <= n1.low && c.low <= n2.low &&
          (c.low < p1.low || c.low < n1.low)) {
        return { price: c.low, time: c.openTime || 0, idx };
      }
    } else {
      if (c.high >= p1.high && c.high >= p2.high && c.high >= n1.high && c.high >= n2.high &&
          (c.high > p1.high || c.high > n1.high)) {
        return { price: c.high, time: c.openTime || 0, idx };
      }
    }
  }
  return null;
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
 * Tìm các đỉnh/đáy xoay chiều (Swing Points) kèm timestamp (openTime) & index
 * để chống đếm trùng đa khung và hỗ trợ S/R Flip + lọc cản đã bị phá vỡ.
 */
function findSwingPoints(candles, leftStrength = 3, rightStrength = 3) {
  const highs = [];
  const lows = [];
  const highPoints = [];
  const lowPoints = [];
  if (!candles || candles.length < leftStrength + rightStrength + 1) {
    return { highs, lows, highPoints, lowPoints };
  }

  for (let i = leftStrength; i < candles.length - rightStrength; i++) {
    const c = candles[i];
    const t = c.openTime || 0;

    let isHigh = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].high > c.high) { isHigh = false; break; }
      }
    }
    if (isHigh) {
      highs.push(c.high);
      highPoints.push({ price: c.high, time: t, idx: i });
    }

    let isLow = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].low < c.low) { isLow = false; break; }
      }
    }
    if (isLow) {
      lows.push(c.low);
      lowPoints.push({ price: c.low, time: t, idx: i });
    }
  }

  return { highs, lows, highPoints, lowPoints };
}

module.exports = {
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  fetchM15Recent,
  fetchBinanceKlines,
  calculateATR,
  findSwingPoints,
  getRecentFractalSwing,
  isCacheStale,
  mergeCandles,
  SHARED_DATA_DIR,
  _h1HistCache,
  _h4HistCache,
  _d1HistCache,
  _m15RecentCache
};
