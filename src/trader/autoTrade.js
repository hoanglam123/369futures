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
  overrideLevelLastSide,
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
  isGridWidthValid,
  YEAR_START_MS,
} = require('../pp369');
const { log } = require('../pp369/_logger');

const SCAN_INTERVAL_MS = 30_000;   // scan mỗi 30 giây
const TRAILING_SL_INTERVAL_MS = 3_000; // kiểm tra vị thế để dịch SL mỗi 3 giây (tăng interval để tránh rate limit)
const MONITOR_LIMIT_INTERVAL_MS = 3_000; // Luồng 3: monitor lệnh LIMIT đang chờ mỗi 3 giây
const DEBOUNCE_MS = 5 * 60_000; // 5 phút / tín hiệu
const COIN_REFRESH_INTERVAL_MS = 4 * 60 * 60_000; // Tái kiểm tra danh sách coin mỗi 4 giờ

// Debounce map: key → timestamp lần đặt lệnh gần nhất
const _fired = new Map();

// Tránh thông báo đóng vị thế trùng lặp giữa bot (Virtual) và sàn
const justClosedByBot = new Set();
const lastActivePositions = new Map(); // sym -> { entryPrice, leverage, amt, isLong }
const partialClosedSymbols = new Set(); // sym -> true (đã chốt lời 50% tại 13% ROI)

// Cache lưu metadata của vị thế đang chạy
const METADATA_PATH = path.join(process.cwd(), 'data', 'active_trades.json');
let activeTradesMetadata = {};
try {
  if (fs.existsSync(METADATA_PATH)) {
    activeTradesMetadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
  }
} catch (err) {
  log.warn(`[AutoTrade] Lỗi đọc active_trades.json: ${err.message}`);
}

