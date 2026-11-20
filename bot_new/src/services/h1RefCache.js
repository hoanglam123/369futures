'use strict';

/**
 * h1RefCache.js — Quản lý và lưu trữ bền vững mốc nến H1 đầu tháng cho 400+ coin.
 *
 * Tính năng chính:
 * 1. Nạp và lưu đĩa data/h1_ref_cache.json (0ms khi restart bot).
 * 2. Tự động fetch song song (batch 15, delay 40ms) cho các coin chưa có cache.
 * 3. Pre-populate toàn bộ levelCache (_levelCache) cho PP369 trong 0ms.
 * 4. Tự động nhận diện thời điểm sang tháng mới:
 *    - Đợi nến H1 đầu tiên đóng lúc 01:00 UTC (08:00 VN ngày mùng 1).
 *    - Tự động làm mới cache và mốc cho toàn bộ 400+ coin.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('./logger');

// Thư mục lưu cache
function resolveDataDir() {
  const candidates = [
    path.resolve(process.cwd(), 'data'),
    path.resolve(__dirname, '../../../data'),
    path.resolve(__dirname, '../../data')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

const DATA_DIR = resolveDataDir();
const H1_REF_CACHE_FILE = path.join(DATA_DIR, 'h1_ref_cache.json');

const LEVELS_RANGE = 6;

function monthStartMs(date = new Date()) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function monthLabel(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function isH1CandleClosed(date = new Date()) {
  const startMs = monthStartMs(date);
  // Nến H1 đầu tháng đóng sau 1 giờ (3600000ms)
  return (date.getTime() - startMs) >= 3600000;
}

function getBaseUnit(price) {
  if (price >= 10000) return 1000;
  if (price >= 1000)  return 100;
  if (price >= 100)   return 10;
  if (price >= 10)    return 1;
  if (price >= 1)     return 0.1;
  if (price >= 0.2)   return 0.01;
  if (price >= 0.02)  return 0.001;
  if (price >= 0.002) return 0.0001;
  return 0.00001;
}

function getStep(price) {
  const unit = getBaseUnit(price);
  return Math.round(3 * unit * 1e8) / 1e8;
}

function getDecimals(price) {
  if (price >= 100)  return 2;
  if (price >= 10)   return 3;
  if (price >= 1)    return 4;
  if (price >= 0.2)  return 4;
  if (price >= 0.1)  return 5;
  if (price >= 0.02) return 5;
  if (price >= 0.01) return 6;
  return 8;
}

function buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange = LEVELS_RANGE) {
  const grid = [];
  for (let i = -levelsRange; i <= levelsRange; i++) {
    const offset = i * step;
    grid.push({
      value: parseFloat((upperPrice + offset).toFixed(decimals)),
      type:  'tren',
      tier:  i,
    });
    grid.push({
      value: parseFloat((lowerPrice + offset).toFixed(decimals)),
      type:  'duoi',
      tier:  i,
    });
  }
  grid.sort((a, b) => a.value - b.value || (a.type === 'tren' ? -1 : 1));
  return grid.filter((v, i, arr) =>
    i === 0 || !(v.value === arr[i - 1].value && v.type === arr[i - 1].type)
  );
}

// Bộ nhớ cache RAM
let _h1RefCache = {};
let _lastMonthProcessed = null;

function loadH1RefCache() {
  try {
    if (fs.existsSync(H1_REF_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(H1_REF_CACHE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        _h1RefCache = raw.items || raw;
        _lastMonthProcessed = raw.monthStart || null;
        return _h1RefCache;
      }
    }
  } catch (err) {
    log.warn(`[H1RefCache] Không đọc được cache file ${H1_REF_CACHE_FILE}: ${err.message}`);
  }
  _h1RefCache = {};
  return _h1RefCache;
}

function saveH1RefCache(monthStart) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const payload = {
      monthStart: monthStart || monthStartMs(),
      monthLabel: monthLabel(),
      updatedAt: new Date().toISOString(),
      count: Object.keys(_h1RefCache).length,
      items: _h1RefCache
    };
    fs.writeFileSync(H1_REF_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    log.warn(`[H1RefCache] Lỗi ghi file cache ${H1_REF_CACHE_FILE}: ${err.message}`);
  }
}

/**
 * Fetch 1 nến H1 đầu tháng từ Binance Futures
 */
