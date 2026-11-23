'use strict';

/**
 * Phương pháp "369" — Xác định mốc phản ứng giá hàng tháng
 *
 * Nguyên tắc:
 *   1. Lấy nến H1 đầu tiên của tháng → Open và Close là 2 mốc gốc
 *   2. Các mốc tiếp theo = Open/Close ± (3 × n × đơn vị giá), n = 1, 2, 3...
 *      Ví dụ BTC: đơn vị = 1000 → bước = 3000 → mốc ±3000, ±6000, ±9000
 *      Ví dụ UNI: đơn vị = 0.1  → bước = 0.3   → mốc ±0.3, ±0.6, ±0.9
 *   3. Tín hiệu LONG: giá về Close level SAU KHI đã chạm Open level phía trên
 *      Tín hiệu SHORT: giá về Open level SAU KHI đã chạm Close level phía dưới
 *      (LONG luôn entry tại Close level — SHORT luôn entry tại Open level)
 *   4. Điểm yếu: mốc bị chạm ≥3 lần thường dễ bị phá (+1 điểm, không bỏ lệnh)
 */

const axios = require('axios');
const { log } = require('./_logger');
const { isIpBanned } = require('../services/rateLimitGuard');

// ─── Cấu hình ─────────────────────────────────────────────────────────────────

const LEVELS_RANGE    = 6;     // Tạo ±6 tầng mốc quanh giá gốc
const TOUCH_TOLERANCE = 0.003; // 0.3% dung sai để tính "đã chạm mốc"
const NEAR_LEVEL_PCT  = 0.005; // 0.5% = "giá đang tiếp cận mốc — đủ gần để alert / đặt lệnh" (đồng bộ bot-h4)
const PROXIMITY_PCT   = 0.02;  // 2% = ngưỡng lọc WebSocket — chỉ scan coin đang gần mốc
// Quy tắc 3 lần: lần 1 = strong (+2), lần 2 = medium (+1), lần 3+ = weak (+1)

// ─── In-memory cache ──────────────────────────────────────────────────────────

// H1 cache: { symbol: { monthStart, openPrice, closePrice, step, decimals, upperPrice, lowerPrice } }
const _h1Cache = {};

// 1m candle cache: { symbol: { monthStart, candles: [...], cursor: openTime } }
const _m1Cache = {};

// Level cache: { symbol: { longEntry, shortEntry } } — dùng cho WebSocket proximity filter
const _levelCache = {};

// ─── Tính bước giá tự động theo price ────────────────────────────────────────

function getBaseUnit(price) {
  if (price >= 10000) return 1000;
  if (price >= 1000)  return 100;
  if (price >= 100)   return 10;
  if (price >= 10)    return 1;
  if (price >= 1)     return 0.1;
  if (price >= 0.2)   return 0.01;   // ADA, $0.20-$0.99 → step=0.03
  if (price >= 0.02)  return 0.001;  // CC ($0.15), HBAR ($0.09655) → step=0.003
  if (price >= 0.002) return 0.0001;
  return 0.00001;
}

// Bước = 3 × đơn vị giá (3, 6, 9... là bội số của bước này)
function getStep(price) {
  const unit = getBaseUnit(price);
  return Math.round(3 * unit * 1e8) / 1e8; // tránh float drift
}

function getDecimals(price) {
  if (price >= 100)  return 2;
  if (price >= 10)   return 3;
  if (price >= 1)    return 4;
  if (price >= 0.2)  return 4;  // ADA: 0.2366
  if (price >= 0.1)  return 5;  // CC: 0.15293
  if (price >= 0.02) return 5;  // HBAR: 0.08052 — Binance Futures dùng 5 decimal (tick 0.00001)
  if (price >= 0.01) return 6;
  return 8;
}

// ─── Tạo lưới mốc giá ────────────────────────────────────────────────────────

