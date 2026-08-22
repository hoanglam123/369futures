'use strict';

/**
 * Turnover Guard — PP369
 * 
 * Kiểm tra và bảo vệ bot trước các mã coin có Vốn Hóa Nhỏ (Market Cap < $100M) 
 * nhưng Khối Lượng Giao Dịch 24H (Futures) lại tăng đột biến (> 8% Market Cap).
 * 
 * Mục đích: Tránh các đợt quét râu thanh khoản (Liquidity Hunt) và nến giật bất thường
 * do dòng tiền đầu cơ / cá voi thao túng các mã low-cap thanh khoản mỏng.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');

// Cache Volume 24H (Futures USDT-M)
let _volume24hCache = {};
let _lastVol24hFetchTime = 0;
const VOL24H_CACHE_TTL_MS = 2 * 60 * 1000; // 2 phút cập nhật 1 lần

// Cache Market Cap từ file data/market_cap_top.json
let _marketCapDataCache = null;
let _lastMarketCapFileRead = 0;

/**
 * Đọc dữ liệu Market Cap từ file JSON nội bộ.
 */
function getMarketCapDataSync() {
  const now = Date.now();
  if (_marketCapDataCache && (now - _lastMarketCapFileRead < 5 * 60 * 1000)) {
    return _marketCapDataCache;
  }
  try {
    const filePath = path.join(process.cwd(), 'data', 'market_cap_top.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      _marketCapDataCache = data;
      _lastMarketCapFileRead = now;
      return data;
    }
  } catch (_) {}
  return _marketCapDataCache || { symbols: [], marketCapMap: {}, rankMap: {} };
}

/**
 * Lấy Vốn hóa (USD) của một đồng coin.
 * @param {string} symbol - Tên coin (ví dụ: 'BTC', 'RVN')
 * @returns {number|null} Vốn hóa USD hoặc null nếu không tìm thấy
 */
function getMarketCapUSD(symbol) {
  if (!symbol) return null;
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const data = getMarketCapDataSync();
  if (data.marketCapMap && data.marketCapMap[cleanSym]) {
    return data.marketCapMap[cleanSym];
  }
  return null;
}

/**
 * Lấy Thứ hạng Vốn hóa (Rank).
 * @param {string} symbol 
 * @returns {number} Rank (1, 2, ... hoặc 999 nếu ngoài Top)
 */
function getMarketCapRank(symbol) {
  if (!symbol) return 999;
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const data = getMarketCapDataSync();
  if (data.rankMap && data.rankMap[cleanSym]) {
    return data.rankMap[cleanSym];
  }
  if (Array.isArray(data.symbols)) {
    const idx = data.symbols.indexOf(cleanSym);
    if (idx !== -1) return idx + 1;
  }
  return 999;
}

/**
 * Cập nhật Cache Volume 24H từ Binance Futures (1 request duy nhất gom toàn sàn).
 * Tần suất gọi: tối đa 1 lần mỗi 2 phút.
 */
async function updateVolume24hCache(force = false) {
  const now = Date.now();
  if (!force && (now - _lastVol24hFetchTime < VOL24H_CACHE_TTL_MS)) {
    return _volume24hCache;
  }
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10_000 });
    if (Array.isArray(res.data)) {
      const map = {};
      for (const item of res.data) {
        if (!item.symbol || !item.symbol.endsWith('USDT')) continue;
        const sym = item.symbol.replace(/USDT$/, '');
        map[sym] = parseFloat(item.quoteVolume || '0');
      }
      _volume24hCache = map;
      _lastVol24hFetchTime = now;
      return _volume24hCache;
    }
  } catch (err) {
    log.warn(`[TurnoverGuard] Không thể cập nhật Volume 24H Binance: ${err.message}`);
  }
  return _volume24hCache;
}

/**
 * Lấy Khối lượng giao dịch 24H (USDT) của một đồng coin.
 * @param {string} symbol 
 * @returns {number} Quote volume (USDT)
 */
function getVolume24hUSD(symbol) {
  if (!symbol) return 0;
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  return _volume24hCache[cleanSym] ?? 0;
}

/**
 * Thiết lập thủ công cache Volume 24H (dùng cho testing / mock).
 */
function setMockVolume24h(symbol, quoteVolumeUSD) {
  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  _volume24hCache[cleanSym] = quoteVolumeUSD;
  _lastVol24hFetchTime = Date.now();
}

/**
 * Thiết lập thủ công cache Market Cap (dùng cho testing / mock).
 */
