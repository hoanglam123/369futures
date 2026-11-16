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
const { log }   = require('./_logger');

const FSTREAM        = 'wss://fstream.binance.com/stream?streams=';
const RECONNECT_DELAY = 5000;

let _ws       = null;
let _symbols  = [];
let _prices   = {};   // { BTC: 95000, ETH: 3200, ... }
let _stopped  = false;

// ─── Kết nối / Reconnect ──────────────────────────────────────────────────────

function _buildUrl(symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}usdt@markPrice`).join('/');
  return `${FSTREAM}${streams}`;
}

function _connect() {
  if (_stopped || _symbols.length === 0) return;

  _ws = new WebSocket(_buildUrl(_symbols));

  _ws.on('open', () => {
    log.system(`[PP369Stream] Kết nối markPrice stream: ${_symbols.join(', ')}`);
  });

  _ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const d   = msg.data;
      if (!d?.s || !d?.p) return;
      const sym = d.s.replace('USDT', '');
      _prices[sym] = parseFloat(d.p);
    } catch (_) {}
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
 * Khởi động stream với danh sách symbols.
 * Gọi lại với danh sách mới nếu coin list thay đổi — tự reconnect.
 */
function start369Stream(symbols) {
  if (!symbols?.length) return;

  const newList = [...new Set(symbols)].sort().join(',');
  const oldList = [...new Set(_symbols)].sort().join(',');

  if (newList === oldList && _ws?.readyState === WebSocket.OPEN) return;

  _stopped = false;
  _symbols = symbols;

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
    const price  = _prices[sym];
    const levels = levelCache[sym];

    // Chưa có giá hoặc chưa có level → include để an toàn (fail-open)
    if (!price || !levels?.longEntry || !levels?.shortEntry) return true;

    // Threshold adaptive: đảm bảo coin không bị lọc khi đang ở giữa 2 mốc
    // Với step lớn (SOL 20%, ETH 10%), threshold cố định 2% sẽ miss phần lớn vùng giữa
    const adaptiveThreshold = levels.step
      ? Math.max(threshold, (levels.step / price) * 0.6)
      : threshold;

    const distLong  = (price - levels.longEntry)  / price;
    const distShort = (levels.shortEntry - price) / price;

    return distLong <= adaptiveThreshold || distShort <= adaptiveThreshold;
  });
}

module.exports = { start369Stream, stop369Stream, getMarkPrice, getNearbySymbols };