/**
 * Trả về mảng tất cả mốc giá (tren-series + duoi-series), sort tăng dần.
 * Mỗi mốc: { value, type: 'tren'|'duoi', tier: số nguyên }
 *
 * tren = max(openPrice, closePrice) → LONG entry (mốc trên)
 * duoi = min(openPrice, closePrice) → SHORT entry (mốc dưới)
 */
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

// ─── Lấy nến từ Binance Futures (Có Cache 30s & IP Ban Guard như bot-h4) ──────

const _klinesCache = new Map();
const KLINES_CACHE_TTL_MS = 30 * 1000; // 30 giây cache cho nến ngắn hạn
const MAX_KLINES_CACHE_SIZE = 500;      // Giới hạn số lượng entries chống rò rỉ RAM

async function fetchBinanceKlines(symbol, interval, startTimeMs, limit = 1500) {
  if (isIpBanned()) {
    return [];
  }

  const normStartTime = startTimeMs != null ? Math.floor(startTimeMs / 60000) * 60000 : 'null';
  const cacheKey = `${symbol}_${interval}_${normStartTime}_${limit}`;
  const cached = _klinesCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < KLINES_CACHE_TTL_MS)) {
    return cached.data;
  }

  const url = 'https://fapi.binance.com/fapi/v1/klines';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (isIpBanned()) return [];
      const params = { symbol: `${symbol}USDT`, interval, limit };
      if (startTimeMs != null) params.startTime = startTimeMs;
      const res = await axios.get(url, {
        params,
        timeout: 15000,
      });
      const data = (res.data || []).map(c => ({
        openTime: c[0],
        open:     parseFloat(c[1]),
        high:     parseFloat(c[2]),
        low:      parseFloat(c[3]),
        close:    parseFloat(c[4]),
        volume:   parseFloat(c[5]),
      }));
      if (_klinesCache.size >= MAX_KLINES_CACHE_SIZE) {
        const firstKey = _klinesCache.keys().next().value;
        _klinesCache.delete(firstKey);
      }
      _klinesCache.set(cacheKey, { timestamp: Date.now(), data });
      return data;
    } catch (err) {
      if (isIpBanned() || err?.response?.status === 418 || err?.response?.status === 429) {
        throw err;
      }
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
        continue;
      }
      throw err;
    }
  }
  return [];
}

// Lấy nến H1 đầu tháng có cache — chỉ gọi API khi tháng mới hoặc chưa có cache
async function fetchH1Cached(symbol) {
  const startMs = monthStartMs();
  const cached  = _h1Cache[symbol];
  if (cached && cached.monthStart === startMs) return cached;

  try {
    const { getH1RefCache } = require('../services/h1RefCache');
    const diskCache = getH1RefCache();
    if (diskCache && diskCache[symbol] && diskCache[symbol].monthStart === startMs) {
      _h1Cache[symbol] = diskCache[symbol];
      return _h1Cache[symbol];
    }
  } catch (_) {}

  const candles = await fetchBinanceKlines(symbol, '1h', startMs, 2);
  if (!candles.length) return null;

  const first      = candles[0];
  const openPrice  = first.open;
  const closePrice = first.close;
  const step       = getStep(openPrice);
  const decimals   = getDecimals(openPrice);
  const upperPrice = Math.max(openPrice, closePrice);
  const lowerPrice = Math.min(openPrice, closePrice);

  const entry = { monthStart: startMs, openPrice, closePrice, step, decimals, upperPrice, lowerPrice };
  _h1Cache[symbol] = entry;
  return entry;
}

// Làm tròn timestamp xuống boundary H1 gần nhất
function floorToH1(tsMs) {
  const H1_MS = 60 * 60 * 1000;
  return Math.floor(tsMs / H1_MS) * H1_MS;
}

const _h1MonthCache = {};
const _m1CurrCache = {};

