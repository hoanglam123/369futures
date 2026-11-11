'use strict';

/**
 * PP369 Daily Performance Reporter
 * Tổng kết kết quả giao dịch (TP, SL, BE, PnL) sau mỗi 24h và gửi báo cáo về Telegram.
 * Chạy tự động vào 07:00 AM (giờ VN - UTC+7), đồng bộ với mốc nến ngày và nến H1 tháng.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');
const { sendTelegram } = require('./telegram');
const { getMarkPrice } = require('./stream');

const SHADOW_HISTORY_FILE = path.join(process.cwd(), 'data', 'shadow_trades_history.jsonl');
const DATASET_FILE = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
const SHADOW_POSITIONS_FILE = path.join(process.cwd(), 'data', 'shadow_positions.json');
const REAL_POSITIONS_FILE = path.join(process.cwd(), 'data', 'active_trades.json');
const STATE_FILE = path.join(process.cwd(), 'data', 'last_daily_report.json');

/**
 * Kiểm tra xem bản ghi có phải dữ liệu rác/lỗi hay không:
 * - Coin test giả lập: TEST*, TWIN_*
 * - Lỗi thoát BE tức thì trong <= 1 phút do xung đột râu nến trước khi cập nhật code
 */
function isBogusTrade(rec) {
  if (!rec) return true;
  const sym = String(rec.symbol || '').toUpperCase();
  if (/^(TEST|TWIN_)/i.test(sym)) return true;

  const dur = typeof rec.holdingDurationMinutes === 'number' ? rec.holdingDurationMinutes : 999;
  const outcome = (rec.outcome || rec.exitType || '').toUpperCase();
  const isBE = outcome === 'SAVED_BE' || outcome === 'BE' || rec.isSavedBE === true;

  // Lệnh cắn BE ngay trong <= 1 phút với entryPrice ~ exitPrice là lỗi râu nến lookback cũ
  if (isBE && dur <= 1.0) {
    const entry = parseFloat(rec.entryPrice || 0);
    const exit = parseFloat(rec.exitPrice || 0);
    if (!entry || !exit || Math.abs(entry - exit) / (entry || 1) < 0.005) {
      return true;
    }
  }

  return false;
}

/**
 * Đọc và tổng hợp các lệnh đã đóng trong khoảng thời gian `sinceMs` (mặc định 24h qua)
 */
