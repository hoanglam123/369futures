'use strict';

/**
 * Real-time BTC Flash Guard — Phase 4 Bảo vệ biến tốc BTC 180s (Độ trễ 0ms)
 *
 * Đồng bộ ngưỡng tối ưu với bot-h4 (chống báo động giả & chống Ping-Pong lật chiều):
 * - Dump: Rơi >= 0.65% trong 60s hoặc >= 1.00% trong 180s -> Khóa LONG Altcoin
 * - Pump: Giật tăng >= 0.65% trong 60s hoặc >= 1.00% trong 180s -> Khóa SHORT Altcoin
 * - Phân 2 mức thời gian khóa: MODERATE (20p) vs SEVERE >= 1.50% (45p)
 * - Cooldown chống lật chiều Ping-Pong tối thiểu 5 phút (chỉ vượt qua nếu cú ngược >= 1.20%)
 */

const { log } = require('./logger');

const TICK_WINDOW_MS      = 180_000;  // 3 phút
const MODERATE_LOCK_MS    = 20 * 60 * 1000; // 20 phút cho biến động vừa
const SEVERE_LOCK_MS      = 45 * 60 * 1000; // 45 phút cho bão thật >= 1.5%
const TRIGGER_COOLDOWN_MS = 180_000; // Cooldown 3 phút giữa các lần cảnh báo cùng chiều
const FLIP_COOLDOWN_MS    = 5 * 60 * 1000; // Chống lật chiều Ping-Pong 5 phút
const FLIP_OVERRIDE_PCT   = 1.20;

const WS_60S_THRESHOLD_PCT  = parseFloat(process.env.BTC_FLASH_60S_PCT || '0.65');
const WS_180S_THRESHOLD_PCT = parseFloat(process.env.BTC_FLASH_180S_PCT || '1.00');
const SEVERE_THRESHOLD_PCT  = 1.50;

let _btcTickHistory = []; // [ { t: timestamp, p: price }, ... ]
let _lastTriggerTime = 0;
const _flashListeners = new Set();
let _flashState = {
  activeFlash: null,       // 'FLASH_DUMP' | 'FLASH_PUMP' | null
  severity: 'NORMAL',      // 'NORMAL' | 'MODERATE' | 'SEVERE'
  lockedUntil: 0,
  triggeredAt: 0,
  reason: '',
  velocityPct: 0
};

function onFlashTrigger(cb) {
  if (typeof cb === 'function') _flashListeners.add(cb);
}

function offFlashTrigger(cb) {
  _flashListeners.delete(cb);
}

function _emitFlashEvent(payload) {
  for (const cb of _flashListeners) {
    try { cb(payload); } catch (_) {}
  }
}

/**
 * Nạp tick giá BTC từ WebSocket 0ms
 * @param {number} price Giá BTC hiện tại
 * @param {number} [nowMs] Optional timestamp cho unit test
 */
