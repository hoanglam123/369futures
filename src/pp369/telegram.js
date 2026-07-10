'use strict';

/**
 * Telegram Notifier — PP369
 * Gửi thông báo tín hiệu và trạng thái bot qua Telegram Bot API.
 */

const axios = require('axios');
const { log } = require('./_logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8974388983:AAGTEgJNmAegGPmWUgvd3Lpvtbefv-yn6pg';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1663202780';

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

/**
 * Gửi một tin nhắn Telegram (HTML parse mode).
 * @param {string} text - Nội dung tin nhắn HTML
 * @returns {Promise<void>}
 */
async function sendTelegram(text) {
  try {
    await axios.post(API_URL, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (err) {
    log.warn(`[Telegram] Lỗi gửi tin nhắn: ${err.message}`);
  }
}

/**
 * Gửi thông báo khởi động bot.
 * @param {number} coinCount - Số mã coin đang theo dõi
 */
async function notifyBotStart(coinCount) {
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const text = [
    '🚀 <b>PP369 AutoTrade đã khởi động</b>',
    '',
    `🕐 Thời gian: <code>${now}</code>`,
    `📊 Số mã theo dõi: <b>${coinCount}</b> coin`,
    '',
    '<i>Bot đang quét các mốc phản ứng theo phương pháp 369...</i>',
  ].join('\n');

  await sendTelegram(text);
}

/**
 * Gửi thông báo khi phát hiện tín hiệu LONG / SHORT.
 * @param {Object[]} signals - Danh sách tín hiệu từ get369Signal (signal !== 'NONE')
 */
async function notifySignals(signals) {
  if (!signals || !signals.length) return;

  const { format369Alert } = require('./formatter');
  const text = format369Alert(signals);
  await sendTelegram(text);
}

module.exports = { sendTelegram, notifyBotStart, notifySignals };
