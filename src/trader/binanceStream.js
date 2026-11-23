'use strict';

/**
 * Binance Futures User Data Stream (WebSocket) — Phase 4
 *
 * Kết nối wss://fstream.binance.com/ws/<listenKey> để nhận event real-time:
 *   - ORDER_TRADE_UPDATE: Khi order status thay đổi (FILLED, CANCELED, PARTIALLY_FILLED, EXPIRED)
 *   - ACCOUNT_UPDATE: Cập nhật biến động số dư và vị thế thực tế
 *
 * Vòng đời kết nối:
 *   1. POST /fapi/v1/listenKey     → Tạo listenKey
 *   2. Kết nối WebSocket
 *   3. Keepalive PUT mỗi 30 phút   → Giữ listenKey sống (hết hạn sau 60 phút)
 *   4. Auto-reconnect sau 5s khi mất kết nối hoặc khi nhận mã lỗi 400
 */

const WebSocket = require('ws');
const axios     = require('axios');
const { log }   = require('../pp369/_logger');
const { isIpBanned } = require('./circuitBreaker');

const BASE_URL  = 'https://fapi.binance.com';
const WS_URL    = 'wss://fstream.binance.com/ws';

const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 phút (listenKey hết hạn sau 60 phút)
const RECONNECT_DELAY_MS    = 5_000;           // 5 giây cơ sở (exponential backoff tối đa 60s)
const MAX_RECONNECT_DELAY_MS = 60_000;

let _ws               = null;
let _listenKey        = null;
let _keepaliveTimer   = null;
let _reconnectTimer   = null;
let _reconnectAttempt = 0;
let _stopped          = false;
let _currentApiKey    = process.env.BINANCE_API_KEY || '';

// Danh sách callback đăng ký nhận event
const _entryFillCallbacks   = [];
const _fillCallbacks        = [];
const _cancelCallbacks      = [];
const _partialFillCallbacks = [];
const _accountCallbacks     = [];

function isEnabled(apiKey = _currentApiKey) {
  return !!apiKey;
}

/**
 * Đăng ký callback khi một Lệnh Mở Vị Thế (Entry) được cắn khớp (FILLED, reduceOnly = false).
 * cb({ orderId, clientOrderId, symbol, avgPrice, side, orderType, qty, filledQty, reduceOnly })
 */
function onEntryFill(cb) {
  _entryFillCallbacks.push(cb);
}

/**
 * Đăng ký callback khi BẤT KỲ order nào FILLED (kể cả TP, SL, Entry).
 * cb({ orderId, clientOrderId, symbol, avgPrice, side, orderType, qty, filledQty, reduceOnly })
 */
function onOrderFill(cb) {
  _fillCallbacks.push(cb);
}

/**
 * Đăng ký callback khi một order bị CANCELED hoặc EXPIRED.
 * cb({ orderId, symbol, orderType, status })
 */
function onOrderCancel(cb) {
  _cancelCallbacks.push(cb);
}

/**
 * Đăng ký callback khi một order bị khớp một phần.
 */
function onOrderPartialFill(cb) {
  _partialFillCallbacks.push(cb);
}

/**
 * Đăng ký callback khi có sự kiện cập nhật tài khoản (ACCOUNT_UPDATE).
 */
function onAccountUpdate(cb) {
  _accountCallbacks.push(cb);
}

// ─── Binance REST Helpers ─────────────────────────────────────────────────────

async function createListenKey(apiKey = _currentApiKey) {
  const { data } = await axios.post(`${BASE_URL}/fapi/v1/listenKey`, null, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10_000,
  });
  return data.listenKey;
}

async function refreshListenKey(listenKey, apiKey = _currentApiKey) {
  await axios.put(`${BASE_URL}/fapi/v1/listenKey`, null, {
    headers: { 'X-MBX-APIKEY': apiKey },
    params:  { listenKey },
    timeout: 10_000,
  });
}

