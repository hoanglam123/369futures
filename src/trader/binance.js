'use strict';

/**
 * Binance Futures REST client — ký HMAC-SHA256, hỗ trợ đặt lệnh và tra cứu vị thế.
 * Tất cả lệnh dùng positionSide=BOTH (one-way mode, mặc định Binance).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('../pp369/_logger');

const { isIpBanned, triggerCircuitBreaker, checkCircuitBreaker, setOnUnbanCallback } = require('./circuitBreaker');

const BASE = 'https://fapi.binance.com';
const FILE_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');

let timeOffset = 0;

async function syncTimeOffset(verbose = false) {
  if (isIpBanned()) return;
  try {
    const t0 = Date.now();
    const res = await axios.get(`${BASE}/fapi/v1/time`, { timeout: 10000 });
    const t1 = Date.now();
    const serverTime = res.data.serverTime;
    // Bù trừ độ trễ mạng RTT (Round-Trip Time):
    // Thời điểm Binance ghi nhận serverTime nằm giữa thời gian gửi request (t0) và nhận response (t1)
    const rtt = t1 - t0;
    timeOffset = Math.round(serverTime - (t0 + t1) / 2);
    // if (verbose || Math.abs(timeOffset) > 1000) {
    //   log.system(`[Binance] Đã đồng bộ giờ: offset = ${timeOffset}ms (Giờ server: ${new Date(serverTime).toISOString()}, RTT: ${rtt}ms)`);
    // }
  } catch (err) {
    if (err?.response?.status === 418 || err?.response?.data?.code === -1003) {
      triggerCircuitBreaker(err, 'BinanceTimeSync');
    } else {
      log.warn(`[Binance] Không thể đồng bộ giờ: ${err.message}`);
    }
  }
}

// Khi vừa hết phạt IP, tự động kích hoạt đồng bộ giờ lại lập tức
setOnUnbanCallback(() => {
  syncTimeOffset(true).catch(() => { });
});

// Chạy đồng bộ giờ ngay khi load module
syncTimeOffset().catch(() => { });
// Đồng bộ lại thời gian mỗi 3 phút để triệt tiêu lệch giờ (drift) khi ứng dụng chạy lâu dài
setInterval(() => syncTimeOffset().catch(() => { }), 3 * 60 * 1000);

function _buildBody(params) {
  const timestamp = Date.now() + timeOffset;
  return new URLSearchParams({ ...params, timestamp, recvWindow: 30000 }).toString();
}

function _sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function _authHeaders(apiKey) {
  return { 'X-MBX-APIKEY': apiKey };
}

async function _requestWithRetry(fn) {
  checkCircuitBreaker();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const data = err.response?.data;
      const status = err.response?.status;

      if (status === 418 || data?.code === -1003) {
        triggerCircuitBreaker(err, 'Binance');
        checkCircuitBreaker(); // Throw [IP_BAN_CIRCUIT_BREAKER] error immediately
      }

      if (status === 429) {
        triggerCircuitBreaker(err, 'Binance 429');
        checkCircuitBreaker(); // Throw [RATE_LIMIT_THROTTLE] error immediately
      }

      if (data && data.code === -1021) {
        log.system(`[Binance] Lỗi -1021 (Timestamp outside recvWindow). Đang tự động đồng bộ lại giờ và thử lại (Lần ${attempt + 1}/3)...`);
        await syncTimeOffset(true);
        if (attempt < 2) {
          continue;
        }
      }

      const isNetworkErr = !err.response || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH';
      if (isNetworkErr && attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
}

// Giữ nguyên các ID số nguyên >= 16 chữ số (orderId/algoId 19 chữ số) dạng chuỗi để tránh mất độ chính xác float64
function safeJsonParse(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    const preserved = raw.replace(/"(orderId|algoId|id)":\s*(\d{16,})/g, '"$1":"$2"');
    return JSON.parse(preserved);
  } catch {
    return raw;
  }
}

async function _post(path, params, apiKey, secret) {
  // Gắn clientOrderId / clientAlgoId cố định TRƯỚC vòng retry để chống nhân đôi lệnh khi rớt mạng (idempotency)
  const safeParams = { ...params };
  if (path === '/fapi/v1/order' && !safeParams.newClientOrderId) {
    safeParams.newClientOrderId = `bh4_${crypto.randomBytes(8).toString('hex')}`;
  } else if (path === '/fapi/v1/algoOrder' && !safeParams.clientAlgoId) {
    safeParams.clientAlgoId = `bh4a_${crypto.randomBytes(8).toString('hex')}`;
  }
  return _requestWithRetry(async () => {
    const body = _buildBody(safeParams);
    const sig = _sign(body, secret);
    const res = await axios.post(`${BASE}${path}`, `${body}&signature=${sig}`, {
      headers: { ..._authHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
      transformResponse: [safeJsonParse],
    });
    return res.data;
  });
}

async function _get(path, params, apiKey, secret) {
  return _requestWithRetry(async () => {
    const body = _buildBody(params);
    const sig = _sign(body, secret);
    const res = await axios.get(`${BASE}${path}?${body}&signature=${sig}`, {
      headers: _authHeaders(apiKey),
      timeout: 10000,
      transformResponse: [safeJsonParse],
    });
    return res.data;
  });
}

async function _delete(path, params, apiKey, secret) {
  return _requestWithRetry(async () => {
    const body = _buildBody(params);
    const sig = _sign(body, secret);
    const res = await axios.delete(`${BASE}${path}?${body}&signature=${sig}`, {
      headers: _authHeaders(apiKey),
      timeout: 10000,
      transformResponse: [safeJsonParse],
    });
    return res.data;
  });
}

// ─── Exchange info (không cần auth) ──────────────────────────────────────────

let _stepSizesCache = {};
let _tickSizesCache = {};
let _minQtysCache = {};
let _minNotionalsCache = {};

function _loadFiltersFromDiskSync() {
  try {
    if (fs.existsSync(FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
      _stepSizesCache = data.stepSizes || {};
      _tickSizesCache = data.tickSizes || {};
      _minQtysCache = data.minQtys || {};
      _minNotionalsCache = data.minNotionals || {};
    }
  } catch (_) {}
}

function getSymbolTickSizeSync(symbol) {
  const symUsdt = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
  if (_tickSizesCache[symUsdt]) return _tickSizesCache[symUsdt];
  _loadFiltersFromDiskSync();
  return _tickSizesCache[symUsdt] || null;
}

function getSymbolStepSizeSync(symbol) {
  const symUsdt = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
  if (_stepSizesCache[symUsdt]) return _stepSizesCache[symUsdt];
  _loadFiltersFromDiskSync();
  return _stepSizesCache[symUsdt] || null;
}

async function loadStepSizes(forceRefresh = false) {
  if (isIpBanned()) return;
  if (!forceRefresh && fs.existsSync(FILE_PATH)) {
    try {
      const stat = fs.statSync(FILE_PATH);
      const isFresh = (Date.now() - stat.mtimeMs) < 12 * 3600 * 1000; // Tươi mới trong 12h
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      if (isFresh && data.stepSizes && data.tickSizes && Object.keys(data.stepSizes).length > 100) {
        _stepSizesCache = data.stepSizes;
        _tickSizesCache = data.tickSizes;
        _minQtysCache = data.minQtys || {};
        _minNotionalsCache = data.minNotionals || {};
        log.system(`[Binance] Loaded step and tick sizes from existing file: ${Object.keys(data.stepSizes).length} symbols`);
        return;
      }
    } catch (err) {
      log.warn(`[Binance] Lỗi đọc file step_sizes.json cũ: ${err.message}. Tiến hành tải mới.`);
    }
  }

  try {
    const res = await axios.get(`${BASE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
    const stepSizes = {};
    const tickSizes = {};
    const minQtys = {};
    const minNotionals = {};
    for (const s of res.data.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING') continue;
      const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
      if (lot) {
        stepSizes[s.symbol] = parseFloat(lot.stepSize);
        if (lot.minQty) minQtys[s.symbol] = parseFloat(lot.minQty);
      }

      const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
      if (priceFilter) tickSizes[s.symbol] = parseFloat(priceFilter.tickSize);

      const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
      if (notionalFilter) {
        const mn = parseFloat(notionalFilter.notional || notionalFilter.minNotional || 0);
        if (mn > 0) minNotionals[s.symbol] = mn;
      }
    }
    const dir = path.dirname(FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let data = {};
    try {
      if (fs.existsSync(FILE_PATH)) {
        data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
      }
    } catch (_) { }

    data.stepSizes = stepSizes;
    data.tickSizes = tickSizes;
    data.minQtys = minQtys;
    data.minNotionals = minNotionals;
    data.lastUpdated = Date.now();
    data.lastUpdatedStr = new Date().toISOString();
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    _stepSizesCache = stepSizes;
    _tickSizesCache = tickSizes;
    _minQtysCache = minQtys;
    _minNotionalsCache = minNotionals;
    log.system(`[Binance] Loaded and saved step/tick sizes to file: ${Object.keys(stepSizes).length} symbols`);
  } catch (err) {
    log.warn(`[Binance] Lỗi cập nhật exchangeInfo step/tick sizes: ${err.message}`);
  }
}

// ─── Leverage brackets (cần auth) ────────────────────────────────────────────

/**
 * Lấy max leverage cho danh sách symbols từ /fapi/v1/leverageBracket.
 * Chỉ lấy 1 lần cho tất cả symbols rồi lọc — tránh gọi API nhiều lần.
 *
 * Kết quả lưu vào step_sizes.json dạng:
 *   "leverageInfo": { "BTC": 125, "ETH": 75, "SOL": 50, ... }
 *
 * @param {string[]} symbols - Danh sách coin (không có USDT), ví dụ ['BTC', 'ETH']
 * @param {string}   apiKey
 * @param {string}   secret
 */