/**
 * Lấy nến H1 lịch sử từ đầu tháng đến H1 hiện tại (incremental, đồng bộ kiến trúc Hybrid từ bot-h4).
 * Tối đa ~744 nến H1 trong cả tháng -> Chỉ tốn 1 API call lần đầu, các lần sau trong cùng giờ tốn 0 API call!
 */
async function fetchH1MonthHistorical(symbol) {
  const H1_MS = 60 * 60 * 1000;
  const startMs = monthStartMs();
  const currentH1Start = floorToH1(Date.now());

  let cache = _h1MonthCache[symbol];
  if (!cache || cache.monthStart !== startMs) {
    cache = { monthStart: startMs, candles: [], cursor: startMs };
    _h1MonthCache[symbol] = cache;
  }

  // Nếu đã có đủ nến H1 tới giờ vừa đóng -> 0 API calls
  const lastClosedTime = cache.candles.length > 0 ? cache.candles[cache.candles.length - 1].openTime : 0;
  if (cache.candles.length > 0 && lastClosedTime + H1_MS >= currentH1Start) {
    return cache.candles;
  }

  // Tận dụng disk cache từ candleCache nếu có sẵn nến trong tháng
  if (cache.candles.length === 0) {
    try {
      const { _h1HistCache } = require('../services/candleCache');
      const diskCandles = _h1HistCache?.[symbol]?.candles;
      if (Array.isArray(diskCandles) && diskCandles.length > 0 && diskCandles[0].openTime <= startMs) {
        const monthCandles = diskCandles.filter(c => c.openTime >= startMs && c.openTime < currentH1Start);
        if (monthCandles.length > 0) {
          cache.candles = monthCandles;
          cache.cursor = monthCandles[monthCandles.length - 1].openTime + H1_MS;
          if (cache.cursor >= currentH1Start) {
            return cache.candles;
          }
        }
      }
    } catch (_) {}
  }

  const missingFrom = cache.candles.length > 0 ? (lastClosedTime + H1_MS) : startMs;
  if (missingFrom >= currentH1Start) return cache.candles;

  const missingHours = Math.max(2, Math.ceil((currentH1Start - missingFrom) / H1_MS) + 2);
  const batch = await fetchBinanceKlines(symbol, '1h', missingFrom, Math.min(missingHours, 1000));
  const closedNew = (batch || []).filter(c => c.openTime >= missingFrom && c.openTime < currentH1Start);

  if (closedNew.length > 0) {
    cache.candles.push(...closedNew);
    cache.cursor = cache.candles[cache.candles.length - 1].openTime + H1_MS;
  }
  return cache.candles;
}

/**
 * Lấy nến M1 từ đầu H1 hiện tại đến bây giờ (incremental, reset khi H1 mới mở).
 * Tối đa 60 nến M1 / giờ — 1 API call duy nhất (limit=60, weight=1), kèm 10s REST API Shield như bot-h4.
 */
async function fetchM1Current(symbol) {
  const currentH1Start = floorToH1(Date.now());
  let cache = _m1CurrCache[symbol];

  if (!cache || cache.h1Start !== currentH1Start) {
    cache = { h1Start: currentH1Start, candles: [], cursor: currentH1Start, lastFetchTime: 0 };
    _m1CurrCache[symbol] = cache;
  }

  // 🛡️ REST API SHIELD: Nếu vừa fetch trong vòng 10s gần đây, trả về cache ngay lập tức (0 API call).
  if (cache.candles.length > 0 && (Date.now() - (cache.lastFetchTime || 0) < 10000)) {
    return cache.candles;
  }

  cache.lastFetchTime = Date.now();
  const batch = await fetchBinanceKlines(symbol, '1m', cache.cursor, 60);
  if (batch && batch.length > 0) {
    if (cache.candles.length > 0) {
      const lastTime = cache.candles[cache.candles.length - 1].openTime;
      const overlapIdx = batch.findIndex(c => c.openTime > lastTime);
      if (overlapIdx > 0) {
        cache.candles[cache.candles.length - 1] = batch[0];
        cache.candles.push(...batch.slice(overlapIdx));
      } else if (overlapIdx === 0) {
        cache.candles.push(...batch);
      } else {
        cache.candles[cache.candles.length - 1] = batch[batch.length - 1];
      }
    } else {
      cache.candles.push(...batch);
    }
    cache.cursor = cache.candles[cache.candles.length - 1].openTime;
  }

  return cache.candles;
}