async function fetchBinanceH1Candle(symbol, startTimeMs) {
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const params = { symbol: `${cleanSym}USDT`, interval: '1h', startTime: startTimeMs, limit: 1 };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, { params, timeout: 8000 });
      if (res.data && res.data.length > 0) {
        const c = res.data[0];
        return {
          openTime: c[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          closeTime: c[6],
        };
      }
      return null;
    } catch (err) {
      if (attempt === 2) return null;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * Khởi tạo và nạp cache nến H1 đầu tháng cho toàn bộ danh sách symbols
 */
async function initH1RefCache(symbols = [], forceRefresh = false) {
  loadH1RefCache();
  const currentMonthStart = monthStartMs();
  const isClosed = isH1CandleClosed();

  const missing = [];
  for (const sym of symbols) {
    const cached = _h1RefCache[sym];
    const isCurrent = cached && cached.monthStart === currentMonthStart;
    if (forceRefresh || !cached || !isCurrent || (!cached.isClosed && isClosed)) {
      missing.push(sym);
    }
  }

  if (missing.length === 0) {
    log.system(`[H1RefCache] ✓ Đã sẵn sàng mốc H1 đầu tháng cho ${symbols.length} coin (0 REST API calls).`);
    return _h1RefCache;
  }

  log.system(`[H1RefCache] Đang cập nhật mốc H1 đầu tháng cho ${missing.length}/${symbols.length} coin...`);

  // Xử lý song song theo batch 15 coin với delay nhỏ để giữ an toàn rate limit
  const BATCH_SIZE = 15;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async sym => {
      try {
        const candle = await fetchBinanceH1Candle(sym, currentMonthStart);
        if (candle) {
          const openPrice  = candle.open;
          const closePrice = candle.close;
          const step       = getStep(openPrice);
          const decimals   = getDecimals(openPrice);
          const upperPrice = Math.max(openPrice, closePrice);
          const lowerPrice = Math.min(openPrice, closePrice);

          _h1RefCache[sym] = {
            monthStart: currentMonthStart,
            monthLabel: monthLabel(),
            openPrice,
            closePrice,
            step,
            decimals,
            upperPrice,
            lowerPrice,
            candleOpenTime: candle.openTime,
            isClosed: isClosed || (Date.now() >= candle.closeTime),
          };
        }
      } catch (e) {
        log.warn(`[H1RefCache] Lỗi nạp nến H1 cho ${sym}: ${e.message}`);
      }
    }));

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, 40));
    }
  }

  saveH1RefCache(currentMonthStart);
  _lastMonthProcessed = currentMonthStart;
  log.system(`[H1RefCache] ✓ Hoàn tất nạp mốc H1 đầu tháng cho ${Object.keys(_h1RefCache).length} coin (đã lưu đĩa).`);
  return _h1RefCache;
}

/**
 * Pre-populate các mốc 369 (longEntry, shortEntry, step) cho levelCache
 */
function prePopulateLevelCache(symbols = [], priceMap = {}) {
  const { setLevelCacheEntry } = require('../pp369/core');
  let populatedCount = 0;

  for (const sym of symbols) {
    const entry = _h1RefCache[sym];
    if (!entry) continue;

    const livePrice = priceMap[sym]?.price || priceMap[sym] || entry.closePrice;
    if (!livePrice || isNaN(livePrice) || livePrice <= 0) continue;

    const effectiveStep = getStep(livePrice);
    const effectiveDecimals = getDecimals(livePrice);

    const distTicks = Math.ceil(Math.max(
      Math.abs(entry.upperPrice - livePrice),
      Math.abs(entry.lowerPrice - livePrice)
    ) / effectiveStep);
    const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);

    const grid = buildLevelGrid(entry.upperPrice, entry.lowerPrice, effectiveStep, effectiveDecimals, levelsRange);
    const longEntry = grid.filter(l => l.type === 'tren' && l.value <= livePrice).pop();
    const shortEntry = grid.find(l => l.type === 'duoi' && l.value > (longEntry ? longEntry.value : livePrice));

    if (longEntry && shortEntry) {
      if (typeof setLevelCacheEntry === 'function') {
        setLevelCacheEntry(sym, {
          longEntry: longEntry.value,
          shortEntry: shortEntry.value,
          step: effectiveStep
        });
      }
      populatedCount++;
    }
  }

  return populatedCount;
}

/**
 * Kiểm tra xem có chuyển sang tháng mới chưa.
 * Nếu đã sang tháng mới VÀ nến H1 đầu tiên đã đóng:
 * Tự động kích hoạt làm mới toàn bộ mốc và levelCache.
 */
async function checkMonthTransition(symbols = [], priceMap = {}) {
  const currentMonth = monthStartMs();
  if (_lastMonthProcessed && _lastMonthProcessed !== currentMonth) {
    if (isH1CandleClosed()) {
      log.system(`[H1RefCache] 🗓️ Phát hiện sang tháng mới (${monthLabel()})! Đang cập nhật lại toàn bộ mốc H1...`);
      await initH1RefCache(symbols, true);
      prePopulateLevelCache(symbols, priceMap);
      _lastMonthProcessed = currentMonth;
      log.system(`[H1RefCache] ✓ Đã chuyển giao mốc tháng mới thành công.`);
      return true;
    }
  }
  return false;
}

function getH1RefCache() {
  return _h1RefCache;
}

module.exports = {
  initH1RefCache,
  loadH1RefCache,
  saveH1RefCache,
  prePopulateLevelCache,
  checkMonthTransition,
  getH1RefCache,
  monthStartMs,
  monthLabel,
  isH1CandleClosed,
  getStep,
  getDecimals,
  buildLevelGrid
};
