'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../pp369/_logger');

const STATE_FILE = path.join(process.cwd(), 'data', 'rolling_performance_guard.json');

// Cấu hình quy chuẩn theo yêu cầu:
const REAL_WINDOW_SIZE = 10;        // Cửa sổ trượt 10 lệnh thật gần nhất
const MIN_TRADES_TO_EVAL = 7;       // Cần tối thiểu 7 lệnh để có đủ mẫu thống kê
const MAX_LOSS_RATE_TRIGGER = 70.0; // Thua >= 70% (tương đương Win Rate < 30%)
const MAX_TOTAL_LOSS_USD = -25.0;   // Tổng lỗ ròng 10 lệnh gần nhất <= -$25 USD
const STAND_DOWN_HOURS = 2.0;       // Thời gian tạm dừng tối thiểu: 2 tiếng
const SHADOW_EVAL_COUNT = 3;        // Đánh giá 3 lệnh shadow gần nhất để mở lại

let _state = {
  recentRealTrades: [], // Array of { symbol, side, isWin, pnlUsd, pnlPercent, exitType, exitTime }
  isStandDown: false,
  standDownUntil: 0,
  standDownReason: '',
  recentShadowTrades: [], // Array of { symbol, signal, outcome, isWin, pnlUsd, exitTime }
  historyLogs: []
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      if (loaded && Array.isArray(loaded.recentRealTrades)) {
        _state = loaded;
      }
    }
  } catch (e) {
    log.warn(`[PerformanceGuard] Lỗi nạp ${STATE_FILE}: ${e.message}`);
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf8');
  } catch (e) {
    log.warn(`[PerformanceGuard] Lỗi ghi ${STATE_FILE}: ${e.message}`);
  }
}

loadState();

/**
 * Ghi nhận kết quả của một lệnh thật vừa đóng trên sàn Binance
 * @param {object} param0
 * @param {string} param0.symbol
 * @param {'LONG'|'SHORT'|'BUY'|'SELL'} param0.side
 * @param {boolean} param0.isWin
 * @param {number} [param0.pnlUsd=0]
 * @param {number} [param0.pnlPercent=0]
 * @param {string} [param0.exitType='SL']
 */
function recordRealTradeOutcome({ symbol, side, isWin, pnlUsd = 0, pnlPercent = 0, exitType = 'SL' }) {
  const now = Date.now();
  const cleanSym = symbol.replace('USDT', '');
  const realPnl = typeof pnlUsd === 'number' ? pnlUsd : 0;
  const isLoss = !isWin || realPnl < -0.2;

  // Thêm vào danh sách 10 lệnh thật gần nhất
  _state.recentRealTrades.push({
    symbol: cleanSym,
    side: (side === 'LONG' || side === 'BUY') ? 'LONG' : 'SHORT',
    isWin: !isLoss,
    pnlUsd: realPnl,
    pnlPercent: typeof pnlPercent === 'number' ? pnlPercent : 0,
    exitType: exitType || 'SL',
    exitTime: now
  });

  // Giữ tối đa 10 lệnh
  if (_state.recentRealTrades.length > REAL_WINDOW_SIZE) {
    _state.recentRealTrades.shift();
  }

  // Nếu đang trong Stand-Down, không kích hoạt lại Stand-Down chồng chéo
  if (_state.isStandDown && now < _state.standDownUntil) {
    saveState();
    return;
  }

  // Đánh giá hiệu suất nếu đã đủ mẫu tối thiểu (>= 7 lệnh)
  if (_state.recentRealTrades.length >= MIN_TRADES_TO_EVAL) {
    const totalCount = _state.recentRealTrades.length;
    const lossCount = _state.recentRealTrades.filter(t => !t.isWin).length;
    const winCount = totalCount - lossCount;
    const winRate = (winCount / totalCount) * 100;
    const lossRate = (lossCount / totalCount) * 100;
    const totalPnl = _state.recentRealTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

    const isLowWinRate = lossRate >= MAX_LOSS_RATE_TRIGGER; // Thua >= 70% (Win < 30%)
    const isExceededLoss = totalPnl <= MAX_TOTAL_LOSS_USD;   // Lỗ >= $25 USD

    if (isLowWinRate || isExceededLoss) {
      _state.isStandDown = true;
      _state.standDownUntil = now + STAND_DOWN_HOURS * 3600 * 1000;
      _state.standDownReason = isLowWinRate && isExceededLoss
        ? `Tỷ lệ thua quá cao (${lossCount}/${totalCount} lệnh = ${lossRate.toFixed(1)}%) và Tổng PnL âm lớn ($${totalPnl.toFixed(2)} USD)`
        : (isLowWinRate 
          ? `Tỷ lệ thắng thấp (${winCount}/${totalCount} lệnh = ${winRate.toFixed(1)}% < 30%)`
          : `Tổng lỗ ròng 10 lệnh gần nhất chạm ngưỡng ($${totalPnl.toFixed(2)} <= -$25.0 USD)`);
      
      _state.recentShadowTrades = []; // Reset để theo dõi 3 lệnh shadow mới
      
      log.system(`[PerformanceGuard] 🚨🚨🚨 [STAND-DOWN ACTIVATED] PHÁT HIỆN AI LỆCH PHA VỚI THỊ TRƯỜNG!`);
      log.system(`                    Lý do: ${_state.standDownReason}.`);
      log.system(`                    Hành động: TẠM KHÓA 100% LỆNH THẬT TRONG TỐI THIỂU 2 TIẾNG.`);
      log.system(`                    Chuyển toàn bộ hệ thống sang SHADOW-ONLY để AI thăm dò và đánh giá 3 lệnh shadow tiếp theo.`);
    }
  }

  saveState();
}

