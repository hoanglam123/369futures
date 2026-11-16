'use strict';

/**
 * Kiểm tra biến động giá BTC mỗi 1 phút.
 * Gửi alert khi giá thay đổi >= BTC_ALERT_USD$ (mặc định $1000) so với giá
 * BTC_ALERT_WINDOW phút trước (mặc định 15 phút — tương đương nến 15p).
 * Cooldown BTC_ALERT_COOLDOWN phút giữa 2 alert liên tiếp (mặc định 30).
 */

const { getBTCPrice } = require('../collectors/btcPrice');
const { sendMessages } = require('./telegram');
const { log } = require('./logger');

const THRESHOLD_USD  = parseInt(process.env.BTC_ALERT_USD      || '1000', 10);
const COOLDOWN_MS    = parseInt(process.env.BTC_ALERT_COOLDOWN || '30',   10) * 60_000;
const WINDOW_MINUTES = parseInt(process.env.BTC_ALERT_WINDOW   || '15',   10);
const DIVIDER        = '━━━━━━━━━━━━━━━━';
const TIMEZONE       = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';

const MAX_HISTORY = WINDOW_MINUTES + 5;

let priceHistory  = []; // [{ price, ts }]
let lastAlertTime = 0;
let initialized   = false;

// ─── Format ──────────────────────────────────────────────────────────────────

function fmtPrice(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function fmtDelta(n) {
  return `${n >= 0 ? '+' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

function fmtPct(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function directionEmoji(delta) {
  if (delta >= 3000) return '🚀';
  if (delta >= 1000) return '📈';
  if (delta <= -3000) return '💥';
  if (delta < 0) return '📉';
  return '📈';
}

function buildAlertMessage(current, refPrice, delta, ageMin) {
  const pct       = (current - refPrice) / refPrice * 100;
  const emoji     = directionEmoji(delta);
  const direction = delta > 0 ? 'tăng' : 'giảm';
  const now       = new Date().toLocaleString('vi-VN', { timeZone: TIMEZONE });

  let msg = `🚨 <b>CẢNH BÁO BIẾN ĐỘNG BTC</b>\n`;
  msg += `${DIVIDER}\n\n`;
  msg += `${emoji} BTC <b>${direction} ${fmtDelta(delta)}</b> trong <b>${ageMin} phút</b>\n`;
  msg += `   <i>(${fmtPct(pct)})</i>\n\n`;
  msg += `💰 Giá hiện tại: <b>${fmtPrice(current)}</b>\n`;
  msg += `📊 Giá ${ageMin} phút trước: <i>${fmtPrice(refPrice)}</i>\n\n`;
  msg += `${DIVIDER}\n`;
  msg += `⏰ <i>${now}</i>`;

  return msg;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function checkBTCAlert() {
  let current;
  try {
    current = await getBTCPrice();
  } catch (e) {
    log.warn('BTC Alert: Không lấy được giá', { error: e.message });
    return;
  }

  const now = Date.now();

  priceHistory.push({ price: current, ts: now });
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();

  if (!initialized) {
    initialized = true;
    log.price(`BTC Alert khởi tạo: ${fmtPrice(current)} | ngưỡng ${fmtDelta(THRESHOLD_USD)}/nến ${WINDOW_MINUTES}p`);
    return;
  }

  if ((now - lastAlertTime) < COOLDOWN_MS) return;

  // Lấy entry gần nhất đã đủ WINDOW_MINUTES phút trước
  const windowMs = WINDOW_MINUTES * 60_000;
  const refEntry = priceHistory
    .filter(e => (now - e.ts) >= windowMs * 0.75)
    .at(-1);

  if (!refEntry) return;

  const delta  = current - refEntry.price;
  const ageMin = Math.round((now - refEntry.ts) / 60_000);

  if (Math.abs(delta) >= THRESHOLD_USD) {
    const msg = buildAlertMessage(current, refEntry.price, delta, ageMin);
    log.price(`BTC Alert: ${fmtDelta(delta)} trong ${ageMin}p (${fmtPrice(refEntry.price)} → ${fmtPrice(current)}) — gửi alert`);
    try {
      await sendMessages([msg]);
      lastAlertTime = now;
    } catch (e) {
      log.error('BTC Alert: Không gửi được Telegram', { error: e.message });
    }
  }
}

module.exports = { checkBTCAlert };