/**
 * Hybrid Candles (Đồng bộ từ bot-h4):
 * Kết hợp H1 lịch sử (đầu tháng → H1 đang mở) + M1 hiện tại (H1 đang mở → bây giờ).
 * Giảm 200x lượng REST API weight so với việc quét 28.800 nến 1m từ đầu tháng.
 */
async function fetchM1Incremental(symbol) {
  const h1Candles = await fetchH1MonthHistorical(symbol);
  const m1Candles = await fetchM1Current(symbol);
  return [...h1Candles, ...m1Candles];
}

// Nến H1 đầu tháng = nến bắt đầu lúc 00:00:00 UTC (múi giờ Binance mặc định).
// Binance dùng UTC cho tất cả klines API — "tháng mới" bắt đầu đúng 00:00 UTC ngày 1.
// June 1 00:00 UTC = 07:00 VN → đây là nến trader thấy trên chart Binance khi bắt đầu tháng mới.

function monthStartMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function monthLabel() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── Đếm số lần bouncing hợp lệ giữa 2 mốc ─────────────────────────────────

/**
 * Quét toàn bộ nến theo thứ tự thời gian, đếm số lần giá bouncing hợp lệ
 * giữa longEntry (Close level dưới) và shortEntry (Open level trên).
 *
 * Quy tắc đếm:
 *   - Chỉ tính khi giá đến mốc từ phía ĐỐI DIỆN (tức là đã "đi" qua khoảng giữa)
 *   - Nếu giá chạm lại mốc cùng bên mà không ghé mốc kia → KHÔNG tính thêm lần
 *
 * Trả về:
 *   lowerCount  — số lần giá đi từ Open level trên → Close level dưới (= số LONG đã xảy ra)
 *   upperCount  — số lần giá đi từ Close level dưới → Open level trên (= số SHORT đã xảy ra)
 *   lastSide    — 'lower' | 'upper' | null (bên nào được chạm gần nhất)
 */
function analyzeRoundtrips(candles, lowerLevel, upperLevel) {
  const lolTol = lowerLevel * TOUCH_TOLERANCE;
  const upTol  = upperLevel * TOUCH_TOLERANCE;

  let lastSide   = null;  // bên nào được chạm gần nhất (valid)
  let lowerCount = 0;     // số lần valid từ upper → lower
  let upperCount = 0;     // số lần valid từ lower → upper

  for (const c of candles) {
    const hitLower = c.low  <= lowerLevel + lolTol;
    const hitUpper = c.high >= upperLevel - upTol;

    // Nếu nến chạm CẢ HAI mốc (cây nến rất rộng):
    // Dùng hướng của nến (close vs open) để xác định bên nào là điểm cuối
    if (hitLower && hitUpper) {
      const endedLow = c.close < c.open;
      if (endedLow && lastSide !== 'lower') {
        if (lastSide === 'upper') lowerCount++;
        lastSide = 'lower';
      } else if (!endedLow && lastSide !== 'upper') {
        if (lastSide === 'lower') upperCount++;
        lastSide = 'upper';
      }
      continue;
    }

    if (hitLower && lastSide !== 'lower') {
      if (lastSide === 'upper') lowerCount++;
      lastSide = 'lower';
    }

    if (hitUpper && lastSide !== 'upper') {
      if (lastSide === 'lower') upperCount++;
      lastSide = 'upper';
    }
  }

  return { lowerCount, upperCount, lastSide };
}

// ─── Tạo signal 369 cho 1 coin ────────────────────────────────────────────────

