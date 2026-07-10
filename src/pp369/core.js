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
const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');
const { notifySignals } = require('./telegram');

const FILE_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');

// ─── Cấu hình ─────────────────────────────────────────────────────────────────

const LEVELS_RANGE = 6;     // Tạo ±6 tầng mốc quanh giá gốc
const TOUCH_TOLERANCE = 0.003; // 0.3% dung sai để tính "đã chạm mốc"
const NEAR_LEVEL_PCT = 0.003; // 0.3% = "giá đang tiếp cận mốc — đủ gần để alert / đặt lệnh"
const PROXIMITY_PCT = 0.02;  // 2% = ngưỡng lọc WebSocket — chỉ scan coin đang gần mốc
// Quy tắc 3 lần: lần 1 = strong (+2), lần 2 = medium (+1), lần 3+ = weak (+1)

// Mốc gốc H4: nến H4 đầu tiên của năm 2026 (01/01/2026 00:00:00 UTC = 07:00 VN)
const YEAR_START_MS = Date.UTC(2026, 0, 1);

// ─── Lọc coin theo độ rộng grid ──────────────────────────────────────────────
// Grid quá hẹp (< 3%): coin cực đắt — khoảng giá biến động quá nhỏ so với step
// Grid quá rộng (> 20%): coin rẻ tiền (1000x...) — biến động quá lớn, rủi ro cao
// Ngưỡng 3–20% bao gồm BTC/ETH (≈3%), SOL (≈4%), các altcoin tầm trung (5–15%)
const GRID_MIN_PCT = 3;   // 3% — bao gồm cả coin đắt tiền/thị phần lớn (BTC, ETH, SOL...)
const GRID_MAX_PCT = 20;  // 20%

/**
 * Tính khoảng cách % giữa 2 mốc cùng loại (tren→tren hoặc duoi→duoi).
 * = step / openPrice × 100
 * @param {{ step: number, openPrice: number }} h1Entry - Entry từ h1Cache
 * @returns {number} Khoảng cách % (ví dụ 3.09 cho BTC)
 */
function getGridStepPct(h1Entry) {
  if (!h1Entry || !h1Entry.step || !h1Entry.openPrice) return 0;
  return (h1Entry.step / h1Entry.openPrice) * 100;
}

/**
 * Kiểm tra coin có nằm trong ngưỡng grid cho phép không (GRID_MIN_PCT – GRID_MAX_PCT).
 * @param {{ step: number, openPrice: number }} h1Entry
 * @returns {boolean}
 */
function isGridWidthValid(h1Entry) {
  const pct = getGridStepPct(h1Entry);
  return pct >= GRID_MIN_PCT && pct <= GRID_MAX_PCT;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

// H1 cache (legacy monthly): { symbol: { monthStart, openPrice, closePrice, step, decimals, upperPrice, lowerPrice } }
const _h1Cache = {};

// H4 reference cache (yearly): { symbol: { yearStart, openPrice, closePrice, step, decimals, upperPrice, lowerPrice } }
const _h4RefCache = {};

// H4 historical candle cache: { symbol: { yearStart, candles: [], cursor } } — toàn bộ H4 đã đóng từ đầu năm
const _h4HistCache = {};

// M1 current H4 period cache: { symbol: { h4Start, candles: [], cursor } } — reset mỗi khi H4 mới mở
const _m1CurrCache = {};

// 1m candle cache (legacy monthly): { symbol: { monthStart, candles: [...], cursor: openTime } }
const _m1Cache = {};

// Level cache: { symbol: { longEntry, shortEntry } } — dùng cho WebSocket proximity filter
const _levelCache = {};

// ─── Tính bước giá tự động theo price ────────────────────────────────────────

function getBaseUnit(price) {
  if (price >= 10000) return 1000;
  if (price >= 1000) return 100;
  if (price >= 100) return 10;
  if (price >= 10) return 1;
  if (price >= 1) return 0.1;
  if (price >= 0.2) return 0.01;   // ADA, $0.20-$0.99 → step=0.03
  if (price >= 0.02) return 0.001;  // CC ($0.15), HBAR ($0.09655) → step=0.003
  if (price >= 0.002) return 0.0001;
  return 0.00001;
}

// Bước = 3 × đơn vị giá (3, 6, 9... là bội số của bước này)
function getStep(price) {
  const unit = getBaseUnit(price);
  return Math.round(3 * unit * 1e8) / 1e8; // tránh float drift
}

function getDecimals(price) {
  if (price >= 100) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  if (price >= 0.2) return 4;  // ADA: 0.2366
  if (price >= 0.1) return 5;  // CC: 0.15293
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
      type: 'tren',
      tier: i,
    });
    grid.push({
      value: parseFloat((lowerPrice + offset).toFixed(decimals)),
      type: 'duoi',
      tier: i,
    });
  }
  grid.sort((a, b) => a.value - b.value || (a.type === 'tren' ? -1 : 1));
  return grid.filter((v, i, arr) =>
    i === 0 || !(v.value === arr[i - 1].value && v.type === arr[i - 1].type)
  );
}

