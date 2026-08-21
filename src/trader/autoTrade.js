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
const { createClient, loadStepSizes, loadLeverageBrackets, calcQuantity } = require('./binance');
const { isIpBanned } = require('./circuitBreaker');
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
  onPriceUpdate,
  sendTelegram,
  score369Method,
  isGridWidthValid,
  YEAR_START_MS,
  getMarketCapRank,
  fetchH4Reference,
  buildLevelGrid,
  recordTradeEntry,
  recordTradeExit,
  evaluateSignalWithAI,
  recordAIEvaluation,
  recordSkippedSignal,
} = require('../pp369');
const { log } = require('../pp369/_logger');

const SCAN_INTERVAL_MS = 30_000;   // scan mỗi 30 giây
const TRAILING_SL_INTERVAL_MS = 6_000; // kiểm tra vị thế để dịch SL mỗi 6 giây
const MONITOR_LIMIT_INTERVAL_MS = 3_000; // Luồng 3: monitor lệnh LIMIT đang chờ mỗi 3 giây
const DEBOUNCE_MS = 5 * 60_000; // 5 phút / tín hiệu
const COIN_REFRESH_INTERVAL_MS = 4 * 60 * 60_000; // Tái kiểm tra danh sách coin mỗi 4 giờ
const LEVERAGE_REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // Tự động cập nhật trần đòn bẩy mỗi 6 giờ
const MIN_CONFLUENCE_SCORE = parseFloat(process.env.MIN_CONFLUENCE_SCORE || '4.0'); // Ngưỡng Confluence Score tối thiểu (mặc định 4.0đ)

// Debounce map: key → timestamp lần đặt lệnh gần nhất
const _fired = new Map();
const bounceCancelledLevels = new Map(); // key: sym_targetLevel -> expireTimestamp (60 phút cooldown)

function isBounceCooldown(sym, targetLevel) {
  const exp = bounceCancelledLevels.get(`${sym}_${targetLevel}`);
  return exp != null && Date.now() < exp;
}

// Tránh thông báo đóng vị thế trùng lặp giữa bot (Virtual) và sàn
const justClosedByBot = new Set();
const lastActivePositions = new Map(); // sym -> { entryPrice, leverage, amt, isLong }
const partialClosedSymbols = new Set(); // sym -> true (đã chốt lời 50% tại 13% ROI)

// Bộ lọc tránh in trùng lặp log scan mỗi 30s (cooldown 15 phút)
const _signalLogCooldown = new Map();
function _shouldLogSignal(sym, sigType, level, statusKey, cooldownMs = 15 * 60 * 1000) {
  const key = `${sym}_${sigType}_${level}_${statusKey}`;
  const now = Date.now();
  const last = _signalLogCooldown.get(key) || 0;
  if (now - last > cooldownMs) {
    _signalLogCooldown.set(key, now);
    return true;
  }
  return false;
}

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

let tickSizesCache = null;
function getTickSizeCached(sym) {
  if (!tickSizesCache) {
    try {
      const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        tickSizesCache = data.tickSizes ?? {};
      }
    } catch (_) {
      tickSizesCache = {};
    }
  }
  return tickSizesCache[`${sym}USDT`] ?? null;
}

