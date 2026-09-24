'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../pp369/_logger');

const STATE_FILE = path.join(process.cwd(), 'data', 'directional_circuit_breaker.json');

// Cấu hình Cửa sổ trượt thời gian (Sliding Window):
const WINDOW_MS = 2 * 60 * 60 * 1000;      // 2 giờ (120 phút)
const MAX_LOSSES_TRIGGER = 3;              // 3 lệnh thua trong 2 giờ -> Kích hoạt khóa
const FLASH_WINDOW_MS = 15 * 60 * 1000;    // 15 phút (Mật độ thua dồn dập)
const FLASH_LOSSES_TRIGGER = 2;            // 2 lệnh thua dồn dập trong 15 phút -> Kích hoạt khóa
const DEFAULT_LOCK_HOURS = 1.5;            // Thời gian khóa 90 phút
const SHADOW_EVAL_COUNT = 5; // Số lệnh shadow cần theo dõi sau khi khóa để đánh giá độ ổn định

let _state = {
  LONG: {
    losses: [],      // Array of { symbol, exitTime, pnlUsd, pnlPercent, exitType }
    lockedUntil: 0,
    lockReason: '',
    shadowTrades: [] // Array of { symbol, outcome, isWinOrBE, pnlUsd, roi, exitTime }
  },
  SHORT: {
    losses: [],
    lockedUntil: 0,
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
    log.warn(`[DirectionalCB] Lỗi ghi ${STATE_FILE}: ${e.message}`);
  }
}

loadState();

/**
 * Ghi nhận kết quả của một lệnh Shadow đã hoàn tất trong thời gian bị khóa để đánh giá mở khóa sớm
 * Quy tắc: Theo dõi 5 lệnh Shadow sau khi khóa, nếu tổng PnL 5 lệnh đã ổn định thì mở khóa sớm
 * @param {object} param0
 * @param {string} param0.symbol Mã coin
 * @param {'LONG'|'SHORT'|'BUY'|'SELL'} param0.signal Chiều lệnh
 * @param {string} param0.outcome 'MISSED_TP' | 'SAVED_BE' | 'SAVED_SL' | 'TIMEOUT_PROFIT' | 'TIMEOUT_LOSS' | 'REAL_TP'
 * @param {number} [param0.pnlUsd=0] Lãi/lỗ USD
 * @param {number} [param0.roi=0] ROI %
 * @returns {boolean} true nếu vừa giải phóng khóa thành công
 */
