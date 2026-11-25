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
const axios = require('axios');
const { createClient, loadStepSizes, loadLeverageBrackets, calcQuantity, getSymbolTickSizeSync } = require('./binance');
const { isIpBanned } = require('./circuitBreaker');
const { notifySignals, sendTelegram } = require('../pp369/telegram');
const { getOnDemandMarketData, getRamCacheStats } = require('../collectors');
const {
  startStream: startBinanceStream,
  stopStream: stopBinanceStream,
  onEntryFill,
  onOrderFill,
  onOrderCancel,
} = require('./binanceStream');
const {
  placeDualBracket,
  ratchetBreakeven,
  ratchetTrailingFractal,
  autoCleanOppositeOrder,
} = require('./bracketManager');
const {
  evaluateSafetyBrake,
  overrideSafetyBrake,
  isSafetyBrakeActive,
  runReverseCheck,
} = require('./safetyBrake');
const { startDashboard, stopDashboard, broadcastWs, setPromoteShadowHandler, setCancelLimitHandler } = require('../dashboard');
const { removeShadowPosition, removeShadowBySymbolDirection } = require('../pp369/shadowTracker');
const { startTelegramCommands, stopTelegramCommands } = require('../services');
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
  getRecentFractalSwing,
  getRecentM15FractalSwing,
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  findSwingPoints,
  calculateATR,
  isTop50Symbol,
  scoreSetup,
  checkHardFilters,
  calcMaxLeverage,
  calcTAFromKlines,
  updatePricesRest,
  syncWebSocketSubscriptions,
  onPriceUpdate,
  score369Method,
  isGridWidthValid,
  getMinGridPct,
  GRID_MAX_PCT,
  YEAR_START_MS,
  getMarketCapRank,
  fetchH4Reference,
  buildLevelGrid,
  recordTradeEntry,
  recordTradeExit,
  evaluateSignalWithAI,
  recordAIEvaluation,
  getAIModelConfig,
  recordSkippedSignal,
  checkTurnoverGuard,
  updateVolume24hCache,
  registerShadowTrade,
  updateShadowPrices,
  getActiveShadowPositions,
  getShadowStats,
  startPeriodicRetrain,
  getRetrainStatus,
  startDailyReportScheduler,
} = require('../pp369');
const { log } = require('../pp369/_logger');
const { isSymbolInCooldown, getRemainingCooldownHours, addSymbolToCooldown } = require('./cooldownManager');
const { isDirectionLocked, recordDirectionalTradeExit, tryEarlyDirectionalRecovery } = require('./directionalCircuitBreaker');
const { isRealTradingSuspended, recordRealTradeOutcome } = require('./rollingPerformanceGuard');
const { scanMicrostructure, getCvdMomentum } = require('./microstructureScanner');

const SCAN_INTERVAL_MS = 30_000;   // scan mỗi 30 giây
const TRAILING_SL_INTERVAL_MS = 6_000; // kiểm tra vị thế để dịch SL mỗi 6 giây
const MONITOR_LIMIT_INTERVAL_MS = 3_000; // Luồng 3: monitor lệnh LIMIT đang chờ mỗi 3 giây
const DEBOUNCE_MS = 5 * 60_000; // 5 phút / tín hiệu
const COIN_REFRESH_INTERVAL_MS = 4 * 60 * 60_000; // Tái kiểm tra danh sách coin mỗi 4 giờ
const LEVERAGE_REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // Tự động cập nhật trần đòn bẩy mỗi 6 giờ
const MIN_CONFLUENCE_SCORE = parseFloat(process.env.MIN_CONFLUENCE_SCORE || '5.0'); // Ngưỡng Confluence Score tối thiểu (mặc định 5.0đ)
let isShadowMode = process.env.SHADOW_MODE === 'true' || !process.env.BINANCE_API_KEY || !(process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET);

function isShadowPositionActive(sym) {
  if (!isShadowMode || !sym) return false;
  const activeShadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
  return Object.values(activeShadows).some(p => p.symbol === sym);
}

// [ARCHIVED - BE] Cơ chế Dời SL về hòa vốn (Breakeven) & Chốt lời từng phần cũ:
// Tạm tắt để AI tự quyết định TP & SL dứt điểm cho từng lệnh, loại bỏ bẫy quét non hòa vốn (Negative Asymmetry)
// Code cũ:
//   const ENABLE_TRAILING_BE = process.env.ENABLE_TRAILING_BE !== 'false';
//   const ENABLE_PARTIAL_TP = process.env.ENABLE_PARTIAL_TP !== 'false';
const ENABLE_TRAILING_BE = true; // Kích hoạt M15 Fractal Wave Trailing SL: Dời SL bám theo Đáy/Đỉnh sóng Williams Fractal 5 nến trên M15/M5/M1 khi đạt ngưỡng kích hoạt (>= 35% TP)
const ENABLE_PARTIAL_TP = false;  // Tắt chốt 50% non: Chốt trọn vẹn 100% tại mốc TP tối ưu của AI
const ENABLE_TREND_RUNNER = process.env.ENABLE_TREND_RUNNER !== 'false';
// Cấu hình AI Hủy Limit Sớm (Pre-Fill Cancel: Hủy lệnh LIMIT nếu dòng tiền Taker/sổ lệnh suy yếu trước khi khớp)
const ENABLE_AI_PREFILL_CANCEL = process.env.ENABLE_AI_PREFILL_CANCEL !== 'false';
// Cấu hình Thoát Hiểm Phòng Thủ (Đã tắt trên Altcoin theo Roadmap Phase 1, chỉ giữ lại duy nhất BTC Flash Guard vĩ mô)
const ENABLE_DEFENSIVE_ESCAPE = false;

// Debounce map: key → timestamp lần đặt lệnh gần nhất
const _fired = new Map();
const bounceCancelledLevels = new Map(); // key: sym_targetLevel -> expireTimestamp (20 phút cooldown thích ứng)

// Thời gian chờ xác nhận duy trì nảy xa trước khi hủy lệnh LIMIT theo cơ chế Bounce Cancel (mặc định 180s = 3 phút)
const BOUNCE_CANCEL_WAIT_SEC = parseInt(process.env.BOUNCE_CANCEL_WAIT_SECONDS || '180', 10);
const BOUNCE_CANCEL_WAIT_MS = BOUNCE_CANCEL_WAIT_SEC * 1000;

function checkBounceCancelHoldReady(sym, dir, meta, isBounceConditionMet, displayPct, thresholdPct) {
  if (!isBounceConditionMet) {
    if (meta.bounceConfirmStartTime) {
      log.system(`[AutoTrade] [BounceCancel] ${sym} ${dir}: Giá quay lại dưới ngưỡng nảy (${displayPct.toFixed(2)}% < ${thresholdPct.toFixed(2)}%) → Hủy đếm ngược, tiếp tục giữ lệnh LIMIT.`);
      meta.bounceConfirmStartTime = null;
      saveActiveTradesMetadata();
    }
    return false;
  }

  if (BOUNCE_CANCEL_WAIT_MS <= 0) return true;

  const now = Date.now();
  if (!meta.bounceConfirmStartTime) {
    meta.bounceConfirmStartTime = now;
    saveActiveTradesMetadata();
    log.system(`[AutoTrade] [BounceCancel] ${sym} ${dir}: Giá nảy ${displayPct.toFixed(2)}% >= ${thresholdPct.toFixed(2)}% — Chờ xác nhận ${BOUNCE_CANCEL_WAIT_SEC}s (${(BOUNCE_CANCEL_WAIT_SEC / 60).toFixed(1)}p) trước khi hủy LIMIT...`);
    return false;
  }

  return (now - meta.bounceConfirmStartTime) >= BOUNCE_CANCEL_WAIT_MS;
}

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

// Hàm dọn dẹp các Map bộ nhớ đệm chạy 24/7 để triệt tiêu rò rỉ bộ nhớ (Memory Leak Prevention)
let _lastGcTime = 0;
function pruneMemoryCaches() {
  const now = Date.now();
  // 1. Dọn dẹp _signalLogCooldown
  if (_signalLogCooldown.size > 200) {
    for (const [k, ts] of _signalLogCooldown.entries()) {
      if (now - ts > 30 * 60 * 1000) {
        _signalLogCooldown.delete(k);
      }
    }
  }
  // 2. Dọn dẹp bounceCancelledLevels (xóa các key đã quá hạn cooldown)
  for (const [k, exp] of bounceCancelledLevels.entries()) {
    if (now >= exp) {
      bounceCancelledLevels.delete(k);
    }
  }
  // 3. Dọn dẹp _fired debounce map (xóa các key cũ hơn 10 phút)
  for (const [k, ts] of _fired.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      _fired.delete(k);
    }
  }
  // 4. Kích hoạt dọn rác V8 chủ động mỗi 5 phút (nếu có cờ --expose-gc) để duy trì RAM ~100MB
  if (typeof global.gc === 'function' && (now - _lastGcTime > 5 * 60 * 1000)) {
    _lastGcTime = now;
    try {
      global.gc();
    } catch (_) { }
  }
}

// Watchlist cho các mã chờ check Retest nến H1
const lowScoreWatchlist = {}; // sym -> { symbol, signal, targetLevel, score, step, timestamp }
let lastCheckedH1Time = 0;

// Cache lưu metadata của vị thế đang chạy
const METADATA_PATH = path.join(process.cwd(), 'data', 'active_trades.json');
let activeTradesMetadata = {};
try {
  if (fs.existsSync(METADATA_PATH)) {
    activeTradesMetadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
    for (const [sym, meta] of Object.entries(activeTradesMetadata)) {
      if (meta?.isPartialClosed) {
        partialClosedSymbols.add(sym);
      }
      if (meta && !meta.isClosed) {
        const dir = meta.side || meta.direction || (meta.isLong === true ? 'LONG' : (meta.isLong === false ? 'SHORT' : null));
        try { removeShadowBySymbolDirection(sym, dir); } catch (_) {}
      }
    }
  }
} catch (err) {
  log.warn(`[AutoTrade] Lỗi đọc active_trades.json: ${err.message}`);
}

function getTickSizeCached(sym) {
  return getSymbolTickSizeSync(sym);
}

function getEffectiveTickSize(sym, price) {
  const cached = getTickSizeCached(sym);
  if (typeof cached === 'number' && cached > 0) return cached;
  const dec = getDecimals(price);
  return Math.pow(10, -dec);
}

function saveActiveTradesMetadata() {
  try {
    fs.writeFileSync(METADATA_PATH, JSON.stringify(activeTradesMetadata, null, 2), 'utf8');
    if (typeof broadcastWs === 'function') {
      broadcastWs('TRADES_UPDATE', activeTradesMetadata);
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi ghi active_trades.json: ${err.message}`);
  }
}

// ── BTC Flash Pump / Dump Guard State ────────────────────────
let globalTradeClient = null;

let btcFlashState = {
  isShortLocked: false,
  isLongLocked: false,
  lockedUntil: 0,
  lockReason: '',
  severity: 'NORMAL',       // 'NORMAL' | 'MODERATE' | 'SEVERE'
  lastTriggeredAt: 0,       // Chống Ping-Pong lật chiều liên tục
  lastTriggeredM1OpenTime: 0,
  lastTriggeredM15OpenTime: 0,
  lastCheckTime: 0
};

const BTC_FLASH_FLIP_COOLDOWN_MS   = 5 * 60_000;  // Chống lật chiều Pump <-> Dump tối thiểu 5 phút
const BTC_FLASH_FLIP_OVERRIDE_PCT  = 1.20;        // Chỉ cho phép lật chiều ngay trong 5p nếu cú ngược >= 1.20%
const BTC_FLASH_MODERATE_LOCK_MS   = 20 * 60_000; // Mức 1 (Biến động mạnh): Khóa mở mới 20 phút, KHÔNG ép PanicEscape
const BTC_FLASH_SEVERE_LOCK_MS     = 45 * 60_000; // Mức 2 (Bão thật >= 1.5%): Khóa 45 phút + PanicEscape lệnh đang lỗ
const BTC_FLASH_WS_60S_PCT         = 0.65;        // WS 60s >= ±0.65%
const BTC_FLASH_WS_180S_PCT        = 1.00;        // WS 180s >= ±1.00%
const BTC_FLASH_M1_BODY_PCT        = 0.55;        // M1 thân nến >= ±0.55% + Vol >= 2.5x
const BTC_FLASH_M1_CASCADE_PCT     = 0.85;        // 3 nến M1 liên tiếp >= ±0.85%
const BTC_FLASH_M15_BODY_PCT       = 0.90;        // M15 thân nến >= ±0.90% + Vol >= 2.2x (bỏ bẫy râu rút chân)
const BTC_FLASH_M15_VOL_RATIO      = 2.2;
const BTC_FLASH_M15_VOL_ABS        = 8000;
const BTC_FLASH_SEVERE_MOVE_PCT    = 1.50;

// ── Sliding Window 180s cho Real-time WebSocket Velocity ────
const btcTickHistory = []; // { t: number, p: number }
let lastWsFlashTriggerTime = 0;

function checkBtcFlashGatekeeper(signal) {
  const isShort = signal === 'SHORT' || signal === 'SELL';
  const isLong = signal === 'LONG' || signal === 'BUY';
  const now = Date.now();
  if (isShort && btcFlashState.isShortLocked && now < btcFlashState.lockedUntil) {
    return {
      isLocked: true,
      severity: btcFlashState.severity || 'MODERATE',
      reason: btcFlashState.lockReason || 'BTC Flash Pump',
      remainingMinutes: Math.max(1, Math.ceil((btcFlashState.lockedUntil - now) / 60_000))
    };
  }
  if (isLong && btcFlashState.isLongLocked && now < btcFlashState.lockedUntil) {
    return {
      isLocked: true,
      severity: btcFlashState.severity || 'MODERATE',
      reason: btcFlashState.lockReason || 'BTC Flash Dump',
      remainingMinutes: Math.max(1, Math.ceil((btcFlashState.lockedUntil - now) / 60_000))
    };
  }
  return { isLocked: false, severity: 'NORMAL', reason: '', remainingMinutes: 0 };
}

function isBtcFlashLocked(signal) {
  return checkBtcFlashGatekeeper(signal).isLocked;
}

function isOrderReduceOnly(order) {
  return order?.reduceOnly === true ||
    order?.reduceOnly === 'true' ||
    order?.closePosition === true ||
    order?.closePosition === 'true';
}

// ── Helper kích hoạt Khóa SHORT khi BTC Flash Pump ──────────
async function triggerBtcFlashPump(client, { reason, source = 'REST', movePct = 0, durationMs = null } = {}) {
  const now = Date.now();
  const absMove = Math.abs(Number(movePct) || 0);
  const isSevere = absMove >= BTC_FLASH_SEVERE_MOVE_PCT || (source !== 'Nến M15' && absMove >= 1.20);
  const severity = isSevere ? 'SEVERE' : 'MODERATE';
  const lockMs = durationMs || (isSevere ? BTC_FLASH_SEVERE_LOCK_MS : BTC_FLASH_MODERATE_LOCK_MS);
  const lockMins = Math.round(lockMs / 60_000);

  // Chống Ping-Pong: nếu đang khóa LONG chưa quá 5 phút và cú ngược chiều chưa đạt bão >= 1.20% -> bỏ qua
  if (btcFlashState.isLongLocked && now < btcFlashState.lockedUntil) {
    const elapsedSinceTrigger = now - (btcFlashState.lastTriggeredAt || 0);
    if (elapsedSinceTrigger < BTC_FLASH_FLIP_COOLDOWN_MS && absMove < BTC_FLASH_FLIP_OVERRIDE_PCT) {
      log.system(`[AutoTrade] ⏳ [BTC Guard] Bỏ qua tín hiệu xoay chiều Dump -> Pump [${source}] (${absMove.toFixed(2)}% < ${BTC_FLASH_FLIP_OVERRIDE_PCT}%) trong thời gian chống Ping-Pong 5 phút.`);
      return { triggered: false, reason: 'FLIP_COOLDOWN' };
    }
    btcFlashState.isLongLocked = false;
    log.system(`[AutoTrade] 🔄 [BTC Guard] BTC xoay chiều mạnh từ Dump sang Pump -> Tự động GIẢI PHÓNG lệnh LONG!`);
  }

  const isNewLock = !btcFlashState.isShortLocked;
  const isUpgradeToSevere = btcFlashState.isShortLocked && btcFlashState.severity !== 'SEVERE' && isSevere;
  btcFlashState.isShortLocked = true;
  btcFlashState.lockedUntil = Math.max(btcFlashState.lockedUntil, now + lockMs);
  btcFlashState.lockReason = reason;
  btcFlashState.severity = isSevere ? 'SEVERE' : (btcFlashState.severity === 'SEVERE' ? 'SEVERE' : 'MODERATE');
  btcFlashState.lastTriggeredAt = now;

  if (isNewLock || isUpgradeToSevere) {
    log.system(`[AutoTrade] 🚨 [BTC Flash Pump Guard] [${source} | ${severity}] Kích hoạt khóa SHORT Altcoin trong ${lockMins} phút (${btcFlashState.lockReason})`);

    // Hủy CHỈ các lệnh ENTRY Limit SHORT đang treo (!reduceOnly — tuyệt đối KHÔNG hủy TP LIMIT của vị thế LONG)
    const effectiveClient = client || globalTradeClient;
    if (effectiveClient) {
      try {
        const openOrders = await effectiveClient.getOpenOrders();
        for (const order of (openOrders || [])) {
          if (!isOrderReduceOnly(order) && order.side === 'SELL' && (order.type === 'LIMIT' || order.orderType === 'LIMIT')) {
            const sym = order.symbol.replace('USDT', '');
            await effectiveClient.cancelOrder(sym, order.orderId).catch(() => { });
            log.system(`[AutoTrade] [BTC Guard] Hủy lệnh ENTRY LIMIT SHORT treo của ${sym} để phòng ngừa rủi ro.`);
          }
        }
        // Giữ nguyên toàn bộ vị thế đã khớp cùng TP/SL & Fractal Trailing SL trên sàn (không kích hoạt PanicEscape)
      } catch (_) { }
    }

    sendTelegram(
      `🚨 <b>[BTC Flash Pump Guard — ${severity}] (${source})</b>\n` +
      `• <b>Phát hiện:</b> ${reason}\n` +
      `• <b>Hành động:</b> Tự động <b>KHÓA SHORT ${lockMins}p</b> &amp; hủy Entry Limit chờ (giữ nguyên vị thế đã khớp cùng TP/SL trên sàn)!`
    ).catch(() => { });
  }
  return { triggered: true, severity, lockMins };
}

// ── Helper kích hoạt Khóa LONG khi BTC Flash Dump ──────────
async function triggerBtcFlashDump(client, { reason, source = 'REST', movePct = 0, durationMs = null } = {}) {
  const now = Date.now();
  const absMove = Math.abs(Number(movePct) || 0);
  const isSevere = absMove >= BTC_FLASH_SEVERE_MOVE_PCT || (source !== 'Nến M15' && absMove >= 1.20);
  const severity = isSevere ? 'SEVERE' : 'MODERATE';
  const lockMs = durationMs || (isSevere ? BTC_FLASH_SEVERE_LOCK_MS : BTC_FLASH_MODERATE_LOCK_MS);
  const lockMins = Math.round(lockMs / 60_000);

  // Chống Ping-Pong: nếu đang khóa SHORT chưa quá 5 phút và cú ngược chiều chưa đạt bão >= 1.20% -> bỏ qua
  if (btcFlashState.isShortLocked && now < btcFlashState.lockedUntil) {
    const elapsedSinceTrigger = now - (btcFlashState.lastTriggeredAt || 0);
    if (elapsedSinceTrigger < BTC_FLASH_FLIP_COOLDOWN_MS && absMove < BTC_FLASH_FLIP_OVERRIDE_PCT) {
      log.system(`[AutoTrade] ⏳ [BTC Guard] Bỏ qua tín hiệu xoay chiều Pump -> Dump [${source}] (${absMove.toFixed(2)}% < ${BTC_FLASH_FLIP_OVERRIDE_PCT}%) trong thời gian chống Ping-Pong 5 phút.`);
      return { triggered: false, reason: 'FLIP_COOLDOWN' };
    }
    btcFlashState.isShortLocked = false;
    log.system(`[AutoTrade] 🔄 [BTC Guard] BTC xoay chiều mạnh từ Pump sang Dump -> Tự động GIẢI PHÓNG lệnh SHORT!`);
  }

  const isNewLock = !btcFlashState.isLongLocked;
  const isUpgradeToSevere = btcFlashState.isLongLocked && btcFlashState.severity !== 'SEVERE' && isSevere;
  btcFlashState.isLongLocked = true;
  btcFlashState.lockedUntil = Math.max(btcFlashState.lockedUntil, now + lockMs);
  btcFlashState.lockReason = reason;
  btcFlashState.severity = isSevere ? 'SEVERE' : (btcFlashState.severity === 'SEVERE' ? 'SEVERE' : 'MODERATE');
  btcFlashState.lastTriggeredAt = now;

  if (isNewLock || isUpgradeToSevere) {
    log.system(`[AutoTrade] 🚨 [BTC Flash Dump Guard] [${source} | ${severity}] Kích hoạt khóa LONG Altcoin trong ${lockMins} phút (${btcFlashState.lockReason})`);

    // Hủy CHỈ các lệnh ENTRY Limit LONG đang treo (!reduceOnly — tuyệt đối KHÔNG hủy TP LIMIT của vị thế SHORT)
    const effectiveClient = client || globalTradeClient;
    if (effectiveClient) {
      try {
        const openOrders = await effectiveClient.getOpenOrders();
        for (const order of (openOrders || [])) {
          if (!isOrderReduceOnly(order) && order.side === 'BUY' && (order.type === 'LIMIT' || order.orderType === 'LIMIT')) {
            const sym = order.symbol.replace('USDT', '');
            await effectiveClient.cancelOrder(sym, order.orderId).catch(() => { });
            log.system(`[AutoTrade] [BTC Guard] Hủy lệnh ENTRY LIMIT LONG treo của ${sym} để phòng ngừa rủi ro.`);
          }
        }
        // Giữ nguyên toàn bộ vị thế đã khớp cùng TP/SL & Fractal Trailing SL trên sàn (không kích hoạt PanicEscape)
      } catch (_) { }
    }

    sendTelegram(
      `🚨 <b>[BTC Flash Dump Guard — ${severity}] (${source})</b>\n` +
      `• <b>Phát hiện:</b> ${reason}\n` +
      `• <b>Hành động:</b> Tự động <b>KHÓA LONG ${lockMins}p</b> &amp; hủy Entry Limit chờ (giữ nguyên vị thế đã khớp cùng TP/SL trên sàn)!`
    ).catch(() => { });
  }
  return { triggered: true, severity, lockMins };
}

// ── TẦNG 1: Real-time WebSocket Velocity Guard (Độ trễ 0ms - Không chờ nến đóng) ──
function checkRealtimeBtcFlashVelocity(price, client) {
  if (!price || price <= 0) return;
  const now = Date.now();
  btcTickHistory.push({ t: now, p: price });

  // Dọn dẹp tick cũ hơn 180s (3 phút)
  while (btcTickHistory.length > 0 && btcTickHistory[0].t < now - 180_000) {
    btcTickHistory.shift();
  }

  // Cần ít nhất 5 tick và tích lũy ít nhất 15s dữ liệu để tránh báo động giả khi bot mới khởi động
  if (btcTickHistory.length < 5) return;
  const oldestTick = btcTickHistory[0];
  if (now - oldestTick.t < 15_000) return;

  // Cooldown giữa 2 lần kích hoạt liên tiếp qua WebSocket (tối thiểu 180s)
  if (now - lastWsFlashTriggerTime < 180_000) return;

  // Tính đỉnh và đáy trong 60s và 180s gần nhất
  let max60 = 0, min60 = Infinity;
  let max180 = 0, min180 = Infinity;

  for (let i = btcTickHistory.length - 1; i >= 0; i--) {
    const tick = btcTickHistory[i];
    const age = now - tick.t;
    if (age <= 180_000) {
      if (tick.p > max180) max180 = tick.p;
      if (tick.p < min180) min180 = tick.p;
    }
    if (age <= 60_000) {
      if (tick.p > max60) max60 = tick.p;
      if (tick.p < min60) min60 = tick.p;
    }
  }

  // 1. Flash Dump tức thì:
  // - Rơi >= 0.65% trong 60 giây gần nhất từ đỉnh 60s
  // - Hoặc rơi >= 1.00% trong 180 giây gần nhất từ đỉnh 180s
  const drop60 = max60 > 0 ? ((price - max60) / max60) * 100 : 0;
  const drop180 = max180 > 0 ? ((price - max180) / max180) * 100 : 0;

  if (drop60 <= -BTC_FLASH_WS_60S_PCT || drop180 <= -BTC_FLASH_WS_180S_PCT) {
    const changePct = drop60 <= -BTC_FLASH_WS_60S_PCT ? drop60 : drop180;
    const windowSec = drop60 <= -BTC_FLASH_WS_60S_PCT ? 60 : 180;
    const peakPrice = windowSec === 60 ? max60 : max180;
    lastWsFlashTriggerTime = now;
    triggerBtcFlashDump(client, {
      reason: `BTC Vận Tốc Xả WebSocket 0ms (Rơi ${changePct.toFixed(2)}% trong ${windowSec}s: $${peakPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      source: 'WebSocket 0ms Realtime',
      movePct: Math.abs(changePct)
    });
    return;
  }

  // 2. Flash Pump tức thì:
  // - Tăng >= +0.65% trong 60 giây gần nhất từ đáy 60s
  // - Hoặc tăng >= +1.00% trong 180 giây gần nhất từ đáy 180s
  const pump60 = min60 < Infinity ? ((price - min60) / min60) * 100 : 0;
  const pump180 = min180 < Infinity ? ((price - min180) / min180) * 100 : 0;

  if (pump60 >= BTC_FLASH_WS_60S_PCT || pump180 >= BTC_FLASH_WS_180S_PCT) {
    const changePct = pump60 >= BTC_FLASH_WS_60S_PCT ? pump60 : pump180;
    const windowSec = pump60 >= BTC_FLASH_WS_60S_PCT ? 60 : 180;
    const troughPrice = windowSec === 60 ? min60 : min180;
    lastWsFlashTriggerTime = now;
    triggerBtcFlashPump(client, {
      reason: `BTC Vận Tốc Tăng WebSocket 0ms (Tăng +${changePct.toFixed(2)}% trong ${windowSec}s: $${troughPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      source: 'WebSocket 0ms Realtime',
      movePct: Math.abs(changePct)
    });
    return;
  }
}

// ── TẦNG 2 & 3: Quét nến M1 (Momentum 60s) & M15 (Macro Guard) ──────────────
async function updateBtcFlashGuard(client) {
  const now = Date.now();
  if (now - btcFlashState.lastCheckTime < 15_000) return; // Check mỗi 15s
  btcFlashState.lastCheckTime = now;

  try {
    // Lấy song song nến M1 (bắt xung lực nhanh 60s) và M15 (bắt sóng lớn vĩ mô)
    const [klines1m, klines15m] = await Promise.all([
      fetchBinanceKlines('BTC', '1m', null, 25).catch(() => null),
      fetchBinanceKlines('BTC', '15m', null, 21).catch(() => null)
    ]);

    // ── TẦNG 2: Kiểm tra Nến M1 Momentum (Mỗi nến chỉ trigger tối đa 1 lần) ──
    if (klines1m && klines1m.length >= 5) {
      let sumVol1m = 0;
      const count1m = Math.min(20, klines1m.length - 1);
      for (let i = klines1m.length - 1 - count1m; i < klines1m.length - 1; i++) {
        sumVol1m += klines1m[i].volume;
      }
      const ma20Vol1m = count1m > 0 ? (sumVol1m / count1m) : klines1m[klines1m.length - 1].volume;

      const lastClosed1m = klines1m[klines1m.length - 2];
      const isNewM1Candle = lastClosed1m?.openTime && lastClosed1m.openTime !== btcFlashState.lastTriggeredM1OpenTime;

      if (isNewM1Candle) {
        const volRatio1m = ma20Vol1m > 0 ? (lastClosed1m.volume / ma20Vol1m) : 1.0;
        const bodyPct1m = ((lastClosed1m.close - lastClosed1m.open) / lastClosed1m.open) * 100;

        // 1 nến M1 xả mạnh: Thân <= -0.55% kèm Vol >= 2.5x MA20 hoặc Vol >= 800 BTC
        if (bodyPct1m <= -BTC_FLASH_M1_BODY_PCT && (volRatio1m >= 2.5 || lastClosed1m.volume >= 800)) {
          btcFlashState.lastTriggeredM1OpenTime = lastClosed1m.openTime;
          await triggerBtcFlashDump(client, {
            reason: `BTC Nến M1 Xả Mạnh (Giảm ${bodyPct1m.toFixed(2)}% | Vol ${volRatio1m.toFixed(1)}x MA20 M1 [${lastClosed1m.volume.toFixed(0)} BTC])`,
            source: 'Nến M1 Closed',
            movePct: Math.abs(bodyPct1m)
          });
          return;
        }

        // 1 nến M1 bơm mạnh: Thân >= +0.55% kèm Vol >= 2.5x MA20 hoặc Vol >= 800 BTC
        if (bodyPct1m >= BTC_FLASH_M1_BODY_PCT && (volRatio1m >= 2.5 || lastClosed1m.volume >= 800)) {
          btcFlashState.lastTriggeredM1OpenTime = lastClosed1m.openTime;
          await triggerBtcFlashPump(client, {
            reason: `BTC Nến M1 Bơm Mạnh (Tăng +${bodyPct1m.toFixed(2)}% | Vol ${volRatio1m.toFixed(1)}x MA20 M1 [${lastClosed1m.volume.toFixed(0)} BTC])`,
            source: 'Nến M1 Closed',
            movePct: Math.abs(bodyPct1m)
          });
          return;
        }

        // 3 nến M1 liên tiếp trượt dài (Cascade >= ±0.85%)
        if (klines1m.length >= 4) {
          const c1 = klines1m[klines1m.length - 4];
          const c2 = klines1m[klines1m.length - 3];
          const c3 = klines1m[klines1m.length - 2];
          const isCascadeDump = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;
          const totalDrop3m = ((c3.close - c1.open) / c1.open) * 100;
          if (isCascadeDump && totalDrop3m <= -BTC_FLASH_M1_CASCADE_PCT) {
            btcFlashState.lastTriggeredM1OpenTime = c3.openTime;
            await triggerBtcFlashDump(client, {
              reason: `BTC Xả Dồn 3 Nến M1 Liên Tiếp (Tổng rơi ${totalDrop3m.toFixed(2)}% trong 3 phút)`,
              source: 'M1 Cascade',
              movePct: Math.abs(totalDrop3m)
            });
            return;
          }

          const isCascadePump = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
          const totalPump3m = ((c3.close - c1.open) / c1.open) * 100;
          if (isCascadePump && totalPump3m >= BTC_FLASH_M1_CASCADE_PCT) {
            btcFlashState.lastTriggeredM1OpenTime = c3.openTime;
            await triggerBtcFlashPump(client, {
              reason: `BTC Bơm Dồn 3 Nến M1 Liên Tiếp (Tổng tăng +${totalPump3m.toFixed(2)}% trong 3 phút)`,
              source: 'M1 Cascade',
              movePct: Math.abs(totalPump3m)
            });
            return;
          }
        }
      }
    }

    // ── TẦNG 3: Kiểm tra Nến M15 Macro Guard (Chống lặp nến cũ & Bỏ bẫy râu rút chân) ──
    if (!klines15m || klines15m.length < 2) return;

    let sumVol15m = 0;
    const count15m = Math.min(20, klines15m.length - 1);
    for (let i = klines15m.length - 1 - count15m; i < klines15m.length - 1; i++) {
      sumVol15m += klines15m[i].volume;
    }
    const ma20Vol15m = count15m > 0 ? (sumVol15m / count15m) : klines15m[klines15m.length - 1].volume;

    const lastClosed15m = klines15m[klines15m.length - 2];
    const currRunning15m = klines15m[klines15m.length - 1];

    const checkCandle15m = (c) => {
      const open = c.open;
      const close = c.close;
      const high = c.high;
      const low = c.low;
      const vol = c.volume;
      const volRatio = ma20Vol15m > 0 ? (vol / ma20Vol15m) : 1.0;
      const bodyPct = ((close - open) / open) * 100;
      const rangePct = ((high - low) / (low || 1)) * 100;

      // Bắt buộc THÂN NẾN phải giữ vững >= ±0.90% kèm Vol >= 2.2x MA20 (hoặc >= 8000 BTC).
      // Triệt tiêu báo động giả khi nến chỉ quét râu rồi rút chân hồi phục!
      const volQualifies = (volRatio >= BTC_FLASH_M15_VOL_RATIO || vol >= BTC_FLASH_M15_VOL_ABS);
      const isPump = volQualifies && bodyPct >= BTC_FLASH_M15_BODY_PCT;
      const isDump = volQualifies && bodyPct <= -BTC_FLASH_M15_BODY_PCT;

      return { isPump, isDump, volRatio, bodyPct, rangePct, vol, openTime: c.openTime || 0 };
    };

    // Chỉ xét lastClosed15m nếu vừa đóng trong vòng <= 3 phút (tránh lật lại bởi nến cũ 10-14p trước)
    const closedAgeMs = lastClosed15m?.openTime ? (now - (lastClosed15m.openTime + 15 * 60_000)) : Infinity;
    const canCheckClosed15m = closedAgeMs >= 0 && closedAgeMs <= 3 * 60_000 && lastClosed15m.openTime !== btcFlashState.lastTriggeredM15OpenTime;
    const canCheckRunning15m = currRunning15m?.openTime && currRunning15m.openTime !== btcFlashState.lastTriggeredM15OpenTime;

    const resRunning15m = canCheckRunning15m ? checkCandle15m(currRunning15m) : { isPump: false, isDump: false };
    const resClosed15m  = canCheckClosed15m  ? checkCandle15m(lastClosed15m)  : { isPump: false, isDump: false };

    const activePump15m = resRunning15m.isPump ? resRunning15m : (resClosed15m.isPump ? resClosed15m : null);
    const activeDump15m = resRunning15m.isDump ? resRunning15m : (resClosed15m.isDump ? resClosed15m : null);

    if (activePump15m) {
      btcFlashState.lastTriggeredM15OpenTime = activePump15m.openTime;
      await triggerBtcFlashPump(client, {
        reason: `BTC Flash Pump M15 (Vol ${activePump15m.volRatio.toFixed(1)}x MA20 [${activePump15m.vol.toFixed(0)} BTC] | Thân +${activePump15m.bodyPct.toFixed(2)}%)`,
        source: 'Nến M15',
        movePct: Math.abs(activePump15m.bodyPct)
      });
    } else if (activeDump15m) {
      btcFlashState.lastTriggeredM15OpenTime = activeDump15m.openTime;
      await triggerBtcFlashDump(client, {
        reason: `BTC Flash Dump M15 (Vol ${activeDump15m.volRatio.toFixed(1)}x MA20 [${activeDump15m.vol.toFixed(0)} BTC] | Thân ${activeDump15m.bodyPct.toFixed(2)}%)`,
        source: 'Nến M15',
        movePct: Math.abs(activeDump15m.bodyPct)
      });
    }
    // Kiểm tra mở khóa an toàn khi thị trường đã hạ nhiệt
    else if (btcFlashState.isShortLocked || btcFlashState.isLongLocked) {
      const timeRemaining = btcFlashState.lockedUntil - now;
      if (timeRemaining <= 5 * 60_000 || now >= btcFlashState.lockedUntil) {
        const lastVolRatio = ma20Vol15m > 0 ? (lastClosed15m.volume / ma20Vol15m) : 1.0;
        const lastRangePct = ((lastClosed15m.high - lastClosed15m.low) / (lastClosed15m.low || 1)) * 100;
        const isCooledDown = lastVolRatio < 1.3 && lastRangePct <= 0.45;

        if (isCooledDown || now >= btcFlashState.lockedUntil) {
          btcFlashState.isShortLocked = false;
          btcFlashState.isLongLocked = false;
          btcFlashState.lockedUntil = 0;
          btcFlashState.lockReason = '';
          btcFlashState.severity = 'NORMAL';

          log.system(`[AutoTrade] 🟢 [BTC Flash Guard] Thị trường BTC đã hạ nhiệt an toàn (Vol ${lastVolRatio.toFixed(1)}x, Range ${lastRangePct.toFixed(2)}%). Mở khóa giao dịch bình thường.`);
          sendTelegram(
            `🟢 <b>[BTC Flash Guard] THỊ TRƯỜNG ĐÃ HẠ NHIỆT AN TOÀN</b>\n` +
            `• Nến M15 BTC đã ổn định (Vol <b>${lastVolRatio.toFixed(1)}x</b>, Biên độ <b>${lastRangePct.toFixed(2)}%</b>)\n` +
            `• Tự động <b>MỞ KHÓA GIAO DỊCH ALTCOIN</b> bình thường trở lại!`
          ).catch(() => { });
        }
      }
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi kiểm tra BTC Flash Guard: ${err.message}`);
  }
}

// ─── TẬP HỢP DỮ LIỆU ĐA TẦNG CHO BỘ LỌC COIN 4 TẦNG (PHASE 2) ──────────────────

let _fundingRatesCache = null;
let _fundingRatesCacheTime = 0;

async function getBinanceFundingRates() {
  const now = Date.now();
  if (_fundingRatesCache && (now - _fundingRatesCacheTime < 60_000)) {
    return _fundingRatesCache;
  }
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 8000 });
    const rates = {};
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        if (!item.symbol || !item.symbol.endsWith('USDT')) continue;
        const sym = item.symbol.slice(0, -4);
        const rate = parseFloat(item.lastFundingRate);
        if (!isNaN(rate)) {
          rates[sym] = rate;
        }
      }
    }
    _fundingRatesCache = rates;
    _fundingRatesCacheTime = now;
    return rates;
  } catch (err) {
    return _fundingRatesCache || {};
  }
}

let _lastBtcTA = null;
let _lastBtcTATime = 0;

