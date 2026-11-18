'use strict';

/**
 * Xử lý lệnh Telegram từ người dùng.
 * Poll getUpdates mỗi 15 giây để nhận lệnh mới.
 *
 * Lệnh hỗ trợ:
 *   /status   — Trạng thái bot, thời gian bản tin tiếp theo
 *   /trades   — Danh sách lệnh đang theo dõi
 *   /stats    — Thống kê thắng/thua tích lũy
 *   /runnow   — Chạy phân tích thị trường ngay lập tức
 *   /report   — Kiểm tra TP/SL + gửi báo cáo lịch sử lệnh
 *   /backtest — Phân tích klines Binance cho lệnh active (khi bot offline)
 *   /funding  — Xem funding rate thị trường realtime
 *   /sync     — Đồng bộ vị thế thủ công từ Binance (phát hiện position bot bị miss)
 *   /help     — Danh sách lệnh
 */

const axios = require('axios');
const { sendMessage, sendMessages } = require('./telegram');
const { getActiveTrades, checkActiveTrades, sendActiveTradesSummary, runBacktest, syncManualPositions, forceSyncBrakeOverride } = require('./tradeMonitor');
const { buildDetailedReport } = require('./tradeStats');
const { getFundingRates, getNextFundingInfo } = require('../collectors/fundingRates');
const { buildFundingSection } = require('../formatters/message');
const { buildFundingStatsMessage } = require('./fundingTracker');
const { isJobRunning } = require('../job');
const { log } = require('./logger');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const DIVIDER  = '━━━━━━━━━━━━━━━━';
const POLL_INTERVAL_MS = 15000; // 15 giây

let offset    = 0;
let runJobFn  = null;
let pollTimer = null;

function setRunJob(fn) {
  runJobFn = fn;
}

function getTelegramApiUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Thiếu TELEGRAM_BOT_TOKEN');
  return `https://api.telegram.org/bot${token}`;
}