/**
 * Ghi nhận kết quả của một lệnh Shadow đã hoàn tất trong thời gian Stand-Down
 * @param {object} param0
 * @param {string} param0.symbol
 * @param {string} param0.signal
 * @param {string} param0.outcome 'MISSED_TP' | 'SAVED_BE' | 'SAVED_SL'
 * @param {number} [param0.pnlUsd=0]
 * @param {number} [param0.roi=0]
 */
function recordShadowTradeOutcome({ symbol, signal, outcome, pnlUsd = 0, roi = 0 }) {
  if (!_state.isStandDown) return;

  // Bỏ qua các lệnh hủy chờ Limit do Bounce Cancel hoặc Timeout
  if (outcome === 'BOUNCE_CANCEL' || outcome === 'LIMIT_TIMEOUT') return;

  const now = Date.now();
  const isWinOrBE = outcome === 'MISSED_TP' || outcome === 'SAVED_BE' || roi >= 0 || pnlUsd >= 0;

  _state.recentShadowTrades.push({
    symbol: symbol.replace('USDT', ''),
    signal,
    outcome,
    isWinOrBE,
    pnlUsd: typeof pnlUsd === 'number' ? pnlUsd : 0,
    roi: typeof roi === 'number' ? roi : 0,
    exitTime: now
  });

  // Giữ tối đa 5 lệnh shadow gần nhất
  if (_state.recentShadowTrades.length > 5) {
    _state.recentShadowTrades.shift();
  }

  saveState();

  const shadowCount = _state.recentShadowTrades.length;
  log.system(`[PerformanceGuard] 👁️ Ghi nhận kết quả Shadow trong Stand-Down: ${symbol} (${signal}) -> ${outcome} (PnL: $${Number(pnlUsd).toFixed(2)}). Tiến độ đánh giá: ${shadowCount}/${SHADOW_EVAL_COUNT} lệnh.`);

  // Kiểm tra điều kiện mở lại tiền thật (Auto-Resume)
  checkStandDownAutoResume();
}

/**
 * Kiểm tra xem đã đủ điều kiện để tự động gỡ Stand-Down và mở lại tiền thật chưa
 * @returns {boolean} true nếu vừa được mở lại
 */
