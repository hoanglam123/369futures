'use strict';

/**
 * Directional Circuit Breaker — Phase 4 Ngắt mạch theo chiều (LONG / SHORT)
 *
 * Chống chuỗi thua dây chuyền khi thị trường gãy cấu trúc hoặc có tin tức thiên nga đen:
 * - 2 lệnh thua trong 40 phút -> Khóa chiều đó 60 phút (Flash Surge).
 * - 3 lệnh thua trong 2 giờ -> Khóa chiều đó 120 phút (Trend Breakdown).
 * - Chiều ngược lại vẫn hoạt động bình thường.
 * - Tự động mở khóa sớm nếu 5 lệnh Shadow ảo cùng chiều cho thấy thị trường hồi phục (Win/BE >= 60% và PnL >= 0).
 */

const fs   = require('fs');
const path = require('path');
const { log } = require('./logger');

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'directional_circuit_breaker.json');

const WINDOW_MS          = 2 * 60 * 60 * 1000;    // 2 giờ (120 phút)
const MAX_LOSSES_TRIGGER = 3;                    // 3 lệnh thua trong 2 giờ -> Khóa
const FLASH_WINDOW_MS    = 40 * 60 * 1000;       // 40 phút
const FLASH_LOSSES_TRIGGER = 2;                  // 2 lệnh thua trong 40 phút -> Khóa
const FLASH_LOCK_HOURS   = 1.0;                  // Khóa 60 phút
const TREND_LOCK_HOURS   = 2.0;                  // Khóa 120 phút
const DEFAULT_LOCK_HOURS = 1.0;
const SHADOW_EVAL_COUNT  = 5;                    // 5 lệnh shadow để đánh giá mở sớm
const MIN_LOCK_BEFORE_EARLY_UNLOCK_MS = 15 * 60 * 1000; // Khóa tối thiểu 15p trước khi mở sớm

let _state = {
  LONG: {
    losses: [],
    lockedUntil: 0,
    lockedAt: 0,
    lockReason: '',
    shadowTrades: []
  },
  SHORT: {
    losses: [],
    lockedUntil: 0,
    lockedAt: 0,
    lockReason: '',
    shadowTrades: []
  }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      if (loaded && loaded.LONG && loaded.SHORT) {
        _state = loaded;
      }
    }
  } catch (e) {
    log.warn(`[DirectionalCB] Lỗi nạp ${STATE_FILE}: ${e.message}`);
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf8');
  } catch (e) {
    log.warn(`[DirectionalCB] Lỗi lưu ${STATE_FILE}: ${e.message}`);
  }
}

loadState();

/**
 * Ghi nhận kết quả của một lệnh Shadow đã hoàn tất trong thời gian bị khóa để đánh giá mở khóa sớm
 */