function processBtcTick(price, nowMs = Date.now()) {
  if (!price || price <= 0 || isNaN(price)) return null;
  const now = nowMs;

  _btcTickHistory.push({ t: now, p: price });

  // Dọn dẹp tick cũ hơn 180s
  while (_btcTickHistory.length > 0 && _btcTickHistory[0].t < now - TICK_WINDOW_MS) {
    _btcTickHistory.shift();
  }

  // Tự động giải phóng trạng thái khóa nếu hết thời gian
  if (_flashState.lockedUntil && now >= _flashState.lockedUntil) {
    log.system(`[AutoTrade] 🔄 [BTC Guard] Thị trường BTC đã hạ nhiệt an toàn. Mở khóa giao dịch bình thường.`);
    _flashState = { activeFlash: null, severity: 'NORMAL', lockedUntil: 0, triggeredAt: 0, reason: '', velocityPct: 0 };
  }

  // Cần ít nhất 4 tick và dữ liệu tích lũy >= 5 giây để tránh nhiễu
  if (_btcTickHistory.length < 4) return _flashState;
  const oldestTick = _btcTickHistory[0];
  if (now - oldestTick.t < 5_000) return _flashState;

  if (now - _lastTriggerTime < TRIGGER_COOLDOWN_MS) return _flashState;

  let max60 = 0, min60 = Infinity;
  let max180 = 0, min180 = Infinity;

  for (let i = _btcTickHistory.length - 1; i >= 0; i--) {
    const tick = _btcTickHistory[i];
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

  const drop60  = max60 > 0 ? ((price - max60) / max60) * 100 : 0;
  const drop180 = max180 > 0 ? ((price - max180) / max180) * 100 : 0;

  // 1. Flash Dump tức thì: Rơi >= 0.65% trong 60s hoặc >= 1.00% trong 180s
  if (drop60 <= -WS_60S_THRESHOLD_PCT || drop180 <= -WS_180S_THRESHOLD_PCT) {
    const changePct = drop60 <= -WS_60S_THRESHOLD_PCT ? drop60 : drop180;
    const windowSec = drop60 <= -WS_60S_THRESHOLD_PCT ? 60 : 180;
    const peakPrice = windowSec === 60 ? max60 : max180;
    _lastTriggerTime = now;
    return triggerFlashDump({
      reason: `BTC xả tốc độ cao (Rơi ${changePct.toFixed(2)}% trong ${windowSec}s: $${peakPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      velocityPct: changePct,
      nowMs: now
    });
  }

  const pump60  = min60 < Infinity ? ((price - min60) / min60) * 100 : 0;
  const pump180 = min180 < Infinity ? ((price - min180) / min180) * 100 : 0;

  // 2. Flash Pump tức thì: Tăng >= +0.65% trong 60s hoặc >= +1.00% trong 180s
  if (pump60 >= WS_60S_THRESHOLD_PCT || pump180 >= WS_180S_THRESHOLD_PCT) {
    const changePct = pump60 >= WS_60S_THRESHOLD_PCT ? pump60 : pump180;
    const windowSec = pump60 >= WS_60S_THRESHOLD_PCT ? 60 : 180;
    const troughPrice = windowSec === 60 ? min60 : min180;
    _lastTriggerTime = now;
    return triggerFlashPump({
      reason: `BTC bơm tốc độ cao (Tăng +${changePct.toFixed(2)}% trong ${windowSec}s: $${troughPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      velocityPct: changePct,
      nowMs: now
    });
  }

  return _flashState;
}

function triggerFlashDump({ reason, velocityPct = -1.0, nowMs = Date.now() }) {
  const now = nowMs;
  const absMove = Math.abs(velocityPct);
  // Chống Ping-Pong 5 phút nếu đang khóa PUMP
  if (_flashState.activeFlash === 'FLASH_PUMP' && now < _flashState.lockedUntil) {
    if ((now - (_flashState.triggeredAt || 0)) < FLIP_COOLDOWN_MS && absMove < FLIP_OVERRIDE_PCT) {
      return _flashState;
    }
  }
  const isSevere = absMove >= SEVERE_THRESHOLD_PCT;
  const lockMs = isSevere ? SEVERE_LOCK_MS : MODERATE_LOCK_MS;
  _flashState = {
    activeFlash: 'FLASH_DUMP',
    severity: isSevere ? 'SEVERE' : 'MODERATE',
    lockedUntil: now + lockMs,
    triggeredAt: now,
    reason: reason || 'BTC FLASH DUMP DETECTED',
    velocityPct
  };
  log.warn(`[AutoTrade] 🚨 [BTC Flash Dump Guard — ${_flashState.severity}] Kích hoạt khóa LONG Altcoin trong ${Math.round(lockMs / 60000)} phút (${reason})`);
  _emitFlashEvent({
    ..._flashState,
    directionToCancel: 'LONG',
    lockMins: Math.round(lockMs / 60000)
  });
  return _flashState;
}

function triggerFlashPump({ reason, velocityPct = 1.0, nowMs = Date.now() }) {
  const now = nowMs;
  const absMove = Math.abs(velocityPct);
  // Chống Ping-Pong 5 phút nếu đang khóa DUMP
  if (_flashState.activeFlash === 'FLASH_DUMP' && now < _flashState.lockedUntil) {
    if ((now - (_flashState.triggeredAt || 0)) < FLIP_COOLDOWN_MS && absMove < FLIP_OVERRIDE_PCT) {
      return _flashState;
    }
  }
  const isSevere = absMove >= SEVERE_THRESHOLD_PCT;
  const lockMs = isSevere ? SEVERE_LOCK_MS : MODERATE_LOCK_MS;
  _flashState = {
    activeFlash: 'FLASH_PUMP',
    severity: isSevere ? 'SEVERE' : 'MODERATE',
    lockedUntil: now + lockMs,
    triggeredAt: now,
    reason: reason || 'BTC FLASH PUMP DETECTED',
    velocityPct
  };
  log.warn(`[AutoTrade] 🚨 [BTC Flash Pump Guard — ${_flashState.severity}] Kích hoạt khóa SHORT Altcoin trong ${Math.round(lockMs / 60000)} phút (${reason})`);
  _emitFlashEvent({
    ..._flashState,
    directionToCancel: 'SHORT',
    lockMins: Math.round(lockMs / 60000)
  });
  return _flashState;
}

function checkBtcFlashStatus() {
  const now = Date.now();
  if (_flashState.lockedUntil && now >= _flashState.lockedUntil) {
    _flashState = { activeFlash: null, severity: 'NORMAL', lockedUntil: 0, triggeredAt: 0, reason: '', velocityPct: 0 };
  }
  return { ..._flashState };
}

function resetFlashGuard() {
  _flashState = { activeFlash: null, severity: 'NORMAL', lockedUntil: 0, triggeredAt: 0, reason: '', velocityPct: 0 };
  _btcTickHistory = [];
  _lastTriggerTime = 0;
}

function getBtcVelocity() {
  if (_btcTickHistory.length < 2) return 0;
  const now = Date.now();
  const first = _btcTickHistory[0];
  const last = _btcTickHistory[_btcTickHistory.length - 1];
  if (!first || !last || first.p <= 0) return 0;
  return parseFloat((((last.p - first.p) / first.p) * 100).toFixed(2));
}

module.exports = {
  processBtcTick,
  checkBtcFlashStatus,
  triggerFlashDump,
  triggerFlashPump,
  resetFlashGuard,
  getBtcVelocity,
  onFlashTrigger,
  offFlashTrigger
};
