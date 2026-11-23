'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const STATS_FILE  = path.join(DATA_DIR, 'trade_stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'trade_history.json');
const DIVIDER     = '━━━━━━━━━━━━━━━━';
const TIMEZONE    = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const TAKER_FEE   = 0.0004;  // Binance taker fee per side — must match tradeMonitor.js

const DEFAULT = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  totalPnlPct: 0,
  bestTrade: null,   // { symbol, direction, pnlPct }
  worstTrade: null,
  currentStreak: 0,
  streakType: null,  // 'win' | 'loss'
  updatedAt: null,
};

function loadStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATS_FILE)) return { ...DEFAULT };
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) };
  } catch (e) {
    log.warn('Không thể load trade stats', { error: e.message });
    return { ...DEFAULT };
  }
}

function saveStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (e) {
    log.warn('Không thể lưu trade stats', { error: e.message });
  }
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

function saveHistory(history) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    log.warn('Không thể lưu trade history', { error: e.message });
  }
}

const stats = loadStats();

// Map exitReason + result → legacy hit value (backward compat cho old records + reports)
function _deriveHit(exitReason, result) {
  if (exitReason === 'tp')           return 'TP';
  if (exitReason === 'sl')           return 'SL';
  if (exitReason === 'reversed') {
    if (result === 'win')  return 'REV_WIN';
    if (result === 'loss') return 'REV_LOSS';
    return 'reversed';
  }
  if (exitReason === 'manual_close') return 'manual_close';
  return exitReason ?? 'unknown';
}

// Ghi lịch sử 1 lệnh đã đóng vào trade_history.json
function appendHistory(trade, hit, exitReason, result, closePrice, pnlPct) {
  const history = loadHistory();
  const recAt = trade.recommendedAt instanceof Date ? trade.recommendedAt : new Date(trade.recommendedAt);
  const closeAt = trade.closedAt instanceof Date ? trade.closedAt : new Date();
  const durationMs = closeAt - recAt;
  if (durationMs < 60_000) return; // bỏ qua lệnh giả/duplicate < 1 phút
  if (trade.id && history.some(h => h.id === trade.id)) {
    log.warn(`appendHistory: bỏ qua duplicate id=${trade.id} (${trade.symbol} ${trade.direction})`);
    return;
  }
  history.push({
    id:           trade.id,
    symbol:       trade.symbol,
    direction:    trade.direction,
    entryPrice:   trade.entryPrice,
    targetPrice:  trade.targetPrice,
    slPrice:      trade.slPrice,
    leverage:     trade.leverage ?? null,
    hit,                                  // backward compat: 'TP'|'SL'|'REV_WIN'|'REV_LOSS'|'reversed'|'manual_close'
    exitReason,                           // new: 'tp'|'sl'|'reversed'|'manual_close'
    result,                               // new: 'win'|'loss'|'breakeven'|null
    closePrice:   closePrice ?? null,
    pnlPct:       pnlPct ?? null,
    tp1Hit:       trade.tp1Hit ?? false,
    tp2Hit:       trade.tp2Hit ?? false,
    manualEntry:  trade.manualEntry ?? false,
    recommendedAt: recAt.toISOString(),
    closedAt:      closeAt.toISOString(),
    durationMs,
  });
  saveHistory(history);
}

/**
 * Ghi kết quả lệnh vào stats + history.
 *
 * @param {Object}      params.trade       - trade object
 * @param {string}      params.exitReason  - 'tp' | 'sl' | 'reversed' | 'manual_close'
 * @param {string|null} params.result      - 'win' | 'loss' | 'breakeven' | null
 *                                           null = không xác định được kết quả → chỉ ghi history, KHÔNG cập nhật stats
 * @param {number|null} params.closePrice  - giá đóng thực tế
 * @param {number|null} params.pnlPct      - raw PnL % từ entryPrice/closePrice (không leverage)
 */