function setMockMarketCapData(marketCapMap, rankMap = {}) {
  _marketCapDataCache = {
    updatedAt: Date.now(),
    symbols: Object.keys(marketCapMap),
    marketCapMap: marketCapMap,
    rankMap: rankMap
  };
  _lastMarketCapFileRead = Date.now();
}

/**
 * KIỂM TRA BỘ LỌC TURNOVER GUARD:
 * Ngưỡng quy định: Market Cap < 100M USD VÀ Volume 24H / Market Cap > 8.0%
 * -> Dừng giao dịch để tránh nến quét râu thanh khoản.
 * 
 * @param {string} symbol - Tên coin (ví dụ: 'RVN', 'BTC')
 * @returns {{
 *   isBlocked: boolean,
 *   isLowCap: boolean,
 *   marketCapUSD: number|null,
 *   vol24hUSD: number,
 *   turnoverRatioPct: number,
 *   reason: string
 * }}
 */
function checkTurnoverGuard(symbol) {
  if (!symbol) {
    return {
      isBlocked: false,
      isLowCap: false,
      marketCapUSD: null,
      vol24hUSD: 0,
      turnoverRatioPct: 0,
      reason: 'Symbol không hợp lệ'
    };
  }

  const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
  const vol24hUSD = getVolume24hUSD(cleanSym);
  const rawMarketCap = getMarketCapUSD(cleanSym);
  const rank = getMarketCapRank(cleanSym);

  // 1. Phân loại Low-Cap (< 100M USD):
  // - Nếu có dữ liệu Market Cap và < 100 triệu USD
  // - Hoặc không có Market Cap cụ thể nhưng rank ngoài Top 150 (các coin rank > 150 đều < 100M)
  const isExplicitLowCap = rawMarketCap !== null && rawMarketCap < 100_000_000;
  const isRankLowCap = rawMarketCap === null && rank > 150;
  const isLowCap = isExplicitLowCap || isRankLowCap;

  // Nếu là Coin Top / Mid-Cap (> 100M USD hoặc Rank Top 100) -> An toàn
  if (!isLowCap && rank <= 100) {
    const mc = rawMarketCap || 500_000_000;
    const ratio = mc > 0 ? (vol24hUSD / mc) * 100 : 0;
    return {
      isBlocked: false,
      isLowCap: false,
      marketCapUSD: mc,
      vol24hUSD,
      turnoverRatioPct: ratio,
      reason: 'Coin Top / Mid-Cap có thanh khoản an toàn'
    };
  }

  // 2. Tính toán Turnover Ratio cho Low-Cap:
  // Nếu không có Market Cap chính xác nhưng rank ngoài 150, dùng mốc ước lượng thận trọng (60M USD)
  const effectiveMC = rawMarketCap || (rank > 300 ? 40_000_000 : 70_000_000);
  const turnoverRatioPct = effectiveMC > 0 ? (vol24hUSD / effectiveMC) * 100 : 0;

  // 3. Quy tắc chặn: Market Cap < 100M VÀ Turnover > 8.0%
  const MAX_LOWCAP_TURNOVER_PCT = 8.0;

  if (isLowCap && vol24hUSD > 0 && turnoverRatioPct > MAX_LOWCAP_TURNOVER_PCT) {
    const mcStr = (effectiveMC / 1e6).toFixed(1);
    const volStr = (vol24hUSD / 1e6).toFixed(2);
    return {
      isBlocked: true,
      isLowCap: true,
      marketCapUSD: effectiveMC,
      vol24hUSD,
      turnoverRatioPct,
      reason: `MarketCap nhỏ ($${mcStr}M < 100M) nhưng KL 24H quá lớn ($${volStr}M ~ ${turnoverRatioPct.toFixed(1)}% MC > 8%) — Nguy cơ quét râu cao, DỪNG GIAO DỊCH`
    };
  }

  return {
    isBlocked: false,
    isLowCap: isLowCap,
    marketCapUSD: effectiveMC,
    vol24hUSD,
    turnoverRatioPct,
    reason: 'Thanh khoản và vòng quay vốn ổn định'
  };
}

/**
 * Kiểm tra nhanh xem mã coin có đang bị dừng giao dịch bởi Turnover Guard hay không.
 * @param {string} symbol 
 * @returns {boolean}
 */
function isTurnoverBlocked(symbol) {
  const res = checkTurnoverGuard(symbol);
  return res.isBlocked;
}

module.exports = {
  updateVolume24hCache,
  getVolume24hUSD,
  getMarketCapUSD,
  getMarketCapRank,
  checkTurnoverGuard,
  isTurnoverBlocked,
  setMockVolume24h,
  setMockMarketCapData
};