function getDailyTradeStats(windowMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const startTime = now - windowMs;
  const seenTradeIds = new Set();
  const completedTrades = [];
  const cancelledTrades = [];

  // 1. Quét dữ liệu từ shadow_trades_history.jsonl
  if (fs.existsSync(SHADOW_HISTORY_FILE)) {
    try {
      const lines = fs.readFileSync(SHADOW_HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (isBogusTrade(rec)) continue; // Bỏ qua dữ liệu test và lệnh lỗi BE 0p

          const exitTime = rec.exitTimestamp || rec.time || 0;
          if (exitTime < startTime || exitTime > now) continue;

          const id = rec.shadowId || `${rec.symbol}_${exitTime}`;
          if (seenTradeIds.has(id)) continue;
          seenTradeIds.add(id);

          const isCancelled = rec.isCancelled === true || rec.outcome === 'BOUNCE_CANCEL' || rec.outcome === 'LIMIT_TIMEOUT';
          const isTP = rec.outcome === 'TP' || rec.outcome === 'MISSED_TP' || rec.isMissedTP === true || rec.isTradeWin === true;
          const isBE = rec.outcome === 'BE' || rec.outcome === 'SAVED_BE' || rec.isSavedBE === true;
          const isSL = rec.outcome === 'SL' || rec.outcome === 'SAVED_SL' || rec.outcome === 'TIMEOUT_LOSS' || rec.isSavedSL === true;

          let type = 'OTHER';
          if (isTP) type = 'TP';
          else if (isBE) type = 'BE';
          else if (isSL) type = 'SL';
          else if (isCancelled) type = 'CANCEL';

          const tradeItem = {
            id,
            isShadow: true,
            symbol: rec.symbol,
            signal: rec.signal || 'LONG',
            entryPrice: rec.entryPrice || 0,
            exitPrice: rec.exitPrice || 0,
            exitTimestamp: exitTime,
            holdingDurationMinutes: rec.holdingDurationMinutes || 0,
            type,
            pnlPercent: parseFloat(rec.pnlPercent) || 0,
            pnlUsd: parseFloat(rec.pnlUsd) || 0,
            score: rec.score || 0
          };

          if (isCancelled) {
            cancelledTrades.push(tradeItem);
          } else {
            completedTrades.push(tradeItem);
          }
        } catch (_) {}
      }
    } catch (e) {
      log.warn(`[DailyReporter] Lỗi đọc shadow_trades_history: ${e.message}`);
    }
  }

  // 2. Quét thêm từ ai_trade_dataset.jsonl (cho cả lệnh thật và lệnh shadow)
  if (fs.existsSync(DATASET_FILE)) {
    try {
      const lines = fs.readFileSync(DATASET_FILE, 'utf8').trim().split('\n').filter(Boolean);
      // Xây dựng bảng tra cứu ENTRY để lấy giá vào chuẩn xác cho các lệnh EXIT bị thiếu entryPrice
      const entryLookup = new Map();
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ENTRY') {
            if (rec.tradeId) entryLookup.set(rec.tradeId, rec);
            if (rec.orderId) entryLookup.set(String(rec.orderId), rec);
          }
        } catch (_) {}
      }

      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.type !== 'EXIT') continue;
          if (isBogusTrade(rec)) continue; // Bỏ qua dữ liệu test và lệnh lỗi BE 0p

          const exitTime = rec.exitTimestamp || 0;
          if (exitTime < startTime || exitTime > now) continue;

          const id = rec.tradeId || rec.orderId || `${rec.symbol}_${exitTime}`;
          if (seenTradeIds.has(id)) continue;
          seenTradeIds.add(id);

          const exitType = (rec.exitType || '').toUpperCase();
          const isCancelled = exitType.includes('CANCEL') || exitType.includes('TIMEOUT');
          const isTP = exitType === 'TP' || rec.isWin === true;
          const isBE = exitType === 'BE';
          const isSL = exitType === 'SL' || exitType === 'VIRTUAL_SL';

          let type = 'OTHER';
          if (isTP) type = 'TP';
          else if (isBE) type = 'BE';
          else if (isSL) type = 'SL';
          else if (isCancelled) type = 'CANCEL';

          const entryInfo = entryLookup.get(rec.tradeId) || entryLookup.get(String(rec.orderId)) || entryLookup.get(id);
          const entryPrice = rec.entryPrice || entryInfo?.entryPrice || 0;
          const signal = rec.signal || entryInfo?.signal || (rec.side === 'SELL' ? 'SHORT' : 'LONG');

          const tradeItem = {
            id,
            isShadow: rec.isShadow === true,
            symbol: rec.symbol,
            signal,
            entryPrice,
            exitPrice: rec.exitPrice || 0,
            exitTimestamp: exitTime,
            holdingDurationMinutes: rec.holdingDurationMinutes || 0,
            type,
            pnlPercent: parseFloat(rec.pnlPercent) || 0,
            pnlUsd: parseFloat(rec.pnlUsd) || 0,
            score: rec.score || 0
          };

          if (isCancelled) {
            cancelledTrades.push(tradeItem);
          } else {
            completedTrades.push(tradeItem);
          }
        } catch (_) {}
      }
    } catch (e) {
      log.warn(`[DailyReporter] Lỗi đọc ai_trade_dataset: ${e.message}`);
    }
  }

  // Sắp xếp các lệnh theo thời gian kết thúc tăng dần
  completedTrades.sort((a, b) => a.exitTimestamp - b.exitTimestamp);

  // 3. Tính toán các chỉ số thống kê
  let tpCount = 0;
  let beCount = 0;
  let slCount = 0;
  let otherCount = 0;
  let totalPnlUsd = 0;
  let totalRoiPct = 0;

  for (const t of completedTrades) {
    totalPnlUsd += t.pnlUsd;
    totalRoiPct += t.pnlPercent;
    if (t.type === 'TP') tpCount++;
    else if (t.type === 'BE') beCount++;
    else if (t.type === 'SL') slCount++;
    else otherCount++;
  }

  const decisiveCount = tpCount + slCount;
  const winRate = decisiveCount > 0 ? (tpCount / decisiveCount) * 100 : 0;
  const totalClosed = tpCount + beCount + slCount + otherCount;
  const winBeRate = totalClosed > 0 ? ((tpCount + beCount) / totalClosed) * 100 : 0;

  // 4. Lấy danh sách vị thế đang mở
  const activePositions = [];
  if (fs.existsSync(SHADOW_POSITIONS_FILE)) {
    try {
      const activeRaw = JSON.parse(fs.readFileSync(SHADOW_POSITIONS_FILE, 'utf8'));
      for (const p of Object.values(activeRaw)) {
        if (!p || !p.symbol) continue;
        const sym = p.symbol;
        const currentPrice = getMarkPrice(sym) || p.entryPrice;
        let unrealizedRoi = 0;
        if (p.isFilled && p.entryPrice > 0 && currentPrice > 0) {
          const delta = p.signal === 'LONG' ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice);
          unrealizedRoi = (delta / p.entryPrice) * 100 * (p.leverage || 10);
        }
        activePositions.push({
          symbol: sym,
          signal: p.signal,
          entryPrice: p.entryPrice,
          currentPrice,
          isFilled: p.isFilled,
          leverage: p.leverage || 10,
          unrealizedRoi: Math.round(unrealizedRoi * 10) / 10,
          isShadow: true
        });
      }
    } catch (_) {}
  }

  return {
    windowMs,
    startTime,
    endTime: now,
    totalClosed,
    tpCount,
    beCount,
    slCount,
    cancelCount: cancelledTrades.length,
    winRate: Math.round(winRate * 10) / 10,
    winBeRate: Math.round(winBeRate * 10) / 10,
    totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
    totalRoiPct: Math.round(totalRoiPct * 10) / 10,
    completedTrades,
    cancelledTrades,
    activePositions
  };
}