function recordDirectionalShadowOutcome({ symbol, signal, outcome, pnlUsd = 0, roi = 0 }) {
  const normSide = (signal === 'LONG' || signal === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();
  const dirData = _state[normSide];

  // Chỉ đánh giá khi chiều này ĐANG BỊ KHÓA
  if (!dirData || !dirData.lockedUntil || now >= dirData.lockedUntil) return false;

  // Bỏ qua các lệnh hủy Limit chưa khớp
  if (outcome === 'BOUNCE_CANCEL' || outcome === 'LIMIT_TIMEOUT') return false;

  if (!Array.isArray(dirData.shadowTrades)) {
    dirData.shadowTrades = [];
  }

  const cleanSym = (symbol || '').replace('USDT', '');
  const numPnl = typeof pnlUsd === 'number' ? pnlUsd : 0;
  const numRoi = typeof roi === 'number' ? roi : 0;
  const isWinOrBE = outcome === 'MISSED_TP' || outcome === 'SAVED_BE' || outcome === 'REAL_TP' || outcome === 'TIMEOUT_PROFIT' || numRoi >= 0 || numPnl >= 0;

  dirData.shadowTrades.push({
    symbol: cleanSym,
    outcome,
    isWinOrBE,
    pnlUsd: Math.round(numPnl * 100) / 100,
    roi: Math.round(numRoi * 100) / 100,
    exitTime: now
  });

  // Chỉ giữ tối đa SHADOW_EVAL_COUNT (5 lệnh) gần nhất
  if (dirData.shadowTrades.length > SHADOW_EVAL_COUNT) {
    dirData.shadowTrades.shift();
  }

  saveState();

  const count = dirData.shadowTrades.length;
  const totalShadowPnl = dirData.shadowTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const goodCount = dirData.shadowTrades.filter(t => t.isWinOrBE).length;

  log.system(`[DirectionalCB] 👁️ Ghi nhận kết quả Shadow chiều ${normSide}: ${cleanSym} -> ${outcome} (PnL: $${numPnl >= 0 ? '+' : ''}${numPnl.toFixed(2)} USD). Tiến độ đánh giá mở khóa: ${count}/${SHADOW_EVAL_COUNT} lệnh (Tổng PnL: $${totalShadowPnl >= 0 ? '+' : ''}${totalShadowPnl.toFixed(2)} USD, ${goodCount}/${count} Win/BE).`);

  // Kiểm tra điều kiện mở khóa sớm khi đã đủ 5 lệnh shadow
  if (count >= SHADOW_EVAL_COUNT) {
    // Tiêu chuẩn ổn định:
    // 1. Tổng PnL của 5 lệnh >= 0 USD (bảo toàn vốn hoặc dương)
    // HOẶC 2. Có ít nhất 3/5 lệnh Win/BE (>= 60%) và tổng PnL không bị lỗ nặng (>= -0.5 USD)
    const isStable = totalShadowPnl >= 0 || (goodCount >= 3 && totalShadowPnl >= -0.5);

    if (isStable) {
      const symList = dirData.shadowTrades.map(t => `${t.symbol}:${t.outcome}($${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)})`).join(', ');
      log.system(`[DirectionalCB] 🚀🚀 [AI Market Recovery] 5 lệnh Shadow chiều ${normSide} đã ổn định: [${symList}] (Tổng PnL: $${totalShadowPnl >= 0 ? '+' : ''}${totalShadowPnl.toFixed(2)} USD, ${goodCount}/5 Win/BE) -> Sóng ngược đã hạ nhiệt, AI TỰ ĐỘNG MỞ KHÓA CHIỀU ${normSide} SỚM!`);
      dirData.lockedUntil = 0;
      dirData.lockReason = '';
      dirData.losses = [];
      dirData.shadowTrades = [];
      dirData.extensionCount = 0;
      saveState();
      return true;
    }
  }

  return false;
}

/**
 * Thử giải phóng khóa sớm cho một chiều nếu có bằng chứng thị trường hồi phục / phe đó có lãi ổn định
 * @param {'LONG'|'SHORT'|'BUY'|'SELL'} side 
 * @param {string} symbol 
 * @param {number} roi 
 * @param {string} [source='SHADOW_PROFIT'] 'REAL_TP' | 'REAL_PROFIT' | 'SHADOW_TP' | 'SHADOW_PROFIT'
 * @returns {boolean} true nếu vừa giải phóng khóa thành công
 */
function tryEarlyDirectionalRecovery(side, symbol, roi = 0, source = 'SHADOW_PROFIT') {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();
  const dirData = _state[normSide];

  if (dirData && dirData.lockedUntil && now < dirData.lockedUntil) {
    if (source === 'REAL_TP' || source === 'REAL_PROFIT') {
      const pnlUsd = (Number(roi) / 100) * 3.0;
      return recordDirectionalShadowOutcome({
        symbol,
        signal: normSide,
        outcome: source,
        pnlUsd,
        roi: Number(roi)
      });
    }
  }
  return false;
}

/**
 * Ghi nhận kết quả một lệnh vừa đóng để cập nhật Cửa sổ trượt
 * @param {object} param0
 * @param {string} param0.symbol Mã coin
 * @param {'LONG'|'SHORT'|'BUY'|'SELL'} param0.side Hướng lệnh
 * @param {boolean} param0.isWin Lệnh thắng (TP) hay thua (SL)
 * @param {string} param0.exitType 'TP' | 'SL' | 'HARD_MAX_LOSS' | 'PANIC_ESCAPE' | ...
 * @param {number} [param0.pnlUsd=0] Lãi lỗ USD
 * @param {number} [param0.pnlPercent=0] Lãi lỗ %
 */
function recordDirectionalTradeExit({ symbol, side, isWin, exitType, pnlUsd = 0, pnlPercent = 0 }) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();

  const isLoss = !isWin && (exitType === 'SL' || exitType === 'HARD_MAX_LOSS' || pnlPercent < -0.5 || pnlUsd < -0.2);

  if (isLoss) {
    if (!_state[normSide]) _state[normSide] = { losses: [], lockedUntil: 0, lockReason: '', shadowTrades: [] };

    // Dọn dẹp các lệnh quá hạn 2 tiếng trong cửa sổ
    _state[normSide].losses = (_state[normSide].losses || []).filter(l => (now - l.exitTime) <= WINDOW_MS);

    _state[normSide].losses.push({
      symbol: symbol.replace('USDT', ''),
      exitTime: now,
      pnlUsd: typeof pnlUsd === 'number' ? pnlUsd : 0,
      pnlPercent: typeof pnlPercent === 'number' ? pnlPercent : 0,
      exitType: exitType || 'SL'
    });

    const recentLosses = _state[normSide].losses;
    const count2h = recentLosses.length;

    // Kiểm tra mất mát chớp nhoáng (Flash losses trong 15p)
    const count15m = recentLosses.filter(l => (now - l.exitTime) <= FLASH_WINDOW_MS).length;

    log.system(`[DirectionalCB] ⚠️ Ghi nhận lệnh ${normSide} dính SL: ${symbol} (${exitType} | PnL: $${Number(pnlUsd).toFixed(2)} USD). Tổng SL chiều ${normSide} trong 2h qua: ${count2h} lệnh (15p qua: ${count15m} lệnh).`);

    let shouldLock = false;
    let lockReason = '';
    let lockHours = DEFAULT_LOCK_HOURS;

    if (count15m >= FLASH_LOSSES_TRIGGER) {
      shouldLock = true;
      lockReason = `Flash Surge (${count15m} lệnh ${normSide} dính SL dồn dập trong 15 phút)`;
      lockHours = 1.5;
    } else if (count2h >= MAX_LOSSES_TRIGGER) {
      shouldLock = true;
      const symList = recentLosses.map(l => l.symbol).join(', ');
      lockReason = `Xu hướng ngược áp đảo (${count2h} lệnh ${normSide} dính SL trong 2h: [${symList}])`;
      lockHours = 2.0;
    }

    if (shouldLock) {
      const lockUntil = now + lockHours * 3600 * 1000;
      _state[normSide].lockedUntil = Math.max(_state[normSide].lockedUntil || 0, lockUntil);
      _state[normSide].lockReason = lockReason;
      _state[normSide].shadowTrades = [];
      _state[normSide].extensionCount = 0;
      saveState();

      log.system(`[DirectionalCB] 🚨🚨 [DIRECTIONAL CIRCUIT BREAKER] KÍCH HOẠT KHÓA CHIỀU ${normSide} TRONG ${lockHours} GIỜ!`);
      log.system(`               Lý do: ${lockReason}. Tạm dừng 100% lệnh ${normSide} mới để bảo vệ vốn!`);
    } else {
      saveState();
    }
  } else if (isWin || exitType === 'TP') {
    // Nếu có lệnh ăn TP cùng chiều -> Kiểm tra mở khóa sớm hoặc giảm bớt áp lực chuỗi thua
    tryEarlyDirectionalRecovery(normSide, symbol, pnlPercent || 15.0, 'REAL_TP');
    if (_state[normSide] && _state[normSide].losses && _state[normSide].losses.length > 0) {
      _state[normSide].losses.shift(); // Xóa bớt 1 lệnh thua cũ nhất
      saveState();
    }
  }
}