/**
 * @param {string} symbol    - Ký hiệu coin không có USDT (ví dụ 'BTC', 'UNI')
 * @param {number|null} currentPrice - Giá hiện tại (null = dùng nến gần nhất)
 */
async function get369Signal(symbol, currentPrice = null) {
  const month = monthLabel();

  try {
    const h1 = await fetchH1Cached(symbol);
    if (!h1) {
      return { signal: 'NONE', symbol, month, reason: 'Không lấy được nến H1 tháng này' };
    }

    const { openPrice, closePrice, step, decimals, upperPrice, lowerPrice } = h1;

    const stream = require('./stream');
    const price = currentPrice || (typeof stream.getMarkPrice === 'function' ? stream.getMarkPrice(symbol) : null) || (typeof stream.getPrices === 'function' ? stream.getPrices()[symbol] : null) || null;

    // Dùng step từ GIÁ HIỆN TẠI thay vì H1 open — đảm bảo khoảng cách mốc phù hợp
    // khi coin đã tăng/giảm mạnh so với đầu tháng (VD: coin 10x → step tăng 10x theo)
    const effectiveStep     = getStep(price || openPrice);
    const effectiveDecimals = getDecimals(price || openPrice);

    // Fast pre-check: Nếu có currentPrice, kiểm tra lưới và cự ly trước khi fetch nến 1m (tiết kiệm API)
    if (price != null && price > 0) {
      const distTicks = Math.ceil(Math.max(
        Math.abs(upperPrice - price),
        Math.abs(lowerPrice - price),
      ) / effectiveStep);
      const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);

      const grid = buildLevelGrid(upperPrice, lowerPrice, effectiveStep, effectiveDecimals, levelsRange);
      const longEntry  = grid.filter(l => l.type === 'tren' && l.value < price).pop();
      const shortEntry = grid.find(l   => l.type === 'duoi' && l.value > price);

      if (longEntry && shortEntry) {
        _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: effectiveStep };

        const nearTol   = price * NEAR_LEVEL_PCT * 2; // 0.2% dung sai chạm
        const gridWidthStepPre = shortEntry.value - longEntry.value;
        const nearLong  = (price <= longEntry.value + nearTol) && (price >= longEntry.value - gridWidthStepPre * 0.50);
        const nearShort = (price >= shortEntry.value - nearTol) && (price <= shortEntry.value + gridWidthStepPre * 0.50);

        if (!nearLong && !nearShort) {
          return {
            signal: 'NONE', symbol, month, openPrice, closePrice, step: effectiveStep,
            targetLevel: null,
            reason: `Giá ${price} chưa chạm mốc 369`
          };
        }
      }
    }

    const m1Candles = await fetchM1Incremental(symbol);

    if (!m1Candles.length) {
      return { signal: 'NONE', symbol, month, reason: 'Không lấy được nến 1m tháng này' };
    }

    const finalPrice = price ?? (m1Candles.length > 0 ? m1Candles[m1Candles.length - 1].close : null);
    if (!finalPrice || finalPrice <= 0) {
      return { signal: 'NONE', symbol, month, reason: 'Không có giá hiện tại hợp lệ' };
    }

    const distTicks = Math.ceil(Math.max(
      Math.abs(upperPrice - finalPrice),
      Math.abs(lowerPrice - finalPrice),
    ) / effectiveStep);
    const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);

    const grid = buildLevelGrid(upperPrice, lowerPrice, effectiveStep, effectiveDecimals, levelsRange);

    const longEntry  = grid.filter(l => l.type === 'tren' && l.value < finalPrice).pop();
    const shortEntry = grid.find(l   => l.type === 'duoi' && l.value > finalPrice);

    if (!longEntry || !shortEntry) {
      return { signal: 'NONE', symbol, month, openPrice, closePrice, step: effectiveStep,
               reason: `Giá ${finalPrice} nằm ngoài vùng lưới mốc` };
    }

    _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: effectiveStep };

    const pairLow  = longEntry.value;
    const pairHigh = shortEntry.value;

    const done = m1Candles.slice(0, -1);

    const { lowerCount, upperCount, lastSide } =
      analyzeRoundtrips(done, pairLow, pairHigh);

    const touchCountLong  = lowerCount;
    const touchCountShort = upperCount;

    const nearTol   = finalPrice * NEAR_LEVEL_PCT;
    const gridWidthStep = shortEntry.value - longEntry.value;
    const nearLong  = (finalPrice <= longEntry.value + nearTol) && (finalPrice >= longEntry.value - gridWidthStep * 0.50);
    const nearShort = (finalPrice >= shortEntry.value - nearTol) && (finalPrice <= shortEntry.value + gridWidthStep * 0.50);

    let signal      = 'NONE';
    let strength    = 'none';
    let targetLevel = null;
    let condLevel   = null;
    let touchCount  = 0;
    let reason      = '';

    if (nearLong && lastSide === 'upper') {
      signal      = 'LONG';
      strength    = touchCountLong === 0 ? 'strong' : touchCountLong === 1 ? 'medium' : 'weak';
      touchCount  = touchCountLong;
      targetLevel = longEntry.value;
      condLevel   = shortEntry.value;
      reason      = `[369] LONG lần ${touchCountLong + 1} tại ${longEntry.value} ← từ ${shortEntry.value} (${strength})`;
    }

    if (nearShort && lastSide === 'lower' && signal === 'NONE') {
      signal      = 'SHORT';
      strength    = touchCountShort === 0 ? 'strong' : touchCountShort === 1 ? 'medium' : 'weak';
      touchCount  = touchCountShort;
      targetLevel = shortEntry.value;
      condLevel   = longEntry.value;
      reason      = `[369] SHORT lần ${touchCountShort + 1} tại ${shortEntry.value} ← từ ${longEntry.value} (${strength})`;
    }

    if (signal === 'NONE') {
      reason = `[369] Không có tín hiệu — giá ${price} giữa ${pairLow}↔${pairHigh}`;
    }

    const allBelow = grid.filter(l => l.value < price);
    const allAbove = grid.filter(l => l.value > price);

    return {
      symbol,
      signal,
      strength,
      touchCount,
      targetLevel,
      condLevel,
      nearestAbove: allAbove.length ? allAbove[0].value : null,
      nearestBelow: allBelow.length ? allBelow[allBelow.length - 1].value : null,
      currentPrice: price,
      openPrice,
      closePrice,
      step: effectiveStep,
      month,
      reason,
      debugInfo: {
        lowerCount,
        upperCount,
        lastSide,
        pairLow,
        pairHigh,
        totalCandles: done.length,
      },
      nearLevels: grid
        .filter(l => Math.abs(l.value - price) < effectiveStep * 5.5)
        .map(l => ({ value: l.value, type: l.type, tier: l.tier })),
    };

  } catch (err) {
    const is429 = err?.response?.status === 429;
    const is418 = err?.response?.status === 418;
    // IP bị soft-ban: re-throw để get369SignalsForCoins có thể dừng toàn bộ loop
    if (is418) throw err;
    log.warn(`[369] ${symbol}: ${is429 ? 'rate limit Binance klines (429) — đã retry 3 lần, bỏ qua lần này' : `lỗi fetch klines — ${err.message}`}`);
    return { signal: 'NONE', symbol, month, reason: `Lỗi: ${err.message}` };
  }
}