async function loadLeverageBrackets(symbols, apiKey, secret) {
  if (isIpBanned()) return {};
  if (!apiKey || !secret) {
    log.system(`[Binance] Không có BINANCE_API_KEY/SECRET — bỏ qua tải leverage brackets.`);
    return {};
  }
  log.system(`[Binance] Đang lấy leverage brackets cho ${symbols.length} coin...`);

  let allBrackets;
  try {
    // Gọi 1 lần không có symbol param → trả về tất cả symbols
    allBrackets = await _get('/fapi/v1/leverageBracket', {}, apiKey, secret);
  } catch (err) {
    log.warn(`[Binance] Lỗi lấy leverage brackets: ${err.message}`);
    return {};
  }

  // Build lookup: symbol → maxLeverage (bracket[0] luôn là bracket nhỏ nhất = max leverage)
  const lookup = {};
  for (const item of allBrackets) {
    const sym = item.symbol?.replace('USDT', '');
    if (sym && item.brackets?.length > 0) {
      lookup[sym] = item.brackets[0].initialLeverage;
    }
  }

  // Chỉ giữ các symbol trong danh sách đã lọc
  const leverageInfo = {};
  for (const sym of symbols) {
    if (lookup[sym] != null) {
      leverageInfo[sym] = lookup[sym];
    }
  }

  // Lưu vào step_sizes.json
  try {
    let data = {};
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    data.leverageInfo = leverageInfo;
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    log.system(`[Binance] Đã lưu leverage cho ${Object.keys(leverageInfo).length} coin vào step_sizes.json`);
  } catch (err) {
    log.warn(`[Binance] Lỗi ghi leverageInfo vào file: ${err.message}`);
  }

  return leverageInfo;
}

