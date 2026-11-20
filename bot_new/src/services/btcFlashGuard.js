'use strict';

/**
 * Real-time BTC Flash Guard — Phase 4 Bảo vệ biến tốc BTC 180s (Độ trễ 0ms)
 *
 * Theo dõi từng tick giá BTC qua WebSocket stream theo cửa sổ trượt 180 giây:
 * - Dump: Rơi >= 0.45% trong 60s hoặc >= 0.70% trong 180s (hoặc >= 1.0% trong 3p)
 *   -> Khóa ngay lập tức việc mở lệnh LONG cho toàn bộ Altcoin (0ms, không chờ nến đóng).
 * - Pump: Giật tăng >= 0.45% trong 60s hoặc >= 0.70% trong 180s
 *   -> Khóa ngay lập tức việc mở lệnh SHORT cho toàn bộ Altcoin.
 */

const { log } = require('./logger');

const TICK_WINDOW_MS = 180_000;  // 3 phút
const LOCK_DURATION_MS = 15 * 60 * 1000; // Khóa 15 phút sau khi có biến động bão
const TRIGGER_COOLDOWN_MS = 180_000; // Cooldown 3 phút giữa các lần cảnh báo

let _btcTickHistory = []; // [ { t: timestamp, p: price }, ... ]
let _lastTriggerTime = 0;
let _flashState = {
  activeFlash: null,       // 'FLASH_DUMP' | 'FLASH_PUMP' | null
  lockedUntil: 0,
  reason: '',
  velocityPct: 0
};

/**
 * Nạp tick giá BTC từ WebSocket 0ms
 * @param {number} price Giá BTC hiện tại
 */
function processBtcTick(price) {
  if (!price || price <= 0 || isNaN(price)) return null;
  const now = Date.now();

  _btcTickHistory.push({ t: now, p: price });

  // Dọn dẹp tick cũ hơn 180s
  while (_btcTickHistory.length > 0 && _btcTickHistory[0].t < now - TICK_WINDOW_MS) {
    _btcTickHistory.shift();
  }

  // Tự động giải phóng trạng thái khóa nếu hết thời gian
  if (_flashState.lockedUntil && now >= _flashState.lockedUntil) {
    log.system(`[BTCFlashGuard] 🟢 Thị trường BTC đã qua đợt biến động giật. Mở khóa giao dịch bình thường.`);
    _flashState = { activeFlash: null, lockedUntil: 0, reason: '', velocityPct: 0 };
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

  // 1. Flash Dump tức thì: Rơi >= 0.45% trong 60s hoặc >= 0.70% trong 180s
  if (drop60 <= -0.45 || drop180 <= -0.70) {
    const changePct = drop60 <= -0.45 ? drop60 : drop180;
    const windowSec = drop60 <= -0.45 ? 60 : 180;
    const peakPrice = windowSec === 60 ? max60 : max180;
    _lastTriggerTime = now;
    return triggerFlashDump({
      reason: `BTC xả tốc độ cao (Rơi ${changePct.toFixed(2)}% trong ${windowSec}s: $${peakPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      velocityPct: changePct
    });
  }

  const pump60  = min60 < Infinity ? ((price - min60) / min60) * 100 : 0;
  const pump180 = min180 < Infinity ? ((price - min180) / min180) * 100 : 0;

  // 2. Flash Pump tức thì: Tăng >= +0.45% trong 60s hoặc >= +0.70% trong 180s
  if (pump60 >= 0.45 || pump180 >= 0.70) {
    const changePct = pump60 >= 0.45 ? pump60 : pump180;
    const windowSec = pump60 >= 0.45 ? 60 : 180;
    const troughPrice = windowSec === 60 ? min60 : min180;
    _lastTriggerTime = now;
    return triggerFlashPump({
      reason: `BTC bơm tốc độ cao (Tăng +${changePct.toFixed(2)}% trong ${windowSec}s: $${troughPrice.toFixed(1)} -> $${price.toFixed(1)})`,
      velocityPct: changePct
    });
  }

  return _flashState;
}

function triggerFlashDump({ reason, velocityPct = -1.0 }) {
  const now = Date.now();
  _flashState = {
    activeFlash: 'FLASH_DUMP',
    lockedUntil: now + LOCK_DURATION_MS,
    reason: reason || 'BTC FLASH DUMP DETECTED',
    velocityPct
  };
  log.warn(`[BTCFlashGuard] 🚨🚨 [BTC FLASH DUMP] ${reason} -> TẠM KHÓA TOÀN BỘ LỆNH LONG ALTCOIN!`);
  return _flashState;
}

function triggerFlashPump({ reason, velocityPct = 1.0 }) {
  const now = Date.now();
  _flashState = {
    activeFlash: 'FLASH_PUMP',
    lockedUntil: now + LOCK_DURATION_MS,
    reason: reason || 'BTC FLASH PUMP DETECTED',
    velocityPct
  };
  log.warn(`[BTCFlashGuard] 🚨🚨 [BTC FLASH PUMP] ${reason} -> TẠM KHÓA TOÀN BỘ LỆNH SHORT ALTCOIN!`);
  return _flashState;
}

function checkBtcFlashStatus() {
  const now = Date.now();
  if (_flashState.lockedUntil && now >= _flashState.lockedUntil) {
    _flashState = { activeFlash: null, lockedUntil: 0, reason: '', velocityPct: 0 };
  }
  return { ..._flashState };
}

function resetFlashGuard() {
  _flashState = { activeFlash: null, lockedUntil: 0, reason: '', velocityPct: 0 };
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
  getBtcVelocity
};