function saveActiveTradesMetadata() {
  try {
    fs.writeFileSync(METADATA_PATH, JSON.stringify(activeTradesMetadata, null, 2), 'utf8');
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi ghi active_trades.json: ${err.message}`);
  }
}

function getLeverageCached(sym) {
  try {
    const cachePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (data.leverageInfo && data.leverageInfo[sym] != null) {
        return data.leverageInfo[sym];
      }
    }
  } catch (_) {}
  return 20;
}

function calcHalfQuantity(sym, totalQty) {
  let stepSize = 0.001;
  try {
    const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      stepSize = data.stepSizes?.[`${sym}USDT`] || data.steps?.[`${sym}USDT`] || 0.001;
    }
  } catch (_) {}
  const half = totalQty / 2;
  const qty = Math.floor(half / stepSize) * stepSize;
  const dec = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat(qty.toFixed(dec));
}

/**
 * Tính toán Stoploss theo Vùng Tier, Take Profit 1:1, Dời SL 50% và Đòn bẩy/Margin động
 *
 * @param {string} symbol
 * @param {'LONG'|'SHORT'} side
 * @param {number} entryPrice
 * @param {object} h4Ref - { upperPrice, lowerPrice, step, decimals }
 * @param {number} tickSize
 * @param {number} maxExchangeLeverage
 * @param {number} [targetLossUSD=5.0]
 */
function calculateTierSLTP(symbol, side, entryPrice, h4Ref, tickSize, maxExchangeLeverage, targetLossUSD = 5.0) {
  const step = h4Ref?.step || getStep(entryPrice);
  const decimals = h4Ref?.decimals || getDecimals(entryPrice);
  const upperPrice = h4Ref?.upperPrice || entryPrice;
  const lowerPrice = h4Ref?.lowerPrice || entryPrice;

  const distTicks = Math.ceil(Math.max(
    Math.abs(upperPrice - entryPrice),
    Math.abs(lowerPrice - entryPrice)
  ) / step);
  const levelsRange = Math.max(30, distTicks + 10);
  const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);

  let tierLong, tierShort;
  if (side === 'LONG' || side === 'BUY') {
    tierLong = grid.filter(l => l.type === 'tren' && l.value <= entryPrice * 1.005).pop()?.value || entryPrice;
    tierShort = grid.filter(l => l.type === 'duoi' && l.value <= entryPrice * 1.005).pop()?.value || (entryPrice - step * 0.1);
  } else {
    tierShort = grid.find(l => l.type === 'duoi' && l.value >= entryPrice * 0.995)?.value || entryPrice;
    tierLong = grid.find(l => l.type === 'tren' && l.value >= entryPrice * 0.995)?.value || (entryPrice + step * 0.1);
  }

  // Buffer: max(33 ticks, 10% step, 0.3% price)
  const effTickSize = tickSize || (decimals === 5 ? 0.00001 : (decimals === 4 ? 0.0001 : 0.000001));
  const buffer = Math.max(33 * effTickSize, step * 0.10, entryPrice * 0.003);
  let rawSL = (side === 'LONG' || side === 'BUY') ? (tierShort - buffer) : (tierLong + buffer);
  let slDist = Math.abs(entryPrice - rawSL);
  let slPct = (slDist / entryPrice) * 100;

  // Min SL = 1.0%, Max SL = 3.5%
  if (slPct < 1.0) {
    slPct = 1.0;
    slDist = entryPrice * 0.01;
    rawSL = (side === 'LONG' || side === 'BUY') ? (entryPrice - slDist) : (entryPrice + slDist);
  } else if (slPct > 3.5) {
    return { valid: false, reason: `SL theo Tier quá rộng (${slPct.toFixed(2)}% > 3.5%)` };
  }

  const calcLeverage = Math.max(1, Math.floor(50 / slPct)); // target ~50% ROI SL
  const leverage = Math.min(calcLeverage, maxExchangeLeverage || 20);

  // Margin cần nạp để nếu dính SL thì lỗ đúng targetLossUSD
  const actualMargin = targetLossUSD / (leverage * (slPct / 100));

  const tpPrice = (side === 'LONG' || side === 'BUY') ? (entryPrice + slDist * 1.5) : (entryPrice - slDist * 1.5);
  const beTriggerPrice = (side === 'LONG' || side === 'BUY') ? (entryPrice + slDist * 0.50) : (entryPrice - slDist * 0.50);

  return {
    valid: true,
    slPrice: parseFloat(rawSL.toFixed(decimals)),
    tpPrice: parseFloat(tpPrice.toFixed(decimals)),
    beTriggerPrice: parseFloat(beTriggerPrice.toFixed(decimals)),
    slDistance: slDist,
    slPct: slPct,
    leverage: leverage,
    margin: actualMargin,
    targetLossUSD: targetLossUSD
  };
}


let stepSizesCache = null;
function formatQuantity(sym, rawQty) {
  if (!stepSizesCache) {
    try {
      const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        stepSizesCache = data.stepSizes ?? {};
      } else {
        stepSizesCache = {};
      }
    } catch (_) {
      stepSizesCache = {};
    }
  }

  const stepSize = stepSizesCache[`${sym}USDT`] ?? 0.001;
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
  const amount = parseFloat(process.env.TRADE_AMOUNT || '30');
  const leverage = parseInt(process.env.LEVERAGE || '10', 10);
  const orderType = (process.env.ORDER_TYPE || 'LIMIT').toUpperCase();
  const notional = amount * leverage;
  const limitTimeoutMinutes = parseInt(process.env.LIMIT_TIMEOUT_MINUTES || '15', 10);
  const limitTimeoutMs = limitTimeoutMinutes * 60_000;
  const h1RetestLimitTimeoutMinutes = parseInt(process.env.H1_RETEST_LIMIT_TIMEOUT_MINUTES || '60', 10);
  const h1RetestLimitTimeoutMs = h1RetestLimitTimeoutMinutes * 60_000;
  const limitTouchedTimeoutMinutes = parseInt(process.env.LIMIT_TOUCHED_TIMEOUT_MINUTES || '10', 10);
  const limitTouchedTimeoutMs = limitTouchedTimeoutMinutes * 60_000;

  const activeSymbols = new Set();
  // Guard chống duplicate: ghi nhận symbol đang được xử lý NGAY LẬP TỨC
  // trước mọi async call để tránh cả 2 luồng (WS + Poll) cùng đặt lệnh song song
  const processingSymbols = new Set();

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
    }
    if (!leverageInfo || Object.keys(leverageInfo).length === 0) {
      log.system(`[AutoTrade] Chưa có leverageInfo trong cache — đang tải từ Binance...`);
      leverageInfo = await loadLeverageBrackets(activeCoinList, apiKey, secret);
    } else {
      log.system(`[AutoTrade] Đã nạp leverageInfo cho ${Object.keys(leverageInfo).length} coin từ cache.`);
    }
  } catch (e) {
    log.warn(`[AutoTrade] Không đọc được leverageInfo: ${e.message} — dùng leverage mặc định ${leverage}x cho tất cả.`);
  }

  // ── Định kỳ làm mới trần đòn bẩy (Leverage Brackets) mỗi 6 giờ vào step_sizes.json ────
  setInterval(async () => {
    try {
      log.system('[AutoTrade] [LeverageRefresh] Đang cập nhật lại trần đòn bẩy các coin vào step_sizes.json...');
      const updatedInfo = await loadLeverageBrackets(activeCoinList, apiKey, secret);
      if (updatedInfo && Object.keys(updatedInfo).length > 0) {
        leverageInfo = updatedInfo;
        log.system(`[AutoTrade] [LeverageRefresh] Đã cập nhật thành công đòn bẩy cho ${Object.keys(updatedInfo).length} coin.`);
      }
    } catch (err) {
      log.warn(`[AutoTrade] [LeverageRefresh] Lỗi cập nhật đòn bẩy: ${err.message}`);
    }
  }, LEVERAGE_REFRESH_INTERVAL_MS);

  // Lấy giá REST lần đầu để xác định các coin gần mốc
  await updatePricesRest();
  const initialLevelCache = getLevelCache();
  const initialNearby = getNearbySymbols(activeCoinList, initialLevelCache, 0.01);

  // Khởi động WebSocket stream và đăng ký (subscribe) chỉ các mã đang gần mốc
  start369Stream(initialNearby);

  // ── Đăng ký Real-time WebSocket Price listener để cập nhật maxFavorablePrice tức thì (0ms) ──
  // Đảm bảo mọi quét râu (wick spike) ngắn dưới 1s đều được ghi nhận ngay lập tức cho Trailing SL
  onPriceUpdate((sym, price) => {
    if (!price || price <= 0) return;
    const meta = activeTradesMetadata[sym];
    if (meta) {
      const isLong = meta.side === 'BUY' || meta.isLong === true;
      if (meta.isFilled) {
        // Vị thế ĐÃ MỞ: theo dõi giá tốt nhất sau khi vào lệnh cho Trailing SL
        if (isLong) {
          if (meta.maxFavorablePrice == null || price > meta.maxFavorablePrice) {
            meta.maxFavorablePrice = price;
          }
        } else {
          if (meta.maxFavorablePrice == null || price < meta.maxFavorablePrice) {
            meta.maxFavorablePrice = price;
          }
        }
      } else if (meta.orderId) {
        // Lệnh LIMIT ĐANG CHỜ KHỚP: theo dõi độ nảy để Bounce Cancel
        if (isLong) {
          if (meta.maxFavorablePrice == null || price > meta.maxFavorablePrice) {
            meta.maxFavorablePrice = price;
          }
        } else {
          if (meta.maxFavorablePrice == null || price < meta.maxFavorablePrice) {
            meta.maxFavorablePrice = price;
          }
        }
      }
    }
  });

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

  let lastHeartbeatTime = Date.now();

  async function scan() {
    if (isIpBanned()) return;
    try {
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
          const hasOpenPosition = currentPos.some(p => p.symbol === `${sym}USDT` && parseFloat(p.positionAmt) !== 0);
          if (hasOpenPosition) {
            // 🛡️ ĐÃ KHỚP VÀ ĐANG CÓ VỊ THẾ MỞ TRÊN SÀN -> Tuyệt đối không hủy và không báo "chạm entry không khớp"!
            remainingOrders.push(order);
            continue;
          }

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
            } else if (meta.hasTouchedEntry) {
              // [BUG-2 FIX] Reset timer khi giá ra xa mốc Entry > 1.5%
              // Tránh: timer đếm từ lần chạm cũ → hủy lệnh sớm hơn dự kiến khi giá quay lại
              const farFromEntryLong = order.side === 'BUY' && markPrice > entryPrice * 1.015;
              const farFromEntryShort = order.side === 'SELL' && markPrice < entryPrice * 0.985;
              if (farFromEntryLong || farFromEntryShort) {
                meta.hasTouchedEntry = false;
                meta.touchedTime = null;
                saveActiveTradesMetadata();
              }
            }
          }

          const isTouchedTimeout = meta?.hasTouchedEntry === true && (now - (meta.touchedTime || order.time)) > limitTouchedTimeoutMs;
          const isNormalTimeout = curTimeoutMinutes > 0 && (now - order.time) > curTimeoutMs;

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

                if (!lastActivePositions.has(sym)) {
                  delete activeTradesMetadata[sym];
                  saveActiveTradesMetadata();
                } else {
                  meta.orderId = null;
                  saveActiveTradesMetadata();
                }
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
            const meta = activeTradesMetadata[sym];
            const markPrice = getMarkPrice(sym);

            if (meta && markPrice) {
              const entryPrice = parseFloat(order.price);
              const stepVal = meta.step || getStep(entryPrice);
              const unit = stepVal / 3;
              const touchThresholdPct = 0.12;             // fixed 0.12% — khoảng cách tuyệt đối từ entry (không phụ thuộc grid)
              const bounceDistance = unit * 0.40;         // Cố định 40 ticks (0.40 * unit) nảy khỏi entry/điểm chạm là hủy LIMIT ngay
              const bouncePct = (bounceDistance / entryPrice) * 100;

              if (order.side === 'BUY') {
                // LONG: kiểm tra xem giá hiện tại có bật nảy đi xa mốc entry hay chưa
                const currentBouncedPct = ((markPrice - entryPrice) / entryPrice) * 100;
                const touchZoneUpper = entryPrice * (1 + touchThresholdPct / 100);
                if (markPrice <= touchZoneUpper) {
                  // Giá đang trong vùng touch — cập nhật điểm thấp nhất
                  meta.touchLow = meta.touchLow == null ? markPrice : Math.min(meta.touchLow, markPrice);
                }

                const isBouncedFromTouch = meta.touchLow != null && markPrice >= (meta.touchLow * (1 + bouncePct / 100));
                const isBouncedFromEntry = meta.hasTouchedEntry === true && currentBouncedPct >= bouncePct;

                if (isBouncedFromTouch || isBouncedFromEntry) {
                  const bounceRef = meta.touchLow != null ? meta.touchLow : entryPrice;
                  const bounceDisplayPct = meta.touchLow != null ? ((markPrice - meta.touchLow) / meta.touchLow * 100) : currentBouncedPct;
                  log.system(`[AutoTrade] [BounceCancel] ${sym} LONG: giá từ điểm chạm $${bounceRef.toFixed(6)} đã bật lên $${markPrice.toFixed(6)} (+${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
                    bounceCancelledLevels.set(`${sym}_${entryPrice}`, Date.now() + 60 * 60_000);
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} LONG</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Giá điểm chạm: <b>$${bounceRef.toFixed(6)}</b> | Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${bounceDisplayPct.toFixed(2)}%)\n` +
                      `• Giá đã chạm sát mốc và bật nảy ra xa → Hủy lệnh ngay lập tức (Khóa mốc 60p)`
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
                    const errStr = _binanceErr(e);
                    if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
                      log.system(`[AutoTrade] [BounceCancel] Lệnh LIMIT ${sym} đã khớp vị thế hoặc đã hủy trước đó trên sàn (-2011).`);
                    } else {
                      log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
                      remainingOrders.push(order);
                    }
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
                const isBouncedFromEntry = meta.hasTouchedEntry === true && currentBouncedPct >= bouncePct;

                if (isBouncedFromTouch || isBouncedFromEntry) {
                  const bounceRef = meta.touchHigh != null ? meta.touchHigh : entryPrice;
                  const bounceDisplayPct = meta.touchHigh != null ? ((meta.touchHigh - markPrice) / meta.touchHigh * 100) : currentBouncedPct;
                  log.system(`[AutoTrade] [BounceCancel] ${sym} SHORT: giá từ điểm chạm $${bounceRef.toFixed(6)} đã bật xuống $${markPrice.toFixed(6)} (-${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}%) → Hủy LIMIT ngay lập tức`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
                    bounceCancelledLevels.set(`${sym}_${entryPrice}`, Date.now() + 60 * 60_000);
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} SHORT</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Giá điểm chạm: <b>$${bounceRef.toFixed(6)}</b> | Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${bounceDisplayPct.toFixed(2)}%)\n` +
                      `• Giá đã chạm sát mốc và bật nảy ra xa → Hủy lệnh ngay lập tức (Khóa mốc 60p)`
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
                    const errStr = _binanceErr(e);
                    if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
                      log.system(`[AutoTrade] [BounceCancel] Lệnh LIMIT ${sym} đã khớp vị thế hoặc đã hủy trước đó trên sàn (-2011).`);
                    } else {
                      log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
                      remainingOrders.push(order);
                    }
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
      // 1. WebSocket lắng nghe biến động giá cho tất cả coin trong bán kính 1.0% + toàn bộ coin đang có vị thế/lệnh chờ
      const wsNearby = getNearbySymbols(activeCoinList, levelCache, 0.01);
      const wsAllSymbols = Array.from(new Set([...wsNearby, ...activeSymbols]));
      syncWebSocketSubscriptions(wsAllSymbols);

      // 2. Vòng lặp Scan định kỳ chỉ xử lý các coin đang thực sự TIỆM CẬN SÁT MỐC (<= 0.5%) để tối ưu tốc độ treo LIMIT
      const scanNearby = getNearbySymbols(activeCoinList, levelCache, 0.005, true);

      const nowTime = Date.now();
      if (nowTime - lastHeartbeatTime >= 15 * 60 * 1000) {
        lastHeartbeatTime = nowTime;
        log.system(`[AutoTrade] 🟢 Hệ thống hoạt động bình thường | Theo dõi: ${activeCoinList.length} coin | Tiệm cận sát mốc (<=0.5%): ${scanNearby.length} coin`);
      }

      if (!scanNearby.length) return;

      // Priority Sorting: Sắp xếp các mã coin theo độ sát mốc tăng dần (% khoảng cách nhỏ nhất xử lý trước)
      scanNearby.sort((a, b) => {
        const priceA = getMarkPrice(a) || 0;
        const priceB = getMarkPrice(b) || 0;
        const levA = levelCache[a];
        const levB = levelCache[b];
        const distA = priceA && levA ? Math.min(Math.abs(priceA - levA.longEntry) / priceA, Math.abs(levA.shortEntry - priceA) / priceA) : 1;
        const distB = priceB && levB ? Math.min(Math.abs(priceB - levB.longEntry) / priceB, Math.abs(levB.shortEntry - priceB) / priceB) : 1;
        return distA - distB;
      });

      for (const sym of scanNearby.slice(0, 15)) {
        const markPrice = getMarkPrice(sym);
        enqueueSymbolSignal(client, sym, markPrice, leverageInfo, leverage, coins);
      }
    } catch (err) {
      log.warn(`[AutoTrade] Lỗi trong chu kỳ scan: ${err.message}`);
    }
  }

  // ─── CONCURRENCY POOL FOR SIGNAL CHECKS ──────────────────────────────────
  const MAX_CONCURRENT_SIGNAL_CHECKS = 1;
  let activeSignalChecks = 0;
  const signalCheckQueue = [];

  function enqueueSymbolSignal(client, sym, markPrice, leverageInfo, leverage, coins) {
    if (isIpBanned()) return;
    if (!sym || !markPrice || activeSymbols.has(sym) || processingSymbols.has(sym)) return;

    if (signalCheckQueue.some(item => item.sym === sym)) return;

    signalCheckQueue.push({ client, sym, markPrice, leverageInfo, leverage, coins });
    processSignalQueue();
  }

  function processSignalQueue() {
    if (activeSignalChecks >= MAX_CONCURRENT_SIGNAL_CHECKS || signalCheckQueue.length === 0) return;

    const task = signalCheckQueue.shift();
    if (!task) return;

    activeSignalChecks++;
    processSymbolSignal(task.client, task.sym, task.markPrice, task.leverageInfo, task.leverage, task.coins)
      .catch(err => {
        log.warn(`[AutoTrade] Queue error for ${task.sym}: ${err.message}`);
      })
      .finally(() => {
        activeSignalChecks--;
        setTimeout(processSignalQueue, 400); // Sleep 400ms giữa các symbol để bảo đảm tốc độ và an toàn API
      });
  }

  async function processSymbolSignal(client, sym, markPrice, leverageInfo, leverage, coins) {
    if (isIpBanned()) return;
    if (!sym || !markPrice || activeSymbols.has(sym) || processingSymbols.has(sym)) return;
    // Khóa symbol ngay lập tức — trước mọi await — để chặn duplicate từ Luồng 1 + Luồng 2
    processingSymbols.add(sym);
    try {

      let sig;
      try {
        sig = await get369Signal(sym, markPrice);
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi get369Signal ${sym}: ${e.message}`);
        return;
      }

      if (!sig || sig.signal === 'NONE' || !sig.targetLevel || sig.targetLevel <= 0 || !sig.step || sig.step <= 0) {
        if (sig?.reason && (sig.reason.includes('Không lấy được nến H4') || sig.reason.includes('không trùng ngày 01/01/2026'))) {
          log.warn(`[AutoTrade] Phát hiện ${sym} không có nến H4 đầu năm 2026. Loại bỏ khỏi danh sách quét.`);
          const idx = coins.indexOf(sym);
          if (idx !== -1) {
            coins.splice(idx, 1);
            log.system(`[AutoTrade] Đã loại bỏ ${sym} khỏi danh sách quét. Còn lại ${coins.length} coin.`);
          }
        }
        return;
      }

      // Tính điểm Scorer trước khi đặt lệnh và gửi Telegram
      let scoreRes = null;
      try {
        scoreRes = await score369Method(sig, sig.signal);
        sig.score = scoreRes.score;
        sig.scoreReasons = scoreRes.reasons;
      } catch (err) {
        log.warn(`[AutoTrade] Lỗi tính score cho ${sym}: ${err.message}`);
      }

      const isNewSignalLog = _shouldLogSignal(sym, sig.signal, sig.targetLevel, 'detected');
      if (isNewSignalLog) {
        log.system(`[AutoTrade] ${sym} → ${sig.signal} (Score: +${sig.score}đ) tại $${sig.targetLevel}`);
      }

      const volScore = scoreRes?.volScore || 0;
      const isM15Volatile = scoreRes?.isM15Volatile === true;
      const isStagnant = scoreRes?.isStagnant === true;
      const isH1VolSurge = scoreRes?.isH1VolSurge === true;
      const hasCriterion2 = (volScore >= 0.3 && !isM15Volatile && !isStagnant && !isH1VolSurge);
      if (!hasCriterion2) {
        if (isNewSignalLog) {
          const failReason = isH1VolSurge
            ? 'Đột biến Volume 3 nến H1 (gấp >= 2.5x)'
            : (isStagnant
              ? 'Nén bế tắc H1 (24-48 nến Range <= 1.5%)'
              : (isM15Volatile ? 'M15 biến động mạnh' : 'Biến động H1/M15 không đạt'));
          log.system(`[AutoTrade] ${sym} ${sig.signal} không đạt Tiêu chí 2 (${failReason}) — Đưa vào Watchlist chờ Retest H1`);
        }
        const rank = getMarketCapRank ? getMarketCapRank(sym) : 999;
        lowScoreWatchlist[sym] = {
          symbol: sym,
          signal: sig.signal,
          targetLevel: sig.targetLevel,
          score: sig.score,
          scoreReasons: sig.scoreReasons || [],
          volScore: scoreRes?.volScore || 0,
          otherScore: scoreRes?.otherScore || 0,
          step: sig.step || getStep(markPrice),
          gridWidthPct: parseFloat(sig.gridWidthPct) || 3.5,
          marketCapRank: rank,
          timestamp: Date.now()
        };
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'rec_no_volatility')) {
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: sig.score ?? 0,
            scoreReasons: sig.scoreReasons || [],
            skipReason: isH1VolSurge ? 'H1_VOLUME_SURGE' : (isStagnant ? 'STAGNANT_COMPRESSION' : 'NO_VOLATILITY_FILTER'),
            markPrice: markPrice,
            marketCapRank: getMarketCapRank ? getMarketCapRank(sym) : 999,
          });
        }
        return;
      }

      // Phân bổ ký quỹ (Margin) theo Xếp Hạng Vốn Hóa (MarketCap Rank):
      // - Top 10 (BTC, ETH, SOL...): $50 USDT
      // - Top 11 - 50: $40 USDT
      // - Top 51 - 150: $35 USDT
      // - Ngoài Top 150: $30 USDT chuẩn
      const baseEnvMargin = parseFloat(process.env.TRADE_AMOUNT) || 30;
      const rank = getMarketCapRank ? getMarketCapRank(sym) : 999;
      let tradeAmount = baseEnvMargin;
      let rankTierLabel = 'Ngoài Top 150';

      if (sym === 'BTC' || sym === 'ETH' || rank <= 10) {
        tradeAmount = Math.max(baseEnvMargin, 50);
        rankTierLabel = `Top 10 (Rank #${rank})`;
      } else if (rank <= 50) {
        tradeAmount = Math.max(baseEnvMargin, 40);
        rankTierLabel = `Top 50 (Rank #${rank})`;
      } else if (rank <= 150) {
        tradeAmount = Math.max(baseEnvMargin, 35);
        rankTierLabel = `Top 150 (Rank #${rank})`;
      } else {
        tradeAmount = baseEnvMargin;
        rankTierLabel = `Lowcap (Rank #${rank})`;
      }

      const score = sig.score ?? 0;
      if (isNewSignalLog) {
        log.system(
          `[AutoTrade] Phân bổ Ký quỹ ${sym}: $${tradeAmount} ` +
          `(Phân cấp Vốn hóa ${rankTierLabel} | Score: +${score.toFixed(1)}đ)`
        );
      }

      if (_isDebounced(sig)) {
        if (isNewSignalLog) {
          log.system(`[AutoTrade] ${sym} ${sig.signal} đã đặt gần đây — bỏ qua`);
        }
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'rec_debounced')) {
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
        }
        return;
      }

      if (isBounceCooldown(sym, sig.targetLevel)) {
        if (isNewSignalLog) {
          log.system(`[AutoTrade] 🛑 ${sym} ${sig.signal} @ $${sig.targetLevel} vừa bị Bounce Cancel (đang trong Cooldown 60p) — bỏ qua khuyến nghị`);
        }
        return;
      }

      try {
        const hasPos = await client.hasOpenPosition(sym);
        if (hasPos) {
          log.system(`[AutoTrade] ${sym} đang có vị thế mở — bỏ qua`);
          return;
        }
      } catch (e) {
        log.warn(`[AutoTrade] Không check được vị thế ${sym}: ${_binanceErr(e)} — ngắt xử lý tín hiệu.`);
        return;
      }

      // Ngưỡng nảy xa trước khi đặt lệnh (Pre-entry bounce): Cố định 40 ticks (0.40 * unit)
      const entryPrice = sig.targetLevel;
      const stepVal = sig.step || getStep(entryPrice);
      const unit = stepVal / 3;
      const preEntryBouncePct = (unit * 0.40 / entryPrice) * 100; // Cố định 40 ticks (0.40 * unit)
      const touchThresholdPct = 0.12;
      let maxRecentBouncePct = null;

      if (sig.recentM1Candles && sig.recentM1Candles.length > 0) {
        const recentM1 = sig.recentM1Candles;
        if (sig.signal === 'LONG') {
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
              // Nếu candle.low thấp hơn entry (sig.targetLevel), khoảng nảy tính từ entry đến đỉnh cao nhất
              const touchLow = Math.max(candle.low, sig.targetLevel);
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
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled')) {
              log.system(
                `[AutoTrade] ${sym} LONG: Từ khi chạm mốc Short ($${sig.condLevel}), nến M1 đã xát mốc entry LONG ($${bestTouchLow.toFixed(6)}) ` +
                `rồi nảy lên đỉnh $${bestPeakHigh.toFixed(6)} (+${maxBouncePct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}% Khung/5) — HỦY LIMIT stale.`
              );
            }
            return;
          }
          maxRecentBouncePct = maxBouncePct;
        } else if (sig.signal === 'SHORT') {
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
              // Nếu candle.high cao hơn entry (sig.targetLevel), khoảng nảy/sụt giảm tính từ entry xuống đáy
              const touchHigh = Math.min(candle.high, sig.targetLevel);
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
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled')) {
              log.system(
                `[AutoTrade] ${sym} SHORT: Từ khi chạm mốc Long ($${sig.condLevel}), nến M1 đã xát mốc entry SHORT ($${bestTouchHigh.toFixed(6)}) ` +
                `rồi nảy xuống đáy $${bestTroughLow.toFixed(6)} (-${maxDropPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}% Khung/5) — HỦY LIMIT stale.`
              );
            }
            return;
          }
          maxRecentBouncePct = maxDropPct;
        }
      } else {
        if (sig.signal === 'LONG') {
          const bouncedAwayPct = ((markPrice - sig.targetLevel) / sig.targetLevel) * 100;
          if (bouncedAwayPct >= preEntryBouncePct) {
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled_fallback')) {
              log.system(`[AutoTrade] ${sym} LONG đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} +${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%) — bỏ qua không đặt lệnh LIMIT stale.`);
            }
            return;
          }
        } else if (sig.signal === 'SHORT') {
          const bouncedAwayPct = ((sig.targetLevel - markPrice) / sig.targetLevel) * 100;
          if (bouncedAwayPct >= preEntryBouncePct) {
            log.system(`[AutoTrade] ${sym} SHORT đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} -${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%) — bỏ qua không đặt lệnh LIMIT stale.`);
            return;
          }
        }
      }

      const gridStepPct = (sig.step / sig.targetLevel) * 100;
      sig.marketCapRank = rank;
      sig.gridWidthPct = gridStepPct;

      // ── Tiêu chí 2: Bộ Lọc Confluence Score tối thiểu (Mặc định >= 4.5đ) ──

      if ((sig.score || 0) < MIN_CONFLUENCE_SCORE) {
        log.system(`[AutoTrade] ⏭️ ${sym} (${sig.signal}) Score = ${sig.score}đ < ${MIN_CONFLUENCE_SCORE}đ — Bỏ qua không đặt lệnh.`);
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'low_score_skipped')) {
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: sig.score ?? 0,
            scoreReasons: sig.scoreReasons || [],
            skipReason: `SCORE_LOW_LT_${MIN_CONFLUENCE_SCORE}`,
            markPrice: markPrice,
            marketCapRank: rank,
          });
        }
        return;
      }

      // ── Thu thập dữ liệu nến M15 thô để nạp vào AI Reviewer v2.0 ──
      let rawMarketData = null;
      let klinesM15 = null;
      try {
        klinesM15 = await fetchBinanceKlines(sym, '15m', null, 21);
        const currM15 = klinesM15 && klinesM15.length > 0 ? klinesM15[klinesM15.length - 1] : null;
        rawMarketData = {
          lastM15: currM15,
          touchCount: 1
        };
      } catch (err) {
        // fallback
      }

      const aiEval = evaluateSignalWithAI(sig, rawMarketData);
      recordAIEvaluation(sig, aiEval);

      // ── Tiêu chí 3: Bộ Lọc Phủ Quyết AI Veto Filter (Chỉ đánh khi WinProb >= 58%) ──
      // Chặn các tín hiệu có WinProb < 58.0% hoặc đồng thời cạn thanh khoản (VOL_DRY) & OI tháo chạy (OI_COOLING)
      const isAiVeto = (aiEval.winProbability < 58.0) || (aiEval.reason.includes('VOL_DRY') && aiEval.reason.includes('OI_COOLING'));
      if (isAiVeto) {
        log.system(`[AutoTrade] 🛑 [AI Veto] ${sym} (${sig.signal}) bị phủ quyết (WinProb ${aiEval.winProbability.toFixed(1)}% < 58%): ${aiEval.reason} — Bỏ qua không đặt lệnh.`);
        return;
      }

      if (aiEval.isApproved) {
        log.system(`[AI Reviewer] 🟢 Khuyên NÊN ĐẶT LỆNH ${sym} (${sig.signal}) - ${aiEval.reason}`);
      } else {
        log.system(`[AI Reviewer] 🟡 ${sym} (${sig.signal}) - ${aiEval.reason}`);
      }

      // ── BỘ LỌC M15 SPIKE GUARD (Chặn đặt Limit khi M15 bùng nổ Vol >= 2.5x & Biên độ > 1.4%) ──
      try {
        if (!klinesM15) {
          klinesM15 = await fetchBinanceKlines(sym, '15m', null, 21);
        }
        if (klinesM15 && klinesM15.length >= 20) {
          const past20 = klinesM15.slice(0, klinesM15.length - 1);
          const currM15 = klinesM15[klinesM15.length - 1];
          const avgVol20 = past20.reduce((sum, c) => sum + c.volume, 0) / past20.length;
          const m15VolRatio = avgVol20 > 0 ? (currM15.volume / avgVol20) : 1;
          const m15RangePct = ((currM15.high - currM15.low) / (currM15.low || 1)) * 100;

          if (m15RangePct > 1.4 && m15VolRatio >= 2.5) {
            const alertMsg = `🛑 <b>[M15 Spike Guard - BỎ QUA LIMIT]</b>\n` +
              `• <b>Coin:</b> #${sym} (${sig.signal})\n` +
              `• <b>Mốc Entry:</b> $${sig.targetLevel}\n` +
              `• <b>Biên độ M15:</b> ${m15RangePct.toFixed(2)}% (Ngưỡng > 1.4%)\n` +
              `• <b>Volume M15:</b> ${m15VolRatio.toFixed(2)}x MA20 (Ngưỡng >= 2.5x)\n` +
              `• <b>Lý do:</b> Nến M15 đang bão giá giật mạnh đâm cản. Tự động bỏ qua đặt Limit để tránh dính SL.`;

            log.system(`[AutoTrade] 🛑 [M15 Spike Guard] ${sym} (${sig.signal}): Nến M15 bão giá (Biên độ ${m15RangePct.toFixed(2)}% > 1.4% & Vol ${m15VolRatio.toFixed(2)}x >= 2.5x) — BỎ QUA ĐẶT LIMIT`);

            try {
              await sendTelegram(alertMsg);
            } catch (teleErr) {
              log.warn(`[AutoTrade] Lỗi gửi telegram M15 Spike Guard cho ${sym}: ${teleErr.message}`);
            }

            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'm15_spike_skipped')) {
              recordSkippedSignal({
                symbol: sym,
                signal: sig.signal,
                signalPrice: sig.targetLevel,
                score: sig.score ?? 0,
                scoreReasons: sig.scoreReasons || [],
                skipReason: 'M15_VOLATILITY_VOLUME_SPIKE',
                markPrice: markPrice,
                marketCapRank: rank,
              });
            }
            return;
          }
        }
      } catch (errM15) {
        log.warn(`[AutoTrade] Không thể kiểm tra nến M15 Spike Guard cho ${sym}: ${errM15.message}`);
      }

      // ── LOGIC MỚI: TÍNH TOÁN STOPLOSS THEO TIER, TP 1:1.5, VÀ ĐÒN BẨY / MARGIN ĐỘNG ──
      const h4Ref = await fetchH4Reference(sym);
      const tickSize = getTickSizeCached(sym) || (getDecimals(sig.targetLevel) === 5 ? 0.00001 : (getDecimals(sig.targetLevel) === 4 ? 0.0001 : 0.000001));
      const targetLossUSD = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '5.0');
      const maxAllowed = leverageInfo[sym] ?? leverage;

      const tierSetup = calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4Ref, tickSize, maxAllowed, targetLossUSD);
      if (!tierSetup.valid) {
        log.system(`[AutoTrade] ⏭️ ${sym} (${sig.signal}) bỏ qua: ${tierSetup.reason}`);
        return;
      }

      const effectiveLeverage = tierSetup.leverage;
      const actualTradeMargin = Number(tierSetup.margin.toFixed(2));
      const currentNotional = actualTradeMargin * effectiveLeverage;

      sig.leverage = effectiveLeverage;
      sig.margin = actualTradeMargin;

      const { qty } = calcQuantity(sym, currentNotional, sig.targetLevel);
      if (qty <= 0) {
        log.warn(`[AutoTrade] ${sym}: quantity = 0 — không đủ khối lượng đặt lệnh`);
        return;
      }

      const side = sig.signal === 'LONG' ? 'BUY' : 'SELL';

      try {
        try {
          await client.setLeverage(sym, effectiveLeverage);
          log.system(`[AutoTrade] Set leverage ${sym}USDT = ${effectiveLeverage}x (Tier SL: $${tierSetup.slPrice} (${tierSetup.slPct.toFixed(2)}%), TP 1:1.5: $${tierSetup.tpPrice}, Dời SL tại $${tierSetup.beTriggerPrice} | Ký quỹ: $${actualTradeMargin})`);
        } catch (e) {
          const binErr = e.response?.data;
          const errStr = _binanceErr(e);
          log.warn(`[AutoTrade] Set leverage ${sym} thất bại: ${errStr}`);
          if (binErr?.code === -4411) {
            throw e;
          }
          if (isIpBanned() || errStr.includes('IP_BAN_CIRCUIT_BREAKER')) {
            return;
          }
        }

        let order;
        if (orderType === 'MARKET') {
          order = await client.placeMarket(sym, side, qty);
        } else {
          const dec = getDecimals(sig.targetLevel);
          order = await client.placeLimit(sym, side, qty, sig.targetLevel, dec);
        }

        activeSymbols.add(sym);

        const trendReason = sig.scoreReasons.find(r => r.includes('[Xu hướng H4/H1]'));
        const h4Part = trendReason ? trendReason.split('|')[0] : '';
        const isCounter = h4Part.includes('H4 ngược');

        const posGridPct = (sig.step / sig.targetLevel) * 100;
        activeTradesMetadata[sym] = {
          score: sig.score,
          isCounterTrend: isCounter,
          entryPrice: sig.targetLevel,
          side,
          gridWidthPct: sig.gridWidthPct || posGridPct,
          gridStepPct: posGridPct,
          step: sig.step || getStep(sig.targetLevel), // [BUG-4 FIX] Lưu step để checkTrailingSL tính unit chính xác
          orderId: order.orderId ?? null,
          maxFavorablePrice: null,
          time: Date.now(),
          markPrice: markPrice,
          scoreReasons: sig.scoreReasons,
          marketCapRank: rank,
          leverage: effectiveLeverage,
          margin: actualTradeMargin,
          maxRecentBouncePct: maxRecentBouncePct ?? null,
          // ── THÔNG SỐ TIER SL / TP MỚI ──
          tierSlPrice: tierSetup.slPrice,
          tierTpPrice: tierSetup.tpPrice,
          beTriggerPrice: tierSetup.beTriggerPrice,
          slDistance: tierSetup.slDistance,
          slPct: tierSetup.slPct,
          targetLossUSD: targetLossUSD,
        };
        saveActiveTradesMetadata();

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
          gridWidthPct: gridStepPct,
          maxRecentBouncePct: maxRecentBouncePct ?? null,
          leverage: effectiveLeverage,
          margin: tradeAmount,
        });

        _markFired(sig);
        activeSymbols.add(sym); // 🛡️ BẢO VỆ LOCAL RAM: Khóa symbol ngay khi đặt lệnh thành công, không phụ thuộc REST sync 418
        sig.aiEval = aiEval;
        sig.leverage = effectiveLeverage;
        sig.margin = actualTradeMargin;
        sig.tierSlPrice = tierSetup.slPrice;
        sig.tierTpPrice = tierSetup.tpPrice;
        notifySignals([sig]).catch(() => { });
        logSignal369(sig);

        log.system(
          `[AutoTrade] ✓ ${sym} ${side} ${qty} @ $${sig.targetLevel} ` +
          `orderId=${order.orderId} status=${order.status}`
        );

        // Telegram: thông báo đặt lệnh LIMIT mới với đầy đủ Score + Reasons
        try {
          const reasonLines = (sig.scoreReasons || [])
            .map(r => `  • ${String(r).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`)
            .join('\n');
          const aiLine = aiEval
            ? `\n• AI: ${aiEval.isApproved ? '🟢 Nên vào' : '🟡 Khuyên bỏ'} (${(aiEval.winRate * 100).toFixed(1)}%)`
            : '';
          // sendTelegram(
          //   `📋 <b>[AutoTrade] Đặt lệnh LIMIT mới</b>\n` +
          //   `• Coin: <b>${sym} (${sig.signal})</b>\n` +
          //   `• Entry: <b>$${sig.targetLevel}</b>\n` +
          //   `• Đòn bẩy: <b>${effectiveLeverage}x</b> | Ký quỹ: <b>$${tradeAmount}</b>\n` +
          //   `• Score: <b>+${sig.score?.toFixed(2) ?? '?'}đ</b>${aiLine}\n` +
          //   `• Lý do:\n${reasonLines}`
          // ).catch(() => { });
        } catch (_) { }


      } catch (e) {
        const binErr = e.response?.data;
        const errCode = binErr?.code;
        log.warn(`[AutoTrade] Lỗi đặt lệnh ${sym}: ${_binanceErr(e)}`);

        if (errCode === -4411) {
          log.warn(`[AutoTrade] Phát hiện lỗi -4411 cho ${sym}. Tiến hành loại bỏ và đánh dấu lỗi vào step_sizes.json.`);
          await markSymbolFailed(sym, 'Lỗi 4411 - Chưa ký hợp đồng TradFi');
          const idx = coins.indexOf(sym);
          if (idx !== -1) {
            coins.splice(idx, 1);
            log.system(`[AutoTrade] Đã loại bỏ ${sym} khỏi danh sách quét. Còn lại ${coins.length} coin.`);
          }
        }
      }
    } finally {
      processingSymbols.delete(sym);
    }
  }

  // Chạy ngay lần đầu
  await scan();

  // Luồng 1 (Real-time Event Stream 0ms): Lắng nghe điểm giá WebSocket trực tiếp
  const activeCoinSet = new Set(coins);
  const symbolSignalCooldown = {}; // Cooldown per symbol (chặn spam REST API từ WebSocket ticks dồn dập)

  onPriceUpdate((sym, price) => {
    if (isIpBanned()) return;
    if (!activeCoinSet.has(sym) || activeSymbols.has(sym)) return;

    // 🛡️ COOLDOWN GUARD: Chỉ cho phép enqueueSymbolSignal tối đa 1 lần mỗi 15 giây cho từng coin
    const now = Date.now();
    if ((symbolSignalCooldown[sym] || 0) + 15000 > now) return;

    const levelCache = getLevelCache();
    const levels = levelCache[sym];
    if (!levels?.longEntry || !levels?.shortEntry) return;

    const nearTol = price * 0.003; // Ngưỡng 0.3% tiệm cận mốc
    const nearLong = Math.abs(price - levels.longEntry) <= nearTol;
    const nearShort = Math.abs(levels.shortEntry - price) <= nearTol;

    if (nearLong || nearShort) {
      symbolSignalCooldown[sym] = now; // Ghi nhận thời điểm check
      enqueueSymbolSignal(client, sym, price, leverageInfo, leverage, coins);
    }
  });

  // Luồng 2: Quét Polling dự phòng 30s
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
    checkH1RetestSignals(client, activeSymbols, leverageInfo).catch(err => {
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
let isCheckingPendingLimits = false;

async function checkPendingLimits(client, activeSymbols) {
  if (isIpBanned() || isCheckingPendingLimits) return;
  isCheckingPendingLimits = true;
  try {
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
      if (!markPrice || !meta.entryPrice) continue;

      const entry = meta.entryPrice;
      const stepVal = meta.step || getStep(entry);
      const unit = stepVal / 3;
      const bounceDistance = unit * 0.40; // Cố định 40 ticks (0.40 * unit) nảy khỏi entry là hủy LIMIT ngay
      const bouncePct = (bounceDistance / entry) * 100;

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
            bounceCancelledLevels.set(`${sym}_${entry}`, Date.now() + 60 * 60_000);
            sendTelegram(
              `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
              `• Coin: <b>${sym} LONG</b>\n` +
              `• Entry: <b>$${entry}</b>\n` +
              `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${displayPct.toFixed(2)}%)\n` +
              `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức (Khóa mốc)`
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
            bounceCancelledLevels.set(`${sym}_${entry}`, Date.now() + 60 * 60_000);
            sendTelegram(
              `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
              `• Coin: <b>${sym} SHORT</b>\n` +
              `• Entry: <b>$${entry}</b>\n` +
              `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${displayPct.toFixed(2)}%)\n` +
              `• Giá đã nảy xa mốc → Hủy lệnh ngay lập tức (Khóa mốc)`
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
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi luồng checkPendingLimits: ${err.message}`);
  } finally {
    isCheckingPendingLimits = false;
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
async function checkH1RetestSignals(client, activeSymbols, leverageInfo = {}) {
  if (isIpBanned()) return;
  const currentH1Time = Math.floor(Date.now() / 3600000) * 3600000;
  if (currentH1Time === lastCheckedH1Time) return;
  lastCheckedH1Time = currentH1Time;

  const symbolsToWatch = Object.keys(lowScoreWatchlist);
  if (symbolsToWatch.length === 0) return;

  const watchlistSummary = symbolsToWatch.map(s => {
    const d = lowScoreWatchlist[s];
    return `${s}(${d?.signal || '?'} @$${d?.targetLevel || '?'})`;
  }).join(', ');
  log.system(`[H1Retest] === Kiểm tra ${symbolsToWatch.length} coin trong Watchlist: [${watchlistSummary}] ===`);

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
      if (activeSymbols && activeSymbols.has(sym)) {
        delete lowScoreWatchlist[sym];
        continue;
      }
      const hasPos = await client.hasOpenPosition(sym);
      if (hasPos) {
        delete lowScoreWatchlist[sym];
        continue;
      }

      // Tải 60 nến 1M của giờ H1 vừa trôi qua
      const m1Candles = await fetchBinanceKlines(sym, '1m', prevH1Start, 60);
      if (!m1Candles || m1Candles.length === 0) continue;

      const { signal, targetLevel } = watchData;
      // [BUG-1 FIX] Luôn dùng getStep(targetLevel) thay vì watchData.step
      // Lý do: watchData.step lưu từ lúc coin vào Watchlist (giá khác), có thể sai tier nếu giá đã đi qua ranh giới bước giá
      // VD: coin thêm watchlist lúc giá $0.22 (step=0.03), nhưng targetLevel=$0.18 (step=0.003) → leverage sai 10x
      const step = getStep(targetLevel);
      const isLong = signal === 'LONG';
      const side = isLong ? 'BUY' : 'SELL';

      // Lấy giá Open/Close/High/Low tổng quan của cả nến H1
      const h1Open = m1Candles[0].open;
      const h1Close = m1Candles[m1Candles.length - 1].close;
      const h1MinLow = Math.min(...m1Candles.map(c => c.low));
      const h1MaxHigh = Math.max(...m1Candles.map(c => c.high));

      // 1. Check nến H1 có rút chân/rút râu thực sự tại Entry không:
      let isRutChan = false;
      const isTouchedH1 = isLong ? (h1MinLow <= targetLevel) : (h1MaxHigh >= targetLevel);

      if (isLong) {
        // LONG: Mở nến trên/tại mốc (h1Open >= targetLevel), nhúng đâm qua mốc (h1MinLow <= targetLevel)
        // VÀ rút chân chốt nến tại/trên mốc (h1Close >= targetLevel)
        isRutChan = h1Open >= targetLevel && h1MinLow <= targetLevel && h1Close >= targetLevel;
      } else {
        // SHORT: Mở nến dưới/tại mốc (h1Open <= targetLevel), đẩy trồi qua mốc (h1MaxHigh >= targetLevel)
        // VÀ rút râu chốt nến tại/dưới mốc (h1Close <= targetLevel)
        isRutChan = h1Open <= targetLevel && h1MaxHigh >= targetLevel && h1Close <= targetLevel;
      }

      if (!isRutChan) {
        if (isTouchedH1) {
          log.system(`[H1Retest] ${sym} ${signal} nến H1 đã chạm mốc $${targetLevel} nhưng đâm thủng mốc (Close: $${h1Close}) — XÓA KHỎI WATCHLIST`);
          delete lowScoreWatchlist[sym];
        } else {
          // Kiểm tra "gần chạm + đã nảy": nếu wick H1 đã đến gần mốc entry (trong step*0.1)
          // VÀ giá đã nảy xa khỏi điểm gần chạm đó → coi như mốc đã bị test, xóa khỏi watchlist
          // VD: BAN SHORT entry $0.07543, h1MaxHigh $0.07539 (cách 4 ticks < step*0.1=0.0003)
          //     → nảy từ $0.07539 xuống $0.074x → đã test mốc → xóa
          const nearTouchRange = step * 0.1; // ~10% bước giá = 10 ticks cho coin bước 0.001
          const unit = step / 3;
          const bouncePct = (unit * 0.40 / targetLevel) * 100; // Cố định 40 ticks (0.40 * unit) nảy khỏi cản là hủy khỏi Watchlist

          if (isLong) {
            const isNearTouched = h1MinLow <= targetLevel + nearTouchRange;
            // Bounce từ điểm thấp nhất (h1MinLow) lên cao nhất (h1MaxHigh) trong cùng H1
            const bounceFromLow = ((h1MaxHigh - h1MinLow) / h1MinLow) * 100;
            if (isNearTouched && bounceFromLow >= bouncePct) {
              log.system(`[H1Retest] ${sym} LONG gần chạm mốc $${targetLevel} (Low: $${h1MinLow}, cách ${((h1MinLow - targetLevel) / targetLevel * 100).toFixed(3)}%) và đã nảy +${bounceFromLow.toFixed(2)}% >= ${bouncePct.toFixed(2)}% — XÓA KHỎI WATCHLIST`);
              delete lowScoreWatchlist[sym];
            } else {
              log.system(`[H1Retest] ${sym} LONG nến H1 chưa chạm mốc $${targetLevel} (Low: $${h1MinLow}) — Tiếp tục giữ trong Watchlist`);
            }
          } else {
            const isNearTouched = h1MaxHigh >= targetLevel - nearTouchRange;
            // Bounce từ điểm cao nhất (h1MaxHigh) xuống thấp nhất (h1MinLow) trong cùng H1
            const bounceFromHigh = ((h1MaxHigh - h1MinLow) / h1MaxHigh) * 100;
            if (isNearTouched && bounceFromHigh >= bouncePct) {
              log.system(`[H1Retest] ${sym} SHORT gần chạm mốc $${targetLevel} (High: $${h1MaxHigh}, cách ${((targetLevel - h1MaxHigh) / targetLevel * 100).toFixed(3)}%) và đã nảy -${bounceFromHigh.toFixed(2)}% >= ${bouncePct.toFixed(2)}% — XÓA KHỎI WATCHLIST`);
              delete lowScoreWatchlist[sym];
            } else {
              log.system(`[H1Retest] ${sym} SHORT nến H1 chưa chạm mốc $${targetLevel} (High: $${h1MaxHigh}) — Tiếp tục giữ trong Watchlist`);
            }
          }
        }
        continue;
      }

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

      // 3. Tính Mức Nẩy ROI Tối Đa từ TOÀN BỘ nến H1 (không chỉ sau touchIndex)
      //    Lý do: Wick chạm entry có thể xảy ra CUỐI H1, trong khi bounce thật đã xảy ra TRƯỚC đó.
      //    Nếu chỉ tính từ touchIndex → bỏ sót bounce sớm hơn → đặt lệnh sai.
      let maxFavorableMovePct = 0;
      if (isLong) {
        const maxHighInH1 = Math.max(...m1Candles.map(c => c.high));
        maxFavorableMovePct = ((maxHighInH1 - targetLevel) / targetLevel) * 100;
      } else {
        const minLowInH1 = Math.min(...m1Candles.map(c => c.low));
        maxFavorableMovePct = ((targetLevel - minLowInH1) / targetLevel) * 100;
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

      // ── LOGIC MỚI: TÍNH TOÁN STOPLOSS THEO TIER, TP 1:1, VÀ ĐÒN BẨY / MARGIN ĐỘNG CHO RETEST H1 ──
      const h4RefRetest = await fetchH4Reference(sym);
      const tickSizeRetest = getTickSizeCached(sym) || (getDecimals(targetLevel) === 5 ? 0.00001 : (getDecimals(targetLevel) === 4 ? 0.0001 : 0.000001));
      const targetLossUSDRetest = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '5.0');
      const maxAllowedRetest = (leverageInfo && leverageInfo[sym]) ?? getLeverageCached(sym) ?? 20;

      const tierSetupRetest = calculateTierSLTP(sym, signal, targetLevel, h4RefRetest, tickSizeRetest, maxAllowedRetest, targetLossUSDRetest);
      if (!tierSetupRetest.valid) {
        log.system(`[H1Retest] ⏭️ ${sym} (${signal}) bỏ qua: ${tierSetupRetest.reason}`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      const effectiveLeverageRetest = tierSetupRetest.leverage;
      const actualTradeMarginRetest = Number(tierSetupRetest.margin.toFixed(2));
      const notional = actualTradeMarginRetest * effectiveLeverageRetest;

      const { qty } = calcQuantity(sym, notional, targetLevel);
      const dec = getDecimals(targetLevel);

      if (qty <= 0) {
        log.warn(`[H1Retest] ${sym}: quantity calculation <= 0 — bỏ qua không đặt limit`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      // ── AI Reviewer Machine Learning Offline (Retest H1) ──
      const rank = watchData.marketCapRank || (getMarketCapRank ? getMarketCapRank(sym) : 999);
      const sigForAI = {
        symbol: sym,
        signal: signal,
        targetLevel: targetLevel,
        score: watchData.score,
        scoreReasons: watchData.scoreReasons || [],
        marketCapRank: rank,
        gridWidthPct: gridStepPct,
      };

      let rawMarketDataRetest = null;
      let klinesM15Retest = null;
      try {
        klinesM15Retest = await fetchBinanceKlines(sym, '15m', null, 21);
        const currM15 = klinesM15Retest && klinesM15Retest.length > 0 ? klinesM15Retest[klinesM15Retest.length - 1] : null;
        rawMarketDataRetest = {
          lastM15: currM15,
          touchCount: 2
        };
      } catch (err) {
        // fallback
      }

      const aiEval = evaluateSignalWithAI(sigForAI, rawMarketDataRetest);
      recordAIEvaluation(sigForAI, aiEval);

      // Tiêu chí 3: AI Veto Filter cho Retest H1 (Chỉ đánh khi WinProb >= 58%)
      const isAiVeto = (aiEval.winProbability < 58.0) || (aiEval.reason.includes('VOL_DRY') && aiEval.reason.includes('OI_COOLING'));
      if (isAiVeto) {
        log.system(`[AutoTrade (Retest H1)] 🛑 [AI Veto] ${sym} (${signal}) bị phủ quyết (WinProb ${aiEval.winProbability.toFixed(1)}% < 58%): ${aiEval.reason} — Hủy đặt lệnh Retest.`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      if (aiEval.isApproved) {
        log.system(`[AI Reviewer (Retest H1)] 🟢 Khuyên NÊN ĐẶT LỆNH ${sym} (${signal}) - ${aiEval.reason}`);
      } else {
        log.system(`[AI Reviewer (Retest H1)] 🟡 ${sym} (${signal}) - ${aiEval.reason}`);
      }

      // ── BỘ LỌC M15 SPIKE GUARD CHO RETEST H1 ──
      try {
        if (!klinesM15Retest) {
          klinesM15Retest = await fetchBinanceKlines(sym, '15m', null, 21);
        }
        if (klinesM15Retest && klinesM15Retest.length >= 20) {
          const past20 = klinesM15Retest.slice(0, klinesM15Retest.length - 1);
          const currM15 = klinesM15Retest[klinesM15Retest.length - 1];
          const avgVol20 = past20.reduce((sum, c) => sum + c.volume, 0) / past20.length;
          const m15VolRatio = avgVol20 > 0 ? (currM15.volume / avgVol20) : 1;
          const m15RangePct = ((currM15.high - currM15.low) / (currM15.low || 1)) * 100;

          if (m15RangePct > 1.4 && m15VolRatio >= 2.5) {
            const alertMsg = `🛑 <b>[M15 Spike Guard - RETEST H1 BỎ QUA LIMIT]</b>\n` +
              `• <b>Coin:</b> #${sym} (${signal})\n` +
              `• <b>Mốc Entry:</b> $${targetLevel}\n` +
              `• <b>Biên độ M15:</b> ${m15RangePct.toFixed(2)}% (Ngưỡng > 1.4%)\n` +
              `• <b>Volume M15:</b> ${m15VolRatio.toFixed(2)}x MA20 (Ngưỡng >= 2.5x)\n` +
              `• <b>Lý do:</b> Nến M15 đang bão giá giật mạnh đâm cản. Tự động bỏ qua đặt Limit Retest.`;

            log.system(`[H1Retest] 🛑 [M15 Spike Guard] ${sym} (${signal}): Nến M15 bão giá (Biên độ ${m15RangePct.toFixed(2)}% > 1.4% & Vol ${m15VolRatio.toFixed(2)}x >= 2.5x) — BỎ QUA ĐẶT LIMIT RETEST`);

            try {
              await sendTelegram(alertMsg);
            } catch (teleErr) {
              log.warn(`[H1Retest] Lỗi gửi telegram M15 Spike Guard cho ${sym}: ${teleErr.message}`);
            }

            delete lowScoreWatchlist[sym];
            continue;
          }
        }
      } catch (errM15) {
        log.warn(`[H1Retest] Không thể kiểm tra nến M15 Spike Guard cho ${sym}: ${errM15.message}`);
      }

      try {
        try { await client.setLeverage(sym, effectiveLeverageRetest); } catch (_) { }

        const limitOrder = await client.placeLimit(sym, side, qty, targetLevel, dec);
        const limitId = limitOrder.orderId || limitOrder.id || 'unknown';

        if (activeSymbols) activeSymbols.add(sym);

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
          leverage: effectiveLeverageRetest,
          step: step,
          gridWidthPct: watchData.gridWidthPct || gridStepPct,
          gridStepPct: gridStepPct,
          margin: actualTradeMarginRetest,
          maxFavorablePrice: null,
          isH1Retest: true,
          // ── THÔNG SỐ TIER SL / TP MỚI ──
          tierSlPrice: tierSetupRetest.slPrice,
          tierTpPrice: tierSetupRetest.tpPrice,
          beTriggerPrice: tierSetupRetest.beTriggerPrice,
          slDistance: tierSetupRetest.slDistance,
          slPct: tierSetupRetest.slPct,
          targetLossUSD: targetLossUSDRetest,
        };
        saveActiveTradesMetadata();

        // Xóa khỏi watchlist vì đã đặt lệnh thành công
        delete lowScoreWatchlist[sym];

        // Bắn thông báo Telegram
        await sendTelegram(
          `🎯 <b>[AutoTrade] Lệnh LIMIT Retest H1</b>\n` +
          `• Coin: <b>${sym}USDT (${signal})</b>\n` +
          `• Giá Entry: <b>$${targetLevel}</b>\n` +
          `• Đòn bẩy: <b>${effectiveLeverageRetest}x</b> (Ký quỹ: $${actualTradeMarginRetest})\n` +
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

let isCheckingTrailingSL = false;

async function checkTrailingSL(client, defaultLeverage, leverageInfo, activeSymbols) {
  if (isIpBanned() || isCheckingTrailingSL) return;
  isCheckingTrailingSL = true;
  try {
    if (!activeSymbols || activeSymbols.size === 0) return;

    const rawPositions = await client.getOpenPositions();
    const positions = (rawPositions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    // Kiểm tra xem có vị thế nào ở lượt trước mà lượt này không còn không (sàn đóng hoặc user đóng tay)
    for (const [prevSym, prevPos] of lastActivePositions.entries()) {
      const isStillOpen = positions.some(p => p.symbol === `${prevSym}USDT`);
      if (!isStillOpen) {
        partialClosedSymbols.delete(prevSym);

        // 🧹 Hủy sạch tất cả các lệnh LIMIT Entry còn dư và SL/TP cũ trên sàn (chống cắn lại phần dư của lệnh limit)
        client.cancelAllOpenOrders(prevSym).catch(() => {});
        client.getOpenAlgoOrders(prevSym).then(algos => {
          for (const a of (algos || [])) {
            client.cancelAlgoOrder(prevSym, a.algoId || a.orderId).catch(() => {});
          }
        }).catch(() => {});

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

      // ── Theo dõi maxFavorablePrice: Giá đỉnh/đáy tốt nhất từ khi vào lệnh ──
      // Cập nhật mỗi 3 giây để tránh bỏ lỡ spike ngắn dưới 3 giây giữa hai lần poll.
      // Một khi maxFavorablePrice đã vượt ngưỡng trail trigger, trạng thái này được giữ nguyên
      // cho đến khi vị thế đóng — đảm bảo SL luôn được dời về hòa vốn khi đã đủ điều kiện.
      let metaForPeak = activeTradesMetadata[sym];
      if (!metaForPeak) {
        // Fallback: Tự động khởi tạo metadata nếu vị thế mở trên sàn chưa có metadata
        const stepVal = getStep(entryPrice);
        metaForPeak = {
          symbol: sym,
          side: isLong ? 'BUY' : 'SELL',
          entryPrice: entryPrice,
          leverage: leverageVal,
          step: stepVal,
          gridWidthPct: (stepVal / entryPrice) * 100,
          gridStepPct: (stepVal / entryPrice) * 100,
          maxFavorablePrice: markPrice,
          time: Date.now(),
        };
        activeTradesMetadata[sym] = metaForPeak;
        saveActiveTradesMetadata();
      }

      // Thông báo Telegram khi lệnh LIMIT khớp mở vị thế
      if (metaForPeak && !metaForPeak.hasNotifiedFill) {
        metaForPeak.hasNotifiedFill = true;
        metaForPeak.isFilled = true;
        // 🛡️ RESET maxFavorablePrice về đúng giá Entry ngay khi khớp lệnh,
        // triệt tiêu giá đỉnh cũ lúc đang chờ lệnh LIMIT để tránh bị kích hoạt dời SL ảo đóng lệnh sớm!
        metaForPeak.maxFavorablePrice = entryPrice;
        saveActiveTradesMetadata();
        const fillSide = isLong ? 'LONG' : 'SHORT';
        sendTelegram(
          `⚡ <b>[AutoTrade] Lệnh LIMIT đã khớp thành công!</b>\n` +
          `• Coin: <b>${sym} (${fillSide})</b>\n` +
          `• Giá Entry: <b>$${entryPrice}</b>\n` +
          `• Đòn bẩy: <b>${leverageVal}x</b>\n` +
          `• Ký quỹ: <b>$${metaForPeak.margin || (parseFloat(process.env.TRADE_AMOUNT) || 30)}</b>\n` +
          `• Điểm Score: <b>+${metaForPeak.score || 0}đ</b>`
        ).catch(() => { });
      }
      if (isLong) {
        metaForPeak.maxFavorablePrice = Math.max(metaForPeak.maxFavorablePrice || markPrice, markPrice);
      } else {
        metaForPeak.maxFavorablePrice = Math.min(metaForPeak.maxFavorablePrice || markPrice, markPrice);
      }

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

      // 2.5 Kiểm tra Nến H1 Không Phản Ứng (Gãy cản 35% SL -> Dời TP về Entry hòa vốn)
      //     Áp dụng thuần túy theo Giá Đóng Cửa (Close Price) của cây nến H1 đầu tiên đóng sau khi vào lệnh:
      //     - LONG:  Đóng H1 <= Entry - 35% slDistance
      //     - SHORT: Đóng H1 >= Entry + 35% slDistance
      const invalidationDistance = meta?.slDistance ? (meta.slDistance * 0.35) : (unit * 0.35);
      if (meta && !meta.isH1Failed && !meta.isPanicEscape) {
        const nowMs = Date.now();
        if (!meta._lastH1Check || (nowMs - meta._lastH1Check >= 15000)) {
          meta._lastH1Check = nowMs;
          try {
            const h1s = await fetchBinanceKlines(sym, '1h', null, 5);
            if (h1s && h1s.length >= 2) {
              const lastClosedH1 = h1s[h1s.length - 2];
              const h1CloseTime = lastClosedH1 ? (lastClosedH1.openTime + 3600_000) : 0;
              const entryTime = meta.time || (nowMs - 3600_000);

              // Cây nến H1 vừa đóng phải kết thúc sau thời điểm vào lệnh
              if (lastClosedH1 && h1CloseTime > entryTime) {
                const cClose = lastClosedH1.close;

                if (isLong) {
                  const isClosedBelow = cClose <= (entryPrice - invalidationDistance);
                  if (isClosedBelow) {
                    meta.isH1Failed = true;
                    log.system(`[AutoTrade] ⚠️ ${sym} LONG: Nến H1 đóng cửa gãy sâu 35% SL ($${cClose} <= $${(entryPrice - invalidationDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn $${entryPrice}`);
                  }
                } else {
                  const isClosedAbove = cClose >= (entryPrice + invalidationDistance);
                  if (isClosedAbove) {
                    meta.isH1Failed = true;
                    log.system(`[AutoTrade] ⚠️ ${sym} SHORT: Nến H1 đóng cửa gãy sâu 35% SL ($${cClose} >= $${(entryPrice + invalidationDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn $${entryPrice}`);
                  }
                }
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra H1 cho vị thế ${sym}: ${err.message}`);
          }
        }
      }

      // 2.5b Kiểm tra Nến M15 Đóng Cửa Không Phản Ứng (Dời TP về Entry hòa vốn)
      //     - LONG:  Giá thấp nhất (Low) <= Entry - 30% slDistance (đã từng đâm sâu >= 30% SL)
      //              VÀ Giá đóng cửa (Close) <= Entry - 8% slDistance (đóng nến dưới Entry >= 8% SL)
      //     - SHORT: Giá cao nhất (High) >= Entry + 30% slDistance (đã từng vọt cao >= 30% SL)
      //              VÀ Giá đóng cửa (Close) >= Entry + 8% slDistance (đóng nến trên Entry >= 8% SL)
      const m15MaxPlungeDistance = meta?.slDistance ? (meta.slDistance * 0.30) : (unit * 0.30);
      const m15CloseThresholdDistance = meta?.slDistance ? (meta.slDistance * 0.08) : (unit * 0.08);
      if (meta && !meta.isH1Failed && !meta.isPanicEscape) {
        const nowMs = Date.now();
        if (!meta._lastM15Check || (nowMs - meta._lastM15Check >= 15000)) {
          meta._lastM15Check = nowMs;
          try {
            const m15s = await fetchBinanceKlines(sym, '15m', null, 5);
            if (m15s && m15s.length >= 2) {
              const lastClosedM15 = m15s[m15s.length - 2];
              const m15CloseTime = lastClosedM15 ? (lastClosedM15.openTime + 15 * 60_000) : 0;
              const entryTime = meta.time || (nowMs - 15 * 60_000);

              // Cây nến M15 vừa đóng phải kết thúc sau thời điểm vào lệnh
              if (lastClosedM15 && m15CloseTime > entryTime) {
                const cClose = lastClosedM15.close;
                const cLow = lastClosedM15.low;
                const cHigh = lastClosedM15.high;

                if (isLong) {
                  const isLowBelow30Pct = cLow <= (entryPrice - m15MaxPlungeDistance);
                  const isClosedBelow8Pct = cClose <= (entryPrice - m15CloseThresholdDistance);

                  if (isLowBelow30Pct && isClosedBelow8Pct) {
                    meta.isH1Failed = true;
                    log.system(
                      `[AutoTrade] ⚠️ ${sym} LONG: Nến M15 đóng cửa dưới Entry -8% SL ($${cClose} <= $${(entryPrice - m15CloseThresholdDistance).toFixed(6)}) ` +
                      `kèm đáy nến Low <= Entry - 30% SL ($${cLow} <= $${(entryPrice - m15MaxPlungeDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn $${entryPrice}`
                    );
                  }
                } else {
                  const isHighAbove30Pct = cHigh >= (entryPrice + m15MaxPlungeDistance);
                  const isClosedAbove8Pct = cClose >= (entryPrice + m15CloseThresholdDistance);

                  if (isHighAbove30Pct && isClosedAbove8Pct) {
                    meta.isH1Failed = true;
                    log.system(
                      `[AutoTrade] ⚠️ ${sym} SHORT: Nến M15 đóng cửa trên Entry +8% SL ($${cClose} >= $${(entryPrice + m15CloseThresholdDistance).toFixed(6)}) ` +
                      `kèm đỉnh nến High >= Entry + 30% SL ($${cHigh} >= $${(entryPrice + m15MaxPlungeDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn $${entryPrice}`
                    );
                  }
                }
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra M15 cho vị thế ${sym}: ${err.message}`);
          }
        }
      }

      // 2.6 Kiểm tra M15 Bùng Nổ Volume / Đâm Sâu (Panic Escape -> Dời TP về Entry hòa vốn)
      //     - Khi M15 (đang chạy hoặc vừa đóng) có Volume dự phóng >= 2.5x TB 20 nến M15
      //     - VÀ Giá bị đâm lún sâu >= 40% slDistance qua Entry
      //     - LONG & SHORT: Dời TP về Entry hòa vốn để thoát hàng khi có nhịp giật râu hồi
      if (meta && !meta.isPanicEscape) {
        const nowMs = Date.now();
        if (!meta._lastM15VolCheck || (nowMs - meta._lastM15VolCheck >= 20000)) {
          meta._lastM15VolCheck = nowMs;
          try {
            const m15s = await fetchBinanceKlines(sym, '15m', null, 25);
            if (m15s && m15s.length >= 22) {
              const currentM15 = m15s[m15s.length - 1];
              const lastClosedM15 = m15s[m15s.length - 2];
              const base20 = m15s.slice(-22, -2);
              const avgBaseVolM15 = base20.reduce((s, c) => s + c.volume, 0) / 20;

              const elapsedMin = Math.max(1, Math.min(15, (nowMs - currentM15.openTime) / 60000));
              const projectedCurrentVol = (currentM15.volume / elapsedMin) * 15;
              const currentRatio = avgBaseVolM15 > 0 ? (projectedCurrentVol / avgBaseVolM15) : 0;
              const closedRatio = avgBaseVolM15 > 0 ? (lastClosedM15.volume / avgBaseVolM15) : 0;
              const maxM15Ratio = Math.max(currentRatio, closedRatio);

              if (avgBaseVolM15 > 0 && maxM15Ratio >= 2.5) {
                // Kiểm tra xem giá có bị đâm lún sâu >= 40% slDistance
                const deepPlungeDistance = meta?.slDistance ? (meta.slDistance * 0.40) : (unit * 0.40);
                const isDeepPlunge = isLong
                  ? (Math.min(currentM15.low, lastClosedM15.low) <= entryPrice - deepPlungeDistance)
                  : (Math.max(currentM15.high, lastClosedM15.high) >= entryPrice + deepPlungeDistance);

                if (isDeepPlunge) {
                  meta.isPanicEscape = true;
                  const escapePrice = Number(entryPrice.toFixed(8));

                  log.system(
                    `[AutoTrade] 🚨 [M15 Panic Escape] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ` +
                    `M15 bùng nổ Volume (${maxM15Ratio.toFixed(2)}x TB 20 nến) kèm đâm lún sâu >= 40% SL ` +
                    `-> Kích hoạt dời TP về Entry hòa vốn @ $${escapePrice}`
                  );
                  await sendTelegram(
                    `🚨 <b>M15 Bùng Nổ Volume - Kích Hoạt Thoát Hiểm (Hòa Vốn Entry)</b>\n` +
                    `• Coin: <b>${sym}</b> (${isLong ? 'LONG' : 'SHORT'})\n` +
                    `• Entry: <b>$${entryPrice}</b>\n` +
                    `• Volume M15: <b>${maxM15Ratio.toFixed(1)}x TB 20 nến</b>\n` +
                    `• Đã dời TP thoát hiểm về Entry: <b>$${escapePrice}</b> để đón nhịp giật râu thoát hàng!`
                  );
                }
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra M15 Volume Escape cho ${sym}: ${err.message}`);
          }
        }
      }

      // 3. Tính khoảng cách giá tuyệt đối (Dynamic Trailing SL - Option B):
      //    SL = entry +/- unit (tương đương đúng -13% Margin với đòn bẩy = 39 / gridStepPct)
      //    TP = entry +/- (unit * tpMultiplier) -> 90, 120, 150 ticks với step=300 (hoặc Entry / Escape nếu có sự cố)
      //    Trail Trigger: CỐ ĐỊNH 45 ticks (0.45 * unit) cho TẤT CẢ các thang điểm và mọi độ rộng lưới
      //    Trail SL = entry +/- (unit * 0.05) -> Dời SL +5đ (+5 ticks tùy bước giá, tương đương 0.05 * unit) khi chạm mốc Trail Trigger
      //    LƯU Ý OPTION B: Một khi lệnh đã dời SL về +5đ thì giữ nguyên SL hòa, không rollback về âm.
      const trailMultiplier = 0.45; // Cố định 45 ticks (0.45 * unit) cho mọi thang điểm và độ rộng lưới
      const tpDistance = unit * tpMultiplier;
      const trailDistance = unit * trailMultiplier;
      const trailSlDistance = unit * 0.05; // Dời SL +5 ticks (0.05 * unit) khi chạm mốc Trail Trigger
      // 3. Tính khoảng cách giá và mục tiêu TP/SL theo Tier mới:
      let targetSlPriceExact, targetTpPriceExact, trailTriggerPriceExact, trailedSlPriceExact;
      
      if (meta?.tierSlPrice && meta?.tierTpPrice) {
        targetSlPriceExact = meta.tierSlPrice;
        if (meta?.isPanicEscape || meta?.isH1Failed) {
          targetTpPriceExact = Number(entryPrice.toFixed(8));
        } else {
          targetTpPriceExact = meta.tierTpPrice;
        }
        trailTriggerPriceExact = meta.beTriggerPrice;
        // Dời SL về hòa vốn (+/- 5 ticks bù phí và trượt giá)
        const beBuffer = unit * 0.05;
        trailedSlPriceExact = isLong ? Number((entryPrice + beBuffer).toFixed(8)) : Number((entryPrice - beBuffer).toFixed(8));
      } else {
        // Fallback theo unit nếu metadata cũ
        const trailMultiplier = 0.45;
        const tpDistance = unit * tpMultiplier;
        const trailDistance = unit * trailMultiplier;
        const trailSlDistance = unit * 0.05;
        const slBufferDistance = unit * 0.03;
        if (isLong) {
          targetSlPriceExact = Number((entryPrice - unit - slBufferDistance).toFixed(8));
          if (meta?.isPanicEscape || meta?.isH1Failed) {
            targetTpPriceExact = Number(entryPrice.toFixed(8));
          } else {
            targetTpPriceExact = Number((entryPrice + tpDistance).toFixed(8));
          }
          trailTriggerPriceExact = Number((entryPrice + trailDistance).toFixed(8));
          trailedSlPriceExact = Number((entryPrice + trailSlDistance).toFixed(8));
        } else {
          targetSlPriceExact = Number((entryPrice + unit + slBufferDistance).toFixed(8));
          if (meta?.isPanicEscape || meta?.isH1Failed) {
            targetTpPriceExact = Number(entryPrice.toFixed(8));
          } else {
            targetTpPriceExact = Number((entryPrice - tpDistance).toFixed(8));
          }
          trailTriggerPriceExact = Number((entryPrice - trailDistance).toFixed(8));
          trailedSlPriceExact = Number((entryPrice - trailSlDistance).toFixed(8));
        }
      }

      // Đổi sang ROI % tương đương để logging / telegram / dataset
      const slPct = meta?.slPct ? -meta.slPct : -13;
      const tpPct = (meta?.isPanicEscape || meta?.isH1Failed) ? 0 : parseFloat(((Math.abs(targetTpPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      const trailTrigger = parseFloat(((Math.abs(trailTriggerPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      const trailSlRoi = parseFloat(((Math.abs(trailedSlPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      const posNotional = absAmt * entryPrice;
      const unrealizedPnlUsd = (roi / 100) * (meta?.margin || (posNotional / leverageVal));

      // ----------------------------------------------------
      // 0. HARD MAX LOSS GUARD (Khống chế trần lỗ tối đa)
      // ----------------------------------------------------
      const hardLossCapUSD = (meta?.targetLossUSD ? meta.targetLossUSD : 5.0) * 1.10; // Đệm 10% trượt giá
      if (unrealizedPnlUsd <= -hardLossCapUSD) {
        log.system(`[AutoTrade] 🚨 [Hard Max Loss Guard] Kích hoạt cho ${sym}: Lỗ thả nổi $${unrealizedPnlUsd.toFixed(2)} (${roi.toFixed(2)}%) chạm ngưỡng trần -$${hardLossCapUSD.toFixed(2)} USDT. Cắt lỗ MARKET ngay lập tức!`);
        try {
          justClosedByBot.add(sym);
          await client.placeMarket(sym, oppositeSide, absAmt);
          // 🧹 Hủy sạch tất cả các lệnh còn dư trên sàn (chống cắn lại phần dư của lệnh limit)
          client.cancelAllOpenOrders(sym).catch(() => {});
          for (const algo of openAlgoOrders) {
            client.cancelAlgoOrder(sym, algo.algoId || algo.orderId).catch(() => {});
          }
          await sendTelegram(`🚨 <b>[Hard Max Loss Guard] Cắt Lỗ Khẩn Cấp</b>\n• Coin: <b>${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n• Lỗ chặn tại: <b>$${unrealizedPnlUsd.toFixed(2)} USDT (${roi.toFixed(2)}%)</b>`);
          if (meta) {
            const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
            recordTradeExit({
              tradeId: `${sym}-${meta.orderId || 'vHardLoss'}`,
              orderId: String(meta.orderId || ''),
              symbol: sym,
              exitPrice: markPrice,
              exitTimestamp: Date.now(),
              exitType: 'HARD_MAX_LOSS',
              pnlPercent: roi,
              pnlUsd: unrealizedPnlUsd,
              holdingDurationMinutes: holdingDurationMinutes,
              isWin: false,
            });
          }
        } catch (e) {
          justClosedByBot.delete(sym);
          log.error(`[AutoTrade] [Hard Max Loss Guard] Lỗi đóng vị thế ${sym}: ${e.message}`);
        }
        continue;
      }

      // ----------------------------------------------------
      // 1. Quản lý TAKE PROFIT (Virtual & Real)
      // ----------------------------------------------------

      // 1a. Virtual TP — đóng vị thế ngay khi giá chạm mốc TP mục tiêu
      const isTpReached = isLong ? (markPrice >= targetTpPriceExact - 1e-9) : (markPrice <= targetTpPriceExact + 1e-9);
      if (isTpReached) {
        const exitLabel = meta?.isPanicEscape ? 'Thoát Hiểm Entry' : (meta?.isH1Failed ? 'Hòa Vốn Entry' : 'Take Profit');
        log.system(`[AutoTrade] [Virtual TP - ${exitLabel}] Kích hoạt cho ${sym}: Giá $${markPrice} chạm mốc $${targetTpPriceExact.toFixed(5)} (ROI ~${roi.toFixed(2)}%). Đóng vị thế MARKET.`);
        try {
          justClosedByBot.add(sym);
          await client.placeMarket(sym, oppositeSide, absAmt);
          // 🧹 Hủy sạch tất cả các lệnh còn dư trên sàn (chống cắn lại phần dư của lệnh limit)
          client.cancelAllOpenOrders(sym).catch(() => {});
          for (const algo of openAlgoOrders) {
            client.cancelAlgoOrder(sym, algo.algoId || algo.orderId).catch(() => {});
          }
          await sendTelegram(`🎯 <b>${exitLabel} (Virtual)</b>\n• Coin: <b>${sym}</b>\n• Giá chạm: <b>$${markPrice}</b> (Target: $${targetTpPriceExact.toFixed(5)})\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
          // ── Record trade exit for AI Dataset ──
          if (meta) {
            const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
            recordTradeExit({
              tradeId: `${sym}-${meta.orderId || 'vTP'}`,
              orderId: String(meta.orderId || ''),
              symbol: sym,
              exitPrice: markPrice,
              exitTimestamp: Date.now(),
              exitType: meta?.isPanicEscape ? 'PANIC_ESCAPE' : (meta?.isH1Failed ? 'BE_EXIT' : 'TP'),
              pnlPercent: roi,
              pnlUsd: (roi / 100) * (meta.margin || 0),
              holdingDurationMinutes: holdingDurationMinutes,
              isWin: roi >= 0,
            });
          }
        } catch (e) {
          justClosedByBot.delete(sym);
          log.error(`[AutoTrade] [Virtual TP] Lỗi đóng vị thế ${sym}: ${e.message}`);
        }
        continue; // Bỏ qua check SL cho coin này trong lượt này
      }

      // 1b. Cập nhật / Đặt algo TP lên sàn tại mốc targetTpPriceExact
      const isCustomTpActive = (meta?.isH1Failed || meta?.isPanicEscape) === true;
      if (isCustomTpActive && realTpOrders.length > 0 && !meta.hasMovedTpToCustom) {
        for (const o of realTpOrders) {
          try {
            if (o.isAlgo) await client.cancelAlgoOrder(sym, o.orderId);
            else await client.cancelOrder(sym, o.orderId);
          } catch (e) {
            log.warn(`[AutoTrade] Hủy TP cũ ${sym} để dời về mốc thoát: ${e.message}`);
          }
        }
        meta.hasMovedTpToCustom = true;
        try {
          const tpOrder = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', targetTpPriceExact);
          const tpId = tpOrder.orderId || tpOrder.algoId || 'unknown';
          const tpLabel = meta?.isPanicEscape ? 'Thoát hiểm Entry' : 'Hòa vốn Entry';
          log.system(`[AutoTrade] ⚠️ Đã dời TP ${sym} về mốc [${tpLabel}] @ $${targetTpPriceExact.toFixed(5)} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          log.error(`[AutoTrade] Đặt TP thoát ${sym} thất bại: ${_binanceErr(e)}`);
        }
      } else if (realTpOrders.length === 0) {
        try {
          const tpOrder = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', targetTpPriceExact);
          const tpId = tpOrder.orderId || tpOrder.algoId || 'unknown';
          log.system(`[AutoTrade] ✓ Đặt TP ${sym} @ $${tpOrder.stopPrice || tpOrder.triggerPrice || targetTpPriceExact.toFixed(5)} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          const errStr = _binanceErr(e);
          if (errStr.includes('-4509') || errStr.includes('-4130')) {
            log.system(`[AutoTrade] Lệnh TP ${sym} đã tồn tại trên sàn hoặc vị thế đã đóng. Bỏ qua.`);
            continue;
          }
          log.error(`[AutoTrade] Đặt TP ${sym} thất bại: ${errStr}`);
        }
      }


      // ----------------------------------------------------
      // 2. Quản lý STOP LOSS (Virtual & Real, Trailing SL & Near-TP Lock)
      // ----------------------------------------------------
      // Dùng peakPrice (giá đỉnh/đáy tốt nhất được theo dõi liên tục) thay vì chỉ markPrice hiện tại.
      const peakPrice = meta?.maxFavorablePrice || markPrice;

      // a. Ngưỡng Kích hoạt Trailing SL cơ bản (45đ cố định, kèm đệm 5 ticks để tránh trượt WebSocket)
      const triggerBuffer = unit * 0.05;
      const isTrailTriggerReached = isLong
        ? (peakPrice >= trailTriggerPriceExact - triggerBuffer)
        : (peakPrice <= trailTriggerPriceExact + triggerBuffer);

      let targetSlPrice = targetSlPriceExact;
      let currentSlPct = slPct;

      if (isTrailTriggerReached) {
        currentSlPct = trailSlRoi; // Dời SL về entry + 5đ (+5 ticks)
        targetSlPrice = trailedSlPriceExact;
      }

      // Lấy tickSize từ cache RAM để định dạng giá chính xác
      const tickSize = getTickSizeCached(sym);

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
        // Có lệnh SL trên sàn -> Thực hiện dịch chuyển Trailing SL khi giá đã từng chạm mốc 45 ticks (isTrailTriggerReached)
        if (isTrailTriggerReached) {
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
            const levelLabel = currentSlPct === trailSlRoi ? '+5đ (Khóa lãi)' : 'Khóa lãi';
            const ticksLabel = (trailMultiplier * 100).toFixed(0);
            log.system(`[AutoTrade] Trailing SL (chạm mốc ${ticksLabel}đ): ${sym} đạt ROI ${roi.toFixed(2)}% -> Dịch SL trên sàn về entry +5đ ($${targetSlStr}, ROI ~${currentSlPct}%) [Mức: ${levelLabel}]`);

            // ── PARTIAL TP 50% (Chốt 50% khối lượng khi đạt 45 ticks và dời SL về BE) ──
            let partialTpExecutedQty = 0;
            if (meta && !meta.hasPartialTp50 && absAmt > 0) {
              try {
                const halfQty = calcHalfQuantity(sym, absAmt);
                if (halfQty > 0) {
                  log.system(`[AutoTrade] 🎯 [Partial TP 50%] ${sym}: Đạt mốc ${ticksLabel}đ -> Tiến hành chốt 50% vị thế (${halfQty} ${sym}) MARKET...`);
                  await client.placeMarket(sym, oppositeSide, halfQty);
                  meta.hasPartialTp50 = true;
                  partialTpExecutedQty = halfQty;
                  saveActiveTradesMetadata();
                }
              } catch (partialErr) {
                log.warn(`[AutoTrade] Lỗi chốt Partial TP 50% cho ${sym}: ${partialErr.message}`);
              }
            }

            // 🧹 Hủy sạch các lệnh LIMIT Entry còn treo dư (chống khớp lại phần dư khi giá hồi về Entry)
            const remainingEntryLimits = openOrders.filter(o => o.type === 'LIMIT' || o.orderType === 'LIMIT');
            for (const limitOrder of remainingEntryLimits) {
              client.cancelOrder(sym, limitOrder.orderId).catch(() => {});
            }

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

              // Gửi duy nhất 1 thông báo Telegram (Gộp Chốt Lời 50% & Dời SL Hòa Vốn)
              const ticksLabel = (trailMultiplier * 100).toFixed(0);
              if (partialTpExecutedQty > 0) {
                sendTelegram(
                  `🎯 <b>[AutoTrade] Chốt Lời 50% & Khóa Lãi (+${ticksLabel} ticks)</b>\n` +
                  `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
                  `• Đã chốt: <b>${partialTpExecutedQty} ${sym}</b> (50% khối lượng)\n` +
                  `• ROI lúc chốt: <b>+${roi.toFixed(2)}%</b>\n` +
                  `• Đã dời SL trên sàn về: <b>$${targetSlStr}</b> (+5 ticks khóa lãi)\n` +
                  `• 50% khối lượng còn lại tiếp tục gồng về TP 1.5R!`
                ).catch(() => { });
              } else {
                sendTelegram(
                  `🛡️ <b>[AutoTrade] Khóa Lãi Hòa Vốn (+${ticksLabel} ticks)</b>\n` +
                  `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
                  `• ROI hiện tại: <b>+${roi.toFixed(2)}%</b>\n` +
                  `• Đã dời SL trên sàn về: <b>$${targetSlStr}</b> (+5 ticks khóa lãi)\n` +
                  `• Tiếp tục gồng về TP 1.5R!`
                ).catch(() => { });
              }
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
          const typeLabel = (isTrailTriggerReached || roi >= trailTrigger) ? 'Trailing SL' : 'Stop Loss';
          log.system(`[AutoTrade] [Virtual ${typeLabel}] Kích hoạt cho ${sym}: Giá ${markPrice} chạm/vượt mốc $${targetSlStr}. Đóng vị thế bằng lệnh MARKET.`);
          try {
            justClosedByBot.add(sym);
            await client.placeMarket(sym, oppositeSide, absAmt);
            // 🧹 Hủy sạch tất cả các lệnh còn dư trên sàn (chống cắn lại phần dư của lệnh limit)
            client.cancelAllOpenOrders(sym).catch(() => {});
            for (const algo of openAlgoOrders) {
              client.cancelAlgoOrder(sym, algo.algoId || algo.orderId).catch(() => {});
            }
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
            if (errStr.includes('-4509') || errStr.includes('-4130') || errStr.includes('-2021')) {
              log.system(`[AutoTrade] Lệnh SL ${sym} đã tồn tại, lập tức kích hoạt hoặc vị thế đã đóng trên sàn. Bỏ qua.`);
            } else {
              log.error(`[AutoTrade] Đặt SL ${sym} thất bại: ${errStr}`);
            }
          }
        }
      }
    }
  } catch (err) {
    if (_shouldLogSignal('SYSTEM', 'HTTP429', 'WARN', 'virtual_tpsl', 60000)) {
      log.warn(`[AutoTrade] Lỗi kiểm tra virtual TP/SL: ${err.message}`);
    }
  } finally {
    isCheckingTrailingSL = false;
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
      const fallbackPrice = (typeof getMarkPrice === 'function' ? getMarkPrice(sym) : null) || prevPos.entryPrice;
      recordTradeExit({
        tradeId: `${sym}-${meta.orderId || 'real'}`,
        orderId: String(meta.orderId || ''),
        symbol: sym,
        exitPrice: closePrice || fallbackPrice,
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
