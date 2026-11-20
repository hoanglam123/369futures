'use strict';

/**
 * Ghi log ra file data/logs/bot-YYYY-MM-DD.log theo ngày.
 * Mỗi dòng: [HH:MM:SS] [CATEGORY] message | {json}
 */

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'data', 'logs');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';

function todayFile() {
  const d = new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE }); // YYYY-MM-DD
  return path.join(LOGS_DIR, `bot-${d}.log`);
}

function timeStr() {
  return new Date().toLocaleTimeString('vi-VN', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function write(category, message, data) {
  const dataStr = data != null ? ' | ' + JSON.stringify(data) : '';
  const line    = `[${timeStr()}] [${category.padEnd(8)}] ${message}${dataStr}\n`;

  // Luôn in ra console (PM2 capture)
  process.stdout.write(line);

  // Ghi vào file log theo ngày
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(todayFile(), line, 'utf8');
  } catch {
    // Không crash nếu ghi file lỗi
  }
}

const log = {
  system:   (msg, data) => write('SYSTEM',   msg, data),
  trade:    (msg, data) => write('TRADE',    msg, data),
  price:    (msg, data) => {
    if (process.env.LOG_PRICE === 'true') write('PRICE', msg, data);
  },
  ai:       (msg, data) => write('AI',       msg, data),
  funding:  (msg, data) => write('FUNDING',  msg, data),
  telegram: (msg, data) => write('TELEGRAM', msg, data),
  warn:     (msg, data) => write('WARN',     msg, data),
  error:    (msg, data) => write('ERROR',    msg, data),
};

module.exports = { log };
