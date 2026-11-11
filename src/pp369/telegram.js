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
const BOT_TAG = process.env.BOT_TAG !== undefined ? process.env.BOT_TAG : '';

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
 * Gửi một tin nhắn đơn lẻ lên Telegram.
 */
async function _sendSingleTelegram(messageText) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axiosTelegram.post(API_URL, {
        chat_id: CHAT_ID,
        text: messageText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return; // Gửi thành công -> thoát
    } catch (err) {
      if (err.response?.status === 400) {
        // Fallback khẩn cấp nếu dính lỗi HTML parse entity: Gửi dạng Plain Text loại bỏ thẻ HTML
        try {
          const plainText = (messageText || '').replace(/<[^>]*>/g, '');
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
      const preview = messageText ? messageText.slice(0, 300).replace(/\n/g, '↵') : '(empty)';
      log.warn(`[Telegram] Lỗi gửi tin nhắn (Thất bại sau ${maxAttempts} lần): ${err.message} | API: ${apiDesc}`);
      log.warn(`[Telegram] Nội dung bị lỗi (300 ký tự đầu): ${preview}`);
    }
  }
}

/**
 * Gửi tin nhắn Telegram (HTML parse mode).
 * Tự động chia nhỏ tin nhắn nếu vượt quá giới hạn 4096 ký tự của Telegram API.
 * @param {string} text - Nội dung tin nhắn HTML
 * @returns {Promise<void>}
 */
async function sendTelegram(text) {
  if (!text) return;
  const finalPrefix = BOT_TAG ? `${BOT_TAG} ` : '';
  const messageText = (finalPrefix && !text.includes(BOT_TAG)) ? `${finalPrefix}${text}` : text;

  // Giới hạn Telegram là 4096 ký tự. Chia nhỏ an toàn ở mốc 3800 ký tự theo dòng nén
  if (messageText.length <= 3800) {
    return await _sendSingleTelegram(messageText);
  }

  const lines = messageText.split('\n');
  const chunks = [];
  let currentChunk = '';

  for (const line of lines) {
    if ((currentChunk + '\n' + line).length > 3800) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = currentChunk ? (currentChunk + '\n' + line) : line;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  for (let i = 0; i < chunks.length; i++) {
    await _sendSingleTelegram(chunks[i]);
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500)); // Delay 500ms tránh spam rate limit
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
    `🚀 <b>${BOT_TAG ? BOT_TAG + ' ' : ''}PP369 AutoTrade đã khởi động</b>`,
    '',
    `🕐 Thời gian: <code>${now}</code>`,
    `📊 Số mã theo dõi: <b>${coinCount}</b> coin`,
    '',
    '<i>Bot đang quét các mốc phản ứng theo phương pháp 369...</i>',
  ].join('\n');
  return sendTelegram(text);
}

module.exports = {
  sendTelegram,
  notifyBotStart,
};