// ─── Lấy nến từ Binance Futures ───────────────────────────────────────────────

async function fetchBinanceKlines(symbol, interval, startTimeMs, limit = 1500) {
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.get(url, {
        params: { symbol: `${symbol}USDT`, interval, startTime: startTimeMs, limit },
        timeout: 15000,
      });
      return (res.data || []).map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch (err) {
      if (err?.response?.status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
}

// Lấy nến H1 đầu tháng có cache — chỉ gọi API khi tháng mới hoặc chưa có cache
async function fetchH1Cached(symbol) {
  const startMs = monthStartMs();
  const cached = _h1Cache[symbol];
  if (cached && cached.monthStart === startMs) {
    return cached.failed ? null : cached;
  }

  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      const fileCache = data.h1Cache ?? {};
      if (fileCache[symbol] && fileCache[symbol].monthStart === startMs) {
        _h1Cache[symbol] = fileCache[symbol];
        return fileCache[symbol].failed ? null : fileCache[symbol];
      }
    } catch (err) {
      log.warn(`[369] Lỗi đọc h1Cache từ file: ${err.message}`);
    }
  }

  // Gọi API klines 1h để lấy nến H1 đầu tháng
  let candles;
  try {
    candles = await fetchBinanceKlines(symbol, '1h', startMs, 2);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 400) {
      const entry = { monthStart: startMs, failed: true, reason: `Status ${status}` };
      _h1Cache[symbol] = entry;
      try {
        let data = {};
        if (fs.existsSync(FILE_PATH)) {
          const content = fs.readFileSync(FILE_PATH, 'utf8');
          data = JSON.parse(content);
        }
        if (!data.h1Cache) data.h1Cache = {};
        data.h1Cache[symbol] = entry;
        fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        log.warn(`[369] Đã đánh dấu lỗi ${status} cho ${symbol} vào step_sizes.json, sẽ không gọi lại nữa.`);
      } catch (e) {
        log.warn(`[369] Lỗi ghi file h1Cache cho ${symbol}: ${e.message}`);
      }
    } else if (status === 418) {
      throw new Error('IP_BANNED_418');
    }
    return null;
  }

  if (!candles || !candles.length) return null;

  const first = candles[0];
  const openPrice = first.open;
  const closePrice = first.close;
  const step = getStep(openPrice);
  const decimals = getDecimals(openPrice);
  const upperPrice = Math.max(openPrice, closePrice);
  const lowerPrice = Math.min(openPrice, closePrice);

  const entry = { monthStart: startMs, openPrice, closePrice, step, decimals, upperPrice, lowerPrice };
  _h1Cache[symbol] = entry;

  try {
    let data = {};
    if (fs.existsSync(FILE_PATH)) {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      data = JSON.parse(content);
    }
    if (!data.h1Cache) data.h1Cache = {};
    data.h1Cache[symbol] = entry;

    const dir = path.dirname(FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    log.system(`[369] Saved H1 cache for ${symbol} to file`);
  } catch (err) {
    log.warn(`[369] Lỗi ghi h1Cache vào file: ${err.message}`);
  }

  return entry;
}

