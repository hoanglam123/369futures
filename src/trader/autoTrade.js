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

const path = require('path');
const fs = require('fs');
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
  notifySignals,
  sendTelegram,
  score369Method,
} = require('../pp369');
const { log } = require('../pp369/_logger');

const SCAN_INTERVAL_MS = 30_000;   // scan mỗi 30 giây
const TRAILING_SL_INTERVAL_MS = 3_000; // kiểm tra vị thế để dịch SL mỗi 3 giây (tăng interval để tránh rate limit)
const DEBOUNCE_MS = 5 * 60_000; // 5 phút / tín hiệu

// Debounce map: key → timestamp lần đặt lệnh gần nhất
const _fired = new Map();

// Tránh thông báo đóng vị thế trùng lặp giữa bot (Virtual) và sàn
const justClosedByBot = new Set();
const lastActivePositions = new Map(); // sym -> { entryPrice, leverage, amt, isLong }
const partialClosedSymbols = new Set(); // sym -> true (đã chốt lời 50% tại 13% ROI)

function formatQuantity(sym, rawQty) {
  let stepSize = 0.001;
  try {
    const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      const stepSizes = data.stepSizes ?? {};
      stepSize = stepSizes[`${sym}USDT`] ?? 0.001;
    }
  } catch (_) {}
  
  const qty = Math.floor(rawQty / stepSize) * stepSize;
  const dec = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat(qty.toFixed(dec));
}

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
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;
  const amount = parseFloat(process.env.TRADE_AMOUNT || '5');
  const leverage = parseInt(process.env.LEVERAGE || '10', 10);
  const orderType = (process.env.ORDER_TYPE || 'LIMIT').toUpperCase();
  const notional = amount * leverage;

  const activeSymbols = new Set();

  if (!apiKey || !secret) {
    throw new Error('Thiếu BINANCE_API_KEY hoặc BINANCE_SECRET trong .env');
  }

  log.system(`[AutoTrade] Khởi động: ${coins.length} coin | margin=$${amount} | ${leverage}x | type=${orderType}`);

  await loadStepSizes();

  // Đọc leverageInfo từ cache để cap leverage theo giới hạn Binance cho phép mỗi coin
  let leverageInfo = {};
  try {
    const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      leverageInfo = raw.leverageInfo || {};
      log.system(`[AutoTrade] Đã nạp leverageInfo cho ${Object.keys(leverageInfo).length} coin từ cache.`);
    }
  } catch (e) {
    log.warn(`[AutoTrade] Không đọc được leverageInfo: ${e.message} — dùng leverage mặc định ${leverage}x cho tất cả.`);
  }

  // Lấy giá REST lần đầu để xác định các coin gần mốc
  await updatePricesRest();
  const initialLevelCache = getLevelCache();
  const initialNearby = getNearbySymbols(coins, initialLevelCache, 0.01);

  // Khởi động WebSocket stream và đăng ký (subscribe) chỉ các mã đang gần mốc
  start369Stream(initialNearby);

  // Chờ WebSocket kết nối và nhận giá live ban đầu cho các mã đó
  await new Promise(r => setTimeout(r, 4000));

  const client = createClient(apiKey, secret);

  log.system('[AutoTrade] Bắt đầu scan...');

  async function scan() {
    // 1. Cập nhật lại giá REST của toàn bộ coin để kiểm tra xem có coin nào mới đi vào mốc gần phản ứng không
    await updatePricesRest();

    // Đồng bộ danh sách coin có vị thế hoặc lệnh chờ (thường + algo) để tối ưu checkTrailingSL
    try {
      const currentPos = await client.getOpenPositions();
      const currentOrders = await client.getOpenOrders();
      const currentAlgoOrders = await client.getOpenAlgoOrders();
      
      activeSymbols.clear();
      for (const p of currentPos) {
        activeSymbols.add(p.symbol.replace('USDT', ''));
      }
      for (const o of currentOrders) {
        activeSymbols.add(o.symbol.replace('USDT', ''));
      }
      for (const o of currentAlgoOrders) {
        activeSymbols.add(o.symbol.replace('USDT', ''));
      }
    } catch (e) {
      log.warn(`[AutoTrade] Lỗi đồng bộ activeSymbols: ${_binanceErr(e)}`);
    }

    const levelCache = getLevelCache();
    const nearby = getNearbySymbols(coins, levelCache, 0.01);

    // 2. Đồng bộ danh sách đăng ký WebSocket (Subscribe các coin mới vào mốc, Unsubscribe các coin đã ra xa)
    syncWebSocketSubscriptions(nearby);

    log.system(`[AutoTrade] Scan: ${nearby.length}/${coins.length} coin gần mốc phản ứng.`);
    if (!nearby.length) return;

    for (const sym of nearby) {
      // Bỏ qua nếu coin đã có vị thế mở hoặc lệnh chờ khớp trên sàn để tránh đặt trùng
      if (activeSymbols.has(sym)) {
        continue;
      }

      const markPrice = getMarkPrice(sym);

      let sig;
      try {
        sig = await get369Signal(sym, markPrice);
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi get369Signal ${sym}: ${e.message}`);
        continue;
      }

      if (sig.signal === 'NONE') {
        if (sig.reason && (sig.reason.includes('Không lấy được nến H4') || sig.reason.includes('không trùng ngày 01/01/2026'))) {
          log.warn(`[AutoTrade] Phát hiện ${sym} không có nến H4 đầu năm 2026. Loại bỏ khỏi danh sách quét.`);
          const idx = coins.indexOf(sym);
          if (idx !== -1) {
            coins.splice(idx, 1);
            log.system(`[AutoTrade] Đã loại bỏ ${sym} khỏi danh sách quét. Còn lại ${coins.length} coin.`);
          }
        }
        continue;
      }

      // Tính điểm Scorer trước khi đặt lệnh và gửi Telegram
      try {
        const scoreRes = await score369Method(sig, sig.signal);
        sig.score = scoreRes.score;
        sig.scoreReasons = scoreRes.reasons;
      } catch (err) {
        log.warn(`[AutoTrade] Lỗi tính score cho ${sym}: ${err.message}`);
      }

      log.system(`[AutoTrade] ${sym} → ${sig.signal} (Score: +${sig.score}đ) tại $${sig.targetLevel}`);

      // Kiểm tra debounce
      if (_isDebounced(sig)) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} đã đặt gần đây — bỏ qua`);
        continue;
      }

      // Kiểm tra chưa có vị thế mở (double check)
      try {
        const hasPos = await client.hasOpenPosition(sym);
        if (hasPos) {
          log.system(`[AutoTrade] ${sym} đang có vị thế mở — bỏ qua`);
          continue;
        }
      } catch (e) {
        log.warn(`[AutoTrade] Không check được vị thế ${sym}: ${_binanceErr(e)} — vẫn tiếp tục đặt lệnh`);
      }

      // 1. Tính đòn bẩy động theo khoảng cách thực tế giữa mốc LONG dưới và SHORT trên
      const gridWidth = Math.abs(sig.condLevel - sig.targetLevel);
      const pct = (gridWidth / Math.min(sig.targetLevel, sig.condLevel)) * 100;
      const calculatedLeverage = Math.floor(50 / pct);
      const maxAllowed = leverageInfo[sym] ?? leverage; // leverage mặc định từ .env làm fallback
      const effectiveLeverage = Math.max(1, Math.min(calculatedLeverage, maxAllowed));

      sig.leverage = effectiveLeverage; // Gán vào signal để formatter hiển thị đòn bẩy chính xác trên Telegram

      // 2. Tính Notional động để cố định ký quỹ (Margin) = TRADE_AMOUNT = 10$
      const currentNotional = amount * effectiveLeverage;

      // 3. Tính quantity dựa trên currentNotional và giá kích hoạt targetLevel
      const { qty } = calcQuantity(sym, currentNotional, sig.targetLevel);
      if (qty <= 0) {
        log.warn(`[AutoTrade] ${sym}: quantity = 0 — tăng TRADE_AMOUNT hoặc LEVERAGE`);
        continue;
      }

      const side = sig.signal === 'LONG' ? 'BUY' : 'SELL';

      try {
        try {
          await client.setLeverage(sym, effectiveLeverage);
          log.system(`[AutoTrade] Set leverage ${sym}USDT = ${effectiveLeverage}x (Lưới: ${pct.toFixed(2)}% → tính được ${calculatedLeverage}x, giới hạn: ${maxAllowed}x | Ký quỹ mục tiêu: $${amount})`);
        } catch (e) {
          const binErr = e.response?.data;
          log.warn(`[AutoTrade] Set leverage ${sym} thất bại: ${_binanceErr(e)} — vẫn tiếp tục đặt lệnh`);
          if (binErr?.code === -4411) {
            throw e; // ném ra ngoài để xử lý blacklist
          }
        }

        let order;
        if (orderType === 'MARKET') {
          order = await client.placeMarket(sym, side, qty);
        } else {
          const dec = getDecimals(sig.targetLevel);
          order = await client.placeLimit(sym, side, qty, sig.targetLevel, dec);
        }

        activeSymbols.add(sym); // Thêm vào danh sách active để check SL/TP ngay lập tức
        _markFired(sig); // Đánh dấu debounce sau khi đặt lệnh thành công
        notifySignals([sig]).catch(() => { }); // Gửi Telegram thông báo lệnh đã đặt thành công
        logSignal369(sig);

        log.system(
          `[AutoTrade] ✓ ${sym} ${side} ${qty} @ $${sig.targetLevel} ` +
          `orderId=${order.orderId} status=${order.status}`
        );



      } catch (e) {
        const binErr = e.response?.data;
        const errCode = binErr?.code;
        log.warn(`[AutoTrade] Lỗi đặt lệnh ${sym}: ${_binanceErr(e)}`);

        if (errCode === -4411) {
          log.warn(`[AutoTrade] Phát hiện lỗi -4411 cho ${sym}. Tiến hành loại bỏ và đánh dấu lỗi vào step_sizes.json.`);
          await markSymbolFailed(sym, 'Lỗi 4411 - Chưa ký hợp đồng TradFi');
          // Loại bỏ khỏi danh sách coins trong runtime để dừng scan
          const idx = coins.indexOf(sym);
          if (idx !== -1) {
            coins.splice(idx, 1);
            log.system(`[AutoTrade] Đã loại bỏ ${sym} khỏi danh sách quét. Còn lại ${coins.length} coin.`);
          }
        }
      }
    }
  }

  // Chạy ngay lần đầu
  await scan();

  // Luồng 1: Quét tín hiệu để đặt lệnh LIMIT (Mỗi 30s)
  const timer = setInterval(scan, SCAN_INTERVAL_MS);

  // Luồng 2: Kiểm tra vị thế đang mở và dịch chuyển Stop Loss (Mỗi 2s)
  const trailingSlTimer = setInterval(() => {
    checkTrailingSL(client, leverage, leverageInfo, activeSymbols).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng Trailing SL: ${err.message}`);
    });
  }, TRAILING_SL_INTERVAL_MS);

  // Trả về hàm stop để caller có thể dừng nếu cần
  return function stop() {
    clearInterval(timer);
    clearInterval(trailingSlTimer);
    log.system('[AutoTrade] Đã dừng.');
  };
}

function _binanceErr(e) {
  const d = e.response?.data;
  return d ? `[${d.code}] ${d.msg}` : e.message;
}

async function markSymbolFailed(sym, reason) {
  try {
    const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.h4Cache) data.h4Cache = {};

      // Đánh dấu failed để không tải lại khi khởi động
      data.h4Cache[sym] = {
        ...(data.h4Cache[sym] || {}),
        failed: true,
        reason: reason,
        updatedAt: Date.now()
      };

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      log.system(`[AutoTrade] Đã lưu trạng thái lỗi 4411 của ${sym} vào h4Cache.`);
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi cập nhật step_sizes.json khi đánh dấu lỗi ${sym}: ${err.message}`);
  }
}