// ─── Quantity helper ──────────────────────────────────────────────────────────

function _getStepSizeCached(symbol) {
  return getSymbolStepSizeSync(symbol) ?? 0.001;
}

function calcQuantity(symbol, notional, price) {
  if (!price || price <= 0) return { qty: 0, stepSize: 0.001 };
  const symUsdt = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
  const stepSize = _getStepSizeCached(symbol);
  const raw = notional / price;
  const qty = Math.floor(raw / stepSize) * stepSize;
  const dec = Math.max(0, Math.round(-Math.log10(stepSize)));
  const finalQty = parseFloat(qty.toFixed(dec));

  // Kiểm tra minQty và minNotional nếu có trong cache exchangeInfo
  const minQty = _minQtysCache[symUsdt] || 0;
  const minNotional = _minNotionalsCache[symUsdt] || 0;
  if (minQty > 0 && finalQty < minQty) {
    return { qty: 0, stepSize, reason: `BELOW_MIN_QTY (${finalQty} < ${minQty})` };
  }
  if (minNotional > 0 && finalQty * price < minNotional) {
    return { qty: 0, stepSize, reason: `BELOW_MIN_NOTIONAL (${(finalQty * price).toFixed(2)} < ${minNotional})` };
  }
  return { qty: finalQty, stepSize };
}

