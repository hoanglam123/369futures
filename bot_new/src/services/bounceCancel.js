'use strict';

/**
 * Bounce Cancel — Phase 4 Cơ chế Hủy lệnh Bật Nảy
 *
 * Khi treo lệnh LIMIT tại mốc hỗ trợ/kháng cự:
 * - Nếu giá tiếp cận sát mốc (<= 0.08% hoặc theo gridStep) rồi bật ngược ra xa (> 0.6%) mà không khớp lệnh:
 * - Bot nhận diện dòng tiền đã phản ứng xong tại mốc -> Tự động hủy lệnh LIMIT và đưa mốc vào cooldown 60 phút.
 * - Tránh rủi ro khi giá quay lại test lần thứ 2 (dễ thủng mốc).
 */

const { log } = require('./logger');

const CLOSE_PROXIMITY_PCT = parseFloat(process.env.CLOSE_PROXIMITY_PCT || '0.20'); // 0.20% xem như đã tiệm cận mốc (chuẩn bot-h4)
const BOUNCE_AWAY_PCT     = parseFloat(process.env.BOUNCE_AWAY_PCT || '1.50');     // 1.50% bật nảy ra xa (thích ứng đòn bẩy thấp 3x-7x)
const BOUNCE_CANCEL_WAIT_MS = parseInt(process.env.BOUNCE_CANCEL_WAIT_SECONDS || '180', 10) * 1000; // Chờ xác nhận 180s (3p) trước khi hủy
const BOUNCE_COOLDOWN_MS  = 60 * 60 * 1000; // 60 phút cooldown cho mốc

// key: `${symbol}_${targetLevel}` -> { nearestPrice, peakPrice, setAt, ... }
const _trackedLimits = new Map();
// key: `${symbol}_${targetLevel}` -> expireTimestamp
const _bounceCooldowns = new Map();

function trackPendingLimit(trade) {
  if (!trade || !trade.symbol || !trade.entryPrice) return;
  const sym = trade.symbol.replace('USDT', '').toUpperCase();
  const level = trade.targetLevel || trade.entryPrice;
  const key = `${sym}_${level}`;

  // Tự động dọn các entry cũ hơn 4 giờ
  const now = Date.now();
  for (const [k, v] of _trackedLimits.entries()) {
    if (now - (v.setAt || 0) > 4 * 3600 * 1000) {
      _trackedLimits.delete(k);
    }
  }

  if (!_trackedLimits.has(key)) {
    _trackedLimits.set(key, {
      symbol: sym,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      targetLevel: level,
      orderId: trade.binanceEntryOrderId || trade.id,
      minDistancePct: Infinity,
      bouncePeakPrice: trade.entryPrice,
      hasApproached: false,
      setAt: now
    });
  }
}

function untrackLimit(sym, level) {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();
  const key = `${cleanSym}_${level}`;
  _trackedLimits.delete(key);
}

/**
 * Kiểm tra xem lệnh Limit có bị bật nảy không khớp (Bounce Cancel)
 * @param {object} trade 
 * @param {number} currentPrice 
 * @param {object} [opts] - { waitMs?: number, nowMs?: number }
 * @returns {{ shouldCancel: boolean, reason: string }}
 */