function recordTradeResult({ trade, exitReason, result, closePrice, pnlPct }) {
  const hit = _deriveHit(exitReason, result);

  // result=null: không xác định được kết quả → chỉ ghi history, bỏ qua stats
  if (result === null) {
    appendHistory(trade, hit, exitReason, result, closePrice, pnlPct);
    log.trade(`recordTradeResult: ${trade.symbol} ${exitReason} result=null — ghi history, bỏ qua stats`);
    return;
  }

  // Cập nhật stats
  stats.totalTrades++;
  if (pnlPct != null) stats.totalPnlPct = parseFloat((stats.totalPnlPct + pnlPct).toFixed(4));

  if (result === 'win') {
    stats.wins++;
    stats.currentStreak = stats.streakType === 'win' ? stats.currentStreak + 1 : 1;
    stats.streakType = 'win';
    if (pnlPct != null && (!stats.bestTrade || pnlPct > stats.bestTrade.pnlPct)) {
      stats.bestTrade = { symbol: trade.symbol, direction: trade.direction, pnlPct };
    }
  } else if (result === 'loss') {
    stats.losses++;
    stats.currentStreak = stats.streakType === 'loss' ? stats.currentStreak + 1 : 1;
    stats.streakType = 'loss';
    if (pnlPct != null && (!stats.worstTrade || pnlPct < stats.worstTrade.pnlPct)) {
      stats.worstTrade = { symbol: trade.symbol, direction: trade.direction, pnlPct };
    }
  }
  // breakeven: totalTrades++ và breakeven++, không cập nhật wins/losses/streak
  if (result === 'breakeven') {
    stats.breakeven = (stats.breakeven ?? 0) + 1;
  }

  stats.updatedAt = new Date().toISOString();
  saveStats();
  appendHistory(trade, hit, exitReason, result, closePrice, pnlPct);
  log.trade(`Stats: ${stats.wins}W/${stats.losses}L | Win rate ${(stats.wins / stats.totalTrades * 100).toFixed(1)}%`);

  // ─── Tích hợp Phase 4: Directional Circuit Breaker & Cooldown Manager ───
  try {
    // Lệnh đóng hòa vốn / có lãi sau khi dời SL về BE (như XRP +1.00% net) KHÔNG tính là lệnh thua SL
    const isRealLoss = result === 'loss' && (pnlPct == null || pnlPct < 0);
    const isProfitOrBE = result === 'win' || result === 'breakeven' || (pnlPct != null && pnlPct >= 0);

    const dirCB = require('./directionalCircuitBreaker');
    if (dirCB && typeof dirCB.recordDirectionalTradeExit === 'function') {
      dirCB.recordDirectionalTradeExit({
        symbol: trade.symbol,
        side: trade.direction,
        isWin: isProfitOrBE,
        exitType: isRealLoss ? 'SL' : (exitReason === 'tp' ? 'TP' : 'BE'),
        pnlPercent: pnlPct ?? 0,
        pnlUsd: (pnlPct ?? 0) * 0.5
      });
    }

    if (isRealLoss) {
      const cdMgr = require('./cooldownManager');
      if (cdMgr && typeof cdMgr.addSymbolToCooldown === 'function') {
        cdMgr.addSymbolToCooldown(trade.symbol, 6.0, `SL_EXIT: ${exitReason}`);
      }
    }
  } catch (err) {
    log.warn(`[TradeStats] Lỗi cập nhật CircuitBreaker/Cooldown: ${err.message}`);
  }
}

// Ghi lịch sử khi lệnh bị đảo chiều (không có P&L rõ ràng)
function recordReversed(trade) {
  appendHistory(trade, 'reversed', 'reversed', null, null, null);
}

/**
 * Cập nhật entry 'reversed' với giá đóng thực tế sau khi user đóng vị thế thủ công trên Binance.
 * Chỉ sửa delta totalPnlPct — KHÔNG thay đổi totalTrades/wins/losses (đã đếm lúc reversal).
 * Đổi exitReason từ 'reversed' → 'manual_close' để không bị re-process lần sau.
 *
 * @returns {boolean} true nếu cập nhật thành công, false nếu không tìm thấy entry
 */