// ─── Batch cho nhiều coin ─────────────────────────────────────────────────────

/**
 * Lấy 369 signal cho danh sách symbols song song.
 * @param {string[]} symbols - Mảng symbol không có USDT
 * @param {Object}   taMap   - TA data map để lấy giá hiện tại (optional)
 * @returns {Object} { BTC: signal, ETH: signal, ... }
 */
async function get369SignalsForCoins(symbols, taMap = {}) {
  const map = {};

  for (const sym of symbols) {
    if (isIpBanned()) break;
    try {
      map[sym] = await get369Signal(sym, taMap[sym]?.price ?? null);
    } catch (err) {
      if (err?.response?.status === 418 || err?.response?.status === 429 || isIpBanned()) {
        log.warn(`[369] IP bị Binance giới hạn (${err?.response?.status || 'RateLimit'}) — dừng toàn bộ klines scan`);
        break;
      }
      map[sym] = { signal: 'NONE', symbol: sym, reason: err?.message ?? 'unknown' };
    }
    // Tránh 429: delay nhỏ giữa các symbol
    await new Promise(r => setTimeout(r, 150));
  }

  return map;
}

// ─── Tính điểm đóng góp cho Confluence Scorer ────────────────────────────────

/**
 * @param {object} sig369   - Kết quả từ get369Signal
 * @param {string} direction - 'LONG' | 'SHORT'
 * @returns {{ score: number, reasons: string[] }}
 */