function checkBounceCancel(trade, currentPrice, opts = {}) {
  if (!trade || !currentPrice || currentPrice <= 0) {
    return { shouldCancel: false, reason: '' };
  }

  const waitMs = opts.waitMs !== undefined ? opts.waitMs : BOUNCE_CANCEL_WAIT_MS;
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();

  const sym = (trade.symbol || '').replace('USDT', '').toUpperCase();
  const level = trade.targetLevel || trade.entryPrice;
  const key = `${sym}_${level}`;

  let tracker = _trackedLimits.get(key);
  if (!tracker) {
    trackPendingLimit(trade);
    tracker = _trackedLimits.get(key);
  }
  if (!tracker) return { shouldCancel: false, reason: '' };

  const entry = tracker.entryPrice;
  const distPct = Math.abs(currentPrice - entry) / entry * 100;

  if (distPct < tracker.minDistancePct) {
    tracker.minDistancePct = distPct;
  }

  // Đã từng tiếp cận sát mốc (<= 0.20% hoặc chạm/xuyên qua entry chuẩn bot-h4)
  const isLong = tracker.direction === 'LONG' || tracker.direction === 'BUY';
  const isTouch = isLong ? currentPrice <= entry * 1.0015 : currentPrice >= entry * 0.9985;
  if (distPct <= CLOSE_PROXIMITY_PCT || isTouch) {
    tracker.hasApproached = true;
    if (!tracker.touchedTime) tracker.touchedTime = now;
  }

  // Cập nhật giá nảy và kiểm tra duy trì đủ thời gian chờ xác nhận (BOUNCE_CANCEL_WAIT_MS)
  if (tracker.hasApproached) {
    const currentBouncePct = isLong
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100;

    if (isLong && (tracker.peakPrice == null || currentPrice > tracker.peakPrice)) {
      tracker.peakPrice = currentPrice;
    } else if (!isLong && (tracker.lowestPrice == null || currentPrice < tracker.lowestPrice)) {
      tracker.lowestPrice = currentPrice;
    }

    if (currentBouncePct >= BOUNCE_AWAY_PCT) {
      if (!tracker.bounceConfirmStartTime) {
        tracker.bounceConfirmStartTime = now;
        if (waitMs > 0) {
          log.system(`[AutoTrade] [BounceCancel] ${sym} ${isLong ? 'LONG' : 'SHORT'}: Giá nảy ${currentBouncePct.toFixed(2)}% >= ${BOUNCE_AWAY_PCT.toFixed(2)}% — Chờ xác nhận ${Math.round(waitMs / 1000)}s trước khi hủy LIMIT...`);
          return { shouldCancel: false, reason: 'WAITING_BOUNCE_CONFIRM' };
        }
      }

      if (waitMs > 0 && (now - tracker.bounceConfirmStartTime) < waitMs) {
        return { shouldCancel: false, reason: 'WAITING_BOUNCE_CONFIRM' };
      }

      _trackedLimits.delete(key);
      _bounceCooldowns.set(key, now + BOUNCE_COOLDOWN_MS);
      const sign = isLong ? '+' : '-';
      log.system(`[AutoTrade] [BounceCancel] ${sym} ${isLong ? 'LONG' : 'SHORT'}: entry=$${entry}, current=$${currentPrice} (duy trì nảy ${sign}${currentBouncePct.toFixed(2)}% >= ${BOUNCE_AWAY_PCT.toFixed(2)}% suốt ${Math.round(waitMs / 1000)}s) → Hủy LIMIT`);
      return {
        shouldCancel: true,
        reason: `Bounce Cancel: Giá duy trì nảy ${sign}${currentBouncePct.toFixed(2)}% ra xa mốc suốt ${Math.round(waitMs / 1000)}s (tiệm cận ${tracker.minDistancePct.toFixed(3)}%)`
      };
    } else if (tracker.bounceConfirmStartTime) {
      // Giá đã quay đầu về dưới ngưỡng nảy -> reset bộ đếm, tiếp tục giữ lệnh LIMIT
      log.system(`[AutoTrade] [BounceCancel] ${sym} ${isLong ? 'LONG' : 'SHORT'}: Giá quay lại dưới ngưỡng nảy (${currentBouncePct.toFixed(2)}% < ${BOUNCE_AWAY_PCT.toFixed(2)}%) → Tiếp tục giữ lệnh LIMIT.`);
      tracker.bounceConfirmStartTime = null;
    }
  }

  return { shouldCancel: false, reason: '' };
}

function isLevelBounceCooldown(sym, targetLevel) {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();
  const key = `${cleanSym}_${targetLevel}`;
  const exp = _bounceCooldowns.get(key);
  if (!exp) return false;
  if (Date.now() < exp) return true;
  _bounceCooldowns.delete(key);
  return false;
}

function getBounceCooldowns() {
  const now = Date.now();
  const result = [];
  for (const [key, exp] of _bounceCooldowns.entries()) {
    if (exp > now) {
      result.push({ key, remainingMins: Math.round((exp - now) / 60000) });
    }
  }
  return result;
}

function clearBounceCooldowns() {
  _bounceCooldowns.clear();
  _trackedLimits.clear();
}

module.exports = {
  trackPendingLimit,
  untrackLimit,
  checkBounceCancel,
  isLevelBounceCooldown,
  getBounceCooldowns,
  clearBounceCooldowns,
  CLOSE_PROXIMITY_PCT,
  BOUNCE_AWAY_PCT
};
