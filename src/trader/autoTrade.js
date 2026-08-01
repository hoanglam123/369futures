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
  getStep,
  fetchBinanceKlines,
  updatePricesRest,
  syncWebSocketSubscriptions,
  notifySignals,
  sendTelegram,
  score369Method,
  isGridWidthValid,
  YEAR_START_MS,
  getMarketCapRank,
  recordTradeEntry,
  recordTradeExit,
  recordSkippedSignal,
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

// Watchlist cho các mã Score < 5.5đ để chờ check Retest nến H1
const lowScoreWatchlist = {}; // sym -> { symbol, signal, targetLevel, score, step, isCounterTrend, timestamp }
let lastCheckedH1Time = 0;

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
  const h1RetestLimitTimeoutMinutes = parseInt(process.env.H1_RETEST_LIMIT_TIMEOUT_MINUTES || '60', 10);
  const h1RetestLimitTimeoutMs = h1RetestLimitTimeoutMinutes * 60_000;
  const limitTouchedTimeoutMinutes = parseInt(process.env.LIMIT_TOUCHED_TIMEOUT_MINUTES || '5', 10);
  const limitTouchedTimeoutMs = limitTouchedTimeoutMinutes * 60_000;

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
        const sym = order.symbol.replace('USDT', '');
        const meta = activeTradesMetadata[sym];
        const isH1Retest = meta?.isH1Retest === true;
        const curTimeoutMs = isH1Retest ? h1RetestLimitTimeoutMs : limitTimeoutMs;
        const curTimeoutMinutes = isH1Retest ? h1RetestLimitTimeoutMinutes : limitTimeoutMinutes;
        const entryPrice = parseFloat(order.price);
        const markPrice = getMarkPrice(sym);

        // Đánh dấu nếu giá hiện tại đã chạm hoặc vượt mốc Entry
        if (meta && markPrice && entryPrice) {
          const isTouchLong = order.side === 'BUY' && markPrice <= entryPrice * 1.0012;
          const isTouchShort = order.side === 'SELL' && markPrice >= entryPrice * 0.9988;
          if (isTouchLong || isTouchShort) {
            if (!meta.hasTouchedEntry) {
              meta.hasTouchedEntry = true;
              meta.touchedTime = Date.now();
              saveActiveTradesMetadata();
            }
          }
        }

        const isTouchedTimeout = meta?.hasTouchedEntry === true && (now - (meta.touchedTime || order.time)) > limitTouchedTimeoutMs;
        const isNormalTimeout = (now - order.time) > curTimeoutMs;

        if (order.type === 'LIMIT' && (isNormalTimeout || isTouchedTimeout)) {
          const exitType = isTouchedTimeout ? 'LIMIT_TOUCHED_TIMEOUT' : 'LIMIT_TIMEOUT';
          const typeLabel = isTouchedTimeout
            ? `đã chạm/vượt Entry ($${entryPrice}) quá ${limitTouchedTimeoutMinutes} phút không khớp`
            : (isH1Retest ? `Retest H1 treo quá ${curTimeoutMinutes} phút` : `thường treo quá ${curTimeoutMinutes} phút`);

          log.system(`[AutoTrade] Lệnh LIMIT của ${sym} ${typeLabel} (${((now - (isTouchedTimeout ? meta.touchedTime : order.time)) / 60000).toFixed(1)} phút) -> Tiến hành hủy...`);
          try {
            await client.cancelOrder(sym, order.orderId);
            log.system(`[AutoTrade] ✓ Đã hủy thành công lệnh LIMIT treo của ${sym}`);

            // ── Record trade exit for AI Dataset trước khi xóa metadata ──
            if (meta) {
              const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
              recordTradeExit({
                tradeId: `${sym}-${meta.orderId || 'timeout'}`,
                orderId: String(meta.orderId || ''),
                symbol: sym,
                exitPrice: markPrice || parseFloat(order.price),
                exitTimestamp: Date.now(),
                exitType: exitType,
                pnlPercent: 0,
                pnlUsd: 0,
                holdingDurationMinutes: holdingDurationMinutes,
                isWin: false,
              });

              delete activeTradesMetadata[sym];
              saveActiveTradesMetadata();
            }

            const telegramTitle = isTouchedTimeout
              ? `⚠️ <b>[AutoTrade] Hủy lệnh Limit đã chạm Entry nhưng không khớp</b>`
              : `⚠️ <b>[AutoTrade] Hủy lệnh Limit ${isH1Retest ? 'Retest H1 ' : ''}treo quá hạn</b>`;

            const telegramWaitStr = isTouchedTimeout
              ? `• Đã chờ từ khi chạm: <b>${((now - (meta?.touchedTime || order.time)) / 60000).toFixed(1)} phút</b>`
              : `• Đã chờ: <b>${((now - order.time) / 60000).toFixed(1)} phút</b>`;

            sendTelegram(
              `${telegramTitle}\n` +
              `• Coin: <b>${sym}</b>\n` +
              `• Hướng: <b>${order.side}</b>\n` +
              `• Giá đặt: <b>$${order.price}</b>\n` +
              (markPrice ? `• Giá hiện tại: <b>$${markPrice}</b>\n` : '') +
              `• Số lượng: <b>${order.origQty}</b>\n` +
              telegramWaitStr
            ).catch(() => { });
          } catch (e) {
            log.warn(`[AutoTrade] Không thể hủy lệnh LIMIT của ${sym}: ${_binanceErr(e)}`);
            remainingOrders.push(order); // Giữ lại nếu hủy thất bại
          }
        } else {
          // ── Bounce Cancel: phát hiện giá đã chạm vùng entry rồi bật ra mạnh ───
          const sym = order.symbol.replace('USDT', '');
          const hasOpenPosition = currentPos.some(p => p.symbol === `${sym}USDT` && parseFloat(p.positionAmt) !== 0);
          if (hasOpenPosition) {
            // Nếu đã có vị thế mở trên sàn -> Không Bounce Cancel và KHÔNG xóa metadata vị thế!
            remainingOrders.push(order);
            continue;
          }

          const meta = activeTradesMetadata[sym];
          const markPrice = getMarkPrice(sym);

          if (meta && markPrice && meta.gridStepPct) {
            const entryPrice = parseFloat(order.price);
            const stepPct = meta.gridStepPct;
            const touchThresholdPct = 0.12;             // fixed 0.12% — khoảng cách tuyệt đối từ entry (không phụ thuộc grid)
            const bouncePct = stepPct / 5.5;          // ví dụ 3.7/5.5 = 0.67%

            if (order.side === 'BUY') {
              // LONG: kiểm tra xem giá hiện tại có bật nảy đi xa mốc entry hay chưa
              const currentBouncedPct = ((markPrice - entryPrice) / entryPrice) * 100;
              const touchZoneUpper = entryPrice * (1 + touchThresholdPct / 100);
              if (markPrice <= touchZoneUpper) {
                // Giá đang trong vùng touch — cập nhật điểm thấp nhất
                meta.touchLow = meta.touchLow == null ? markPrice : Math.min(meta.touchLow, markPrice);
              }

              const isBouncedFromTouch = meta.touchLow != null && markPrice >= (meta.touchLow * (1 + bouncePct / 100));
              const isBouncedFromEntry = currentBouncedPct >= bouncePct;

              if (isBouncedFromTouch || isBouncedFromEntry) {
                const bounceRef = meta.touchLow != null ? meta.touchLow : entryPrice;
                const bounceDisplayPct = meta.touchLow != null ? ((markPrice - meta.touchLow) / meta.touchLow * 100) : currentBouncedPct;
                log.system(`[AutoTrade] [BounceCancel] ${sym} LONG: giá từ mốc $${bounceRef.toFixed(6)} đã bật lên $${markPrice.toFixed(6)} (+${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`);
                try {
                  await client.cancelOrder(sym, order.orderId);
                  overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
                  sendTelegram(
                    `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                    `• Coin: <b>${sym} LONG</b>\n` +
                    `• Entry: <b>$${entryPrice}</b>\n` +
                    `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${bounceDisplayPct.toFixed(2)}%)\n` +
                    `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức`
                  ).catch(() => { });
                  // ── Record trade exit for AI Dataset (BOUNCE_CANCEL) ──
                  if (activeTradesMetadata[sym]) {
                    const metaCancel = activeTradesMetadata[sym];
                    const holdingDurationMinutes = (Date.now() - (metaCancel.time || Date.now())) / 60000;
                    recordTradeExit({
                      tradeId: `${sym}-${metaCancel.orderId || 'bounce'}`,
                      orderId: String(metaCancel.orderId || ''),
                      symbol: sym,
                      exitPrice: markPrice,
                      exitTimestamp: Date.now(),
                      exitType: 'BOUNCE_CANCEL',
                      pnlPercent: 0,
                      pnlUsd: 0,
                      holdingDurationMinutes: holdingDurationMinutes,
                      isWin: false,
                    });
                    delete activeTradesMetadata[sym];
                    saveActiveTradesMetadata();
                  }
                } catch (e) {
                  log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${_binanceErr(e)}`);
                  remainingOrders.push(order);
                }
                continue; // order đã xử lý, không push vào remainingOrders
              }
            } else if (order.side === 'SELL') {
              // SHORT: kiểm tra xem giá hiện tại có bật nảy đi xa mốc entry hay chưa
              const currentBouncedPct = ((entryPrice - markPrice) / entryPrice) * 100;
              const touchZoneLower = entryPrice * (1 - touchThresholdPct / 100);
              if (markPrice >= touchZoneLower) {
                // Giá đang trong vùng touch — cập nhật điểm cao nhất
                meta.touchHigh = meta.touchHigh == null ? markPrice : Math.max(meta.touchHigh, markPrice);
              }

              const isBouncedFromTouch = meta.touchHigh != null && markPrice <= (meta.touchHigh * (1 - bouncePct / 100));
              const isBouncedFromEntry = currentBouncedPct >= bouncePct;

              if (isBouncedFromTouch || isBouncedFromEntry) {
                const bounceRef = meta.touchHigh != null ? meta.touchHigh : entryPrice;
                const bounceDisplayPct = meta.touchHigh != null ? ((meta.touchHigh - markPrice) / meta.touchHigh * 100) : currentBouncedPct;
                log.system(`[AutoTrade] [BounceCancel] ${sym} SHORT: giá từ mốc $${bounceRef.toFixed(6)} đã bật xuống $${markPrice.toFixed(6)} (-${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`);
                try {
                  await client.cancelOrder(sym, order.orderId);
                  overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
                  sendTelegram(
                    `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                    `• Coin: <b>${sym} SHORT</b>\n` +
                    `• Entry: <b>$${entryPrice}</b>\n` +
                    `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${bounceDisplayPct.toFixed(2)}%)\n` +
                    `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức`
                  ).catch(() => { });
                  // ── Record trade exit for AI Dataset (BOUNCE_CANCEL) ──
                  if (activeTradesMetadata[sym]) {
                    const metaCancel = activeTradesMetadata[sym];
                    const holdingDurationMinutes = (Date.now() - (metaCancel.time || Date.now())) / 60000;
                    recordTradeExit({
                      tradeId: `${sym}-${metaCancel.orderId || 'bounce'}`,
                      orderId: String(metaCancel.orderId || ''),
                      symbol: sym,
                      exitPrice: markPrice,
                      exitTimestamp: Date.now(),
                      exitType: 'BOUNCE_CANCEL',
                      pnlPercent: 0,
                      pnlUsd: 0,
                      holdingDurationMinutes: holdingDurationMinutes,
                      isWin: false,
                    });
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

      const isBtc = sym === 'BTC';

      // Bắt buộc phải có Tiêu chí 2 (Biến động H1/M15 an toàn - không có khung nào bị điểm cộng (+0đ)). Riêng BTC bỏ qua.
      const hasCriterion2 = sig.scoreReasons && sig.scoreReasons.some(r => r.includes('[Biến động H1/M15]') && !r.includes('(+0đ)'));
      if (!isBtc && !hasCriterion2) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} không đạt Tiêu chí 2 (Biến động H1/M15 an toàn) — bỏ qua`);
        recordSkippedSignal({
          symbol: sym,
          signal: sig.signal,
          signalPrice: sig.targetLevel,
          score: sig.score ?? 0,
          scoreReasons: sig.scoreReasons || [],
          skipReason: 'NO_VOLATILITY_FILTER',
          markPrice: markPrice,
          marketCapRank: getMarketCapRank ? getMarketCapRank(sym) : 999,
        });
        continue;
      }

      // Phân bổ ký quỹ (Margin): Kết hợp Thang điểm Scorer PP369 + Thưởng Rank MarketCap
      const score = sig.score ?? 0;
      let baseMargin = 30;
      if (!isBtc && score < 5.5) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} có Score = ${sig.score}đ < 5.5đ — Đưa vào Watchlist chờ Retest nến H1`);
        lowScoreWatchlist[sym] = {
          symbol: sym,
          signal: sig.signal,
          targetLevel: sig.targetLevel,
          score: sig.score,
          step: sig.step || getStep(markPrice),
          isCounterTrend: sig.isCounterTrend,
          timestamp: Date.now()
        };
        // Ghi log để backfill phân tích (không ảnh hưởng hiệu năng)
        recordSkippedSignal({
          symbol: sym,
          signal: sig.signal,
          signalPrice: sig.targetLevel,
          score: sig.score,
          scoreReasons: sig.scoreReasons || [],
          skipReason: 'SCORE_TOO_LOW',
          markPrice: markPrice,
          marketCapRank: getMarketCapRank ? getMarketCapRank(sym) : 999,
        });
        continue;
      } else if (score >= 9.0) {
        baseMargin = 60; // Lệnh Siêu phẩm (Top 1%): Base Margin $60
      } else if (score >= 8.0) {
        baseMargin = 50; // Lệnh Rất đẹp: Base Margin $50
      } else if (score >= 7.0) {
        baseMargin = 40; // Lệnh Khá đẹp: Base Margin $40
      } else {
        baseMargin = 30; // Lệnh Tiêu chuẩn / BTC: Base Margin $30
      }

      // Thưởng thêm Ký quỹ (Bonus Margin) theo Xếp hạng vốn hóa MarketCap Rank
      const rank = getMarketCapRank ? getMarketCapRank(sym) : 999;
      let rankBonusMargin = 0;
      if (rank <= 10) {
        rankBonusMargin = 20; // Top 1-10 (BTC, ETH, BNB, SOL, XRP, DOGE...): +$20
      } else if (rank <= 30) {
        rankBonusMargin = 10; // Top 11-30 (ADA, LINK, SUI, AVAX, NEAR...): +$10
      }

      const tradeAmount = baseMargin + rankBonusMargin;

      // Dow & Trendline đóng vai trò tiêu chí phụ trợ (+0đ đến +2đ). 
      // Quyết định vào lệnh hoàn toàn phụ thuộc vào tổng điểm Scorer PP369 (Score >= 5.5đ).


      // Kiểm tra debounce
      if (_isDebounced(sig)) {
        log.system(`[AutoTrade] ${sym} ${sig.signal} đã đặt gần đây — bỏ qua`);
        recordSkippedSignal({
          symbol: sym,
          signal: sig.signal,
          signalPrice: sig.targetLevel,
          score: sig.score ?? 0,
          scoreReasons: sig.scoreReasons || [],
          skipReason: 'DEBOUNCED',
          markPrice: markPrice,
          marketCapRank: rank,
        });
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
      const pct = (gridWidth / Math.min(sig.targetLevel, sig.condLevel)) * 100; // % Khung kẹp giá

      // Pre-entry Bounce Check: Quét nến 1M từ lúc giá vừa chạm condLevel đến nay.
      // Nếu đã từng xát mốc entry (targetLevel) rồi nảy quá % Khung / 5.0 => Hủy LIMIT stale.
      const preEntryBouncePct = pct / 5.0; // Ngưỡng % Khung / 5.0 theo quy tắc 369
      const touchThresholdPct = 0.12;      // Tiệm cận 0.12% xát mốc
      let maxRecentBouncePct = null;      // Giá trị bounce tối đa ghi nhận cho dataset

      if (sig.recentM1Candles && sig.recentM1Candles.length > 0) {
        const recentM1 = sig.recentM1Candles;
        if (sig.signal === 'LONG') {
          // Bắt đầu quét từ thời điểm giá vừa chạm mốc Short trên (sig.condLevel) gần nhất
          let startIdx = 0;
          for (let i = recentM1.length - 1; i >= 0; i--) {
            if (recentM1[i].high >= sig.condLevel) {
              startIdx = i;
              break;
            }
          }

          const touchZoneUpper = sig.targetLevel * (1 + touchThresholdPct / 100);
          let maxBouncePct = 0;
          let bestTouchLow = 0;
          let bestPeakHigh = 0;

          for (let i = startIdx; i < recentM1.length; i++) {
            const candle = recentM1[i];
            if (candle.low <= touchZoneUpper) {
              const touchLow = candle.low;
              let peakHigh = markPrice;
              for (let j = i; j < recentM1.length; j++) {
                if (recentM1[j].high > peakHigh) {
                  peakHigh = recentM1[j].high;
                }
              }
              const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
              if (bouncePct > maxBouncePct) {
                maxBouncePct = bouncePct;
                bestTouchLow = touchLow;
                bestPeakHigh = peakHigh;
              }
            }
          }

          if (maxBouncePct >= preEntryBouncePct) {
            log.system(
              `[AutoTrade] ${sym} LONG: Từ khi chạm mốc Short ($${sig.condLevel}), nến M1 đã xát mốc entry LONG ($${bestTouchLow.toFixed(6)}) ` +
              `rồi nảy lên đỉnh $${bestPeakHigh.toFixed(6)} (+${maxBouncePct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}% Khung/5) — HỦY LIMIT stale.`
            );
            continue;
          }
          // Record max bounce for dataset if trade is allowed
          maxRecentBouncePct = maxBouncePct;
        } else if (sig.signal === 'SHORT') {
          // Bắt đầu quét từ thời điểm giá vừa chạm mốc Long dưới (sig.condLevel) gần nhất
          let startIdx = 0;
          for (let i = recentM1.length - 1; i >= 0; i--) {
            if (recentM1[i].low <= sig.condLevel) {
              startIdx = i;
              break;
            }
          }

          const touchZoneLower = sig.targetLevel * (1 - touchThresholdPct / 100);
          let maxDropPct = 0;
          let bestTouchHigh = 0;
          let bestTroughLow = 0;

          for (let i = startIdx; i < recentM1.length; i++) {
            const candle = recentM1[i];
            if (candle.high >= touchZoneLower) {
              const touchHigh = candle.high;
              let troughLow = markPrice;
              for (let j = i; j < recentM1.length; j++) {
                if (recentM1[j].low < troughLow) {
                  troughLow = recentM1[j].low;
                }
              }
              const dropPct = ((touchHigh - troughLow) / touchHigh) * 100;
              if (dropPct > maxDropPct) {
                maxDropPct = dropPct;
                bestTouchHigh = touchHigh;
                bestTroughLow = troughLow;
              }
            }
          }

          if (maxDropPct >= preEntryBouncePct) {
            log.system(
              `[AutoTrade] ${sym} SHORT: Từ khi chạm mốc Long ($${sig.condLevel}), nến M1 đã xát mốc entry SHORT ($${bestTouchHigh.toFixed(6)}) ` +
              `rồi nảy xuống đáy $${bestTroughLow.toFixed(6)} (-${maxDropPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}% Khung/5) — HỦY LIMIT stale.`
            );
            continue;
          }
          // Record max bounce for dataset if trade is allowed
          maxRecentBouncePct = maxDropPct;
        }
      } else {
        // Fallback: So sánh trực tiếp markPrice với targetLevel nếu chưa có nến M1
        if (sig.signal === 'LONG') {
          const bouncedAwayPct = ((markPrice - sig.targetLevel) / sig.targetLevel) * 100;
          if (bouncedAwayPct >= preEntryBouncePct) {
            log.system(`[AutoTrade] ${sym} LONG đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} +${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%) — bỏ qua không đặt lệnh LIMIT stale.`);
            continue;
          }
        } else if (sig.signal === 'SHORT') {
          const bouncedAwayPct = ((sig.targetLevel - markPrice) / sig.targetLevel) * 100;
          if (bouncedAwayPct >= preEntryBouncePct) {
            log.system(`[AutoTrade] ${sym} SHORT đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} -${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%) — bỏ qua không đặt lệnh LIMIT stale.`);
            continue;
          }
        }
      }
      // Đòn bẩy tính theo quy định SL = unit (step / 3) tương đương đúng -13% Margin
      const calculatedLeverage = Math.floor(39 / pct); // 13% * 3 / pct
      const maxAllowed = leverageInfo[sym] ?? leverage; // leverage mặc định từ .env làm fallback
      const effectiveLeverage = Math.max(1, Math.min(calculatedLeverage, maxAllowed));

      sig.leverage = effectiveLeverage; // Gán vào signal để formatter hiển thị đòn bẩy chính xác trên Telegram
      sig.margin = tradeAmount; // Gán để ghi log signal

      // 2. Tính Notional động để cố định ký quỹ (Margin) = tradeAmount (20$ đến 50$)
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
          time: Date.now(),
          // ── Dataset Collector ──
          markPrice: markPrice,
          scoreReasons: sig.scoreReasons,
          marketCapRank: rank,
          leverage: effectiveLeverage,
          margin: tradeAmount,
          maxRecentBouncePct: maxRecentBouncePct ?? null, // Calculated in pre-entry bounce check
        };
        saveActiveTradesMetadata();

        // ── Record trade entry for AI Dataset ──
        recordTradeEntry({
          tradeId: `${sym}-${order.orderId || Date.now()}`,
          orderId: String(order.orderId || ''),
          symbol: sym,
          signal: sig.signal,
          entryPrice: sig.targetLevel,
          markPrice: markPrice,
          score: sig.score,
          scoreReasons: sig.scoreReasons,
          marketCapRank: rank,
          gridWidthPct: pct,
          maxRecentBouncePct: maxRecentBouncePct ?? null,
          leverage: effectiveLeverage,
          margin: tradeAmount,
        });

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

  // Luồng 4: Check Retest nến H1 cho các mã trong Watchlist (Mỗi 10s kiểm tra xem H1 vừa đóng chưa)
  const h1RetestTimer = setInterval(() => {
    checkH1RetestSignals(client).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng Check H1 Retest: ${err.message}`);
    });
  }, 10000);

  // Trả về hàm stop để caller có thể dừng nếu cần
  return function stop() {
    clearInterval(timer);
    clearInterval(trailingSlTimer);
    clearInterval(monitorLimitTimer);
    clearInterval(h1RetestTimer);
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
      if (markPrice <= entry * 1.0012) {
        if (!meta.hasTouchedEntry) {
          meta.hasTouchedEntry = true;
          meta.touchedTime = Date.now();
          saveActiveTradesMetadata();
        }
      }

      if (meta.maxFavorablePrice === null || markPrice > meta.maxFavorablePrice) {
        meta.maxFavorablePrice = markPrice;
      }

      const maxFav = meta.maxFavorablePrice;
      const maxBouncedPct = ((maxFav - entry) / entry) * 100;
      const currentBouncedPct = ((markPrice - entry) / entry) * 100;
      const maxBouncedRoi = maxBouncedPct * (meta.leverage || 1);
      const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);

      // Lệnh H1 Retest: Hủy khi ROI >= 5%. Lệnh thường: Hủy khi giá nảy >= bouncePct (gridStepPct / 5.5 ~7-8% ROI)
      const isRetestCancel = meta.isH1Retest && (currentBouncedRoi >= 5.0 || maxBouncedRoi >= 5.0);
      const isRegularCancel = currentBouncedPct >= bouncePct || maxBouncedPct >= bouncePct;

      if (isRetestCancel || isRegularCancel) {
        const displayPct = currentBouncedPct >= bouncePct ? currentBouncedPct : maxBouncedPct;
        log.system(
          `[AutoTrade] [BounceCancel] ${sym} LONG: ` +
          `entry=$${entry}, current=$${markPrice.toFixed(6)} (+${displayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`
        );
        try {
          await client.cancelOrder(sym, meta.orderId);
          overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
          sendTelegram(
            `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
            `• Coin: <b>${sym} LONG</b>\n` +
            `• Entry: <b>$${entry}</b>\n` +
            `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${displayPct.toFixed(2)}%)\n` +
            `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức`
          ).catch(() => { });
          // ── Record trade exit for AI Dataset (BOUNCE_CANCEL) ──
          const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
          recordTradeExit({
            tradeId: `${sym}-${meta.orderId || 'bounce'}`,
            orderId: String(meta.orderId || ''),
            symbol: sym,
            exitPrice: markPrice,
            exitTimestamp: Date.now(),
            exitType: 'BOUNCE_CANCEL',
            pnlPercent: 0,
            pnlUsd: 0,
            holdingDurationMinutes: holdingDurationMinutes,
            isWin: false,
          });
          if (!lastActivePositions.has(sym)) {
            delete activeTradesMetadata[sym];
            saveActiveTradesMetadata();
          } else {
            meta.orderId = null;
          }
        } catch (e) {
          const errStr = _binanceErr(e);
          log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
          if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
            if (!lastActivePositions.has(sym)) {
              delete activeTradesMetadata[sym];
              saveActiveTradesMetadata();
            } else {
              meta.orderId = null;
            }
          }
        }
      }

    } else if (meta.side === 'SELL') {
      // ── SHORT: giá tốt khi đi XUỐNG khỏi entry ───────────────────────────
      if (markPrice >= entry * 0.9988) {
        if (!meta.hasTouchedEntry) {
          meta.hasTouchedEntry = true;
          meta.touchedTime = Date.now();
          saveActiveTradesMetadata();
        }
      }

      if (meta.maxFavorablePrice === null || markPrice < meta.maxFavorablePrice) {
        meta.maxFavorablePrice = markPrice;
      }

      const minFav = meta.maxFavorablePrice;
      const maxBouncedPct = ((entry - minFav) / entry) * 100;
      const currentBouncedPct = ((entry - markPrice) / entry) * 100;
      const maxBouncedRoi = maxBouncedPct * (meta.leverage || 1);
      const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);

      // Lệnh H1 Retest: Hủy khi ROI >= 5%. Lệnh thường: Hủy khi giá nảy >= bouncePct (gridStepPct / 5.5 ~7-8% ROI)
      const isRetestCancel = meta.isH1Retest && (currentBouncedRoi >= 5.0 || maxBouncedRoi >= 5.0);
      const isRegularCancel = currentBouncedPct >= bouncePct || maxBouncedPct >= bouncePct;

      if (isRetestCancel || isRegularCancel) {
        const displayPct = currentBouncedPct >= bouncePct ? currentBouncedPct : maxBouncedPct;
        log.system(
          `[AutoTrade] [BounceCancel] ${sym} SHORT: ` +
          `entry=$${entry}, current=$${markPrice.toFixed(6)} (-${displayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`
        );
        try {
          await client.cancelOrder(sym, meta.orderId);
          overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
          sendTelegram(
            `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
            `• Coin: <b>${sym} SHORT</b>\n` +
            `• Entry: <b>$${entry}</b>\n` +
            `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${displayPct.toFixed(2)}%)\n` +
            `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức`
          ).catch(() => { });
          // ── Record trade exit for AI Dataset (BOUNCE_CANCEL) ──
          const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
          recordTradeExit({
            tradeId: `${sym}-${meta.orderId || 'bounce'}`,
            orderId: String(meta.orderId || ''),
            symbol: sym,
            exitPrice: markPrice,
            exitTimestamp: Date.now(),
            exitType: 'BOUNCE_CANCEL',
            pnlPercent: 0,
            pnlUsd: 0,
            holdingDurationMinutes: holdingDurationMinutes,
            isWin: false,
          });
          if (!lastActivePositions.has(sym)) {
            delete activeTradesMetadata[sym];
            saveActiveTradesMetadata();
          } else {
            meta.orderId = null;
          }
        } catch (e) {
          const errStr = _binanceErr(e);
          log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
          if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
            if (!lastActivePositions.has(sym)) {
              delete activeTradesMetadata[sym];
              saveActiveTradesMetadata();
            } else {
              meta.orderId = null;
            }
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

/**
 * Luồng 4: Check Retest nến H1 cho các mã trong Watchlist (Chạy ở phút 00 của mỗi giờ)
 */
async function checkH1RetestSignals(client) {
  const currentH1Time = Math.floor(Date.now() / 3600000) * 3600000;
  if (currentH1Time === lastCheckedH1Time) return;
  lastCheckedH1Time = currentH1Time;

  const symbolsToWatch = Object.keys(lowScoreWatchlist);
  if (symbolsToWatch.length === 0) return;

  log.system(`[H1Retest] === Kiểm tra Retest nến H1 vừa đóng cho ${symbolsToWatch.length} coin trong Watchlist ===`);

  const prevH1Start = currentH1Time - 3600000;

  for (const sym of symbolsToWatch) {
    const watchData = lowScoreWatchlist[sym];
    if (!watchData) continue;

    // Hết hạn sau 24h nếu không có retest
    if (Date.now() - watchData.timestamp > 24 * 3600 * 1000) {
      delete lowScoreWatchlist[sym];
      continue;
    }

    try {
      // Kiểm tra nếu đã có vị thế mở hoặc lệnh chờ -> Bỏ qua
      const hasPos = await client.hasOpenPosition(sym);
      if (hasPos) {
        delete lowScoreWatchlist[sym];
        continue;
      }

      // Tải 60 nến 1M của giờ H1 vừa trôi qua
      const m1Candles = await fetchBinanceKlines(sym, '1m', prevH1Start, 60);
      if (!m1Candles || m1Candles.length === 0) continue;

      const { signal, targetLevel, step } = watchData;
      const isLong = signal === 'LONG';

      // Lấy giá Open/Close/High/Low tổng quan của cả nến H1
      const h1Close = m1Candles[m1Candles.length - 1].close;
      const h1MinLow = Math.min(...m1Candles.map(c => c.low));
      const h1MaxHigh = Math.max(...m1Candles.map(c => c.high));

      // 1. Check nến H1 có rút chân/rút râu tại Entry không:
      let isRutChan = false;
      if (isLong) {
        // LONG: chạm/vượt mốc entry (minLow <= targetLevel) VÀ đóng nến trên entry (h1Close > targetLevel)
        isRutChan = h1MinLow <= targetLevel && h1Close > targetLevel;
      } else {
        // SHORT: chạm/vượt mốc entry (maxHigh >= targetLevel) VÀ đóng nến dưới entry (h1Close < targetLevel)
        isRutChan = h1MaxHigh >= targetLevel && h1Close < targetLevel;
      }

      if (!isRutChan) continue; // Nến H1 chưa đóng rút chân tại entry

      // 2. Tìm thời điểm (index) chạm entry lần đầu tiên trong chuỗi nến 1M
      let touchIndex = -1;
      for (let i = 0; i < m1Candles.length; i++) {
        const c = m1Candles[i];
        if (isLong && c.low <= targetLevel) {
          touchIndex = i;
          break;
        } else if (!isLong && c.high >= targetLevel) {
          touchIndex = i;
          break;
        }
      }

      if (touchIndex === -1) continue;

      // 3. Tính Mức Nẩy ROI Tối Đa từ nến 1M (sau thời điểm touchIndex)
      let maxFavorableMovePct = 0;
      if (isLong) {
        let maxHighAfterTouch = targetLevel;
        for (let i = touchIndex; i < m1Candles.length; i++) {
          if (m1Candles[i].high > maxHighAfterTouch) {
            maxHighAfterTouch = m1Candles[i].high;
          }
        }
        maxFavorableMovePct = ((maxHighAfterTouch - targetLevel) / targetLevel) * 100;
      } else {
        let minLowAfterTouch = targetLevel;
        for (let i = touchIndex; i < m1Candles.length; i++) {
          if (m1Candles[i].low < minLowAfterTouch) {
            minLowAfterTouch = m1Candles[i].low;
          }
        }
        maxFavorableMovePct = ((targetLevel - minLowAfterTouch) / targetLevel) * 100;
      }

      // Tính đòn bẩy động
      const gridStepPct = (step / targetLevel) * 100;
      const leverage = Math.max(1, Math.floor(39 / gridStepPct));
      const maxFavorableRoi = maxFavorableMovePct * leverage;

      if (maxFavorableRoi >= 5.0) {
        log.system(`[H1Retest] ${sym} ${signal} nến H1 rút chân nhưng ĐÃ PHẢN ỨNG NẢY ROI = +${maxFavorableRoi.toFixed(2)}% (>= 5.0%) sau khi chạm entry. Bỏ qua không đặt limit.`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      // CHƯA PHẢN ỨNG ĐỦ 5% ROI -> Tiến hành ĐẶT LỆNH LIMIT NGAY TẠI MỐC ENTRY!
      log.system(`[H1Retest] 🎯 ${sym} ${signal} H1 đóng rút chân chuẩn tại Entry $${targetLevel}, chưa nảy đủ 5% ROI (Max ROI: +${maxFavorableRoi.toFixed(2)}%). ĐẶT LỆNH LIMIT TẠI ENTRY!`);

      const side = isLong ? 'BUY' : 'SELL';
      const tradeAmount = 20; // Margin cơ bản $20 cho lệnh Retest H1
      const notional = tradeAmount * leverage;
      const { qty } = calcQuantity(sym, notional, targetLevel);
      const dec = getDecimals(targetLevel);

      if (qty <= 0) {
        log.warn(`[H1Retest] ${sym}: quantity calculation <= 0 — bỏ qua không đặt limit`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      try {
        try { await client.setLeverage(sym, leverage); } catch (_) { }

        const limitOrder = await client.placeLimit(sym, side, qty, targetLevel, dec);
        const limitId = limitOrder.orderId || limitOrder.id || 'unknown';

        log.system(`[H1Retest] ✓ Đã đặt thành công lệnh LIMIT Retest H1 cho ${sym} ${side} ${qty} @ $${targetLevel} (orderId=${limitId})`);

        // Đưa thông tin vào activeTradesMetadata để luồng Trailing SL và Bounce Cancel tự động quản lý!
        activeTradesMetadata[sym] = {
          symbol: sym,
          side: side,
          entryPrice: targetLevel,
          orderId: String(limitId),
          time: Date.now(),
          score: watchData.score,
          isCounterTrend: watchData.isCounterTrend,
          leverage: leverage,
          step: step,
          gridStepPct: gridStepPct,
          margin: tradeAmount,
          maxFavorablePrice: null,
          isH1Retest: true
        };
        saveActiveTradesMetadata();

        // Xóa khỏi watchlist vì đã đặt lệnh thành công
        delete lowScoreWatchlist[sym];

        // Bắn thông báo Telegram
        await sendTelegram(
          `🎯 <b>[AutoTrade] Lệnh LIMIT Retest H1</b>\n` +
          `• Coin: <b>${sym}USDT (${signal})</b>\n` +
          `• Giá Entry: <b>$${targetLevel}</b>\n` +
          `• Đòn bẩy: <b>${leverage}x</b> (Ký quỹ: $${tradeAmount})\n` +
          `• Score gốc: <b>${watchData.score}đ</b>\n` +
          `• Lý do: Nến H1 đóng rút chân chuẩn tại Entry, chưa nảy đủ 5% ROI (Max ROI: +${maxFavorableRoi.toFixed(2)}%)`
        );
      } catch (err) {
        log.error(`[H1Retest] Lỗi đặt lệnh LIMIT cho ${sym}: ${err.message}`);
        delete lowScoreWatchlist[sym];
      }
    } catch (e) {
      log.error(`[H1Retest] Lỗi xử lý ${sym}: ${e.message}`);
    }
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
        partialClosedSymbols.delete(prevSym);

        // Get metadata before deleting
        const meta = activeTradesMetadata[prevSym];

        // Xóa metadata của vị thế đã đóng
        if (activeTradesMetadata[prevSym]) {
          delete activeTradesMetadata[prevSym];
          saveActiveTradesMetadata();
        }

        if (justClosedByBot.has(prevSym)) {
          justClosedByBot.delete(prevSym); // Bỏ qua vì bot đã chủ động gửi thông báo Virtual TP/SL rồi
        } else {
          notifyRealClose(client, prevSym, prevPos, meta).catch(() => { });
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
      // Lấy cấu hình TP/SL dựa trên Quy Tắc Bước Giá (Unit = Step / 3)
      // ----------------------------------------------------
      const meta = activeTradesMetadata[sym];

      // 1. Xác định Bước giá (Step) & Đơn vị (Unit = Step / 3)
      const currentStep = meta?.step || getStep(entryPrice);
      const unit = currentStep / 3;

      // 2. Quyết định Tỷ lệ TP theo Score (với step=300 -> unit=100):
      //    - Score < 7đ (hoặc Ngược Trend): TP = 90 ticks  -> tpMultiplier = 0.9
      //    - Score < 8đ (7.0 - 7.9đ):       TP = 120 ticks -> tpMultiplier = 1.2
      //    - Score >= 8đ (>= 8.0đ):         TP = 150 ticks -> tpMultiplier = 1.5
      let tpMultiplier = 0.9;
      if (meta) {
        const isCounter = meta.isCounterTrend;
        const score = meta.score;

        if (isCounter || score < 7) {
          tpMultiplier = 0.9;  // 90 ticks (với step=300)
        } else if (score < 8) {
          tpMultiplier = 1.2;  // 120 ticks (với step=300)
        } else {
          tpMultiplier = 1.5;  // 150 ticks (với step=300)
        }
      }

      // 3. Tính khoảng cách giá tuyệt đối:
      //    SL = entry +/- unit (tương đương đúng -13% Margin với đòn bẩy = 39 / gridStepPct)
      //    TP = entry +/- (unit * tpMultiplier) -> 90, 120, 150 ticks với step=300
      //    Trail Trigger = entry +/- (unit * 0.45) -> CỐ ĐỊNH 45 ticks với step=300 cho TẤT CẢ các thang điểm!
      const tpDistance = unit * tpMultiplier;
      const trailDistance = unit * 0.45; // Cố định 45 ticks (0.45 * unit) cho mọi thang điểm

      let targetSlPriceExact, targetTpPriceExact, trailTriggerPriceExact;
      if (isLong) {
        targetSlPriceExact = entryPrice - unit;
        targetTpPriceExact = entryPrice + tpDistance;
        trailTriggerPriceExact = entryPrice + trailDistance;
      } else {
        targetSlPriceExact = entryPrice + unit;
        targetTpPriceExact = entryPrice - tpDistance;
        trailTriggerPriceExact = entryPrice - trailDistance;
      }

      // Đổi sang ROI % tương đương để logging / telegram / dataset
      const slPct = -13;
      const tpPct = parseFloat(((tpDistance / entryPrice) * leverageVal * 100).toFixed(2));
      const trailTrigger = parseFloat(((trailDistance / entryPrice) * leverageVal * 100).toFixed(2));
      const trailSlRoi = 1; // ROI +1% khi dời SL hòa vốn

      // ----------------------------------------------------
      // 1. Quản lý TAKE PROFIT (Virtual & Real)
      // ----------------------------------------------------

      // 1a. Virtual TP — đóng vị thế ngay khi giá chạm mốc TP mục tiêu
      const isTpReached = isLong ? (markPrice >= targetTpPriceExact) : (markPrice <= targetTpPriceExact);
      if (isTpReached) {
        log.system(`[AutoTrade] [Virtual TP] Kích hoạt cho ${sym}: Giá $${markPrice} chạm TP $${targetTpPriceExact.toFixed(5)} (ROI ~${roi.toFixed(2)}%). Đóng vị thế MARKET.`);
        try {
          justClosedByBot.add(sym);
          await client.placeMarket(sym, oppositeSide, absAmt);
          await sendTelegram(`🎯 <b>Take Profit (Virtual)</b>\n• Coin: <b>${sym}</b>\n• Giá chạm: <b>$${markPrice}</b> (TP: $${targetTpPriceExact.toFixed(5)})\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
          // ── Record trade exit for AI Dataset ──
          if (meta) {
            const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
            recordTradeExit({
              tradeId: `${sym}-${meta.orderId || 'vTP'}`,
              orderId: String(meta.orderId || ''),
              symbol: sym,
              exitPrice: markPrice,
              exitTimestamp: Date.now(),
              exitType: 'TP',
              pnlPercent: roi,
              pnlUsd: (roi / 100) * (meta.margin || 0),
              holdingDurationMinutes: holdingDurationMinutes,
              isWin: true,
            });
          }
        } catch (e) {
          justClosedByBot.delete(sym);
          log.error(`[AutoTrade] [Virtual TP] Lỗi đóng vị thế ${sym}: ${e.message}`);
        }
        continue; // Bỏ qua check SL cho coin này trong lượt này
      }

      // 1b. Đặt algo TP lên sàn tại mốc targetTpPriceExact (chỉ khi chưa có)
      if (realTpOrders.length === 0) {
        try {
          const tpOrder = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', targetTpPriceExact);
          const tpId = tpOrder.orderId || tpOrder.algoId || 'unknown';
          log.system(`[AutoTrade] ✓ Đặt TP ${sym} @ $${tpOrder.stopPrice || tpOrder.triggerPrice || targetTpPriceExact.toFixed(5)} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          const errStr = _binanceErr(e);
          if (errStr.includes('-4509')) {
            log.system(`[AutoTrade] Vị thế ${sym} đã đóng trên sàn (TP/SL đã khớp trước đó). Bỏ qua.`);
            continue;
          }
          log.error(`[AutoTrade] Đặt TP ${sym} thất bại: ${errStr}`);
        }
      }


      // ----------------------------------------------------
      // 2. Quản lý STOP LOSS (Virtual & Real, Trailing SL)
      // ----------------------------------------------------
      const isTrailTriggerReached = isLong ? (markPrice >= trailTriggerPriceExact) : (markPrice <= trailTriggerPriceExact);

      let targetSlPrice = targetSlPriceExact;
      let currentSlPct = slPct;

      if (isTrailTriggerReached) {
        currentSlPct = trailSlRoi; // Dời SL về entry + 1% ROI (Hòa vốn)
        targetSlPrice = isLong
          ? entryPrice * (1 + (trailSlRoi / 100) / leverageVal)
          : entryPrice * (1 - (trailSlRoi / 100) / leverageVal);
      }

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
            // ── Record trade exit for AI Dataset ──
            if (meta) {
              const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
              recordTradeExit({
                tradeId: `${sym}-${meta.orderId || 'vSL'}`,
                orderId: String(meta.orderId || ''),
                symbol: sym,
                exitPrice: markPrice,
                exitTimestamp: Date.now(),
                exitType: typeLabel === 'Trailing SL' ? 'TRAILING_SL' : 'SL',
                pnlPercent: roi,
                pnlUsd: (roi / 100) * (meta.margin || 0),
                holdingDurationMinutes: holdingDurationMinutes,
                isWin: false,
              });
            }
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

async function notifyRealClose(client, sym, prevPos, meta) {
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
    let exitType = 'SL';
    if (hasTradeData) {
      if (realizedProfit < 0) {
        label = '🛡️ Stop Loss';
        exitType = 'SL';
      } else if (roi >= 15) {
        label = '🎯 Take Profit';
        exitType = 'TP';
      } else if (roi >= 4) {
        label = '🛡️ Trailing SL (Khóa lãi)';
        exitType = 'TRAILING_SL';
      } else {
        label = '🛡️ Trailing SL (Hòa vốn)';
        exitType = 'TRAILING_SL';
      }
    }

    // ── Record trade exit for AI Dataset ──
    if (meta) {
      const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
      recordTradeExit({
        tradeId: `${sym}-${meta.orderId || 'real'}`,
        orderId: String(meta.orderId || ''),
        symbol: sym,
        exitPrice: closePrice || markPrice,
        exitTimestamp: Date.now(),
        exitType: exitType,
        pnlPercent: roi,
        pnlUsd: realizedProfit,
        holdingDurationMinutes: holdingDurationMinutes,
        isWin: hasTradeData && realizedProfit >= 0,
      });
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