/**
 * Định dạng báo cáo HTML gửi Telegram
 */
function formatDailyReportHtml(stats) {
  const isShadow = process.env.SHADOW_MODE === 'true' || !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET;
  const modeLabel = isShadow ? 'Shadow Mode (Paper Trading)' : 'Real Trading (Lệnh Thật)';

  const startVn = new Date(stats.startTime + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(5, 16);
  const endVn = new Date(stats.endTime + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(5, 16);

  const pnlSign = stats.totalPnlUsd >= 0 ? '+' : '';
  const pnlEmoji = stats.totalPnlUsd > 0 ? '🟢' : (stats.totalPnlUsd < 0 ? '🔴' : '⚖️');
  const roiSign = stats.totalRoiPct >= 0 ? '+' : '';

  let html = `📊 <b>[PP369 H1 Tháng] TỔNG KẾT GIAO DỊCH 24H</b>\n`;
  html += `📅 <i>Thời gian: ${startVn} ➜ ${endVn} (UTC+7)</i>\n`;
  html += `⚙️ <i>Chế độ: <b>${modeLabel}</b></i>\n\n`;

  html += `━━━━━━━━━━━━━━━━━━━\n`;
  html += `📈 <b>HIỆU SUẤT TỔNG QUAN:</b>\n`;
  html += `• Tổng lệnh hoàn tất: <b>${stats.totalClosed} lệnh</b>\n`;
  html += `• 🟢 Chốt lời (TP): <b>${stats.tpCount} lệnh</b>\n`;
  html += `• ⚖️ Hòa vốn (BE): <b>${stats.beCount} lệnh</b>\n`;
  html += `• 🔴 Cắt lỗ (SL): <b>${stats.slCount} lệnh</b>\n`;
  if (stats.cancelCount > 0) {
    html += `• ⚪ Hủy treo / Timeout: <b>${stats.cancelCount} lệnh</b>\n`;
  }
  html += `• 🎯 Tỷ lệ Thắng (Win Rate): <b>${stats.winRate}%</b>${stats.tpCount + stats.slCount > 0 ? ` (${stats.tpCount}/${stats.tpCount + stats.slCount})` : ''}\n`;
  html += `• 🛡️ Bảo toàn vốn (Win + BE): <b>${stats.winBeRate}%</b>\n`;
  html += `• ${pnlEmoji} Tổng PnL 24h: <b>${pnlSign}$${stats.totalPnlUsd.toFixed(2)} USD</b> (ROI: <b>${roiSign}${stats.totalRoiPct.toFixed(1)}%</b>)\n`;

  // Danh sách vị thế đang mở (tóm tắt gọn nếu có)
  if (stats.activePositions.length > 0) {
    html += `\n━━━━━━━━━━━━━━━━━━━\n`;
    html += `👁️ <b>VỊ THẾ ĐANG CHẠY (${stats.activePositions.length} vị thế):</b>\n`;
    stats.activePositions.slice(0, 10).forEach((p, idx) => {
      const statusLabel = p.isFilled ? 'Đã khớp' : 'Chờ Limit';
      const roiSign = p.unrealizedRoi >= 0 ? '+' : '';
      html += `${idx + 1}. <b>${p.symbol} ${p.signal}</b> [${statusLabel}]`;
      if (p.isFilled) {
        html += ` (ROI: <b>${roiSign}${p.unrealizedRoi}%</b>)`;
      }
      html += `\n`;
    });
    if (stats.activePositions.length > 10) {
      html += `<i>... và ${stats.activePositions.length - 10} vị thế khác đang theo dõi.</i>\n`;
    }
  }

  html += `\n━━━━━━━━━━━━━━━━━━━\n`;
  html += `💡 <i>Bot PP369 H1 Tháng tự động tổng kết định kỳ 24h để hỗ trợ đánh giá chiến lược.</i>`;

  return html;
}

/**
 * Gửi báo cáo tổng kết 24h qua Telegram
 */
async function sendDailyReportTelegram() {
  try {
    const stats = getDailyTradeStats();
    const html = formatDailyReportHtml(stats);
    await sendTelegram(html);
    log.system(`[DailyReporter] ✓ Đã gửi báo cáo tổng kết 24h về Telegram thành công (${stats.totalClosed} lệnh, PnL: $${stats.totalPnlUsd})`);
    return stats;
  } catch (err) {
    log.warn(`[DailyReporter] Không thể gửi báo cáo Telegram: ${err.message}`);
    return null;
  }
}

/**
 * Đọc ngày gửi báo cáo gần nhất từ đĩa
 */
function getLastReportDay() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return data.lastReportDay || null;
    }
  } catch (_) {}
  return null;
}