// Lấy nến 1m incremental — lần đầu fetch toàn bộ, sau đó chỉ fetch nến mới
async function fetchM1Incremental(symbol) {
  const startMs = monthStartMs();
  let cache = _m1Cache[symbol];

  // Reset khi sang tháng mới
  if (!cache || cache.monthStart !== startMs) {
    cache = { monthStart: startMs, candles: [], cursor: startMs };
    _m1Cache[symbol] = cache;
  }

  const LIMIT = 1500;
  const fetched = [];
  let cursor = cache.cursor;

  // Fetch từ cursor (overlap nến cuối để bắt update của nến đang hình thành)
  while (true) {
    const batch = await fetchBinanceKlines(symbol, '1m', cursor, LIMIT);
    if (!batch.length) break;
    fetched.push(...batch);
    if (batch.length < LIMIT) break;
    cursor = batch[batch.length - 1].openTime + 60_000;
  }

  if (fetched.length > 0) {
    if (cache.candles.length > 0) {
      // Thay thế nến cuối đã cache (có thể là nến chưa hoàn chỉnh) bằng dữ liệu mới
      const lastCachedTime = cache.candles[cache.candles.length - 1].openTime;
      const overlapIdx = fetched.findIndex(c => c.openTime > lastCachedTime);
      if (overlapIdx > 0) {
        cache.candles[cache.candles.length - 1] = fetched[0]; // cập nhật nến cuối
        cache.candles.push(...fetched.slice(overlapIdx));
      } else if (overlapIdx === 0) {
        cache.candles.push(...fetched);
      } else {
        // Toàn bộ fetched là cũ — chỉ cập nhật nến cuối
        cache.candles[cache.candles.length - 1] = fetched[fetched.length - 1];
      }
    } else {
      cache.candles.push(...fetched);
    }
    // cursor = openTime của nến cuối (không +60s → lần sau overlap để refresh nến đang hình thành)
    cache.cursor = cache.candles[cache.candles.length - 1].openTime;
  }

  return cache.candles;
}

// Nến H1 đầu tháng = nến bắt đầu lúc 00:00:00 UTC (múi giờ Binance mặc định).
// Binance dùng UTC cho tất cả klines API — "tháng mới" bắt đầu đúng 00:00 UTC ngày 1.
// June 1 00:00 UTC = 07:00 VN → đây là nến trader thấy trên chart Binance khi bắt đầu tháng mới.

// ─── H4 Yearly Hybrid Functions ──────────────────────────────────────────────

/**
 * Lấy nến H4 đầu tiên của năm 2026 làm mốc gốc (thay H1 đầu tháng).
 * Cache in-memory + file (h4Cache section trong step_sizes.json).
 */
async function fetchH4Reference(symbol) {
  const cached = _h4RefCache[symbol];
  if (cached) return cached.failed ? null : cached;

  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      const fc = (data.h4Cache ?? {})[symbol];
      if (fc?.yearStart === YEAR_START_MS) {
        _h4RefCache[symbol] = fc;
        return fc.failed ? null : fc;
      }
    } catch (err) {
      log.warn(`[369] Lỗi đọc h4Cache từ file: ${err.message}`);
    }
  }

  let candles;
  try {
    candles = await fetchBinanceKlines(symbol, '4h', YEAR_START_MS, 2);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 400) {
      const entry = { yearStart: YEAR_START_MS, failed: true, reason: `Status ${status}` };
      _h4RefCache[symbol] = entry;
      try {
        let data = {};
        if (fs.existsSync(FILE_PATH)) data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        if (!data.h4Cache) data.h4Cache = {};
        data.h4Cache[symbol] = entry;
        fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) { log.warn(`[369] Lỗi ghi h4Cache: ${e.message}`); }
    } else if (status === 418) {
      throw new Error('IP_BANNED_418');
    }
    return null;
  }

  if (!candles?.length || candles[0].openTime !== YEAR_START_MS) {
    const entry = {
      yearStart: YEAR_START_MS,
      failed: true,
      reason: !candles?.length ? 'Không trả về nến H4' : `Nến đầu tiên (${new Date(candles[0].openTime).toISOString()}) không trùng ngày 01/01/2026`
    };
    _h4RefCache[symbol] = entry;
    try {
      let data = {};
      if (fs.existsSync(FILE_PATH)) data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
      if (!data.h4Cache) data.h4Cache = {};
      data.h4Cache[symbol] = entry;
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
      log.system(`[369] Đã đánh dấu lỗi không có nến H4 đầu năm 2026 cho ${symbol}.`);
    } catch (e) { log.warn(`[369] Lỗi ghi h4Cache: ${e.message}`); }
    return null;
  }

  const first = candles[0];
  const openPrice  = first.open;
  const closePrice = first.close;
  const step       = getStep(openPrice);
  const decimals   = getDecimals(openPrice);
  const upperPrice = Math.max(openPrice, closePrice);
  const lowerPrice = Math.min(openPrice, closePrice);

  const entry = { yearStart: YEAR_START_MS, openPrice, closePrice, step, decimals, upperPrice, lowerPrice };
  _h4RefCache[symbol] = entry;
  try {
    let data = {};
    if (fs.existsSync(FILE_PATH)) data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    if (!data.h4Cache) data.h4Cache = {};
    data.h4Cache[symbol] = entry;
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { log.warn(`[369] Lỗi ghi h4Cache: ${e.message}`); }

  return entry;
}

