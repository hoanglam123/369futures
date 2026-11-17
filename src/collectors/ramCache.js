'use strict';

/**
 * RAM Caching & On-Demand Collector Engine (Phase 3)
 *
 * Nguyên tắc thiết kế:
 *   1. On-Demand Trigger: Không quét định kỳ 450 coin để tránh quá tải quota API.
 *      Chỉ kích hoạt thu thập chuyên sâu khi coin tiếp cận mốc lưới PP369 (<= 0.3%)
 *      hoặc phát sinh tín hiệu LONG/SHORT.
 *   2. RAM Caching 180s - 300s: Mọi dữ liệu kéo về được lưu vào bộ nhớ RAM,
 *      phục vụ tức thì (0ms latency) cho Tầng 3 (Confluence Scorer) và Tầng 4 (AI Dataset).
 *   3. Request Coalescing (Ghép luồng): Tránh gọi trùng lặp song song cho cùng 1 symbol.
 *   4. Safe Fallback: Khi API ngoài bị timeout hoặc rate limit, trả về cache gần nhất
 *      hoặc default rỗng an toàn, không bao giờ làm sập tiến trình bot.
 */

const { getWhaleData } = require('./whaleData');
const { getDerivatives } = require('./derivatives');
const { getFearGreedIndex } = require('./fearGreed');

// Cấu hình TTL bộ đệm RAM
const WHALE_TTL_MS = 180_000;       // 3 phút
const DERIVATIVES_TTL_MS = 180_000; // 3 phút
const FEAR_GREED_TTL_MS = 900_000;  // 15 phút (chỉ số ngày)
const MAX_CACHE_ENTRIES = 100;

// Bộ đệm RAM
const _whaleCache = new Map();       // sym -> { data, timestamp }
const _derivativesCache = new Map(); // sym -> { data, timestamp }
let _fearGreedCache = null;          // { data, timestamp }

// Request coalescing map để chống gọi lặp đồng thời
const _pendingWhaleRequests = new Map();
const _pendingDerivRequests = new Map();
let _pendingFearGreedRequest = null;

/**
 * Lấy chỉ số Fear & Greed với bộ đệm RAM 15 phút.
 */
async function getFearGreedCached() {
  const now = Date.now();
  if (_fearGreedCache && (now - _fearGreedCache.timestamp < FEAR_GREED_TTL_MS)) {
    return _fearGreedCache.data;
  }

  if (_pendingFearGreedRequest) {
    return _pendingFearGreedRequest;
  }

  _pendingFearGreedRequest = (async () => {
    try {
      const data = await getFearGreedIndex();
      _fearGreedCache = { data, timestamp: Date.now() };
      return data;
    } catch (err) {
      return _fearGreedCache?.data || { value: 50, classification: 'Neutral' };
    } finally {
      _pendingFearGreedRequest = null;
    }
  })();

  return _pendingFearGreedRequest;
}

/**
 * Lấy dữ liệu cá voi cho 1 symbol với bộ đệm RAM 3 phút.
 */
async function getWhaleDataCached(symbol) {
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  if (!cleanSym) return null;

  const now = Date.now();
  const cached = _whaleCache.get(cleanSym);
  if (cached && (now - cached.timestamp < WHALE_TTL_MS)) {
    return cached.data;
  }

  if (_pendingWhaleRequests.has(cleanSym)) {
    return _pendingWhaleRequests.get(cleanSym);
  }

  const promise = (async () => {
    try {
      const data = await getWhaleData([cleanSym], 4);
      if (_whaleCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = _whaleCache.keys().next().value;
        if (firstKey) _whaleCache.delete(firstKey);
      }
      _whaleCache.set(cleanSym, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      return cached?.data || null;
    } finally {
      _pendingWhaleRequests.delete(cleanSym);
    }
  })();

  _pendingWhaleRequests.set(cleanSym, promise);
  return promise;
}

/**
 * Lấy dữ liệu phái sinh (OI & L/S) cho 1 symbol với bộ đệm RAM 3 phút.
 */
async function getDerivativesCached(symbol) {
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  if (!cleanSym) return null;

  const now = Date.now();
  const cached = _derivativesCache.get(cleanSym);
  if (cached && (now - cached.timestamp < DERIVATIVES_TTL_MS)) {
    return cached.data;
  }

  if (_pendingDerivRequests.has(cleanSym)) {
    return _pendingDerivRequests.get(cleanSym);
  }

  const promise = (async () => {
    try {
      const data = await getDerivatives([cleanSym], 4);
      if (_derivativesCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = _derivativesCache.keys().next().value;
        if (firstKey) _derivativesCache.delete(firstKey);
      }
      _derivativesCache.set(cleanSym, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      return cached?.data || null;
    } finally {
      _pendingDerivRequests.delete(cleanSym);
    }
  })();

  _pendingDerivRequests.set(cleanSym, promise);
  return promise;
}

/**
 * Thu thập On-Demand toàn bộ dữ liệu chuyên sâu cho 1 symbol (Whale, Derivatives, Fear&Greed)
 * Trả về ngay lập tức nếu đã có trong RAM cache!
 */
async function getOnDemandMarketData(symbol) {
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  if (!cleanSym) return { whaleData: null, derivatives: null, fearGreed: null };

  const [whaleData, derivatives, fearGreed] = await Promise.all([
    getWhaleDataCached(cleanSym).catch(() => null),
    getDerivativesCached(cleanSym).catch(() => null),
    getFearGreedCached().catch(() => null),
  ]);

  return {
    whaleData,
    derivatives,
    fearGreed
  };
}

/**
 * Thống kê tình trạng bộ nhớ RAM Cache
 */
function getRamCacheStats() {
  return {
    whaleCachedSymbols: _whaleCache.size,
    derivativesCachedSymbols: _derivativesCache.size,
    hasFearGreedCache: !!_fearGreedCache,
    fearGreedValue: _fearGreedCache?.data?.value ?? null,
  };
}

/**
 * Xóa cache (phục vụ unit test)
 */
function clearRamCache() {
  _whaleCache.clear();
  _derivativesCache.clear();
  _fearGreedCache = null;
  _pendingWhaleRequests.clear();
  _pendingDerivRequests.clear();
  _pendingFearGreedRequest = null;
}

module.exports = {
  getOnDemandMarketData,
  getWhaleDataCached,
  getDerivativesCached,
  getFearGreedCached,
  getRamCacheStats,
  clearRamCache,
  WHALE_TTL_MS,
  DERIVATIVES_TTL_MS,
  FEAR_GREED_TTL_MS,
};