function recordDirectionalShadowOutcome({ symbol, signal, outcome, pnlUsd = 0, roi = 0 }) {
  const normSide = (signal === 'LONG' || signal === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();
  const dirData = _state[normSide];

  if (!dirData || !dirData.lockedUntil || now >= dirData.lockedUntil) return false;

  if (outcome === 'BOUNCE_CANCEL' || outcome === 'LIMIT_TIMEOUT') return false;

  if (!Array.isArray(dirData.shadowTrades)) {
    dirData.shadowTrades = [];
  }

  const cleanSym = (symbol || '').replace('USDT', '').toUpperCase();
  const numPnl = typeof pnlUsd === 'number' ? pnlUsd : 0;
  const numRoi = typeof roi === 'number' ? roi : 0;
  const isWinOrBE = outcome === 'MISSED_TP' || outcome === 'SAVED_BE' || outcome === 'TIMEOUT_PROFIT' || numRoi >= 0 || numPnl >= 0;

  const newTrade = {
    symbol: cleanSym,
    outcome,
    isWinOrBE,
    pnlUsd: Math.round(numPnl * 100) / 100,
    roi: Math.round(numRoi * 100) / 100,
    exitTime: now
  };

  const existingIdx = dirData.shadowTrades.findIndex(t => t.symbol === cleanSym);
  if (existingIdx >= 0) {
    dirData.shadowTrades[existingIdx] = newTrade;
  } else {
    dirData.shadowTrades.push(newTrade);
  }

  if (dirData.shadowTrades.length > SHADOW_EVAL_COUNT) {
    dirData.shadowTrades.shift();
  }

  saveState();

  const count = dirData.shadowTrades.length;
  const totalShadowPnl = dirData.shadowTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const goodCount = dirData.shadowTrades.filter(t => t.isWinOrBE).length;

  log.system(`[DirectionalCB] Ghi nhận Shadow ${normSide}: ${cleanSym} -> ${outcome} ($${numPnl.toFixed(2)}). Tiến độ mở khóa: ${count}/${SHADOW_EVAL_COUNT} coin (PnL: $${totalShadowPnl.toFixed(2)}, ${goodCount}/${count} Win/BE)`);

  if (count >= SHADOW_EVAL_COUNT) {
    const elapsedLockMs = now - (dirData.lockedAt || 0);
    if (elapsedLockMs < MIN_LOCK_BEFORE_EARLY_UNLOCK_MS) {
      return false;
    }

    const isStable = totalShadowPnl >= 0 && (goodCount / count) >= 0.60;
    if (isStable) {
      log.system(`[AutoTrade] 🔓 [CIRCUIT BREAKER] 5 coin Shadow chiều ${normSide} đã ổn định -> TỰ ĐỘNG MỞ KHÓA CHIỀU ${normSide} SỚM!`);
      dirData.lockedUntil = 0;
      dirData.lockedAt = 0;
      dirData.lockReason = '';
      dirData.losses = [];
      dirData.shadowTrades = [];
      saveState();
      return true;
    }
  }

  return false;
}

/**
 * Ghi nhận kết quả lệnh thật vừa đóng để cập nhật Cửa sổ trượt
 */
function recordDirectionalTradeExit({ symbol, side, isWin, exitType, pnlUsd = 0, pnlPercent = 0, isPartialClosed = false }) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();

  const isProtectedExit = isPartialClosed || exitType === 'TRAILING_SL' || exitType === 'DEFENSIVE_BE_EXIT' || exitType === 'BE_EXIT';
  if (isProtectedExit && (pnlUsd >= -0.2 || pnlPercent >= -2.0)) {
    return;
  }

  const isLoss = !isWin && !isPartialClosed && (exitType === 'SL' || exitType === 'HARD_MAX_LOSS' || pnlPercent < -0.5 || pnlUsd < -0.2);

  if (isLoss) {
    if (!_state[normSide]) _state[normSide] = { losses: [], lockedUntil: 0, lockReason: '', shadowTrades: [] };

    // Dọn dẹp các lệnh quá hạn 2 tiếng
    _state[normSide].losses = (_state[normSide].losses || []).filter(l => (now - l.exitTime) <= WINDOW_MS);

    _state[normSide].losses.push({
      symbol: (symbol || '').replace('USDT', ''),
      exitTime: now,
      pnlUsd: typeof pnlUsd === 'number' ? pnlUsd : 0,
      pnlPercent: typeof pnlPercent === 'number' ? pnlPercent : 0,
      exitType: exitType || 'SL'
    });

    const recentLosses = _state[normSide].losses;
    const count2h = recentLosses.length;
    const countFlash = recentLosses.filter(l => (now - l.exitTime) <= FLASH_WINDOW_MS).length;

    log.warn(`[AutoTrade] ⚠️ [DirectionalCB] Ghi nhận lệnh ${normSide} dính SL: ${symbol} (${exitType} | PnL: $${Number(pnlUsd).toFixed(2)} USD). Tổng SL chiều ${normSide} 2h: ${count2h} lệnh (40p: ${countFlash} lệnh).`);

    let shouldLock = false;
    let lockReason = '';
    let lockHours = DEFAULT_LOCK_HOURS;

    if (countFlash >= FLASH_LOSSES_TRIGGER) {
      shouldLock = true;
      lockReason = `Flash Surge (${countFlash} lệnh ${normSide} dính SL trong 40 phút)`;
      lockHours = FLASH_LOCK_HOURS;
    } else if (count2h >= MAX_LOSSES_TRIGGER) {
      shouldLock = true;
      const symList = recentLosses.map(l => l.symbol).join(', ');
      lockReason = `Xu hướng ngược áp đảo (${count2h} lệnh ${normSide} dính SL trong 2h: [${symList}])`;
      lockHours = TREND_LOCK_HOURS;
    }

    if (shouldLock) {
      const lockUntil = now + lockHours * 3600 * 1000;
      _state[normSide].lockedAt = now;
      _state[normSide].lockedUntil = Math.max(_state[normSide].lockedUntil || 0, lockUntil);
      _state[normSide].lockReason = lockReason;
      _state[normSide].shadowTrades = [];
      saveState();

      log.warn(`[AutoTrade] 🚨 [CIRCUIT BREAKER] KÍCH HOẠT KHÓA CHIỀU ${normSide} TRONG ${lockHours} GIỜ! Lý do: ${lockReason}`);
    } else {
      saveState();
    }
  } else if (isWin || exitType === 'TP') {
    if (_state[normSide]?.losses?.length > 0) {
      _state[normSide].losses.shift();
      saveState();
    }
  }
}