/**
 * Lấy toàn bộ nến H4 đã đóng từ đầu năm 2026 đến H4 hiện tại (incremental).
 * Chỉ gọi API khi có H4 mới đóng (mỗi 4 giờ), cache lại memory.
 */
async function fetchH4Historical(symbol) {
  const H4_MS = 4 * 60 * 60 * 1000;
  const currentH4Start = floorToH4(Date.now());
  let cache = _h4HistCache[symbol];

  if (!cache || cache.yearStart !== YEAR_START_MS) {
    cache = { yearStart: YEAR_START_MS, candles: [], cursor: YEAR_START_MS };
    _h4HistCache[symbol] = cache;
  }

  if (cache.cursor >= currentH4Start) return cache.candles; // Không có H4 mới nào

  let cursor = cache.cursor;
  while (cursor < currentH4Start) {
    const batch = await fetchBinanceKlines(symbol, '4h', cursor, 1500);
    if (!batch.length) break;

    const closed = batch.filter(c => c.openTime < currentH4Start);
    if (cache.candles.length > 0) {
      const lastTime = cache.candles[cache.candles.length - 1].openTime;
      cache.candles.push(...closed.filter(c => c.openTime > lastTime));
    } else {
      cache.candles.push(...closed);
    }

    if (batch.length < 1500 || closed.length < batch.length) break;
    cursor = batch[batch.length - 1].openTime + H4_MS;
  }

  if (cache.candles.length > 0) {
    cache.cursor = cache.candles[cache.candles.length - 1].openTime + H4_MS;
  }

  return cache.candles;
}

/**
 * Lấy nến M1 từ đầu H4 hiện tại đến bây giờ (incremental, reset khi H4 mới mở).
 * Tối đa 240 nến M1 / 4 giờ — 1 API call duy nhất mỗi H4.
 */
async function fetchM1Current(symbol) {
  const currentH4Start = floorToH4(Date.now());
  let cache = _m1CurrCache[symbol];

  if (!cache || cache.h4Start !== currentH4Start) {
    cache = { h4Start: currentH4Start, candles: [], cursor: currentH4Start };
    _m1CurrCache[symbol] = cache;
  }

  const fetched = [];
  let cursor = cache.cursor;
  while (true) {
    const batch = await fetchBinanceKlines(symbol, '1m', cursor, 1500);
    if (!batch.length) break;
    fetched.push(...batch);
    if (batch.length < 1500) break;
    cursor = batch[batch.length - 1].openTime + 60_000;
  }

  if (fetched.length > 0) {
    if (cache.candles.length > 0) {
      const lastTime = cache.candles[cache.candles.length - 1].openTime;
      const overlapIdx = fetched.findIndex(c => c.openTime > lastTime);
      if (overlapIdx > 0) {
        cache.candles[cache.candles.length - 1] = fetched[0];
        cache.candles.push(...fetched.slice(overlapIdx));
      } else if (overlapIdx === 0) {
        cache.candles.push(...fetched);
      } else {
        cache.candles[cache.candles.length - 1] = fetched[fetched.length - 1];
      }
    } else {
      cache.candles.push(...fetched);
    }
    cache.cursor = cache.candles[cache.candles.length - 1].openTime;
  }

  return cache.candles;
}

/**
 * Kết hợp H4 lịch sử (đầu năm → H4 đang mở) + M1 hiện tại (H4 đang mở → bây giờ).
 * Dùng cho analyzeRoundtrips thay thế fetchM1Incremental.
 */