// Lấy offset hiện tại để bỏ qua các tin nhắn cũ trước khi bot khởi động
async function initOffset() {
  try {
    const { data } = await axios.get(`${getTelegramApiUrl()}/getUpdates`, {
      params: { offset: -1, timeout: 0, allowed_updates: ['message', 'channel_post'] },
      timeout: 10000,
    });
    if (data.ok && data.result.length > 0) {
      offset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch {
    // Không làm gì, offset mặc định = 0
  }
}

async function fetchUpdates() {
  try {
    const { data } = await axios.get(`${getTelegramApiUrl()}/getUpdates`, {
      params: { offset, timeout: 0, allowed_updates: ['message', 'channel_post'] },
      timeout: 10000,
    });
    return data.ok ? data.result : [];
  } catch {
    return [];
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleStatus(args, chatId) {
  const active = getActiveTrades();
  const now    = new Date().toLocaleString('vi-VN', { timeZone: TIMEZONE });

  // Tính giờ bản tin tiếp theo (0h, 4h, 8h, 12h, 16h, 20h)
  const vnHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false })
      .formatToParts(new Date())
      .find(p => p.type === 'hour').value,
    10
  ) % 24;
  const schedule = [0, 4, 8, 12, 16, 20];
  const nextH   = schedule.find(h => h > vnHour) ?? schedule[0];
  const nextLabel = `${String(nextH).padStart(2, '0')}:00`;

  let msg = `🤖 <b>TRẠNG THÁI BOT</b>\n${DIVIDER}\n`;
  msg += `✅ Bot đang chạy bình thường\n`;
  msg += `🕐 Giờ hiện tại: <i>${now}</i>\n`;
  msg += `⏰ Bản tin tiếp theo: <b>${nextLabel} (giờ VN)</b>\n`;
  msg += `📋 Lệnh đang theo dõi: <b>${active.length}</b>\n`;
  msg += `${DIVIDER}\n`;
  msg += `<i>Lịch: 0h • 4h • 8h • 12h • 16h • 20h</i>`;

  await sendMessage(msg, {}, chatId);
}

async function handleTrades(args, chatId) {
  const active = getActiveTrades();
  if (!active.length) {
    await sendMessage(
      `📋 <b>Không có lệnh nào đang theo dõi</b>\n` +
      `<i>AI sẽ tìm lệnh mới trong bản tin tiếp theo</i>`,
      {},
      chatId
    );
    return;
  }
  await sendActiveTradesSummary(chatId);
}

async function handleStats(args, chatId) {
  await sendMessage(buildDetailedReport(), {}, chatId);
}

async function handleRunNow(args, chatId) {
  if (!runJobFn) {
    await sendMessage('❌ Không thể chạy job ngay lúc này', {}, chatId);
    return;
  }
  if (isJobRunning()) {
    await sendMessage('⏳ <b>Job đang chạy rồi</b> — vui lòng chờ bản tin hiện tại xong', {}, chatId);
    return;
  }
  await sendMessage(
    `🔄 <b>Đang chạy phân tích thị trường...</b>\n` +
    `<i>Bạn sẽ nhận bản tin trong vài phút</i>`,
    {},
    chatId
  );
  try {
    await runJobFn();
  } catch (e) {
    await sendMessage(`❌ Job lỗi: <code>${e.message.slice(0, 300)}</code>`, {}, chatId);
  }
}

async function handleReport(args, chatId) {
  const active = getActiveTrades();
  if (active.length > 0) {
    await sendMessage(`🔍 <b>Đang kiểm tra ${active.length} lệnh...</b>`, {}, chatId);
    await checkActiveTrades().catch(e => log.warn('Không thể kiểm tra giá', { error: e.message }));
  }
  const report = buildDetailedReport();
  await sendMessages([report], 1500, chatId);
  if (active.length > 0) {
    await sendActiveTradesSummary(chatId).catch(() => {});
  }
  await sendMessages([buildFundingStatsMessage()], 1500, chatId).catch(() => {});
}

async function handleFunding(args, chatId) {
  await sendMessage(`⏳ <b>Đang lấy funding rates...</b>`, {}, chatId);
  try {
    const funding = await getFundingRates();
    const section = buildFundingSection(funding);
    if (!section.trim()) {
      await sendMessage(`📊 <b>Funding Rate</b>\n<i>Không có dữ liệu funding đáng chú ý lúc này</i>`, {}, chatId);
      return;
    }
    await sendMessages([section], 1500, chatId);
  } catch (e) {
    await sendMessage(`❌ Lỗi lấy funding rate: <code>${e.message.slice(0, 200)}</code>`, {}, chatId);
  }
}

async function handleBacktest(args, chatId) {
  const active = getActiveTrades();
  if (!active.length) {
    await sendMessage(`📋 <b>Không có lệnh active</b>\n<i>Backtest không có gì để làm</i>`, {}, chatId);
    return;
  }
  await sendMessage(
    `⏳ <b>Đang chạy backtest ${active.length} lệnh...</b>\n` +
    `<i>Tải klines Binance, vui lòng chờ vài giây</i>`,
    {},
    chatId
  );
  try {
    const { checked, closed } = await runBacktest();
    const report = buildDetailedReport();
    await sendMessages([report], 1500, chatId);
    log.system(`Backtest (Telegram): ${closed}/${checked} lệnh tìm thấy kết quả`);
  } catch (e) {
    await sendMessage(`❌ Backtest lỗi: <code>${e.message.slice(0, 300)}</code>`, {}, chatId);
  }
}

async function handleHelp(args, chatId) {
  let msg = `🤖 <b>Crypto Bot — Danh sách lệnh</b>\n${DIVIDER}\n`;
  msg += `/status   — Trạng thái bot &amp; giờ bản tin tiếp theo\n`;
  msg += `/trades   — Danh sách lệnh đang theo dõi\n`;
  msg += `/stats    — Thống kê thắng/thua tích lũy\n`;
  msg += `/runnow   — Chạy phân tích thị trường ngay\n`;
  msg += `/report   — Kiểm tra TP/SL + báo cáo lịch sử lệnh\n`;
  msg += `/backtest — Phân tích klines khi bot offline\n`;
  msg += `/funding  — Funding rate thị trường realtime\n`;
  msg += `/sync     — Đồng bộ vị thế thủ công từ Binance\n`;
  msg += `/forcesync — Tắt Safety Brake đồng bộ cưỡng bức\n`;
  msg += `/help     — Danh sách lệnh này`;
  await sendMessage(msg, {}, chatId);
}

async function handleSync(args, chatId) {
  await sendMessage(`🔄 <b>Đang đồng bộ vị thế từ Binance...</b>`, {}, chatId);
  try {
    await syncManualPositions();
    const active = getActiveTrades();
    await sendMessage(
      `✅ <b>Đồng bộ hoàn tất</b>\n` +
      `Hiện đang theo dõi <b>${active.length}</b> lệnh.`,
      {},
      chatId
    );
  } catch (e) {
    await sendMessage(`❌ Sync lỗi: <code>${e.message.slice(0, 300)}</code>`, {}, chatId);
  }
}

async function handleForceSync(args, chatId) {
  forceSyncBrakeOverride();
  await sendMessage(`⚠️ <b>Force sync — safety brake tắt 1 lần</b>\nĐang đồng bộ...`, {}, chatId);
  try {
    await syncManualPositions('forcesync');
    const active = getActiveTrades();
    await sendMessage(`✅ <b>Force sync hoàn tất</b>\nĐang theo dõi <b>${active.length}</b> lệnh.`, {}, chatId);
  } catch (e) {
    await sendMessage(`❌ Force sync lỗi: <code>${e.message.slice(0, 300)}</code>`, {}, chatId);
  }
}

const COMMANDS = {
  '/status':    handleStatus,
  '/trades':    handleTrades,
  '/stats':     handleStats,
  '/runnow':    handleRunNow,
  '/report':    handleReport,
  '/backtest':  handleBacktest,
  '/funding':   handleFunding,
  '/sync':      handleSync,
  '/forcesync': handleForceSync,
  '/help':      handleHelp,
};

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollOnce() {
  const updates = await fetchUpdates();
  for (const update of updates) {
    offset = update.update_id + 1;

    const msgObj = update.message ?? update.channel_post;
    const text = msgObj?.text?.trim();
    if (!text) continue;
    const senderChatId = msgObj?.chat?.id;

    // Hỗ trợ /command@botname và /command ARGS
    const parts = text.trim().split(/\s+/);
    const cmd  = parts[0].split('@')[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    const handler = COMMANDS[cmd];
    if (!handler) continue;

    log.telegram(`Lệnh nhận được: ${cmd}${args ? ' ' + args : ''} (chatId=${senderChatId})`);
    try {
      await handler(args, senderChatId);
    } catch (e) {
      log.error(`Command ${cmd} lỗi`, { error: e.message });
      try {
        await sendMessage(`❌ Lỗi xử lý lệnh: <code>${e.message.slice(0, 200)}</code>`, {}, senderChatId);
      } catch {}
    }
  }
}

async function startPolling() {
  await initOffset(); // bỏ qua tin cũ trước khi bot khởi động
  log.telegram('Command polling đã bắt đầu (mỗi 15 giây)');

  const loop = async () => {
    await pollOnce();
    pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
}

module.exports = { startPolling, stopPolling, setRunJob };