/**
 * Kiểm tra xem một chiều (LONG hay SHORT) có đang bị ngắt mạch khóa không
 */
function isDirectionLocked(side) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();
  const dirData = _state[normSide];

  if (!dirData) return { isLocked: false, remainingMinutes: 0, reason: '', count: 0 };

  dirData.losses = (dirData.losses || []).filter(l => (now - l.exitTime) <= WINDOW_MS);

  if (dirData.lockedUntil && now < dirData.lockedUntil) {
    const remainingMinutes = Math.round((dirData.lockedUntil - now) / 60000);
    return {
      isLocked: true,
      remainingMinutes,
      reason: dirData.lockReason || 'DIRECTIONAL_SL_STREAK',
      count: dirData.losses.length
    };
  }

  if (dirData.lockedUntil && now >= dirData.lockedUntil) {
    log.system(`[AutoTrade] 🔓 [CIRCUIT BREAKER] Hết thời gian ngắt mạch chiều ${normSide}. Tự động khôi phục giao dịch ${normSide}!`);
    dirData.lockedUntil = 0;
    dirData.lockedAt = 0;
    dirData.lockReason = '';
    dirData.losses = [];
    dirData.shadowTrades = [];
    saveState();
  }

  return {
    isLocked: false,
    remainingMinutes: 0,
    reason: '',
    count: dirData.losses.length
  };
}

function clearDirectionLock(side) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  if (_state[normSide]) {
    _state[normSide].lockedUntil = 0;
    _state[normSide].lockedAt = 0;
    _state[normSide].lockReason = '';
    _state[normSide].losses = [];
    _state[normSide].shadowTrades = [];
    saveState();
    log.system(`[AutoTrade] 🔓 [CIRCUIT BREAKER] Đã giải phóng khóa chiều ${normSide}`);
  }
}

function getDirectionalStatus() {
  const now = Date.now();
  return {
    LONG: isDirectionLocked('LONG'),
    SHORT: isDirectionLocked('SHORT'),
    recentLongLosses: (_state.LONG?.losses || []).filter(l => (now - l.exitTime) <= WINDOW_MS),
    recentShortLosses: (_state.SHORT?.losses || []).filter(l => (now - l.exitTime) <= WINDOW_MS)
  };
}

module.exports = {
  recordDirectionalTradeExit,
  recordDirectionalShadowOutcome,
  isDirectionLocked,
  clearDirectionLock,
  getDirectionalStatus,
  WINDOW_MS,
  MAX_LOSSES_TRIGGER,
  FLASH_WINDOW_MS,
  FLASH_LOSSES_TRIGGER,
  FLASH_LOCK_HOURS,
  TREND_LOCK_HOURS,
  SHADOW_EVAL_COUNT
};
