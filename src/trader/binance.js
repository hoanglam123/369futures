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

// ─── Signing helpers ──────────────────────────────────────────────────────────

function _buildBody(params) {
  return new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
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

// ─── Exchange info (không cần auth) ──────────────────────────────────────────

async function loadStepSizes() {
  if (fs.existsSync(FILE_PATH)) {
    try {
      const content = fs.readFileSync(FILE_PATH, 'utf8');
      const data = JSON.parse(content);
      if (data.stepSizes) {
        log.system(`[Binance] Loaded step sizes from existing file: ${Object.keys(data.stepSizes).length} symbols`);
        return;
      }
    } catch (err) {
      log.warn(`[Binance] Lỗi đọc file step_sizes.json cũ: ${err.message}. Tiến hành tải mới.`);
    }
  }

  const res = await axios.get(`${BASE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
  const stepSizes = {};
  for (const s of res.data.symbols) {
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    if (lot) stepSizes[s.symbol] = parseFloat(lot.stepSize);
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
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  log.system(`[Binance] Loaded and saved step sizes to file: ${Object.keys(stepSizes).length} symbols`);
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
      return _post('/fapi/v1/order', {
        symbol: `${symbol}USDT`,
        side,
        type: 'LIMIT',
        quantity: qty,
        price: price.toFixed(decimals),
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
     * Kiểm tra có vị thế mở không (positionAmt != 0).
     */
    async hasOpenPosition(symbol) {
      const data = await _get('/fapi/v2/positionRisk', { symbol: `${symbol}USDT` }, apiKey, secret);
      return data.some(p => parseFloat(p.positionAmt) !== 0);
    },

    calcQuantity,
  };
}

module.exports = { createClient, loadStepSizes, calcQuantity };