async function checkTrailingSL(client, defaultLeverage, leverageInfo, activeSymbols) {
  try {
    if (!activeSymbols || activeSymbols.size === 0) return;

    const positions = await client.getOpenPositions();

    // Kiểm tra xem có vị thế nào ở lượt trước mà lượt này không còn không (sàn đóng hoặc user đóng tay)
    for (const [prevSym, prevPos] of lastActivePositions.entries()) {
      const isStillOpen = positions.some(p => p.symbol === `${prevSym}USDT`);
      if (!isStillOpen) {
        partialClosedSymbols.delete(prevSym); // Giải phóng trạng thái chốt lời một phần
        if (justClosedByBot.has(prevSym)) {
          justClosedByBot.delete(prevSym); // Bỏ qua vì bot đã chủ động gửi thông báo Virtual TP/SL rồi
        } else {
          notifyRealClose(client, prevSym, prevPos).catch(() => {});
        }
      }
    }

    // Cập nhật lại trạng thái các vị thế hoạt động cho lượt sau
    lastActivePositions.clear();
    for (const p of positions) {
      const sym = p.symbol.replace('USDT', '');
      lastActivePositions.set(sym, {
        entryPrice: parseFloat(p.entryPrice),
        leverage: parseFloat(p.leverage),
        amt: parseFloat(p.positionAmt),
        isLong: parseFloat(p.positionAmt) > 0
      });
    }

    if (!positions.length) return;

    // Lấy các symbols của vị thế đang mở
    const openSymbols = positions.map(p => p.symbol.replace('USDT', ''));

    // Lấy lệnh thường và lệnh algo cho từng symbol song song (không catch lỗi ẩn để tránh đua lệnh)
    const orderPromises = openSymbols.map(async (sym) => {
      const [orders, algoOrders] = await Promise.all([
        client.getOpenOrders(sym),
        client.getOpenAlgoOrders(sym)
      ]);
      return { sym, orders, algoOrders };
    });

    const symbolOrdersResults = await Promise.all(orderPromises);

    for (const p of positions) {
      const sym = p.symbol.replace('USDT', '');
      const entryPrice = parseFloat(p.entryPrice);
      const markPrice = parseFloat(p.markPrice);
      const leverageVal = parseFloat(p.leverage);
      const amt = parseFloat(p.positionAmt);

      if (amt === 0 || entryPrice === 0) continue;

      const isLong = amt > 0;
      const absAmt = Math.abs(amt);
      const oppositeSide = isLong ? 'SELL' : 'BUY';

      // ROI % = % thay đổi giá * leverage
      const roi = isLong
        ? ((markPrice - entryPrice) / entryPrice) * leverageVal * 100
        : ((entryPrice - markPrice) / entryPrice) * leverageVal * 100;

      // Lấy danh sách lệnh chờ của symbol hiện tại từ kết quả đã truy vấn
      const symbolResult = symbolOrdersResults.find(r => r.sym === sym);
      const openOrders = symbolResult ? symbolResult.orders : [];
      const openAlgoOrders = symbolResult ? symbolResult.algoOrders : [];

      const realSlOrders = [
        ...openOrders.filter(o => o.type === 'STOP_MARKET'),
        ...openAlgoOrders.filter(o => o.orderType === 'STOP_MARKET').map(o => ({
          ...o,
          orderId: o.algoId,
          type: o.orderType,
          stopPrice: o.triggerPrice,
          isAlgo: true
        }))
      ];

      const realTpOrders = [
        ...openOrders.filter(o => o.type === 'TAKE_PROFIT_MARKET'),
        ...openAlgoOrders.filter(o => o.orderType === 'TAKE_PROFIT_MARKET').map(o => ({
          ...o,
          orderId: o.algoId,
          type: o.orderType,
          stopPrice: o.triggerPrice,
          isAlgo: true
        }))
      ];

      // ----------------------------------------------------
      // 0. Hỗ trợ PARTIAL TP (ROI >= 10% -> Đóng 50% vị thế)
      // ----------------------------------------------------
      if (roi >= 10 && !partialClosedSymbols.has(sym)) {
        partialClosedSymbols.add(sym);
        const closeQty = formatQuantity(sym, absAmt * 0.5); // Đóng 50%
        if (closeQty > 0) {
          log.system(`[AutoTrade] [Partial TP] Đóng 50% vị thế của ${sym}: qty = ${closeQty}`);
          try {
            await client.placeMarket(sym, oppositeSide, closeQty);
            await sendTelegram(`🔔 <b>[AutoTrade] Partial TP (50%)</b>\n• Coin: <b>${sym}</b>\n• Hướng đóng: <b>${oppositeSide}</b>\n• Số lượng đóng: <b>${closeQty}</b>\n• Giá khớp: <b>$${markPrice}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
          } catch (e) {
            log.error(`[AutoTrade] [Partial TP] Thất bại cho ${sym}: ${e.message}`);
          }
        }
      }

      // ----------------------------------------------------
      // 1. Quản lý TAKE PROFIT (TP = 20% ROI)
      // ----------------------------------------------------
      if (realTpOrders.length === 0) {
        if (roi >= 20) {
          log.system(`[AutoTrade] [Virtual TP] Kích hoạt cho ${sym}: ROI = ${roi.toFixed(2)}% (>= 20%). Đóng vị thế bằng lệnh MARKET.`);
          try {
            justClosedByBot.add(sym);
            await client.placeMarket(sym, oppositeSide, absAmt);
            await sendTelegram(`🔔 <b>[AutoTrade] Virtual TP</b>\n• Coin: <b>${sym}</b>\n• Hướng: <b>${oppositeSide} (Close)</b>\n• Giá khớp: <b>$${markPrice}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
          } catch (e) {
            justClosedByBot.delete(sym);
            log.error(`[AutoTrade] [Virtual TP] Lỗi đóng vị thế ${sym}: ${e.message}`);
          }
          continue; // Bỏ qua check SL cho coin này trong lượt này
        }

        // Đặt lệnh TP thật lên sàn vì vị thế đang mở và chưa có TP (50% còn lại tiếp tục giữ TP 20% như ban đầu)
        const tpPrice = isLong
          ? entryPrice * (1 + 0.20 / leverageVal)
          : entryPrice * (1 - 0.20 / leverageVal);

        try {
          const tpOrder = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', tpPrice);
          const tpId = tpOrder.orderId || tpOrder.algoId || 'unknown';
          log.system(`[AutoTrade] ✓ Đặt TP ${sym} @ $${tpOrder.stopPrice || tpOrder.triggerPrice || tpPrice} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          log.error(`[AutoTrade] Đặt TP ${sym} thất bại: ${_binanceErr(e)}`);
        }
      }

      // ----------------------------------------------------
      // 2. Quản lý STOP LOSS (SL = 13% ROI, Trailing SL entry + 1% khi ROI >= 10%)
      // ----------------------------------------------------
      // Tính mức SL mục tiêu
      const targetSlPrice = roi >= 10
        ? (isLong ? entryPrice * (1 + 0.01 / leverageVal) : entryPrice * (1 - 0.01 / leverageVal))
        : (isLong ? entryPrice * (1 - 0.13 / leverageVal) : entryPrice * (1 + 0.13 / leverageVal));

      // Lấy tickSize từ cache để định dạng giá chính xác
      let tickSize = null;
      try {
        const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);
          const tickSizes = data.tickSizes ?? {};
          tickSize = tickSizes[`${sym}USDT`] ?? null;
        }
      } catch (_) { }

      let roundedTargetSl;
      let dec;
      if (tickSize) {
        roundedTargetSl = Math.round(targetSlPrice / tickSize) * tickSize;
        dec = Math.max(0, Math.round(-Math.log10(tickSize)));
      } else {
        roundedTargetSl = targetSlPrice;
        dec = 5;
      }
      const targetSlStr = roundedTargetSl.toFixed(dec);

      if (realSlOrders.length > 0) {
        // Có lệnh SL trên sàn -> Chỉ thực hiện khi cần dịch chuyển Trailing SL (ROI >= 10%)
        if (roi >= 10) {
          let alreadyMoved = false;
          for (const o of realSlOrders) {
            const stopPrice = parseFloat(o.stopPrice);
            if (stopPrice.toFixed(dec) === targetSlStr) {
              alreadyMoved = true;
              break;
            }
          }

          if (!alreadyMoved) {
            log.system(`[AutoTrade] Trailing SL: ${sym} đạt ROI ${roi.toFixed(2)}% (>= 10%) -> Dịch SL trên sàn về entry + 1% ROI ($${targetSlStr})`);
            // Hủy SL cũ
            for (const o of realSlOrders) {
              try {
                if (o.isAlgo) {
                  await client.cancelAlgoOrder(sym, o.orderId);
                } else {
                  await client.cancelOrder(sym, o.orderId);
                }
                log.system(`[AutoTrade] Đã hủy SL cũ của ${sym} (orderId=${o.orderId})`);
              } catch (e) {
                log.warn(`[AutoTrade] Hủy SL cũ ${sym} thất bại: ${e.message}`);
              }
            }
            // Đặt SL mới
            try {
              const newSl = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', roundedTargetSl);
              const orderIdStr = newSl.orderId || newSl.algoId || 'unknown';
              const stopPriceStr = newSl.stopPrice || newSl.triggerPrice || roundedTargetSl;
              log.system(`[AutoTrade] ✓ Đã dịch SL mới cho ${sym} @ $${stopPriceStr} (orderId=${orderIdStr})`);
            } catch (e) {
              log.warn(`[AutoTrade] Đặt SL mới trên sàn thất bại: ${e.message} -> Sẽ quản lý Virtual SL từ lượt tiếp theo.`);
            }
          }
        }
      } else {
        // Không có lệnh SL trên sàn -> Đặt lệnh SL thật lên sàn
        // Kiểm tra trước xem đã chạm mốc cắt lỗ chưa (Virtual SL)
        const slTriggered = isLong
          ? (markPrice <= roundedTargetSl)
          : (markPrice >= roundedTargetSl);

        if (slTriggered) {
          const typeLabel = roi >= 10 ? 'Virtual Trailing SL (+1% ROI)' : 'Virtual SL (13%)';
          log.system(`[AutoTrade] [${typeLabel}] Kích hoạt cho ${sym}: Giá ${markPrice} chạm/vượt mốc $${targetSlStr}. Đóng vị thế bằng lệnh MARKET.`);
          try {
            justClosedByBot.add(sym);
            await client.placeMarket(sym, oppositeSide, absAmt);
            await sendTelegram(`🔔 <b>[AutoTrade] ${typeLabel}</b>\n• Coin: <b>${sym}</b>\n• Hướng: <b>${oppositeSide} (Close)</b>\n• Giá khớp: <b>$${markPrice}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
          } catch (e) {
            justClosedByBot.delete(sym);
            log.error(`[AutoTrade] [${typeLabel}] Lỗi đóng vị thế ${sym}: ${e.message}`);
          }
        } else {
          // Chưa chạm mốc cắt lỗ -> Đặt lệnh SL thật lên sàn
          try {
            const slOrder = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', roundedTargetSl);
            const slId = slOrder.orderId || slOrder.algoId || 'unknown';
            log.system(`[AutoTrade] ✓ Đặt SL ${sym} @ $${slOrder.stopPrice || slOrder.triggerPrice || roundedTargetSl} (đối ứng ${oppositeSide}) orderId=${slId}`);
          } catch (e) {
            log.error(`[AutoTrade] Đặt SL ${sym} thất bại: ${_binanceErr(e)}`);
          }
        }
      }
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi kiểm tra virtual TP/SL: ${err.message}`);
  }
}

async function notifyRealClose(client, sym, prevPos) {
  try {
    // Chờ 1.5 giây để Binance Futures cập nhật đầy đủ lịch sử giao dịch đóng vị thế
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Lấy 5 giao dịch cá nhân gần nhất của symbol này
    const trades = await client.getUserTrades(sym, 5);
    if (!trades || !trades.length) return;

    // Lọc các giao dịch đóng vị thế (có side ngược với hướng vị thế của prevPos)
    const oppositeSide = prevPos.isLong ? 'SELL' : 'BUY';
    const closeTrades = trades.filter(t => t.side === oppositeSide);
    if (!closeTrades.length) return;

    // Lấy giao dịch đóng mới nhất
    closeTrades.sort((a, b) => b.time - a.time);
    const lastTrade = closeTrades[0];

    const closePrice = parseFloat(lastTrade.price);
    const realizedProfit = parseFloat(lastTrade.realizedPnl || lastTrade.realizedProfit || '0');
    const timeStr = new Date(lastTrade.time).toLocaleString('vi-VN');

    // Tính toán tỷ lệ ROI thực tế khi đóng vị thế
    const priceDiff = prevPos.isLong ? (closePrice - prevPos.entryPrice) : (prevPos.entryPrice - closePrice);
    const roi = (priceDiff / prevPos.entryPrice) * prevPos.leverage * 100;

    // Phân loại lý do đóng
    let typeLabel = 'Đóng vị thế (Khớp sàn)';
    if (realizedProfit > 0) {
      typeLabel = '🎯 Take Profit (Sàn khớp)';
    } else if (realizedProfit < 0) {
      typeLabel = '🛡️ Stop Loss (Sàn khớp)';
    }

    const profitEmoji = realizedProfit >= 0 ? '🟢' : '🔴';

    await sendTelegram(
      `🔔 <b>[AutoTrade] ${typeLabel}</b>\n` +
      `• Coin: <b>${sym}</b>\n` +
      `• Hướng đóng: <b>${oppositeSide}</b>\n` +
      `• Giá entry: <b>$${prevPos.entryPrice}</b>\n` +
      `• Giá đóng: <b>$${closePrice}</b>\n` +
      `• ROI đạt: <b>${roi.toFixed(2)}%</b>\n` +
      `• Lợi nhuận: <b>${profitEmoji} $${realizedProfit.toFixed(2)}</b>\n` +
      `• Thời gian: <b>${timeStr}</b>`
    );
  } catch (e) {
    log.warn(`[AutoTrade] Lỗi gửi thông báo đóng vị thế ${sym}: ${e.message}`);
  }
}

module.exports = { startAutoTrade };
