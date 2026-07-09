'use strict';

/**
 * PP369 Auto-Trader
 *
 * Flow:
 *   1. Start markPrice WebSocket stream
 *   2. Mỗi SCAN_INTERVAL giây: lọc coin gần mốc → chạy get369Signal()
 *   3. Có tín hiệu LONG/SHORT + chưa có vị thế mở → đặt lệnh Binance Futures
 *   4. Debounce 5 phút / tín hiệu để tránh vào lệnh trùng
 */

const { createClient, loadStepSizes, calcQuantity } = require('./binance');
const {
  get369Signal,
  getLevelCache,
  logSignal369,
  start369Stream,
  getMarkPrice,
  getNearbySymbols,
  getDecimals,
  updatePricesRest,
  syncWebSocketSubscriptions,
} = require('../pp369');
const { log } = require('../pp369/_logger');

const SCAN_INTERVAL_MS = 30_000;   // scan mỗi 30 giây
const DEBOUNCE_MS      = 5 * 60_000; // 5 phút / tín hiệu

// Debounce map: key → timestamp lần đặt lệnh gần nhất
const _fired = new Map();

function _signalKey(sig) {
  // Unique key theo symbol + hướng + tháng + mức entry — tránh re-entry cùng setup
  return `${sig.symbol}|${sig.signal}|${sig.month}|${sig.targetLevel}`;
}

function _isDebounced(sig) {
  const last = _fired.get(_signalKey(sig));
  return last != null && Date.now() - last < DEBOUNCE_MS;
}

function _markFired(sig) {
  _fired.set(_signalKey(sig), Date.now());
}

// Using unified getDecimals from pp369 module

// ─── Main ─────────────────────────────────────────────────────────────────────

async function startAutoTrade(coins) {
  const apiKey    = process.env.BINANCE_API_KEY;
  const secret    = process.env.BINANCE_SECRET;
  const amount    = parseFloat(process.env.TRADE_AMOUNT  || '10');
  const leverage  = parseInt(process.env.LEVERAGE        || '10', 10);
  const orderType = (process.env.ORDER_TYPE              || 'LIMIT').toUpperCase();
  const notional  = amount * leverage;

  if (!apiKey || !secret) {
    throw new Error('Thiếu BINANCE_API_KEY hoặc BINANCE_SECRET trong .env');
  }

  log.system(`[AutoTrade] Khởi động: ${coins.length} coin | margin=$${amount} | ${leverage}x | type=${orderType}`);

  await loadStepSizes();
  
  // Lấy giá REST lần đầu để xác định các coin gần mốc
  await updatePricesRest();
  const initialLevelCache = getLevelCache();
  const initialNearby = getNearbySymbols(coins, initialLevelCache, 0.005);
  
  // Khởi động WebSocket stream và đăng ký (subscribe) chỉ các mã đang gần mốc
  start369Stream(initialNearby);

  // Chờ WebSocket kết nối và nhận giá live ban đầu cho các mã đó
  await new Promise(r => setTimeout(r, 4000));

  const client = createClient(apiKey, secret);

  log.system('[AutoTrade] Bắt đầu scan...');

  async function scan() {
    // 1. Cập nhật lại giá REST của toàn bộ coin để kiểm tra xem có coin nào mới đi vào mốc gần phản ứng không
    await updatePricesRest();
    
    const levelCache = getLevelCache();
    const nearby     = getNearbySymbols(coins, levelCache, 0.005);

    // 2. Đồng bộ danh sách đăng ký WebSocket (Subscribe các coin mới vào mốc, Unsubscribe các coin đã ra xa)
    syncWebSocketSubscriptions(nearby);

    log.system(`[AutoTrade] Scan: ${nearby.length}/${coins.length} coin gần mốc phản ứng.`);
    if (!nearby.length) return;

    for (const sym of nearby) {
      const markPrice = getMarkPrice(sym);

      let sig;
      try {
        sig = await get369Signal(sym, markPrice);
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi get369Signal ${sym}: ${e.message}`);
        continue;
      }

      if (sig.signal === 'NONE') continue;

      log.system(`[AutoTrade] ${sym} → ${sig.signal} (${sig.strength}) tại $${sig.targetLevel}`);

      // Kiểm tra debounce
      if (_isDebounced(sig)) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} đã đặt gần đây — bỏ qua`);
        continue;
      }

      // Kiểm tra chưa có vị thế mở
      try {
        const hasPos = await client.hasOpenPosition(sym);
        if (hasPos) {
          log.system(`[AutoTrade] ${sym} đang có vị thế mở — bỏ qua`);
          _markFired(sig); // debounce luôn để không check lại liên tục
          continue;
        }
      } catch (e) {
        log.warn(`[AutoTrade] Không check được vị thế ${sym}: ${_binanceErr(e)} — vẫn tiếp tục đặt lệnh`);
      }

      // Tính quantity
      const { qty } = calcQuantity(sym, notional, sig.currentPrice);  // đọc từ file JSON
      if (qty <= 0) {
        log.warn(`[AutoTrade] ${sym}: quantity = 0 — tăng TRADE_AMOUNT hoặc LEVERAGE`);
        continue;
      }

      const side = sig.signal === 'LONG' ? 'BUY' : 'SELL';

      try {
        // Set leverage ngay trước khi đặt lệnh để tránh quá tải API khi bắt đầu
        try {
          await client.setLeverage(sym, leverage);
          log.system(`[AutoTrade] Set leverage ${sym}USDT = ${leverage}x trước khi đặt lệnh`);
        } catch (e) {
          log.warn(`[AutoTrade] Set leverage ${sym} thất bại: ${_binanceErr(e)} — vẫn tiếp tục đặt lệnh`);
        }

        let order;
        if (orderType === 'MARKET') {
          order = await client.placeMarket(sym, side, qty);
        } else {
          const dec = getDecimals(sig.targetLevel);
          order = await client.placeLimit(sym, side, qty, sig.targetLevel, dec);
        }

        _markFired(sig);
        logSignal369(sig);

        log.system(
          `[AutoTrade] ✓ ${sym} ${side} ${qty} @ $${sig.targetLevel} ` +
          `orderId=${order.orderId} status=${order.status}`
        );

      } catch (e) {
        log.warn(`[AutoTrade] Lỗi đặt lệnh ${sym}: ${_binanceErr(e)}`);
      }
    }
  }

  // Chạy ngay lần đầu
  await scan();

  // Sau đó lặp theo interval
  const timer = setInterval(scan, SCAN_INTERVAL_MS);

  // Trả về hàm stop để caller có thể dừng nếu cần
  return function stop() {
    clearInterval(timer);
    log.system('[AutoTrade] Đã dừng.');
  };
}

function _binanceErr(e) {
  const d = e.response?.data;
  return d ? `[${d.code}] ${d.msg}` : e.message;
}

module.exports = { startAutoTrade };
