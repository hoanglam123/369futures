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

const CLOSE_PROXIMITY_PCT = 0.08; // 0.08% xem như đã tiệm cận mốc
const BOUNCE_AWAY_PCT     = 0.60; // 0.60% bật nảy ra xa
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
      setAt: Date.now()
    });
  }
}

/**
 * Kiểm tra xem lệnh Limit có bị bật nảy không khớp (Bounce Cancel)
 * @param {object} trade 
 * @param {number} currentPrice 
 * @returns {{ shouldCancel: boolean, reason: string }}
 */
function checkBounceCancel(trade, currentPrice) {
  if (!trade || !currentPrice || currentPrice <= 0) {
    return { shouldCancel: false, reason: '' };
  }

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

  // Đã từng tiếp cận sát mốc (<= 0.08%)
  if (distPct <= CLOSE_PROXIMITY_PCT) {
    tracker.hasApproached = true;
  }

  // Cập nhật giá nảy cực đại sau khi đã tiếp cận
  const isLong = tracker.direction === 'LONG' || tracker.direction === 'BUY';
  if (tracker.hasApproached) {
    if (isLong) {
      // LONG: Chờ đón ở dưới, giá bật tăng ngược lên trên entry
      const bouncePct = ((currentPrice - entry) / entry) * 100;
      if (bouncePct >= BOUNCE_AWAY_PCT) {
        _trackedLimits.delete(key);
        _bounceCooldowns.set(key, Date.now() + BOUNCE_COOLDOWN_MS);
        log.warn(`[BounceCancel] ↩️ [BOUNCE CANCEL] ${sym} LONG @ ${entry}: Giá đã chạm sát mốc (min dist ${tracker.minDistancePct.toFixed(3)}%) rồi nảy lên +${bouncePct.toFixed(2)}% mà chưa fill -> HỦY LỆNH LIMIT & KHÓA MỐC 60P!`);
        return {
          shouldCancel: true,
          reason: `Bounce Cancel: Giá đã nảy +${bouncePct.toFixed(2)}% ra xa mốc sau khi tiệm cận ${tracker.minDistancePct.toFixed(3)}%`
        };
      }
    } else {
      // SHORT: Chờ đón ở trên, giá bật giảm ngược xuống dưới entry
      const bouncePct = ((entry - currentPrice) / entry) * 100;
      if (bouncePct >= BOUNCE_AWAY_PCT) {
        _trackedLimits.delete(key);
        _bounceCooldowns.set(key, Date.now() + BOUNCE_COOLDOWN_MS);
        log.warn(`[BounceCancel] ↩️ [BOUNCE CANCEL] ${sym} SHORT @ ${entry}: Giá đã chạm sát mốc (min dist ${tracker.minDistancePct.toFixed(3)}%) rồi dội xuống -${bouncePct.toFixed(2)}% mà chưa fill -> HỦY LỆNH LIMIT & KHÓA MỐC 60P!`);
        return {
          shouldCancel: true,
          reason: `Bounce Cancel: Giá đã dội -${bouncePct.toFixed(2)}% ra xa mốc sau khi tiệm cận ${tracker.minDistancePct.toFixed(3)}%`
        };
      }
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
  checkBounceCancel,
  isLevelBounceCooldown,
  getBounceCooldowns,
  clearBounceCooldowns,
  CLOSE_PROXIMITY_PCT,
  BOUNCE_AWAY_PCT
};
