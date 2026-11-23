'use strict';

/**
 * Dịch vụ gửi tin nhắn lên Telegram qua Bot API
 * Sử dụng axios trực tiếp (không cần thư viện nặng)
 * Docs: https://core.telegram.org/bots/api#sendmessage
 */

const axios    = require('axios');
const FormData = require('form-data');
const { log }  = require('./logger');

// Giới hạn ký tự Telegram cho mỗi tin nhắn
const TELEGRAM_MAX_LENGTH = 4096;

// Đóng tất cả HTML tags đang mở trong đoạn text
function closeOpenTags(text) {
  const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'code', 'pre', 'a']);
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, slash, tag] = m;
    const t = tag.toLowerCase();
    if (!TAGS.has(t)) continue;
    if (slash) { if (stack[stack.length - 1] === t) stack.pop(); }
    else stack.push(t);
  }
  let result = text;
  while (stack.length) result += `</${stack.pop()}>`;
  return result;
}

// Chia message dài thành nhiều phần tại ranh giới section (dấu ━━━)
// Mỗi phần ≤ maxLen ký tự, không cắt giữa HTML tag
function splitHtmlMessage(text, maxLen = TELEGRAM_MAX_LENGTH - 100) {
  if (text.length <= maxLen) return [text];

  const DIVIDER = '━━━━━━━━━━━━━━━━';
  const parts = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.slice(start);
    if (remaining.length <= maxLen) {
      parts.push(closeOpenTags(remaining.trim()));
      break;
    }

    const chunk = text.slice(start, start + maxLen);

    // Ưu tiên cắt tại ranh giới section (dấu ━━━)
    const divPos = chunk.lastIndexOf(DIVIDER);
    if (divPos > maxLen / 4) {
      parts.push(closeOpenTags(text.slice(start, start + divPos).trim()));
      start += divPos;
      continue;
    }

    // Fallback: cắt tại xuống dòng gần nhất
    const nlPos = chunk.lastIndexOf('\n');
    const cutAt = nlPos > maxLen / 2 ? nlPos : maxLen;
    parts.push(closeOpenTags(text.slice(start, start + cutAt).trim()));
    start += cutAt;
  }

  return parts.filter(p => p.trim().length > 0);
}

/**
 * Chọn bot token phù hợp theo chat_id:
 *   - Nếu chatId là TELEGRAM_NEWS_CHAT_ID và TELEGRAM_NEWS_BOT_TOKEN được cấu hình → dùng news token
 *   - Còn lại → dùng TELEGRAM_BOT_TOKEN mặc định
 */
function resolveApiUrl(chatId = null) {
  const newsChatId  = process.env.TELEGRAM_NEWS_CHAT_ID;
  const newsToken   = process.env.TELEGRAM_NEWS_BOT_TOKEN;
  if (chatId && newsChatId && String(chatId) === String(newsChatId) && newsToken) {
    return `https://api.telegram.org/bot${newsToken}`;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Thiếu TELEGRAM_BOT_TOKEN trong file .env');
  return `https://api.telegram.org/bot${token}`;
}

function getChatId(override = null) {
  const chatId = override || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('Thiếu TELEGRAM_CHAT_ID trong file .env');
  return chatId;
}

function validateTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const botId = token.split(':')[0];
  if (String(chatId).trim() === String(botId).trim()) {
    log.error(`[Telegram] ❌ CẤU HÌNH SAI: TELEGRAM_CHAT_ID="${chatId}" trong file .env đang trùng với Bot ID! Telegram cấm Bot gửi tin nhắn cho chính nó. Vui lòng mở file .env trên VPS sửa TELEGRAM_CHAT_ID thành Chat ID cá nhân của bạn (ví dụ: 1663202780) hoặc Channel/Group ID.`);
  }
}

validateTelegramConfig();

/**
 * Gửi một tin nhắn HTML lên Telegram
 * Tự động cắt bớt nếu nội dung quá dài
 * @param {string} text - Nội dung tin nhắn (HTML format)
 * @param {object} extra - Tùy chọn bổ sung cho Telegram API
 */
/**
 * Escape ký tự '<' đứng lẻ không thuộc các thẻ HTML hợp lệ của Telegram (vd: "<1.5%.", "<=0.5%")
 */
function sanitizeTelegramHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<(?!\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler)\b[^>]*>)/gi, '&lt;');
}

