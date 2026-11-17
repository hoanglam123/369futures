'use strict';

/**
 * Telegram 2-Way Interactive Command Bot — Phase 5
 *
 * Hỗ trợ các lệnh tương tác hai chiều từ điện thoại:
 *   /status    — Trạng thái bot, RAM, WebSocket, Safety Brake, Cooldown
 *   /trades    — Danh sách các vị thế đang chạy & PnL thời gian thực
 *   /scan369   — Radar top các coin đang áp sát mốc lưới PP369
 *   /forcesync — Mở phanh an toàn (Override Safety Brake) & Đồng bộ Binance
 *   /report    — Thống kê tổng quan PnL, Winrate, Profit Factor
 *   /cooldown  — Danh sách các coin đang bị phạt dừng giao dịch
 *   /help      — Hướng dẫn sử dụng các lệnh
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { log } = require('../pp369/_logger');
const { sendTelegram } = require('../pp369/telegram');
const { overrideSafetyBrake, isSafetyBrakeActive, getLastBrakeInfo } = require('../trader/safetyBrake');
const { isStreamConnected } = require('../trader/binanceStream');

const DATA_DIR = path.join(process.cwd(), 'data');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const DIVIDER = '━━━━━━━━━━━━━━━━';
const POLL_INTERVAL_MS = 12_000; // 12 giây

let _offset = 0;
let _pollTimer = null;
let _isPolling = false;
let _activeTradesProvider = null;
let _radarCoinsProvider = null;

function setTradeProviders({ getActiveTrades, getNearbyCoins }) {
  if (getActiveTrades) _activeTradesProvider = getActiveTrades;
  if (getNearbyCoins) _radarCoinsProvider = getNearbyCoins;
}

function getTelegramApiUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return `https://api.telegram.org/bot${token}`;
}

function readJson(file, fallback = {}) {
  try {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file, limit = 100) {
  try {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return [];
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
    const result = [];
    const start = Math.max(0, lines.length - limit);
    for (let i = lines.length - 1; i >= start; i--) {
      try { result.push(JSON.parse(lines[i])); } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStatus() {
  const mem = process.memoryUsage();
  const uptimeMin = Math.round(process.uptime() / 60);
  const now = new Date().toLocaleString('vi-VN', { timeZone: TIMEZONE });
  const activeTrades = readJson('active_trades.json', {});
  const activeCount = Object.values(activeTrades).filter(t => t && !t.isClosed).length;
  const isWsConnected = isStreamConnected();
  const isBrakeTripped = isSafetyBrakeActive();
  const brakeInfo = getLastBrakeInfo();

  const cooldowns = readJson('sl_cooldown.json', {});
  const nowMs = Date.now();
  const cdCount = Object.values(cooldowns).filter(entry => {
    const exp = typeof entry === 'object' ? entry.expiry : entry;
    return exp > nowMs;
  }).length;

  let msg = `🤖 <b>TRẠNG THÁI BOT PP369 FUTURES</b>\n${DIVIDER}\n`;
  msg += `🟢 <b>Hệ thống:</b> ONLINE (Uptime: ${uptimeMin} phút)\n`;
  msg += `🕐 <b>Thời gian:</b> <i>${now}</i>\n`;
  msg += `⚡ <b>Vị thế đang chạy:</b> <b>${activeCount}</b> lệnh\n`;
  msg += `📡 <b>WebSocket Stream:</b> ${isWsConnected ? '✅ KẾT NỐI' : '⚠️ MẤT KẾT NỐI'}\n`;
  msg += `🛡️ <b>Safety Brake:</b> ${isBrakeTripped ? '🚨 ĐANG KÍCH HOẠT' : '✅ AN TOÀN'}\n`;
  if (isBrakeTripped && brakeInfo.reason) {
    msg += `   <i>Lý do: ${brakeInfo.reason}</i>\n`;
  }
  msg += `⏸️ <b>Coin đang Cooldown:</b> <b>${cdCount}</b> coin\n`;
  msg += `💾 <b>RAM sử dụng:</b> RSS ${Math.round(mem.rss / 1024 / 1024)}MB | Heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB\n`;
  msg += `${DIVIDER}\n`;
  msg += `<i>Gõ <code>/trades</code> để xem chi tiết vị thế</i>`;

  await sendTelegram(msg);
}

async function handleTrades() {
  const activeTrades = readJson('active_trades.json', {});
  const openEntries = Object.entries(activeTrades).filter(([sym, meta]) => meta && !meta.isClosed);

  if (!openEntries.length) {
    await sendTelegram(`📋 <b>Không có vị thế nào đang mở</b>\n<i>Hệ thống đang quét tìm mốc lưới PP369 tiếp theo...</i>`);
    return;
  }

  let msg = `⚡ <b>DANH SÁCH VỊ THẾ ĐANG CHẠY (${openEntries.length})</b>\n${DIVIDER}\n`;

  for (const [sym, meta] of openEntries) {
    const isLong = meta.side === 'BUY' || meta.side === 'LONG';
    const sideIcon = isLong ? '🟢 LONG' : '🔴 SHORT';
    const entry = meta.entryPrice || 0;
    const mark = meta.markPrice || entry;
    const lev = meta.leverage || 10;
    const margin = meta.margin || 20;

    const roi = isLong
      ? ((mark - entry) / entry) * lev * 100
      : ((entry - mark) / entry) * lev * 100;
    const pnlUsd = (roi / 100) * margin;
    const roiSign = roi >= 0 ? '+' : '';
    const roiIcon = roi >= 0 ? '📈' : '📉';

    msg += `<b>#${sym}</b> [${sideIcon} ⚡${lev}x]\n`;
    msg += `• Vào: <code>$${entry}</code> ➔ Hiện tại: <code>$${mark}</code>\n`;
    msg += `• ${roiIcon} PnL: <b>${roiSign}${roi.toFixed(2)}%</b> (~${roiSign}$${pnlUsd.toFixed(2)})\n`;
    msg += `• 🎯 TP: <code>$${meta.tierTpPrice || meta.targetPrice || 'N/A'}</code> | 🛑 SL: <code>$${meta.currentSlPrice || meta.tierSlPrice || 'N/A'}</code>\n`;
    if (meta.isBreakeven) {
      msg += `• 🛡️ <i>Đã dời Breakeven 35% (Risk-Free)</i>\n`;
    }
    msg += `\n`;
  }

  msg += `${DIVIDER}`;
  await sendTelegram(msg);
}

async function handleScan369() {
  const levelCache = readJson('step_sizes.json', {});
  const signals = readJsonl('369_signals.jsonl', 5);

  let msg = `🎯 <b>RADAR LƯỚI HÌNH HỌC PP369</b>\n${DIVIDER}\n`;
  msg += `<b>Tín hiệu nảy mốc gần nhất:</b>\n`;

  if (!signals.length) {
    msg += `<i>Chưa có tín hiệu ghi nhận trong phiên hiện tại.</i>\n`;
  } else {
    for (const s of signals.slice(0, 4)) {
      const isLong = s.signal === 'LONG';
      const icon = isLong ? '🟢' : '🔴';
      msg += `${icon} <b>${s.symbol}</b>: ${s.signal} @ $${s.entryPrice || s.targetLevel || 'N/A'}\n`;
      msg += `   <i>Thời gian: ${s.timestamp ? new Date(s.timestamp).toLocaleTimeString('vi-VN', { timeZone: TIMEZONE }) : 'vừa xong'} | Điểm: +${s.score || 0}đ</i>\n`;
    }
  }

  msg += `\n${DIVIDER}\n`;
  msg += `<i>Mốc lưới được tính từ nến H1 đầu năm 01/01/2026 00:00 UTC.</i>`;
  await sendTelegram(msg);
}

async function handleForceSync() {
  overrideSafetyBrake();
  let msg = `⚡ <b>LỆNH FORCESYNC ĐÃ ĐƯỢC TIẾP NHẬN</b>\n${DIVIDER}\n`;
  msg += `🔓 Đã mở khóa phanh Safety Brake (Override 1 lần).\n`;
  msg += `🔄 Hệ thống sẽ tiến hành đồng bộ chéo trực tiếp với Binance REST API ở chu kỳ quét tiếp theo.\n`;
  msg += `<i>Vui lòng gõ <code>/status</code> sau 15 giây để kiểm tra lại trạng thái.</i>`;
  await sendTelegram(msg);
}

async function handleReport() {
  const history = readJsonl('shadow_trades_history.jsonl', 100);
  const total = history.length;
  if (!total) {
    await sendTelegram(`📊 <b>Chưa có đủ dữ liệu lịch sử để tổng kết báo cáo</b>`);
    return;
  }

  const wins = history.filter(t => t.pnlPct > 0).length;
  const losses = history.filter(t => t.pnlPct <= 0).length;
  const winRate = ((wins / total) * 100).toFixed(1);
  const totalPnl = history.reduce((sum, t) => sum + (t.pnlPct || 0), 0).toFixed(2);
  const winPnl = history.filter(t => t.pnlPct > 0).reduce((sum, t) => sum + t.pnlPct, 0);
  const lossPnl = Math.abs(history.filter(t => t.pnlPct < 0).reduce((sum, t) => sum + t.pnlPct, 0));
  const pf = lossPnl > 0 ? (winPnl / lossPnl).toFixed(2) : (winPnl > 0 ? '99.9' : '0.0');

  let msg = `📊 <b>BÁO CÁO HIỆU SUẤT GIAO DỊCH PP369</b>\n${DIVIDER}\n`;
  msg += `🎯 <b>Tổng số lệnh:</b> <b>${total}</b> lệnh\n`;
  msg += `✅ <b>Thắng:</b> ${wins} | ❌ <b>Thua:</b> ${losses}\n`;
  msg += `🏆 <b>Tỷ lệ thắng (Win Rate):</b> <b>${winRate}%</b>\n`;
  msg += `💰 <b>Tổng ROI tích lũy:</b> <b>${totalPnl >= 0 ? '+' : ''}${totalPnl}%</b>\n`;
  msg += `📈 <b>Profit Factor:</b> <b>${pf}</b>\n`;
  msg += `${DIVIDER}`;

  await sendTelegram(msg);
}

async function handleCooldown() {
  const cooldowns = readJson('sl_cooldown.json', {});
  const now = Date.now();
  const activeList = [];

  for (const [sym, entry] of Object.entries(cooldowns)) {
    const exp = typeof entry === 'object' ? entry.expiry : entry;
    const reason = typeof entry === 'object' ? entry.reason : 'SL';
    if (exp > now) {
      const remainingH = ((exp - now) / 3600000).toFixed(1);
      activeList.push({ sym, reason, remainingH });
    }
  }

  if (!activeList.length) {
    await sendTelegram(`✅ <b>Không có coin nào đang bị Cooldown</b>\n<i>Tất cả các coin đủ điều kiện đều sẵn sàng giao dịch.</i>`);
    return;
  }

  let msg = `⏸️ <b>DANH SÁCH COIN ĐANG COOLDOWN (${activeList.length})</b>\n${DIVIDER}\n`;
  for (const item of activeList) {
    msg += `• <b>#${item.sym}</b>: Khóa ${item.remainingH}h (Lý do: <code>${item.reason}</code>)\n`;
  }
  msg += `${DIVIDER}\n`;
  msg += `<i>Sau khi hết thời gian phạt, bot sẽ tự động mở lại giao dịch.</i>`;

  await sendTelegram(msg);
}

async function handleHelp() {
  let msg = `📖 <b>BỘ LỆNH ĐIỀU KHIỂN TELEGRAM PP369</b>\n${DIVIDER}\n`;
  msg += `<code>/status</code>   — Kiểm tra tình trạng bot, RAM, WebSocket, Safety Brake\n`;
  msg += `<code>/trades</code>   — Danh sách các vị thế đang chạy & PnL thời gian thực\n`;
  msg += `<code>/scan369</code>  — Xem các tín hiệu áp sát lưới PP369\n`;
  msg += `<code>/forcesync</code>— Mở khóa phanh Safety Brake & đồng bộ lại với sàn Binance\n`;
  msg += `<code>/report</code>   — Xem tổng kết PnL, Winrate, Profit Factor\n`;
  msg += `<code>/cooldown</code> — Danh sách các coin đang bị tạm dừng sau khi chạm SL\n`;
  msg += `<code>/help</code>     — Xem bảng hướng dẫn này\n`;
  msg += `${DIVIDER}`;

  await sendTelegram(msg);
}

// ─── Dispatcher & Polling ─────────────────────────────────────────────────────

const COMMANDS = {
  '/status': handleStatus,
  '/trades': handleTrades,
  '/positions': handleTrades,
  '/scan369': handleScan369,
  '/radar': handleScan369,
  '/forcesync': handleForceSync,
  '/report': handleReport,
  '/cooldown': handleCooldown,
  '/help': handleHelp,
};

async function executeCommand(cmdText) {
  const cleanCmd = (cmdText || '').trim().split(/\s+/)[0].toLowerCase();
  const handler = COMMANDS[cleanCmd];
  if (handler) {
    await handler();
    return true;
  }
  return false;
}

async function fetchTelegramUpdates() {
  const url = getTelegramApiUrl();
  if (!url) return [];
  try {
    const { data } = await axios.get(`${url}/getUpdates`, {
      params: { offset: _offset, timeout: 0, allowed_updates: ['message'] },
      timeout: 8000,
    });
    return data?.ok ? data.result : [];
  } catch {
    return [];
  }
}

async function pollOnce() {
  const updates = await fetchTelegramUpdates();
  for (const update of updates) {
    _offset = update.update_id + 1;
    const text = update.message?.text?.trim();
    if (!text) continue;

    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    const handler = COMMANDS[cmd];
    if (handler) {
      log.system(`[TelegramCommands] Tiếp nhận lệnh: ${cmd}`);
      try {
        await handler();
      } catch (err) {
        log.error(`[TelegramCommands] Lỗi thực thi lệnh ${cmd}: ${err.message}`);
      }
    }
  }
}

async function startTelegramCommands() {
  const url = getTelegramApiUrl();
  if (!url) {
    log.system('[TelegramCommands] Không có TELEGRAM_BOT_TOKEN — Bỏ qua tính năng điều khiển 2 chiều');
    return false;
  }

  // Khởi tạo offset ban đầu để bỏ qua tin nhắn cũ trước khi bot khởi động
  try {
    const { data } = await axios.get(`${url}/getUpdates`, {
      params: { offset: -1, timeout: 0, allowed_updates: ['message'] },
      timeout: 8000,
    });
    if (data?.ok && data.result.length > 0) {
      _offset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch {}

  _isPolling = true;
  log.system('[TelegramCommands] 🚀 Bộ lệnh Telegram 2 chiều đã khởi động thành công (Polling 12s)');

  const loop = async () => {
    if (!_isPolling) return;
    await pollOnce();
    _pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();

  return true;
}

function stopTelegramCommands() {
  _isPolling = false;
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  log.system('[TelegramCommands] Đã dừng bộ lệnh Telegram 2 chiều');
}

module.exports = {
  startTelegramCommands,
  stopTelegramCommands,
  executeCommand,
  setTradeProviders,
  handleStatus,
  handleTrades,
  handleScan369,
  handleForceSync,
  handleReport,
  handleCooldown,
  handleHelp,
  COMMANDS,
};