async function fetchHybridCandles(symbol) {
  const h4Candles = await fetchH4Historical(symbol);
  const m1Candles = await fetchM1Current(symbol);
  return [...h4Candles, ...m1Candles];
}

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

// Làm tròn timestamp xuống boundary H4 gần nhất (00:00, 04:00, 08:00, ... UTC)
function floorToH4(tsMs) {
  const H4_MS = 4 * 60 * 60 * 1000;
  return Math.floor(tsMs / H4_MS) * H4_MS;
}

function yearLabel() {
  return String(new Date().getUTCFullYear());
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
  const upTol = upperLevel * TOUCH_TOLERANCE;

  let lastSide = null;  // bên nào được chạm gần nhất (valid)
  let lowerCount = 0;     // số lần valid từ upper → lower
  let upperCount = 0;     // số lần valid từ lower → upper

  for (const c of candles) {
    const hitLower = c.low <= lowerLevel + lolTol;
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
  const month = yearLabel(); // Dùng nhãn năm 2026 thay vì tháng

  try {
    // Lấy nến H4 đầu năm 2026 làm mốc gốc (thay H1 đầu tháng)
    const h1 = await fetchH4Reference(symbol);
    if (!h1) {
      return { signal: 'NONE', symbol, month, reason: 'Không lấy được nến H4 đầu năm 2026' };
    }

    const { openPrice, closePrice, step, decimals, upperPrice, lowerPrice } = h1;

    // Fast pre-check: Nếu có currentPrice, kiểm tra xem có đang sát mốc hay không
    // trước khi gọi fetchHybridCandles (tốn API)
    if (currentPrice !== null) {
      const distTicks = Math.ceil(Math.max(
        Math.abs(upperPrice - currentPrice),
        Math.abs(lowerPrice - currentPrice),
      ) / step);
      const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);
      const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);

      const longEntry = grid.filter(l => l.type === 'tren' && l.value < currentPrice).pop();
      const shortEntry = grid.find(l => l.type === 'duoi' && l.value > currentPrice);

      if (longEntry && shortEntry) {
        const currentGridPct = ((shortEntry.value - longEntry.value) / longEntry.value) * 100;
        if (currentGridPct < GRID_MIN_PCT || currentGridPct > GRID_MAX_PCT) {
          _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: step };
          return {
            signal: 'NONE', symbol, month, openPrice, closePrice, step: step,
            reason: `Khoảng cách giữa 2 mốc gần nhất (${currentGridPct.toFixed(2)}%) không đạt yêu cầu ${GRID_MIN_PCT}-${GRID_MAX_PCT}%`
          };
        }

        const nearTol = currentPrice * NEAR_LEVEL_PCT;
        const nearLong = (currentPrice - longEntry.value) <= nearTol;
        const nearShort = (shortEntry.value - currentPrice) <= nearTol;

        if (!nearLong && !nearShort) {
          _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: step };
          return {
            signal: 'NONE', symbol, month, openPrice, closePrice, step: step,
            reason: `Giá ${currentPrice} đang ở xa các mốc (không chạm)`
          };
        }
      }
    }

    // Hybrid: H4 lịch sử (đầu năm → H4 hiện tại) + M1 (H4 đang mở → bây giờ)
    const hybridCandles = await fetchHybridCandles(symbol);

    if (!hybridCandles.length) {
      return { signal: 'NONE', symbol, month, reason: 'Không lấy được nến phân tích (H4+M1)' };
    }

    const price = currentPrice ?? hybridCandles[hybridCandles.length - 1].close;

    const distTicks = Math.ceil(Math.max(
      Math.abs(upperPrice - price),
      Math.abs(lowerPrice - price),
    ) / step);
    const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);

    const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);

    const longEntry = grid.filter(l => l.type === 'tren' && l.value < price).pop();
    const shortEntry = grid.find(l => l.type === 'duoi' && l.value > price);

    if (!longEntry || !shortEntry) {
      return {
        signal: 'NONE', symbol, month, openPrice, closePrice, step: step,
        reason: `Giá ${price} nằm ngoài vùng lưới mốc`
      };
    }

    _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: step };

    const pairLow = longEntry.value;
    const pairHigh = shortEntry.value;
    const currentGridPct = ((pairHigh - pairLow) / pairLow) * 100;

    if (currentGridPct < GRID_MIN_PCT || currentGridPct > GRID_MAX_PCT) {
      return {
        signal: 'NONE', symbol, month, openPrice, closePrice, step: step,
        reason: `Khoảng cách giữa 2 mốc gần nhất (${currentGridPct.toFixed(2)}%) không đạt yêu cầu ${GRID_MIN_PCT}-${GRID_MAX_PCT}%`
      };
    }

    const done = hybridCandles.slice(0, -1); // bỏ nến M1 đang hình thành (nến cuối)

    const { lowerCount, upperCount, lastSide } =
      analyzeRoundtrips(done, pairLow, pairHigh);

    const touchCountLong = lowerCount;
    const touchCountShort = upperCount;

    const nearTol = price * NEAR_LEVEL_PCT;
    const nearLong = (price - longEntry.value) <= nearTol;
    const nearShort = (shortEntry.value - price) <= nearTol;

    let signal = 'NONE';
    let strength = 'none';
    let targetLevel = null;
    let condLevel = null;
    let touchCount = 0;
    let reason = '';

    if (nearLong && lastSide === 'upper') {
      signal = 'LONG';
      strength = touchCountLong === 0 ? 'strong' : touchCountLong === 1 ? 'medium' : 'weak';
      touchCount = touchCountLong;
      targetLevel = longEntry.value;
      condLevel = shortEntry.value;
      reason = `[369] LONG lần ${touchCountLong + 1} tại ${longEntry.value} ← từ ${shortEntry.value} (${strength})`;
    }

    if (nearShort && lastSide === 'lower' && signal === 'NONE') {
      signal = 'SHORT';
      strength = touchCountShort === 0 ? 'strong' : touchCountShort === 1 ? 'medium' : 'weak';
      touchCount = touchCountShort;
      targetLevel = shortEntry.value;
      condLevel = longEntry.value;
      reason = `[369] SHORT lần ${touchCountShort + 1} tại ${shortEntry.value} ← từ ${longEntry.value} (${strength})`;
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
      step: step,
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
        .filter(l => Math.abs(l.value - price) < step * 5.5)
        .map(l => ({ value: l.value, type: l.type, tier: l.tier })),
    };

  } catch (err) {
    const status = err?.response?.status;
    if (status === 400) {
      // 400: symbol không hợp lệ → đánh dấu vào h4Cache để không gọi lại
      const entry = { yearStart: YEAR_START_MS, failed: true, reason: `Status ${status}` };
      _h4RefCache[symbol] = entry;
      try {
        let data = {};
        if (fs.existsSync(FILE_PATH)) data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        if (!data.h4Cache) data.h4Cache = {};
        data.h4Cache[symbol] = entry;
        fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        log.warn(`[369] Đánh dấu lỗi ${status} cho ${symbol} vào h4Cache.`);
      } catch (e) {
        log.warn(`[369] Lỗi ghi h4Cache cho ${symbol}: ${e.message}`);
      }
    }
    // 418: IP bị ban tạm thời — KHÔNG ghi file, throw để dừng init
    if (status === 418) throw new Error('IP_BANNED_418');
    const is429 = status === 429;
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
  const CONCURRENCY = 3;
  const map = {};

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(sym => get369Signal(sym, taMap[sym]?.price ?? null))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      map[batch[j]] = r.status === 'fulfilled'
        ? r.value
        : { signal: 'NONE', symbol: batch[j], reason: r.reason?.message ?? 'unknown' };
    }
  }

  // Gửi Telegram khi có tín hiệu LONG hoặc SHORT mới
  const activeSignals = Object.values(map).filter(s => s.signal === 'LONG' || s.signal === 'SHORT');
  if (activeSignals.length > 0) {
    notifySignals(activeSignals).catch(() => {}); // fire-and-forget, không chặn luồng chính
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
      : sig369.strength === 'weak' ? 1
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

function getLevelCache() {
  if (Object.keys(_levelCache).length === 0 && fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);

      // Ưu tiên h4Cache (năm 2026), fallback h1Cache (legacy tháng)
      const useH4 = !!(data.h4Cache && Object.keys(data.h4Cache).length > 0);
      const refCache = useH4 ? (data.h4Cache || {}) : (data.h1Cache || {});

      for (const [symbol, entry] of Object.entries(refCache)) {
        const isValid = useH4
          ? (entry.yearStart === YEAR_START_MS && !entry.failed)
          : (entry.monthStart === monthStartMs() && !entry.failed);

        if (!isValid) continue;

        if (useH4) _h4RefCache[symbol] = entry;
        else _h1Cache[symbol] = entry;

        const { upperPrice, lowerPrice, step, decimals } = entry;
        const price = entry.closePrice;
        const distTicks = Math.ceil(Math.max(
          Math.abs(upperPrice - price),
          Math.abs(lowerPrice - price),
        ) / step);
        const levelsRange = Math.max(LEVELS_RANGE, distTicks + 5);
        const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);
        const longEntry  = grid.filter(l => l.type === 'tren' && l.value < price).pop();
        const shortEntry = grid.find(l => l.type === 'duoi' && l.value > price);
        if (longEntry && shortEntry) {
          _levelCache[symbol] = { longEntry: longEntry.value, shortEntry: shortEntry.value, step: step };
        }
      }
    } catch (err) {
      log.warn(`[369] Không thể pre-populate level cache: ${err.message}`);
    }
  }
  return _levelCache;
}