function saveActiveTradesMetadata() {
  try {
    fs.writeFileSync(METADATA_PATH, JSON.stringify(activeTradesMetadata, null, 2), 'utf8');
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi ghi active_trades.json: ${err.message}`);
  }
}

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
  } catch (_) { }

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
  const limitTimeoutMinutes = parseInt(process.env.LIMIT_TIMEOUT_MINUTES || '15', 10);
  const limitTimeoutMs = limitTimeoutMinutes * 60_000;

  const activeSymbols = new Set();

  if (!apiKey || !secret) {
    throw new Error('Thiếu BINANCE_API_KEY hoặc BINANCE_SECRET trong .env');
  }

  log.system(`[AutoTrade] Khởi động: ${coins.length} coin | margin=$${amount} | ${leverage}x | type=${orderType}`);

  // Danh sách coin mutable — sẽ được cập nhật định kỳ theo giá hiện tại
  let activeCoinList = [...coins];

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
  const initialNearby = getNearbySymbols(activeCoinList, initialLevelCache, 0.01);

  // Khởi động WebSocket stream và đăng ký (subscribe) chỉ các mã đang gần mốc
  start369Stream(initialNearby);

  // ── Tái kiểm tra danh sách coin mỗi 4 giờ theo giá thị trường hiện tại ────
  setInterval(async () => {
    try {
      await updatePricesRest();
      const cachePath = path.join(process.cwd(), 'data', 'step_sizes.json');
      if (!fs.existsSync(cachePath)) return;
      const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const h4Cache = cacheData.h4Cache || {};
      const newList = Object.entries(h4Cache)
        .filter(([sym, e]) => {
          if (e.yearStart !== YEAR_START_MS || e.failed) return false;
          const currentPrice = getMarkPrice(sym);
          return isGridWidthValid(e, currentPrice, sym);
        })
        .map(([sym]) => sym);
      const oldCount = activeCoinList.length;
      activeCoinList = newList;
      log.system(`[AutoTrade] [CoinRefresh] Tái kiểm tra danh sách: ${oldCount} → ${activeCoinList.length} coin hợp lệ theo giá hiện tại.`);
    } catch (err) {
      log.warn(`[AutoTrade] [CoinRefresh] Lỗi tái kiểm tra danh sách coin: ${err.message}`);
    }
  }, COIN_REFRESH_INTERVAL_MS);

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

      // Quét và hủy các lệnh LIMIT treo quá hạn
      const now = Date.now();
      const remainingOrders = [];
      for (const order of currentOrders) {
        if (order.type === 'LIMIT' && (now - order.time) > limitTimeoutMs) {
          const sym = order.symbol.replace('USDT', '');
          log.system(`[AutoTrade] Lệnh LIMIT của ${sym} đã treo quá ${limitTimeoutMinutes} phút (${((now - order.time) / 60000).toFixed(1)} phút) -> Tiến hành hủy...`);
          try {
            await client.cancelOrder(sym, order.orderId);
            log.system(`[AutoTrade] ✓ Đã hủy thành công lệnh LIMIT treo của ${sym}`);

            if (activeTradesMetadata[sym]) {
              delete activeTradesMetadata[sym];
              saveActiveTradesMetadata();
            }

            sendTelegram(
              `⚠️ <b>[AutoTrade] Hủy lệnh Limit treo quá hạn</b>\n` +
              `• Coin: <b>${sym}</b>\n` +
              `• Hướng: <b>${order.side}</b>\n` +
              `• Giá đặt: <b>$${order.price}</b>\n` +
              `• Số lượng: <b>${order.origQty}</b>\n` +
              `• Đã chờ: <b>${((now - order.time) / 60000).toFixed(1)} phút</b>`
            ).catch(() => { });
          } catch (e) {
            log.warn(`[AutoTrade] Không thể hủy lệnh LIMIT của ${sym}: ${_binanceErr(e)}`);
            remainingOrders.push(order); // Giữ lại nếu hủy thất bại
          }
        } else {
          // ── Bounce Cancel: phát hiện giá đã chạm vùng entry rồi bật ra mạnh ───
          const sym = order.symbol.replace('USDT', '');
          const meta = activeTradesMetadata[sym];
          const markPrice = getMarkPrice(sym);

          if (meta && markPrice && meta.gridStepPct) {
            const entryPrice = parseFloat(order.price);
            const stepPct = meta.gridStepPct;
            const touchThresholdPct = 0.07;             // fixed 0.07% — khoảng cách tuyệt đối từ entry (không phụ thuộc grid)
            const bouncePct = stepPct / 5.5;          // ví dụ 3.7/5.5 = 0.67%

            if (order.side === 'BUY') {
              // LONG: touch zone là [entry, entry*(1 + touchThreshold%)]
              const touchZoneUpper = entryPrice * (1 + touchThresholdPct / 100);
              if (markPrice <= touchZoneUpper) {
                // Giá đang trong vùng touch — cập nhật điểm thấp nhất
                meta.touchLow = meta.touchLow == null ? markPrice : Math.min(meta.touchLow, markPrice);
              } else if (meta.touchLow != null) {
                // Đã từng touch và bây giờ giá đã thoát khỏi zone — kiểm tra bounce
                const bounceTarget = meta.touchLow * (1 + bouncePct / 100);
                if (markPrice >= bounceTarget) {
                  log.system(`[AutoTrade] [BounceCancel] ${sym} LONG: giá chạm ${meta.touchLow.toFixed(6)} rồi bật lên ${markPrice.toFixed(6)} (+${bouncePct.toFixed(2)}% từ đáy) → Hủy LIMIT stale`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} LONG</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Chạm đáy: <b>$${meta.touchLow.toFixed(6)}</b>\n` +
                      `• Bật lên: <b>$${markPrice.toFixed(6)}</b> (+${bouncePct.toFixed(2)}%)
                      `
                    ).catch(() => { });
                    if (activeTradesMetadata[sym]) {
                      delete activeTradesMetadata[sym];
                      saveActiveTradesMetadata();
                    }
                  } catch (e) {
                    log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${_binanceErr(e)}`);
                    remainingOrders.push(order);
                  }
                  continue; // order đã xử lý, không push vào remainingOrders
                }
              }
            } else if (order.side === 'SELL') {
              // SHORT: touch zone là [entry*(1 - touchThreshold%), entry]
              const touchZoneLower = entryPrice * (1 - touchThresholdPct / 100);
              if (markPrice >= touchZoneLower) {
                // Giá đang trong vùng touch — cập nhật điểm cao nhất
                meta.touchHigh = meta.touchHigh == null ? markPrice : Math.max(meta.touchHigh, markPrice);
              } else if (meta.touchHigh != null) {
                // Đã từng touch và bây giờ giá đã thoát khỏi zone — kiểm tra bounce
                const bounceTarget = meta.touchHigh * (1 - bouncePct / 100);
                if (markPrice <= bounceTarget) {
                  log.system(`[AutoTrade] [BounceCancel] ${sym} SHORT: giá chạm ${meta.touchHigh.toFixed(6)} rồi bật xuống ${markPrice.toFixed(6)} (-${bouncePct.toFixed(2)}% từ đỉnh) → Hủy LIMIT stale`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} SHORT</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Chạm đỉnh: <b>$${meta.touchHigh.toFixed(6)}</b>\n` +
                      `• Bật xuống: <b>$${markPrice.toFixed(6)}</b> (-${bouncePct.toFixed(2)}%)
                      `
                    ).catch(() => { });
                    if (activeTradesMetadata[sym]) {
                      delete activeTradesMetadata[sym];
                      saveActiveTradesMetadata();
                    }
                  } catch (e) {
                    log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${_binanceErr(e)}`);
                    remainingOrders.push(order);
                  }
                  continue; // order đã xử lý, không push vào remainingOrders
                }
              }
            }
          }

          remainingOrders.push(order);
        }
      }

      activeSymbols.clear();
      for (const p of currentPos) {
        activeSymbols.add(p.symbol.replace('USDT', ''));
      }
      for (const o of remainingOrders) {
        activeSymbols.add(o.symbol.replace('USDT', ''));
      }
      for (const o of currentAlgoOrders) {
        activeSymbols.add(o.symbol.replace('USDT', ''));
      }
    } catch (e) {
      log.warn(`[AutoTrade] Lỗi đồng bộ activeSymbols: ${_binanceErr(e)}`);
    }

    const levelCache = getLevelCache();
    const nearby = getNearbySymbols(activeCoinList, levelCache, 0.01);

    // 2. Đồng bộ danh sách đăng ký WebSocket (Subscribe các coin mới vào mốc, Unsubscribe các coin đã ra xa)
    syncWebSocketSubscriptions(nearby);

    // log.system(`[AutoTrade] Scan: ${nearby.length}/${activeCoinList.length} coin gần mốc phản ứng.`);
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

      // Bắt buộc phải có Tiêu chí 2 (Biến động H1/M15 an toàn - không có khung nào bị điểm cộng (+0đ))
      const hasCriterion2 = sig.scoreReasons && sig.scoreReasons.some(r => r.includes('[Biến động H1/M15]') && !r.includes('(+0đ)'));
      if (!hasCriterion2) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} không đạt Tiêu chí 2 (Biến động H1/M15 an toàn) — bỏ qua`);
        continue;
      }

      // Phân bổ ký quỹ (Margin) theo trần Max Score = 10.5đ
      const score = sig.score;
      let tradeAmount = 0;
      if (score < 5.5) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} có Score = ${sig.score}đ < 5.5đ — bỏ qua`);
        continue;
      } else if (score >= 9.0) {
        tradeAmount = 35; // Lệnh Siêu phẩm (Top 1%): Margin $35
      } else if (score >= 8.0) {
        tradeAmount = 25; // Lệnh Rất đẹp: Margin $25
      } else if (score >= 7.0) {
        tradeAmount = 15; // Lệnh Khá đẹp: Margin $15
      } else if (score >= 5.5) {
        tradeAmount = 10; // Lệnh Tiêu chuẩn: Margin $10
      }

      // Dow & Trendline đóng vai trò tiêu chí phụ trợ (+0đ đến +2đ). 
      // Quyết định vào lệnh hoàn toàn phụ thuộc vào tổng điểm Scorer PP369 (Score >= 5.5đ).


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
      sig.margin = tradeAmount; // Gán để ghi log signal

      // 2. Tính Notional động để cố định ký quỹ (Margin) = tradeAmount (10$ hoặc 20$)
      const currentNotional = tradeAmount * effectiveLeverage;

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
          log.system(`[AutoTrade] Set leverage ${sym}USDT = ${effectiveLeverage}x (Lưới: ${pct.toFixed(2)}% → tính được ${calculatedLeverage}x, giới hạn: ${maxAllowed}x | Ký quỹ mục tiêu: $${tradeAmount})`);
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

        // Lưu metadata vị thế để check TP/SL động
        // isCounterTrend chỉ xét H4 (xu hướng trung hạn)
        // H4 ngược = counter-trend thật → TP/SL chặt hơn
        // H1 ngược nhưng H4 thuận = pullback trong trend chính → không phạt
        const trendReason = sig.scoreReasons.find(r => r.includes('[Xu hướng H4/H1]'));
        const h4Part = trendReason ? trendReason.split('|')[0] : '';
        const isCounter = h4Part.includes('H4 ngược');

        activeTradesMetadata[sym] = {
          score: sig.score,
          isCounterTrend: isCounter,
          entryPrice: sig.targetLevel,
          side,                   // 'BUY' hoặc 'SELL' — dùng cho bounce cancel
          gridStepPct: (sig.step / sig.targetLevel) * 100, // % grid theo giá entry
          orderId: order.orderId ?? null,  // Luồng 3: dùng để cancel đúng lệnh
          maxFavorablePrice: null,         // Luồng 3: giá xa nhất đúng chiều từ sau khi đặt lệnh
          time: Date.now()
        };
        saveActiveTradesMetadata();

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

  // Luồng 2: Kiểm tra vị thế đang mở và dịch chuyển Stop Loss (Mỗi 3s)
  const trailingSlTimer = setInterval(() => {
    checkTrailingSL(client, leverage, leverageInfo, activeSymbols).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng Trailing SL: ${err.message}`);
    });
  }, TRAILING_SL_INTERVAL_MS);

  // Luồng 3: Monitor lệnh LIMIT đang chờ — Return Cancel (Mỗi 3s)
  const monitorLimitTimer = setInterval(() => {
    checkPendingLimits(client, activeSymbols).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng Monitor Limit: ${err.message}`);
    });
  }, MONITOR_LIMIT_INTERVAL_MS);

  // Trả về hàm stop để caller có thể dừng nếu cần
  return function stop() {
    clearInterval(timer);
    clearInterval(trailingSlTimer);
    clearInterval(monitorLimitTimer);
    log.system('[AutoTrade] Đã dừng.');
  };
}

function _binanceErr(e) {
  const d = e.response?.data;
  return d ? `[${d.code}] ${d.msg}` : e.message;
}

/**
 * Luồng 3: Return Cancel — Monitor lệnh LIMIT đang chờ khớp (mỗi 3s)
 *
 * Vấn đề giải quyết:
 *   Giá chạm entry → bounce → rồi quay lại fill lệnh LIMIT ở thời điểm
 *   bối cảnh đã xấu (support đã bị test lại = tín hiệu yếu).
 *
 * Logic:
 *   - Track maxFavorablePrice: giá xa nhất đi đúng chiều kể từ khi đặt lệnh
 *   - Khi giá đã từng bật ra >= bouncePct% khỏi entry (ghi nhận bounce thật)
 *     AND giá hiện tại quay về gần entry (<= touchThresholdPct% trên entry)
 *     → Hủy lệnh LIMIT (stale fill)
 *
 * Không gọi API: dùng getMarkPrice() từ WebSocket cache.
 * Chỉ gọi API cancelOrder khi thực sự cần cancel.
 */
async function checkPendingLimits(client, activeSymbols) {
  // Ngưỡng: giá phải bounce ra bao nhiêu % từ entry mới coi là bounce thật
  // Dùng gridStepPct/5.5 — ví dụ grid 3.7% → bouncePct = 0.67%
  const TOUCH_THRESHOLD_PCT = 0.15; // % tính từ entry — nếu giá về trong mức này → coi là "sắp fill lại"

  for (const [sym, meta] of Object.entries(activeTradesMetadata)) {
    // Chỉ xử lý lệnh LIMIT đang chờ (có orderId, chưa fill thành vị thế)
    if (!meta.orderId) continue;

    // Nếu đã có vị thế mở (fill rồi) → bỏ qua, để Luồng 2 xử lý
    if (activeSymbols && activeSymbols.has(sym)) {
      // Kiểm tra thêm: nếu sym trong activeSymbols nhưng vẫn là lệnh chờ
      // thì vẫn có thể monitor — activeSymbols bao gồm cả pending orders
      // Chỉ skip nếu đã có position thật (lastActivePositions)
      if (lastActivePositions.has(sym)) continue;
    }

    const markPrice = getMarkPrice(sym);
    if (!markPrice || !meta.entryPrice || !meta.gridStepPct) continue;

    const entry = meta.entryPrice;
    const bouncePct = meta.gridStepPct / 5.5; // ngưỡng bounce tối thiểu để ghi nhận

    if (meta.side === 'BUY') {
      // ── LONG: giá tốt khi đi LÊN khỏi entry ──────────────────────────────
      // Cập nhật giá cao nhất đã đạt được (đúng chiều LONG)
      if (meta.maxFavorablePrice === null || markPrice > meta.maxFavorablePrice) {
        meta.maxFavorablePrice = markPrice;
      }

      const maxFav = meta.maxFavorablePrice;
      const bouncedPct = ((maxFav - entry) / entry) * 100;
      const returnedPct = ((markPrice - entry) / entry) * 100;

      // Cancel khi: đã bounce đủ xa VÀ giá đã quay về gần entry
      if (bouncedPct >= bouncePct && returnedPct <= TOUCH_THRESHOLD_PCT) {
        log.system(
          `[AutoTrade] [ReturnCancel] ${sym} LONG: ` +
          `entry=$${entry}, max=$${maxFav.toFixed(6)} (+${bouncedPct.toFixed(2)}%), ` +
          `current=$${markPrice.toFixed(6)} (về ${returnedPct.toFixed(2)}% trên entry) → Hủy LIMIT stale`
        );
        try {
          await client.cancelOrder(sym, meta.orderId);
          overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
          sendTelegram(
            `🔄 <b>[AutoTrade] Hủy LIMIT (Return Cancel)</b>\n` +
            `• Coin: <b>${sym} LONG</b>\n` +
            `• Entry: <b>$${entry}</b>\n` +
            `• Đã bật lên: <b>$${maxFav.toFixed(6)}</b> (+${bouncedPct.toFixed(2)}%)\n` +
            `• Quay về: <b>$${markPrice.toFixed(6)}</b> — sắp fill lại → Hủy`
          ).catch(() => { });
          delete activeTradesMetadata[sym];
          saveActiveTradesMetadata();
        } catch (e) {
          const errStr = _binanceErr(e);
          log.warn(`[AutoTrade] [ReturnCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
          if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
            delete activeTradesMetadata[sym];
            saveActiveTradesMetadata();
          }
        }
      }

    } else if (meta.side === 'SELL') {
      // ── SHORT: giá tốt khi đi XUỐNG khỏi entry ───────────────────────────
      // Cập nhật giá thấp nhất đã đạt được (đúng chiều SHORT)
      if (meta.maxFavorablePrice === null || markPrice < meta.maxFavorablePrice) {
        meta.maxFavorablePrice = markPrice;
      }

      const maxFav = meta.maxFavorablePrice;
      const bouncedPct = ((entry - maxFav) / entry) * 100;
      const returnedPct = ((entry - markPrice) / entry) * 100;

      // Cancel khi: đã bounce đủ xa XUỐNG VÀ giá đã quay về gần entry
      if (bouncedPct >= bouncePct && returnedPct <= TOUCH_THRESHOLD_PCT) {
        log.system(
          `[AutoTrade] [ReturnCancel] ${sym} SHORT: ` +
          `entry=$${entry}, min=$${maxFav.toFixed(6)} (-${bouncedPct.toFixed(2)}%), ` +
          `current=$${markPrice.toFixed(6)} (về ${returnedPct.toFixed(2)}% dưới entry) → Hủy LIMIT stale`
        );
        try {
          await client.cancelOrder(sym, meta.orderId);
          overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
          sendTelegram(
            `🔄 <b>[AutoTrade] Hủy LIMIT (Return Cancel)</b>\n` +
            `• Coin: <b>${sym} SHORT</b>\n` +
            `• Entry: <b>$${entry}</b>\n` +
            `• Đã rớt xuống: <b>$${maxFav.toFixed(6)}</b> (-${bouncedPct.toFixed(2)}%)\n` +
            `• Quay về: <b>$${markPrice.toFixed(6)}</b> — sắp fill lại → Hủy`
          ).catch(() => { });
          delete activeTradesMetadata[sym];
          saveActiveTradesMetadata();
        } catch (e) {
          const errStr = _binanceErr(e);
          log.warn(`[AutoTrade] [ReturnCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
          if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
            delete activeTradesMetadata[sym];
            saveActiveTradesMetadata();
          }
        }
      }
    }
  }
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

        // Xóa metadata của vị thế đã đóng
        if (activeTradesMetadata[prevSym]) {
          delete activeTradesMetadata[prevSym];
          saveActiveTradesMetadata();
        }

        if (justClosedByBot.has(prevSym)) {
          justClosedByBot.delete(prevSym); // Bỏ qua vì bot đã chủ động gửi thông báo Virtual TP/SL rồi
        } else {
          notifyRealClose(client, prevSym, prevPos).catch(() => { });
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

    // Lấy toàn bộ lệnh thường và lệnh algo 1 lần (không theo symbol) rồi lọc — tránh N×2 requests song song gây timeout
    const [allOpenOrders, allAlgoOrdersRaw] = await Promise.all([
      client.getOpenOrders(),
      client.getOpenAlgoOrders()
    ]);
    const allAlgoOrders = Array.isArray(allAlgoOrdersRaw)
      ? allAlgoOrdersRaw
      : (allAlgoOrdersRaw?.orders ?? []);

    const symbolOrdersResults = openSymbols.map((sym) => {
      const symUsdt = `${sym}USDT`;
      const orders = allOpenOrders.filter(o => o.symbol === symUsdt);
      const algoOrders = allAlgoOrders.filter(o => o.symbol === symUsdt);
      return { sym, orders, algoOrders };
    });

    for (const p of positions) {
      const sym = p.symbol.replace('USDT', '');
      const entryPrice = parseFloat(p.entryPrice);
      const leverageVal = parseFloat(p.leverage);
      const amt = parseFloat(p.positionAmt);

      if (amt === 0 || entryPrice === 0) continue;

      const isLong = amt > 0;
      const absAmt = Math.abs(amt);
      const oppositeSide = isLong ? 'SELL' : 'BUY';

      // Ưu tiên dùng markPrice từ WebSocket cache (real-time, cập nhật liên tục)
      // thay vì p.markPrice từ REST API (có độ trễ 200-500ms, có thể bỏ lỡ bounce ngắn)
      const wsMark = getMarkPrice(sym);
      const markPrice = (wsMark && wsMark > 0) ? wsMark : parseFloat(p.markPrice);


      // ROI % = % thay đổi giá * leverage
      const roi = isLong
        ? ((markPrice - entryPrice) / entryPrice) * leverageVal * 100
        : ((entryPrice - markPrice) / entryPrice) * leverageVal * 100;


      // Lấy danh sách lệnh chờ của symbol hiện tại từ kết quả đã truy vấn
      const symbolResult = symbolOrdersResults.find(r => r.sym === sym);
      const openOrders = symbolResult ? symbolResult.orders : [];
      const openAlgoOrders = symbolResult ? symbolResult.algoOrders : [];

      const realSlOrders = [
        ...openOrders.filter(o => o.type === 'STOP_MARKET' || o.type === 'STOP'),
        ...openAlgoOrders.filter(o => o.type === 'STOP_MARKET' || o.orderType === 'STOP_MARKET' || o.type === 'STOP' || o.orderType === 'STOP').map(o => ({
          ...o,
          orderId: o.algoId,
          type: o.type || o.orderType,
          stopPrice: o.triggerPrice,
          isAlgo: true
        }))
      ];

      const realTpOrders = [
        ...openOrders.filter(o => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT'),
        ...openAlgoOrders.filter(o => o.type === 'TAKE_PROFIT_MARKET' || o.orderType === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.orderType === 'TAKE_PROFIT').map(o => ({
          ...o,
          orderId: o.algoId,
          type: o.type || o.orderType,
          stopPrice: o.triggerPrice,
          isAlgo: true
        }))
      ];

      // ----------------------------------------------------
      // Lấy cấu hình TP/SL dựa trên metadata của lệnh
      // ----------------------------------------------------
      const meta = activeTradesMetadata[sym];

      let tpPct = 20;        // ROI % chốt lời (mặc định)
      let slPct = -13;       // ROI % cắt lỗ (mặc định)
      let trailTrigger = 9;  // ROI % để bắt đầu dời SL về entry
      let trailSlRoi = 1;    // ROI % sau khi dời SL (entry + 1%)

      if (meta) {
        const isCounter = meta.isCounterTrend;
        const score = meta.score;

        if (isCounter) {
          // Lệnh ngược xu hướng: TP 10%, SL 8%, lãi ROI +5% dịch SL về mức hòa vốn (ROI +1%)
          tpPct = 10;
          slPct = -8;
          trailTrigger = 5;
          trailSlRoi = 1;
        } else if (score < 7) {
          // Lệnh điểm thấp (dưới 7đ, tức là [6.0 - 7.0)) và thuận xu hướng: TP=10%, SL 10%, lãi 5% dịch SL về mức hòa vốn (ROI +1%)
          tpPct = 10;
          slPct = -10;
          trailTrigger = 5;
          trailSlRoi = 1;
        } else if (score < 8) {
          // Lệnh điểm trung bình (dưới 8đ, tức là [7.0 - 8.0)) và thuận xu hướng: TP 20%, SL 13%, dịch SL về ROI +1% khi TP đạt 9%
          tpPct = 20;
          slPct = -13;
          trailTrigger = 9;
          trailSlRoi = 1;
        } else {
          // Lệnh thuận xu hướng & Điểm cao (>= 8đ): TP 25%, SL 15%, dịch SL về ROI +1% khi TP đạt 9%
          tpPct = 25;
          slPct = -15;
          trailTrigger = 9;
          trailSlRoi = 1;
        }
      }

      // ----------------------------------------------------
      // 1. Quản lý TAKE PROFIT (Virtual & Real)
      // ----------------------------------------------------

      // 1a. Virtual TP — luôn chạy độc lập, là tuyến phòng thủ cuối cùng.
      //     Đảm bảo chốt lời ngay cả khi algo TP đã đặt nhưng Binance không trigger
      //     (ví dụ: giá spike nhanh vượt trigger rồi rút về, mark vs last price lệch nhỏ).
      if (roi >= tpPct) {
        log.system(`[AutoTrade] [Virtual TP] Kích hoạt cho ${sym}: ROI = ${roi.toFixed(2)}% (>= ${tpPct}%). Đóng vị thế bằng lệnh MARKET.`);
        try {
          justClosedByBot.add(sym);
          await client.placeMarket(sym, oppositeSide, absAmt);
          await sendTelegram(`🎯 <b>Take Profit (Virtual)</b>\n• Coin: <b>${sym}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
        } catch (e) {
          justClosedByBot.delete(sym);
          log.error(`[AutoTrade] [Virtual TP] Lỗi đóng vị thế ${sym}: ${e.message}`);
        }
        continue; // Bỏ qua check SL cho coin này trong lượt này
      }

      // 1b. Đặt algo TP lên sàn (chỉ khi chưa có)
      if (realTpOrders.length === 0) {
        const tpPrice = isLong
          ? entryPrice * (1 + (tpPct / 100) / leverageVal)
          : entryPrice * (1 - (tpPct / 100) / leverageVal);

        try {
          const tpOrder = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', tpPrice);
          const tpId = tpOrder.orderId || tpOrder.algoId || 'unknown';
          log.system(`[AutoTrade] ✓ Đặt TP ${sym} @ $${tpOrder.stopPrice || tpOrder.triggerPrice || tpPrice} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          const errStr = _binanceErr(e);
          if (errStr.includes('-4509')) {
            log.system(`[AutoTrade] Vị thế ${sym} đã đóng trên sàn (TP/SL đã khớp trước đó). Bỏ qua.`);
            continue; // Vị thế đã đóng, không tiếp tục xử lý SL cho coin này nữa
          }
          log.error(`[AutoTrade] Đặt TP ${sym} thất bại: ${errStr}`);
        }
      }


      // ----------------------------------------------------
      // 2. Quản lý STOP LOSS (Virtual & Real, Trailing SL)
      // ----------------------------------------------------
      // Tính mức SL mục tiêu dựa trên trailing trigger 2 tầng (Bảo vệ lãi khi đạt 75% quãng đường)
      let currentSlPct = slPct;

      // Tầng 2: Khóa lãi khi giá chạy được 75% quãng đường tới TP
      const trailTrigger2 = tpPct >= 20 ? (tpPct === 20 ? 15 : 18) : null;
      const trailSlRoi2 = tpPct >= 20 ? (tpPct === 20 ? 8 : 10) : null;

      if (trailTrigger2 !== null && roi >= trailTrigger2) {
        currentSlPct = trailSlRoi2; // Khóa lãi (ví dụ +8% hoặc +10% ROI)
      } else if (roi >= trailTrigger) {
        currentSlPct = trailSlRoi;  // Hòa vốn (ví dụ +1% ROI)
      }

      const targetSlPrice = isLong
        ? entryPrice * (1 + (currentSlPct / 100) / leverageVal)
        : entryPrice * (1 - (currentSlPct / 100) / leverageVal);

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
        // Có lệnh SL trên sàn -> Chỉ thực hiện khi cần dịch chuyển Trailing SL (ROI >= trailTrigger)
        if (roi >= trailTrigger) {
          let alreadyMoved = false;
          let betterOrEqualExists = false;

          for (const o of realSlOrders) {
            const stopPrice = parseFloat(o.stopPrice);
            if (stopPrice.toFixed(dec) === targetSlStr) {
              alreadyMoved = true;
              break;
            }
            // Kiểm tra xem đã có lệnh SL tốt hơn (khóa lãi cao hơn) tồn tại trên sàn chưa
            if (isLong) {
              if (stopPrice > targetSlPrice) {
                betterOrEqualExists = true;
              }
            } else {
              if (stopPrice < targetSlPrice) {
                betterOrEqualExists = true;
              }
            }
          }

          if (!alreadyMoved && !betterOrEqualExists) {
            const levelLabel = currentSlPct === trailSlRoi ? 'Hòa vốn' : 'Khóa lãi';
            log.system(`[AutoTrade] Trailing SL: ${sym} đạt ROI ${roi.toFixed(2)}% -> Dịch SL trên sàn về entry + ${currentSlPct}% ROI ($${targetSlStr}) [Mức: ${levelLabel}]`);
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
              const errStr = _binanceErr(e);
              if (errStr.includes('-4509')) {
                log.system(`[AutoTrade] Vị thế ${sym} đã đóng trên sàn trong khi dịch SL.`);
              } else {
                log.warn(`[AutoTrade] Đặt SL mới trên sàn thất bại: ${e.message} -> Sẽ quản lý Virtual SL từ lượt tiếp theo.`);
              }
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
          const typeLabel = roi >= trailTrigger ? 'Trailing SL' : 'Stop Loss';
          log.system(`[AutoTrade] [Virtual ${typeLabel}] Kích hoạt cho ${sym}: Giá ${markPrice} chạm/vượt mốc $${targetSlStr}. Đóng vị thế bằng lệnh MARKET.`);
          try {
            justClosedByBot.add(sym);
            await client.placeMarket(sym, oppositeSide, absAmt);
            await sendTelegram(`🛡️ <b>${typeLabel} (Virtual)</b>\n• Coin: <b>${sym}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
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
            const errStr = _binanceErr(e);
            if (errStr.includes('-4509')) {
              log.system(`[AutoTrade] Vị thế ${sym} đã đóng trên sàn (TP/SL đã khớp trước đó). Bỏ qua.`);
            } else {
              log.error(`[AutoTrade] Đặt SL ${sym} thất bại: ${errStr}`);
            }
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

    let closePrice = null;
    let realizedProfit = 0;
    let roi = 0;
    let hasTradeData = false;

    try {
      // Lấy 5 giao dịch cá nhân gần nhất của symbol này
      const trades = await client.getUserTrades(sym, 5);
      if (trades && trades.length > 0) {
        const oppositeSide = prevPos.isLong ? 'SELL' : 'BUY';
        const closeTrades = trades.filter(t => t.side === oppositeSide);
        if (closeTrades.length > 0) {
          closeTrades.sort((a, b) => b.time - a.time);
          const lastTrade = closeTrades[0];

          closePrice = parseFloat(lastTrade.price);
          realizedProfit = parseFloat(lastTrade.realizedPnl || lastTrade.realizedProfit || '0');
          const priceDiff = prevPos.isLong ? (closePrice - prevPos.entryPrice) : (prevPos.entryPrice - closePrice);
          roi = (priceDiff / prevPos.entryPrice) * prevPos.leverage * 100;
          hasTradeData = true;
        }
      }
    } catch (tradeErr) {
      log.warn(`[AutoTrade] Lỗi lấy userTrades cho ${sym}: ${tradeErr.message}`);
    }

    // Phân loại lý do đóng
    let label = '🛡️ Đóng vị thế (Sàn khớp)';
    if (hasTradeData) {
      if (realizedProfit < 0) {
        label = '🛡️ Stop Loss';
      } else if (roi >= 15) {
        label = '🎯 Take Profit';
      } else if (roi >= 4) {
        label = '🛡️ Trailing SL (Khóa lãi)';
      } else {
        label = '🛡️ Trailing SL (Hòa vốn)';
      }
    }

    const roiStr = hasTradeData ? `\n• ROI đạt: <b>${roi.toFixed(2)}%</b>` : '';

    await sendTelegram(
      `<b>${label}</b>\n` +
      `• Coin: <b>${sym}</b>` +
      roiStr
    );
  } catch (e) {
    log.warn(`[AutoTrade] Lỗi gửi thông báo đóng vị thế ${sym}: ${e.message}`);
  }
}

module.exports = { startAutoTrade };