function score369Method(sig369, direction) {
  if (!sig369 || sig369.signal === 'NONE') {
    return { score: 0, reasons: [] };
  }
  if (sig369.signal !== direction) {
    return { score: 0, reasons: [] };
  }

  const score = sig369.strength === 'strong' ? 2
              : sig369.strength === 'medium' ? 1
              : sig369.strength === 'weak'   ? 1
              : 0;

  const lan = sig369.touchCount + 1;
  const reasons = score > 0
    ? [`[PP369] ${direction} lần ${lan} tại ${sig369.targetLevel} ← từ ${sig369.condLevel} (${sig369.strength}) (+${score})`]
    : [];

  return { score, reasons };
}

// ─── Format cho AI prompt ─────────────────────────────────────────────────────

function format369ForPrompt(signals369Map) {
  if (!signals369Map || !Object.keys(signals369Map).length) return '';

  const lines = ['\n[PHƯƠNG PHÁP 369 — Mốc phản ứng giá tháng]'];
  lines.push('Tín hiệu: giá từ mốc trên xuống mốc dưới → LONG | từ mốc dưới lên mốc trên → SHORT');
  lines.push('Quy tắc 3 lần: lần 1=strong(+2) | lần 2=medium(+1) | lần 3+=weak(+1)');
  lines.push('');

  for (const [sym, s] of Object.entries(signals369Map)) {
    if (!s.openPrice) continue;
    const fp = v => v >= 100 ? `$${v.toLocaleString('en-US')}` : `$${v}`;
    lines.push(`${sym} (${s.month}):`);
    lines.push(`  Nến H1 đầu tháng: Open=${fp(s.openPrice)} | Close=${fp(s.closePrice)} | Bước=${fp(s.step)}`);
    lines.push(`  Mốc bao quanh: Dưới=${fp(s.nearestBelow)} / Trên=${fp(s.nearestAbove)}`);
    if (s.signal === 'LONG' || s.signal === 'SHORT') {
      const lan = s.touchCount + 1;
      lines.push(`  → Tín hiệu: ${s.signal} lần ${lan} tại ${fp(s.targetLevel)} [${s.strength}]`);
    } else {
      lines.push(`  → Không có tín hiệu (giá đang giữa vùng hoặc chưa đủ điều kiện)`);
    }
  }

  return lines.join('\n');
}

function getLevelCache() { return _levelCache; }

function setLevelCacheEntry(symbol, data) {
  if (symbol && data) {
    _levelCache[symbol] = data;
  }
}

function mergeLevelCache(entries) {
  if (entries && typeof entries === 'object') {
    Object.assign(_levelCache, entries);
  }
}

module.exports = {
  get369Signal, get369SignalsForCoins, score369Method, format369ForPrompt,
  getLevelCache, setLevelCacheEntry, mergeLevelCache, PROXIMITY_PCT,
  buildLevelGrid, getStep, getDecimals, LEVELS_RANGE,
};