function checkStandDownAutoResume() {
  if (!_state.isStandDown) return false;

  const now = Date.now();
  const hasElapsedMinTime = now >= _state.standDownUntil; // Đã qua tối thiểu 2 tiếng
  const evaluatedShadows = _state.recentShadowTrades.slice(-SHADOW_EVAL_COUNT); // 3 lệnh shadow gần nhất

  if (!hasElapsedMinTime) {
    const remMin = Math.round((_state.standDownUntil - now) / 60000);
    // Chưa hết 2 tiếng -> Tiếp tục chờ
    return false;
  }

  // Đã hết 2 tiếng, kiểm tra đủ 3 lệnh shadow chưa
  if (evaluatedShadows.length < SHADOW_EVAL_COUNT) {
    // Chưa đủ 3 lệnh shadow -> Tiếp tục giữ Stand-Down để chờ AI có đủ mẫu thẩm định
    return false;
  }

  // Đã đủ 3 lệnh shadow: Kiểm tra chất lượng của 3 lệnh này
  const goodCount = evaluatedShadows.filter(s => s.isWinOrBE).length; // Số lệnh ăn TP hoặc hòa vốn
  const totalShadowPnl = evaluatedShadows.reduce((sum, s) => sum + s.pnlUsd, 0);

  // Điều kiện khôi phục: Ít nhất 2/3 lệnh Shadow có lãi/BE (>= 66.7%) HOẶC Tổng PnL shadow dương
  const isRecovered = goodCount >= 2 || totalShadowPnl > 0;

  if (isRecovered) {
    const symList = evaluatedShadows.map(s => `${s.symbol}:${s.outcome}`).join(', ');
    log.system(`[PerformanceGuard] 🚀🚀🚀 [AI MODEL RE-ALIGNED] AI ĐÃ THẨM ĐỊNH LỆNH ỔN ĐỊNH TRỞ LẠI!`);
    log.system(`                    3 lệnh Shadow gần nhất: [${symList}] (${goodCount}/3 Win/BE, PnL: +$${totalShadowPnl.toFixed(2)} USD).`);
    log.system(`                    TỰ ĐỘNG KHÔI PHỤC GIAO DỊCH TIỀN THẬT TRÊN BINANCE!`);

    _state.isStandDown = false;
    _state.standDownUntil = 0;
    _state.standDownReason = '';
    _state.recentRealTrades = []; // Reset cửa sổ lệnh thật để bắt đầu chu kỳ đánh giá mới
    _state.recentShadowTrades = [];
    saveState();
    return true;
  } else {
    // 3 lệnh shadow vẫn thua -> Thị trường vẫn tiếp tục xấu, gia hạn thêm 1 tiếng để AI tiếp tục thăm dò
    _state.standDownUntil = now + 1.0 * 3600 * 1000;
    _state.recentShadowTrades = []; // Reset để thu thập 3 lệnh mới
    saveState();
    log.system(`[PerformanceGuard] ⚠️ 3 lệnh Shadow gần nhất vẫn chưa ổn định (${goodCount}/3 Win/BE). Gia hạn Stand-Down thêm 1 tiếng để AI tiếp tục thăm dò bảo vệ vốn!`);
    return false;
  }
}

/**
 * Kiểm tra xem giao dịch tiền thật có đang bị tạm dừng không
 * @returns {{ isSuspended: boolean, remainingMinutes: number, reason: string, shadowCount: number, recentPnl: number, winRate: number }}
 */
function isRealTradingSuspended() {
  if (!_state.isStandDown) {
    return {
      isSuspended: false,
      remainingMinutes: 0,
      reason: '',
      shadowCount: 0,
      recentPnl: 0,
      winRate: 100
    };
  }

  // Thử kiểm tra tự động khôi phục
  if (checkStandDownAutoResume()) {
    return {
      isSuspended: false,
      remainingMinutes: 0,
      reason: '',
      shadowCount: 0,
      recentPnl: 0,
      winRate: 100
    };
  }

  const now = Date.now();
  const remMin = Math.max(0, Math.round((_state.standDownUntil - now) / 60000));
  const totalCount = _state.recentRealTrades.length;
  const winCount = _state.recentRealTrades.filter(t => t.isWin).length;
  const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;
  const totalPnl = _state.recentRealTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

  return {
    isSuspended: true,
    remainingMinutes: remMin,
    reason: _state.standDownReason,
    shadowCount: _state.recentShadowTrades.length,
    recentPnl: totalPnl,
    winRate
  };
}

/**
 * Mở lại thủ công giao dịch tiền thật nếu người dùng muốn
 */
function clearStandDown() {
  _state.isStandDown = false;
  _state.standDownUntil = 0;
  _state.standDownReason = '';
  _state.recentRealTrades = [];
  _state.recentShadowTrades = [];
  saveState();
  log.system(`[PerformanceGuard] 🔓 Đã giải phóng Stand-Down thủ công. Giao dịch tiền thật đã được mở lại!`);
}

/**
 * Lấy báo cáo tóm tắt trạng thái Guard
 */
function getGuardReport() {
  const totalCount = _state.recentRealTrades.length;
  const winCount = _state.recentRealTrades.filter(t => t.isWin).length;
  const totalPnl = _state.recentRealTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

  return {
    isStandDown: _state.isStandDown,
    standDownUntil: _state.standDownUntil,
    standDownReason: _state.standDownReason,
    realTradesCount: totalCount,
    realWinRate: totalCount > 0 ? (winCount / totalCount) * 100 : 0,
    realTotalPnl: totalPnl,
    recentShadowCount: _state.recentShadowTrades.length,
    recentShadows: _state.recentShadowTrades
  };
}

module.exports = {
  recordRealTradeOutcome,
  recordShadowTradeOutcome,
  isRealTradingSuspended,
  clearStandDown,
  getGuardReport,
  loadState,
  REAL_WINDOW_SIZE,
  MIN_TRADES_TO_EVAL,
  MAX_TOTAL_LOSS_USD,
  STAND_DOWN_HOURS,
  SHADOW_EVAL_COUNT
};
