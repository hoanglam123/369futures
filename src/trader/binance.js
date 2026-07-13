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

const BASE = 'https://fapi.binance.com';
const FILE_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');

let timeOffset = 0;

async function syncTimeOffset() {
  try {
    const res = await axios.get(`${BASE}/fapi/v1/time`, { timeout: 5000 });
    const serverTime = res.data.serverTime;
    timeOffset = serverTime - Date.now();
    log.system(`[Binance] Đã đồng bộ giờ: offset = ${timeOffset}ms (Giờ server: ${new Date(serverTime).toISOString()})`);
  } catch (err) {
    log.warn(`[Binance] Không thể đồng bộ giờ: ${err.message}`);
  }
}

// Chạy đồng bộ giờ ngay khi load module
syncTimeOffset().catch(() => {});

function _buildBody(params) {
  const timestamp = Date.now() + timeOffset;
  return new URLSearchParams({ ...params, timestamp, recvWindow: 10000 }).toString();
}

function _sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function _authHeaders(apiKey) {
  return { 'X-MBX-APIKEY': apiKey };
}

async function _post(path, params, apiKey, secret) {
  const body = _buildBody(params);
  const sig = _sign(body, secret);
  const res = await axios.post(`${BASE}${path}`, `${body}&signature=${sig}`, {
    headers: { ..._authHeaders(apiKey), 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  return res.data;
}

async function _get(path, params, apiKey, secret) {
  const body = _buildBody(params);
  const sig = _sign(body, secret);
  const res = await axios.get(`${BASE}${path}?${body}&signature=${sig}`, {
    headers: _authHeaders(apiKey),
    timeout: 10000,
  });
  return res.data;
}

async function _delete(path, params, apiKey, secret) {
  const body = _buildBody(params);
  const sig = _sign(body, secret);
  const res = await axios.delete(`${BASE}${path}?${body}&signature=${sig}`, {
    headers: _authHeaders(apiKey),
    timeout: 10000,
  });
  return res.data;
}

// ─── Exchange info (không cần auth) ──────────────────────────────────────────

async function loadStepSizes() {
  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      if (data.stepSizes && data.tickSizes) {
        log.system(`[Binance] Loaded step and tick sizes from existing file: ${Object.keys(data.stepSizes).length} symbols`);
        return;
      }
    } catch (err) {
      log.warn(`[Binance] Lỗi đọc file step_sizes.json cũ: ${err.message}. Tiến hành tải mới.`);
    }
  }

  const res = await axios.get(`${BASE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
  const stepSizes = {};
  const tickSizes = {};
  for (const s of res.data.symbols) {
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    if (lot) stepSizes[s.symbol] = parseFloat(lot.stepSize);

    const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    if (priceFilter) tickSizes[s.symbol] = parseFloat(priceFilter.tickSize);
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

  // Nếu file cũ có dạng root level (chứa BTCUSDT trực tiếp), làm sạch để chuyển sang dạng mới
  if (data.BTCUSDT) {
    data = { h1Cache: data.h1Cache ?? {} };
  }

  data.stepSizes = stepSizes;
  data.tickSizes = tickSizes;
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  log.system(`[Binance] Loaded and saved step/tick sizes to file: ${Object.keys(stepSizes).length} symbols`);
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

function calcQuantity(symbol, notional, price) {
  let stepSize = 0.001;
  try {
    if (fs.existsSync(FILE_PATH)) {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      const stepSizes = data.stepSizes ?? {};
      stepSize = stepSizes[`${symbol}USDT`] ?? 0.001;
    }
  } catch (err) {
    log.warn(`[Binance] Lỗi đọc file step_sizes.json: ${err.message}`);
  }
  const raw = notional / price;
  const qty = Math.floor(raw / stepSize) * stepSize;
  const dec = Math.max(0, Math.round(-Math.log10(stepSize)));
  return { qty: parseFloat(qty.toFixed(dec)), stepSize };
}

// ─── Public client factory ────────────────────────────────────────────────────

function createClient(apiKey, secret) {
  return {
    /**
     * Set đòn bẩy cho 1 symbol trước khi đặt lệnh.
     */
    setLeverage(symbol, leverage) {
      return _post('/fapi/v1/leverage', { symbol: `${symbol}USDT`, leverage }, apiKey, secret);
    },

    /**
     * Đặt lệnh LIMIT GTC tại mức giá cụ thể.
     * @param {string} symbol   - Không có USDT, ví dụ 'BTC'
     * @param {string} side     - 'BUY' | 'SELL'
     * @param {number} qty      - Số lượng đã quantize
     * @param {number} price    - Giá limit
     * @param {number} decimals - Số decimal của price trên Binance
     */
    placeLimit(symbol, side, qty, price, decimals) {
      let tickSize = null;
      try {
        if (fs.existsSync(FILE_PATH)) {
          const content = fs.readFileSync(FILE_PATH, 'utf8');
          const data = JSON.parse(content);
          const tickSizes = data.tickSizes ?? {};
          tickSize = tickSizes[`${symbol}USDT`] ?? null;
        }
      } catch (_) {}

      let finalPriceStr;
      if (tickSize) {
        const roundedPrice = Math.round(price / tickSize) * tickSize;
        const dec = Math.max(0, Math.round(-Math.log10(tickSize)));
        finalPriceStr = roundedPrice.toFixed(dec);
      } else {
        finalPriceStr = price.toFixed(decimals);
      }

      return _post('/fapi/v1/order', {
        symbol: `${symbol}USDT`,
        side,
        type: 'LIMIT',
        quantity: qty,
        price: finalPriceStr,
        timeInForce: 'GTC',
        positionSide: 'BOTH',
      }, apiKey, secret);
    },

    /**
     * Đặt lệnh MARKET — execute ngay tại giá hiện tại.
     */
    placeMarket(symbol, side, qty) {
      return _post('/fapi/v1/order', {
        symbol: `${symbol}USDT`,
        side,
        type: 'MARKET',
        quantity: qty,
        positionSide: 'BOTH',
      }, apiKey, secret);
    },

    /**
     * Đặt lệnh Stop Market (SL) hoặc Take Profit Market (TP) với closePosition=true.
     */
    placeStopOrder(symbol, side, type, stopPrice) {
      let tickSize = null;
      try {
        if (fs.existsSync(FILE_PATH)) {
          const content = fs.readFileSync(FILE_PATH, 'utf8');
          const data = JSON.parse(content);
          const tickSizes = data.tickSizes ?? {};
          tickSize = tickSizes[`${symbol}USDT`] ?? null;
        }
      } catch (_) {}

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
      const data = await _get('/fapi/v2/positionRisk', {}, apiKey, secret);
      return data.filter(p => parseFloat(p.positionAmt) !== 0);
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
     * Hủy lệnh theo orderId.
     */
    cancelOrder(symbol, orderId) {
      return _delete('/fapi/v1/order', { symbol: `${symbol}USDT`, orderId }, apiKey, secret);
    },

    /**
     * Kiểm tra có vị thế mở không (positionAmt != 0).
     */
    async hasOpenPosition(symbol) {
      const data = await _get('/fapi/v2/positionRisk', { symbol: `${symbol}USDT` }, apiKey, secret);
      return data.some(p => parseFloat(p.positionAmt) !== 0);
    },

    calcQuantity,
  };
}

module.exports = { createClient, loadStepSizes, loadLeverageBrackets, calcQuantity };
