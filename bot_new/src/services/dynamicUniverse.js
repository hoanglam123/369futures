'use strict';

/**
 * dynamicUniverse.js — Quản lý Vũ Trụ Thị Trường Động (Dynamic Futures Universe)
 *
 * - Quét toàn bộ 400+ cặp Binance Futures USDT-M đang active (status: TRADING)
 * - Độc lập hoàn toàn với mốc cứng đầu năm của bot-h4
 * - Lọc lưới bước giá chuẩn xác: 2.0% <= gridStepPct <= 30%
 * - Sắp xếp tiệm cận mốc (Proximity Filter <= 0.5%) và cắt Top 8 mã gần nhất
 */

const axios = require('axios');
const { getStep } = require('./tierSLTP');
const { log } = require('./logger');

const UNIVERSE_REFRESH_MS = 4 * 60 * 60 * 1000; // Tự động làm mới mỗi 4 giờ
const GRID_MIN_PCT = 2.0;  // 2.0%
const GRID_MAX_PCT = 30.0; // 30.0%

let _cachedUniverse = null;
let _lastUniverseFetchMs = 0;

/**
 * Lấy toàn bộ các cặp Binance Futures USDT-M Perpetual đang TRADING
 */
async function getAllActiveFuturesSymbols(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedUniverse && (now - _lastUniverseFetchMs < UNIVERSE_REFRESH_MS)) {
    return _cachedUniverse;
  }

  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      const rawSymbols = res.data?.symbols || [];
      const active = [];

      for (const s of rawSymbols) {
        if (
          s.status === 'TRADING' &&
          s.contractType === 'PERPETUAL' &&
          s.quoteAsset === 'USDT'
        ) {
          active.push(s.baseAsset);
        }
      }

      if (active.length > 0) {
        _cachedUniverse = active;
        _lastUniverseFetchMs = now;
        log.system(`[DynamicUniverse] ✓ Đã nạp ${active.length} cặp Binance Futures USDT-M active.`);
        return active;
      }
    } catch (err) {
      if (attempt === 2) {
        log.warn(`[DynamicUniverse] Lỗi nạp exchangeInfo: ${err.message}. Sử dụng danh sách cache hoặc fallback.`);
        return _cachedUniverse || ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'NEAR'];
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return _cachedUniverse || ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'NEAR'];
}

/**
 * Kiểm tra biên độ lưới mốc giá có nằm trong khoảng [2.0%, 30.0%] không
 */
function isGridWidthValid(price) {
  if (!price || price <= 0 || isNaN(price)) return false;
  const step = getStep(price);
  const gridStepPct = (step / price) * 100;
  return gridStepPct >= GRID_MIN_PCT && gridStepPct <= GRID_MAX_PCT;
}

/**
 * Lọc danh sách symbol hợp lệ theo biên độ lưới 2% - 30%
 */
function filterSymbolsByGrid(symbols, priceMap = {}) {
  return symbols.filter(sym => {
    const price = priceMap[sym]?.price || priceMap[sym];
    if (!price || typeof price !== 'number') return true; // Chưa có giá thì giữ lại (fail-open)
    return isGridWidthValid(price);
  });
}

/**
 * Proximity Filter: Sắp xếp theo khoảng cách tới mốc và chỉ lấy Top N mã sát mốc nhất (mặc định Top 8)
 * @param {string[]} symbols
 * @param {Object} levelCache - { SYM: { longEntry, shortEntry } }
 * @param {Object} priceMap - { SYM: price } hoặc hàm lấy giá
 * @param {number} maxDistPct - Ngưỡng tối đa (mặc định 0.005 = 0.5%)
 * @param {number} topN - Số mã tối đa (mặc định 8)
 */
function getTopNearbySymbols(symbols, levelCache, priceMap, maxDistPct = 0.005, topN = 8) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];

  const candidates = [];

  for (const sym of symbols) {
    const p = typeof priceMap === 'function' ? priceMap(sym) : (priceMap[sym]?.price || priceMap[sym]);
    const levels = levelCache ? levelCache[sym] : null;

    if (!p || !levels?.longEntry || !levels?.shortEntry) {
      continue;
    }

    const distLong = Math.abs(p - levels.longEntry) / p;
    const distShort = Math.abs(p - levels.shortEntry) / p;
    const minDist = Math.min(distLong, distShort);

    if (minDist <= maxDistPct) {
      candidates.push({ symbol: sym, dist: minDist, price: p });
    }
  }

  // Sắp xếp tăng dần theo khoảng cách (gần nhất trước)
  candidates.sort((a, b) => a.dist - b.dist);

  return candidates.slice(0, topN).map(c => c.symbol);
}

module.exports = {
  getAllActiveFuturesSymbols,
  isGridWidthValid,
  filterSymbolsByGrid,
  getTopNearbySymbols,
  GRID_MIN_PCT,
  GRID_MAX_PCT
};
