'use strict';

/**
 * Binance Futures User Data Stream (WebSocket)
 *
 * Kết nối wss://fstream.binance.com/ws/<listenKey> để nhận event real-time:
 *   ORDER_TRADE_UPDATE: khi order status thay đổi (FILLED, CANCELED, ...)
 *
 * Flow:
 *   1. POST /fapi/v1/listenKey     → lấy listenKey
 *   2. Kết nối WebSocket
 *   3. Keepalive PUT mỗi 30 phút  → giữ listenKey sống (hết hạn sau 60 phút)
 *   4. Auto-reconnect khi mất kết nối
 */

const WebSocket = require('ws');
const axios     = require('axios');
const { log }   = require('./logger');
const { isIpBanned } = require('./rateLimitGuard');

const BASE_URL  = 'https://fapi.binance.com';
const WS_URL    = 'wss://fstream.binance.com/ws';
const API_KEY   = process.env.BINANCE_API_KEY || '';

const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 phút (listenKey hết hạn sau 60 phút)
const RECONNECT_DELAY_MS    = 5_000;           // 5 giây cơ sở (exponential backoff tối đa 60s)
const MAX_RECONNECT_DELAY_MS = 60_000;

let _ws               = null;
let _listenKey        = null;
let _keepaliveTimer   = null;
let _reconnectTimer   = null;
let _reconnectAttempt = 0;
let _stopped          = false;

// Danh sách callback đăng ký nhận event fill / cancel
const _fillCallbacks   = [];
const _cancelCallbacks = [];

function isEnabled() {
  return process.env.TRADE_ENABLED === 'true' && !!API_KEY;
}

/**
 * Đăng ký callback được gọi khi một order FILLED.
 * cb({ orderId, symbol, avgPrice, side, orderType })
 */
function onEntryFill(cb) {
  _fillCallbacks.push(cb);
}

/**
 * Đăng ký callback được gọi khi một order bị CANCELED hoặc EXPIRED.
 * cb({ orderId, symbol, orderType })
 */
function onOrderCancel(cb) {
  _cancelCallbacks.push(cb);
}

// ─── Binance REST helpers ─────────────────────────────────────────────────────

async function createListenKey() {
  const { data } = await axios.post(`${BASE_URL}/fapi/v1/listenKey`, null, {
    headers: { 'X-MBX-APIKEY': API_KEY },
    timeout: 10_000,
  });
  return data.listenKey;
}

