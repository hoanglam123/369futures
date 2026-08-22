'use strict';

/**
 * Telegram Notifier — PP369
 * Gửi thông báo tín hiệu và trạng thái bot qua Telegram Bot API.
 */

const axios = require('axios');
const https = require('https');
const { log } = require('./_logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8974388983:AAGTEgJNmAegGPmWUgvd3Lpvtbefv-yn6pg';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1663202780';

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

// Tái sử dụng kết nối HTTPS Keep-Alive tới Telegram API để giảm thiểu độ trễ và tránh handshake lại
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 10,
});

const axiosTelegram = axios.create({
  httpsAgent,
  timeout: 20_000, // Tăng timeout lên 20s phòng ngừa nghẽn mạng quốc tế
});

/**
 * Gửi một tin nhắn Telegram (HTML parse mode).
 * @param {string} text - Nội dung tin nhắn HTML
 * @returns {Promise<void>}
 */
async function sendTelegram(text) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axiosTelegram.post(API_URL, {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return; // Gửi thành công -> thoát
    } catch (err) {
      if (err.response?.status === 400) {
        // Fallback khẩn cấp nếu dính lỗi HTML parse entity: Gửi dạng Plain Text loại bỏ thẻ HTML
        try {
          const plainText = (text || '').replace(/<[^>]*>/g, '');
          await axiosTelegram.post(API_URL, {
            chat_id: CHAT_ID,
            text: plainText,
            disable_web_page_preview: true,
          });
          return;
        } catch (_) {}
      }

      if (attempt < maxAttempts) {
        log.warn(`[Telegram] Lỗi gửi tin nhắn (Lần ${attempt}/${maxAttempts}): ${err.message}. Thử lại sau 2 giây...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const apiDesc = err.response?.data?.description ?? '(no response body)';
      const preview = text ? text.slice(0, 300).replace(/\n/g, '↵') : '(empty)';
      log.warn(`[Telegram] Lỗi gửi tin nhắn (Thất bại sau ${maxAttempts} lần): ${err.message} | API: ${apiDesc}`);
      log.warn(`[Telegram] Nội dung bị lỗi (300 ký tự đầu): ${preview}`);
    }
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