/**
 * Lưu ngày gửi báo cáo gần nhất
 */
function saveLastReportDay(dayStr) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastReportDay: dayStr, timestamp: Date.now() }, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Khởi động scheduler quét kiểm tra mỗi phút:
 * Tự động gửi báo cáo vào đúng 07:00 AM giờ Việt Nam (00:00 UTC) mỗi ngày.
 */
function startDailyReportScheduler() {
  log.system('[DailyReporter] 📅 Đã kích hoạt bộ lập lịch Báo Cáo 24H (Tự động gửi lúc 07:00 UTC+7 mỗi sáng).');

  setInterval(async () => {
    try {
      const now = new Date();
      // Giờ Việt Nam (UTC+7)
      const vnTime = new Date(now.getTime() + 7 * 3600 * 1000);
      const vnDateStr = vnTime.toISOString().slice(0, 10); // 'YYYY-MM-DD'
      const vnHour = vnTime.getUTCHours();
      const vnMinute = vnTime.getUTCMinutes();

      // Bắn báo cáo vào đúng 07:00 AM (giờ đóng nến ngày của Binance Futures)
      if (vnHour === 7 && vnMinute === 0) {
        const lastDay = getLastReportDay();
        if (lastDay !== vnDateStr) {
          saveLastReportDay(vnDateStr);
          await sendDailyReportTelegram();
        }
      }
    } catch (err) {
      log.warn(`[DailyReporter] Lỗi scheduler: ${err.message}`);
    }
  }, 60_000);
}

module.exports = {
  getDailyTradeStats,
  formatDailyReportHtml,
  sendDailyReportTelegram,
  startDailyReportScheduler
};

