'use strict';

/**
 * PP369 Mark Price WebSocket Stream
 *
 * Subscribe Binance markPrice stream cho tất cả coin đang theo dõi.
 * Cập nhật giá mỗi ~3 giây — dùng để lọc coin TRƯỚC khi chạy roundtrip analysis,
 * tránh phải phân tích toàn bộ coin list mỗi phút.
 *
 * Flow:
 *   1. Bot khởi động → start369Stream(symbols)
 *   2. Mỗi 1 phút: getNearbySymbols(levelCache) → chỉ scan coin gần mốc
 *   3. Coin xa mốc (>2%) → bỏ qua, tiết kiệm API call + CPU
 */

const WebSocket = require('ws');
const { log } = require('./_logger');
const axios = require('axios');

const FSTREAM = 'wss://fstream.binance.com/market/stream';
const RECONNECT_DELAY = 5000;

let _ws = null;
let _symbols = [];
let _prices = {};   // { BTC: 95000, ETH: 3200, ... }
let _stopped = false;

const _subscribed = new Set();
let _wsRequestId = 1;

// ─── REST Price update for getNearbySymbols pre-check ────────────────────────
async function updatePricesRest() {
  try {
    const url = 'https://fapi.binance.com/fapi/v1/ticker/price';
    const res = await axios.get(url, { timeout: 10000 });
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        if (item.symbol && item.symbol.endsWith('USDT')) {
          const sym = item.symbol.replace('USDT', '');
          _prices[sym] = parseFloat(item.price);
        }
      }
    }
  } catch (err) {
    log.error(`[PP369Stream] Lỗi lấy giá REST: ${err.message}`);
  }
}

// ─── WebSocket dynamic subscription sync ─────────────────────────────────────
function syncWebSocketSubscriptions(nearbySymbols) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;

  const targetSymbols = new Set(nearbySymbols);
  const toSubscribe = [];
  const toUnsubscribe = [];

  for (const sym of targetSymbols) {
    if (!_subscribed.has(sym)) {
      toSubscribe.push(`${sym.toLowerCase()}usdt@markPrice`);
    }
  }

  for (const sym of _subscribed) {
    if (!targetSymbols.has(sym)) {
      toUnsubscribe.push(`${sym.toLowerCase()}usdt@markPrice`);
    }
  }

  if (toSubscribe.length > 0) {
    const payload = {
      method: 'SUBSCRIBE',
      params: toSubscribe,
      id: _wsRequestId++
    };
    _ws.send(JSON.stringify(payload));
    log.system(`[PP369Stream] WS Subscribe: ${toSubscribe.join(', ')}`);
    for (const sym of targetSymbols) {
      if (!_subscribed.has(sym)) _subscribed.add(sym);
    }
  }

  if (toUnsubscribe.length > 0) {
    const payload = {
      method: 'UNSUBSCRIBE',
      params: toUnsubscribe,
      id: _wsRequestId++
    };
    _ws.send(JSON.stringify(payload));
    log.system(`[PP369Stream] WS Unsubscribe: ${toUnsubscribe.join(', ')}`);
    for (const stream of toUnsubscribe) {
      const sym = stream.replace('usdt@markPrice', '').toUpperCase();
      _subscribed.delete(sym);
    }
  }

  _symbols = Array.from(targetSymbols);
}

// ─── Kết nối / Reconnect ──────────────────────────────────────────────────────

function _connect() {
  if (_stopped) return;

  _ws = new WebSocket(FSTREAM);

  _ws.on('open', () => {
    log.system(`[PP369Stream] Kết nối WebSocket thành công (market/stream)`);
    _subscribed.clear();
    if (_symbols && _symbols.length > 0) {
      syncWebSocketSubscriptions(_symbols);
    }
  });

  _ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.result !== undefined) return;

      const data = msg.data || msg;
      if (data && data.s && data.p) {
        const sym = data.s.replace('USDT', '');
        _prices[sym] = parseFloat(data.p);
      }
    } catch (_) { }
  });

  _ws.on('close', () => {
    if (_stopped) return;
    log.warn('[PP369Stream] Mất kết nối — reconnect sau 5s');
    setTimeout(_connect, RECONNECT_DELAY);
  });

  _ws.on('error', (err) => {
    log.warn('[PP369Stream] Lỗi WebSocket', { error: err.message });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Khởi động stream.
 */
function start369Stream(symbols) {
  _symbols = symbols || [];
  _stopped = false;

  if (_ws && _ws.readyState === WebSocket.OPEN) {
    syncWebSocketSubscriptions(_symbols);
    return;
  }

  if (_ws) {
    _ws.removeAllListeners();
    _ws.terminate();
  }
  _connect();
}

function stop369Stream() {
  _stopped = true;
  if (_ws) {
    _ws.removeAllListeners();
    _ws.terminate();
    _ws = null;
  }
}

/** Giá markPrice hiện tại của 1 symbol (null nếu chưa có data) */
function getMarkPrice(symbol) {
  return _prices[symbol] ?? null;
}

/**
 * Lọc danh sách symbols: chỉ trả về coin có giá đang gần mốc.
 *
 * @param {string[]} symbols     - Danh sách coin cần check
 * @param {Object}   levelCache  - { BTC: { longEntry, shortEntry }, ... } từ getLevelCache()
 * @param {number}   threshold   - Ngưỡng % tính là "gần" (mặc định 2%)
 * @returns {string[]}           - Subset của symbols cần scan đầy đủ
 */
function getNearbySymbols(symbols, levelCache, threshold = 0.02) {
  return symbols.filter(sym => {
    const price = _prices[sym];
    const levels = levelCache[sym];

    // Chưa có giá nhưng đã có level -> tạm thời skip để đợi WS nhận giá (tránh gọi API quá mức gây ban IP)
    if (levels?.longEntry && levels?.shortEntry && !price) return false;

    // Chưa có level -> include để tính mốc
    if (!levels?.longEntry || !levels?.shortEntry) return true;

    // Threshold adaptive: đảm bảo giới hạn trong khoảng 25% của bước giá (step) để lọc hiệu quả các coin ở giữa mốc
    const adaptiveThreshold = levels.step
      ? Math.min(threshold, (levels.step / price) * 0.25)
      : threshold;

    const distLong = (price - levels.longEntry) / price;
    const distShort = (levels.shortEntry - price) / price;

    return distLong <= adaptiveThreshold || distShort <= adaptiveThreshold;
  });
}

module.exports = {
  start369Stream,
  stop369Stream,
  getMarkPrice,
  getNearbySymbols,
  updatePricesRest,
  syncWebSocketSubscriptions
};