/**
 * Kiểm tra xem một chiều (LONG hay SHORT) có đang bị ngắt mạch khóa không
 * @param {'LONG'|'SHORT'|'BUY'|'SELL'} side 
 * @returns {{ isLocked: boolean, remainingMinutes: number, reason: string, count: number }}
 */
function isDirectionLocked(side) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  const now = Date.now();
  const dirData = _state[normSide];

  if (!dirData) return { isLocked: false, remainingMinutes: 0, reason: '', count: 0 };

  // Dọn dẹp cửa sổ 2h
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
    const shadowCount = (dirData.shadowTrades || []).length;
    const shadowPnl = (dirData.shadowTrades || []).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const winBeCount = (dirData.shadowTrades || []).filter(t => t.isWinOrBE).length;

    // Kiểm tra an toàn: nếu có lệnh shadow và bằng chứng cho thấy thị trường vẫn đang gây lỗ:
    // (shadowPnl < -0.3 USD hoặc win/be < 50% khi có >= 2 lệnh)
    // -> TUYỆT ĐỐI KHÔNG mở khóa chỉ vì hết giờ! Tự động gia hạn thêm 45 phút.
    // Giới hạn tối đa 3 lần gia hạn liên tiếp (tổng cộng ~3.75h) để tránh treo vô hạn nếu thị trường dị biệt
    const extensionCount = dirData.extensionCount || 0;
    const isStillHostile = shadowCount > 0 && (shadowPnl < -0.3 || (shadowCount >= 2 && (winBeCount / shadowCount) < 0.5));

    if (isStillHostile && extensionCount < 3) {
      const extendHours = 0.75; // 45 phút
      dirData.lockedUntil = now + extendHours * 3600 * 1000;
      dirData.extensionCount = extensionCount + 1;
      const symList = dirData.shadowTrades.map(t => `${t.symbol}:${t.outcome}($${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)})`).join(', ');
      dirData.lockReason = `Hostile Market Extension #${dirData.extensionCount} (${shadowCount} lệnh Shadow vẫn đang lỗ: [${symList}], PnL: $${shadowPnl.toFixed(2)} USD)`;
      saveState();

      log.system(`[DirectionalCB] ⚠️ [Dynamic Lock Extension] Hết thời gian ngắt mạch chiều ${normSide}, nhưng ${shadowCount} lệnh Shadow cho thấy thị trường vẫn đang xấu: [${symList}] (PnL: $${shadowPnl.toFixed(2)} USD, ${winBeCount}/${shadowCount} Win/BE).`);
      log.system(`               -> TỰ ĐỘNG GIA HẠN KHÓA CHIỀU ${normSide} THÊM 45 PHÚT (Lần ${dirData.extensionCount}/3) để bảo vệ tài khoản!`);

      return {
        isLocked: true,
        remainingMinutes: Math.round((dirData.lockedUntil - now) / 60000),
        reason: dirData.lockReason,
        count: dirData.losses.length
      };
    }

    const pnlLogStr = shadowPnl >= 0 ? `+$${shadowPnl.toFixed(2)}` : `-$${Math.abs(shadowPnl).toFixed(2)}`;
    log.system(`[DirectionalCB] 🟢 Hết thời gian ngắt mạch chiều ${normSide} và kiểm tra an toàn đạt chuẩn (${shadowCount} lệnh Shadow, PnL: ${pnlLogStr} USD). Tự động khôi phục giao dịch ${normSide} bình thường!`);
    dirData.lockedUntil = 0;
    dirData.lockReason = '';
    dirData.losses = [];
    dirData.shadowTrades = [];
    dirData.extensionCount = 0;
    saveState();
  }

  return {
    isLocked: false,
    remainingMinutes: 0,
    reason: '',
    count: dirData.losses.length
  };
}

/**
 * Mở khóa sớm cho một chiều
 * @param {'LONG'|'SHORT'} side
 */
function clearDirectionLock(side) {
  const normSide = (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT';
  if (_state[normSide]) {
    _state[normSide].lockedUntil = 0;
    _state[normSide].lockReason = '';
    _state[normSide].losses = [];
    _state[normSide].shadowTrades = [];
    _state[normSide].extensionCount = 0;
    saveState();
    log.system(`[DirectionalCB] 🔓 Đã giải phóng khóa chiều ${normSide}.`);
  }
}

/**
 * Lấy trạng thái đầy đủ phục vụ logging / dashboard
 */
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
  tryEarlyDirectionalRecovery,
  getDirectionalStatus,
  WINDOW_MS,
  MAX_LOSSES_TRIGGER,
  FLASH_LOSSES_TRIGGER,
  SHADOW_EVAL_COUNT
};
