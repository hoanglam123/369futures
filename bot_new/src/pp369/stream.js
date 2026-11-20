'use strict';

/**
 * PP369 Mark Price WebSocket Stream — Phase 3 Real-time 0ms Event-Driven Engine
 *
 * 1. Lắng nghe WebSocket stream giá đa luồng: wss://fstream.binance.com/market/stream
 * 2. Đồng bộ đăng ký động (Dynamic Subscription): tự động subscribe các coin gần mốc (<=1.0%),
 *    luôn luôn duy trì stream BTC 24/7 để phục vụ real-time 0ms BTC Flash Guard.
 * 3. Chu kỳ kiểm tra kép:
 *    - Luồng 1 (0ms WebSocket): Phát tín hiệu giá ngay khi có tick mới (onPriceUpdate).
 *    - Luồng 2 (REST Fallback 30s): Polling dự phòng giá đề phòng rớt gói tin hoặc mạng lag.
 * 4. Ping/pong heartbeat mỗi 30s chống zombie connection.
 */

const WebSocket = require('ws');
const axios     = require('axios');
const { log }   = require('./_logger');

const FSTREAM         = 'wss://fstream.binance.com/market/stream';
const RECONNECT_DELAY = 5000;

let _ws               = null;
let _symbols          = [];
let _prices           = {};       // { BTC: 95000, ETH: 3200, ... }
let _priceTimestamps  = {};       // { BTC: 172663..., ... }
let _stopped          = false;
const _subscribed     = new Set();
let _wsRequestId      = 1;
let _pingInterval     = null;
const _priceCallbacks = new Set();

// ─── REST Price Fallback ──────────────────────────────────────────────────────
async function updatePricesRest() {
  const url = 'https://fapi.binance.com/fapi/v1/ticker/price';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      if (Array.isArray(res.data)) {
        const now = Date.now();
        for (const item of res.data) {
          if (item.symbol && item.symbol.endsWith('USDT')) {
            const sym = item.symbol.replace('USDT', '');
            _prices[sym] = parseFloat(item.price);
            _priceTimestamps[sym] = now;
          }
        }
      }
      return true;
    } catch (err) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      log.warn(`[PP369Stream] Lỗi lấy giá REST: ${err.message}`);
      return false;
    }
  }
}

// ─── WebSocket Dynamic Subscription Sync ──────────────────────────────────────
async function syncWebSocketSubscriptions(nearbySymbols) {
  const targetSymbols = new Set(nearbySymbols || []);
  targetSymbols.add('BTC'); // Luôn luôn duy trì stream BTC 24/7 cho BTC Flash Guard
  _symbols = Array.from(targetSymbols);

  if (!_ws || _ws.readyState !== WebSocket.OPEN) {
    _subscribed.clear();
    for (const sym of targetSymbols) _subscribed.add(sym);
    return;
  }

  const toSubscribe   = [];
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
  if (toSubscribe.length > 0) {
    for (let i = 0; i < toSubscribe.length; i += CHUNK_SIZE) {
      const chunk = toSubscribe.slice(i, i + CHUNK_SIZE);
      const payload = {
        method: 'SUBSCRIBE',
        params: chunk,
        id: _wsRequestId++
      };
      try { _ws.send(JSON.stringify(payload)); } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
    for (const sym of targetSymbols) {
      _subscribed.add(sym);
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
      try { _ws.send(JSON.stringify(payload)); } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
    for (const stream of toUnsubscribe) {
      const sym = stream.replace('usdt@markPrice', '').toUpperCase();
      _subscribed.delete(sym);
    }
  }

  _symbols = Array.from(targetSymbols);
}

// ─── Kết nối / Reconnect / Heartbeat ──────────────────────────────────────────
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
    log.system(`[PP369Stream] Kết nối WebSocket market/stream thành công`);
    _subscribed.clear();
    const symbolsToSub = _symbols && _symbols.length > 0 ? _symbols : ['BTC'];
    syncWebSocketSubscriptions(symbolsToSub);

    // Heartbeat ping mỗi 30s
    _pingInterval = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        try { _ws.ping(); } catch (_) {}
      }
    }, 30_000);
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
        _priceTimestamps[sym] = Date.now();

        if (_priceCallbacks.size > 0) {
          for (const cb of _priceCallbacks) {
            try { cb(sym, price); } catch (_) {}
          }
        }
      }
    } catch (_) {}
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
    try { _ws.terminate(); } catch (_) {}
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

function onPriceUpdate(cb) {
  if (typeof cb === 'function') {
    _priceCallbacks.add(cb);
  }
}

function offPriceUpdate(cb) {
  _priceCallbacks.delete(cb);
}

function start369Stream(symbols) {
  _symbols = symbols ? Array.from(new Set([...symbols, 'BTC'])) : ['BTC'];
  _stopped = false;

  if (_ws && _ws.readyState === WebSocket.OPEN) {
    syncWebSocketSubscriptions(_symbols);
    return;
  }

  if (_ws) {
    _ws.removeAllListeners();
    try { _ws.terminate(); } catch (_) {}
  }
  _connect();
}

function stop369Stream() {
  _stopped = true;
  _cleanupPing();
  if (_ws) {
    _ws.removeAllListeners();
    try { _ws.terminate(); } catch (_) {}
    _ws = null;
  }
  _subscribed.clear();
}

function getMarkPrice(symbol, maxAgeMs = 30000) {
  if (!symbol) return null;
  const p = _prices[symbol];
  if (p === undefined || p === null) return null;
  if (maxAgeMs > 0) {
    const ts = _priceTimestamps[symbol];
    if (!ts || (Date.now() - ts) > maxAgeMs) return null;
  }
  return p;
}

function getPrices() {
  return { ..._prices };
}

function getSubscribedSymbols() {
  return Array.from(_subscribed);
}

function getNearbySymbols(symbols, levelCache, threshold = 0.02) {
  return (symbols || []).filter(sym => {
    const price  = _prices[sym];
    const levels = levelCache ? levelCache[sym] : null;

    if (!price || !levels?.longEntry || !levels?.shortEntry) return true;

    const adaptiveThreshold = levels.step
      ? Math.max(threshold, (levels.step / price) * 0.6)
      : threshold;

    const distLong  = (price - levels.longEntry)  / price;
    const distShort = (levels.shortEntry - price) / price;

    return distLong <= adaptiveThreshold || distShort <= adaptiveThreshold;
  });
}

module.exports = {
  start369Stream,
  stop369Stream,
  getMarkPrice,
  getPrices,
  getSubscribedSymbols,
  getNearbySymbols,
  syncWebSocketSubscriptions,
  updatePricesRest,
  onPriceUpdate,
  offPriceUpdate
};