async function initH1Cache(symbols) {
  const startMs = monthStartMs();
  const missing = [];

  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      const h1Cache = data.h1Cache || {};
      for (const sym of symbols) {
        if (!h1Cache[sym] || h1Cache[sym].monthStart !== startMs) {
          missing.push(sym);
        }
      }
    } catch (_) {
      missing.push(...symbols);
    }
  } else {
    missing.push(...symbols);
  }

  if (missing.length === 0) return;
  log.system(`[369] initH1Cache: ${missing.length} coin chưa có nến H1 đầu tháng.`);
  for (let i = 0; i < missing.length; i++) {
    const sym = missing[i];
    try { await fetchH1Cached(sym); } catch (e) {
      log.warn(`[369] Lỗi init H1 cho ${sym}: ${e.message}`);
      if (e.message === 'IP_BANNED_418') { log.error('[369] Bị ban 418, dừng initH1Cache.'); break; }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  log.system(`[369] Hoàn tất initH1Cache.`);
}

/**
 * Nạp nến H4 đầu năm 2026 cho danh sách symbols vào cache.
 * Dùng thay initH1Cache khi chạy theo phương pháp H4 yearly.
 * Delay 200ms/coin để tránh 418 ban.
 */
async function initH4Cache(symbols) {
  const missing = [];

  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      const h4Cache = data.h4Cache || {};
      for (const sym of symbols) {
        if (!h4Cache[sym] || h4Cache[sym].yearStart !== YEAR_START_MS) {
          missing.push(sym);
        }
      }
    } catch (_) {
      missing.push(...symbols);
    }
  } else {
    missing.push(...symbols);
  }

  if (missing.length === 0) {
    log.system(`[369] initH4Cache: Tất cả ${symbols.length} coin đã có nến H4 đầu năm.`);
    return;
  }

  log.system(`[369] initH4Cache: Cần nạp H4 cho ${missing.length}/${symbols.length} coin (delay 200ms/coin)...`);

  for (let i = 0; i < missing.length; i++) {
    const sym = missing[i];
    try {
      await fetchH4Reference(sym);
    } catch (e) {
      log.warn(`[369] Lỗi init H4 cho ${sym}: ${e.message}`);
      if (e.message === 'IP_BANNED_418') {
        log.error('[369] Bị ban IP 418 — dừng initH4Cache ngay.');
        break;
      }
    }
    // 200ms delay — đủ để tránh 418 (10 req/2s = 5 req/s, an toàn)
    await new Promise(r => setTimeout(r, 200));
  }
  log.system(`[369] Hoàn tất initH4Cache.`);
}

module.exports = {
  get369Signal, get369SignalsForCoins, score369Method, format369ForPrompt,
  getLevelCache, PROXIMITY_PCT, getDecimals, getStep,
  initH1Cache, initH4Cache, YEAR_START_MS,
  getGridStepPct, isGridWidthValid, GRID_MIN_PCT, GRID_MAX_PCT,
};