async function getBtcTA() {
  const now = Date.now();
  if (_lastBtcTA && (now - _lastBtcTATime < 3 * 60 * 1000)) {
    return _lastBtcTA;
  }
  try {
    const [k1h, k4h, k1d] = await Promise.all([
      fetchBinanceKlines('BTC', '1h', null, 100).catch(() => null),
      fetchBinanceKlines('BTC', '4h', null, 200).catch(() => null),
      fetchBinanceKlines('BTC', '1d', null, 220).catch(() => null),
    ]);
    if (k4h && k4h.length >= 20) {
      _lastBtcTA = calcTAFromKlines('BTC', k1h, k4h, k1d, null);
      _lastBtcTATime = now;
      return _lastBtcTA;
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi fetch BTC TA: ${err.message}`);
  }
  return _lastBtcTA;
}

const _symbolTACache = new Map();

async function getSymbolTA(sym) {
  const now = Date.now();
  const cached = _symbolTACache.get(sym);
  if (cached && (now - cached.time < 60_000)) {
    return cached.ta;
  }
  try {
    const [k1h, k4h, k1d] = await Promise.all([
      fetchBinanceKlines(sym, '1h', null, 100).catch(() => null),
      fetchBinanceKlines(sym, '4h', null, 200).catch(() => null),
      fetchBinanceKlines(sym, '1d', null, 220).catch(() => null),
    ]);
    if (k4h && k4h.length >= 20) {
      const ta = calcTAFromKlines(sym, k1h, k4h, k1d, null);
      if (_symbolTACache.size > 200) {
        const firstKey = _symbolTACache.keys().next().value;
        if (firstKey) _symbolTACache.delete(firstKey);
      }
      _symbolTACache.set(sym, { time: now, ta });
      return ta;
    }
  } catch (err) {
    log.warn(`[AutoTrade] Lỗi fetch TA cho ${sym}: ${err.message}`);
  }
  return null;
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
  } catch (_) { }
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
  } catch (_) { }
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
/**
 * Tính toán Target Loss & Tỷ lệ R:R Take Profit linh hoạt theo AI (Data-Driven Dynamic Risk & Adaptive R:R)
 * Phân tầng dựa trên xác suất thắng WinProb (từ Bayesian Model) kết hợp Confluence Score và MarketCap Rank:
 * - Hạng S (Super Sniper): WinProb >= 65% hoặc (Top 10 & WinProb >= 55%) hoặc (Top 50 & WinProb >= 60% & Score >= 6.5): TP 1:2.0
 * - Hạng A (High Quality): WinProb >= 58% hoặc (Top 50 & WinProb >= 53%) hoặc (Top 150 & WinProb >= 55% & Score >= 6.0): TP 1:1.75
/**
 * Tính toán Tỷ lệ TakeProfit động (TP Ratio) và Cấp độ Lệnh dựa trên 100% AI Win Probability:
 * - Hạng S (Super Sniper): WinProb >= 65% hoặc (Top 10 & WinProb >= 55%) hoặc (Top 50 & WinProb >= 60%): TP 1:2.00
 * - Hạng A (High Quality): WinProb >= 58% hoặc (Top 50 & WinProb >= 53%) hoặc (Top 150 & WinProb >= 55%): TP 1:1.75
/**
 * Phân tầng rủi ro & tỷ lệ TP/SL động theo mô hình học máy AI (Adaptive Risk & Dynamic TP/SL Profile):
 * - Không hardcode các mốc 65/58/52 hay tỷ lệ 2.0/1.75/1.5 thủ công
 * - Tự động đọc ngưỡng duyệt tối ưu (optTh) và tỷ lệ chốt lời MFE (optimalTpGridRatio) từ AI
 * - Phân hạng thích ứng theo khoảng cách xác suất vượt trội so với ngưỡng tối ưu của AI
 *
 * @param {number} rank - MarketCap rank
 * @param {number} winProb - Xác suất thắng Bayesian do AI Reviewer chấm (5% - 95%)
 * @param {number|null} [score=null]
 * @param {number} [baseLossUSD=7.5]
 */
function getDynamicRiskProfile(rank, winProb, score = null, baseLossUSD = 7.5) {
  const modelCfg = typeof getAIModelConfig === 'function' ? getAIModelConfig() : null;
  const optTh = modelCfg?.optimalThresholds?.uniform || modelCfg?.thresholdApprovalPct || 48.0;
  const mfeMae = modelCfg?.mfeMaeProfile;
  const optimalTpGridRatio = typeof mfeMae?.optimalTpGridRatio === 'number' ? mfeMae.optimalTpGridRatio : 0.50;

  const wp = typeof winProb === 'number' && !isNaN(winProb) ? winProb : optTh;
  const rk = typeof rank === 'number' && !isNaN(rank) ? rank : 999;

  let multiplier = 1.0;
  // Tỷ lệ TP R:R cơ sở chuẩn hóa theo tỷ lệ nảy MFE học được từ dữ liệu lịch sử
  const baseRr = Math.max(1.35, Number((optimalTpGridRatio * 3.0).toFixed(2)));
  let tpRatio = baseRr;
  let grade = 'B (Solid Quality)';

  // Phân hạng động theo mức độ vượt trội của tín hiệu so với ngưỡng chuẩn AI:
  if (wp >= optTh + 5.0 || (rk <= 10 && wp >= optTh + 2.0)) {
    tpRatio = Math.max(baseRr, 2.0);
    grade = 'S (Super Sniper)';
  } else if (wp >= optTh + 2.0 || (rk <= 50 && wp >= optTh + 1.0)) {
    tpRatio = Math.max(baseRr, 1.75);
    grade = 'A (High Quality)';
  } else if (wp >= optTh) {
    tpRatio = Math.max(baseRr, 1.50);
    grade = 'B (Solid Quality)';
  } else {
    tpRatio = baseRr;
    grade = 'C (Standard)';
  }

  return {
    targetLossUSD: Number((baseLossUSD * multiplier).toFixed(2)),
    tpRatio: Number(tpRatio.toFixed(2)),
    multiplier: multiplier,
    grade: grade
  };
}

/**
 * Backward compatibility alias
 */
function getDynamicTargetLossUSD(rank, winProb, score, baseLossUSD = 5.0) {
  return getDynamicRiskProfile(rank, winProb, score, baseLossUSD).targetLossUSD;
}

/**
 * Làm tròn giá SL bảo thủ theo chuẩn Binance:
 * - Long: Làm tròn xuống (Math.floor) để SL lùi sâu hơn về phía an toàn
 * - Short: Làm tròn lên (Math.ceil) để SL lùi cao hơn về phía an toàn
 */
function roundSlConservative(slPrice, tickSize, isLong) {
  if (!tickSize || tickSize <= 0 || isNaN(tickSize)) return slPrice;
  const inv = 1 / tickSize;
  const rounded = isLong
    ? Math.floor(slPrice * inv + 1e-9) / inv
    : Math.ceil(slPrice * inv - 1e-9) / inv;
  return Number(rounded.toFixed(8));
}

/**
 * Làm tròn giá TP bảo thủ theo chuẩn Binance:
 * - Long: Làm tròn xuống (Math.floor) để dễ chạm TP hơn
 * - Short: Làm tròn lên (Math.ceil) để dễ chạm TP hơn
 */
function roundTpConservative(tpPrice, tickSize, isLong) {
  if (!tickSize || tickSize <= 0 || isNaN(tickSize)) return tpPrice;
  const inv = 1 / tickSize;
  const rounded = isLong
    ? Math.floor(tpPrice * inv + 1e-9) / inv
    : Math.ceil(tpPrice * inv - 1e-9) / inv;
  return Number(rounded.toFixed(8));
}

/**
 * Cải tiến Né Nam Châm Số Tròn Tâm Lý (Psychological Round Number Evasion):
 * Nếu mức SL tính ra rơi vào phạm vi +/- 0.15% của mốc số tròn lớn,
 * tự động dịch lùi thêm 0.25% để thoát hẳn vùng quét râu của tạo lập.
 */
function evadeRoundNumber(price, isLong) {
  if (!price || price <= 0 || isNaN(price)) return price;
  const mag = Math.pow(10, Math.floor(Math.log10(price)));
  let stepR;
  if (price >= 1000) stepR = 500;
  else if (price >= 100) stepR = 50;
  else if (price >= 10) stepR = 5;
  else if (price >= 1) stepR = 0.5;
  else if (price >= 0.1) stepR = 0.05;
  else stepR = mag;

  const nearestRound = Math.round(price / stepR) * stepR;
  const diffPct = Math.abs(price - nearestRound) / price;
  if (diffPct <= 0.0015) {
    return isLong ? price * (1 - 0.0025) : price * (1 + 0.0025);
  }
  return price;
}

/**
 * Né Số Tròn Tâm Lý cho TP (Front-running Psychological Round Numbers):
 * Kéo TP lùi nhẹ (-0.15%) ngay trước mốc số tròn lớn để khớp sớm trước tường xả/hút, miễn R:R vẫn >= 1.48.
 */
function evadeTpRoundNumber(tpPrice, entryPrice, slDist, isLong) {
  if (!tpPrice || tpPrice <= 0 || !entryPrice || !slDist || slDist <= 0 || isNaN(tpPrice)) return tpPrice;
  const mag = Math.pow(10, Math.floor(Math.log10(tpPrice)));
  let stepR;
  if (tpPrice >= 1000) stepR = 500;
  else if (tpPrice >= 100) stepR = 50;
  else if (tpPrice >= 10) stepR = 5;
  else if (tpPrice >= 1) stepR = 0.5;
  else if (tpPrice >= 0.1) stepR = 0.05;
  else stepR = mag;

  const nearestRound = Math.round(tpPrice / stepR) * stepR;
  if (nearestRound <= 0) return tpPrice;

  let candidate = null;
  if (isLong) {
    const rel = (tpPrice - nearestRound) / nearestRound;
    if (rel >= -0.0005 && rel <= 0.0030) {
      candidate = nearestRound * (1 - 0.0015);
    }
  } else {
    const rel = (nearestRound - tpPrice) / nearestRound;
    if (rel >= -0.0005 && rel <= 0.0030) {
      candidate = nearestRound * (1 + 0.0015);
    }
  }

  if (candidate != null) {
    const newDist = isLong ? (candidate - entryPrice) : (entryPrice - candidate);
    if (newDist > 0 && (newDist / slDist) >= 1.48) {
      return candidate;
    }
  }
  return tpPrice;
}

/**
 * Thuật toán Xác Định Stop Loss Thích Ứng & 5 Cải Tiến Chống Tử Huyệt (Giai đoạn 1):
 * - Kịch bản 1 (Sweet Spot): Tìm Đáy/Đỉnh Swing H1/H4 trong [1.2*ATR, 2.0*ATR] (<= 3.5%) -> SL ẩn sau cản + 0.2% đệm.
 * - Kịch bản 2 (Đỉnh/Đáy quá xa): > 2.0*ATR hoặc > 3.5% -> Clamp về 1.5*ATR (max 3.0% - 3.5%).
 * - Kịch bản 3 (Không có Đáy/Đỉnh cũ): 1.5*ATR (sàn tối thiểu 1.3% Top 50, 1.8% Altcoin).
 * - 5 Cải tiến chống tử huyệt:
 *   1. Bảo vệ Giá Cháy: Liq Dist >= 1.5 * slDist, tự động hạ đòn bẩy nếu vi phạm.
 *   2. Chống Trượt Giá Sổ Lệnh: Ký quỹ cứng $20 USDT (Top 50), $10 USDT (Ngoài Top 50).
 *   3. Khóa Cứng Khung Thời Gian Cấu Trúc: Chỉ dùng H1 (3-5 ngày) & H4 (2 tuần).
 *   4. Né Nam Châm Số Tròn Tâm Lý.
 *   5. Làm Tròn Bảo Thủ Theo TickSize Binance.
 * - Chốt chặn R:R >= 1.5: Đo khoảng cách TP / SL, nếu < 1.48 => VETO HỦY KÈO.
 * - Mốc Breakeven 35%: Khi giá đi được 35% tới TP, dời SL về Entry +- 1% phí (Risk-Free).
 */
async function getDynamicMargin(isTier1, clientInstance = null) {
  const tier1Pct = parseFloat(process.env.TRADE_SIZE_PCT_TIER1 || process.env.TRADE_SIZE_PCT || '0');
  const tier2Pct = parseFloat(process.env.TRADE_SIZE_PCT_TIER2 || (tier1Pct > 0 ? tier1Pct : '0'));
  const effPct = isTier1 ? tier1Pct : tier2Pct;

  const tier1Fallback = parseFloat(process.env.TRADE_AMOUNT_TIER1 || process.env.TRADE_AMOUNT || '20');
  const tier2Fallback = parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10');
  const fallbackMargin = isTier1 ? tier1Fallback : tier2Fallback;

  if (effPct <= 0) {
    return fallbackMargin;
  }

  try {
    const cl = clientInstance || (typeof client !== 'undefined' ? client : null);
    let navBalance = 0;
    let availBalance = 0;
    if (cl && typeof cl.getWalletBalance === 'function') {
      navBalance = await cl.getWalletBalance();
      availBalance = typeof cl.getBalance === 'function' ? await cl.getBalance() : navBalance;
    } else if (cl && typeof cl.getBalance === 'function') {
      navBalance = await cl.getBalance();
      availBalance = navBalance;
    }
    if (navBalance && navBalance > 0) {
      const minMargin = parseFloat(process.env.TRADE_MIN_USDT || '5.0');
      const maxMargin = parseFloat(process.env.TRADE_MAX_USDT || (isTier1 ? '100.0' : '50.0'));
      const calcMargin = (navBalance * effPct) / 100.0;
      const clamped = Math.min(Math.max(calcMargin, minMargin), maxMargin);
      // Chặn an toàn không vượt quá 95% số dư khả dụng còn lại trên sàn
      const safeMargin = availBalance > 0 ? Math.min(clamped, availBalance * 0.95) : clamped;
      return parseFloat(safeMargin.toFixed(2));
    }
  } catch (_) { }

  return fallbackMargin;
}

const SR_EPOCH_MS_THRESHOLD = 1_000_000_000_000;
const SR_D1_FRESH_MAX_AGE_MS = 60 * 24 * 3600 * 1000; // Cản D1 1 chạm chỉ là Cản Cứng nếu <= 60 ngày gần nhất (hoặc cực trị 90d)

function countDistinctTouches(points, minSepMs) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const timed = points.filter(p => typeof p.time === 'number' && p.time >= SR_EPOCH_MS_THRESHOLD);
  if (timed.length === 0) {
    const keys = new Set(points.map((p, i) => (p.idx != null ? `${p.timeframe || ''}_${p.idx}` : `${p.timeframe || ''}_${p.price}_${i}`)));
    return keys.size;
  }
  const sorted = [...timed].sort((a, b) => a.time - b.time);
  let count = 1;
  let lastT = sorted[0].time;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - lastT >= minSepMs) {
      count++;
      lastT = sorted[i].time;
    }
  }
  return count;
}

function countZoneCrossings(zoneMin, zoneMax, formationTime, h4Candles) {
  if (!Array.isArray(h4Candles) || h4Candles.length < 4) return 0;
  const recent = h4Candles.slice(-180); // ~30 ngày H4
  const lowerBound = zoneMin * 0.9985;
  const upperBound = zoneMax * 1.0015;
  let crossings = 0;
  let lastSide = 0;

  for (const c of recent) {
    if (formationTime >= SR_EPOCH_MS_THRESHOLD && typeof c.openTime === 'number' && c.openTime >= SR_EPOCH_MS_THRESHOLD) {
      if (c.openTime <= formationTime) continue;
    }
    const close = c.close;
    if (close > upperBound) {
      if (lastSide === -1) crossings++;
      lastSide = 1;
    } else if (close < lowerBound) {
      if (lastSide === 1) crossings++;
      lastSide = -1;
    }
  }
  return crossings;
}

/**
 * Nhóm các swing points vào các Cluster Zones [zoneMin, zoneMax]
 * - Chống Cluster Chaining: so với tâm cụm (zoneMid) VÀ giới hạn độ rộng tối đa của cụm.
 * - Đếm số lần chạm độc lập theo thời gian, kiểm tra độ tươi D1 và lọc cản chết đã bị xuyên phá >= 3 lần.
 */
function buildClusterZones(points, toleranceRatio = 0.005, opts = {}) {
  if (!points || !Array.isArray(points) || points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let currentGroup = [sorted[0]];
  let groupSum = sorted[0].price;

  for (let i = 1; i < sorted.length; i++) {
    const pt = sorted[i];
    const groupMin = currentGroup[0].price;
    const groupMid = groupSum / currentGroup.length;

    const tol = Math.max(groupMid * toleranceRatio, groupMid * 0.002);
    const maxZoneWidth = groupMin * Math.max(0.008, toleranceRatio * 2.5);

    if (Math.abs(pt.price - groupMid) <= tol && (pt.price - groupMin) <= maxZoneWidth) {
      currentGroup.push(pt);
      groupSum += pt.price;
    } else {
      clusters.push(summarizeClusterZone(currentGroup, opts));
      currentGroup = [pt];
      groupSum = pt.price;
    }
  }
  if (currentGroup.length > 0) {
    clusters.push(summarizeClusterZone(currentGroup, opts));
  }

  return clusters;
}

function summarizeClusterZone(group, opts = {}) {
  const prices = group.map(p => p.price);
  const zoneMin = Math.min(...prices);
  const zoneMax = Math.max(...prices);
  const zoneMid = prices.reduce((sum, p) => sum + p, 0) / prices.length;

  const d1Points = group.filter(p => p.timeframe === 'D1');
  const h4Points = group.filter(p => p.timeframe === 'H4');
  const h1Points = group.filter(p => p.timeframe === 'H1');

  const distinctD1 = countDistinctTouches(d1Points, 72 * 3600_000);
  const distinctH4 = countDistinctTouches(h4Points, 24 * 3600_000);
  const distinctH1 = countDistinctTouches(h1Points, 12 * 3600_000);
  const distinctAll = countDistinctTouches(group, 12 * 3600_000);

  const refNowMs = opts.referenceNowMs || Date.now();
  const hasFreshD1 = d1Points.some(p => {
    if (p.isExtreme90d) return true;
    if (!p.time || p.time < SR_EPOCH_MS_THRESHOLD) return true;
    return (refNowMs - p.time) <= SR_D1_FRESH_MAX_AGE_MS;
  });

  const validTimes = group.map(p => p.time).filter(t => typeof t === 'number' && t >= SR_EPOCH_MS_THRESHOLD);
  const formationTime = validTimes.length > 0 ? Math.min(...validTimes) : 0;
  const crossings = opts.h4Candles ? countZoneCrossings(zoneMin, zoneMax, formationTime, opts.h4Candles) : 0;
  const isBroken = crossings >= 3;

  const highestTf = d1Points.length > 0 ? 'D1' : (h4Points.length > 0 ? 'H4' : 'H1');
  const rawMajor = (distinctD1 >= 2) || hasFreshD1 || (distinctH4 >= 2) || (distinctH1 >= 3);
  const isMajor = !isBroken && rawMajor;

  const highCount = group.filter(p => p.type === 'HIGH').length;
  const lowCount  = group.filter(p => p.type === 'LOW').length;

  return {
    zoneMin,
    zoneMax,
    zoneMid,
    touches: distinctAll,
    distinctD1Touches: distinctD1,
    distinctH4Touches: distinctH4,
    distinctH1Touches: distinctH1,
    timeframe: highestTf,
    isMajor,
    isBroken,
    crossings,
    dominantType: highCount >= lowCount ? 'HIGH' : 'LOW',
    points: group
  };
}

async function calculateTierSLTP(
  symbol,
  side,
  entryPrice,
  h4Ref,
  tickSize,
  maxExchangeLeverage,
  targetLossUSD = 3.0,
  tpRatio = 1.5,
  rank = null,
  gridWidthPct = null,
  customKlines = null,
  customMargin = null
) {
  const isLong = (side === 'LONG' || side === 'BUY');
  const coinRank = (typeof rank === 'number' && !isNaN(rank)) ? rank : (getMarketCapRank ? getMarketCapRank(symbol) : 999);
  const isTier1 = (symbol === 'BTC' || symbol === 'ETH' || coinRank <= 50);

  // Ký quỹ chuẩn hóa: Ưu tiên customMargin (tính động theo % balance nếu có)
  const tier1Margin = parseFloat(process.env.TRADE_AMOUNT_TIER1 || process.env.TRADE_AMOUNT || '20');
  const tier2Margin = parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10');
  const standardMargin = (typeof customMargin === 'number' && customMargin > 0)
    ? customMargin
    : (isTier1 ? tier1Margin : tier2Margin);

  const baseMinSlPct = isTier1 ? 1.3 : 1.8;
  const decimals = h4Ref?.decimals || getDecimals(entryPrice);
  const defaultTickSize = Math.pow(10, -decimals);
  const effTickSize = (typeof tickSize === 'number' && tickSize > 0) ? tickSize : defaultTickSize;

  // 1. Tải nến lịch sử H1, H4 và D1 (Đã có RAM cache bảo vệ trong core.js)
  let h1Candles = [];
  let h4Candles = [];
  let d1Candles = [];
  try {
    if (customKlines && customKlines.h1 && customKlines.h4) {
      h1Candles = customKlines.h1;
      h4Candles = customKlines.h4;
      d1Candles = customKlines.d1 || [];
    } else {
      const [resH1, resH4, resD1] = await Promise.all([
        fetchH1Historical(symbol).catch(() => []),
        fetchH4Historical(symbol).catch(() => []),
        fetchD1Historical(symbol).catch(() => [])
      ]);
      h1Candles = resH1 || [];
      h4Candles = resH4 || [];
      d1Candles = resD1 || [];
    }
  } catch (err) {
    // Fallback silent
  }

  // 2. Tính ATR(14, 4h) hoặc ATR(14, 1h)
  let atrVal = null;
  if (h4Candles && h4Candles.length >= 15) {
    atrVal = calculateATR(h4Candles, 14);
  }
  if (!atrVal && h1Candles && h1Candles.length >= 15) {
    const atrH1 = calculateATR(h1Candles, 14);
    if (atrH1) atrVal = atrH1 * 2.0; // Ước lượng 4h từ 1h
  }
  if (!atrVal || atrVal <= 0) {
    atrVal = entryPrice * 0.02; // Mặc định 2.0%
  }
  const atrPct = (atrVal / entryPrice) * 100;

  // 3. Quét cấu trúc Swing S/R hợp nhất trên H1 (300), H4 (150), D1 (180)
  // Hỗ trợ S/R Flip (Hỗ trợ <-> Kháng cự), chống đếm trùng đa khung & lọc cản chết
  const allSwingPoints = [];

  if (h1Candles && h1Candles.length >= 7) {
    const swH1 = findSwingPoints(h1Candles.slice(-300), 3, 3);
    for (const pt of (swH1.lowPoints || []))  allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H1', type: 'LOW' });
    for (const pt of (swH1.highPoints || [])) allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H1', type: 'HIGH' });
  }

  if (h4Candles && h4Candles.length >= 5) {
    const swH4 = findSwingPoints(h4Candles.slice(-150), 2, 2);
    for (const pt of (swH4.lowPoints || []))  allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H4', type: 'LOW' });
    for (const pt of (swH4.highPoints || [])) allSwingPoints.push({ price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'H4', type: 'HIGH' });
  }

  if (d1Candles && d1Candles.length >= 5) {
    const d1Slice = d1Candles.slice(-180);
    const d1Recent90 = d1Slice.slice(-90);
    const max90d = d1Recent90.length ? Math.max(...d1Recent90.map(c => c.high)) : null;
    const min90d = d1Recent90.length ? Math.min(...d1Recent90.map(c => c.low)) : null;
    const swD1 = findSwingPoints(d1Slice, 2, 2);
    for (const pt of (swD1.lowPoints || [])) {
      allSwingPoints.push({
        price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'D1', type: 'LOW',
        isExtreme90d: min90d != null && Math.abs(pt.price - min90d) <= min90d * 0.002
      });
    }
    for (const pt of (swD1.highPoints || [])) {
      allSwingPoints.push({
        price: pt.price, time: pt.time, idx: pt.idx, timeframe: 'D1', type: 'HIGH',
        isExtreme90d: max90d != null && Math.abs(pt.price - max90d) <= max90d * 0.002
      });
    }
  }

  const latestCandleTs = Math.max(
    h1Candles.length ? (h1Candles[h1Candles.length - 1].openTime || 0) : 0,
    h4Candles.length ? (h4Candles[h4Candles.length - 1].openTime || 0) : 0,
    d1Candles.length ? (d1Candles[d1Candles.length - 1].openTime || 0) : 0
  );
  const referenceNowMs = latestCandleTs >= SR_EPOCH_MS_THRESHOLD ? latestCandleTs : Date.now();

  // Nhóm các điểm xoay thành các Vùng Cản Cụm (Cluster Zones)
  const tolRatio = atrVal > 0 ? Math.max(0.003, (atrVal / entryPrice) * 0.20) : 0.005;
  const unifiedClusters = buildClusterZones(allSwingPoints, tolRatio, { h4Candles, referenceNowMs });

  // S/R Flip: Cụm dưới Entry là Support (kể cả đỉnh cũ bị phá); cụm trên Entry là Resistance (kể cả đáy cũ bị phá)
  const supportClusters = unifiedClusters
    .filter(c => c.zoneMax < entryPrice * 0.999)
    .map(c => ({ ...c, isRoleFlipped: c.dominantType === 'HIGH' }))
    .sort((a, b) => b.zoneMax - a.zoneMax);

  const resistanceClusters = unifiedClusters
    .filter(c => c.zoneMin > entryPrice * 1.001)
    .map(c => ({ ...c, isRoleFlipped: c.dominantType === 'LOW' }))
    .sort((a, b) => a.zoneMin - b.zoneMin);

  const protectiveClusters = isLong ? supportClusters : resistanceClusters;

  // 4. MÔ HÌNH HYBRID SL 3 TẦNG THÔNG MINH (Thích ứng ATR đồng bộ bot-new, lọc Cản Chết & ưu tiên Cản Cứng)
  let rawSL = null;
  let slScenario = 'PURE_VOLATILITY_ATR';
  let matchedSwing = null;

  // Sàn & Trần thích ứng ATR:
  // - Sàn: max(baseMin, min(3.5%, 1.5 * ATR)) và >= 1.2 * ATR
  // - Trần: max(3.5%, min(6.0%, 3.0 * ATR))
  const minSlPct = Math.max(baseMinSlPct, Math.min(3.5, 1.5 * atrPct));
  const adaptiveMaxSlPct = Math.max(3.5, Math.min(6.0, 3.0 * atrPct));

  const minSafeDistPct = Math.max(minSlPct, 1.2 * atrPct);
  const maxSafeDistPct = Math.min(adaptiveMaxSlPct, Math.max(3.5, 2.0 * atrPct));

  // Buffer sau cản thích ứng theo ATR: 0.20% (BTC/coin đầm) -> tối đa 0.50% (Altcoin biến động mạnh)
  const slBufferPct = Math.min(0.005, Math.max(0.002, (atrPct / 100) * 0.15));
  const slBuffer = entryPrice * slBufferPct;

  // Lọc bỏ hoàn toàn "Cản Chết" (isBroken === true) khỏi ứng viên đặt SL
  const validProtectiveClusters = protectiveClusters.filter(c => !c.isBroken);

  const pickProtectiveCluster = (pool, minPct, maxPct) => {
    // Pass 1: Ưu tiên Cản Cứng (isMajor) trước để chống quét râu H1 yếu
    for (const c of pool) {
      if (!c.isMajor) continue;
      const distPct = isLong
        ? ((entryPrice - c.zoneMin) / entryPrice) * 100
        : ((c.zoneMax - entryPrice) / entryPrice) * 100;
      if (distPct >= minPct && distPct <= maxPct) return c;
    }
    // Pass 2: Fallback sang cản thường còn hiệu lực (!isBroken)
    for (const c of pool) {
      if (c.isMajor) continue;
      const distPct = isLong
        ? ((entryPrice - c.zoneMin) / entryPrice) * 100
        : ((c.zoneMax - entryPrice) / entryPrice) * 100;
      if (distPct >= minPct && distPct <= maxPct) return c;
    }
    return null;
  };

  // ─── TẦNG 1: CẢN SWEET SPOT H1 / H4 GẦN ───────────────────────────
  const h1h4ProtectiveClusters = validProtectiveClusters.filter(c => c.timeframe === 'H1' || c.timeframe === 'H4');
  const tier1Cluster = pickProtectiveCluster(h1h4ProtectiveClusters, minSafeDistPct, maxSafeDistPct);
  if (tier1Cluster) {
    matchedSwing = isLong ? tier1Cluster.zoneMin : tier1Cluster.zoneMax;
    rawSL = isLong ? (tier1Cluster.zoneMin - slBuffer) : (tier1Cluster.zoneMax + slBuffer);
    slScenario = 'SWEET_SPOT_SWING';
  }

  // ─── TẦNG 2: CẢN D1 TẦM TRUNG (LỊCH SỬ 6 THÁNG) ────────────────────
  if (!rawSL) {
    const d1ProtectiveClusters = validProtectiveClusters.filter(c => c.timeframe === 'D1');
    const maxD1DistPct = Math.min(adaptiveMaxSlPct, Math.max(4.0, 2.2 * atrPct));
    const tier2Cluster = pickProtectiveCluster(d1ProtectiveClusters, minSafeDistPct, maxD1DistPct);
    if (tier2Cluster) {
      matchedSwing = isLong ? tier2Cluster.zoneMin : tier2Cluster.zoneMax;
      rawSL = isLong ? (tier2Cluster.zoneMin - slBuffer) : (tier2Cluster.zoneMax + slBuffer);
      slScenario = 'TIER2_D1_SWING';
    }
  }

  // ─── TẦNG 3: CẢN ĐỘNG FIBONACCI (GIẢI PHÁP ĐỈNH/ĐÁY Ở XA HOẶC DÒ ATH/ATL) ──
  const recentH1 = (h1Candles && h1Candles.length >= 12) ? h1Candles.slice(-24) : [];
  if (!rawSL) {
    // 3A: Fibonacci Retracement trên sóng đẩy H1 gần nhất (24 nến H1 ≈ 1 ngày)
    if (recentH1.length >= 12) {
      const high24 = Math.max(...recentH1.map(c => c.high));
      const low24 = Math.min(...recentH1.map(c => c.low));
      const waveDelta = high24 - low24;
      const wavePct = (waveDelta / entryPrice) * 100;

      // Sóng có biên độ tối thiểu (>= 1.5% và >= 1.2x ATR)
      if (waveDelta > 0 && wavePct >= 1.5 && wavePct >= 1.2 * atrPct) {
        if (!isLong) {
          // SHORT: SL nép sau Fib 0.786 + adaptive slBuffer
          const fib786 = low24 + 0.786 * waveDelta;
          const candidateSL = fib786 + slBuffer;
          const fibDistPct = ((candidateSL - entryPrice) / entryPrice) * 100;
          if (fibDistPct >= minSafeDistPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        } else {
          // LONG: SL nép sau Fib 0.786 - adaptive slBuffer
          const fib786 = high24 - 0.786 * waveDelta;
          const candidateSL = fib786 - slBuffer;
          const fibDistPct = ((entryPrice - candidateSL) / entryPrice) * 100;
          if (fibDistPct >= minSafeDistPct && fibDistPct <= adaptiveMaxSlPct) {
            rawSL = candidateSL;
            matchedSwing = fib786;
            slScenario = 'TIER3A_FIBONACCI_0786';
          }
        }
      }
    }

    // 3B: Fallback Fibonacci Golden ATR (1.618x ATR) nếu sóng phẳng hoặc Fib không thỏa điều kiện
    if (!rawSL) {
      const goldenDistPct = Math.min(Math.max(1.618 * atrPct, minSafeDistPct), Math.min(adaptiveMaxSlPct, 3.5));
      rawSL = isLong
        ? (entryPrice * (1 - goldenDistPct / 100.0))
        : (entryPrice * (1 + goldenDistPct / 100.0));
      slScenario = validProtectiveClusters.length > 0 ? 'CLAMP_FAR_SWING' : 'PURE_VOLATILITY_ATR';
    }
  }

  // Khống chế sàn tối thiểu & trần thích ứng theo ATR (minSafeDistPct .. adaptiveMaxSlPct [3.5% - 6.0%])
  const floorPct = Math.min(minSafeDistPct, adaptiveMaxSlPct);
  const maxCeilingPct = adaptiveMaxSlPct;
  let slDist = Math.abs(entryPrice - rawSL);
  if (slDist < entryPrice * (floorPct / 100.0)) {
    slDist = entryPrice * (floorPct / 100.0);
    rawSL = isLong ? (entryPrice - slDist) : (entryPrice + slDist);
  } else if (slDist > entryPrice * (maxCeilingPct / 100.0)) {
    slDist = entryPrice * (maxCeilingPct / 100.0);
    rawSL = isLong ? (entryPrice - slDist) : (entryPrice + slDist);
  }

  // Cải tiến 4: Né Nam Châm Số Tròn Tâm Lý
  rawSL = evadeRoundNumber(rawSL, isLong);
  slDist = Math.abs(entryPrice - rawSL);

  // Cải tiến 5: Làm Tròn Bảo Thủ Theo TickSize Binance
  const finalSlPrice = roundSlConservative(rawSL, effTickSize, isLong);
  slDist = Math.abs(entryPrice - finalSlPrice);
  const finalSlPct = (slDist / entryPrice) * 100;

  // Cải tiến 1: Bảo Vệ Giá Cháy (Liquidation Front-Running Guard) & Trần Đòn Bẩy
  const mmr = 0.01;
  const maxSafeLevForLiq = 1.0 / (1.5 * (finalSlPct / 100.0) + mmr);

  // Bậc thang ATR chuẩn hóa
  let rawLevAtr;
  if (!atrPct || atrPct <= 0) rawLevAtr = 3;
  else if (atrPct < 0.8) rawLevAtr = 10;
  else if (atrPct < 1.5) rawLevAtr = 7;
  else if (atrPct < 2.5) rawLevAtr = 5;
  else if (atrPct < 4.0) rawLevAtr = 3;
  else rawLevAtr = 2;

  const hardCeilingLev = (symbol === 'BTC' || symbol === 'ETH')
    ? 10
    : (isTier1 ? 7 : 3);

  // Chuẩn hóa rủi ro vốn: khi SL rộng (Tier 2 tới 4.0%), giảm đòn bẩy để bảo vệ TargetLossUSD
  const maxRiskLev = (standardMargin > 0 && finalSlPct > 0)
    ? Math.floor((targetLossUSD * 1.25) / (standardMargin * (finalSlPct / 100.0)))
    : hardCeilingLev;

  let effectiveLeverage = Math.min(
    rawLevAtr,
    Math.floor(maxSafeLevForLiq),
    hardCeilingLev,
    Math.max(1, maxRiskLev),
    maxExchangeLeverage || 20
  );
  effectiveLeverage = Math.max(1, Math.floor(effectiveLeverage));

  // 5. TÍNH TOÁN TP THÔNG MINH (S/R & 369 GRID ANCHORED TP VỚI FRONT-RUNNING)
  const step = h4Ref?.step || getStep(entryPrice);
  const effGridWidth = (typeof gridWidthPct === 'number' && gridWidthPct > 0)
    ? gridWidthPct
    : (((step * 10) / entryPrice) * 100);

  const targetTpRatio = (typeof tpRatio === 'number' && tpRatio > 0) ? tpRatio : 1.50;
  const minRequiredTpDist = slDist * 1.48; // Sàn tối thiểu tuyệt đối để R:R >= 1.48
  const idealTpDist = slDist * targetTpRatio; // Mốc lý tưởng 1.5R

  // 5.1. Quét tìm các Cản Đối Diện (Opposing Clusters)
  // LONG: Cản là Resistance nằm phía trên Entry
  // SHORT: Cản là Support nằm phía dưới Entry
  const opposingClusters = isLong
    ? resistanceClusters.filter(c => c.zoneMin > entryPrice * 1.001).sort((a, b) => a.zoneMin - b.zoneMin)
    : supportClusters.filter(c => c.zoneMax < entryPrice * 0.999).sort((a, b) => b.zoneMax - a.zoneMax);

  // 5.2. Kiểm tra BỨC TƯỜNG CẢN CỨNG CHẶN ĐẦU (Hard Major Wall Blocking Check)
  // Chỉ bấm VETO khi một Cản Cứng thực sự (Major S/R: D1 hoặc H4 touches >= 2) nằm chắn đường
  // khiến giá không thể đạt được R:R >= 1.48 (vị trí bức tường nằm trước khoảng cách tối thiểu)!
  // Nếu là cản yếu (Minor S/R: 1x H1 wick): KÍCH HOẠT WEAK S/R BYPASS (Bỏ qua cản yếu để không reject oan uổng)
  for (const c of opposingClusters) {
    const rawDistToWall = isLong ? (c.zoneMin - entryPrice) : (entryPrice - c.zoneMax);

    if (rawDistToWall < minRequiredTpDist) {
      if (c.isMajor) {
        // Bức tường cản cứng chặn đầu -> VETO chính xác vì giá không thể vượt qua cản cứng này để đạt 1.48R
        const frontRunPrice = isLong ? (c.zoneMin - entryPrice * 0.002) : (c.zoneMax + entryPrice * 0.002);
        const distToWall = Math.max(0, Math.abs(entryPrice - frontRunPrice));
        const blockedRR = distToWall / slDist;
        const finalTpPriceFail = roundTpConservative(frontRunPrice, effTickSize, isLong);
        const flipTag = c.isRoleFlipped ? ' S/R-Flip' : '';
        return {
          valid: false,
          reason: `RR_BLOCKED_BY_MAJOR_SR (Cản cứng ${c.timeframe}${flipTag} [${c.zoneMin.toFixed(decimals)}-${c.zoneMax.toFixed(decimals)}] (${c.touches} chạm) chặn tại R:R = ${blockedRR.toFixed(2)} < 1.48)`,
          rrRatio: parseFloat(blockedRR.toFixed(2)),
          slPrice: finalSlPrice,
          tpPrice: finalTpPriceFail,
          slDistance: slDist,
          tpDistance: distToWall,
          slPct: parseFloat(finalSlPct.toFixed(2)),
          tpPct: parseFloat(((distToWall / entryPrice) * 100).toFixed(2)),
          leverage: effectiveLeverage,
          margin: standardMargin
        };
      }
      // Nếu là Minor S/R (Weak S/R): Không reject, kích hoạt cơ chế Bypass để tìm mốc phía sau!
    }
  }

  // 5.3. Xác định Mốc TP Mục Tiêu (ưu tiên Cản Cứng isMajor trước, tránh chốt non tại râu H1 yếu):
  let rawTP = null;
  let tpAnchorType = 'STANDARD_RR';

  // Ứng viên 1 (Pass 1): Ưu tiên Cản Cứng (isMajor) gần nhất trong [1.48R, 2.50R]
  for (const c of opposingClusters) {
    if (!c.isMajor) continue;
    const frontRunPrice = isLong
      ? (c.zoneMin - entryPrice * 0.002)
      : (c.zoneMax + entryPrice * 0.002);
    const dist = Math.abs(entryPrice - frontRunPrice);
    const candRR = dist / slDist;
    if (candRR >= 1.48 && candRR <= 2.50) {
      rawTP = frontRunPrice;
      tpAnchorType = `${c.timeframe}_SR_ANCHOR`;
      break;
    }
  }

  // Ứng viên 1 (Pass 2): Nếu không có Cản Cứng trong [1.48R, 2.50R], xét cản thường còn hiệu lực (!isBroken) đạt >= targetTpRatio
  if (!rawTP) {
    for (const c of opposingClusters) {
      if (c.isMajor || c.isBroken) continue;
      const frontRunPrice = isLong
        ? (c.zoneMin - entryPrice * 0.002)
        : (c.zoneMax + entryPrice * 0.002);
      const dist = Math.abs(entryPrice - frontRunPrice);
      const candRR = dist / slDist;
      if (candRR >= Math.max(1.48, targetTpRatio) && candRR <= 2.50) {
        rawTP = frontRunPrice;
        tpAnchorType = `${c.timeframe}_SR_ANCHOR`;
        break;
      }
    }
  }

  // Ứng viên 2: Mốc Lưới 369 kế tiếp (với Front-running 0.2%) nếu chưa có TP hoặc cản ở xa
  if (!rawTP && step > 0) {
    const gridTarget1 = isLong ? (entryPrice + step) : (entryPrice - step);
    const frontRunGrid1 = isLong ? (gridTarget1 - entryPrice * 0.002) : (gridTarget1 + entryPrice * 0.002);
    const distGrid1 = Math.abs(entryPrice - frontRunGrid1);
    const rrGrid1 = distGrid1 / slDist;

    if (rrGrid1 >= 1.48 && rrGrid1 <= 2.50) {
      rawTP = frontRunGrid1;
      tpAnchorType = '369_GRID_ANCHOR';
    } else if (rrGrid1 < 1.48) {
      // Nếu 1 step quá nhỏ không đủ 1.48R, thử mốc 2 step
      const gridTarget2 = isLong ? (entryPrice + 2 * step) : (entryPrice - 2 * step);
      const frontRunGrid2 = isLong ? (gridTarget2 - entryPrice * 0.002) : (gridTarget2 + entryPrice * 0.002);
      const distGrid2 = Math.abs(entryPrice - frontRunGrid2);
      const rrGrid2 = distGrid2 / slDist;
      if (rrGrid2 >= 1.48 && rrGrid2 <= 3.0) {
        rawTP = frontRunGrid2;
        tpAnchorType = '369_GRID_2STEP_ANCHOR';
      }
    }
  }

  // Ứng viên 2b: Fibonacci Extension 1.272 / 1.618 trên sóng H1 gần nhất (đồng bộ bot-new khi vùng cản/lưới 369 trống)
  if (!rawTP && recentH1.length >= 12) {
    const high24 = Math.max(...recentH1.map(c => c.high));
    const low24  = Math.min(...recentH1.map(c => c.low));
    const waveDelta = high24 - low24;
    if (waveDelta > 0) {
      for (const ext of [1.272, 1.618]) {
        const fibTarget = isLong
          ? (low24 + ext * waveDelta) - entryPrice * 0.002
          : (high24 - ext * waveDelta) + entryPrice * 0.002;
        const distFib = isLong ? (fibTarget - entryPrice) : (entryPrice - fibTarget);
        const rrFib = slDist > 0 ? (distFib / slDist) : 0;
        if (distFib > 0 && rrFib >= 1.48 && rrFib <= 3.0) {
          rawTP = fibTarget;
          tpAnchorType = ext === 1.272 ? 'FIB_EXT_1272' : 'FIB_EXT_1618';
          break;
        }
      }
    }
  }

  // Ứng viên 3: Fallback mục tiêu 1.5R chuẩn hoặc 0.618 step, khóa trần tối đa 2.50R để không làm hỏng BE 50% TP
  if (!rawTP) {
    const fallbackDist = Math.min(Math.max(idealTpDist, step * 0.618), slDist * 2.50);
    rawTP = isLong ? (entryPrice + fallbackDist) : (entryPrice - fallbackDist);
    tpAnchorType = 'FALLBACK_RATIO';
  }

  // 5.3b. HARD CAP THEO CẢN CỨNG ĐẦU TIÊN: Tuyệt đối không đặt TP xuyên qua phía sau bức tường Cản Cứng!
  const firstMajorWall = opposingClusters.find(c => c.isMajor);
  if (firstMajorWall) {
    const wallFrontRun = isLong
      ? (firstMajorWall.zoneMin - entryPrice * 0.002)
      : (firstMajorWall.zoneMax + entryPrice * 0.002);
    const tpOvershootsWall = isLong ? (rawTP > wallFrontRun) : (rawTP < wallFrontRun);
    if (tpOvershootsWall) {
      rawTP = wallFrontRun;
      tpAnchorType = `${firstMajorWall.timeframe}_MAJOR_WALL_CAP`;
    }
  }

  // 5.3c. Né Số Tròn Tâm Lý cho TP (Front-running trước tường xả/hút số tròn, chỉ áp dụng nếu giữ R:R >= 1.48)
  rawTP = evadeTpRoundNumber(rawTP, entryPrice, slDist, isLong);

  // 5.4. Làm tròn bảo thủ theo tickSize Binance
  const finalTpPrice = roundTpConservative(rawTP, effTickSize, isLong);
  const finalTpDist = Math.abs(entryPrice - finalTpPrice);
  const finalTpPct = (finalTpDist / entryPrice) * 100;
  const rrRatio = slDist > 0 ? (finalTpDist / slDist) : 0;

  // 🛡️ CHỐT CHẶN CỨNG R:R >= 1.5 (VETO NẾU KHÔNG ĐẠT)
  if (rrRatio < 1.48) {
    return {
      valid: false,
      reason: `RR_BELOW_1.5 (R:R = ${rrRatio.toFixed(2)} < 1.5 — Không đạt tỷ lệ lời/lỗ)`,
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      slPrice: finalSlPrice,
      tpPrice: finalTpPrice,
      slDistance: slDist,
      tpDistance: finalTpDist,
      slPct: parseFloat(finalSlPct.toFixed(2)),
      tpPct: parseFloat(finalTpPct.toFixed(2)),
      leverage: effectiveLeverage,
      margin: standardMargin
    };
  }

  // 6. THIẾT LẬP MỐC BREAKEVEN 50% TP (mặc định 50% thay vì 35% để chống quét râu non) VÀ ĐỆM PHÍ THỰC 0.14% GIÁ
  const beTriggerRatio = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));
  const fractalTriggerDist = finalTpDist * beTriggerRatio;
  const beTriggerPrice = isLong ? (entryPrice + fractalTriggerDist) : (entryPrice - fractalTriggerDist);
  const beFeeBuffer = entryPrice * 0.0014; // Đệm phí round-trip thực tế 0.14% giá (độc lập với đòn bẩy)
  const beSlPrice = isLong ? (entryPrice + beFeeBuffer) : (entryPrice - beFeeBuffer);

  return {
    valid: true,
    slPrice: finalSlPrice,
    tpPrice: finalTpPrice,
    beTriggerPrice: parseFloat(beTriggerPrice.toFixed(decimals)),
    beSlPrice: parseFloat(beSlPrice.toFixed(decimals)),
    slDistance: slDist,
    slPct: parseFloat(finalSlPct.toFixed(2)),
    tpDistance: finalTpDist,
    tpPct: parseFloat(finalTpPct.toFixed(2)),
    minSlPct: minSlPct,
    atrPct: parseFloat(atrPct.toFixed(2)),
    slScenario: slScenario,
    tpAnchorType: tpAnchorType,
    matchedSwing: matchedSwing,
    leverage: effectiveLeverage,
    margin: standardMargin,
    targetLossUSD: targetLossUSD,
    tpRatio: parseFloat(rrRatio.toFixed(2)),
    gridWidthPct: effGridWidth,
    rrRatio: parseFloat(rrRatio.toFixed(2))
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

/**
 * Pre-Limit Tactical Gatekeeper:
 * Kiểm tra các rủi ro chiến thuật tức thì trước khi thực sự bắn lệnh LIMIT lên sàn Binance.
 * Ngăn chặn tuyệt đối việc "hứng dao rơi" (M15 Marubozu xả thẳng hoặc Taker Sell > 75%).
 * Nếu nguy hiểm: tạm hoãn đặt Limit và đưa vào Watchlist chờ nến H1 đóng rút chân/râu xác nhận.
 */
function checkPreLimitTacticalGatekeeper({ sym, signal, targetLevel, markPrice, currM15, microstructure }) {
  const isLong = signal === 'LONG';

  // 1. Kiểm tra nến M15 tức thì (Marubozu Dump / Flush into Entry)
  if (currM15 && currM15.open && currM15.close && currM15.high && currM15.low) {
    const range = currM15.high - currM15.low;
    const body = Math.abs(currM15.close - currM15.open);
    const bodyPct = (body / (currM15.low || 1)) * 100;

    if (range > 0 && bodyPct >= 0.70) {
      if (isLong && currM15.close < currM15.open) {
        // Nến đỏ xả mạnh vào Entry
        const lowerWick = currM15.close - currM15.low;
        const lowerWickRatio = lowerWick / range;
        const bodyRatio = body / range;
        // Nếu thân nến chiếm >= 65% range và râu dưới < 15% (dao đang lao dốc chưa có lực cản)
        if (bodyRatio >= 0.65 && lowerWickRatio < 0.15) {
          return {
            passed: false,
            reason: `M15 Marubozu xả dốc (-${bodyPct.toFixed(2)}%, râu dưới chỉ ${(lowerWickRatio * 100).toFixed(1)}% < 15%) — Hứng dao rơi nguy hiểm`
          };
        }
      } else if (!isLong && currM15.close > currM15.open) {
        // Nến xanh bơm mạnh vào Entry
        const upperWick = currM15.high - currM15.close;
        const upperWickRatio = upperWick / range;
        const bodyRatio = body / range;
        // Nếu thân nến chiếm >= 65% range và râu trên < 15% (tên lửa đang phi lên)
        if (bodyRatio >= 0.65 && upperWickRatio < 0.15) {
          return {
            passed: false,
            reason: `M15 Marubozu bơm dốc (+${bodyPct.toFixed(2)}%, râu trên chỉ ${(upperWickRatio * 100).toFixed(1)}% < 15%) — Cản tàu nguy hiểm`
          };
        }
      }
    }
  }

  // 2. Kiểm tra Microstructure Order Flow (Taker Volume Flush & Tường đè)
  if (microstructure) {
    const takerBuyRatio = microstructure.takerBuyRatio ?? 0.5;
    const wallCategory = microstructure.wall;

    if (isLong) {
      // Áp lực bán Taker Sell >= 75% (takerBuyRatio <= 0.25)
      if (takerBuyRatio <= 0.25) {
        return {
          passed: false,
          reason: `Áp lực xả chủ động Taker Sell cực lớn (${((1 - takerBuyRatio) * 100).toFixed(1)}% >= 75%) — Dòng tiền đang bán tháo`
        };
      }
      if (wallCategory === 'WALL_CRUSHING_ENTRY') {
        return {
          passed: false,
          reason: `Tường bán khổng lồ đè sát trên đầu Entry (Orderbook Wall Crushing)`
        };
      }
    } else {
      // Áp lực mua Taker Buy >= 75%
      if (takerBuyRatio >= 0.75) {
        return {
          passed: false,
          reason: `Áp lực mua chủ động Taker Buy cực lớn (${(takerBuyRatio * 100).toFixed(1)}% >= 75%) — Dòng tiền đang FOMO đẩy giá`
        };
      }
      if (wallCategory === 'WALL_CRUSHING_ENTRY') {
        return {
          passed: false,
          reason: `Tường mua khổng lồ kê sát dưới chân Entry (Orderbook Wall Crushing)`
        };
      }
    }
  }

  return { passed: true, reason: 'Tactical conditions safe' };
}

// Using unified getDecimals from pp369 module

// ─── Main ─────────────────────────────────────────────────────────────────────

async function startAutoTrade(coins) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
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

  // ── REVERSAL SIGNAL & ACTIVE POSITION TRACKING (Đồng bộ cơ chế với bot-new) ──
  const MIN_SCORE_REVERSAL = parseInt(process.env.MIN_SCORE_REVERSAL || '9', 10);
  const REVERSAL_ALERT_COOLDOWN_MS = parseInt(process.env.REVERSAL_ALERT_COOLDOWN_MS || String(30 * 60 * 1000), 10);
  const reversalAlertCooldown = {}; // sym -> timestamp
  const activePositionsMap = new Map(); // sym -> { direction: 'LONG' | 'SHORT', positionAmt, entryPrice }
  const activeOrdersMap = new Map(); // sym -> 'LONG' | 'SHORT'

  function getActiveTradeDirection(sym) {
    if (activePositionsMap.has(sym)) {
      return activePositionsMap.get(sym).direction;
    }
    if (activeOrdersMap.has(sym)) {
      return activeOrdersMap.get(sym);
    }
    const meta = activeTradesMetadata[sym];
    if (meta?.side) {
      return (meta.side === 'BUY' || meta.side === 'LONG') ? 'LONG' : 'SHORT';
    }
    if (activeSymbols.has(sym)) {
      return 'UNKNOWN';
    }
    return null;
  }

  // ── PENDING REVERSAL ENTRY LIFECYCLE (Đồng bộ triệt để với bot-new) ──
  const PENDING_REVERSALS_PATH = path.join(process.cwd(), 'data', 'pending_reversals.json');
  let pendingReversals = {};
  try {
    if (fs.existsSync(PENDING_REVERSALS_PATH)) {
      pendingReversals = JSON.parse(fs.readFileSync(PENDING_REVERSALS_PATH, 'utf8'));
    }
  } catch (_) { pendingReversals = {}; }

  function savePendingReversals() {
    try {
      fs.writeFileSync(PENDING_REVERSALS_PATH, JSON.stringify(pendingReversals, null, 2), 'utf8');
    } catch (_) { }
  }

  function fmtPrice(p) {
    if (p == null || isNaN(p)) return '—';
    const num = Number(p);
    if (num >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (num >= 1) return num.toFixed(4);
    return num.toFixed(6);
  }

  function activatePendingReversalIfAny(sym) {
    if (pendingReversals[sym] && pendingReversals[sym].status === 'waiting_old_close') {
      const rev = pendingReversals[sym];
      rev.status = 'pending_entry';
      rev.activatedAt = Date.now();
      savePendingReversals();

      const dirIcon = rev.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      sendTelegram(
        `⏳ <b>[ĐẢO CHIỀU — KÍCH HOẠT HÀNG CHỜ] — #${sym} ${dirIcon} ⚡x${rev.leverage}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `Đã ghi nhận vị thế cũ được đóng trên sàn!\n` +
        `💰 Entry mục tiêu: <code>$${fmtPrice(rev.entryPrice)}</code>\n` +
        `🎯 Chốt lời (TP):   <code>$${fmtPrice(rev.tpPrice)}</code>\n` +
        `🛑 Cắt lỗ (SL):     <code>$${fmtPrice(rev.slPrice)}</code>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>🤖 Bot đang rà soát giá: chỉ vào lệnh MARKET khi giá về đúng vùng entry (không đuổi giá xấu) và chưa chạm SL.</i>`
      ).catch(() => { });

      log.system(`[AutoTrade] ⏳ [Đảo Chiều Kích Hoạt Hàng Chờ] ${sym} ${rev.direction} — Vị thế cũ đã đóng, bắt đầu rà soát entry`);
    }
  }

  isShadowMode = process.env.SHADOW_MODE === 'true' || !apiKey || !secret;
  if (!isShadowMode && (!apiKey || !secret)) {
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

  // Khởi tạo Binance REST client TRƯỚC khi đăng ký WebSocket callbacks (tránh lỗi TDZ khi WS fill sớm)
  const client = isShadowMode ? null : createClient(apiKey, secret);
  globalTradeClient = client;

  // ── Định kỳ làm mới trần đòn bẩy (Leverage Brackets) mỗi 6 giờ vào step_sizes.json ────
  const leverageRefreshTimer = setInterval(async () => {
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

  // ── Khởi động Binance Futures User Data Stream WebSocket (Phase 4) ──
  if (apiKey) {
    startBinanceStream(apiKey).catch(err => {
      log.warn(`[AutoTrade] Không thể khởi động Binance User Data Stream: ${err.message}`);
    });

    onEntryFill(async (fillData) => {
      const sym = fillData.symbol;
      const meta = activeTradesMetadata[sym];
      if (meta && !meta.isFilled) {
        meta.isFilled = true;
        meta.orderId = null; // Xóa orderId lệnh LIMIT pending để checkPendingLimits không hiểu nhầm
        meta.entryPrice = fillData.avgPrice || meta.entryPrice;
        meta.fillTime = Date.now();
        meta._placingBracket = true;
        activeOrdersMap.delete(sym);
        activePositionsMap.set(sym, {
          direction: (meta.side === 'BUY' || meta.side === 'LONG') ? 'LONG' : 'SHORT',
          positionAmt: fillData.qty || meta.qty,
          entryPrice: meta.entryPrice
        });
        if (client && typeof client.invalidatePositionCache === 'function') client.invalidatePositionCache();
        saveActiveTradesMetadata();

        // Đặt cặp lệnh bảo vệ kép Dual Bracket (Limit TP & Stop Market SL) trực tiếp lên sàn
        try {
          if (client && meta.tierTpPrice && meta.tierSlPrice) {
            const qty = fillData.qty || meta.qty;
            await placeDualBracket({
              client,
              sym,
              side: fillData.side,
              qty,
              entryPrice: meta.entryPrice,
              targetPrice: meta.tierTpPrice,
              slPrice: meta.tierSlPrice,
              meta,
            });
            saveActiveTradesMetadata();
          }
        } finally {
          meta._placingBracket = false;
        }
      }
    });

    onOrderFill(async (fillData) => {
      const sym = fillData.symbol;
      const meta = activeTradesMetadata[sym];
      if (!meta || !meta.isFilled) return;

      const isLongPos = meta.side === 'BUY' || meta.side === 'LONG';
      const closingSide = isLongPos ? 'SELL' : 'BUY';
      const isClosingOrder = (fillData.reduceOnly || fillData.closePosition || fillData.side === closingSide);
      if (!isClosingOrder) return;

      const isTpMatch = (meta.tpOrderId && String(fillData.orderId) === String(meta.tpOrderId)) ||
                        (fillData.orderType === 'TAKE_PROFIT_MARKET' || fillData.orderType === 'TAKE_PROFIT');
      const isSlMatch = (meta.slOrderId && (
                          String(fillData.orderId) === String(meta.slOrderId) ||
                          (fillData.algoId && String(fillData.algoId) === String(meta.slOrderId))
                        )) ||
                        (fillData.orderType === 'STOP_MARKET' || fillData.orderType === 'STOP');

      if (!isTpMatch && !isSlMatch) return;

      const exitPx = fillData.avgPrice || meta.entryPrice;
      const levVal = meta.leverage || 1;
      const rawMovePct = meta.entryPrice > 0
        ? (isLongPos ? (exitPx - meta.entryPrice) / meta.entryPrice : (meta.entryPrice - exitPx) / meta.entryPrice) * 100
        : 0;
      const estRoi = rawMovePct * levVal;
      const estPnlUsd = (estRoi / 100) * (meta.margin || 0);
      const holdingMin = (Date.now() - (meta.time || Date.now())) / 60000;
      const hasTakenPartial = !!(meta.isPartialClosed || partialClosedSymbols.has(sym));

      // Đánh dấu đóng đồng bộ trước khi await để ngăn checkTrailingSL báo trùng & ngăn SafetyBrake báo giả
      justClosedByBot.add(sym);
      meta.isClosed = true;
      delete activeTradesMetadata[sym];
      delete reversalAlertCooldown[sym];
      activeOrdersMap.delete(sym);
      activePositionsMap.delete(sym);
      activeSymbols.delete(sym);
      lastActivePositions.delete(sym);
      partialClosedSymbols.delete(sym);
      if (client && typeof client.invalidatePositionCache === 'function') client.invalidatePositionCache();
      saveActiveTradesMetadata();

      if (isTpMatch) {
        log.system(`[AutoTrade] 🎯 Lệnh TP khớp cho ${sym} @ $${exitPx}! Tự động dọn dẹp SL đối ứng...`);
        await autoCleanOppositeOrder({ client, sym, filledType: 'TP', meta });
        const exitType = meta.isTrendRunner ? 'TREND_RUNNER_TP' : 'TP';
        recordTradeExit({
          tradeId: `${sym}-${meta.orderId || fillData.orderId || 'wsTP'}`,
          orderId: String(fillData.orderId || meta.orderId || ''),
          symbol: sym,
          exitPrice: exitPx,
          exitTimestamp: Date.now(),
          exitType,
          pnlPercent: estRoi,
          pnlUsd: estPnlUsd,
          holdingDurationMinutes: holdingMin,
          isWin: estRoi >= 0,
        });
        recordDirectionalTradeExit({ symbol: sym, side: isLongPos ? 'LONG' : 'SHORT', isWin: true, exitType, pnlUsd: estPnlUsd, pnlPercent: estRoi, isPartialClosed: hasTakenPartial });
        recordRealTradeOutcome({ symbol: sym, side: isLongPos ? 'LONG' : 'SHORT', isWin: true, exitType, pnlUsd: estPnlUsd, pnlPercent: estRoi, isPartialClosed: hasTakenPartial });
        sendTelegram(`🎯 <b>[AutoTrade] Chốt Lời Thành Công!</b>\n• Coin: <b>#${sym} (${isLongPos ? 'LONG' : 'SHORT'})</b>\n• Giá TP: <b>$${exitPx}</b> (ROI ~${estRoi >= 0 ? '+' : ''}${estRoi.toFixed(2)}%)`).catch(() => { });
        activatePendingReversalIfAny(sym);
      } else if (isSlMatch) {
        const isTrailingProfit = (meta.isBeTriggered || meta.fractalSlPrice) && estRoi >= -1.0;
        const exitType = isTrailingProfit ? 'TRAILING_SL' : 'SL';
        log.system(`[AutoTrade] 🛑 Lệnh Stop-Market SL khớp cho ${sym} @ $${exitPx} (${exitType}, ROI ${estRoi.toFixed(2)}%)! Tự động dọn dẹp TP đối ứng...`);
        await autoCleanOppositeOrder({ client, sym, filledType: 'SL', meta });
        if (!isTrailingProfit && !hasTakenPartial && estRoi < -1.0) {
          addSymbolToCooldown(sym, 6.0, 'SL_NORMAL');
        }
        recordTradeExit({
          tradeId: `${sym}-${meta.orderId || fillData.orderId || 'wsSL'}`,
          orderId: String(fillData.orderId || meta.orderId || ''),
          symbol: sym,
          exitPrice: exitPx,
          exitTimestamp: Date.now(),
          exitType,
          pnlPercent: estRoi,
          pnlUsd: estPnlUsd,
          holdingDurationMinutes: holdingMin,
          isWin: estRoi >= 0,
        });
        recordDirectionalTradeExit({ symbol: sym, side: isLongPos ? 'LONG' : 'SHORT', isWin: estRoi >= 0 || hasTakenPartial, exitType, pnlUsd: estPnlUsd, pnlPercent: estRoi, isPartialClosed: hasTakenPartial });
        recordRealTradeOutcome({ symbol: sym, side: isLongPos ? 'LONG' : 'SHORT', isWin: estRoi >= 0 || hasTakenPartial, exitType, pnlUsd: estPnlUsd, pnlPercent: estRoi, isPartialClosed: hasTakenPartial });
        sendTelegram(
          isTrailingProfit
            ? `🌊 <b>[AutoTrade] Đóng Vị Thế Trailing SL (${meta.fractalTf || 'BE'})</b>\n• Coin: <b>#${sym} (${isLongPos ? 'LONG' : 'SHORT'})</b>\n• Giá đóng: <b>$${exitPx}</b> (ROI ~${estRoi >= 0 ? '+' : ''}${estRoi.toFixed(2)}%)`
            : `🛑 <b>[AutoTrade] Dừng Lỗ Vị Thế</b>\n• Coin: <b>#${sym} (${isLongPos ? 'LONG' : 'SHORT'})</b>\n• Giá SL: <b>$${exitPx}</b> (ROI ~${estRoi.toFixed(2)}%)\n• Kích hoạt Cooldown 6h bảo vệ vốn`
        ).catch(() => { });
        activatePendingReversalIfAny(sym);
      }
    });
  }

  // ── Khởi động vòng lặp Tự học Tự động (Autonomous Retraining Loop) ──
  startPeriodicRetrain({ checkIntervalMs: 60 * 60 * 1000, minNewSamples: 20 });

  // ── Khởi động Báo Cáo Tổng Kết Giao Dịch 24H qua Telegram (07:00 UTC+7 mỗi ngày) ──
  startDailyReportScheduler();

  // ── Đăng ký bộ xử lý nút "⚡ Đẩy Limit" từ Shadow Dashboard lên Binance thật (Bot tiếp quản 100% TP/SL + BE/Fractal) ──
  setPromoteShadowHandler(async (shadowId) => {
    if (isShadowMode || !client) {
      return { ok: false, error: 'Bot đang chạy chế độ SHADOW_MODE hoặc chưa có Binance API Key' };
    }
    const shadows = getActiveShadowPositions();
    const sh = shadows[shadowId];
    if (!sh) {
      return { ok: false, error: 'Không tìm thấy vị thế Shadow đang hoạt động' };
    }
    const sym = sh.symbol;
    const isLong = sh.signal === 'LONG' || sh.signal === 'BUY';
    const side = isLong ? 'BUY' : 'SELL';
    const entryPrice = parseFloat(sh.entryPrice);
    const tpPrice = parseFloat(sh.tierTpPrice || 0);
    const slPrice = parseFloat(sh.tierSlPrice || sh.originalSlPrice || 0);
    const slPct = parseFloat(sh.slPct || (entryPrice > 0 ? Math.abs((slPrice - entryPrice) / entryPrice) * 100 : 3.0));
    const leverage = Math.max(1, parseInt(sh.leverage || 5, 10));
    const isTier1 = isTop50Symbol(sym);
    const envMargin = await getDynamicMargin(isTier1, client);
    const reqMargin = (typeof envMargin === 'number' && envMargin > 0) ? envMargin : parseFloat(sh.margin || 10);

    if (!entryPrice || entryPrice <= 0 || !tpPrice || !slPrice) {
      return { ok: false, error: `Thông số Entry/TP/SL không hợp lệ cho ${sym}` };
    }
    if (activeTradesMetadata[sym] && !activeTradesMetadata[sym].isClosed) {
      return { ok: false, error: `${sym} đang có vị thế/lệnh chờ trong bot-h4` };
    }

    // Kiểm tra trên Binance để tuyệt đối chống đặt trùng
    try {
      const [hasPos, openOrders] = await Promise.all([
        client.hasOpenPosition(sym),
        client.getOpenOrders(sym).catch(() => []),
      ]);
      if (hasPos) return { ok: false, error: `${sym} đang có vị thế mở trên sàn Binance` };
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        return { ok: false, error: `${sym} đã có lệnh chờ mở trên sàn Binance` };
      }
    } catch (errCheck) {
      return { ok: false, error: `Lỗi kiểm tra sàn Binance: ${errCheck.message}` };
    }

    const availBal = await client.getBalance();
    if (!availBal || availBal < 5) {
      return { ok: false, error: `Số dư khả dụng không đủ ($${(availBal || 0).toFixed(2)} USDT)` };
    }
    const actualMargin = Math.min(reqMargin, availBal * 0.95);
    const q = calcQuantity(sym, actualMargin * leverage, entryPrice);
    if (!q || !q.qty || q.qty <= 0) {
      return { ok: false, error: `Không tính được khối lượng hợp lệ cho ${sym} (${q?.reason || 'qty=0'})` };
    }

    const tickSize = getEffectiveTickSize(sym, entryPrice);
    const decimals = tickSize && tickSize > 0
      ? Math.max(0, Math.round(-Math.log10(tickSize)))
      : getDecimals(entryPrice);

    await client.setLeverage(sym, leverage);
    const order = await client.placeLimit(sym, side, q.qty, entryPrice, decimals, false);

    const beTriggerRatio = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));
    const beTriggerPrice = (typeof sh.beTriggerPrice === 'number' && sh.beTriggerPrice > 0)
      ? sh.beTriggerPrice
      : (isLong ? entryPrice + (tpPrice - entryPrice) * beTriggerRatio : entryPrice - (entryPrice - tpPrice) * beTriggerRatio);
    const step = getStep(entryPrice);
    const posGridPct = sh.gridWidthPct || (step && entryPrice > 0 ? (step / entryPrice) * 100 : 3.5);
    const markPrice = getMarkPrice(sym) || entryPrice;

    activeTradesMetadata[sym] = {
      score: sh.score || 0,
      isCounterTrend: false,
      entryPrice,
      side,
      gridWidthPct: posGridPct,
      gridStepPct: posGridPct,
      step,
      orderId: order.orderId ?? null,
      isFilled: false,
      hasNotifiedFill: false,
      maxFavorablePrice: null,
      pendingBouncePeakPrice: null,
      time: Date.now(),
      markPrice,
      scoreReasons: sh.scoreReasons || [],
      marketCapRank: sh.marketCapRank || 999,
      leverage,
      margin: actualMargin,
      maxRecentBouncePct: null,
      aiWinProbability: sh.winProbability ?? null,
      aiExpectedRoi: null,
      isTrendRunnerEligible: false,
      tierSlPrice: slPrice,
      tierTpPrice: tpPrice,
      beTriggerPrice,
      slDistance: Math.abs(entryPrice - slPrice),
      slPct,
      targetLossUSD: parseFloat((actualMargin * (slPct / 100) * leverage).toFixed(2)),
      source: 'manual_shadow_promote',
    };
    saveActiveTradesMetadata();

    recordTradeEntry({
      tradeId: `${sym}-${order.orderId || Date.now()}`,
      orderId: String(order.orderId || ''),
      symbol: sym,
      signal: isLong ? 'LONG' : 'SHORT',
      entryPrice,
      markPrice,
      score: sh.score || 0,
      scoreReasons: sh.scoreReasons || [],
      marketCapRank: sh.marketCapRank || 999,
      gridWidthPct: posGridPct,
      marketMetrics: sh.marketMetrics || null,
      signalMetrics: sh.signalMetrics || null,
      microstructure: sh.microstructure || null,
      leverage,
      margin: actualMargin,
      aiWinProbability: sh.winProbability ?? null,
    });

    removeShadowPosition(shadowId);
    removeShadowBySymbolDirection(sym, isLong ? 'LONG' : 'SHORT');
    log.system(`[AutoTrade] ⚡ [Manual Shadow Promote] Đã đẩy LIMIT ${sym} ${side} qty=${q.qty} @ $${entryPrice} (orderId=${order.orderId}) | Margin=$${actualMargin.toFixed(2)} (Tier ${isTier1 ? 1 : 2} .env) | Lev=${leverage}x | TP=$${tpPrice} | SL=$${slPrice} | BE=$${beTriggerPrice.toFixed(4)} — Bot tiếp quản 100%!`);

    return {
      ok: true,
      orderId: order.orderId,
      symbol: sym,
      side,
      qty: q.qty,
      entryPrice,
      tpPrice,
      slPrice,
      beTriggerPrice,
      leverage,
      margin: parseFloat(actualMargin.toFixed(2)),
    };
  });

  // ── Đăng ký bộ xử lý nút "✕ Hủy Limit" tại bảng Vị thế thực tế trên Dashboard ──
  setCancelLimitHandler(async ({ symbol, orderId }) => {
    const sym = String(symbol || '').toUpperCase().replace(/USDT$/i, '');
    if (!sym) return { ok: false, error: 'Thiếu symbol' };
    if (isShadowMode || !client) {
      return { ok: false, error: 'Bot đang chạy SHADOW_MODE hoặc chưa có Binance API Key' };
    }

    const openOrders = await client.getOpenOrders(sym).catch(() => []);
    const targets = (Array.isArray(openOrders) ? openOrders : []).filter(o => {
      const isEntryLimit = o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
      if (!isEntryLimit) return false;
      return orderId ? String(o.orderId) === String(orderId) : true;
    });

    const canceledOrderIds = [];
    for (const o of targets) {
      await client.cancelOrder(sym, o.orderId);
      canceledOrderIds.push(String(o.orderId));
    }

    if (canceledOrderIds.length === 0) {
      const fallbackId = orderId || activeTradesMetadata[sym]?.orderId;
      if (fallbackId) {
        try {
          await client.cancelOrder(sym, fallbackId);
          canceledOrderIds.push(String(fallbackId));
        } catch (cancelErr) {
          const msg = cancelErr?.message || '';
          if (!msg.includes('-2011') && !msg.includes('Unknown order')) {
            return { ok: false, error: `Không thể hủy lệnh Limit ${sym}: ${msg}` };
          }
        }
      } else {
        return { ok: false, error: `Không tìm thấy lệnh LIMIT chờ khớp nào cho ${sym} trên sàn Binance` };
      }
    }

    // Dọn metadata trong RAM + active_trades.json nếu lệnh chưa khớp thành vị thế
    if (activeTradesMetadata[sym] && !activeTradesMetadata[sym].isFilled) {
      delete activeTradesMetadata[sym];
      saveActiveTradesMetadata();
    }

    log.system(`[AutoTrade] ✕ [Dashboard Cancel Limit] Đã hủy lệnh LIMIT chờ khớp ${sym} (orderIds=${canceledOrderIds.join(',') || 'cleaned'})`);
    return { ok: true, symbol: sym, canceledOrderIds };
  });

  // ── Khởi động Web Dashboard Express/Canvas Port 3369 (Phase 5) ──
  // Mặc định port 3369 để tránh xung đột với bot_new (port 3000) trên VPS
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || (process.env.PORT && process.env.PORT !== '3000' ? process.env.PORT : '3369'), 10);
  try {
    startDashboard(dashboardPort);
  } catch (err) {
    log.warn(`[AutoTrade] Không thể khởi động Web Dashboard: ${err.message}`);
  }

  // ── Khởi động Bộ Lệnh Telegram 2 Chiều (Phase 5) ──
  try {
    startTelegramCommands();
  } catch (err) {
    log.warn(`[AutoTrade] Không thể khởi động Telegram Commands: ${err.message}`);
  }

  // ── Đăng ký Real-time WebSocket Price listener để cập nhật maxFavorablePrice tức thì (0ms) ──
  // Đảm bảo mọi quét râu (wick spike) ngắn dưới 1s đều được ghi nhận ngay lập tức cho Trailing SL và Shadow PnL
  onPriceUpdate((sym, price) => {
    if (!price || price <= 0) return;

    // Cập nhật giá thời gian thực cho hệ thống Shadow PnL Tracker
    updateShadowPrices({ [sym]: price });

    // 🛡️ TẦNG 1: REAL-TIME BTC FLASH GUARD (Độ trễ 0ms từ WebSocket Stream - Không chờ nến đóng)
    if (sym === 'BTC') {
      checkRealtimeBtcFlashVelocity(price, globalTradeClient);
    }

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
        // Lệnh LIMIT ĐANG CHỜ KHỚP: theo dõi độ nảy để Bounce Cancel (DÙNG BIẾN RIÊNG pendingBouncePeakPrice)
        if (isLong) {
          if (meta.pendingBouncePeakPrice == null || price > meta.pendingBouncePeakPrice) {
            meta.pendingBouncePeakPrice = price;
          }
        } else {
          if (meta.pendingBouncePeakPrice == null || price < meta.pendingBouncePeakPrice) {
            meta.pendingBouncePeakPrice = price;
          }
        }
      }
    }
  });

  // ── Luồng đồng bộ giá ngầm cho các vị thế Shadow PnL đang chạy (mỗi 10s) ────
  // Đồng bộ giá từ bộ nhớ cache WebSocket getMarkPrice (0 tốn IP weight REST API)
  const shadowSyncTimer = setInterval(() => {
    try {
      const activeShadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
      const shadowSyms = Object.values(activeShadows).map(p => p.symbol);
      for (const sym of shadowSyms) {
        const mp = typeof getMarkPrice === 'function' ? getMarkPrice(sym) : null;
        if (mp && mp > 0) {
          updateShadowPrices({ [sym]: mp });
        }
      }
    } catch (_) { }
  }, 10_000);

  // Tập hợp coin đang hoạt động (khai báo trước để coinRefreshTimer đồng bộ được)
  const activeCoinSet = new Set(coins);

  // ── Tái kiểm tra danh sách coin mỗi 4 giờ theo giá thị trường hiện tại ────
  const coinRefreshTimer = setInterval(async () => {
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
      activeCoinSet.clear();
      for (const s of newList) activeCoinSet.add(s);
      log.system(`[AutoTrade] [CoinRefresh] Tái kiểm tra danh sách: ${oldCount} → ${activeCoinList.length} coin hợp lệ theo giá hiện tại.`);
    } catch (err) {
      log.warn(`[AutoTrade] [CoinRefresh] Lỗi tái kiểm tra danh sách coin: ${err.message}`);
    }
  }, COIN_REFRESH_INTERVAL_MS);

  // Chờ WebSocket kết nối và nhận giá live ban đầu cho các mã đó
  await new Promise(r => setTimeout(r, 4000));

  if (client) {
    try {
      const initBalance = await client.getBalance();
      log.system(`[AutoTrade] 💼 Binance Account bot-h4: Key=***${apiKey.slice(-4)} | Available Balance: $${initBalance.toFixed(2)} USDT`);
    } catch (err) {
      log.warn(`[AutoTrade] Không thể lấy balance ban đầu: ${err.message}`);
    }
  }

  // ── Đồng bộ hóa trạng thái vị thế/lệnh chờ với sàn khi bot khởi động lại (Startup Reconciliation) ──
  try {
    const [openPos, openOrders] = await Promise.all([
      client.getOpenPositions(),
      client.getOpenOrders()
    ]);
    const activeExchangeSymbols = new Set([
      ...openPos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol.replace('USDT', '')),
      ...openOrders.map(o => o.symbol.replace('USDT', ''))
    ]);

    for (const p of openPos) {
      const amt = parseFloat(p.positionAmt);
      if (amt !== 0) {
        const sym = p.symbol.replace('USDT', '');
        const dir = amt > 0 ? 'LONG' : 'SHORT';
        activePositionsMap.set(sym, {
          direction: dir,
          positionAmt: amt,
          entryPrice: parseFloat(p.entryPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit)
        });
        try { removeShadowBySymbolDirection(sym, dir); } catch (_) {}
      }
    }
    for (const o of openOrders) {
      const sym = o.symbol.replace('USDT', '');
      const dir = o.side === 'BUY' ? 'LONG' : 'SHORT';
      activeOrdersMap.set(sym, dir);
      if (!isOrderReduceOnly(o) && (o.type === 'LIMIT' || o.orderType === 'LIMIT')) {
        try { removeShadowBySymbolDirection(sym, dir); } catch (_) {}
      }
    }

    let cleanedCount = 0;
    for (const sym of Object.keys(activeTradesMetadata)) {
      if (!activeExchangeSymbols.has(sym)) {
        delete activeTradesMetadata[sym];
        delete reversalAlertCooldown[sym];
        activeOrdersMap.delete(sym);
        activePositionsMap.delete(sym);
        activeSymbols.delete(sym);
        activatePendingReversalIfAny(sym);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      saveActiveTradesMetadata();
      log.system(`[AutoTrade] [StartupReconciliation] Đã dọn dẹp ${cleanedCount} vị thế rác cũ trong metadata không còn tồn tại trên sàn.`);
    }
  } catch (err) {
    log.warn(`[AutoTrade] [StartupReconciliation] Lỗi kiểm tra chéo vị thế khi khởi động: ${err.message}`);
  }

  log.system('[AutoTrade] Bắt đầu scan...');

  let lastHeartbeatTime = Date.now();
  const scanWindowStats = {
    pollCycles: 0,
    wsTicks: 0,
    coinsChecked: 0,
    signals369: 0,
    rejectHardFilter: 0,
    rejectScore: 0,
    rejectMath: 0,
    rejectGatekeeper: 0,
    ordersDispatched: 0,
  };
  let isScanning = false;

  async function scan() {
    if (isIpBanned() || isScanning) return;
    isScanning = true;
    scanWindowStats.pollCycles++;
    try {
      // 0. Dọn dẹp cache RAM định kỳ (tránh rò rỉ bộ nhớ khi chạy 24/7)
      pruneMemoryCaches();

      // Cập nhật và kiểm tra lưới bảo vệ BTC Flash Pump / Dump Guard & Cache Volume 24H
      await updateBtcFlashGuard(client);
      await updateVolume24hCache();

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
          // 🛡️ TUYỆT ĐỐI KHÔNG xử lý Timeout/BounceCancel cho các lệnh reduceOnly (như TP LIMIT)
          if (isOrderReduceOnly(order)) {
            remainingOrders.push(order);
            continue;
          }
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
              const touchThresholdPct = 0.15;             // fixed 0.15% — khoảng cách tuyệt đối từ entry
              // Thống nhất 1 công thức bouncePct duy nhất với checkPendingLimits (chống 2 luồng tự reset bộ đếm của nhau)
              const effGridPct = (meta.gridWidthPct && meta.gridWidthPct > 0) ? meta.gridWidthPct : ((stepVal / entryPrice) * 100);
              const bouncePct = Math.min(Math.max(effGridPct * 0.35, 1.50), 3.00);

              if (order.side === 'BUY') {
                // LONG: kiểm tra xem giá hiện tại có bật nảy đi xa mốc entry hay chưa
                const currentBouncedPct = ((markPrice - entryPrice) / entryPrice) * 100;
                const touchZoneUpper = entryPrice * (1 + touchThresholdPct / 100);
                if (markPrice <= touchZoneUpper) {
                  // Giá đang trong vùng touch — cập nhật điểm thấp nhất
                  meta.touchLow = meta.touchLow == null ? markPrice : Math.min(meta.touchLow, markPrice);
                }

                const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);
                const isRetestCancel = meta.isH1Retest && currentBouncedRoi >= 5.0;
                const isBouncedFromTouch = meta.touchLow != null && markPrice >= (meta.touchLow * (1 + bouncePct / 100));
                const isBouncedFromEntry = currentBouncedPct >= bouncePct;
                const bounceRef = meta.touchLow != null ? meta.touchLow : entryPrice;
                const bounceDisplayPct = meta.touchLow != null ? ((markPrice - meta.touchLow) / meta.touchLow * 100) : currentBouncedPct;
                const shouldCancelNow = checkBounceCancelHoldReady(sym, 'LONG', meta, isRetestCancel || isBouncedFromTouch || isBouncedFromEntry, bounceDisplayPct, bouncePct);

                if (shouldCancelNow) {
                  log.system(`[AutoTrade] [BounceCancel] ${sym} LONG: giá từ điểm chạm $${bounceRef.toFixed(6)} duy trì bật lên $${markPrice.toFixed(6)} (+${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}% suốt ${BOUNCE_CANCEL_WAIT_SEC}s) → Hủy LIMIT`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
                    bounceCancelledLevels.set(`${sym}_${entryPrice}`, Date.now() + 60 * 60_000);
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} LONG</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Giá điểm chạm: <b>$${bounceRef.toFixed(6)}</b> | Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${bounceDisplayPct.toFixed(2)}%)\n` +
                      `• Giá duy trì bật nảy xa mốc suốt ${BOUNCE_CANCEL_WAIT_SEC}s → Hủy lệnh (Khóa mốc 60p)`
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

                const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);
                const isRetestCancel = meta.isH1Retest && currentBouncedRoi >= 5.0;
                const isBouncedFromTouch = meta.touchHigh != null && markPrice <= (meta.touchHigh * (1 - bouncePct / 100));
                const isBouncedFromEntry = currentBouncedPct >= bouncePct;
                const bounceRef = meta.touchHigh != null ? meta.touchHigh : entryPrice;
                const bounceDisplayPct = meta.touchHigh != null ? ((meta.touchHigh - markPrice) / meta.touchHigh * 100) : currentBouncedPct;
                const shouldCancelNow = checkBounceCancelHoldReady(sym, 'SHORT', meta, isRetestCancel || isBouncedFromTouch || isBouncedFromEntry, bounceDisplayPct, bouncePct);

                if (shouldCancelNow) {
                  log.system(`[AutoTrade] [BounceCancel] ${sym} SHORT: giá từ điểm chạm $${bounceRef.toFixed(6)} duy trì bật xuống $${markPrice.toFixed(6)} (-${bounceDisplayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}% suốt ${BOUNCE_CANCEL_WAIT_SEC}s) → Hủy LIMIT`);
                  try {
                    await client.cancelOrder(sym, order.orderId);
                    overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
                    bounceCancelledLevels.set(`${sym}_${entryPrice}`, Date.now() + 60 * 60_000);
                    sendTelegram(
                      `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
                      `• Coin: <b>${sym} SHORT</b>\n` +
                      `• Entry: <b>$${entryPrice}</b>\n` +
                      `• Giá điểm chạm: <b>$${bounceRef.toFixed(6)}</b> | Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${bounceDisplayPct.toFixed(2)}%)\n` +
                      `• Giá duy trì bật nảy xa mốc suốt ${BOUNCE_CANCEL_WAIT_SEC}s → Hủy lệnh (Khóa mốc 60p)`
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
        activePositionsMap.clear();
        activeOrdersMap.clear();

        for (const p of currentPos) {
          const amt = parseFloat(p.positionAmt);
          if (amt !== 0) {
            const sym = p.symbol.replace('USDT', '');
            activeSymbols.add(sym);
            activePositionsMap.set(sym, {
              direction: amt > 0 ? 'LONG' : 'SHORT',
              positionAmt: amt,
              entryPrice: parseFloat(p.entryPrice),
              unrealizedPnl: parseFloat(p.unRealizedProfit)
            });
          }
        }
        for (const o of remainingOrders) {
          const sym = o.symbol.replace('USDT', '');
          activeSymbols.add(sym);
          activeOrdersMap.set(sym, o.side === 'BUY' ? 'LONG' : 'SHORT');
        }
        for (const o of currentAlgoOrders) {
          activeSymbols.add(o.symbol.replace('USDT', ''));
        }

        // Kích hoạt hàng chờ đảo chiều nếu vị thế cũ đã đóng trên Binance
        for (const sym of Object.keys(pendingReversals)) {
          if (pendingReversals[sym]?.status === 'waiting_old_close' && !activePositionsMap.has(sym)) {
            activatePendingReversalIfAny(sym);
          }
        }
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi đồng bộ activeSymbols: ${_binanceErr(e)}`);
      }

      const levelCache = getLevelCache();
      // 1. WebSocket lắng nghe biến động giá cho tất cả coin trong bán kính 1.0% + toàn bộ coin đang có vị thế/lệnh chờ/shadow
      const wsNearby = getNearbySymbols(activeCoinList, levelCache, 0.01);
      const activeShadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
      const shadowSyms = Object.values(activeShadows).map(p => p.symbol);
      const wsAllSymbols = Array.from(new Set([...wsNearby, ...activeSymbols, ...shadowSyms]));
      syncWebSocketSubscriptions(wsAllSymbols);

      // 2. Vòng lặp Scan định kỳ chỉ xử lý các coin đang thực sự TIỆM CẬN SÁT MỐC (<= 0.5%) để tối ưu tốc độ treo LIMIT
      const scanNearby = getNearbySymbols(activeCoinList, levelCache, 0.005, true);
      const missingLvlCount = activeCoinList.filter(s => !levelCache[s]?.longEntry || !levelCache[s]?.shortEntry).length;

      const nowTime = Date.now();
      if (nowTime - lastHeartbeatTime >= 15 * 60 * 1000) {
        lastHeartbeatTime = nowTime;
        const st = { ...scanWindowStats };
        scanWindowStats.pollCycles = 0;
        scanWindowStats.wsTicks = 0;
        scanWindowStats.coinsChecked = 0;
        scanWindowStats.signals369 = 0;
        scanWindowStats.rejectHardFilter = 0;
        scanWindowStats.rejectScore = 0;
        scanWindowStats.rejectMath = 0;
        scanWindowStats.rejectGatekeeper = 0;
        scanWindowStats.ordersDispatched = 0;

        const missingNote = missingLvlCount > 0 ? ` (chưa có mốc: ${missingLvlCount})` : '';
        log.system(
          `[AutoTrade] 🟢 Nhịp tim 15p | Theo dõi: ${activeCoinList.length} coin | Sát mốc (<=0.5%): ${scanNearby.length} coin${missingNote} | ` +
          `Quét: ${st.pollCycles} poll + ${st.wsTicks} WS (${st.coinsChecked} lượt coin) | 369: ${st.signals369} | ` +
          `Lọc: Hard/Grid=${st.rejectHardFilter}, Điểm=${st.rejectScore}, R:R=${st.rejectMath}, AI/Gate=${st.rejectGatekeeper} | Vào lệnh: ${st.ordersDispatched}`
        );

        // Báo cáo Shadow PnL định kỳ
        let shadowLine = '';
        try {
          const shadowStats = getShadowStats();
          if (shadowStats.totalResolved > 0 || shadowStats.activePositionsCount > 0) {
            const beStr = shadowStats.totalSavedBE > 0 ? ` | Thoát BE: ${shadowStats.totalSavedBE} lệnh` : '';
            log.system(`[Shadow PnL] 📊 Thống kê AI Veto: Đang theo dõi: ${shadowStats.activePositionsCount} lệnh | Đã cứu SL: ${shadowStats.totalSavedSL} lệnh (+$${shadowStats.totalSavedUSD})${beStr} | Bỏ lỡ TP: ${shadowStats.totalMissedTP} lệnh (-$${shadowStats.totalMissedUSD}) | Giá trị AI ròng: +$${shadowStats.netValueUSD} USD (Độ chính xác Veto: ${shadowStats.aiVetoAccuracyPct}%)`);
            shadowLine = `\n👁️ Shadow Veto: <b>${shadowStats.activePositionsCount}</b> đang theo dõi · Cứu SL <b>${shadowStats.totalSavedSL}</b> / Bỏ lỡ TP <b>${shadowStats.totalMissedTP}</b> (${shadowStats.aiVetoAccuracyPct}%)`;
          }
        } catch (_) { }

        if (process.env.ENABLE_HEARTBEAT_TELEGRAM !== 'false') {
          const openPosCount = activePositionsMap.size;
          const pendingOrdCount = activeOrdersMap.size;
          const hbMsg =
            `💓 <b>NHỊP TIM QUÉT 15 PHÚT — BOT-H4</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `📡 Theo dõi: <b>${activeCoinList.length} coin</b> | Sát mốc (≤0.5%): <b>${scanNearby.length} coin</b> | Vị thế: <b>${openPosCount}</b> (chờ LIMIT: <b>${pendingOrdCount}</b>)\n` +
            `🔍 Đã quét: <b>${st.pollCycles} lượt</b> (Polling) + <b>${st.wsTicks} tick</b> (WS 0ms) · <b>${st.coinsChecked}</b> lượt coin\n` +
            `📐 Tín hiệu 369: <b>${st.signals369}</b>\n` +
            `🛑 Bị lọc: Hard/Grid <b>${st.rejectHardFilter}</b> · Điểm <b>${st.rejectScore}</b> · R:R/SLTP <b>${st.rejectMath}</b> · AI/Gate <b>${st.rejectGatekeeper}</b>\n` +
            `🚀 Đẩy vào lệnh: <b>${st.ordersDispatched}</b>` +
            shadowLine;
          sendTelegram(hbMsg).catch(() => { });
        }
      }

      if (scanNearby.length) {
        // Dọn bộ nhớ xoay vòng quá hạn (> 5 phút)
        for (const [k, v] of recentPollingScan.entries()) {
          if (nowTime - v.ts > 5 * 60 * 1000) recentPollingScan.delete(k);
        }

        // Lọc sẵn coin chắc chắn không vào lệnh & xoay vòng Top 8 cuốn chiếu (TTL 2 phút) để không bị kẹt lặp lại 8 coin cũ
        const eligibleNearby = [];
        for (const sym of scanNearby) {
          if (processingSymbols.has(sym) || isShadowPositionActive(sym) || isSymbolInCooldown(sym)) continue;
          const p = getMarkPrice(sym);
          const lv = levelCache[sym];
          if (!p || !lv?.longEntry || !lv?.shortEntry) continue;

          const dLong = Math.abs(p - lv.longEntry) / p;
          const dShort = Math.abs(lv.shortEntry - p) / p;
          const nearestDir = dLong <= dShort ? 'LONG' : 'SHORT';
          const nearestLevel = nearestDir === 'LONG' ? lv.longEntry : lv.shortEntry;
          const distPct = Math.min(dLong, dShort);

          const activeDir = getActiveTradeDirection(sym);
          if (activeDir) {
            if (activeDir === 'UNKNOWN' || activeDir === nearestDir) continue;
            if ((reversalAlertCooldown[sym] || 0) + REVERSAL_ALERT_COOLDOWN_MS > nowTime) continue;
          }

          const prevScan = recentPollingScan.get(sym);
          if (prevScan && prevScan.level === nearestLevel && (nowTime - prevScan.ts) < POLL_ROTATION_TTL_MS) continue;

          eligibleNearby.push({ sym, p, distPct, nearestLevel });
        }

        eligibleNearby.sort((a, b) => a.distPct - b.distPct);
        for (const item of eligibleNearby.slice(0, 8)) {
          recentPollingScan.set(item.sym, { level: item.nearestLevel, ts: nowTime });
          enqueueSymbolSignal(client, item.sym, item.p, leverageInfo, leverage, coins);
        }
      }

      // Rà soát hàng chờ Đảo Chiều (Pending Reversal Auto-Entry)
      await checkPendingReversalAutoEntry();
    } catch (err) {
      log.warn(`[AutoTrade] Lỗi trong chu kỳ scan: ${err.message}`);
    } finally {
      isScanning = false;
    }
  }

  // ─── CONCURRENCY POOL & POLLING ROTATION FOR SIGNAL CHECKS ───────────────
  const MAX_CONCURRENT_SIGNAL_CHECKS = 1;
  const MAX_SIGNAL_QUEUE_LEN = 12;
  const POLL_ROTATION_TTL_MS = parseInt(process.env.POLL_ROTATION_TTL_MS || String(2 * 60 * 1000), 10); // 2 phút xoay vòng sang 8 coin tiếp theo
  const recentPollingScan = new Map(); // sym -> { level, ts }
  let activeSignalChecks = 0;
  const signalCheckQueue = [];

  function enqueueSymbolSignal(client, sym, markPrice, leverageInfo, leverage, coins) {
    if (isIpBanned()) return;
    if (!sym || !markPrice || processingSymbols.has(sym) || isShadowPositionActive(sym)) return;

    // Nếu symbol đang active: chỉ cho phép enqueue nếu tiệm cận mốc NGƯỢC CHIỀU và chưa dính cooldown đảo chiều
    const activeDir = getActiveTradeDirection(sym);
    if (activeDir) {
      if (activeDir === 'UNKNOWN') return;
      const now = Date.now();
      if ((reversalAlertCooldown[sym] || 0) + REVERSAL_ALERT_COOLDOWN_MS > now) {
        return; // Đã cảnh báo đảo chiều trong 30p qua → bỏ qua
      }

      // Kiểm tra xem có đang ở mốc đối diện không
      const levelCache = getLevelCache();
      const levels = levelCache ? levelCache[sym] : null;
      if (levels?.longEntry && levels?.shortEntry) {
        const nearTol = markPrice * 0.005; // 0.5%
        const nearLong = Math.abs(markPrice - levels.longEntry) <= nearTol;
        const nearShort = Math.abs(levels.shortEntry - markPrice) <= nearTol;
        const isOppositeNear = (activeDir === 'LONG' && nearShort) || (activeDir === 'SHORT' && nearLong);
        if (!isOppositeNear) return; // Đang ở mốc cùng chiều hoặc ở giữa → bỏ qua
      }
    }

    if (signalCheckQueue.some(item => item.sym === sym)) return;
    // Giới hạn hàng đợi tối đa 12 mã để chống tích backlog & stale markPrice khi BTC giật mạnh
    if (signalCheckQueue.length >= MAX_SIGNAL_QUEUE_LEN) return;

    signalCheckQueue.push({ client, sym, markPrice, leverageInfo, leverage, coins });
    processSignalQueue();
  }

  function processSignalQueue() {
    if (activeSignalChecks >= MAX_CONCURRENT_SIGNAL_CHECKS || signalCheckQueue.length === 0) return;

    const task = signalCheckQueue.shift();
    if (!task) return;

    activeSignalChecks++;
    const freshMarkPrice = getMarkPrice(task.sym) || task.markPrice;
    processSymbolSignal(task.client, task.sym, freshMarkPrice, task.leverageInfo, task.leverage, task.coins)
      .catch(err => {
        log.warn(`[AutoTrade] Queue error for ${task.sym}: ${err.message}`);
      })
      .finally(() => {
        activeSignalChecks--;
        setTimeout(processSignalQueue, 600); // Sleep 600ms giữa các symbol để bảo đảm an toàn API và giãn cách weight Binance
      });
  }

  async function handleReversalSignal(sym, activeDir, sig, markPrice) {
    try {
      let taSymbol = null;
      let btcTA = null;
      let fundingMap = {};
      let onDemand = { whaleData: null, derivatives: null, fearGreed: null };

      try {
        [taSymbol, btcTA, fundingMap, onDemand] = await Promise.all([
          getSymbolTA(sym),
          getBtcTA(),
          getBinanceFundingRates(),
          getOnDemandMarketData(sym)
        ]);
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi nạp dữ liệu on-demand đảo chiều cho ${sym}: ${e.message}`);
      }

      const fundingRate = fundingMap ? fundingMap[sym] : null;
      const whaleData = onDemand?.whaleData || null;
      const derivatives = onDemand?.derivatives || null;
      const fearGreed = onDemand?.fearGreed || null;

      // Chấm điểm Confluence Scorer cho setup ngược chiều
      const scoreRes = scoreSetup(sym, sig.signal, taSymbol, whaleData, derivatives, fundingRate, fearGreed, null, btcTA, sig);
      const score = scoreRes.total;
      const reasons = scoreRes.reasons || [];
      const verdict = scoreRes.verdict || '';
      const confidence = scoreRes.confidence || 0;

      log.system(`[AutoTrade] 🔍 [Check Đảo Chiều] ${sym}: Đang có ${activeDir} | Tín hiệu ${sig.signal} @ $${sig.targetLevel} đạt ${score.toFixed(1)}đ [${verdict}] (Cần >= ${MIN_SCORE_REVERSAL}đ)`);

      if (score >= MIN_SCORE_REVERSAL) {
        reversalAlertCooldown[sym] = Date.now();

        // Tính toán thông số TP/SL động và lưu vào hàng chờ Đảo Chiều (Pending Reversal)
        let tierSetup = null;
        try {
          const rank = getMarketCapRank ? getMarketCapRank(sym) : 999;
          const h4Ref = await fetchH4Reference(sym);
          const tickSize = getEffectiveTickSize(sym, sig.targetLevel);
          const maxAllowed = (typeof leverageInfo[sym] === 'number' ? leverageInfo[sym] : leverageInfo[sym]?.maxLeverage) || 10;
          const tradeAmount = await getDynamicMargin(isTop50Symbol(sym), client);
          tierSetup = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4Ref, tickSize, maxAllowed, 3.0, 1.5, rank, sig.gridWidthPct, null, tradeAmount);
        } catch (_) { }

        if (!tierSetup || !tierSetup.valid) {
          log.system(`[AutoTrade] 🛑 [Bỏ qua Đảo Chiều] ${sym} (${sig.signal}): calculateTierSLTP từ chối (${tierSetup?.reason || 'INVALID_SETUP'}) — không fallback 10x.`);
          return;
        }
        const step = sig.step || getStep(sig.targetLevel);
        const slPrice = tierSetup.slPrice;
        const tpPrice = tierSetup.tpPrice;
        const leverage = tierSetup.leverage;
        const margin = tierSetup.margin;

        pendingReversals[sym] = {
          symbol: sym,
          direction: sig.signal,
          entryPrice: sig.targetLevel,
          slPrice: slPrice,
          tpPrice: tpPrice,
          beTriggerPrice: tierSetup?.beTriggerPrice || null,
          step: step,
          gridWidthPct: sig.gridWidthPct || ((step / sig.targetLevel) * 100),
          leverage: leverage,
          margin: margin,
          score: score,
          scoreReasons: reasons,
          confidence: confidence,
          status: 'waiting_old_close', // Chờ đóng lệnh cũ trên sàn
          savedAt: Date.now(),
          activatedAt: null,
        };
        savePendingReversals();

        const activeIcon = activeDir === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        const revIcon = sig.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        const reasonLines = (reasons || []).slice(0, 5)
          .map(r => `  • ${String(r).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`)
          .join('\n');

        const msg =
          `🔁 <b>[CẢNH BÁO ĐẢO CHIỀU] — #${sym}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📤 <b>Vị thế đang giữ:</b> ${activeIcon} trên sàn\n` +
          `📥 <b>Tín hiệu đối diện:</b> ${revIcon} tại <code>$${sig.targetLevel}</code> (Giá hiện tại: <code>$${markPrice}</code>)\n` +
          `⭐ <b>Điểm Confluence:</b> <b>${score.toFixed(1)}đ</b> [${verdict}] · Độ tin cậy: <b>${confidence}%</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          (reasonLines ? `🧠 <b>Căn cứ hợp lưu:</b>\n${reasonLines}\n━━━━━━━━━━━━━━━━\n` : '') +
          `⚠️ <b>Khuyến nghị:</b>\n` +
          `Nếu đang giữ lệnh ${activeIcon} trên sàn, hãy chủ động cân nhắc chốt lời hoặc đóng vị thế để bảo toàn vốn.\n\n` +
          `⏳ <b>Đã lưu vào hàng chờ Đảo Chiều:</b> Khi bạn đóng vị thế cũ, bot sẽ tự động rà soát để vào lệnh MARKET khi giá thỏa mãn điều kiện (không đuổi giá xấu và chưa chạm SL).\n\n` +
          `<i>🤖 Bot <b>KHÔNG</b> tự đặt lệnh ${revIcon} và <b>KHÔNG</b> tự hủy lệnh ${activeIcon} trên sàn.</i>`;

        sendTelegram(msg).catch(err => {
          log.warn(`[AutoTrade] Không thể gửi cảnh báo đảo chiều Telegram cho ${sym}: ${err.message}`);
        });

        log.system(`[AutoTrade] 🔁 [ĐÃ GỬI CẢNH BÁO ĐẢO CHIỀU & LƯU HÀNG CHỜ] ${sym}: ${activeDir} → ${sig.signal} (${score.toFixed(1)}đ >= ${MIN_SCORE_REVERSAL}đ)`);
      } else {
        log.system(`[AutoTrade] 🛑 [Bỏ qua Đảo Chiều] ${sym}: Tín hiệu ${sig.signal} chỉ đạt ${score.toFixed(1)}đ < ${MIN_SCORE_REVERSAL}đ → Bỏ qua`);
      }
    } catch (err) {
      log.warn(`[AutoTrade] Lỗi trong handleReversalSignal cho ${sym}: ${err.message}`);
    }
  }

  // ── RÀ SOÁT TỰ ĐỘNG VÀO LỆNH ĐẢO CHIỀU (Check Pending Auto-Entry giống bot-new) ──
  const inFlightReversals = new Set(); // Mutex chống WS tick và scan() bắn trùng lệnh MARKET
  async function checkPendingReversalAutoEntry() {
    const activePending = Object.entries(pendingReversals).filter(([_, r]) => r && r.status === 'pending_entry');
    if (!activePending.length) return;

    const REVERSAL_ENTRY_EXPIRY_MS = parseInt(process.env.REVERSAL_ENTRY_EXPIRY_MS || String(4 * 3600 * 1000), 10);
    const now = Date.now();

    for (const [sym, rev] of activePending) {
      if (inFlightReversals.has(sym)) continue;
      // 1. Kiểm tra hết hạn: Quá 4 tiếng không về entry -> Tự hủy
      if (now - (rev.activatedAt || rev.savedAt) > REVERSAL_ENTRY_EXPIRY_MS) {
        log.system(`[AutoTrade] ⏰ [HẾT HẠN ĐẢO CHIỀU] ${sym} ${rev.direction} quá 4h không về vùng entry -> Hủy setup`);
        delete pendingReversals[sym];
        savePendingReversals();
        sendTelegram(
          `⏰ <b>[HẾT HẠN ĐẢO CHIỀU] — #${sym} ${rev.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `💰 Entry mục tiêu: <code>$${fmtPrice(rev.entryPrice)}</code>\n` +
          `⌛ Đã chờ 4h nhưng giá không về vùng entry.\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<i>🤖 Bot tự hủy setup này để tránh vào lệnh muộn khi thị trường đã thay đổi.</i>`
        ).catch(() => { });
        continue;
      }

      const currentPrice = getMarkPrice(sym);
      if (!currentPrice || currentPrice <= 0) continue;

      const isLong = rev.direction === 'LONG';

      // 2. Chốt chặn kiểm soát giá khắt khe (GIỐNG BOT-NEW)
      // Điều kiện 1: Giá KHÔNG ĐƯỢC XẤU HƠN entry
      if (isLong && currentPrice > rev.entryPrice * 1.001) continue; // LONG: giá phải <= entry
      if (!isLong && currentPrice < rev.entryPrice * 0.999) continue; // SHORT: giá phải >= entry (không đuổi giá rơi sâu)

      // Điều kiện 2: Phải còn >= 50% khoảng cách tới SL (chống vào MARKET sát SL khi mốc đã gãy sâu)
      const origSlDist = Math.abs(rev.entryPrice - rev.slPrice);
      const remSlDist = isLong ? (currentPrice - rev.slPrice) : (rev.slPrice - currentPrice);
      if (origSlDist <= 0 || remSlDist < origSlDist * 0.50) continue;

      // Điều kiện 2b: Tái kiểm tra toàn bộ chốt chặn rủi ro trước khi bắn MARKET đảo chiều
      if (isSymbolInCooldown(sym)) continue;
      if (isDirectionLocked(rev.direction)?.isLocked) continue;
      if (isRealTradingSuspended()?.isSuspended) continue;
      const btcFlashRevCheck = checkBtcFlashGatekeeper(rev.direction);
      if (btcFlashRevCheck?.isBlocked) continue;

      inFlightReversals.add(sym);
      try {
        // 3. Kiểm tra balance
        if (!isShadowMode && client) {
          let balance = 0;
          try {
            balance = await client.getBalance();
          } catch (_) { }
          if (balance < (rev.margin || 10)) {
            log.warn(`[AutoTrade] Reversal auto-entry: ${sym} không đủ balance ($${balance.toFixed(2)} < $${rev.margin})`);
            continue;
          }
        }

        // 4. Thực thi vào lệnh MARKET trên sàn
        const effectiveLev = rev.leverage || 10;
        if (!isShadowMode && client) {
          try { await client.setLeverage(sym, effectiveLev); } catch (_) { }
        }

        const currentNotional = (rev.margin || 10) * effectiveLev;
        const { qty } = calcQuantity(sym, currentNotional, currentPrice);
        if (qty <= 0) {
          log.warn(`[AutoTrade] Reversal auto-entry: ${sym} quantity <= 0`);
          continue;
        }

        const side = isLong ? 'BUY' : 'SELL';
        let order;
        if (!isShadowMode && client) {
          order = await client.placeMarket(sym, side, qty);
          if (!order) continue;
        } else {
          order = { orderId: `shadow_rev_${Date.now()}`, status: 'FILLED' };
        }

        activeSymbols.add(sym);
        activePositionsMap.set(sym, {
          direction: rev.direction,
          positionAmt: isLong ? qty : -qty,
          entryPrice: currentPrice
        });

        const posGridPct = (rev.step / currentPrice) * 100;
        activeTradesMetadata[sym] = {
          score: rev.score,
          isCounterTrend: false,
          entryPrice: currentPrice,
          side,
          gridWidthPct: rev.gridWidthPct || posGridPct,
          gridStepPct: posGridPct,
          step: rev.step || getStep(currentPrice),
          orderId: null,
          isFilled: true,
          hasNotifiedFill: true,
          fillTime: Date.now(),
          maxFavorablePrice: currentPrice,
          time: Date.now(),
          markPrice: currentPrice,
          scoreReasons: rev.scoreReasons,
          leverage: effectiveLev,
          margin: rev.margin,
          tierSlPrice: rev.slPrice,
          tierTpPrice: rev.tpPrice,
          beTriggerPrice: rev.beTriggerPrice,
        };
        saveActiveTradesMetadata();

        // Đặt Dual Bracket (TP Limit & SL Stop Market) trực tiếp lên sàn Binance
        if (!isShadowMode && client && rev.tpPrice && rev.slPrice) {
          await placeDualBracket({
            client,
            sym,
            side,
            qty,
            entryPrice: currentPrice,
            targetPrice: rev.tpPrice,
            slPrice: rev.slPrice,
            meta: activeTradesMetadata[sym]
          });
          saveActiveTradesMetadata();
        }

        delete pendingReversals[sym];
        savePendingReversals();

        const dirIcon = isLong ? '🟢 LONG' : '🔴 SHORT';
        const improvePct = isLong
          ? ((rev.entryPrice - currentPrice) / rev.entryPrice * 100).toFixed(2)
          : ((currentPrice - rev.entryPrice) / rev.entryPrice * 100).toFixed(2);
        const improveText = Number(improvePct) > 0 ? `  <i>(giá tốt hơn entry ban đầu ${improvePct}%)</i>` : '';

        sendTelegram(
          `🚀 <b>[VÀO LỆNH ĐẢO CHIỀU THÀNH CÔNG] — #${sym} ${dirIcon} ⚡x${effectiveLev}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `💹 Khớp MARKET tại: <code>$${fmtPrice(currentPrice)}</code>${improveText}\n` +
          `🎯 Chốt lời (TP):   <code>$${fmtPrice(rev.tpPrice)}</code>\n` +
          `🛑 Cắt lỗ (SL):     <code>$${fmtPrice(rev.slPrice)}</code>\n` +
          `💰 Ký quỹ:         <b>$${rev.margin}</b> | Qty: <b>${qty}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<i>🤖 Đã tự động đặt cặp lệnh bảo vệ kép Dual Bracket (TP/SL) trên Binance!</i>`
        ).catch(() => { });

        log.system(`[AutoTrade] 🚀 [ĐẢO CHIỀU MARKET FILL] ${sym} ${side} ${qty} @ $${currentPrice}`);
      } catch (err) {
        log.warn(`[AutoTrade] Lỗi thực thi reversal auto-entry cho ${sym}: ${err.message}`);
      } finally {
        inFlightReversals.delete(sym);
      }
    }
  }

  async function processSymbolSignal(client, sym, markPrice, leverageInfo, leverage, coins) {
    if (isIpBanned()) return;
    if (!sym || !markPrice || processingSymbols.has(sym)) return;
    // Khóa symbol ngay lập tức — trước mọi await — để chặn duplicate từ Luồng 1 + Luồng 2
    processingSymbols.add(sym);
    scanWindowStats.coinsChecked++;
    try {
      const activeDir = getActiveTradeDirection(sym);
      if (activeDir === 'UNKNOWN') return;

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
      scanWindowStats.signals369++;

      // ── CHỐT CHẶN VỊ THẾ ACTIVE: XỬ LÝ LỆNH CÙNG CHIỀU VS ĐẢO CHIỀU ──
      if (activeDir) {
        if (sig.signal === activeDir) {
          // Cùng chiều: Đang có lệnh/vị thế active → Bỏ qua ngay lập tức, không vào lệnh trùng
          return;
        }

        // Ngược chiều: Tín hiệu đảo chiều!
        const now = Date.now();
        if (now - (reversalAlertCooldown[sym] || 0) < REVERSAL_ALERT_COOLDOWN_MS) {
          return; // Vẫn trong cooldown cảnh báo 30 phút → bỏ qua
        }

        // Chấm điểm và cảnh báo đảo chiều
        await handleReversalSignal(sym, activeDir, sig, markPrice);
        return; // LUÔN RETURN — Tuyệt đối không đặt lệnh mới và không hủy lệnh cũ trên Binance!
      }

      // ── TẦNG 1: PHÂN TẦNG DANH MỤC & QUY MÔ VỐN (Tier 1 vs Tier 2) ──
      const isTier1 = isTop50Symbol(sym);
      const rank = getMarketCapRank ? getMarketCapRank(sym) : 999;
      const tradeAmount = await getDynamicMargin(isTier1, client);
      const minRequiredScore = isTier1
        ? parseFloat(process.env.MIN_CONFLUENCE_SCORE_TIER1 || process.env.MIN_CONFLUENCE_SCORE || '7.0')
        : parseFloat(process.env.MIN_CONFLUENCE_SCORE_TIER2 || '8.0');
      const rankTierLabel = isTier1 ? `Tier 1 Top 50 (Rank #${rank})` : `Tier 2 Altcoin (Rank #${rank})`;

      const gridStepPct = (sig.step / sig.targetLevel) * 100;
      sig.marketCapRank = rank;
      sig.gridWidthPct = gridStepPct;
      sig.margin = tradeAmount;

      // ── SÀN AN TOÀN VẬT LÝ ĐỘ RỘNG GRID (SANITY GUARD) ──
      // Bỏ qua ngay các mốc có biên độ quá hẹp không thể giao dịch an toàn (tránh bẫy nhiễu nến cắn SL)
      const minGridPct = getMinGridPct(sym);
      if (gridStepPct < minGridPct || gridStepPct > GRID_MAX_PCT) {
        scanWindowStats.rejectHardFilter++;
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'grid_untradable', 30 * 60 * 1000)) {
          log.system(
            `[AutoTrade] 🛑 Bỏ qua ${sym} (${sig.signal}): Độ rộng lưới không hợp lệ (${gridStepPct.toFixed(2)}% ` +
            `${gridStepPct < minGridPct ? `< sàn tối thiểu ${minGridPct}%` : `> trần tối đa ${GRID_MAX_PCT}%`}) ` +
            `— Cấu trúc mốc không thể giao dịch an toàn (Untradable Grid).`
          );
        }
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'rec_grid_untradable')) {
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: sig.score ?? 0,
            scoreReasons: sig.scoreReasons || [],
            skipReason: gridStepPct < minGridPct ? 'GRID_TOO_NARROW_UNTRADABLE' : 'GRID_TOO_WIDE_UNTRADABLE',
            markPrice: markPrice,
            marketCapRank: rank,
          });
        }
        return;
      }

      // ── TẬP HỢP DỮ LIỆU ĐA TẦNG CHO BỘ LỌC COIN 4 TẦNG (PHASE 2 & 3) ──
      let taSymbol = null;
      let btcTA = null;
      let fundingMap = {};
      let onDemand = { whaleData: null, derivatives: null, fearGreed: null };
      try {
        [taSymbol, btcTA, fundingMap, onDemand] = await Promise.all([
          getSymbolTA(sym),
          getBtcTA(),
          getBinanceFundingRates(),
          getOnDemandMarketData(sym)
        ]);
      } catch (e) {
        log.warn(`[AutoTrade] Lỗi nạp dữ liệu on-demand cho ${sym}: ${e.message}`);
      }
      const fundingRate = fundingMap ? fundingMap[sym] : null;
      const whaleData = onDemand?.whaleData || null;
      const derivatives = onDemand?.derivatives || null;
      const fearGreed = onDemand?.fearGreed || null;

      // ── TẦNG 2: BỘ LỌC CỨNG TIÊN QUYẾT (HARD FILTERS - FAIL FAST) ──
      const hardFilterReason = checkHardFilters(sym, sig.signal, taSymbol, fundingRate, whaleData, btcTA);
      if (hardFilterReason) {
        scanWindowStats.rejectHardFilter++;
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'hard_filter_veto', 10 * 60 * 1000)) {
          log.system(`[AutoTrade] 🛑 [Hard Filter DISQUALIFIED] ${sym} (${sig.signal}): ${hardFilterReason}`);
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: 0,
            scoreReasons: [hardFilterReason],
            skipReason: 'HARD_FILTER_DISQUALIFIED',
            markPrice: markPrice,
            marketCapRank: rank,
          });
        }
        return;
      }

      // ── TẦNG 3: BỘ CHẤM ĐIỂM HỢP LƯU ĐỊNH LƯỢNG (DETERMINISTIC CONFLUENCE SCORER 0 - 10đ) ──
      let scoreRes = null;
      try {
        scoreRes = scoreSetup(sym, sig.signal, taSymbol, whaleData, derivatives, fundingRate, fearGreed, null, btcTA, sig);
        sig.score = scoreRes.total;
        sig.scoreReasons = scoreRes.reasons;
        sig.confluenceVerdict = scoreRes.verdict;
        sig.confluenceConfidence = scoreRes.confidence;
      } catch (err) {
        log.warn(`[AutoTrade] Lỗi tính Confluence Scorer cho ${sym}: ${err.message}`);
        sig.score = 0;
        sig.scoreReasons = [];
      }

      // ── CHỐT CHẶN ĐIỂM CỨNG (HARD SCORE GATE): VETO NGAY LẬP TỨC NẾU KHÔNG ĐẠT ──
      if (sig.score < minRequiredScore) {
        scanWindowStats.rejectScore++;
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'hard_score_gate', 10 * 60 * 1000)) {
          log.system(
            `[AutoTrade] 🛑 [Confluence Filter] ${sym} (${sig.signal}): Score ${sig.score.toFixed(1)}đ < ${minRequiredScore}đ [${rankTierLabel}] — Bỏ qua (Chưa đủ điểm)`
          );
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: sig.score,
            scoreReasons: sig.scoreReasons,
            skipReason: 'HARD_SCORE_GATE_VETO',
            markPrice: markPrice,
            marketCapRank: rank,
          });
        }
        return;
      }

      const isNewSignalLog = _shouldLogSignal(sym, sig.signal, sig.targetLevel, 'detected');
      if (isNewSignalLog) {
        log.system(
          `[AutoTrade] 🎯 [CONFLUENCE PASS] ${sym} → ${sig.signal} (${sig.score.toFixed(1)}đ >= ${minRequiredScore}đ [${rankTierLabel}] | Ký quỹ: $${tradeAmount}) tại $${sig.targetLevel}`
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
          log.system(`[AutoTrade] 🛑 ${sym} ${sig.signal} @ $${sig.targetLevel} vừa bị Bounce Cancel (đang trong Cooldown 20p) — bỏ qua khuyến nghị`);
        }
        return;
      }

      // Chặn đăng ký Shadow trùng nếu coin đã có lệnh/vị thế thật đang chạy trên bot-h4
      if (activeTradesMetadata[sym] && !activeTradesMetadata[sym].isClosed) {
        activeSymbols.add(sym);
        return;
      }

      // ── SL COOLDOWN GUARD: Tránh tái vào lệnh liên tục sau khi dính SL ──
      if (isSymbolInCooldown(sym)) {
        const remH = getRemainingCooldownHours(sym);
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'cooldown_active', 30 * 60 * 1000)) {
          log.system(`[AutoTrade] ⏸️ ${sym} đang trong thời gian SL Cooldown (${remH}h còn lại) — Đăng ký Shadow theo dõi nhịp hồi phục.`);
        }
        // Đăng ký vị thế Shadow với thông số thực tế để AI theo dõi PnL hồi phục của coin này
        let prelimSetupCd = null;
        try {
          const h4RefCd = await fetchH4Reference(sym);
          const tickSizeCd = getEffectiveTickSize(sym, sig.targetLevel);
          const maxAllowedCd = leverageInfo[sym] ?? leverage;
          const baseTargetLossUSDCd = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '3.0');
          prelimSetupCd = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4RefCd, tickSizeCd, maxAllowedCd, baseTargetLossUSDCd, 1.5, rank, sig.gridWidthPct);
        } catch (_) { }

        registerShadowTrade(sig, null, {
          markPrice,
          marketCapRank: rank,
          gridWidthPct: sig.gridWidthPct || gridStepPct,
          leverage: prelimSetupCd?.leverage,
          margin: prelimSetupCd?.margin,
          tierSlPrice: prelimSetupCd?.slPrice,
          tierTpPrice: prelimSetupCd?.tpPrice,
          beTriggerPrice: prelimSetupCd?.beTriggerPrice,
          slPct: prelimSetupCd?.slPct,
          signalMetrics: sig.signalMetrics || null
        });
        return;
      }

      // ── DIRECTIONAL CIRCUIT BREAKER: Kiểm tra xem chiều này có đang bị ngắt mạch không ──
      const dirCheck = isDirectionLocked(sig.signal);
      if (dirCheck.isLocked) {
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'dir_circuit_breaker', 15 * 60 * 1000)) {
          log.system(`[AutoTrade] 🛑 [Directional Circuit Breaker] Chiều ${sig.signal} đang bị khóa (${dirCheck.reason} - còn ${dirCheck.remainingMinutes}p) — Chuyển sang theo dõi Shadow ${sym} để dò nhịp hồi phục.`);
        }

        // Đăng ký vị thế Shadow để AI thăm dò nhiệt độ thị trường mà không rủi ro vốn thật
        let prelimSetupDir = null;
        try {
          const h4RefDir = await fetchH4Reference(sym);
          const tickSizeDir = getEffectiveTickSize(sym, sig.targetLevel);
          const maxAllowedDir = leverageInfo[sym] ?? leverage;
          const baseTargetLossUSDDir = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '3.0');
          prelimSetupDir = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4RefDir, tickSizeDir, maxAllowedDir, baseTargetLossUSDDir, 1.5, rank, sig.gridWidthPct);
        } catch (_) { }

        registerShadowTrade(sig, null, {
          markPrice,
          marketCapRank: rank,
          gridWidthPct: sig.gridWidthPct || gridStepPct,
          leverage: prelimSetupDir?.leverage,
          margin: prelimSetupDir?.margin,
          tierSlPrice: prelimSetupDir?.slPrice,
          tierTpPrice: prelimSetupDir?.tpPrice,
          beTriggerPrice: prelimSetupDir?.beTriggerPrice,
          slPct: prelimSetupDir?.slPct,
          signalMetrics: sig.signalMetrics || null
        });
        return;
      }

      // ── ROLLING PERFORMANCE GUARD: Kiểm tra bot có đang trong Stand-Down Mode không ──
      const suspendCheck = isRealTradingSuspended();
      if (suspendCheck.isSuspended) {
        if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stand_down_mode', 15 * 60 * 1000)) {
          log.system(`[AutoTrade] 🛑 [Stand-Down Mode] Tạm dừng tiền thật do AI đang lệch pha (${suspendCheck.reason} - còn ${suspendCheck.remainingMinutes}p, đã test ${suspendCheck.shadowCount}/3 lệnh Shadow) — Chuyển sang theo dõi Shadow ${sym}.`);
        }

        let prelimSetupSd = null;
        try {
          const h4RefSd = await fetchH4Reference(sym);
          const tickSizeSd = getEffectiveTickSize(sym, sig.targetLevel);
          const maxAllowedSd = leverageInfo[sym] ?? leverage;
          const baseTargetLossUSDSd = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '3.0');
          prelimSetupSd = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4RefSd, tickSizeSd, maxAllowedSd, baseTargetLossUSDSd, 1.5, rank, sig.gridWidthPct);
        } catch (_) { }

        registerShadowTrade(sig, null, {
          markPrice,
          marketCapRank: rank,
          gridWidthPct: sig.gridWidthPct || gridStepPct,
          leverage: prelimSetupSd?.leverage,
          margin: prelimSetupSd?.margin,
          tierSlPrice: prelimSetupSd?.slPrice,
          tierTpPrice: prelimSetupSd?.tpPrice,
          beTriggerPrice: prelimSetupSd?.beTriggerPrice,
          slPct: prelimSetupSd?.slPct,
          signalMetrics: sig.signalMetrics || null
        });
        return;
      }

      // ── BTC FLASH & TURNOVER GUARD: Chuyển giao toàn quyền thẩm định cho Lõi AI Reviewer ──
      const btcFlashCheck = checkBtcFlashGatekeeper(sig.signal);
      const turnoverCheck = checkTurnoverGuard(sym);

      // 🛡️ PENDING LIMIT MUTUAL EXCLUSION: Khóa nếu symbol đã có lệnh/vị thế trong RAM
      if (activeTradesMetadata[sym]) {
        log.system(`[AutoTrade] 🛑 ${sym} đang có lệnh/vị thế (${activeTradesMetadata[sym].side} @ $${activeTradesMetadata[sym].entryPrice}) trong activeTradesMetadata — bỏ qua.`);
        activeSymbols.add(sym);
        return;
      }

      if (!isShadowMode && client) {
        try {
          const hasPos = await client.hasOpenPosition(sym);
          if (hasPos) {
            log.system(`[AutoTrade] ${sym} đang có vị thế mở trên sàn — bỏ qua`);
            activeSymbols.add(sym);
            return;
          }

          // 🛡️ PENDING LIMIT MUTUAL EXCLUSION: Kiểm tra lệnh LIMIT đang chờ trên sàn
          const openOrders = await client.getOpenOrders(sym);
          if (Array.isArray(openOrders) && openOrders.length > 0) {
            const pendingOrder = openOrders.find(o => o.type === 'LIMIT' && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'));
            if (pendingOrder) {
              log.system(`[AutoTrade] 🛑 ${sym} đang có lệnh LIMIT (${pendingOrder.side} @ $${pendingOrder.price}) chờ khớp trên sàn — khóa không đặt thêm lệnh mới.`);
              activeSymbols.add(sym);
              activeOrdersMap.set(sym, pendingOrder.side === 'BUY' ? 'LONG' : 'SHORT');
              return;
            }
          }
        } catch (e) {
          log.warn(`[AutoTrade] Không check được vị thế/lệnh chờ ${sym}: ${_binanceErr(e)} — ngắt xử lý tín hiệu.`);
          return;
        }
      } else if (isShadowMode) {
        if (isShadowPositionActive(sym)) {
          log.system(`[AutoTrade] 👻 [Shadow] ${sym} đang có vị thế Shadow mở — bỏ qua`);
          return;
        }
      }

      // Ngưỡng nảy xa trước khi đặt lệnh (Pre-entry bounce): Thích ứng theo độ rộng Grid (min 1.50%, max 3.00%)
      const entryPrice = sig.targetLevel;
      const stepVal = sig.step || getStep(entryPrice);
      const unit = stepVal / 3;
      const effGridPct = (sig.gridWidthPct && sig.gridWidthPct > 0) ? sig.gridWidthPct : ((stepVal / entryPrice) * 100);
      const preEntryBouncePct = Math.min(Math.max(effGridPct * 0.35, 1.50), 3.00);
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

          maxRecentBouncePct = maxBouncePct;
          if (maxBouncePct >= preEntryBouncePct) {
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled')) {
              log.system(
                `[AutoTrade] ⚠️ ${sym} LONG: Đã nảy +${maxBouncePct.toFixed(2)}% từ mốc entry ($${bestTouchLow.toFixed(6)} → $${bestPeakHigh.toFixed(6)} >= ngưỡng an toàn ${preEntryBouncePct.toFixed(2)}%).`
              );
            }
          }
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

          maxRecentBouncePct = maxDropPct;
          if (maxDropPct >= preEntryBouncePct) {
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled')) {
              log.system(
                `[AutoTrade] ⚠️ ${sym} SHORT: Đã sụt -${maxDropPct.toFixed(2)}% từ mốc entry ($${bestTouchHigh.toFixed(6)} → $${bestTroughLow.toFixed(6)} >= ngưỡng an toàn ${preEntryBouncePct.toFixed(2)}%).`
              );
            }
          }
        }
      } else {
        if (sig.signal === 'LONG') {
          const bouncedAwayPct = ((markPrice - sig.targetLevel) / sig.targetLevel) * 100;
          maxRecentBouncePct = Math.max(0, bouncedAwayPct);
          if (bouncedAwayPct >= preEntryBouncePct) {
            if (_shouldLogSignal(sym, sig.signal, sig.targetLevel, 'stale_canceled_fallback')) {
              log.system(`[AutoTrade] ⚠️ ${sym} LONG đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} +${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%).`);
            }
          }
        } else if (sig.signal === 'SHORT') {
          const bouncedAwayPct = ((sig.targetLevel - markPrice) / sig.targetLevel) * 100;
          maxRecentBouncePct = Math.max(0, bouncedAwayPct);
          if (bouncedAwayPct >= preEntryBouncePct) {
            log.system(`[AutoTrade] ⚠️ ${sym} SHORT đã nảy xa mốc entry ($${sig.targetLevel} → $${markPrice.toFixed(6)} -${bouncedAwayPct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%).`);
          }
        }
      }

      sig.maxRecentBouncePct = maxRecentBouncePct;
      sig.preEntryBouncePct = preEntryBouncePct;

      if (!sig.scoreReasons) sig.scoreReasons = [];
      if (typeof maxRecentBouncePct === 'number') {
        const extremeTh = Math.max(3.0, preEntryBouncePct * 1.8);
        if (maxRecentBouncePct >= extremeTh) {
          sig.scoreReasons.push(`[Độ nảy M1] Giá nảy cực xa mốc trước khi vào lệnh (${maxRecentBouncePct.toFixed(2)}% >= ${extremeTh.toFixed(2)}% Khung)`);
        } else if (maxRecentBouncePct >= preEntryBouncePct) {
          sig.scoreReasons.push(`[Độ nảy M1] Giá đã nảy xa mốc trước khi vào lệnh (${maxRecentBouncePct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(2)}%)`);
        } else if (maxRecentBouncePct >= 0.50) {
          sig.scoreReasons.push(`[Độ nảy M1] Giá chớm nảy (${maxRecentBouncePct.toFixed(2)}% < ${preEntryBouncePct.toFixed(2)}%)`);
        } else {
          sig.scoreReasons.push(`[Độ nảy M1] Mốc mới, chưa bị nảy xa (${maxRecentBouncePct.toFixed(2)}%)`);
        }
      }

      // ── Tiêu chí 2: Đã gỡ bỏ bộ lọc chặn cứng MIN_CONFLUENCE_SCORE — Toàn quyền thẩm định trao cho AI Reviewer ──

      // ── Thu thập toàn bộ dữ liệu thị trường nạp vào Lõi AI Reviewer ──
      let rawMarketData = null;
      let klinesM15 = null;
      let m15VolRatio = 1.0;
      let m15RangePct = 0.0;
      let klinesH1 = null;
      try {
        klinesM15 = await fetchBinanceKlines(sym, '15m', null, 21);
        klinesH1 = await fetchBinanceKlines(sym, '1h', null, 25);
        const currM15 = klinesM15 && klinesM15.length > 0 ? klinesM15[klinesM15.length - 1] : null;
        const lastClosedM15 = klinesM15 && klinesM15.length > 1 ? klinesM15[klinesM15.length - 2] : null;
        const currH1 = klinesH1 && klinesH1.length > 0 ? klinesH1[klinesH1.length - 1] : null;
        const lastClosedH1 = klinesH1 && klinesH1.length > 1 ? klinesH1[klinesH1.length - 2] : null;

        if (currM15) {
          updateShadowPrices({
            [sym]: currM15.close
          });
        }

        if (klinesM15 && klinesM15.length >= 20 && currM15) {
          const past20 = klinesM15.slice(0, klinesM15.length - 1);
          const avgVol20 = past20.reduce((sum, c) => sum + c.volume, 0) / past20.length;
          m15VolRatio = avgVol20 > 0 ? (currM15.volume / avgVol20) : 1.0;
          m15RangePct = ((currM15.high - currM15.low) / (currM15.low || 1)) * 100;
        }

        let h1VolRatio = 1.0;
        if (klinesH1 && klinesH1.length >= 24 && currH1) {
          const past24 = klinesH1.slice(0, klinesH1.length - 1);
          const avgVol24 = past24.reduce((sum, c) => sum + c.volume, 0) / past24.length;
          h1VolRatio = avgVol24 > 0 ? (currH1.volume / avgVol24) : 1.0;
        }

        // Suy diễn btcWave & trend thực tế từ btcTA & taSymbol (sửa bug 100% lệnh bị aiReviewer gán cứng BTC_COUNTER / TREND_NEUTRAL)
        const isLongDir = sig.signal === 'LONG' || sig.signal === 'BUY';
        let derivedBtcWave = 'BTC_NEUTRAL';
        if (btcTA) {
          const btcBull = btcTA.trend === 'TĂNG MẠNH' || btcTA.trend === 'TĂNG' || btcTA.regime === 'TRENDING_UP';
          const btcBear = btcTA.trend === 'GIẢM MẠNH' || btcTA.trend === 'GIẢM' || btcTA.regime === 'TRENDING_DOWN';
          if ((isLongDir && btcBull) || (!isLongDir && btcBear)) derivedBtcWave = 'BTC_ALIGNED';
          else if ((isLongDir && btcBear) || (!isLongDir && btcBull)) derivedBtcWave = 'BTC_COUNTER';
        }
        let derivedTrend = 'TREND_NEUTRAL';
        if (taSymbol) {
          const symBull = taSymbol.trend === 'TĂNG MẠNH' || taSymbol.trend === 'TĂNG';
          const symBear = taSymbol.trend === 'GIẢM MẠNH' || taSymbol.trend === 'GIẢM';
          if ((isLongDir && symBull) || (!isLongDir && symBear)) {
            derivedTrend = (taSymbol.trend === 'TĂNG MẠNH' || taSymbol.trend === 'GIẢM MẠNH') ? 'TREND_PERFECT' : 'TREND_EMA';
          } else if ((isLongDir && symBear) || (!isLongDir && symBull)) {
            derivedTrend = 'TREND_CONFLICT';
          }
        }
        const btcM15Pct = (btcTA?.priceChange4h != null) ? Number((btcTA.priceChange4h / 4).toFixed(2)) : 0;

        rawMarketData = {
          lastM15: currM15,
          currM15,
          lastClosedM15,
          currH1,
          lastClosedH1,
          h1Klines: klinesH1,
          btcWave: derivedBtcWave,
          btcM15Pct,
          trend: derivedTrend,
          targetLevel: sig.targetLevel,
          step: sig.step,
          m15VolRatio,
          m15RangePct,
          h1VolRatio,
          touchCount: (typeof sig.touchCount === 'number' ? sig.touchCount + 1 : 1),
          btcFlashPump: btcFlashState.isShortLocked && Date.now() < btcFlashState.lockedUntil,
          btcFlashDump: btcFlashState.isLongLocked && Date.now() < btcFlashState.lockedUntil,
          turnoverBlocked: turnoverCheck.isBlocked,
          symbol: sym,
          maxRecentBouncePct: sig.maxRecentBouncePct ?? null,
          preEntryBouncePct: sig.preEntryBouncePct ?? null,
          isPreEntryExtremeStale: (typeof sig.maxRecentBouncePct === 'number' && typeof sig.preEntryBouncePct === 'number')
            ? (sig.maxRecentBouncePct >= Math.max(3.0, sig.preEntryBouncePct * 1.8))
            : false,
          isPreEntryStale: (typeof sig.maxRecentBouncePct === 'number' && typeof sig.preEntryBouncePct === 'number')
            ? sig.maxRecentBouncePct >= sig.preEntryBouncePct
            : false,
          whaleData,
          derivatives,
          fearGreed,
        };
      } catch (err) {
        rawMarketData = {
          targetLevel: sig.targetLevel,
          step: sig.step,
          btcFlashPump: btcFlashState.isShortLocked && Date.now() < btcFlashState.lockedUntil,
          btcFlashDump: btcFlashState.isLongLocked && Date.now() < btcFlashState.lockedUntil,
          turnoverBlocked: turnoverCheck.isBlocked,
          symbol: sym,
          maxRecentBouncePct: sig.maxRecentBouncePct ?? null,
          preEntryBouncePct: sig.preEntryBouncePct ?? null,
          isPreEntryExtremeStale: (typeof sig.maxRecentBouncePct === 'number' && typeof sig.preEntryBouncePct === 'number')
            ? (sig.maxRecentBouncePct >= Math.max(3.0, sig.preEntryBouncePct * 1.8))
            : false,
          isPreEntryStale: (typeof sig.maxRecentBouncePct === 'number' && typeof sig.preEntryBouncePct === 'number')
            ? sig.maxRecentBouncePct >= sig.preEntryBouncePct
            : false,
          whaleData,
          derivatives,
          fearGreed,
        };
      }

      // ── Đo trước cấu trúc cản thực tế để nạp khoảng cách SL chuẩn vào AI Reviewer tính EV ──
      const h4Ref = await fetchH4Reference(sym);
      const tickSize = getEffectiveTickSize(sym, sig.targetLevel);
      const maxAllowed = leverageInfo[sym] ?? leverage;
      const baseTargetLossUSD = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '3.0');
      const prelimSetup = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4Ref, tickSize, maxAllowed, baseTargetLossUSD, 1.5, rank, sig.gridWidthPct, null, tradeAmount);
      if (!prelimSetup.valid) {
        scanWindowStats.rejectMath++;
        log.system(`[AutoTrade] ⚠️ Bỏ qua ${sym} (${sig.signal}): ${prelimSetup.reason} — Không đạt chuẩn R:R >= 1.5.`);
        return;
      }
      sig.actualSlPct = prelimSetup.slPct;
      sig.actualTpPct = prelimSetup.tpPct;
      sig.leverage = prelimSetup.leverage;

      const marketMetrics = {
        m15RangePct: rawMarketData?.m15RangePct != null ? Number(rawMarketData.m15RangePct.toFixed(2)) : null,
        m15VolRatio: rawMarketData?.m15VolRatio != null ? Number(rawMarketData.m15VolRatio.toFixed(2)) : null,
        h1RangePct: rawMarketData?.currH1 ? Number((((rawMarketData.currH1.high - rawMarketData.currH1.low) / (rawMarketData.currH1.low || 1)) * 100).toFixed(2)) : null,
        h1VolRatio: rawMarketData?.h1VolRatio != null ? Number(rawMarketData.h1VolRatio.toFixed(2)) : null,
        lastClosedM15RangePct: rawMarketData?.lastClosedM15 ? Number((((rawMarketData.lastClosedM15.high - rawMarketData.lastClosedM15.low) / (rawMarketData.lastClosedM15.low || 1)) * 100).toFixed(2)) : null,
        lastClosedH1RangePct: rawMarketData?.lastClosedH1 ? Number((((rawMarketData.lastClosedH1.high - rawMarketData.lastClosedH1.low) / (rawMarketData.lastClosedH1.low || 1)) * 100).toFixed(2)) : null,
        max3H1RangePct: Array.isArray(rawMarketData?.h1Klines) && rawMarketData.h1Klines.length > 0
          ? Number(Math.max(...rawMarketData.h1Klines.slice(-3).map(k => (((k.high ?? k[2]) - (k.low ?? k[3])) / ((k.low ?? k[3]) || 1)) * 100)).toFixed(2))
          : null,
        m15IsGreen: rawMarketData?.currM15 ? rawMarketData.currM15.close >= rawMarketData.currM15.open : null,
        m15BodyPct: rawMarketData?.currM15 ? Number(((Math.abs(rawMarketData.currM15.close - rawMarketData.currM15.open) / (rawMarketData.currM15.low || 1)) * 100).toFixed(2)) : null
      };
      sig.marketMetrics = marketMetrics;
      if (rawMarketData) {
        rawMarketData.marketMetrics = marketMetrics;
        rawMarketData.signalMetrics = sig.signalMetrics || null;
        try {
          rawMarketData.microstructure = await scanMicrostructure(sym, sig.targetLevel, prelimSetup?.tpPrice || 0, sig.signal, rank);
        } catch (_) { }
      }

      const aiEval = evaluateSignalWithAI(sig, rawMarketData);

      // ── TIÊU CHÍ DUY NHẤT: Đánh giá Rủi ro Toàn diện từ Lõi AI (AI Reviewer Core) ──
      // Toàn bộ các tiêu chí (Trend, S/R, Flow, Volume, BTC Flash, Turnover, M15 Spike, EV R:R) được AI tự học và ra quyết định
      if (!aiEval.isApproved) {
        scanWindowStats.rejectGatekeeper++;
        // 🛡️ THROTTLE CHỐNG SPAM LOG AI VETO: Không in lặp lại mỗi 15s cho cùng coin/mốc giá (cooldown 3 phút)
        const shouldLogVeto = _shouldLogSignal(sym, sig.signal, sig.targetLevel, 'ai_veto_logged', 3 * 60 * 1000);
        if (shouldLogVeto) {
          log.system(`[AutoTrade] 🛑 [AI VETO] ${sym} (${sig.signal}): ${aiEval.reason} — Bỏ qua`);
          recordAIEvaluation(sig, aiEval);
          recordSkippedSignal({
            symbol: sym,
            signal: sig.signal,
            signalPrice: sig.targetLevel,
            score: sig.score ?? 0,
            scoreReasons: sig.scoreReasons || [],
            skipReason: `AI_VETO_${aiEval.vetoCategory || 'REJECTED'}`,
            markPrice: markPrice,
            marketCapRank: rank,
          });
        }

        // Đăng ký vị thế Shadow PnL để theo dõi kết quả thực tế trên thị trường với đòn bẩy và SL/TP thực
        registerShadowTrade(sig, aiEval, {
          markPrice,
          marketCapRank: rank,
          gridWidthPct: sig.gridWidthPct || gridStepPct,
          leverage: prelimSetup.leverage,
          margin: prelimSetup.margin,
          tierSlPrice: prelimSetup.slPrice,
          tierTpPrice: prelimSetup.tpPrice,
          beTriggerPrice: prelimSetup.beTriggerPrice,
          slPct: prelimSetup.slPct,
          marketMetrics,
          signalMetrics: sig.signalMetrics || null,
          microstructure: rawMarketData?.microstructure || null,
          isEconomicBlackout: rawMarketData?.isEconomicBlackout
        });

        // ── Thêm vào lowScoreWatchlist để chờ nến H1 Retest xác nhận rút râu/rút chân ──
        if (!lowScoreWatchlist[sym] || lowScoreWatchlist[sym].targetLevel !== sig.targetLevel) {
          const keys = Object.keys(lowScoreWatchlist);
          if (keys.length >= 40) {
            delete lowScoreWatchlist[keys[0]];
          }
          lowScoreWatchlist[sym] = {
            symbol: sym,
            signal: sig.signal,
            targetLevel: sig.targetLevel,
            score: sig.score ?? 0,
            scoreReasons: sig.scoreReasons || [],
            volScore: scoreRes?.volScore || 0,
            otherScore: scoreRes?.otherScore || 0,
            step: sig.step || getStep(markPrice),
            gridWidthPct: sig.gridWidthPct || gridStepPct,
            marketCapRank: rank,
            margin: tradeAmount,
            signalMetrics: sig.signalMetrics || null,
            timestamp: Date.now()
          };
        }

        return;
      }

      recordAIEvaluation(sig, aiEval);
      log.system(`[AutoTrade] 🟢 [AI APPROVED] ${sym} (${sig.signal}) — ${aiEval.reason}`);

      // ── BƯỚC KIỂM SOÁT CHIẾN THUẬT: PRE-LIMIT TACTICAL GATEKEEPER ──
      // Chỉ áp dụng với lệnh LIMIT (tránh hứng dao rơi khi nến M15 xả Marubozu hoặc Taker Sell > 75%)
      if (orderType !== 'MARKET') {
        const gatekeeperCheck = checkPreLimitTacticalGatekeeper({
          sym,
          signal: sig.signal,
          targetLevel: sig.targetLevel,
          markPrice,
          currM15: rawMarketData?.currM15,
          microstructure: rawMarketData?.microstructure
        });

        if (!gatekeeperCheck.passed) {
          scanWindowStats.rejectGatekeeper++;
          log.system(`[AutoTrade] ⚠️ [PreLimitGatekeeper] Tạm hoãn đặt Limit cho ${sym} (${sig.signal}): ${gatekeeperCheck.reason}.`);

          // Đăng ký Shadow Trade để theo dõi
          registerShadowTrade(sig, aiEval, {
            markPrice,
            marketCapRank: rank,
            gridWidthPct: sig.gridWidthPct || gridStepPct,
            leverage: prelimSetup.leverage,
            margin: prelimSetup.margin,
            tierSlPrice: prelimSetup.slPrice,
            tierTpPrice: prelimSetup.tpPrice,
            beTriggerPrice: prelimSetup.beTriggerPrice,
            slPct: prelimSetup.slPct,
            marketMetrics,
            signalMetrics: sig.signalMetrics || null,
            microstructure: rawMarketData?.microstructure || null,
            isEconomicBlackout: rawMarketData?.isEconomicBlackout
          });

          // Đưa vào lowScoreWatchlist chờ Retest H1 nảy rút chân
          if (!lowScoreWatchlist[sym] || lowScoreWatchlist[sym].targetLevel !== sig.targetLevel) {
            const keys = Object.keys(lowScoreWatchlist);
            if (keys.length >= 40) {
              delete lowScoreWatchlist[keys[0]];
            }
            lowScoreWatchlist[sym] = {
              symbol: sym,
              signal: sig.signal,
              targetLevel: sig.targetLevel,
              score: sig.score ?? 0,
              scoreReasons: sig.scoreReasons || [],
              volScore: scoreRes?.volScore || 0,
              otherScore: scoreRes?.otherScore || 0,
              step: sig.step || getStep(markPrice),
              gridWidthPct: sig.gridWidthPct || gridStepPct,
              marketCapRank: rank,
              margin: tradeAmount,
              signalMetrics: sig.signalMetrics || null,
              timestamp: Date.now()
            };
          }

          return;
        }
      }

      // ── LOGIC MỚI: TÍNH TOÁN STOPLOSS THEO TIER, TP ĐỘNG (1:1.5 -> 1:2.0), VÀ ĐÒN BẨY / MARGIN ĐỘNG (100% TỪ AI) ──
      const riskProfile = getDynamicRiskProfile(rank, aiEval.winProbability, null, baseTargetLossUSD);
      const targetLossUSD = riskProfile.targetLossUSD;
      const tpRatio = riskProfile.tpRatio;

      const tierSetup = await calculateTierSLTP(sym, sig.signal, sig.targetLevel, h4Ref, tickSize, maxAllowed, targetLossUSD, tpRatio, rank, sig.gridWidthPct, null, tradeAmount);
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

      if (isShadowMode) {
        log.system(`[AutoTrade] 👻 [Shadow Entry] Ghi nhận lệnh ảo #${sym} (${sig.signal}) @ $${sig.targetLevel} | Đòn bẩy ${effectiveLeverage}x | SL: $${tierSetup.slPrice} | TP: $${tierSetup.tpPrice}`);
        registerShadowTrade(sig, aiEval, {
          markPrice,
          marketCapRank: rank,
          gridWidthPct: sig.gridWidthPct || gridStepPct,
          leverage: effectiveLeverage,
          margin: actualTradeMargin,
          tierSlPrice: tierSetup.slPrice,
          tierTpPrice: tierSetup.tpPrice,
          beTriggerPrice: tierSetup.beTriggerPrice,
          slPct: tierSetup.slPct,
          marketMetrics,
          signalMetrics: sig.signalMetrics || null,
          microstructure: rawMarketData?.microstructure || null,
          isEconomicBlackout: rawMarketData?.isEconomicBlackout
        });

        if (process.env.SEND_SHADOW_ENTRY_ALERTS === 'true') {
          sendTelegram(`👻 <b>[Shadow Entry] #${sym} (${sig.signal})</b>\n• Mức giá: <code>$${sig.targetLevel}</code> (Đòn bẩy: <b>${effectiveLeverage}x</b> | Ký quỹ: <b>$${actualTradeMargin}</b>)\n• Mục tiêu: SL: <code>$${tierSetup.slPrice}</code> | TP: <code>$${tierSetup.tpPrice}</code>\n• Đang theo dõi ảo qua Shadow PnL Tracker!`);
        }
        return;
      }
      try {
        try {
          await client.setLeverage(sym, effectiveLeverage);
          log.system(`[AutoTrade] Set leverage ${sym}USDT = ${effectiveLeverage}x (Tier SL: $${tierSetup.slPrice} (${tierSetup.slPct.toFixed(2)}%), TP 1:${tierSetup.rrRatio}: $${tierSetup.tpPrice}${(ENABLE_TRAILING_BE && tierSetup.beTriggerPrice) ? `, Fractal Trailing SL kích hoạt tại $${tierSetup.beTriggerPrice}` : ' [Không dời SL]'} | Ký quỹ: $${actualTradeMargin} [${riskProfile.grade}])`);
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

        if (!isShadowMode && client) {
          // Double check ngay trước khi phát lệnh: Chặn tuyệt đối nếu đã có lệnh LIMIT chờ khớp
          const finalCheckOrders = await client.getOpenOrders(sym).catch(() => []);
          if (Array.isArray(finalCheckOrders)) {
            const existingLimit = finalCheckOrders.find(o => o.type === 'LIMIT' && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'));
            if (existingLimit) {
              log.system(`[AutoTrade] 🛑 [Pre-Place Guard] ${sym} vừa phát hiện lệnh LIMIT ${existingLimit.side} @ $${existingLimit.price} đang chờ — Hủy phát lệnh mới để tránh trùng/đối ứng.`);
              activeSymbols.add(sym);
              activeOrdersMap.set(sym, existingLimit.side === 'BUY' ? 'LONG' : 'SHORT');
              return;
            }
          }
        }

        let order;
        let finalEntryPrice = sig.targetLevel;
        if (orderType === 'MARKET') {
          order = await client.placeMarket(sym, side, qty);
        } else {
          // Chống khớp Taker ngoài ý muốn: không đặt LIMIT BUY cao hơn markPrice (hoặc LIMIT SELL thấp hơn markPrice)
          const liveMark = getMarkPrice(sym) || markPrice;
          if (liveMark && liveMark > 0) {
            const puncturedPct = side === 'BUY'
              ? ((sig.targetLevel - liveMark) / sig.targetLevel) * 100
              : ((liveMark - sig.targetLevel) / sig.targetLevel) * 100;
            if (puncturedPct > 0.15) {
              scanWindowStats.rejectGatekeeper++;
              log.system(`[AutoTrade] 🛑 [Maker Guard] ${sym} (${sig.signal}): Giá hiện tại ($${liveMark}) đã đâm thủng qua mốc $${sig.targetLevel} (${puncturedPct.toFixed(2)}% > 0.15%) — hủy đặt LIMIT để tránh khớp Taker giữa đà xả.`);
              return;
            }
            if (puncturedPct > 0) {
              finalEntryPrice = side === 'BUY' ? (liveMark * 0.9995) : (liveMark * 1.0005);
            }
          }
          const dec = getDecimals(finalEntryPrice);
          order = await client.placeLimit(sym, side, qty, finalEntryPrice, dec);
        }
        if (order) scanWindowStats.ordersDispatched++;

        activeSymbols.add(sym);
        activeOrdersMap.set(sym, side === 'BUY' ? 'LONG' : 'SHORT');

        const isCounter = (sig.signalMetrics?.trend === 'TREND_CONFLICT' || sig.signalMetrics?.trend === 'TREND_COUNTER');

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
          isFilled: false,
          hasNotifiedFill: false,
          maxFavorablePrice: null,
          pendingBouncePeakPrice: null,
          time: Date.now(),
          markPrice: markPrice,
          scoreReasons: sig.scoreReasons,
          marketCapRank: rank,
          leverage: effectiveLeverage,
          margin: actualTradeMargin,
          maxRecentBouncePct: maxRecentBouncePct ?? null,
          aiWinProbability: aiEval?.winProbability ?? null,
          aiExpectedRoi: aiEval?.expectedValueRoi ?? aiEval?.expectedEvRoi ?? null,
          isTrendRunnerEligible: aiEval?.isTrendRunnerEligible ?? false,
          // ── THÔNG SỐ TIER SL / TP MỚI ──
          tierSlPrice: tierSetup.slPrice,
          tierTpPrice: tierSetup.tpPrice,
          beTriggerPrice: tierSetup.beTriggerPrice,
          slDistance: tierSetup.slDistance,
          slPct: tierSetup.slPct,
          targetLossUSD: targetLossUSD,
        };
        saveActiveTradesMetadata();
        removeShadowBySymbolDirection(sym, side === 'BUY' ? 'LONG' : 'SHORT');

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
          marketMetrics,
          signalMetrics: sig.signalMetrics || null,
          leverage: effectiveLeverage,
          margin: tradeAmount,
        });

        _markFired(sig);
        activeSymbols.add(sym);
        activeOrdersMap.set(sym, side === 'BUY' ? 'LONG' : 'SHORT'); // 🛡️ BẢO VỆ LOCAL RAM: Khóa symbol ngay khi đặt lệnh thành công, không phụ thuộc REST sync 418
        sig.aiEval = aiEval;
        sig.leverage = effectiveLeverage;
        sig.margin = actualTradeMargin;
        sig.tierSlPrice = tierSetup.slPrice;
        sig.tierTpPrice = tierSetup.tpPrice;
        if (typeof notifySignals === 'function') {
          notifySignals([sig]).catch((err) => {
            log.warn(`[AutoTrade] Lỗi notifySignals cho ${sym}: ${err.message}`);
          });
        }
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
  const symbolSignalCooldown = {}; // Cooldown per symbol (chặn spam REST API từ WebSocket ticks dồn dập)

  onPriceUpdate((sym, price) => {
    if (isIpBanned()) return;
    if (!activeCoinSet.has(sym)) return;

    // ⚡ Kích hoạt rà soát tức thì (0ms) nếu coin này đang trong hàng chờ vào lệnh đảo chiều
    if (pendingReversals[sym]?.status === 'pending_entry') {
      checkPendingReversalAutoEntry().catch(() => { });
    }

    // 🛡️ COOLDOWN GUARD: Chỉ cho phép enqueueSymbolSignal tối đa 1 lần mỗi 15 giây cho từng coin
    const now = Date.now();
    if ((symbolSignalCooldown[sym] || 0) + 15000 > now) return;

    const levelCache = getLevelCache();
    const levels = levelCache[sym];
    if (!levels?.longEntry || !levels?.shortEntry) return;

    const nearTol = price * 0.003; // Ngưỡng 0.3% tiệm cận mốc
    const nearLong = Math.abs(price - levels.longEntry) <= nearTol;
    const nearShort = Math.abs(levels.shortEntry - price) <= nearTol;

    const activeDir = getActiveTradeDirection(sym);
    if (activeDir) {
      if (activeDir === 'UNKNOWN') return;
      // Nếu đang giữ LONG, chỉ quan tâm khi chạm mốc SHORT (đảo chiều)
      // Nếu đang giữ SHORT, chỉ quan tâm khi chạm mốc LONG (đảo chiều)
      const isOppositeNear = (activeDir === 'LONG' && nearShort) || (activeDir === 'SHORT' && nearLong);
      if (!isOppositeNear) return;

      // Kiểm tra cooldown cảnh báo đảo chiều
      if ((reversalAlertCooldown[sym] || 0) + REVERSAL_ALERT_COOLDOWN_MS > now) return;
    } else {
      if (!nearLong && !nearShort) return;
    }

    symbolSignalCooldown[sym] = now; // Ghi nhận thời điểm check
    scanWindowStats.wsTicks++;
    enqueueSymbolSignal(client, sym, price, leverageInfo, leverage, coins);
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
    checkH1RetestSignals(client, activeSymbols, leverageInfo, activeOrdersMap).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng Check H1 Retest: ${err.message}`);
    });
  }, 10000);

  // Luồng 5: Lưới bảo vệ BTC Flash Guard M1 & M15 độc lập (Mỗi 15s)
  const btcFlashTimer = setInterval(() => {
    updateBtcFlashGuard(client).catch(err => {
      log.warn(`[AutoTrade] Lỗi luồng BTC Flash Guard: ${err.message}`);
    });
  }, 15000);

  // Trả về hàm stop để caller có thể dừng nếu cần
  return function stop() {
    clearInterval(timer);
    clearInterval(trailingSlTimer);
    clearInterval(monitorLimitTimer);
    clearInterval(h1RetestTimer);
    clearInterval(btcFlashTimer);
    clearInterval(leverageRefreshTimer);
    clearInterval(shadowSyncTimer);
    clearInterval(coinRefreshTimer);
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
      // Chỉ xử lý lệnh LIMIT đang chờ (có orderId và CHƯA fill thành vị thế — tránh xóa metadata trong cửa sổ 0-6s vừa khớp)
      if (!meta.orderId || meta.isFilled) continue;

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
      // Ngưỡng nảy xa hủy lệnh LIMIT: Đồng bộ theo độ rộng Grid thích ứng đòn bẩy thấp (min 1.50%, max 3.00%)
      const effGridPct = (meta.gridWidthPct && meta.gridWidthPct > 0) ? meta.gridWidthPct : ((stepVal / entry) * 100);
      const bouncePct = Math.min(Math.max(effGridPct * 0.35, 1.50), 3.00);

      // 🛡️ BƯỚC 1: AI PRE-FILL LIMIT CANCEL (Kiểm tra vi cấu trúc thông minh khi giá áp sát cực gần Entry)
      if (ENABLE_AI_PREFILL_CANCEL) {
        const distToEntryPct = Math.abs(markPrice - entry) / entry * 100;
        const now = Date.now();
        // Chỉ quét khi giá áp sát cực gần Entry (<= 0.35%) hoặc đã chạm Entry, và cách lần quét trước ít nhất 4 giây
        if ((distToEntryPct <= 0.35 || meta.hasTouchedEntry === true) && (!meta._lastMicroScanTime || (now - meta._lastMicroScanTime >= 4000))) {
          meta._lastMicroScanTime = now;
          try {
            const side = meta.side === 'BUY' ? 'LONG' : 'SHORT';
            const rank = meta.marketCapRank || 999;
            const micro = await scanMicrostructure(sym, entry, meta.tierTpPrice || 0, side, rank);

            let cancelReason = null;
            if (side === 'LONG') {
              if (micro.takerBuyRatio <= 0.12) {
                cancelReason = `Áp lực xả Taker hoảng loạn cực đoan (Taker Buy chỉ chiếm ${(micro.takerBuyRatio * 100).toFixed(1)}% <= 12%)`;
              } else if (micro.spread === 'SPREAD_WIDE_DANGER') {
                cancelReason = `Độ dãn Spread nguy hiểm (${micro.spreadPct.toFixed(3)}%), thanh khoản cạn kiệt`;
              } else if (micro.wall === 'WALL_CRUSHING_ENTRY') {
                cancelReason = `Tường xả khổng lồ đè sát Entry ($${micro.wallNotionalUsd} USDT @ $${micro.wallPrice})`;
              }
            } else {
              if (micro.takerBuyRatio >= 0.88) {
                cancelReason = `Áp lực mua Taker hoảng loạn cực đoan (Taker Buy lên tới ${(micro.takerBuyRatio * 100).toFixed(1)}% >= 88%)`;
              } else if (micro.spread === 'SPREAD_WIDE_DANGER') {
                cancelReason = `Độ dãn Spread nguy hiểm (${micro.spreadPct.toFixed(3)}%), thanh khoản cạn kiệt`;
              } else if (micro.wall === 'WALL_CRUSHING_ENTRY') {
                cancelReason = `Tường mua khổng lồ đè sát Entry ($${micro.wallNotionalUsd} USDT @ $${micro.wallPrice})`;
              }
            }

            if (cancelReason) {
              // 🛡️ CƠ CHẾ XÁC NHẬN 2 NHỊP (TWO-STRIKE CONFIRMATION / ANTI-SPIKE FILTER):
              // Trừ trường hợp SPREAD_WIDE_DANGER (rút cản toác spread phải hủy ngay),
              // các trường hợp Taker hoặc Wall cần xác nhận lần 2 (cách nhau ~3.5s) để loại trừ giật nhiễu giả 1 giây!
              const isUrgent = micro.spread === 'SPREAD_WIDE_DANGER';
              if (!isUrgent && (!meta._microDangerStrikes || meta._microDangerStrikes < 1)) {
                meta._microDangerStrikes = 1;
                meta._lastMicroScanTime = now - 1000; // Cho phép quét lại xác nhận sau ~3 giây
                log.system(`[AutoTrade] ⚠️ [Microstructure Alert] ${sym} ${side} phát hiện: ${cancelReason} -> Kích hoạt xác nhận nhịp 2 trước khi hủy.`);
                continue;
              }

              // Nhịp 2 xác nhận nguy hiểm thực sự (hoặc Spread toác) -> HỦY LỆNH AN TOÀN!
              log.system(
                `[AutoTrade] 🛡️ [AI Pre-Fill Cancel] ${sym} ${side}: ` +
                `Xác nhận cản suy yếu thực sự -> ${cancelReason} -> Hủy LIMIT an toàn!`
              );
              try {
                await client.cancelOrder(sym, meta.orderId);
                overrideLevelLastSide(sym, side === 'LONG' ? 'lower' : 'upper');
                bounceCancelledLevels.set(`${sym}_${entry}`, Date.now() + 15 * 60_000);
                sendTelegram(
                  `🛡️ <b>[AutoTrade] AI Hủy LIMIT Sớm (Bảo Vệ Vốn)</b>\n` +
                  `• Coin: <b>${sym} (${side})</b>\n` +
                  `• Entry: <b>$${entry}</b> | Giá hiện tại: <b>$${markPrice.toFixed(6)}</b>\n` +
                  `• Nguyên nhân: <b>${cancelReason}</b>\n` +
                  `• Hành động: <b>Xác nhận 2 nhịp vi cấu trúc sụp đổ -> Hủy lệnh tránh dao rơi!</b>`
                ).catch(() => { });

                const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
                recordTradeExit({
                  tradeId: `${sym}-${meta.orderId || 'ai_cancel'}`,
                  orderId: String(meta.orderId || ''),
                  symbol: sym,
                  exitPrice: markPrice,
                  exitTimestamp: Date.now(),
                  exitType: 'AI_PREFILL_CANCEL',
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
                continue;
              } catch (e) {
                const errStr = _binanceErr(e);
                if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
                  log.system(`[AutoTrade] [AI Pre-Fill Cancel] Lệnh LIMIT ${sym} đã khớp vị thế hoặc đã hủy trước đó (-2011).`);
                  if (!lastActivePositions.has(sym)) {
                    delete activeTradesMetadata[sym];
                    saveActiveTradesMetadata();
                  } else {
                    meta.orderId = null;
                  }
                } else {
                  log.warn(`[AutoTrade] [AI Pre-Fill Cancel] Không hủy được LIMIT ${sym}: ${errStr}`);
                }
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra AI Pre-Fill cho ${sym}: ${err.message}`);
          }
        }
      }

      if (meta.side === 'BUY') {
        // ── LONG: giá tốt khi đi LÊN khỏi entry ──────────────────────────────
        if (markPrice <= entry * 1.0012) {
          if (!meta.hasTouchedEntry) {
            meta.hasTouchedEntry = true;
            meta.touchedTime = Date.now();
            saveActiveTradesMetadata();
          }
        }

        if (meta.pendingBouncePeakPrice === null || markPrice > meta.pendingBouncePeakPrice) {
          meta.pendingBouncePeakPrice = markPrice;
        }

        const maxFav = meta.pendingBouncePeakPrice;
        const maxBouncedPct = ((maxFav - entry) / entry) * 100;
        const currentBouncedPct = ((markPrice - entry) / entry) * 100;
        const maxBouncedRoi = maxBouncedPct * (meta.leverage || 1);
        const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);

        // Lệnh H1 Retest: Hủy khi duy trì ROI >= 5%. Lệnh thường: Hủy khi duy trì giá nảy >= bouncePct suốt BOUNCE_CANCEL_WAIT_SEC
        const isRetestCancel = meta.isH1Retest && currentBouncedRoi >= 5.0;
        const isRegularCancel = currentBouncedPct >= bouncePct;
        const shouldCancelNow = checkBounceCancelHoldReady(sym, 'LONG', meta, isRetestCancel || isRegularCancel, currentBouncedPct, bouncePct);

        if (shouldCancelNow) {
          const displayPct = currentBouncedPct;
          log.system(
            `[AutoTrade] [BounceCancel] ${sym} LONG: ` +
            `entry=$${entry}, current=$${markPrice.toFixed(6)} (+${displayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}% duy trì ${BOUNCE_CANCEL_WAIT_SEC}s) → Hủy LIMIT`
          );
          try {
            await client.cancelOrder(sym, meta.orderId);
            overrideLevelLastSide(sym, 'lower'); // Khóa mốc LONG cho đến khi giá chạm mốc trên
            bounceCancelledLevels.set(`${sym}_${entry}`, Date.now() + 20 * 60_000);
            sendTelegram(
              `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
              `• Coin: <b>${sym} LONG</b>\n` +
              `• Entry: <b>$${entry}</b>\n` +
              `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (+${displayPct.toFixed(2)}%)\n` +
              `• Giá duy trì nảy xa mốc suốt ${BOUNCE_CANCEL_WAIT_SEC}s → Hủy lệnh (Khóa mốc)`
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
            if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
              log.system(`[AutoTrade] [BounceCancel] Lệnh LIMIT ${sym} đã khớp vị thế hoặc đã hủy trước đó trên sàn (-2011).`);
              if (!lastActivePositions.has(sym)) {
                delete activeTradesMetadata[sym];
                saveActiveTradesMetadata();
              } else {
                meta.orderId = null;
              }
            } else {
              log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
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

        if (meta.pendingBouncePeakPrice === null || markPrice < meta.pendingBouncePeakPrice) {
          meta.pendingBouncePeakPrice = markPrice;
        }

        const minFav = meta.pendingBouncePeakPrice;
        const maxBouncedPct = ((entry - minFav) / entry) * 100;
        const currentBouncedPct = ((entry - markPrice) / entry) * 100;
        const maxBouncedRoi = maxBouncedPct * (meta.leverage || 1);
        const currentBouncedRoi = currentBouncedPct * (meta.leverage || 1);

        // Lệnh H1 Retest: Hủy khi duy trì ROI >= 5%. Lệnh thường: Hủy khi duy trì giá nảy >= bouncePct suốt BOUNCE_CANCEL_WAIT_SEC
        const isRetestCancel = meta.isH1Retest && currentBouncedRoi >= 5.0;
        const isRegularCancel = currentBouncedPct >= bouncePct;
        const shouldCancelNow = checkBounceCancelHoldReady(sym, 'SHORT', meta, isRetestCancel || isRegularCancel, currentBouncedPct, bouncePct);

        if (shouldCancelNow) {
          const displayPct = currentBouncedPct;
          log.system(
            `[AutoTrade] [BounceCancel] ${sym} SHORT: ` +
            `entry=$${entry}, current=$${markPrice.toFixed(6)} (-${displayPct.toFixed(2)}% >= ${bouncePct.toFixed(2)}% duy trì ${BOUNCE_CANCEL_WAIT_SEC}s) → Hủy LIMIT`
          );
          try {
            await client.cancelOrder(sym, meta.orderId);
            overrideLevelLastSide(sym, 'upper'); // Khóa mốc SHORT cho đến khi giá chạm mốc dưới
            bounceCancelledLevels.set(`${sym}_${entry}`, Date.now() + 20 * 60_000);
            sendTelegram(
              `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
              `• Coin: <b>${sym} SHORT</b>\n` +
              `• Entry: <b>$${entry}</b>\n` +
              `• Giá hiện tại: <b>$${markPrice.toFixed(6)}</b> (-${displayPct.toFixed(2)}%)\n` +
              `• Giá duy trì nảy xa mốc suốt ${BOUNCE_CANCEL_WAIT_SEC}s → Hủy lệnh (Khóa mốc)`
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
            if (errStr.includes('-2011') || errStr.includes('Unknown order')) {
              log.system(`[AutoTrade] [BounceCancel] Lệnh LIMIT ${sym} đã khớp vị thế hoặc đã hủy trước đó trên sàn (-2011).`);
              if (!lastActivePositions.has(sym)) {
                delete activeTradesMetadata[sym];
                saveActiveTradesMetadata();
              } else {
                meta.orderId = null;
              }
            } else {
              log.warn(`[AutoTrade] [BounceCancel] Không hủy được LIMIT ${sym}: ${errStr}`);
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
async function checkH1RetestSignals(client, activeSymbols, leverageInfo = {}, activeOrdersMap = null) {
  if (isIpBanned()) return;
  const currentH1Time = Math.floor(Date.now() / 3600000) * 3600000;
  if (currentH1Time === lastCheckedH1Time) return;
  lastCheckedH1Time = currentH1Time;
  const nowMs = Date.now();
  // Dọn dẹp các mã quá 12h
  for (const sym of Object.keys(lowScoreWatchlist)) {
    const d = lowScoreWatchlist[sym];
    if (!d || nowMs - d.timestamp > 12 * 3600 * 1000) {
      delete lowScoreWatchlist[sym];
    }
  }

  // Chỉ lọc các mã có giá hiện tại gần targetLevel (trong vòng 3.5%) và chưa có vị thế
  const eligibleSymbols = Object.keys(lowScoreWatchlist).filter(sym => {
    if (activeSymbols && activeSymbols.has(sym)) {
      delete lowScoreWatchlist[sym];
      return false;
    }
    const d = lowScoreWatchlist[sym];
    if (!d) return false;
    const mp = getMarkPrice(sym);
    if (!mp || !d.targetLevel) return true;
    const distPct = Math.abs(mp - d.targetLevel) / d.targetLevel;
    return distPct <= 0.035; // Trong vòng 3.5%
  });

  if (eligibleSymbols.length === 0) return;

  // Giới hạn kiểm tra tối đa 12 coin tiềm năng nhất mỗi nến H1 để triệt tiêu request burst
  const symbolsToWatch = eligibleSymbols.slice(0, 12);

  const watchlistSummary = symbolsToWatch.map(s => {
    const d = lowScoreWatchlist[s];
    return `${s}(${d?.signal || '?'} @$${d?.targetLevel || '?'})`;
  }).join(', ');
  log.system(`[H1Retest] === Kiểm tra ${symbolsToWatch.length} coin tiềm năng trong Watchlist: [${watchlistSummary}] ===`);

  const prevH1Start = currentH1Time - 3600000;

  for (const sym of symbolsToWatch) {
    if (isIpBanned()) break;
    const watchData = lowScoreWatchlist[sym];
    if (!watchData) continue;

    // Hết hạn sau 24h nếu không có retest
    if (Date.now() - watchData.timestamp > 24 * 3600 * 1000) {
      delete lowScoreWatchlist[sym];
      continue;
    }

    try {
      // Kiểm tra nếu đã có vị thế mở hoặc lệnh chờ -> Bỏ qua
      if (activeTradesMetadata[sym] || (activeSymbols && activeSymbols.has(sym))) {
        delete lowScoreWatchlist[sym];
        continue;
      }
      if (!isShadowMode && client) {
        const hasPos = await client.hasOpenPosition(sym);
        if (hasPos) {
          delete lowScoreWatchlist[sym];
          continue;
        }

        // 🛡️ PENDING LIMIT MUTUAL EXCLUSION (H1 Retest): Khóa nếu symbol đã có lệnh LIMIT chờ trên sàn
        const openOrders = await client.getOpenOrders(sym).catch(() => []);
        if (Array.isArray(openOrders) && openOrders.some(o => o.type === 'LIMIT' && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'))) {
          log.system(`[H1Retest] 🛑 ${sym} đang có lệnh LIMIT chờ khớp trên sàn — bỏ qua không đặt thêm lệnh Retest.`);
          if (activeSymbols) activeSymbols.add(sym);
          delete lowScoreWatchlist[sym];
          continue;
        }
      } else if (isShadowMode) {
        if (isShadowPositionActive(sym)) {
          delete lowScoreWatchlist[sym];
          continue;
        }
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
          const bouncePct = Math.max((unit * 0.40 / targetLevel) * 100, 1.50); // Tối thiểu 1.50% nảy khỏi cản để thích ứng đòn bẩy thấp

          if (isLong) {
            const isNearTouched = h1MinLow <= targetLevel + nearTouchRange;
            // Bounce từ điểm thấp nhất (h1MinLow) lên cao nhất (h1MaxHigh) trong cùng H1
            const bounceFromLow = ((h1MaxHigh - h1MinLow) / h1MinLow) * 100;
            if (isNearTouched && bounceFromLow >= bouncePct) {
              log.system(`[H1Retest] ${sym} LONG gần chạm mốc $${targetLevel} (Low: $${h1MinLow}, cách ${((h1MinLow - targetLevel) / targetLevel * 100).toFixed(3)}%) và đã nảy +${bounceFromLow.toFixed(2)}% >= ${bouncePct.toFixed(2)}% — XÓA KHỎI WATCHLIST`);
              delete lowScoreWatchlist[sym];
            }
          } else {
            const isNearTouched = h1MaxHigh >= targetLevel - nearTouchRange;
            // Bounce từ điểm cao nhất (h1MaxHigh) xuống thấp nhất (h1MinLow) trong cùng H1
            const bounceFromHigh = ((h1MaxHigh - h1MinLow) / h1MaxHigh) * 100;
            if (isNearTouched && bounceFromHigh >= bouncePct) {
              log.system(`[H1Retest] ${sym} SHORT gần chạm mốc $${targetLevel} (High: $${h1MaxHigh}, cách ${((targetLevel - h1MaxHigh) / targetLevel * 100).toFixed(3)}%) và đã nảy -${bounceFromHigh.toFixed(2)}% >= ${bouncePct.toFixed(2)}% — XÓA KHỎI WATCHLIST`);
              delete lowScoreWatchlist[sym];
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
      const minGridPctRetest = getMinGridPct(sym);
      if (gridStepPct < minGridPctRetest || gridStepPct > GRID_MAX_PCT) {
        log.system(
          `[AutoTrade (Retest H1)] 🛑 Bỏ qua ${sym} (${signal}): Độ rộng lưới không hợp lệ (${gridStepPct.toFixed(2)}% ` +
          `${gridStepPct < minGridPctRetest ? `< sàn tối thiểu ${minGridPctRetest}%` : `> trần tối đa ${GRID_MAX_PCT}%`}) ` +
          `— Cấu trúc mốc không thể giao dịch an toàn (Untradable Grid).`
        );
        delete lowScoreWatchlist[sym];
        continue;
      }
      // Dùng % biên độ bật nảy giá trực tiếp (1.50%) thay cho công thức đòn bẩy legacy 39/gridStepPct (bị thổi phồng 2x-4x)
      const maxRetestBouncePct = parseFloat(process.env.H1_RETEST_MAX_BOUNCE_PCT || '1.50');
      const maxFavorableRoi = maxFavorableMovePct; // giữ biến log tương thích
      if (maxFavorableMovePct >= maxRetestBouncePct) {
        log.system(`[H1Retest] ${sym} ${signal} nến H1 rút chân nhưng ĐÃ PHẢN ỨNG NẢY +${maxFavorableMovePct.toFixed(2)}% (>= ${maxRetestBouncePct}%) sau khi chạm entry. Bỏ qua không đặt limit.`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      // ── SL COOLDOWN GUARD CHO H1 RETEST ──
      if (isSymbolInCooldown(sym)) {
        delete lowScoreWatchlist[sym];
        continue;
      }

      // ── DIRECTIONAL CIRCUIT BREAKER CHO H1 RETEST ──
      const dirCheckRetest = isDirectionLocked(signal);
      if (dirCheckRetest.isLocked) {
        log.system(`[AutoTrade (Retest H1)] 🛑 [Directional Circuit Breaker] Chiều ${signal} đang bị khóa (${dirCheckRetest.reason} - còn ${dirCheckRetest.remainingMinutes}p) — Bỏ qua ${sym}`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      // ── ROLLING PERFORMANCE GUARD CHO H1 RETEST ──
      const suspendCheckRetest = isRealTradingSuspended();
      if (suspendCheckRetest.isSuspended) {
        log.system(`[AutoTrade (Retest H1)] 🛑 [Stand-Down Mode] Tạm dừng tiền thật do AI đang lệch pha (${suspendCheckRetest.reason} - còn ${suspendCheckRetest.remainingMinutes}p) — Bỏ qua ${sym}`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      // ── BTC FLASH & TURNOVER GUARD CHO H1 RETEST ──
      const turnoverCheckRetest = checkTurnoverGuard(sym);
      const nowTimeRetest = Date.now();
      const btcFlashPumpRetest = btcFlashState.isShortLocked && nowTimeRetest < btcFlashState.lockedUntil;
      const btcFlashDumpRetest = btcFlashState.isLongLocked && nowTimeRetest < btcFlashState.lockedUntil;

      // ── TÁI CHẤM ĐIỂM CONFLUENCE & HARD FILTERS MỚI NHẤT (không dùng lại score cũ từ 12 giờ trước) ──
      const isTier1Retest = isTop50Symbol(sym);
      const rank = watchData.marketCapRank || (getMarketCapRank ? getMarketCapRank(sym) : 999);
      const tradeAmountRetest = await getDynamicMargin(isTier1Retest, client);
      const minRequiredScoreRetest = isTier1Retest
        ? parseFloat(process.env.MIN_CONFLUENCE_SCORE_TIER1 || process.env.MIN_CONFLUENCE_SCORE || '7.0')
        : parseFloat(process.env.MIN_CONFLUENCE_SCORE_TIER2 || '8.0');

      let freshScoreRetest = watchData.score;
      let freshReasonsRetest = watchData.scoreReasons || [];
      try {
        const [taRetest, btcTaRetest, fundingRetest] = await Promise.all([
          getSymbolTA(sym),
          getBtcTA(),
          getBinanceFundingRates().catch(() => ({}))
        ]);
        const reScore = scoreSetup(sym, signal, taRetest, null, null, fundingRetest?.[sym] ?? null, null, null, btcTaRetest, {
          signal, targetLevel, step, gridWidthPct: gridStepPct
        });
        if (reScore?.disqualified) {
          log.system(`[AutoTrade (Retest H1)] 🛑 [HardFilter] ${sym} (${signal}) bị loại khi tái kiểm tra: ${reScore.disqualifyReason}`);
          delete lowScoreWatchlist[sym];
          continue;
        }
        if (typeof reScore?.total === 'number') {
          freshScoreRetest = reScore.total;
          freshReasonsRetest = reScore.reasons || freshReasonsRetest;
          watchData.score = freshScoreRetest;
          watchData.scoreReasons = freshReasonsRetest;
        }
      } catch (_) {}

      if (typeof freshScoreRetest === 'number' && freshScoreRetest < minRequiredScoreRetest) {
        log.system(`[AutoTrade (Retest H1)] 🛑 [Confluence Filter] ${sym} (${signal}): Score tươi ${freshScoreRetest}đ < ${minRequiredScoreRetest}đ — Bỏ qua`);
        delete lowScoreWatchlist[sym];
        continue;
      }

      const sigForAI = {
        symbol: sym,
        signal: signal,
        targetLevel: targetLevel,
        score: watchData.score,
        scoreReasons: watchData.scoreReasons || [],
        marketCapRank: rank,
        gridWidthPct: gridStepPct,
        margin: watchData.margin || tradeAmountRetest || (isTier1Retest ? 20 : 10),
        signalMetrics: watchData.signalMetrics || null,
      };

      let rawMarketDataRetest = null;
      let klinesM15Retest = null;
      let m15VolRatioRetest = 1.0;
      let m15RangePctRetest = 0.0;
      try {
        klinesM15Retest = await fetchBinanceKlines(sym, '15m', null, 21);
        const klinesH1Retest = await fetchBinanceKlines(sym, '1h', null, 25);
        const currM15 = klinesM15Retest && klinesM15Retest.length > 0 ? klinesM15Retest[klinesM15Retest.length - 1] : null;
        const lastClosedM15 = klinesM15Retest && klinesM15Retest.length > 1 ? klinesM15Retest[klinesM15Retest.length - 2] : null;
        const currH1 = klinesH1Retest && klinesH1Retest.length > 0 ? klinesH1Retest[klinesH1Retest.length - 1] : null;
        const lastClosedH1 = klinesH1Retest && klinesH1Retest.length > 1 ? klinesH1Retest[klinesH1Retest.length - 2] : null;

        if (currM15) {
          updateShadowPrices({
            [sym]: currM15.close
          });
        }

        if (klinesM15Retest && klinesM15Retest.length >= 20 && currM15) {
          const past20 = klinesM15Retest.slice(0, klinesM15Retest.length - 1);
          const avgVol20 = past20.reduce((sum, c) => sum + c.volume, 0) / past20.length;
          m15VolRatioRetest = avgVol20 > 0 ? (currM15.volume / avgVol20) : 1.0;
          m15RangePctRetest = ((currM15.high - currM15.low) / (currM15.low || 1)) * 100;
        }

        let h1VolRatioRetest = 1.0;
        if (klinesH1Retest && klinesH1Retest.length >= 24 && currH1) {
          const past24 = klinesH1Retest.slice(0, klinesH1Retest.length - 1);
          const avgVol24 = past24.reduce((sum, c) => sum + c.volume, 0) / past24.length;
          h1VolRatioRetest = avgVol24 > 0 ? (currH1.volume / avgVol24) : 1.0;
        }

        rawMarketDataRetest = {
          lastM15: currM15,
          currM15,
          lastClosedM15,
          currH1,
          lastClosedH1,
          targetLevel,
          step,
          m15VolRatio: m15VolRatioRetest,
          m15RangePct: m15RangePctRetest,
          h1VolRatio: h1VolRatioRetest,
          touchCount: 2,
          btcFlashPump: btcFlashPumpRetest,
          btcFlashDump: btcFlashDumpRetest,
          turnoverBlocked: turnoverCheckRetest.isBlocked,
          symbol: sym
        };
      } catch (err) {
        rawMarketDataRetest = {
          targetLevel,
          step,
          touchCount: 2,
          btcFlashPump: btcFlashPumpRetest,
          btcFlashDump: btcFlashDumpRetest,
          turnoverBlocked: turnoverCheckRetest.isBlocked,
          symbol: sym
        };
      }

      // ── Đo trước cấu trúc cản thực tế cho Retest H1 để nạp vào AI Reviewer ──
      const h4RefRetest = await fetchH4Reference(sym);
      const tickSizeRetest = getEffectiveTickSize(sym, targetLevel);
      const maxAllowedRetest = (leverageInfo && leverageInfo[sym]) ?? getLeverageCached(sym) ?? 20;
      const baseLossRetest = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '3.0');
      const prelimRetest = await calculateTierSLTP(sym, signal, targetLevel, h4RefRetest, tickSizeRetest, maxAllowedRetest, baseLossRetest, 1.5, rank, watchData.gridWidthPct || gridStepPct, null, tradeAmountRetest);
      if (!prelimRetest.valid) {
        log.system(`[AutoTrade (Retest H1)] ⚠️ Bỏ qua ${sym} (${signal}): ${prelimRetest.reason} — Không đạt chuẩn R:R >= 1.5.`);
        delete lowScoreWatchlist[sym];
        continue;
      }
      sigForAI.actualSlPct = prelimRetest.slPct;
      sigForAI.actualTpPct = prelimRetest.tpPct;

      const marketMetricsRetest = {
        m15RangePct: rawMarketDataRetest?.m15RangePct != null ? Number(rawMarketDataRetest.m15RangePct.toFixed(2)) : null,
        m15VolRatio: rawMarketDataRetest?.m15VolRatio != null ? Number(rawMarketDataRetest.m15VolRatio.toFixed(2)) : null,
        h1RangePct: rawMarketDataRetest?.currH1 ? Number((((rawMarketDataRetest.currH1.high - rawMarketDataRetest.currH1.low) / (rawMarketDataRetest.currH1.low || 1)) * 100).toFixed(2)) : null,
        h1VolRatio: rawMarketDataRetest?.h1VolRatio != null ? Number(rawMarketDataRetest.h1VolRatio.toFixed(2)) : null,
        lastClosedM15RangePct: rawMarketDataRetest?.lastClosedM15 ? Number((((rawMarketDataRetest.lastClosedM15.high - rawMarketDataRetest.lastClosedM15.low) / (rawMarketDataRetest.lastClosedM15.low || 1)) * 100).toFixed(2)) : null,
        lastClosedH1RangePct: rawMarketDataRetest?.lastClosedH1 ? Number((((rawMarketDataRetest.lastClosedH1.high - rawMarketDataRetest.lastClosedH1.low) / (rawMarketDataRetest.lastClosedH1.low || 1)) * 100).toFixed(2)) : null,
        max3H1RangePct: Array.isArray(rawMarketDataRetest?.h1Klines) && rawMarketDataRetest.h1Klines.length > 0
          ? Number(Math.max(...rawMarketDataRetest.h1Klines.slice(-3).map(k => (((k.high ?? k[2]) - (k.low ?? k[3])) / ((k.low ?? k[3]) || 1)) * 100)).toFixed(2))
          : null,
        m15IsGreen: rawMarketDataRetest?.currM15 ? rawMarketDataRetest.currM15.close >= rawMarketDataRetest.currM15.open : null,
        m15BodyPct: rawMarketDataRetest?.currM15 ? Number(((Math.abs(rawMarketDataRetest.currM15.close - rawMarketDataRetest.currM15.open) / (rawMarketDataRetest.currM15.low || 1)) * 100).toFixed(2)) : null
      };
      sigForAI.marketMetrics = marketMetricsRetest;
      if (rawMarketDataRetest) {
        rawMarketDataRetest.marketMetrics = marketMetricsRetest;
        rawMarketDataRetest.signalMetrics = sigForAI.signalMetrics || null;
        try {
          rawMarketDataRetest.microstructure = await scanMicrostructure(sym, targetLevel, prelimRetest?.tpPrice || 0, signal, rank);
        } catch (_) { }
      }

      const aiEval = evaluateSignalWithAI(sigForAI, rawMarketDataRetest);
      const currentPriceRetest = (typeof getMarkPrice === 'function' ? getMarkPrice(sym) : null) || h1Close || targetLevel;

      // Tiêu chí 3: Đánh giá Rủi ro Toàn diện từ Lõi AI cho Retest H1 (AI Reviewer Core)
      if (!aiEval.isApproved) {
        scanWindowStats.rejectGatekeeper++;
        // 🛡️ THROTTLE CHỐNG SPAM LOG AI VETO CHO RETEST H1: Không in lặp lại mỗi chu kỳ scan (cooldown 5 phút)
        const shouldLogRetestVeto = _shouldLogSignal(sym, signal, targetLevel, 'retest_ai_veto_logged', 5 * 60 * 1000);
        if (shouldLogRetestVeto) {
          log.system(`[AutoTrade (Retest H1)] 🛑 [AI VETO] ${sym} (${signal}): ${aiEval.reason} — Bỏ qua`);
          recordAIEvaluation(sigForAI, aiEval);
        }

        // Đăng ký vị thế Shadow PnL để theo dõi kết quả thực tế trên thị trường
        registerShadowTrade(sigForAI, aiEval, {
          markPrice: currentPriceRetest,
          marketCapRank: rank,
          gridWidthPct: gridStepPct,
          leverage: prelimRetest.leverage,
          margin: prelimRetest.margin,
          tierSlPrice: prelimRetest.slPrice,
          tierTpPrice: prelimRetest.tpPrice,
          beTriggerPrice: prelimRetest.beTriggerPrice,
          slPct: prelimRetest.slPct,
          marketMetrics: marketMetricsRetest,
          signalMetrics: sigForAI.signalMetrics || null,
          microstructure: rawMarketDataRetest?.microstructure || null,
          isEconomicBlackout: rawMarketDataRetest?.isEconomicBlackout
        });

        delete lowScoreWatchlist[sym];
        continue;
      }

      recordAIEvaluation(sigForAI, aiEval);
      log.system(`[AutoTrade (Retest H1)] 🟢 [AI APPROVED] ${sym} (${signal}) — ${aiEval.reason}`);

      // ── TÍNH TOÁN STOPLOSS THEO TIER, TP ĐỘNG (1:1.5 -> 1:2.0), VÀ ĐÒN BẨY / MARGIN ĐỘNG CHO RETEST H1 (100% TỪ AI) ──
      const riskProfileRetest = getDynamicRiskProfile(rank, aiEval.winProbability, null, baseLossRetest);
      const targetLossUSDRetest = riskProfileRetest.targetLossUSD;
      const tpRatioRetest = riskProfileRetest.tpRatio;

      const tierSetupRetest = await calculateTierSLTP(sym, signal, targetLevel, h4RefRetest, tickSizeRetest, maxAllowedRetest, targetLossUSDRetest, tpRatioRetest, rank, watchData.gridWidthPct || gridStepPct, null, tradeAmountRetest);
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

      // ── BƯỚC KIỂM SOÁT CHIẾN THUẬT: PRE-LIMIT GATEKEEPER CHO H1 RETEST ──
      const gatekeeperRetest = checkPreLimitTacticalGatekeeper({
        sym,
        signal,
        targetLevel,
        markPrice: h1Close || targetLevel,
        currM15: rawMarketDataRetest?.currM15,
        microstructure: rawMarketDataRetest?.microstructure
      });
      if (!gatekeeperRetest.passed) {
        log.system(`[H1Retest] ⚠️ [PreLimitGatekeeper] Tạm hoãn đặt Limit Retest cho ${sym} (${signal}): ${gatekeeperRetest.reason}. Giữ lại Watchlist.`);
        continue;
      }

      if (isShadowMode) {
        log.system(`[H1Retest] 👻 [Shadow Retest Entry] Ghi nhận lệnh Retest ảo #${sym} (${signal}) @ $${targetLevel}`);
        registerShadowTrade(sigForAI, aiEval, {
          markPrice: currentPriceRetest,
          marketCapRank: rank,
          gridWidthPct: watchData.gridWidthPct || gridStepPct,
          leverage: effectiveLeverageRetest,
          margin: actualTradeMarginRetest,
          tierSlPrice: prelimRetest.slPrice,
          tierTpPrice: prelimRetest.tpPrice,
          beTriggerPrice: prelimRetest.beTriggerPrice,
          slPct: prelimRetest.slPct,
          marketMetrics: marketMetricsRetest,
          signalMetrics: sigForAI.signalMetrics || null,
          microstructure: rawMarketDataRetest?.microstructure || null,
          isEconomicBlackout: rawMarketDataRetest?.isEconomicBlackout
        });

        if (process.env.SEND_SHADOW_ENTRY_ALERTS === 'true') {
          sendTelegram(`👻 <b>[Shadow Retest Entry] #${sym} (${signal})</b>\n• Mức giá: <code>$${targetLevel}</code> (Đòn bẩy: <b>${effectiveLeverageRetest}x</b>)\n• Đang theo dõi ảo qua Shadow PnL Tracker!`);
        }
        delete lowScoreWatchlist[sym];
        continue;
      }

      try {
        try { await client.setLeverage(sym, effectiveLeverageRetest); } catch (_) { }

        if (!isShadowMode && client) {
          const finalCheckOrders = await client.getOpenOrders(sym).catch(() => []);
          if (Array.isArray(finalCheckOrders) && finalCheckOrders.some(o => o.type === 'LIMIT' && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'))) {
            log.system(`[H1Retest] 🛑 [Pre-Place Guard] ${sym} đang có lệnh LIMIT chờ khớp trên sàn — hủy đặt lệnh Retest.`);
            if (activeSymbols) activeSymbols.add(sym);
            delete lowScoreWatchlist[sym];
            continue;
          }
        }

        const limitOrder = await client.placeLimit(sym, side, qty, targetLevel, dec);
        const limitId = limitOrder.orderId || limitOrder.id || 'unknown';

        if (activeSymbols) activeSymbols.add(sym);
        if (activeOrdersMap) activeOrdersMap.set(sym, side === 'BUY' ? 'LONG' : 'SHORT');

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
          isFilled: false,
          hasNotifiedFill: false,
          maxFavorablePrice: null,
          pendingBouncePeakPrice: null,
          isH1Retest: true,
          aiWinProbability: aiEval?.winProbability ?? null,
          aiExpectedRoi: aiEval?.expectedValueRoi ?? aiEval?.expectedEvRoi ?? null,
          isTrendRunnerEligible: aiEval?.isTrendRunnerEligible ?? false,
          // ── THÔNG SỐ TIER SL / TP MỚI ──
          tierSlPrice: tierSetupRetest.slPrice,
          tierTpPrice: tierSetupRetest.tpPrice,
          beTriggerPrice: tierSetupRetest.beTriggerPrice,
          slDistance: tierSetupRetest.slDistance,
          slPct: tierSetupRetest.slPct,
          targetLossUSD: targetLossUSDRetest,
        };
        saveActiveTradesMetadata();
        removeShadowBySymbolDirection(sym, side === 'BUY' ? 'LONG' : 'SHORT');

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
    // Giãn cách 200ms giữa các symbol để tránh request burst
    await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * Đóng vị thế thật bằng lệnh MARKET với cơ chế chống lệnh trùng lặp và chống mở vị thế ngược (Race Condition Guard):
 * 1. Khóa sym vào justClosedByBot để tránh notifyRealClose bắn thông báo trùng lặp
 * 2. Hủy toàn bộ lệnh mở (TP/SL sàn & Algo) trước khi bắn Market để tránh exchange SL khớp cùng miligiây
 * 3. Bắn lệnh Market với reduceOnly: true (chống mở vị thế ngược nếu sàn đã cắn SL trước)
 * 4. Xóa cache vị thế sàn và dọn dẹp RAM state ngay lập tức
 */
async function closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders = [], reasonLabel = 'CloseMarket') {
  justClosedByBot.add(sym);

  // 1. Hủy ngay tất cả lệnh mở (TP/SL sàn) và lệnh Algo
  client.cancelAllOpenOrders(sym).catch(() => { });
  if (Array.isArray(openAlgoOrders)) {
    for (const algo of openAlgoOrders) {
      client.cancelAlgoOrder(sym, algo.algoId || algo.orderId).catch(() => { });
    }
  }

  // 2. Bắn lệnh Market đóng vị thế với reduceOnly: true
  try {
    await client.placeMarket(sym, oppositeSide, absAmt, true);
  } catch (mErr) {
    const errCode = mErr.response?.data?.code || mErr.code;
    if (errCode === -2022) {
      log.system(`[AutoTrade] [${reasonLabel}] Vị thế ${sym} đã được sàn đóng trước đó (ReduceOnly). Hoàn tất thoát lệnh an toàn.`);
    } else {
      throw mErr;
    }
  }

  // 3. Xóa cache vị thế sàn và dọn dẹp state trong RAM ngay lập tức
  if (typeof client.invalidatePositionCache === 'function') {
    client.invalidatePositionCache();
  }
  if (activeTradesMetadata[sym]) {
    delete activeTradesMetadata[sym];
    saveActiveTradesMetadata();
  }
  lastActivePositions.delete(sym);
  partialClosedSymbols.delete(sym);
}

let isCheckingTrailingSL = false;

async function checkTrailingSL(client, defaultLeverage, leverageInfo, activeSymbols) {
  if (isIpBanned() || isCheckingTrailingSL) return;
  isCheckingTrailingSL = true;
  try {
    if (!activeSymbols || activeSymbols.size === 0) return;

    const rawPositions = await client.getOpenPositions();
    const positions = (rawPositions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    // ── KIỂM TRA SAFETY BRAKE TRƯỚC KHI ĐÓNG VỊ THẾ HÀNG LOẠT (Phase 4) ──
    const filledTrades = Object.entries(activeTradesMetadata)
      .filter(([sym, meta]) => meta && meta.isFilled === true && !meta.isClosed)
      .map(([sym]) => sym);

    const wouldClose = Array.from(lastActivePositions.keys())
      .filter(prevSym => !positions.some(p => p.symbol === `${prevSym}USDT`));

    const brakeCheck = evaluateSafetyBrake({
      eligibleTradesCount: filledTrades.length,
      exchangePositionsCount: positions.length,
      wouldCloseCount: wouldClose.length,
    });

    if (brakeCheck.tripped) {
      log.error(`[AutoTrade] 🚨 SAFETY BRAKE KÍCH HOẠT: ${brakeCheck.reason} — Tạm dừng đối chiếu đóng vị thế!`);
      return;
    }

    // Kiểm tra xem có vị thế nào ở lượt trước mà lượt này không còn không (sàn đóng hoặc user đóng tay)
    for (const [prevSym, prevPos] of lastActivePositions.entries()) {
      const isStillOpen = positions.some(p => p.symbol === `${prevSym}USDT`);
      if (!isStillOpen) {
        partialClosedSymbols.delete(prevSym);

        // 🧹 Hủy sạch tất cả các lệnh LIMIT Entry còn dư và SL/TP cũ trên sàn (chống cắn lại phần dư của lệnh limit)
        client.cancelAllOpenOrders(prevSym).catch(() => { });
        client.getOpenAlgoOrders(prevSym).then(algos => {
          for (const a of (algos || [])) {
            client.cancelAlgoOrder(prevSym, a.algoId || a.orderId).catch(() => { });
          }
        }).catch(() => { });

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

    // Lấy danh sách lệnh thường và lệnh algo:
    // Trên Binance Futures, gọi theo từng symbol chỉ tốn 1 Weight/request thay vì 40 Weight khi không truyền symbol!
    const ordersPromises = openSymbols.map(sym => client.getOpenOrders(sym).catch(err => ({ error: err })));
    const algoPromises = openSymbols.map(sym => client.getOpenAlgoOrders(sym).catch(err => ({ error: err })));
    const [ordersArr, algosArr] = await Promise.all([
      Promise.all(ordersPromises),
      Promise.all(algoPromises)
    ]);

    const symbolOrdersResults = openSymbols.map((sym, idx) => {
      const symUsdt = `${sym}USDT`;
      const ordRes = ordersArr[idx];
      const algoRes = algosArr[idx];
      const fetchFailed = !!(ordRes?.error || algoRes?.error);
      const orders = Array.isArray(ordRes) ? ordRes.filter(o => o.symbol === symUsdt) : [];
      const rawAlgos = Array.isArray(algoRes) ? algoRes : (algoRes?.orders ?? []);
      const algoOrders = Array.isArray(rawAlgos) ? rawAlgos.filter(o => o.symbol === symUsdt) : [];
      return { sym, orders, algoOrders, fetchFailed };
    });

    for (const p of positions) {
      const sym = p.symbol.replace('USDT', '');
      const entryPrice = parseFloat(p.entryPrice);
      const leverageVal = parseFloat(p.leverage);
      const amt = parseFloat(p.positionAmt);

      if (amt === 0 || entryPrice === 0) continue;

      const isLong = amt > 0;
      let absAmt = Math.abs(amt);
      const oppositeSide = isLong ? 'SELL' : 'BUY';

      // 🛡️ Price Guard: Ưu tiên wsMark nếu còn tươi (<10s) và không lệch quá 2% so với restMark (p.markPrice)
      const restMark = parseFloat(p.markPrice);
      const wsMark = (typeof getMarkPrice === 'function') ? getMarkPrice(sym, 10000) : null;
      let markPrice = restMark;

      if (wsMark && wsMark > 0 && restMark > 0) {
        // Kiểm tra độ lệch giữa wsMark và restMark (từ positionRisk của sàn)
        const devPct = Math.abs(wsMark - restMark) / restMark;
        if (devPct <= 0.02) {
          // Lệch <= 2%: wsMark hợp lệ và cập nhật real-time
          markPrice = wsMark;
        } else {
          // Lệch > 2%: wsMark bất thường (dữ liệu rác/socket lag/stale) -> Loại bỏ wsMark, dùng restMark an toàn
          log.warn(`[AutoTrade] [PriceGuard] Giá wsMark ($${wsMark}) lệch ${(devPct * 100).toFixed(2)}% so với restMark sàn ($${restMark}) của ${sym} -> Bỏ qua wsMark, dùng restMark.`);
        }
      }

      // ── Theo dõi maxFavorablePrice: Giá đỉnh/đáy tốt nhất từ khi vào lệnh ──
      // Cập nhật mỗi 3 giây để tránh bỏ lỡ spike ngắn dưới 3 giây giữa hai lần poll.
      // Một khi maxFavorablePrice đã vượt ngưỡng trail trigger, trạng thái này được giữ nguyên
      // cho đến khi vị thế đóng — đảm bảo SL luôn được dời về hòa vốn khi đã đủ điều kiện.
      let metaForPeak = activeTradesMetadata[sym];
      if (!metaForPeak) {
        // Fallback: Tự động khởi tạo metadata nếu vị thế mở trên sàn chưa có metadata (đang chạy sẵn từ trước khi bot restart)
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
          isFilled: true,
          hasNotifiedFill: true, // Vị thế đã có sẵn trên sàn, không gửi lại thông báo "Lệnh LIMIT đã khớp"
        };
        activeTradesMetadata[sym] = metaForPeak;
        saveActiveTradesMetadata();
      }

      // Thông báo Telegram khi lệnh LIMIT khớp mở vị thế
      if (metaForPeak && (!metaForPeak.hasNotifiedFill || !metaForPeak.isFilled)) {
        metaForPeak.hasNotifiedFill = true;
        metaForPeak.isFilled = true;
        // 🛡️ RESET maxFavorablePrice về đúng giá Entry ngay khi khớp lệnh,
        // triệt tiêu mọi giá đỉnh cũ lúc đang chờ lệnh LIMIT để tránh bị kích hoạt dời SL ảo đóng lệnh sớm!
        metaForPeak.maxFavorablePrice = entryPrice;
        metaForPeak.pendingBouncePeakPrice = null;
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
        metaForPeak.maxFavorablePrice = Math.max(metaForPeak.maxFavorablePrice ?? markPrice, markPrice);
      } else {
        metaForPeak.maxFavorablePrice = Math.min(metaForPeak.maxFavorablePrice ?? markPrice, markPrice);
      }

      // ROI % = % thay đổi giá * leverage
      const roi = isLong
        ? ((markPrice - entryPrice) / entryPrice) * leverageVal * 100
        : ((entryPrice - markPrice) / entryPrice) * leverageVal * 100;


      // Lấy danh sách lệnh chờ của symbol hiện tại từ kết quả đã truy vấn
      const symbolResult = symbolOrdersResults.find(r => r.sym === sym);
      const openOrders = symbolResult ? symbolResult.orders : [];
      const openAlgoOrders = symbolResult ? symbolResult.algoOrders : [];
      const isFetchFailed = !!symbolResult?.fetchFailed;

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
        ...openOrders.filter(o =>
          o.type === 'TAKE_PROFIT_MARKET' ||
          o.type === 'TAKE_PROFIT' ||
          (o.type === 'LIMIT' && isOrderReduceOnly(o) && o.side === oppositeSide)
        ),
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

      // Dời SL / TP về hòa vốn có buffer bù phí (+/- 5 ticks bù phí và tối thiểu 0.12% giá để luôn dương PnL sau phí sàn)
      const beBuffer = Math.max(unit * 0.05, entryPrice * 0.0012);

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

      // 2.5 Kiểm tra Nến H1 Không Phản Ứng (Nới lên 75% SL thay vì 60% để tránh bán đúng đáy quét thanh khoản)
      const h1InvalidPct = parseFloat(process.env.H1_INVALIDATION_SL_PCT || '0.75');
      const invalidationDistance = meta?.slDistance ? (meta.slDistance * h1InvalidPct) : (unit * h1InvalidPct);
      if (meta && !meta.isH1Failed && !meta.isPanicEscape) {
        const nowMs = Date.now();
        if (!meta._lastH1Check || (nowMs - meta._lastH1Check >= 60000)) {
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
                    log.system(`[AutoTrade] ⚠️ ${sym} LONG: Nến H1 đóng cửa gãy sâu ${(h1InvalidPct * 100).toFixed(0)}% SL ($${cClose} <= $${(entryPrice - invalidationDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn + buffer bù phí`);
                  }
                } else {
                  const isClosedAbove = cClose >= (entryPrice + invalidationDistance);
                  if (isClosedAbove) {
                    meta.isH1Failed = true;
                    log.system(`[AutoTrade] ⚠️ ${sym} SHORT: Nến H1 đóng cửa gãy sâu ${(h1InvalidPct * 100).toFixed(0)}% SL ($${cClose} >= $${(entryPrice + invalidationDistance).toFixed(6)}) -> Kích hoạt dời TP về Entry hòa vốn + buffer bù phí`);
                  }
                }
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra H1 cho vị thế ${sym}: ${err.message}`);
          }
        }
      }

      // 2.5b [VÔ HIỆU HÓA] Kiểm tra Nến M15 Đóng Cửa Không Phản Ứng
      // Đã tắt quy tắc 2.5b vì altcoin giật râu M15 0.3-0.5% và lệch đóng nến 0.1% là biến động tự nhiên bình thường.

      // 2.6 Kiểm tra M15 Bùng Nổ Volume / Đâm Sâu (Panic Escape -> Dời TP về Entry hòa vốn)
      //     - Chỉ kiểm tra khi nến M15 ĐÃ ĐÓNG CỬA (tránh nhiễu giật râu giữa nến)
      //     - Điều kiện 1: Volume nến M15 vừa đóng >= 2.5x TB 20 nến trước
      //     - Điều kiện 2: Giá trong nến từng bị lún sâu >= 60% slDistance qua Entry
      //     - Điều kiện 3: Phe đối lập thực sự áp đảo khi ĐÓNG NẾN (LONG: nến ĐỎ đóng dưới Entry | SHORT: nến XANH đóng trên Entry)
      //     - LONG & SHORT: Dời TP về Entry hòa vốn để thoát hàng khi có nhịp giật râu hồi
      if (meta && !meta.isH1Failed && !meta.isPanicEscape) {
        const nowMs = Date.now();
        if (!meta._lastM15VolCheck || (nowMs - meta._lastM15VolCheck >= 45000)) {
          meta._lastM15VolCheck = nowMs;
          try {
            const m15s = await fetchBinanceKlines(sym, '15m', null, 25);
            if (m15s && m15s.length >= 22) {
              const lastClosedM15 = m15s[m15s.length - 2];
              const m15CloseTime = lastClosedM15 ? (lastClosedM15.openTime + 15 * 60_000) : 0;
              const entryTime = meta.time || (nowMs - 15 * 60_000);

              // Cây nến M15 vừa đóng phải kết thúc sau thời điểm vào lệnh
              if (lastClosedM15 && m15CloseTime > entryTime && meta._lastCheckedM15VolCloseTime !== m15CloseTime) {
                meta._lastCheckedM15VolCloseTime = m15CloseTime;

                const base20 = m15s.slice(-22, -2);
                const avgBaseVolM15 = base20.reduce((s, c) => s + c.volume, 0) / 20;
                const closedRatio = avgBaseVolM15 > 0 ? (lastClosedM15.volume / avgBaseVolM15) : 0;

                // Điều kiện 1: Volume bùng nổ >= 2.5x
                const hasVolSurge = avgBaseVolM15 > 0 && closedRatio >= 2.5;

                // Điều kiện 2: Giá từng bị đâm lún sâu >= 60% slDistance qua Entry
                const deepPlungeDistance = meta?.slDistance ? (meta.slDistance * 0.60) : (unit * 0.60);
                const isDeepPlunge = isLong
                  ? (lastClosedM15.low <= entryPrice - deepPlungeDistance)
                  : (lastClosedM15.high >= entryPrice + deepPlungeDistance);

                // Điều kiện 3: Phe đối lập thực sự áp đảo khi đóng nến (LONG: nến Đỏ & đóng dưới Entry | SHORT: nến Xanh & đóng trên Entry)
                const isOpposingPressure = isLong
                  ? (lastClosedM15.close < lastClosedM15.open && lastClosedM15.close < entryPrice)
                  : (lastClosedM15.close > lastClosedM15.open && lastClosedM15.close > entryPrice);

                if (hasVolSurge && isDeepPlunge && isOpposingPressure) {
                  meta.isPanicEscape = true;
                  const escapePrice = Number(entryPrice.toFixed(8));

                  log.system(
                    `[AutoTrade] 🚨 [M15 Panic Escape] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ` +
                    `M15 đóng nến bùng nổ Volume (${closedRatio.toFixed(2)}x TB 20 nến) kèm nến ${isLong ? 'ĐỎ' : 'XANH'} đâm lún sâu >= 40% SL ` +
                    `-> Kích hoạt dời TP về Entry hòa vốn @ $${escapePrice}`
                  );
                  await sendTelegram(
                    `🚨 <b>M15 Bùng Nổ Volume - Kích Hoạt Thoát Hiểm (Hòa Vốn Entry)</b>\n` +
                    `• Coin: <b>${sym}</b> (${isLong ? 'LONG' : 'SHORT'})\n` +
                    `• Entry: <b>$${entryPrice}</b>\n` +
                    `• Nến M15 vừa đóng: <b>${isLong ? 'Nến ĐỎ giảm' : 'Nến XANH tăng'} (${closedRatio.toFixed(1)}x TB 20 nến)</b>\n` +
                    `• Giá đóng cửa: <b>$${lastClosedM15.close}</b> (ngược chiều Entry)\n` +
                    `• Đã dời TP thoát hiểm về Entry: <b>$${escapePrice}</b> để đón nhịp giật râu thoát hàng!`
                  );
                } else if (hasVolSurge && isDeepPlunge && !isOpposingPressure) {
                  log.system(
                    `[AutoTrade] ℹ️ [M15 Vol Surge Absorption] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ` +
                    `M15 bùng nổ Volume (${closedRatio.toFixed(2)}x TB) nhưng đóng nến ${isLong ? 'XANH/rút chân' : 'ĐỎ/đè râu'} thuận chiều ` +
                    `-> Xác nhận lực cầu/cung đỡ giá tốt, giữ nguyên TP mục tiêu!`
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
        if (meta?.isPanicEscape || meta?.isH1Failed || meta?.isDefensiveBeActive) {
          targetTpPriceExact = isLong ? Number((entryPrice + beBuffer).toFixed(8)) : Number((entryPrice - beBuffer).toFixed(8));
        } else {
          targetTpPriceExact = meta.tierTpPrice;
        }
        const bePctCfg = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));
        trailTriggerPriceExact = isLong
          ? Number((entryPrice + Math.abs(meta.tierTpPrice - entryPrice) * bePctCfg).toFixed(8))
          : Number((entryPrice - Math.abs(meta.tierTpPrice - entryPrice) * bePctCfg).toFixed(8));
        // 🌊 M15 FRACTAL WAVE TRAILING SL:
        // SL bám theo đáy/đỉnh sóng Williams Fractal 5 nến đã xác nhận trên M15
        const staleBePrice = isLong ? Number((entryPrice + beBuffer).toFixed(8)) : Number((entryPrice - beBuffer).toFixed(8));
        if (meta?.isStaleBeMoved) {
          trailedSlPriceExact = staleBePrice;
        } else if (meta?.fractalSlPrice) {
          trailedSlPriceExact = meta.fractalSlPrice;
        } else {
          trailedSlPriceExact = targetSlPriceExact;
        }
      } else {
        // Fallback theo unit nếu metadata cũ
        const trailMultiplier = 0.45;
        const tpDistance = unit * tpMultiplier;
        const trailDistance = unit * trailMultiplier;
        const trailSlDistance = unit * 0.05;
        const slBufferDistance = unit * 0.03;
        if (isLong) {
          targetSlPriceExact = Number((entryPrice - unit - slBufferDistance).toFixed(8));
          if (meta?.isPanicEscape || meta?.isH1Failed || meta?.isDefensiveBeActive) {
            targetTpPriceExact = Number((entryPrice + beBuffer).toFixed(8));
          } else {
            targetTpPriceExact = Number((entryPrice + tpDistance).toFixed(8));
          }
          trailTriggerPriceExact = Number((entryPrice + trailDistance).toFixed(8));
          trailedSlPriceExact = Number((entryPrice + trailSlDistance).toFixed(8));
        } else {
          targetSlPriceExact = Number((entryPrice + unit + slBufferDistance).toFixed(8));
          if (meta?.isPanicEscape || meta?.isH1Failed || meta?.isDefensiveBeActive) {
            targetTpPriceExact = Number((entryPrice - beBuffer).toFixed(8));
          } else {
            targetTpPriceExact = Number((entryPrice - tpDistance).toFixed(8));
          }
          trailTriggerPriceExact = Number((entryPrice - trailDistance).toFixed(8));
          trailedSlPriceExact = Number((entryPrice - trailSlDistance).toFixed(8));
        }
      }

      // Đổi sang ROI % tương đương để logging / telegram / dataset
      const slPct = meta?.slPct ? -meta.slPct : -13;
      const tpPct = (meta?.isPanicEscape || meta?.isH1Failed || meta?.isDefensiveBeActive) ? 0 : parseFloat(((Math.abs(targetTpPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      const trailTrigger = (typeof trailTriggerPriceExact === 'number' && trailTriggerPriceExact > 0)
        ? parseFloat(((Math.abs(trailTriggerPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2))
        : null;
      const trailSlRoi = parseFloat(((Math.abs(trailedSlPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      const posNotional = absAmt * entryPrice;
      const unrealizedPnlUsd = (roi / 100) * (meta?.margin || (posNotional / leverageVal));

      // ----------------------------------------------------
      // 0a. CƠ CHẾ THOÁT HIỂM 2 GIAI ĐOẠN (HYBRID DEFENSIVE ESCAPE)
      // GIAI ĐOẠN 1: Dời TP về Entry + beBuffer khi lún 40%-45% SL + CVD đối lập > 70% (đón nhịp hồi thoát hòa vốn, Lỗ = 0)
      // GIAI ĐOẠN 2: Cắt Non Market khi lún >= 70% SL + Nến M15 xác nhận đóng thủng cản + CVD xả gia tốc (bảo vệ 30%-35% vốn)
      // GIAI ĐOẠN 3: Sideway theo nến M15 quanh Entry -> Kiên nhẫn giữ vị thế, tuyệt đối không cắt theo thời gian
      // ----------------------------------------------------
      if (ENABLE_DEFENSIVE_ESCAPE && meta && !meta.isTrendRunner && !meta.isPanicEscape && !meta.isH1Failed) {
        const nowMs = Date.now();
        const slDist = meta?.slDistance || unit;
        // Giai đoạn 1: Lún 40% - 45% khoảng cách SL (vượt ra ngoài nhiễu râu quanh Entry)
        const adverseSagDistance = slDist * 0.40;
        const isSagging = isLong
          ? (markPrice <= entryPrice - adverseSagDistance)
          : (markPrice >= entryPrice + adverseSagDistance);

        const neverReachedTrail = !meta.maxFavorablePrice || (isLong ? (meta.maxFavorablePrice < entryPrice * 1.003) : (meta.maxFavorablePrice > entryPrice * 0.997));

        if (!meta.isDefensiveBeActive && isSagging && neverReachedTrail) {
          let shouldTriggerPhase1 = false;
          let cvdRatio = 0.5;
          try {
            const cvd = await getCvdMomentum(sym, isLong ? 'LONG' : 'SHORT');
            cvdRatio = cvd?.takerBuyRatio ?? 0.5;
            // CVD đối lập: Ngưỡng đồng nhất mọi coin >= 65% (Taker Buy <= 35% cho Long, >= 65% cho Short)
            const opposingThreshold = 0.35;
            if (isLong && cvdRatio <= opposingThreshold) shouldTriggerPhase1 = true;
            if (!isLong && cvdRatio >= (1.0 - opposingThreshold)) shouldTriggerPhase1 = true;
          } catch (_) { }

          if (shouldTriggerPhase1) {
            meta.isDefensiveBeActive = true;
            meta.defensiveActivatedTime = nowMs;
            meta.hasMovedTpToCustom = false; // Báo hiệu luồng đặt TP cập nhật lệnh trên sàn
            const escapePrice = isLong ? Number((entryPrice + beBuffer).toFixed(8)) : Number((entryPrice - beBuffer).toFixed(8));
            meta.tierTpPrice = escapePrice;
            targetTpPriceExact = escapePrice;
            const opposingPct = isLong ? ((1 - cvdRatio) * 100).toFixed(1) : (cvdRatio * 100).toFixed(1);
            log.system(
              `[AutoTrade] 🛡️ [Defensive Escape - Phase 1] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ` +
              `Lún sâu 40%-45% SL & Dòng tiền CVD đối lập áp đảo ${opposingPct}% (Ngưỡng: >=65%) -> Dời TP về Entry hòa vốn @ $${escapePrice}`
            );
            await sendTelegram(
              `🛡️ <b>[AutoTrade] Kích Hoạt Thoát Hiểm Giai Đoạn 1 (Dời TP về Entry)</b>\n` +
              `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
              `• Entry: <b>$${entryPrice}</b> | Hiện tại: <b>$${markPrice}</b> (ROI ${roi.toFixed(2)}%)\n` +
              `• Tín hiệu: <b>Lún 40%-45% SL & CVD đối lập ${opposingPct}%</b>\n` +
              `• Hành động: <b>Đã dời TP về $${escapePrice} để đón nhịp giật râu thoát hàng LỖ = 0!</b>`
            ).catch(() => { });
            saveActiveTradesMetadata();
          }
        }

        // Giai đoạn 2: Cắt Non Market nếu lún sâu >= 70% SL + Nến M15 ĐÓNG THỦNG cản + CVD xả gia tốc (> 70%)
        // Giai đoạn 3: Nếu nến M15 đi ngang (sideway) chưa đóng thủng cản -> Kiên nhẫn giữ vị thế
        if (meta.isDefensiveBeActive) {
          const deepLossDistance = slDist * 0.70; // Lún sâu >= 70% khoảng cách SL
          const isDeepDanger = isLong
            ? (markPrice <= entryPrice - deepLossDistance)
            : (markPrice >= entryPrice + deepLossDistance);

          if (isDeepDanger && roi <= -7.5) {
            let isM15ClosedBroken = false;
            let isCvdAccelerating = false;
            let cvdOpposingPct = '0';

            // 1. Kiểm tra xác nhận nến M15 ĐÃ ĐÓNG CỬA (loại bỏ hoàn toàn râu nến M1)
            try {
              const m15s = await fetchBinanceKlines(sym, '15m', null, 5);
              if (m15s && m15s.length >= 2) {
                const lastClosedM15 = m15s[m15s.length - 2];
                const m15CloseTime = (lastClosedM15?.openTime || 0) + 15 * 60_000;
                const entryTime = meta.time || 0;

                // Cây nến M15 vừa đóng phải kết thúc sau thời điểm vào lệnh
                if (lastClosedM15 && m15CloseTime > entryTime) {
                  // LONG: Nến Đỏ & đóng cửa dưới Entry
                  // SHORT: Nến Xanh & đóng cửa trên Entry
                  isM15ClosedBroken = isLong
                    ? (lastClosedM15.close < lastClosedM15.open && lastClosedM15.close < entryPrice)
                    : (lastClosedM15.close > lastClosedM15.open && lastClosedM15.close > entryPrice);
                }
              }
            } catch (err) {
              log.warn(`[AutoTrade] Không kiểm tra được nến M15 đóng cửa cho ${sym}: ${err.message}`);
            }

            // 2. Kiểm tra CVD xả gia tốc (phe đối lập duy trì > 70%)
            try {
              const cvd = await getCvdMomentum(sym, isLong ? 'LONG' : 'SHORT');
              const ratio = cvd?.takerBuyRatio ?? 0.5;
              if (isLong && ratio <= 0.30) isCvdAccelerating = true;
              if (!isLong && ratio >= 0.70) isCvdAccelerating = true;
              cvdOpposingPct = isLong ? ((1 - ratio) * 100).toFixed(1) : (ratio * 100).toFixed(1);
            } catch (_) { }

            // Chỉ kích hoạt cắt non khi HỘI TỤ ĐỦ: Lún 70% SL + Nến M15 xác nhận đóng thủng + CVD xả gia tốc
            // Nếu M15 vẫn đang nén đi ngang (sideway) quanh cản chưa đóng thủng -> Giữ vị thế!
            if (isM15ClosedBroken && isCvdAccelerating) {
              log.system(
                `[AutoTrade] 🚨 [Defensive Early Cut - Phase 2] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ` +
                `Lún sâu >= 70% SL + Nến M15 đóng thủng cản + CVD xả gia tốc ${cvdOpposingPct}% (ROI ${roi.toFixed(2)}%, Lỗ -$${Math.abs(unrealizedPnlUsd).toFixed(2)} USDT) -> Cắt Non Market khẩn cấp!`
              );
              try {
                await closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders, 'Defensive Early Cut');
                await sendTelegram(
                  `🚨 <b>[AutoTrade] Cắt Non Phòng Thủ - Giai Đoạn 2 (Defensive Early Cut)</b>\n` +
                  `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
                  `• Giá cắt: <b>$${markPrice}</b> | ROI: <b>${roi.toFixed(2)}%</b>\n` +
                  `• Thiệt hại khống chế: <b>-$${Math.abs(unrealizedPnlUsd).toFixed(2)} USDT</b>\n` +
                  `• Xác nhận: <b>Nến M15 đóng thủng cản & CVD xả gia tốc ${cvdOpposingPct}%</b>\n` +
                  `• Kết quả: <b>Chủ động cắt sớm để bảo toàn ~30%-35% vốn so với Full SL (-13%)!</b>`
                ).catch(() => { });

                const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
                recordTradeExit({
                  tradeId: `${sym}-${meta.orderId || 'defCut'}`,
                  orderId: String(meta.orderId || ''),
                  symbol: sym,
                  exitPrice: markPrice,
                  exitTimestamp: Date.now(),
                  exitType: 'DEFENSIVE_EARLY_CUT',
                  pnlPercent: roi,
                  pnlUsd: unrealizedPnlUsd,
                  holdingDurationMinutes: holdingDurationMinutes,
                  isWin: false,
                });
                recordDirectionalTradeExit({
                  symbol: sym,
                  side: isLong ? 'LONG' : 'SHORT',
                  isWin: false,
                  exitType: 'DEFENSIVE_EARLY_CUT',
                  pnlUsd: unrealizedPnlUsd,
                  pnlPercent: roi
                });
                recordRealTradeOutcome({
                  symbol: sym,
                  side: isLong ? 'LONG' : 'SHORT',
                  isWin: false,
                  exitType: 'DEFENSIVE_EARLY_CUT',
                  pnlUsd: unrealizedPnlUsd,
                  pnlPercent: roi
                });

                addSymbolToCooldown(sym, null, 'DEFENSIVE_EARLY_CUT');
                continue;
              } catch (e) {
                justClosedByBot.delete(sym);
                log.error(`[AutoTrade] [Defensive Early Cut] Lỗi đóng vị thế ${sym}: ${e.message}`);
              }
            }
          }
        }
      }

      // ----------------------------------------------------
      // 0b. STALE POSITION GUARD (ĐÃ VÔ HIỆU HÓA THEO YÊU CẦU ĐÒN BẨY THẤP)
      //     Vì đòn bẩy thấp nên thời gian đạt TP sẽ lâu hơn, để lệnh chạy tự nhiên theo TP/SL, không can thiệp dời TP/thoát lệnh sau 6h.
      // ----------------------------------------------------

      // ----------------------------------------------------
      // 0. HARD MAX LOSS GUARD (Khống chế trần lỗ tối đa)
      // ----------------------------------------------------
      const baseLossEnv = parseFloat(process.env.MAX_LOSS_PER_TRADE_USD || '5.0');
      const hardLossCapUSD = (meta?.targetLossUSD ? meta.targetLossUSD : baseLossEnv) * 1.10; // Đệm 10% trượt giá
      if (unrealizedPnlUsd <= -hardLossCapUSD) {
        // 🛡️ Xác nhận với restMark sàn trước khi cắt lỗ khẩn cấp
        const restRoi = isLong
          ? ((restMark - entryPrice) / entryPrice) * leverageVal * 100
          : ((entryPrice - restMark) / entryPrice) * leverageVal * 100;
        const restLossUsd = (restRoi / 100) * (meta?.margin || (posNotional / leverageVal));
        if (restLossUsd > -hardLossCapUSD * 0.85) {
          log.warn(`[AutoTrade] 🛡️ [Hard Loss - Blocked] Chặn cắt lỗ ảo cho ${sym}: markPrice=$${markPrice} (Lỗ $${unrealizedPnlUsd.toFixed(2)}) nhưng restMark sàn=$${restMark} (Lỗ $${restLossUsd.toFixed(2)}). Chờ xác nhận.`);
          continue;
        }

        log.system(`[AutoTrade] 🚨 [Hard Max Loss Guard] Kích hoạt cho ${sym}: Lỗ thả nổi $${unrealizedPnlUsd.toFixed(2)} (${roi.toFixed(2)}%) chạm ngưỡng trần -$${hardLossCapUSD.toFixed(2)} USDT. Cắt lỗ MARKET ngay lập tức!`);
        try {
          await closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders, 'Hard Max Loss Guard');
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
            recordDirectionalTradeExit({
              symbol: sym,
              side: isLong ? 'LONG' : 'SHORT',
              isWin: false,
              exitType: 'HARD_MAX_LOSS',
              pnlUsd: unrealizedPnlUsd,
              pnlPercent: roi
            });
            recordRealTradeOutcome({
              symbol: sym,
              side: isLong ? 'LONG' : 'SHORT',
              isWin: false,
              exitType: 'HARD_MAX_LOSS',
              pnlUsd: unrealizedPnlUsd,
              pnlPercent: roi
            });
          }
          addSymbolToCooldown(sym, null, 'HARD_MAX_LOSS');
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
        // 🛡️ Virtual TP Sanity Guard:
        // Đảm bảo giá restMark từ sàn Binance cũng xác nhận tiệm cận mốc TP (tránh lỗi giật giá ảo / lệch feed)
        const isRestTpConfirmed = isLong
          ? (restMark >= targetTpPriceExact * 0.995)
          : (restMark <= targetTpPriceExact * 1.005);
        if (!isRestTpConfirmed) {
          log.warn(`[AutoTrade] 🛡️ [Virtual TP - Blocked] Chặn chốt lời ảo cho ${sym}: markPrice=$${markPrice} chạm target ($${targetTpPriceExact.toFixed(5)}) nhưng restMark sàn=$${restMark} chưa tiệm cận TP. Bỏ qua.`);
          continue;
        }

        // ── 🚀 BƯỚC 2: ADAPTIVE TREND RUNNER (GỒNG LÃI DÀI THEO SÓNG DO AI QUYẾT ĐỊNH) ──
        const isDefensiveExit = (meta?.isPanicEscape || meta?.isH1Failed) === true;
        // AI quyết định gồng sóng Trend Runner: Tự động dựa trên thẩm định vi cấu trúc, Expected ROI và xác suất AI đã học từ dữ liệu quá khứ
        const modelCfg = typeof getAIModelConfig === 'function' ? getAIModelConfig() : null;
        const aiThreshold = modelCfg?.optimalThresholds?.uniform || modelCfg?.thresholdApprovalPct || 48.0;
        const isAiHighConfidence = meta?.isTrendRunnerEligible === true ||
          (meta?.aiExpectedRoi != null && meta.aiExpectedRoi >= 10.0) ||
          (typeof meta?.aiWinProbability === 'number' ? (meta.aiWinProbability >= (aiThreshold + 2.0)) : true);
        const canRunTrend = ENABLE_TREND_RUNNER && !isDefensiveExit && !meta?.isTrendRunner && isAiHighConfidence;

        if (canRunTrend) {
          let isMomentumStrong = false;
          try {
            const cvdMetrics = await getCvdMomentum(sym, isLong ? 'LONG' : 'SHORT');
            const ratio = cvdMetrics?.takerBuyRatio ?? 0.5;
            // Với LONG: Taker Buy vẫn duy trì >= 48% (chưa có dấu hiệu xả tháo hàng)
            // Với SHORT: Taker Buy vẫn <= 52% (chưa có dấu hiệu cover thốc hàng)
            if (isLong && ratio >= 0.48) isMomentumStrong = true;
            if (!isLong && ratio <= 0.52) isMomentumStrong = true;
          } catch (_) {
            isMomentumStrong = true; // Fallback nếu API bận: ưu tiên gồng theo sóng
          }

          if (isMomentumStrong) {
            // 1. Chốt trước 50% vị thế nếu chưa chốt Partial TP để bỏ túi lãi tươi chắc chắn
            let closeQty = 0;
            const isAlreadyPartialClosed = (meta?.isPartialClosed === true) || partialClosedSymbols.has(sym);
            if (!isAlreadyPartialClosed) {
              const halfAmt = absAmt * 0.5;
              closeQty = formatQuantity(sym, halfAmt);
              if (closeQty > 0) {
                try {
                  await client.placeMarket(sym, oppositeSide, closeQty, true);
                  partialClosedSymbols.add(sym);
                  if (meta) {
                    meta.isPartialClosed = true;
                    if (meta.margin) {
                      meta.initialMargin = meta.initialMargin || meta.margin;
                      meta.margin = Number((meta.margin * 0.5).toFixed(2));
                    }
                    saveActiveTradesMetadata();
                  }
                  absAmt = formatQuantity(sym, Math.max(0, absAmt - closeQty));
                  if (lastActivePositions.has(sym)) {
                    const prevData = lastActivePositions.get(sym);
                    lastActivePositions.set(sym, { ...prevData, amt: isLong ? absAmt : -absAmt });
                  }
                  log.system(`[AutoTrade] 🚀 [Trend Runner] Đã chốt trước 50% vị thế ${sym} tại TP1 @ $${markPrice} (qty=${closeQty})`);
                } catch (e) {
                  log.warn(`[AutoTrade] [Trend Runner] Không chốt được 50% cho ${sym}: ${e.message}`);
                }
              }
            }

            // 2. Mở rộng TP lên TP2 dựa theo khoảng cách TP1 / SL thực tế (TUYỆT ĐỐI không dùng unit cũ tránh đặt TP2 thấp hơn TP1)
            const curTp1Dist = Math.max(Math.abs(targetTpPriceExact - entryPrice), Math.abs(markPrice - entryPrice));
            const refSlDist = meta?.slDistance || (curTp1Dist / 1.5);
            const extendedTpDistance = Math.max(curTp1Dist * 1.5, refSlDist * 2.5);
            const targetTp2 = isLong
              ? Number((entryPrice + extendedTpDistance).toFixed(8))
              : Number((entryPrice - extendedTpDistance).toFixed(8));

            // Khóa SL bảo đảm lãi an toàn phía sau markPrice (50% quãng đường TP1, tối đa 65% lãi hiện tại)
            const curGainDist = Math.abs(markPrice - entryPrice);
            const lockedSlDistance = Math.min(curTp1Dist * 0.50, curGainDist * 0.65);
            const lockedSlPrice = isLong
              ? Number((entryPrice + lockedSlDistance).toFixed(8))
              : Number((entryPrice - lockedSlDistance).toFixed(8));

            const prevSlFallback = realSlOrders.length > 0 ? parseFloat(realSlOrders[0].stopPrice) : (meta.currentSlPrice || meta.tierSlPrice);

            meta.isTrendRunner = true;
            meta.runnerTpPrice = targetTp2;
            meta.runnerLockedSlPrice = lockedSlPrice;
            meta.tierTpPrice = targetTp2;
            meta.hasMovedTpToCustom = true;
            targetTpPriceExact = targetTp2;
            saveActiveTradesMetadata();

            // Hủy TP cũ trên sàn và đặt ngay TP2 mới
            for (const o of realTpOrders) {
              try {
                if (o.isAlgo) await client.cancelAlgoOrder(sym, o.orderId);
                else await client.cancelOrder(sym, o.orderId);
              } catch (_) { }
            }
            try {
              const tp2Order = await client.placeStopOrder(sym, oppositeSide, 'TAKE_PROFIT_MARKET', targetTp2);
              const tp2Id = tp2Order?.algoId ?? tp2Order?.orderId ?? null;
              if (tp2Id != null) meta.tpOrderId = String(tp2Id);
            } catch (e) {
              meta.hasMovedTpToCustom = false;
              log.warn(`[AutoTrade] [Trend Runner] Đặt TP2 mới ${sym} thất bại (sẽ đặt bù lượt sau): ${_binanceErr(e)}`);
            }

            // Hủy SL cũ trên sàn và đặt ngay SL khóa lãi mới (rollback nếu lỗi -> không bao giờ để trống SL)
            for (const o of realSlOrders) {
              try {
                if (o.isAlgo) await client.cancelAlgoOrder(sym, o.orderId);
                else await client.cancelOrder(sym, o.orderId);
              } catch (_) { }
            }
            try {
              const slNew = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', lockedSlPrice);
              const slNewId = slNew?.algoId ?? slNew?.orderId ?? null;
              if (slNewId != null) {
                meta.slOrderId = String(slNewId);
                meta.currentSlPrice = lockedSlPrice;
              }
            } catch (e) {
              log.error(`[AutoTrade] [Trend Runner] Đặt SL khóa lãi ${sym} thất bại: ${_binanceErr(e)} — Rollback SL cũ`);
              if (prevSlFallback && prevSlFallback > 0) {
                const rb = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', prevSlFallback).catch(() => null);
                if (rb?.algoId || rb?.orderId) meta.slOrderId = String(rb.algoId || rb.orderId);
              }
            }
            saveActiveTradesMetadata();

            const tp1Roi = parseFloat(((Math.abs(markPrice - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
            const lockedRoi = parseFloat(((lockedSlDistance / entryPrice) * leverageVal * 100).toFixed(2));
            const tp2Roi = parseFloat(((extendedTpDistance / entryPrice) * leverageVal * 100).toFixed(2));

            await sendTelegram(
              `🚀 <b>[AutoTrade] Kích Hoạt Gồng Lãi Theo Sóng (Trend Runner)</b>\n` +
              `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
              `• Đã chạm mốc TP1: <b>$${markPrice}</b> (ROI +${tp1Roi}%)\n` +
              `• Trạng thái: <b>Đã chốt trước 50% tiền lời</b>\n` +
              `• Vị thế còn lại: <b>${absAmt}</b> tiếp tục gồng theo đà sóng\n` +
              `• Khóa SL bảo đảm lãi tại: <b>$${lockedSlPrice}</b> (Chắc chắn ăn +${lockedRoi}% ROI)\n` +
              `• Mục tiêu TP2 mở rộng: <b>$${targetTp2}</b> (Kỳ vọng +${tp2Roi}% ROI)!`
            ).catch(() => { });

            continue; // Bỏ qua đóng vị thế toàn phần, tiếp tục gồng!
          }
        }

        // Nếu trên sàn đã có sẵn lệnh LIMIT TP (Maker fee 0.02%) và không phải thoát hiểm đặc biệt,
        // nhường sàn tự khớp LIMIT Maker (chỉ đóng MARKET dự phòng nếu giá đã vượt quá TP >= 0.25% mà sàn chưa khớp)
        const hasRealMakerLimitTp = !isDefensiveExit && !meta?.isDefensiveBeActive && realTpOrders.some(o => !o.isAlgo && o.type === 'LIMIT');
        const farPastTp = isLong ? (markPrice >= targetTpPriceExact * 1.0025) : (markPrice <= targetTpPriceExact * 0.9975);
        if (hasRealMakerLimitTp && !farPastTp) {
          continue;
        }

        const exitLabel = meta?.isTrendRunner ? 'Trend Runner TP2 (Full Win)' : (meta?.isDefensiveBeActive ? 'Thoát Hiểm Hòa Vốn (Giai Đoạn 1)' : (meta?.isPanicEscape ? 'Thoát Hiểm Entry' : (meta?.isH1Failed ? 'Hòa Vốn Entry' : 'Take Profit')));
        log.system(`[AutoTrade] [Virtual TP - ${exitLabel}] Kích hoạt cho ${sym}: Giá $${markPrice} chạm mốc $${targetTpPriceExact.toFixed(5)} (ROI ~${roi.toFixed(2)}%). Đóng vị thế MARKET.`);
        try {
          await closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders, `Virtual TP - ${exitLabel}`);
          const winIcon = meta?.isTrendRunner ? '🏆' : (meta?.isDefensiveBeActive ? '🛡️' : '🎯');
          const winExtra = meta?.isTrendRunner ? '\n• 🏆 <b>Đã ăn trọn con sóng dài của thị trường!</b>' : (meta?.isDefensiveBeActive ? '\n• 🛡️ <b>Đón nhịp giật râu thoát hàng thành công, bảo toàn vốn LỖ = 0!</b>' : '');
          await sendTelegram(`${winIcon} <b>${exitLabel} (Virtual)</b>\n• Coin: <b>${sym}</b>\n• Giá chạm: <b>$${markPrice}</b> (Target: $${targetTpPriceExact.toFixed(5)})\n• ROI đạt: <b>${roi.toFixed(2)}%</b>${winExtra}`);
          // ── Record trade exit for AI Dataset ──
          if (meta) {
            const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
            const exitTypeVal = meta?.isTrendRunner ? 'TREND_RUNNER_TP' : (meta?.isDefensiveBeActive ? 'DEFENSIVE_BE_EXIT' : (meta?.isPanicEscape ? 'PANIC_ESCAPE' : (meta?.isH1Failed ? 'BE_EXIT' : 'TP')));
            recordTradeExit({
              tradeId: `${sym}-${meta.orderId || 'vTP'}`,
              orderId: String(meta.orderId || ''),
              symbol: sym,
              exitPrice: markPrice,
              exitTimestamp: Date.now(),
              exitType: exitTypeVal,
              pnlPercent: roi,
              pnlUsd: (roi / 100) * (meta.margin || 0),
              holdingDurationMinutes: holdingDurationMinutes,
              isWin: roi >= 0,
            });
            const hasTakenPartial = !!(meta?.isPartialClosed || partialClosedSymbols.has(sym));
            recordDirectionalTradeExit({
              symbol: sym,
              side: isLong ? 'LONG' : 'SHORT',
              isWin: roi >= 0 || hasTakenPartial,
              exitType: exitTypeVal,
              pnlUsd: (roi / 100) * (meta.margin || 0),
              pnlPercent: roi,
              isPartialClosed: hasTakenPartial
            });
            recordRealTradeOutcome({
              symbol: sym,
              side: isLong ? 'LONG' : 'SHORT',
              isWin: roi >= 0 || hasTakenPartial,
              exitType: exitTypeVal,
              pnlUsd: (roi / 100) * (meta.margin || 0),
              pnlPercent: roi,
              isPartialClosed: hasTakenPartial
            });
          }
          if (meta?.isPanicEscape) {
            addSymbolToCooldown(sym, null, 'PANIC_ESCAPE');
          }
        } catch (e) {
          justClosedByBot.delete(sym);
          log.error(`[AutoTrade] [Virtual TP] Lỗi đóng vị thế ${sym}: ${e.message}`);
        }
        continue; // Bỏ qua check SL cho coin này trong lượt này
      }

      // 1b. Cập nhật / Đặt algo TP lên sàn tại mốc targetTpPriceExact
      const isCustomTpActive = (meta?.isH1Failed || meta?.isPanicEscape || meta?.isTrendRunner || meta?.isDefensiveBeActive) === true;
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
          const tpLabel = meta?.isTrendRunner ? 'Trend Runner TP2' : (meta?.isDefensiveBeActive ? 'Thoát hiểm Hòa Vốn' : (meta?.isPanicEscape ? 'Thoát hiểm Entry' : 'Hòa vốn Entry'));
          log.system(`[AutoTrade] ⚠️ Đã dời TP ${sym} về mốc [${tpLabel}] @ $${targetTpPriceExact.toFixed(5)} (đối ứng ${oppositeSide}) orderId=${tpId}`);
        } catch (e) {
          log.error(`[AutoTrade] Đặt TP thoát ${sym} thất bại: ${_binanceErr(e)}`);
        }
      } else if (realTpOrders.length === 0 && !isFetchFailed) {
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

      // a. Ngưỡng Kích hoạt Trailing SL & Risk-Free BE chuẩn xác tại mốc BE_TRIGGER_TP_PCT (mặc định 50% TP)
      const isTrailTriggerReached = (typeof trailTriggerPriceExact === 'number' && trailTriggerPriceExact > 0)
        ? (isLong
          ? (peakPrice >= trailTriggerPriceExact)
          : (peakPrice <= trailTriggerPriceExact))
        : false;

      // 🎯 0. HỖ TRỢ PARTIAL TP (Chốt lời 50% khi chạm mốc Trailing Trigger)
      const isAlreadyPartialClosed = (meta?.isPartialClosed === true) || partialClosedSymbols.has(sym);
      if (ENABLE_PARTIAL_TP && isTrailTriggerReached && !isAlreadyPartialClosed) {
        const halfAmt = absAmt * 0.5;
        const closeQty = formatQuantity(sym, halfAmt);
        if (closeQty > 0) {
          const estRealizedPnl = (roi / 100) * ((meta?.margin || 0) * 0.5);
          log.system(`[AutoTrade] 🎯 [Partial TP] ${sym} chạm mốc kích hoạt ($${trailTriggerPriceExact} / ROI +${roi.toFixed(2)}%): Chốt 50% vị thế (qty = ${closeQty}, lãi ước tính +$${estRealizedPnl.toFixed(2)} USDT)`);
          try {
            await client.placeMarket(sym, oppositeSide, closeQty, true);
            partialClosedSymbols.add(sym);
            if (meta) {
              meta.isPartialClosed = true;
              if (meta.margin) {
                meta.initialMargin = meta.initialMargin || meta.margin;
                meta.margin = Number((meta.margin * 0.5).toFixed(2));
              }
              saveActiveTradesMetadata();
            }
            // Cập nhật số lượng vị thế còn lại
            absAmt = formatQuantity(sym, Math.max(0, absAmt - closeQty));
            if (lastActivePositions.has(sym)) {
              const prevData = lastActivePositions.get(sym);
              lastActivePositions.set(sym, { ...prevData, amt: isLong ? absAmt : -absAmt });
            }
            sendTelegram(
              `🎯 <b>[AutoTrade] Chốt Lời 50% Vị Thế (Partial TP)</b>\n` +
              `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
              `• Đã chốt: <b>${closeQty}</b> (50% vị thế)\n` +
              `• Giá chốt: <b>$${markPrice}</b> | ROI: <b>+${roi.toFixed(2)}%</b>\n` +
              `• Tiền lãi bỏ túi: <b>+$${estRealizedPnl.toFixed(2)} USDT</b>\n` +
              `• Vị thế còn lại: <b>${absAmt}</b> (SL đang dời theo sóng M15 để tiếp tục gồng lãi Full TP!)`
            ).catch(() => { });
          } catch (e) {
            partialClosedSymbols.delete(sym);
            log.error(`[AutoTrade] [Partial TP] Đóng 50% vị thế ${sym} thất bại: ${e.message}`);
          }
        }
      }

      // 🌊 QUÉT CẤU TRÚC SÓNG FRACTAL BẬC THANG (DUAL H1 & M15 STRUCTURE TRAILING) KHI ĐẠT >= 50% TP
      // - Đạt 50% TP (cấu hình BE_TRIGGER_TP_PCT): Khóa ngay mốc hòa vốn Risk-Free (Entry ± 0.14% phí thực)
      // - 50% -> 70% TP: Thang cuốn bám theo Đáy sóng H1 Williams Fractal (loại bỏ M1/M5 nhiễu)
      // - >= 70% TP: Thang cuốn siết theo Đáy sóng M15 Williams Fractal để bảo vệ thành quả
      if (ENABLE_TRAILING_BE && (isTrailTriggerReached || meta?.isBeTriggered)) {
        const beTriggerPctCfg = parseFloat(process.env.BE_TRIGGER_TP_PCT || '50');
        if (meta && !meta.isBeTriggered) {
          meta.isBeTriggered = true;
          // Kích hoạt mốc hòa vốn an toàn bằng đệm phí round-trip thực tế 0.14% giá (độc lập với đòn bẩy)
          const beFeeDist = entryPrice * 0.0014;
          const initialBeSl = isLong ? (entryPrice + beFeeDist) : (entryPrice - beFeeDist);
          if (!meta.fractalSlPrice || (isLong ? initialBeSl > meta.fractalSlPrice : initialBeSl < meta.fractalSlPrice)) {
            meta.fractalSlPrice = initialBeSl;
            meta.fractalTf = `BREAKEVEN_${Math.round(beTriggerPctCfg)}PCT`;
          }
          log.system(`[AutoTrade] 🌊 [Fractal Trailing SL] ${sym} (${isLong ? 'LONG' : 'SHORT'}) chạm ngưỡng ${beTriggerPctCfg}% TP -> Khóa hòa vốn Risk-Free @ $${initialBeSl.toFixed(5)} & kích hoạt Trailing H1/M15!`);
          saveActiveTradesMetadata();
        }

        const nowMs = Date.now();
        // Quét nến Fractal: chạy ngay lượt đầu (hoặc mỗi 20 giây sau đó)
        if (meta && (!meta._lastFractalCheckTime || (nowMs - meta._lastFractalCheckTime >= 20_000))) {
          meta._lastFractalCheckTime = nowMs;
          try {
            const currentGainDist = isLong ? (markPrice - entryPrice) : (entryPrice - markPrice);
            const totalTpDist = targetTpPriceExact ? Math.abs(targetTpPriceExact - entryPrice) : 0;
            const progressPct = totalTpDist > 0 ? (currentGainDist / totalTpDist) * 100 : 0;

            const fn = getRecentFractalSwing || getRecentM15FractalSwing;
            const swingBufferPct = 0.0015; // Đệm 0.15% sau râu nến

            let bestCand = null;

            // 1. Phân tầng theo quãng đường tiến tới TP:
            if (progressPct >= 70) {
              // Vùng áp sát đích (>= 70% TP): Siết chặt theo M15 Williams Fractal
              const m15s = await fetchBinanceKlines(sym, '15m', null, 30);
              const m15Swing = (m15s && m15s.length >= 6) ? fn(m15s, isLong) : null;
              if (m15Swing && typeof m15Swing.price === 'number') {
                const sl = isLong ? (m15Swing.price * (1 - swingBufferPct)) : (m15Swing.price * (1 + swingBufferPct));
                bestCand = { sl, tf: 'M15_FRACTAL', pivotPrice: m15Swing.price };
              }
            } else {
              // Vùng bung sóng (50% -> 70% TP): Bám theo cấu trúc H1 Williams Fractal xương sống
              const h1s = await fetchBinanceKlines(sym, '1h', null, 30);
              const h1Swing = (h1s && h1s.length >= 6) ? fn(h1s, isLong) : null;
              if (h1Swing && typeof h1Swing.price === 'number') {
                const sl = isLong ? (h1Swing.price * (1 - swingBufferPct)) : (h1Swing.price * (1 + swingBufferPct));
                bestCand = { sl, tf: 'H1_FRACTAL', pivotPrice: h1Swing.price };
              }
            }

            // 2. Chốt chặn sàn tối thiểu (Floor Guard): Entry ± 0.14% phí thực
            const beFeeDist = entryPrice * 0.0014;
            const riskFreeSl = isLong ? (entryPrice + beFeeDist) : (entryPrice - beFeeDist);

            if (!bestCand) {
              bestCand = { sl: riskFreeSl, tf: `BREAKEVEN_${Math.round(beTriggerPctCfg)}PCT`, pivotPrice: riskFreeSl };
            }

            if (bestCand) {
              const candidateSl = bestCand.sl;
              // 🛡️ CHỐT CHẶN BÁNH CÓC 1 CHIỀU (ONE-WAY RATCHET):
              // candidateSl phải tốt hơn mốc SL hiện tại (meta.fractalSlPrice hoặc targetSlPriceExact)
              const currentSlLevel = meta.fractalSlPrice || targetSlPriceExact;
              const isBetterSl = isLong ? (candidateSl > currentSlLevel) : (candidateSl < currentSlLevel);

              // Sanity: candidateSl phải an toàn so với markPrice (không thể đặt Stop khi giá hiện tại đã xuyên qua SL)
              const isSafeFromMark = isLong ? (markPrice > candidateSl * 1.0005) : (markPrice < candidateSl * 0.9995);

              if (isBetterSl && isSafeFromMark) {
                const prevSlVal = meta.fractalSlPrice || targetSlPriceExact;
                meta.fractalSlPrice = candidateSl;
                meta.fractalTf = bestCand.tf;
                saveActiveTradesMetadata();

                const isProfitLock = isLong ? (candidateSl > entryPrice) : (candidateSl < entryPrice);
                const slRoi = ((Math.abs(candidateSl - entryPrice) / entryPrice) * leverageVal * 100) * (isProfitLock ? 1 : -1);

                const actionLabel = bestCand.tf === 'BREAKEVEN_35PCT'
                  ? `Khóa hòa vốn Risk-Free @ $${candidateSl.toFixed(5)} (ROI ${slRoi.toFixed(2)}%)`
                  : (isProfitLock
                    ? `Khóa lãi sóng ${bestCand.tf} @ $${candidateSl.toFixed(5)} (+${slRoi.toFixed(2)}% ROI)`
                    : `Nâng SL bám đáy sóng ${bestCand.tf} @ $${candidateSl.toFixed(5)} (${slRoi.toFixed(2)}% ROI)`);

                log.system(`[AutoTrade] 🌊 [Fractal Structure Trailing SL] ${sym} (${isLong ? 'LONG' : 'SHORT'}): ${actionLabel} (SL trước: $${prevSlVal.toFixed(5)})`);
              }
            }
          } catch (err) {
            log.warn(`[AutoTrade] Lỗi kiểm tra Fractal Structure cho ${sym}: ${err.message}`);
          }
        }
      }

      if (meta?.fractalSlPrice && !meta?.isStaleBeMoved) {
        trailedSlPriceExact = meta.fractalSlPrice;
      }

      // 🛡️ SANITY GUARD: Chỉ dời SL lên mốc hòa vốn/khóa lãi nếu mốc dời hợp lệ so với giá thị trường hiện tại
      // - LONG: Giá hiện tại (markPrice) phải CAO HƠN mốc dời (trailedSlPriceExact).
      //   Nếu markPrice <= trailedSlPriceExact, đặt Stop Sell sẽ bị Binance từ chối (-2021) và kích hoạt Virtual SL oan!
      // - SHORT: Giá hiện tại (markPrice) phải THẤP HƠN mốc dời (trailedSlPriceExact).
      const isTrailedSlValid = isLong
        ? (markPrice > trailedSlPriceExact)
        : (markPrice < trailedSlPriceExact);

      // Trend Runner: SL khóa lãi phải hợp lệ so với giá thị trường hiện tại
      const isRunnerSlValid = Boolean(meta?.isTrendRunner && meta?.runnerLockedSlPrice && (isLong ? (markPrice > meta.runnerLockedSlPrice) : (markPrice < meta.runnerLockedSlPrice)));

      // Kích hoạt Trailing SL nếu có Fractal SL hợp lệ (tốt hơn SL ban đầu) hoặc Trend Runner hoặc Stale BE
      const hasValidFractalSl = Boolean(meta?.fractalSlPrice && (isLong ? meta.fractalSlPrice > targetSlPriceExact : meta.fractalSlPrice < targetSlPriceExact));
      const canApplyTrailingSl = (ENABLE_TRAILING_BE && hasValidFractalSl && isTrailedSlValid) || isRunnerSlValid || Boolean(meta?.isStaleBeMoved && isTrailedSlValid);

      let targetSlPrice = targetSlPriceExact;
      let currentSlPct = slPct;

      if (isRunnerSlValid) {
        targetSlPrice = meta.runnerLockedSlPrice;
        currentSlPct = parseFloat(((Math.abs(targetSlPrice - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
      } else if (canApplyTrailingSl) {
        currentSlPct = parseFloat(((Math.abs(trailedSlPriceExact - entryPrice) / entryPrice) * leverageVal * 100).toFixed(2));
        if (isLong ? (trailedSlPriceExact < entryPrice) : (trailedSlPriceExact > entryPrice)) {
          currentSlPct = -currentSlPct; // SL thấp hơn entry thì ROI âm
        }
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
        // Có lệnh SL trên sàn -> Thực hiện dịch chuyển Trailing SL khi giá đã từng chạm mốc (canApplyTrailingSl)
        if (canApplyTrailingSl) {
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
            const isProfitLocked = currentSlPct > 0;
            const tfLabel = meta?.fractalTf || 'M15';
            const isHalfRisk = meta?.fractalTf === 'HALF_RISK';
            const levelLabel = isRunnerSlValid
              ? `Runner Khóa Lãi (+${currentSlPct}%)`
              : (isHalfRisk
                ? `Thu Hẹp 50% Rủi Ro (${currentSlPct}%)`
                : (isProfitLocked ? `Khóa Lãi Sóng ${tfLabel} (+${currentSlPct}%)` : `Bám Đáy/Đỉnh Sóng ${tfLabel} (${currentSlPct}%)`));
            log.system(`[AutoTrade] 🌊 [Fractal Cascade Trailing SL] ${sym} ${levelLabel} -> Dịch SL trên sàn về $${targetSlStr} (ROI ~${currentSlPct}%) [Đỉnh ROI: +${roi.toFixed(2)}%]`);

            // 🧹 Hủy sạch CHỈ các lệnh LIMIT Entry còn treo dư (!reduceOnly — tuyệt đối KHÔNG hủy TP LIMIT của vị thế)
            const remainingEntryLimits = openOrders.filter(o => !isOrderReduceOnly(o) && (o.type === 'LIMIT' || o.orderType === 'LIMIT'));
            for (const limitOrder of remainingEntryLimits) {
              client.cancelOrder(sym, limitOrder.orderId).catch(() => { });
            }

            // Lưu mốc SL cũ trên sàn trước khi hủy để rollback ngay nếu đặt SL mới thất bại
            const prevExchangeSl = realSlOrders.length > 0 ? parseFloat(realSlOrders[0].stopPrice) : (meta?.currentSlPrice || null);

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
            // Đặt SL mới (Bám sát sóng Fractal Cascade) — Rollback ngay nếu lỗi, đóng Market nếu -2021
            try {
              const newSl = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', roundedTargetSl);
              const rawOrderId = newSl?.algoId ?? newSl?.orderId ?? null;
              const orderIdStr = rawOrderId != null ? String(rawOrderId) : null;
              const stopPriceStr = newSl?.stopPrice || newSl?.triggerPrice || roundedTargetSl;
              if (meta && orderIdStr) {
                meta.slOrderId = orderIdStr;
                meta.currentSlPrice = roundedTargetSl;
                saveActiveTradesMetadata();
              }
              log.system(`[AutoTrade] ✓ Đã dịch SL mới cho ${sym} @ $${stopPriceStr} (orderId=${orderIdStr})`);

              // Gửi thông báo Telegram (Khóa Lãi Sóng Cascade / Bám Sóng Cascade)
              const telegramTitle = isRunnerSlValid
                ? `🚀 <b>[AutoTrade] Khóa Lãi Trend Runner (+${currentSlPct}%)</b>`
                : (isHalfRisk
                  ? `🛡️ <b>[AutoTrade] Thu Hẹp 50% Rủi Ro Vị Thế (${currentSlPct}%)</b>`
                  : (isProfitLocked
                    ? `🚀 <b>[AutoTrade] Khóa Lãi Sóng ${tfLabel} Fractal (+${currentSlPct}%)</b>`
                    : `🛡️ <b>[AutoTrade] Nâng SL Bám Đáy/Đỉnh Sóng ${tfLabel} Fractal (${currentSlPct}%)</b>`));
              const partialNotice = isRunnerSlValid
                ? `• Đã khóa chặt mốc bảo hiểm lợi nhuận, tiếp tục gồng 50% còn lại về đích TP2!`
                : (isHalfRisk
                  ? `• Đã dời SL giảm một nửa rủi ro, cho giá vùng thở an toàn chờ hình thành đáy/đỉnh sóng M5/M1!`
                  : (isProfitLocked
                    ? `• Đã khóa chặt mức lãi tối thiểu theo cấu trúc sóng ${tfLabel}, tiếp tục gồng về Full TP!`
                    : `• SL đã được nâng bám sát đáy/đỉnh sóng ${tfLabel} gần nhất (giảm thiểu rủi ro), giữ nguyên vị thế tiếp tục gồng về Full TP!`));
              sendTelegram(
                `${telegramTitle}\n` +
                `• Coin: <b>#${sym} (${isLong ? 'LONG' : 'SHORT'})</b>\n` +
                `• ROI hiện tại: <b>+${roi.toFixed(2)}%</b>\n` +
                `• Đã dời SL trên sàn về: <b>$${targetSlStr}</b> (${isProfitLocked ? `Khóa lãi theo sóng ${tfLabel}` : (isHalfRisk ? 'Giảm 50% rủi ro' : `Bám sát đáy/đỉnh sóng ${tfLabel}`)})\n` +
                `${partialNotice}`
              ).catch(() => { });
            } catch (e) {
              const errStr = _binanceErr(e);
              if (errStr.includes('-4509')) {
                log.system(`[AutoTrade] Vị thế ${sym} đã đóng trên sàn trong khi dịch SL.`);
              } else if (errStr.includes('-2021') || /immediately trigger/i.test(errStr)) {
                log.warn(`[AutoTrade] SL mới ${sym} @ $${targetSlStr} bị -2021 (giá đã xuyên mốc) -> Đóng MARKET bảo vệ ngay lập tức!`);
                await closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders, 'TrailingSL_-2021').catch(ce =>
                  log.error(`[AutoTrade] Đóng MARKET -2021 cho ${sym} thất bại: ${ce.message}`)
                );
              } else {
                log.warn(`[AutoTrade] Đặt SL mới trên sàn cho ${sym} thất bại: ${errStr} -> Rollback SL cũ @ $${prevExchangeSl}`);
                if (prevExchangeSl && prevExchangeSl > 0 && prevExchangeSl !== roundedTargetSl) {
                  try {
                    const rbSl = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', prevExchangeSl);
                    const rbId = rbSl?.algoId ?? rbSl?.orderId ?? null;
                    if (meta && rbId != null) {
                      meta.slOrderId = String(rbId);
                      saveActiveTradesMetadata();
                    }
                    log.warn(`[AutoTrade] 🔄 Đã khôi phục SL cũ ${sym} @ $${prevExchangeSl} (id=${rbId})`);
                  } catch (rbErr) {
                    log.error(`[AutoTrade] 🚨 Khôi phục SL cũ ${sym} thất bại: ${_binanceErr(rbErr)}`);
                  }
                }
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
          const typeLabel = isRunnerSlValid ? 'Trailing SL Runner' : (canApplyTrailingSl ? 'M15 Fractal Trailing SL' : 'Stop Loss');
          log.system(`[AutoTrade] [Virtual ${typeLabel}] Kích hoạt cho ${sym}: Giá ${markPrice} chạm/vượt mốc $${targetSlStr}. Đóng vị thế bằng lệnh MARKET.`);
          try {
            await closeRealPositionMarket(client, sym, oppositeSide, absAmt, openAlgoOrders, `Virtual ${typeLabel}`);
            await sendTelegram(`🛡️ <b>${typeLabel} (Virtual)</b>\n• Coin: <b>${sym}</b>\n• ROI đạt: <b>${roi.toFixed(2)}%</b>`);
            // ── Record trade exit for AI Dataset ──
            if (meta) {
              const holdingDurationMinutes = (Date.now() - (meta.time || Date.now())) / 60000;
              const isRunnerSl = isRunnerSlValid;
              const exitTypeVirtual = isRunnerSl ? 'TREND_RUNNER_TP' : ((canApplyTrailingSl && roi > 0) ? 'TRAILING_SL' : 'SL');
              const isWinVirtual = isRunnerSl || roi > 0;
              recordTradeExit({
                tradeId: `${sym}-${meta.orderId || 'vSL'}`,
                orderId: String(meta.orderId || ''),
                symbol: sym,
                exitPrice: markPrice,
                exitTimestamp: Date.now(),
                exitType: exitTypeVirtual,
                pnlPercent: roi,
                pnlUsd: (roi / 100) * (meta.margin || 0),
                holdingDurationMinutes: holdingDurationMinutes,
                isWin: isWinVirtual,
              });
              const hasTakenPartial = !!(meta?.isPartialClosed || partialClosedSymbols.has(sym));
              recordDirectionalTradeExit({
                symbol: sym,
                side: isLong ? 'LONG' : 'SHORT',
                isWin: isWinVirtual || hasTakenPartial,
                exitType: exitTypeVirtual,
                pnlUsd: (roi / 100) * (meta.margin || 0),
                pnlPercent: roi,
                isPartialClosed: hasTakenPartial
              });
              recordRealTradeOutcome({
                symbol: sym,
                side: isLong ? 'LONG' : 'SHORT',
                isWin: isWinVirtual || hasTakenPartial,
                exitType: exitTypeVirtual,
                pnlUsd: (roi / 100) * (meta.margin || 0),
                pnlPercent: roi,
                isPartialClosed: hasTakenPartial
              });
            }

            // 🛡️ Kích hoạt Cooldown nếu lệnh đóng do Stop Loss thực sự hoặc bị lỗ âm
            const estPnlUsd = (roi / 100) * (meta?.margin || 0);
            const isActualLoss = (typeLabel === 'Stop Loss' && !partialClosedSymbols.has(sym)) && (roi < -1.0 || estPnlUsd < -0.5);
            if (isActualLoss) {
              addSymbolToCooldown(sym, 8.0, 'VIRTUAL_SL_LOSS');
              log.system(`[CooldownManager] ⏳ Đưa ${sym} vào Cooldown 8 giờ do Virtual SL / Lỗ âm (${roi.toFixed(2)}%)`);
            }
          } catch (e) {
            justClosedByBot.delete(sym);
            log.error(`[AutoTrade] [${typeLabel}] Lỗi đóng vị thế ${sym}: ${e.message}`);
          }
        } else if (!isFetchFailed) {
          // Chưa chạm mốc cắt lỗ -> Đặt lệnh SL thật lên sàn (chỉ đặt khi truy vấn lệnh trước đó không bị lỗi/throttle)
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
      // Lấy 20 giao dịch cá nhân gần nhất của symbol này để đảm bảo không bị sót nếu có nhiều fill nhỏ
      const trades = await client.getUserTrades(sym, 20);
      if (trades && trades.length > 0) {
        const oppositeSide = prevPos.isLong ? 'SELL' : 'BUY';
        // 🛡️ BẮT BUỘC lọc các giao dịch khớp SAU KHI vị thế được mở (meta.time - 10s buffer)
        // để tránh nhặt nhầm giao dịch đóng vị thế cũ từ các ngày trước!
        const minTradeTime = meta?.time ? (meta.time - 10000) : (Date.now() - 30 * 60 * 1000);
        const closeTrades = trades.filter(t => t.side === oppositeSide && t.time >= minTradeTime);

        if (closeTrades.length > 0) {
          closeTrades.sort((a, b) => b.time - a.time);
          const recentCloseTime = closeTrades[0].time;
          // 🛡️ Gom tất cả các lượt fill đóng vị thế gần nhất (cửa sổ 60s hoặc đến khi đủ khối lượng vị thế)
          // Khắc phục triệt để lỗi sót partial fills trên các coin thanh khoản mỏng (như TAG)
          const targetCloseQty = Math.abs(prevPos.amt || 0);
          let accumulatedQty = 0;
          const exitFills = [];

          for (const t of closeTrades) {
            const qty = parseFloat(t.qty || t.quantity || '0');
            const timeDiff = Math.abs(t.time - recentCloseTime);
            if (timeDiff <= 60000) {
              exitFills.push(t);
              accumulatedQty += qty;
              if (targetCloseQty > 0 && accumulatedQty >= targetCloseQty * 0.999) {
                break;
              }
            }
          }

          // Tính giá đóng bình quân gia quyền theo khối lượng (VWAP)
          const totalQty = exitFills.reduce((sum, t) => sum + parseFloat(t.qty || t.quantity || '0'), 0);
          if (totalQty > 0) {
            const totalNotional = exitFills.reduce((sum, t) => sum + (parseFloat(t.price) * parseFloat(t.qty || t.quantity || '0')), 0);
            closePrice = Number((totalNotional / totalQty).toFixed(8));
          } else {
            closePrice = parseFloat(closeTrades[0].price);
          }

          realizedProfit = exitFills.reduce((sum, t) => sum + parseFloat(t.realizedPnl || t.realizedProfit || '0'), 0);

          const marginUsed = meta?.margin || (Math.abs(prevPos.amt || 1) * prevPos.entryPrice / (prevPos.leverage || 1));
          if (marginUsed > 0) {
            roi = (realizedProfit / marginUsed) * 100;
          } else {
            const priceDiff = prevPos.isLong ? (closePrice - prevPos.entryPrice) : (prevPos.entryPrice - closePrice);
            roi = (priceDiff / (prevPos.entryPrice || 1)) * (prevPos.leverage || 1) * 100;
          }
          hasTradeData = true;
        }
      }
    } catch (tradeErr) {
      log.warn(`[AutoTrade] Lỗi lấy userTrades cho ${sym}: ${tradeErr.message}`);
    }

    // Nếu không lấy được tradeData mới (hoặc API Binance trả trễ), fallback tính theo markPrice hiện tại
    if (!hasTradeData) {
      const currentMark = (typeof getMarkPrice === 'function' ? getMarkPrice(sym) : null) || prevPos.entryPrice;
      closePrice = currentMark;
      const priceDiff = prevPos.isLong ? (closePrice - prevPos.entryPrice) : (prevPos.entryPrice - closePrice);
      roi = (priceDiff / (prevPos.entryPrice || 1)) * (prevPos.leverage || 1) * 100;
      const marginUsed = meta?.margin || (Math.abs(prevPos.amt || 1) * prevPos.entryPrice / (prevPos.leverage || 1));
      realizedProfit = (roi / 100) * marginUsed;
      hasTradeData = true;
    }

    // Phân loại lý do đóng chính xác dựa vào cả PnL và mức giá chạm so với target TP/SL
    let label = '🛡️ Đóng vị thế (Sàn khớp)';
    let exitType = 'SL';

    // Kiểm tra xem giá đóng có khớp với TP mục tiêu không (xét cả closePrice, maxFavorablePrice và dung sai trượt giá 0.1%)
    // 🛡️ CHỈ công nhận chạm TP nếu lệnh thực sự CÓ LÃI (realizedProfit > 0.1)
    // Loại trừ triệt để trường hợp tierTpPrice bị Defensive Escape dời về Entry hoặc giá từng giật râu đỉnh rồi đảo chiều cắn SL!
    const tpTol = meta?.tierTpPrice ? (meta.tierTpPrice * 0.001) : 0;
    const isPriceAtTp = meta?.tierTpPrice
      ? (prevPos.isLong ? (closePrice >= meta.tierTpPrice - tpTol) : (closePrice <= meta.tierTpPrice + tpTol))
      : false;
    const isPeakAtTp = (meta?.tierTpPrice && meta?.maxFavorablePrice)
      ? (prevPos.isLong ? (meta.maxFavorablePrice >= meta.tierTpPrice - tpTol) : (meta.maxFavorablePrice <= meta.tierTpPrice + tpTol))
      : false;
    const isTpTargetHit = (isPriceAtTp || isPeakAtTp) && realizedProfit > 0.1;

    if ((meta?.isTrendRunner || meta?.runnerStage === 'RUNNING') && realizedProfit > 0.2) {
      label = '🎯 Trend Runner TP';
      exitType = 'TREND_RUNNER_TP';
    } else if ((meta?.isDefensiveBeActive || meta?.defensivePhase === 'PHASE1_BE' || meta?.defensiveMovedToBe) && realizedProfit >= -0.5 && roi >= -2.5) {
      label = '🛡️ Defensive Breakeven';
      exitType = 'DEFENSIVE_BE_EXIT';
    } else if (isTpTargetHit || (realizedProfit > 0.3 && roi >= 15)) {
      label = '🎯 Take Profit';
      exitType = 'TP';
    } else if (realizedProfit > 0.2) {
      const tfStr = meta?.fractalTf ? ` (${meta.fractalTf})` : '';
      label = (meta?.fractalSlPrice || meta?.isBeTriggered) ? `🌊 Fractal Trailing SL (Khóa lãi${tfStr})` : '🛡️ Trailing SL (Khóa lãi)';
      exitType = 'TRAILING_SL';
    } else if (realizedProfit >= -0.2 && roi >= -2.0) {
      const tfStr = meta?.fractalTf ? ` (${meta.fractalTf})` : '';
      label = (meta?.fractalSlPrice || meta?.isBeTriggered) ? `🌊 Fractal Trailing SL (Hòa vốn${tfStr})` : '🛡️ Trailing SL (Hòa vốn)';
      exitType = 'TRAILING_SL';
    } else if (meta?.fractalSlPrice || meta?.isBeTriggered) {
      const tfStr = meta?.fractalTf ? ` (${meta.fractalTf})` : '';
      label = `🌊 Fractal Trailing SL (Bám sóng${tfStr})`;
      exitType = 'SL';
    } else {
      label = '🛡️ Stop Loss';
      exitType = 'SL';
    }

    log.system(`[AutoTrade] [Real Exit] ${sym} (${prevPos.isLong ? 'LONG' : 'SHORT'}): ${label} | Giá: $${prevPos.entryPrice} ➔ $${closePrice} | PnL: $${realizedProfit.toFixed(2)} USDT (ROI: ${roi.toFixed(2)}%)`);

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
      const hasTakenPartial = !!(meta?.isPartialClosed || partialClosedSymbols.has(sym));
      recordDirectionalTradeExit({
        symbol: sym,
        side: prevPos.isLong ? 'LONG' : 'SHORT',
        isWin: (hasTradeData && realizedProfit >= 0) || hasTakenPartial,
        exitType: exitType,
        pnlUsd: realizedProfit,
        pnlPercent: roi,
        isPartialClosed: hasTakenPartial
      });
      recordRealTradeOutcome({
        symbol: sym,
        side: prevPos.isLong ? 'LONG' : 'SHORT',
        isWin: (hasTradeData && realizedProfit >= 0) || hasTakenPartial,
        exitType: exitType,
        pnlUsd: realizedProfit,
        pnlPercent: roi,
        isPartialClosed: hasTakenPartial
      });
    }

    const isActualRealLoss = (exitType === 'SL' && !partialClosedSymbols.has(sym)) && (realizedProfit < -0.5 || roi < -1.0);
    if (isActualRealLoss) {
      addSymbolToCooldown(sym, 8.0, 'SL_LOSS');
      log.system(`[CooldownManager] ⏳ Đưa ${sym} vào Cooldown 8 giờ do khớp SL sàn / Lỗ âm (PnL: $${realizedProfit.toFixed(2)}, ROI: ${roi.toFixed(2)}%)`);
    }

    const pnlSign = realizedProfit >= 0 ? '+' : '';
    const roiSign = roi >= 0 ? '+' : '';
    const sideStr = prevPos.isLong ? 'LONG' : 'SHORT';
    const detailStr = hasTradeData
      ? `\n• Hướng: <b>${sideStr}</b>` +
      `\n• PnL Thực Nhận: <b>${pnlSign}${realizedProfit.toFixed(2)} USDT</b> (ROI: <b>${roiSign}${roi.toFixed(2)}%</b>)` +
      (closePrice && prevPos.entryPrice ? `\n• Giá: <b>$${prevPos.entryPrice}</b> ➔ <b>$${closePrice}</b>` : '')
      : '';

    await sendTelegram(
      `<b>${label}</b>\n` +
      `• Coin: <b>#${sym}</b>` +
      detailStr
    );
  } catch (e) {
    log.warn(`[AutoTrade] Lỗi gửi thông báo đóng vị thế ${sym}: ${e.message}`);
  }
}

module.exports = {
  startAutoTrade,
  calculateTierSLTP,
  buildClusterZones,
  getDynamicRiskProfile,
  checkPreLimitTacticalGatekeeper,
  overrideSafetyBrake,
  isSafetyBrakeActive,
  placeDualBracket,
  ratchetBreakeven,
  ratchetTrailingFractal,
  autoCleanOppositeOrder,
  startDashboard,
  stopDashboard,
  startTelegramCommands,
  stopTelegramCommands,
  triggerBtcFlashDump,
  triggerBtcFlashPump,
  checkBtcFlashGatekeeper,
  isOrderReduceOnly,
};