async function deleteListenKey(listenKey, apiKey = _currentApiKey) {
  try {
    await axios.delete(`${BASE_URL}/fapi/v1/listenKey`, {
      headers: { 'X-MBX-APIKEY': apiKey },
      params:  { listenKey },
      timeout: 10_000,
    });
  } catch { /* silent cleanup */ }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

// Giữ nguyên các ID số nguyên >= 16 chữ số (o.i, orderId, algoId) dạng chuỗi trước khi JSON.parse
function _safeJsonParseStream(raw) {
  if (typeof raw !== 'string') return raw;
  const preserved = raw
    .replace(/"(i|ai|orderId|algoId|id)":\s*(\d{16,})/g, '"$1":"$2"');
  return JSON.parse(preserved);
}

function _invokeCallbacks(list, payload, label) {
  for (const cb of list) {
    try {
      const r = cb(payload);
      if (r && typeof r.catch === 'function') {
        r.catch(e => log.warn(`[BinanceStream] ${label} async callback lỗi: ${e?.message || e}`));
      }
    } catch (e) {
      log.warn(`[BinanceStream] ${label} callback lỗi: ${e.message}`);
    }
  }
}

function handleMessage(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? _safeJsonParseStream(raw) : raw;
  } catch {
    return;
  }

  // 1. Sự kiện cập nhật lệnh
  if (msg.e === 'ORDER_TRADE_UPDATE') {
    const o = msg.o;
    if (!o) return;

    const orderId       = o.i != null ? String(o.i) : null;
    const algoId        = o.ai != null ? String(o.ai) : null;
    const clientOrderId = o.c;
    const symbol        = (o.s || '').replace(/USDT$/, '');
    const orderType     = o.ot;
    const side          = o.S;
    const status        = o.X;
    const reduceOnly    = o.R === true || o.R === 'true';
    const closePosition = o.cp === true || o.cp === 'true';
    const avgPrice      = parseFloat(o.ap) || 0;
    const qty           = parseFloat(o.q) || 0;
    const filledQty     = parseFloat(o.z) || 0;

    const payload = {
      orderId,
      algoId,
      clientOrderId,
      symbol,
      avgPrice,
      side,
      orderType,
      qty,
      filledQty,
      reduceOnly,
      closePosition,
      status,
      timestamp: msg.E || Date.now(),
    };

    if (status === 'FILLED') {
      log.system(`[BinanceStream] ⚡ WS FILL: ${symbol} ${side} ${orderType} #${orderId} @ $${avgPrice} (reduceOnly=${reduceOnly}, cp=${closePosition})`);

      // Dispatch general fill
      _invokeCallbacks(_fillCallbacks, payload, 'fill');

      // Nếu không phải reduceOnly và không phải closePosition → đây là lệnh ENTRY mở vị thế
      if (!reduceOnly && !closePosition) {
        _invokeCallbacks(_entryFillCallbacks, payload, 'entry fill');
      }
      return;
    }

    if (status === 'PARTIALLY_FILLED') {
      _invokeCallbacks(_partialFillCallbacks, payload, 'partial fill');
      return;
    }

    if (status === 'CANCELED' || status === 'EXPIRED') {
      log.system(`[BinanceStream] 🛑 WS CANCEL: ${symbol} ${orderType} #${orderId} (${status})`);
      _invokeCallbacks(_cancelCallbacks, payload, 'cancel');
      return;
    }
  }

  // 2. Sự kiện cập nhật tài khoản
  if (msg.e === 'ACCOUNT_UPDATE') {
    _invokeCallbacks(_accountCallbacks, msg.a, 'account');
  }
}

// ─── WebSocket Lifecycle ──────────────────────────────────────────────────────