// ─── Public client factory ────────────────────────────────────────────────────

function createClient(apiKey, secret) {
  let _posCache = null;
  let _posCacheTime = 0;
  let _balanceCache = null;
  let _balanceCacheTime = 0;
  let _accountCache = null;
  let _accountCacheTime = 0;
  let _incomeCache = null;
  let _incomeCacheTime = 0;
  const _appliedLeverageCache = new Map();

  return {
    /**
     * Lấy số dư khả dụng USDT từ Binance Futures (RAM cache 30s)
     */
    async getBalance() {
      const now = Date.now();
      if (_balanceCache !== null && (now - _balanceCacheTime < 30000)) {
        return _balanceCache;
      }
      try {
        const balances = await _get('/fapi/v2/balance', {}, apiKey, secret);
        const usdt = (Array.isArray(balances) ? balances : []).find(b => b.asset === 'USDT');
        const avail = parseFloat(usdt?.availableBalance || usdt?.balance || '0');
        _balanceCache = avail;
        _balanceCacheTime = now;
        return avail;
      } catch (err) {
        log.warn(`[Binance] getBalance failed: ${err.message}`);
        return _balanceCache !== null ? _balanceCache : 0;
      }
    },

    /**
     * Lấy tổng quan tài khoản Binance Futures (Số dư ví, Equity, Khả dụng, PnL chưa chốt — cache 20s)
     */
    async getAccountSummary() {
      const now = Date.now();
      if (_accountCache && (now - _accountCacheTime < 20000)) {
        return _accountCache;
      }
      try {
        const acc = await _get('/fapi/v2/account', {}, apiKey, secret);
        const openPos = Array.isArray(acc?.positions)
          ? acc.positions.filter(p => parseFloat(p.positionAmt) !== 0).length
          : 0;
        const summary = {
          connected: true,
          apiKeySuffix: apiKey ? apiKey.slice(-4) : '',
          walletBalance: parseFloat(parseFloat(acc?.totalWalletBalance || '0').toFixed(2)),
          availableBalance: parseFloat(parseFloat(acc?.availableBalance || '0').toFixed(2)),
          totalMarginBalance: parseFloat(parseFloat(acc?.totalMarginBalance || '0').toFixed(2)),
          totalUnrealizedProfit: parseFloat(parseFloat(acc?.totalUnrealizedProfit || '0').toFixed(2)),
          totalPositionInitialMargin: parseFloat(parseFloat(acc?.totalPositionInitialMargin || '0').toFixed(2)),
          openPositionsCount: openPos,
          fetchedAt: new Date(now).toISOString(),
        };
        _accountCache = summary;
        _accountCacheTime = now;
        return summary;
      } catch (err) {
        log.warn(`[Binance] getAccountSummary failed: ${err.message}`);
        return _accountCache || { connected: false, error: err.message };
      }
    },

    /**
     * Lấy lịch sử PnL thực tế đã chốt (REALIZED_PNL) từ Binance Futures (cache 60s)
     */
    async getRealizedIncome(limit = 100) {
      const now = Date.now();
      if (_incomeCache && (now - _incomeCacheTime < 60000)) {
        return _incomeCache;
      }
      try {
        const rows = await _get('/fapi/v1/income', { incomeType: 'REALIZED_PNL', limit }, apiKey, secret);
        _incomeCache = Array.isArray(rows) ? rows : [];
        _incomeCacheTime = now;
        return _incomeCache;
      } catch (err) {
        log.warn(`[Binance] getRealizedIncome failed: ${err.message}`);
        return _incomeCache || [];
      }
    },

    /**
     * Set đòn bẩy cho 1 symbol trước khi đặt lệnh (có cache chống gọi trùng API).
     */
    async setLeverage(symbol, leverage) {
      if (_appliedLeverageCache.get(symbol) === leverage) {
        return { symbol: `${symbol}USDT`, leverage, cached: true };
      }
      const res = await _post('/fapi/v1/leverage', { symbol: `${symbol}USDT`, leverage }, apiKey, secret);
      _appliedLeverageCache.set(symbol, leverage);
      return res;
    },

    /**
     * Đặt lệnh LIMIT GTC tại mức giá cụ thể.
     * @param {string} symbol   - Không có USDT, ví dụ 'BTC'
     * @param {string} side     - 'BUY' | 'SELL'
     * @param {number} qty      - Số lượng đã quantize
     * @param {number} price    - Giá limit
     * @param {number} decimals - Số decimal của price trên Binance
     * @param {boolean} [reduceOnly=false] - Nếu true, chỉ giảm vị thế (dùng cho Limit TP)
     */
    placeLimit(symbol, side, qty, price, decimals, reduceOnly = false) {
      const tickSize = getSymbolTickSizeSync(symbol);

      let finalPriceStr;
      if (tickSize) {
        const roundedPrice = Math.round(price / tickSize) * tickSize;
        const dec = Math.max(0, Math.round(-Math.log10(tickSize)));
        finalPriceStr = roundedPrice.toFixed(dec);
      } else {
        finalPriceStr = price.toFixed(decimals);
      }

      const params = {
        symbol: `${symbol}USDT`,
        side,
        type: 'LIMIT',
        quantity: qty,
        price: finalPriceStr,
        timeInForce: 'GTC',
        positionSide: 'BOTH',
      };
      if (reduceOnly) {
        params.reduceOnly = 'true';
      }

      return _post('/fapi/v1/order', params, apiKey, secret);
    },

    /**
     * Lấy thông tin trạng thái 1 lệnh cụ thể theo orderId.
     */
    getOrder(symbol, orderId) {
      return _get('/fapi/v1/order', { symbol: `${symbol}USDT`, orderId }, apiKey, secret);
    },

    /**
     * Lấy thông tin trạng thái 1 lệnh Algo cụ thể theo algoId.
     */
    getAlgoOrder(symbol, algoId) {
      return _get('/fapi/v1/algoOrder', { symbol: `${symbol}USDT`, algoId }, apiKey, secret);
    },

    /**
     * Đặt lệnh MARKET — execute ngay tại giá hiện tại.
     * @param {string} symbol - Không có USDT
     * @param {string} side - 'BUY' | 'SELL'
     * @param {number} qty - Số lượng
     * @param {boolean} [reduceOnly=false] - Nếu true, lệnh chỉ giảm vị thế hiện tại, không mở vị thế mới
     */
    placeMarket(symbol, side, qty, reduceOnly = false) {
      _posCache = null;
      _posCacheTime = 0;
      const params = {
        symbol: `${symbol}USDT`,
        side,
        type: 'MARKET',
        quantity: qty,
        positionSide: 'BOTH',
      };
      if (reduceOnly) {
        params.reduceOnly = 'true';
      }
      return _post('/fapi/v1/order', params, apiKey, secret);
    },

    /**
     * Xóa cache vị thế để lần gọi tiếp theo bắt buộc lấy dữ liệu tươi từ Binance REST API.
     */
    invalidatePositionCache() {
      _posCache = null;
      _posCacheTime = 0;
    },

    /**
     * Đặt lệnh Stop Market (SL) hoặc Take Profit Market (TP) với closePosition=true.
     */
    placeStopOrder(symbol, side, type, stopPrice) {
      const tickSize = getSymbolTickSizeSync(symbol);

      let finalStopPriceStr;
      if (tickSize) {
        const roundedPrice = Math.round(stopPrice / tickSize) * tickSize;
        const dec = Math.max(0, Math.round(-Math.log10(tickSize)));
        finalStopPriceStr = roundedPrice.toFixed(dec);
      } else {
        finalStopPriceStr = stopPrice.toFixed(5); // fallback
      }

      return _post('/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol: `${symbol}USDT`,
        side,
        type,
        triggerPrice: finalStopPriceStr,
        closePosition: 'true',
        positionSide: 'BOTH',
      }, apiKey, secret);
    },

    /**
     * Lấy danh sách lệnh Algo đang chờ của 1 symbol (hoặc toàn bộ nếu không truyền).
     */
    getOpenAlgoOrders(symbol) {
      const params = {};
      if (symbol) {
        params.symbol = `${symbol}USDT`;
      }
      return _get('/fapi/v1/openAlgoOrders', params, apiKey, secret);
    },

    /**
     * Hủy lệnh Algo theo algoId.
     */
    cancelAlgoOrder(symbol, algoId) {
      return _delete('/fapi/v1/algoOrder', { symbol: `${symbol}USDT`, algoId }, apiKey, secret);
    },

    /**
     * Lấy danh sách tất cả các vị thế đang mở (positionAmt != 0).
     */
    async getOpenPositions() {
      const now = Date.now();
      if (!_posCache || (now - _posCacheTime > 5000)) {
        _posCache = await _get('/fapi/v2/positionRisk', {}, apiKey, secret);
        _posCacheTime = now;
      }
      return (_posCache || []).filter(p => parseFloat(p.positionAmt) !== 0);
    },

    /**
     * Trả về map đòn bẩy theo symbol (vd { BNB: 5, BTC: 5 }) tận dụng _posCache từ /fapi/v2/positionRisk (0 API weight thêm).
     */
    async getSymbolLeverageMap() {
      const now = Date.now();
      if (!_posCache || (now - _posCacheTime > 15000)) {
        _posCache = await _get('/fapi/v2/positionRisk', {}, apiKey, secret);
        _posCacheTime = now;
      }
      const map = {};
      for (const p of (_posCache || [])) {
        const sym = String(p.symbol || '').replace(/USDT$/i, '');
        const lev = parseFloat(p.leverage || '0');
        if (sym && lev > 0) map[sym] = lev;
      }
      return map;
    },

    /**
     * Lấy danh sách lệnh đang chờ khớp của 1 symbol (hoặc toàn bộ nếu không truyền symbol).
     */
    getOpenOrders(symbol) {
      const params = {};
      if (symbol) {
        params.symbol = `${symbol}USDT`;
      }
      return _get('/fapi/v1/openOrders', params, apiKey, secret);
    },

    /**
     * Lấy lịch sử giao dịch cá nhân gần nhất cho 1 symbol.
     */
    getUserTrades(symbol, limit = 5) {
      return _get('/fapi/v1/userTrades', { symbol: `${symbol}USDT`, limit }, apiKey, secret);
    },

    /**
     * Hủy lệnh theo orderId.
     */
    cancelOrder(symbol, orderId) {
      return _delete('/fapi/v1/order', { symbol: `${symbol}USDT`, orderId }, apiKey, secret);
    },

    /**
     * Hủy tất cả các lệnh LIMIT và STOP thường của 1 symbol.
     */
    cancelAllOpenOrders(symbol) {
      return _delete('/fapi/v1/allOpenOrders', { symbol: `${symbol}USDT` }, apiKey, secret);
    },

    /**
     * Kiểm tra có vị thế mở không (positionAmt != 0).
     */
    async hasOpenPosition(symbol) {
      const now = Date.now();
      if (!_posCache || (now - _posCacheTime > 5000)) {
        _posCache = await _get('/fapi/v2/positionRisk', {}, apiKey, secret);
        _posCacheTime = now;
      }
      const symUsdt = `${symbol}USDT`;
      return (_posCache || []).some(p => p.symbol === symUsdt && parseFloat(p.positionAmt) !== 0);
    },

    calcQuantity,
  };
}

module.exports = {
  createClient,
  loadStepSizes,
  loadLeverageBrackets,
  calcQuantity,
  syncTimeOffset,
  getSymbolTickSizeSync,
  getSymbolStepSizeSync,
};