async function sendMessage(text, extra = {}, chatId = null) {
  const resolvedChatId = getChatId(chatId);
  const apiUrl = resolveApiUrl(resolvedChatId);

  // Nếu gọi trực tiếp sendMessage với text dài (không qua sendMessages),
  // split lấy phần đầu thay vì cắt cụt giữa chừng
  const rawSafeText = text.length > TELEGRAM_MAX_LENGTH
    ? splitHtmlMessage(text)[0]
    : text;
  const safeText = sanitizeTelegramHtml(rawSafeText);

  let response;
  try {
    response = await axios.post(
      `${apiUrl}/sendMessage`,
      {
        chat_id: resolvedChatId,
        text: safeText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra
      },
      { timeout: 30000 }
    );
  } catch (err) {
    const detail = err.response?.data?.description ?? err.message;
    const status = err.response?.status ?? 'N/A';

    // Nếu vẫn gặp lỗi 400 can't parse entities (vd AI viết lệch cặp thẻ <b>...</i>),
    // tự động fallback gửi bản plain text sạch thẻ HTML để không làm crash job bản tin
    if (status === 400 && typeof detail === 'string' && detail.includes("can't parse entities")) {
      log.warn(`[Telegram] Lỗi parse HTML (${detail}) — tự động fallback gửi plain text`);
      const plainText = rawSafeText.replace(/<\/?[a-z][^>]*>/gi, '').slice(0, TELEGRAM_MAX_LENGTH);
      const { parse_mode, ...restExtra } = extra || {};
      const fallbackRes = await axios.post(
        `${apiUrl}/sendMessage`,
        {
          chat_id: resolvedChatId,
          text: plainText,
          disable_web_page_preview: true,
          ...restExtra
        },
        { timeout: 30000 }
      );
      if (fallbackRes.data?.ok) return fallbackRes.data.result;
    }

    if (status === 403 && typeof detail === 'string' && detail.includes("the bot can't send messages to the bot")) {
      log.error(`[Telegram] ❌ CẤU HÌNH SAI: TELEGRAM_CHAT_ID (${resolvedChatId}) đang là ID của Bot! Vui lòng vào file .env trên VPS đổi TELEGRAM_CHAT_ID thành User ID của bạn (ví dụ: 1663202780) hoặc Channel/Group ID.`);
    }
    throw new Error(`Telegram API lỗi [${status}]: ${detail}`);
  }

  if (!response.data.ok) {
    throw new Error(`Telegram API lỗi: ${JSON.stringify(response.data)}`);
  }

  return response.data.result;
}

/**
 * Gửi nhiều tin nhắn lần lượt với delay nhỏ giữa các tin
 * Tránh bị Telegram rate-limit (30 msg/giây với same chat)
 * @param {string[]} messages - Mảng các tin nhắn cần gửi
 * @param {number} delayMs - Thời gian chờ giữa các tin (ms)
 */
async function sendMessages(messages, delayMs = 1500, chatId = null) {
  const results = [];
  // Mỗi message dài được chia tự động thành nhiều phần trước khi gửi
  const parts = messages.flatMap(msg => splitHtmlMessage(msg));

  for (let i = 0; i < parts.length; i++) {
    const result = await sendMessage(parts[i], {}, chatId);
    results.push(result);
    if (i < parts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

/**
 * Gửi tin nhắn thông báo lỗi (fallback khi job thất bại)
 * Dùng Markdown thông thường thay vì HTML để tránh lỗi parse
 */
async function sendErrorAlert(errorMessage) {
  const safeErr = String(errorMessage).slice(0, 500)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const text = `⚠️ <b>Crypto Bot - Lỗi hệ thống</b>\n\n<code>${safeErr}</code>\n\n<i>Vui lòng kiểm tra logs để biết thêm chi tiết.</i>`;
  return sendMessage(text);
}

/**
 * Gửi ảnh PNG lên Telegram kèm caption HTML.
 * Dùng Node.js 18+ built-in FormData (không cần thư viện form-data).
 * @param {Buffer} imageBuffer - PNG buffer
 * @param {string} caption     - Caption HTML (tối đa 1024 ký tự)
 */
async function sendPhoto(imageBuffer, caption = '', chatId = null) {
  const resolvedChatId = getChatId(chatId);
  const apiUrl = resolveApiUrl(resolvedChatId);

  let form = new FormData();
  form.append('chat_id', resolvedChatId);
  form.append('photo', imageBuffer, { filename: 'chart.png', contentType: 'image/png' });
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await axios.post(`${apiUrl}/sendPhoto`, form, {
        headers: { ...form.getHeaders(), 'Content-Length': form.getLengthSync() },
        timeout: 60000,
      });
      break;
    } catch (err) {
      const detail = err.response?.data?.description ?? err.message;
      if (attempt === 3) throw new Error(`Telegram sendPhoto lỗi: ${detail}`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
      // Tạo lại form vì form-data stream không thể replay
      form = new FormData();
      form.append('chat_id', resolvedChatId);
      form.append('photo', imageBuffer, { filename: 'chart.png', contentType: 'image/png' });
      if (caption) form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'HTML');
    }
  }

  if (!response.data.ok) {
    throw new Error(`Telegram sendPhoto lỗi: ${JSON.stringify(response.data)}`);
  }
  return response.data.result;
}

module.exports = { sendMessage, sendMessages, sendErrorAlert, sendPhoto };