function updateReversedResult({ symbol, direction, entryPrice, actualClosePrice, actualPnlPct, actualResult, actualClosedAt }) {
  const history = loadHistory();
  const idx = history.findLastIndex(h =>
    h.exitReason === 'reversed' &&
    h.symbol    === symbol &&
    h.direction === direction &&
    Math.abs((h.entryPrice || 0) - entryPrice) / Math.max(entryPrice, 1) < 0.001
  );
  if (idx < 0) {
    log.warn(`updateReversedResult: không tìm thấy entry reversed cho ${symbol} ${direction} entry≈${entryPrice}`);
    return false;
  }

  const entry    = history[idx];
  const oldPnlPct = entry.pnlPct ?? 0;
  const delta     = (actualPnlPct ?? 0) - oldPnlPct;

  // Sửa totalPnlPct: thay ước tính bằng thực tế
  if (Math.abs(delta) > 0.00001) {
    stats.totalPnlPct = parseFloat((stats.totalPnlPct + delta).toFixed(4));
  }
  // Điều chỉnh wins/losses nếu result thay đổi (ví dụ win→loss sau close thực tế)
  const oldResult = entry.result;
  if (oldResult != null && actualResult != null && oldResult !== actualResult) {
    if (actualResult === 'win') {
      stats.wins++;
      stats.losses = Math.max(0, stats.losses - 1);
    } else if (actualResult === 'loss') {
      stats.losses++;
      stats.wins = Math.max(0, stats.wins - 1);
    }
    log.trade(`updateReversedResult: ${symbol} ${direction} — result thay đổi ${oldResult} → ${actualResult} (wins=${stats.wins} losses=${stats.losses})`);
  }
  // Update best/worst nếu cần
  if (actualPnlPct != null) {
    if (!stats.bestTrade || actualPnlPct > (stats.bestTrade.pnlPct ?? -Infinity)) {
      stats.bestTrade = { symbol, direction, pnlPct: actualPnlPct };
    }
    if (!stats.worstTrade || actualPnlPct < (stats.worstTrade.pnlPct ?? Infinity)) {
      stats.worstTrade = { symbol, direction, pnlPct: actualPnlPct };
    }
  }
  stats.updatedAt = new Date().toISOString();
  saveStats();

  // Cập nhật history entry: reversed → manual_close, giữ wasReversed=true để dashboard hiện tag REV
  history[idx] = {
    ...entry,
    closePrice:  actualClosePrice ?? entry.closePrice,
    pnlPct:      actualPnlPct    ?? entry.pnlPct,
    result:      actualResult    ?? entry.result,
    hit:         'manual_close',
    exitReason:  'manual_close',
    manualEntry: true,
    wasReversed: true,
    reversedAt:  entry.closedAt ?? null,   // lưu thời điểm REV gốc trước khi ghi đè closedAt
    closedAt:    actualClosedAt  ?? entry.closedAt,
  };
  saveHistory(history);
  recalculateStreakFromHistory();

  log.trade(`updateReversedResult: ${symbol} ${direction} — ước tính ${oldPnlPct.toFixed(4)}% → thực tế ${(actualPnlPct ?? 0).toFixed(4)}% (delta ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}%)`);
  return true;
}

// Tái tính streak từ toàn bộ history (dùng sau updateReversedResult để bù cho việc reversed entry
// được đóng theo thứ tự thời gian khác với thứ tự recordTradeResult được gọi).
function recalculateStreakFromHistory() {
  const history = loadHistory();
  const valid = history
    .filter(h => h.result === 'win' || h.result === 'loss')
    .sort((a, b) => (a.closedAt || '') < (b.closedAt || '') ? -1 : 1);
  if (valid.length === 0) return;
  let streak = 0, type = null;
  for (let i = valid.length - 1; i >= 0; i--) {
    const r = valid[i].result;
    if (type === null)  { type = r; streak = 1; }
    else if (r === type) { streak++; }
    else break;
  }
  stats.currentStreak = streak;
  stats.streakType    = type;
  stats.updatedAt     = new Date().toISOString();
  saveStats();
  log.trade(`recalculateStreak: ${streak} ${type} (từ ${valid.length} entries có result)`);
}