function connect() {
  if (_stopped || !_listenKey) return;

  _ws = new WebSocket(`${WS_URL}/${_listenKey}`);

  _ws.on('open', () => {
    _reconnectAttempt = 0;
    log.system('[BinanceStream] ✓ Kết nối User Data Stream WebSocket thành công');
  });

  _ws.on('message', (data) => {
    handleMessage(data.toString());
  });

  _ws.on('close', (code) => {
    _ws = null;
    if (_stopped) return;
    log.warn(`[BinanceStream] Mất kết nối WebSocket (${code}) — lên lịch kết nối lại`);
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    log.warn(`[BinanceStream] Lỗi WebSocket: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (_stopped || _reconnectTimer) return;
  const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * Math.pow(2, Math.min(_reconnectAttempt, 4)));
  _reconnectAttempt++;
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    if (_stopped) return;
    if (isIpBanned()) {
      log.warn('[BinanceStream] Đang bị IP Ban/429 — hoãn reconnect User Data Stream');
      scheduleReconnect();
      return;
    }
    try {
      _listenKey = await createListenKey(_currentApiKey);
      connect();
    } catch (e) {
      log.warn(`[BinanceStream] Không thể tạo listenKey khi reconnect: ${e.message} — thử lại sau...`);
      scheduleReconnect();
    }
  }, delayMs);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function _ensureKeepaliveTimer() {
  if (_keepaliveTimer) return;
  _keepaliveTimer = setInterval(async () => {
    if (_stopped || !_listenKey || isIpBanned()) return;
    try {
      await refreshListenKey(_listenKey, _currentApiKey);
      log.system('[BinanceStream] Keepalive listenKey thành công');
    } catch (e) {
      log.warn(`[BinanceStream] Keepalive thất bại: ${e.message}`);
      const is400 = e.response?.status === 400 || String(e.message).includes('400');
      if (is400) {
        log.warn('[BinanceStream] listenKey đã hết hạn — khởi động lại WS để lấy key mới');
        _listenKey = null;
        if (_ws) { _ws.terminate(); _ws = null; }
        scheduleReconnect();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

async function startStream(apiKey = _currentApiKey) {
  if (apiKey) _currentApiKey = apiKey;

  if (!isEnabled(_currentApiKey)) {
    log.system('[BinanceStream] Thiếu BINANCE_API_KEY — bỏ qua User Data Stream');
    return false;
  }

  _stopped = false;
  // Luôn bật keepalive timer ngay từ đầu (kể cả khi lần tạo listenKey đầu tiên bị lỗi rồi reconnect sau)
  _ensureKeepaliveTimer();

  try {
    _listenKey = await createListenKey(_currentApiKey);
    log.system(`[BinanceStream] listenKey tạo thành công (${_listenKey.slice(0, 10)}...)`);
  } catch (e) {
    log.warn(`[BinanceStream] Không thể tạo listenKey khi khởi động: ${e.message} — lên lịch kết nối lại`);
    scheduleReconnect();
    return false;
  }

  connect();
  return true;
}

function stopStream() {
  _stopped = true;
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer);  _reconnectTimer = null; }
  if (_ws) { _ws.terminate(); _ws = null; }
  if (_listenKey) {
    deleteListenKey(_listenKey, _currentApiKey);
    _listenKey = null;
  }
  log.system('[BinanceStream] Đã dừng User Data Stream');
}

function isStreamConnected() {
  return !!_ws && _ws.readyState === WebSocket.OPEN;
}

function getListenKey() {
  return _listenKey;
}

// Reset callbacks (dùng cho test)
function clearCallbacks() {
  _entryFillCallbacks.length = 0;
  _fillCallbacks.length = 0;
  _cancelCallbacks.length = 0;
  _partialFillCallbacks.length = 0;
  _accountCallbacks.length = 0;
}

module.exports = {
  startStream,
  stopStream,
  onEntryFill,
  onOrderFill,
  onOrderCancel,
  onOrderPartialFill,
  onAccountUpdate,
  isStreamConnected,
  getListenKey,
  handleMessage,
  handleStreamMessage: handleMessage,
  createListenKey,
  refreshListenKey,
  clearCallbacks,
};
