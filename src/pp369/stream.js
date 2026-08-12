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
  const url = 'https://fapi.binance.com/fapi/v1/ticker/price';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      if (Array.isArray(res.data)) {
        for (const item of res.data) {
          if (item.symbol && item.symbol.endsWith('USDT')) {
            const sym = item.symbol.replace('USDT', '');
            _prices[sym] = parseFloat(item.price);
          }
        }
      }
      return;
    } catch (err) {
      const isNetworkErr = !err.response || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED';
      const isRateLimit = err?.response?.status === 429 || err?.response?.status === 418;
      if ((isRateLimit || isNetworkErr) && attempt < 2) {
        const delay = err?.response?.status === 418 ? 15000 : (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      log.warn(`[PP369Stream] Lỗi lấy giá REST: ${err.message}`);
    }
  }
}

// ─── WebSocket dynamic subscription sync ─────────────────────────────────────
async function syncWebSocketSubscriptions(nearbySymbols) {
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

  const CHUNK_SIZE = 50;
  const newlySubscribed = [];
  const newlyUnsubscribed = [];

  if (toSubscribe.length > 0) {
    for (let i = 0; i < toSubscribe.length; i += CHUNK_SIZE) {
      const chunk = toSubscribe.slice(i, i + CHUNK_SIZE);
      const payload = {
        method: 'SUBSCRIBE',
        params: chunk,
        id: _wsRequestId++
      };
      _ws.send(JSON.stringify(payload));
      await new Promise(r => setTimeout(r, 50));
    }
    for (const sym of targetSymbols) {
      if (!_subscribed.has(sym)) {
        _subscribed.add(sym);
        newlySubscribed.push(sym);
      }
    }
  }

  if (toUnsubscribe.length > 0) {
    for (let i = 0; i < toUnsubscribe.length; i += CHUNK_SIZE) {
      const chunk = toUnsubscribe.slice(i, i + CHUNK_SIZE);
      const payload = {
        method: 'UNSUBSCRIBE',
        params: chunk,
        id: _wsRequestId++
      };
      _ws.send(JSON.stringify(payload));
      await new Promise(r => setTimeout(r, 50));
    }
    for (const stream of toUnsubscribe) {
      const sym = stream.replace('usdt@markPrice', '').toUpperCase();
      _subscribed.delete(sym);
      newlyUnsubscribed.push(sym);
    }
  }

  if (newlySubscribed.length > 0 || newlyUnsubscribed.length > 0) {
    const subStr = newlySubscribed.length > 0 ? `+ Subscribe mới (${newlySubscribed.length}): [${newlySubscribed.join(', ')}] ` : '';
    const unsubStr = newlyUnsubscribed.length > 0 ? `- Unsubscribe (${newlyUnsubscribed.length}): [${newlyUnsubscribed.join(', ')}] ` : '';
    const totalList = Array.from(_subscribed).join(', ');
    // log.system(`[PP369Stream] WebSocket Sync | ${subStr}${unsubStr}| Đang duy trì lắng nghe (${_subscribed.size} mã): [${totalList}]`);
  }

  _symbols = Array.from(targetSymbols);
}

// ─── Kết nối / Reconnect ──────────────────────────────────────────────────────

let _pingInterval = null;

function _cleanupPing() {
  if (_pingInterval) {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }
}

function _connect() {
  if (_stopped) return;
  _cleanupPing();

  _ws = new WebSocket(FSTREAM);

  _ws.on('open', () => {
    log.system(`[PP369Stream] Kết nối WebSocket thành công (market/stream)`);
    _subscribed.clear();
    if (_symbols && _symbols.length > 0) {
      syncWebSocketSubscriptions(_symbols);
    }

    // Ping/pong heartbeat mỗi 30s để chống Zombie WebSocket Connection
    _pingInterval = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        try { _ws.ping(); } catch (_) { }
      }
    }, 30_000);
  });

  _ws.on('pong', () => {
    // WebSocket vẫn phản hồi tốt
  });

  _ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.result !== undefined) return;

      const data = msg.data || msg;
      if (data && data.s && data.p) {
        const sym = data.s.replace('USDT', '');
        const price = parseFloat(data.p);
        _prices[sym] = price;

        if (_priceUpdateCallbacks.size > 0) {
          for (const cb of _priceUpdateCallbacks) {
            try { cb(sym, price); } catch (_) { }
          }
        }
      }
    } catch (_) { }
  });

  _ws.on('close', () => {
    _cleanupPing();
    if (_stopped) return;
    log.warn('[PP369Stream] Mất kết nối — reconnect sau 5s');
    setTimeout(_connect, RECONNECT_DELAY);
  });

  _ws.on('error', (err) => {
    _cleanupPing();
    log.warn('[PP369Stream] Lỗi WebSocket', { error: err.message });
    try { _ws.terminate(); } catch (_) { }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

const _priceUpdateCallbacks = new Set();

/** Đăng ký callback nhận điểm giá real-time từ WebSocket */
function onPriceUpdate(cb) {
  if (typeof cb === 'function') {
    _priceUpdateCallbacks.add(cb);
  }
}

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
 * @param {number}   threshold   - Ngưỡng % tính là "gần" (mặc định 1.5%)
 * @returns {string[]}           - Subset của symbols cần scan đầy đủ
 */
function getNearbySymbols(symbols, levelCache, threshold = 0.015) {
  return symbols.filter(sym => {
    const price = _prices[sym];
    const levels = levelCache[sym];

    // Chưa có giá nhưng đã có level -> tạm thời skip để đợi WS nhận giá (tránh gọi API quá mức gây ban IP)
    if (levels?.longEntry && levels?.shortEntry && !price) return false;

    // Chưa có level -> include để tính mốc
    if (!levels?.longEntry || !levels?.shortEntry) return true;

    // Kiểm tra khoảng cách lưới tại mức giá hiện tại (phải đạt 3-20%)
    const currentGridPct = ((levels.shortEntry - levels.longEntry) / levels.longEntry) * 100;
    if (currentGridPct < 3 || currentGridPct > 20) return false;

    // Adaptive threshold: Giữ ngưỡng lắng nghe ở mức tối thiểu 1.5% giá hoặc 50% bước giá step
    const adaptiveThreshold = levels.step
      ? Math.max(threshold, (levels.step / price) * 0.50)
      : Math.max(threshold, 0.015);

    const distLong = Math.abs(price - levels.longEntry) / price;
    const distShort = Math.abs(levels.shortEntry - price) / price;

    return distLong <= adaptiveThreshold || distShort <= adaptiveThreshold;
  });
}

module.exports = {
  start369Stream,
  stop369Stream,
  getMarkPrice,
  getNearbySymbols,
  updatePricesRest,
  syncWebSocketSubscriptions,
  onPriceUpdate
};