function getStats() {
  return { ...stats };
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '?';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h${m}m`;
  return `${m}p`;
}

function makeWinRateBar(wins, total) {
  const filled = total > 0 ? Math.round((wins / total) * 10) : 0;
  return `<code>${'█'.repeat(filled)}${'░'.repeat(10 - filled)}</code> ${wins}/${total}`;
}

function calcTp2Stats(history) {
  const closed = history.filter(t =>
    t.hit === 'TP' || t.hit === 'SL' ||
    t.exitReason === 'tp' || t.exitReason === 'sl'
  );
  if (!closed.length) return null;
  const tp1Count = closed.filter(t => t.tp1Hit).length;
  const tp2Count = closed.filter(t => t.tp2Hit).length;
  const slTrades = closed.filter(t => t.hit === 'SL' || t.exitReason === 'sl');
  const tp2InSL  = slTrades.filter(t => t.tp2Hit).length;
  const effWins  = closed.filter(t => t.hit === 'TP' || t.exitReason === 'tp').length + tp2InSL;
  return { total: closed.length, tp1Count, tp2Count, slTotal: slTrades.length, tp2InSL, effWins };
}

function buildTp2Block(tp2) {
  if (!tp2 || tp2.total === 0) return '';
  const tp2Rate = (tp2.tp2Count / tp2.total * 100).toFixed(1);
  const effRate = (tp2.effWins  / tp2.total * 100).toFixed(1);
  let block = `${DIVIDER}\n`;
  block += `🥈 <b>Thống kê TP2</b> (mức lãi +10% vốn)\n`;
  block += `Đã chạm TP2: <b>${tp2.tp2Count}/${tp2.total}</b> (<b>${tp2Rate}%</b>)\n`;
  if (tp2.slTotal > 0) {
    block += `Trong ${tp2.slTotal} lệnh SL: <b>${tp2.tp2InSL}</b> đã qua TP2 trước khi dính SL\n`;
  }
  if (tp2.tp2InSL > 0) {
    block += `→ Nếu chốt tại TP2: win rate ước tính <b>${effRate}%</b> (<b>${tp2.effWins}/${tp2.total}</b>)\n`;
  }
  return block;
}

function buildStatsMessage() {
  const winRate = stats.totalTrades > 0
    ? (stats.wins / stats.totalTrades * 100).toFixed(1)
    : '0.0';
  const avgPnl = stats.totalTrades > 0
    ? (stats.totalPnlPct / stats.totalTrades).toFixed(2)
    : '0.00';
  const totalPnlStr = stats.totalPnlPct >= 0
    ? `+${stats.totalPnlPct.toFixed(2)}`
    : stats.totalPnlPct.toFixed(2);
  const avgPnlStr = parseFloat(avgPnl) >= 0 ? `+${avgPnl}` : avgPnl;

  const streakEmoji = stats.streakType === 'win' ? '🔥' : '❄️';
  const streakText  = stats.currentStreak > 0
    ? `${streakEmoji} ${stats.currentStreak} ${stats.streakType === 'win' ? 'thắng' : 'thua'} liên tiếp`
    : 'Chưa có';

  let msg = `📊 <b>THỐNG KÊ LỆNH AI</b>\n`;
  msg += `${DIVIDER}\n`;
  msg += `📋 Tổng: <b>${stats.totalTrades}</b>  |  ✅ Thắng: <b>${stats.wins}</b>  ❌ Thua: <b>${stats.losses}</b>\n`;
  msg += `\n🎯 Win rate: <b>${winRate}%</b>\n`;
  msg += `${makeWinRateBar(stats.wins, stats.totalTrades)}\n`;
  msg += `\n💰 PnL tích lũy:  <b>${totalPnlStr}%</b>\n`;
  msg += `📈 Trung bình/lệnh:  <b>${avgPnlStr}%</b>\n`;

  if (stats.bestTrade) {
    msg += `\n🏆 Tốt nhất:  <b>${stats.bestTrade.symbol} ${stats.bestTrade.direction}</b>  <b>+${stats.bestTrade.pnlPct.toFixed(2)}%</b>\n`;
  }
  if (stats.worstTrade) {
    msg += `💥 Xấu nhất:  <b>${stats.worstTrade.symbol} ${stats.worstTrade.direction}</b>  <b>${stats.worstTrade.pnlPct.toFixed(2)}%</b>\n`;
  }

  msg += `\n${streakEmoji} Chuỗi hiện tại:  <b>${streakText}</b>\n`;

  const tp2 = calcTp2Stats(loadHistory());
  msg += buildTp2Block(tp2);

  if (!tp2) msg += `${DIVIDER}\n`;
  if (stats.updatedAt) {
    const updated = new Date(stats.updatedAt).toLocaleString('vi-VN', { timeZone: TIMEZONE });
    msg += `<i>🕐 Cập nhật: ${updated}</i>`;
  } else {
    msg += `<i>Chưa có lệnh nào hoàn thành</i>`;
  }

  return msg;
}

// Tính icon cho history record (hỗ trợ cả old format và new format)
function _tradeIcon(t) {
  const er = t.exitReason, res = t.result;
  if (er === 'tp')           return '✅';
  if (er === 'sl')           return '❌';
  if (er === 'reversed')     return res === 'win' ? '🔁✅' : res === 'loss' ? '🔁❌' : '🔁';
  if (er === 'manual_close') return res === 'win' ? '✋✅' : res === 'loss' ? '✋❌' : '✋❓';
  // fallback cho old records không có exitReason
  if (t.hit === 'TP')           return '✅';
  if (t.hit === 'REV_WIN')      return '🔁✅';
  if (t.hit === 'REV_LOSS')     return '🔁❌';
  if (t.hit === 'reversed')     return '🔁';
  if (t.hit === 'manual_close') return '✋❓';
  return '❌';
}

// Báo cáo đầy đủ: tổng hợp + lịch sử từng lệnh (dùng cho --report và /stats chi tiết)
function buildDetailedReport() {
  const winRate = stats.totalTrades > 0
    ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
  const totalPnlStr = stats.totalPnlPct >= 0
    ? `+${stats.totalPnlPct.toFixed(2)}` : stats.totalPnlPct.toFixed(2);

  let msg = `📊 <b>BÁO CÁO LỆNH AI</b>\n${DIVIDER}\n`;
  if (stats.totalTrades > 0) {
    const avgPnl = (stats.totalPnlPct / stats.totalTrades).toFixed(2);
    const avgStr = parseFloat(avgPnl) >= 0 ? `+${avgPnl}` : avgPnl;
    msg += `📋 Tổng: <b>${stats.totalTrades}</b>  |  ✅ <b>${stats.wins}</b> thắng  |  ❌ <b>${stats.losses}</b> thua\n`;
    msg += `🎯 Win rate: <b>${winRate}%</b>\n`;
    msg += `${makeWinRateBar(stats.wins, stats.totalTrades)}\n`;
    msg += `💰 PnL: <b>${totalPnlStr}%</b>  (TB: <b>${avgStr}%</b>/lệnh)\n`;
  } else {
    msg += `<i>Chưa có lệnh nào hoàn thành</i>\n`;
  }

  const history = loadHistory();
  if (history.length === 0) {
    msg += `${DIVIDER}\n<i>Lịch sử trống — lệnh sẽ được ghi khi chạm TP/SL</i>`;
    return msg;
  }

  const tp2 = calcTp2Stats(history);
  msg += buildTp2Block(tp2);

  const revTrades = history.filter(t =>
    t.hit === 'REV_WIN' || t.hit === 'REV_LOSS' || t.exitReason === 'reversed'
  );
  if (revTrades.length > 0) {
    const revWins = revTrades.filter(t =>
      t.hit === 'REV_WIN' || (t.exitReason === 'reversed' && t.result === 'win')
    ).length;
    const revPnl  = revTrades.reduce((s, t) => s + (t.pnlPct || 0), 0);
    const revPnlStr = revPnl >= 0 ? `+${revPnl.toFixed(2)}` : revPnl.toFixed(2);
    msg += `${DIVIDER}\n`;
    msg += `🔁 <b>Đảo chiều:</b> ${revTrades.length} lệnh  |  🔁✅ ${revWins} lãi / 🔁❌ ${revTrades.length - revWins} lỗ  |  PnL: <b>${revPnlStr}%</b>\n`;
    msg += `<i>(Đã tính chung vào win rate và PnL tổng)</i>\n`;
  }

  const recent = history.slice(-15).reverse(); // tối đa 15 lệnh gần nhất, mới nhất trước
  msg += `${DIVIDER}\n`;
  msg += `📅 <b>${Math.min(history.length, 15)} LỆNH GẦN NHẤT</b> (tổng ${history.length})\n`;

  for (const t of recent) {
    const icon     = _tradeIcon(t);
    const tp2Badge = ((t.hit === 'SL' || t.exitReason === 'sl') && t.tp2Hit) ? ' 🥈' : '';
    const dirIcon  = t.direction === 'LONG' ? '🟢' : '🔴';
    const lev      = t.leverage ? ` ⚡x${t.leverage}` : '';
    const pnlStr   = t.pnlPct != null
      ? (t.pnlPct >= 0 ? ` <b>+${t.pnlPct.toFixed(2)}%</b>` : ` <b>${t.pnlPct.toFixed(2)}%</b>`)
      : (t.exitReason === 'manual_close' || t.hit === 'manual_close')
        ? ' <i>PnL chưa xác định</i>'
        : ' <i>đảo chiều</i>';
    const feeImpact = t.leverage ? t.leverage * TAKER_FEE * 2 * 100 : 0;
    const actualPnl = (t.pnlPct != null && t.leverage)
      ? (() => { const net = t.pnlPct * t.leverage - feeImpact; return ` (thực: ${net >= 0 ? '+' : ''}${net.toFixed(1)}%)`; })()
      : '';
    const recStr = new Date(t.recommendedAt).toLocaleString('vi-VN', {
      timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const closeStr = new Date(t.closedAt).toLocaleString('vi-VN', {
      timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const dur = fmtDuration(t.durationMs);
    msg += `${icon} <b>${t.symbol}</b> ${dirIcon} ${t.direction}${lev}${tp2Badge} — ${pnlStr}${actualPnl}\n`;
    msg += `   ⌛ ${dur}  |  <i>${recStr} → ${closeStr}</i>\n`;
  }

  msg += `${DIVIDER}\n`;
  if (stats.updatedAt) {
    const updated = new Date(stats.updatedAt).toLocaleString('vi-VN', { timeZone: TIMEZONE });
    msg += `<i>Cập nhật: ${updated}</i>`;
  }

  return msg;
}

/**
 * Tóm tắt hiệu suất gần đây để inject vào AI prompt.
 * Trả về string plain text — AI dùng để tự calibrate mức độ thận trọng.
 */
function getRecentHistoryText(n = 5) {
  const history = loadHistory();
  if (!history.length && !stats.totalTrades) return '';

  const lines = ['\n[HIỆU SUẤT LỆNH GẦN ĐÂY]'];

  if (stats.totalTrades > 0) {
    const wr = (stats.wins / stats.totalTrades * 100).toFixed(1);
    lines.push(`Tổng: ${stats.wins}W/${stats.losses}L | Win rate: ${wr}% | PnL tích lũy: ${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(2)}%`);
    if (stats.currentStreak >= 2) {
      const emoji = stats.streakType === 'win' ? '✅' : '⚠️';
      lines.push(`${emoji} Đang ${stats.streakType === 'win' ? 'thắng' : 'thua'} ${stats.currentStreak} lệnh liên tiếp`);
    }
  }

  const recent = history.slice(-n).reverse();
  for (const t of recent) {
    const er = t.exitReason, res = t.result;
    let label;
    if (er === 'tp')           label = 'TP✅';
    else if (er === 'sl')      label = 'SL❌';
    else if (er === 'reversed') label = res === 'win' ? 'ĐẢO✅' : res === 'loss' ? 'ĐẢO❌' : 'ĐẢO🔁';
    else if (er === 'manual_close') label = res === 'win' ? 'TC✅' : res === 'loss' ? 'TC❌' : 'TC❓';
    // fallback for old records
    else if (t.hit === 'TP')       label = 'TP✅';
    else if (t.hit === 'SL')       label = 'SL❌';
    else if (t.hit === 'REV_WIN')  label = 'ĐẢO✅';
    else if (t.hit === 'REV_LOSS') label = 'ĐẢO❌';
    else if (t.hit === 'manual_close') label = 'TC❓';
    else label = 'ĐẢO🔁';

    const pnl = t.pnlPct != null ? ` (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)` : '';
    const dur = t.durationMs ? ` ${Math.round(t.durationMs / 3600000)}h` : '';
    lines.push(`${label} ${t.symbol} ${t.direction}${pnl}${dur}`);
  }

  // Cảnh báo loss streak → AI tự thắt chặt ngưỡng vào lệnh
  if (stats.streakType === 'loss' && stats.currentStreak >= 3) {
    lines.push(`→ THẮT CHẶT: đang thua ${stats.currentStreak} lệnh liên tiếp, chỉ vào lệnh khi confluence ≥ 9 điểm`);
  }

  return lines.join('\n');
}

module.exports = { recordTradeResult, recordReversed, updateReversedResult, getStats, buildStatsMessage, buildDetailedReport, getRecentHistoryText };