async function refreshListenKey(listenKey) {
  await axios.put(`${BASE_URL}/fapi/v1/listenKey`, null, {
    headers: { 'X-MBX-APIKEY': API_KEY },
    params:  { listenKey },
    timeout: 10_000,
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(raw) {
  let msg;
  try {
    // Giữ nguyên orderId / algoId 64-bit (>= 16 chữ số, vd ETH) dạng chuỗi để tránh mất 3 số cuối
    const safeRaw = typeof raw === 'string'
      ? raw.replace(/"(i|si|aid|orderId|algoId)":\s*(\d{16,})/g, '"$1":"$2"')
      : raw;
    msg = JSON.parse(safeRaw);
  } catch { return; }

  if (msg.e !== 'ORDER_TRADE_UPDATE') return;

  const o = msg.o;
  const orderId   = o.i != null ? String(o.i) : null;
  const symbol    = (o.s || '').replace(/USDT$/, '');
  const orderType = o.ot;
  const rawAlgoId = o.si ?? o.aid ?? null;
  const algoId    = rawAlgoId != null ? String(rawAlgoId) : null;

  if (o.X === 'FILLED') {
    const avgPrice   = parseFloat(o.ap) || 0;
    const side       = o.S;
    const reduceOnly = o.R === true || o.R === 'true';
    log.trade(`WS FILL: ${symbol} ${side} ${orderType} #${orderId} avgPrice=${avgPrice} reduceOnly=${reduceOnly}`);
    for (const cb of _fillCallbacks) {
      try {
        const r = cb({ orderId, symbol, avgPrice, side, orderType, reduceOnly, algoId });
        if (r && typeof r.catch === 'function') {
          r.catch(e => log.warn('binanceStream: fill async callback lỗi', { error: e?.message || String(e) }));
        }
      } catch (e) {
        log.warn('binanceStream: fill callback lỗi', { error: e.message });
      }
    }
    return;
  }

  if (o.X === 'CANCELED' || o.X === 'EXPIRED') {
    log.trade(`WS CANCEL: ${symbol} ${orderType} #${orderId} status=${o.X}`);
    for (const cb of _cancelCallbacks) {
      try {
        const r = cb({ orderId, symbol, orderType });
        if (r && typeof r.catch === 'function') {
          r.catch(e => log.warn('binanceStream: cancel async callback lỗi', { error: e?.message || String(e) }));
        }
      } catch (e) {
        log.warn('binanceStream: cancel callback lỗi', { error: e.message });
      }
    }
    return;
  }
}

// ─── WebSocket lifecycle ──────────────────────────────────────────────────────

function connect() {
  if (_stopped || !_listenKey) return;

  _ws = new WebSocket(`${WS_URL}/${_listenKey}`);

  _ws.on('open', () => {
    _reconnectAttempt = 0;
    log.system('Binance WS: kết nối thành công');
  });

  _ws.on('message', (data) => {
    handleMessage(data.toString());
  });

  _ws.on('close', (code) => {
    _ws = null;
    if (_stopped) return;
    log.warn(`Binance WS: mất kết nối (${code}) — lên lịch kết nối lại`);
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    // 'close' sẽ được gọi ngay sau 'error', xử lý reconnect ở đó
    log.warn('Binance WS: lỗi', { error: err.message });
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
      log.warn('Binance WS: đang bị IP Ban/429 — hoãn reconnect');
      scheduleReconnect();
      return;
    }
    try {
      // Tạo listenKey mới (key cũ có thể đã hết hạn khi offline lâu)
      _listenKey = await createListenKey();
      connect();
    } catch (e) {
      log.warn('Binance WS: không thể tạo listenKey khi reconnect — thử lại...', { error: e.message });
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
      await refreshListenKey(_listenKey);
      log.system('[PP369] [BinanceStream] Keepalive listenKey thành công');
    } catch (e) {
      log.warn('Binance WS: keepalive thất bại', { error: e.message });
      // HTTP 400 = listenKey đã hết hạn → lấy key mới + reconnect WS
      const is400 = e.response?.status === 400 || String(e.message).includes('400');
      if (is400) {
        log.warn('Binance WS: listenKey hết hạn — khởi động lại WS để lấy key mới');
        _listenKey = null;
        if (_ws) { _ws.terminate(); _ws = null; }
        scheduleReconnect();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

async function startStream() {
  if (!isEnabled()) {
    log.system('Binance WS: TRADE_ENABLED=false hoặc thiếu API key — bỏ qua');
    return;
  }

  _stopped = false;
  // Luôn khởi động keepalive timer kể cả khi lần createListenKey đầu thất bại rồi reconnect sau
  _ensureKeepaliveTimer();

  try {
    _listenKey = await createListenKey();
    log.system(`Binance WS: listenKey tạo thành công (${_listenKey.slice(0, 10)}...)`);
  } catch (e) {
    log.warn('Binance WS: không thể tạo listenKey khi khởi động — thử lại sau', { error: e.message });
    scheduleReconnect();
    return;
  }

  connect();
}

function stopStream() {
  _stopped = true;
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer);  _reconnectTimer = null; }
  if (_ws) { _ws.terminate(); _ws = null; }
  log.system('Binance WS: đã dừng');
}

module.exports = { startStream, stopStream, onEntryFill, onOrderCancel, isEnabled };
