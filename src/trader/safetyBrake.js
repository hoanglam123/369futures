'use strict';

/**
 * Safety Brake & Reverse Check Engine — Phase 4
 *
 * 1. Reverse Check (Chu kỳ 60s):
 *    - Quét đối chiếu vị thế giữa bộ nhớ local và sàn Binance REST API.
 *    - Phát hiện trường hợp lệnh đã đóng trên sàn do rớt mạng hoặc miss WebSocket event.
 *
 * 2. Safety Brake (Cầu chì chống đóng lệnh ảo):
 *    - Chặn đứng thảm họa mass-close khi sàn Binance bị lỗi tạm thời trả về danh sách rỗng hoặc tụt vị thế đột ngột.
 *    - Scenario A: Binance trả về 0 positions nhưng bot đang theo dõi >= 1 lệnh filled.
 *    - Scenario B: Đang theo dõi >= 3 lệnh, nhưng >= 60% lệnh bị báo biến mất cùng lúc.
 *    - Khi kích hoạt: KHÔNG đóng lệnh nào, KHÔNG xóa database, bắn cảnh báo đỏ Telegram.
 *    - Mở khóa: Chỉ cho phép ghi đè khi gọi overrideSafetyBrake() hoặc người dùng gõ /forcesync.
 */

const { log } = require('../pp369/_logger');
const { sendTelegram } = require('../pp369/telegram');

const MASS_CLOSE_PERCENT_THRESHOLD = 0.60; // 60%
const MIN_TRADES_FOR_PERCENT_BRAKE = 3;
const BRAKE_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // Tối đa 1 cảnh báo Telegram mỗi 5 phút

let _isBrakeActive = false;
let _lastBrakeReason = '';
let _lastBrakeTriggeredAt = 0;
let _lastAlertSentAt = 0;
let _forceSyncOverride = false;

/**
 * Đánh giá điều kiện an toàn trước khi cho phép đóng lệnh hàng loạt
 */
function evaluateSafetyBrake({ eligibleTradesCount, exchangePositionsCount, wouldCloseCount }) {
  // Nếu người dùng đã xác nhận /forcesync -> cho phép bypass 1 lần
  if (_forceSyncOverride) {
    _forceSyncOverride = false;
    _isBrakeActive = false;
    log.system('[SafetyBrake] 🔓 Override kích hoạt: Cho phép đồng bộ theo lệnh /forcesync của người dùng.');
    return { tripped: false, bypassed: true };
  }

  // Scenario A: Sàn trả về 0 vị thế nhưng bot đang theo dõi >= 2 lệnh đã khớp
  // (Yêu cầu >= 2 lệnh để tránh khóa cứng bot khi chỉ có 1 lệnh đơn đóng SL/TP bình thường mà miss WS)
  const massCloseA = eligibleTradesCount >= 2 && exchangePositionsCount === 0;

  // Scenario B: >= 3 lệnh đang chạy, nhưng >= 60% lệnh sắp bị đóng đồng thời
  const massCloseB = eligibleTradesCount >= MIN_TRADES_FOR_PERCENT_BRAKE &&
                     wouldCloseCount >= Math.ceil(eligibleTradesCount * MASS_CLOSE_PERCENT_THRESHOLD);

  if (massCloseA || massCloseB) {
    const now = Date.now();
    _isBrakeActive = true;
    _lastBrakeTriggeredAt = now;
    _lastBrakeReason = massCloseA
      ? `Binance trả về 0 positions nhưng bot đang theo dõi ${eligibleTradesCount} lệnh filled`
      : `${wouldCloseCount}/${eligibleTradesCount} lệnh (${Math.round(wouldCloseCount / eligibleTradesCount * 100)}%) sẽ bị đóng cùng lúc`;

    log.error(`[SafetyBrake] 🚨 SAFETY BRAKE KÍCH HOẠT — ${_lastBrakeReason} — KHÔNG ĐÓNG LỆNH NÀO`);

    // Gửi cảnh báo đỏ Telegram (throttle mỗi 5 phút để chống spam mỗi 6s)
    if (now - _lastAlertSentAt >= BRAKE_ALERT_COOLDOWN_MS) {
      _lastAlertSentAt = now;
      sendTelegram(
        `🚨 <b>SAFETY BRAKE — Ngừng Đóng Lệnh Tự Động!</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<b>Nguyên nhân:</b> ${_lastBrakeReason}\n\n` +
        `⚠️ Có thể do Binance API tạm thời nghẽn hoặc mất kết nối REST.\n` +
        `Bot <b>bảo lưu 100% vị thế trong bộ nhớ</b> và không xóa database.\n\n` +
        `<i>Gõ <code>/forcesync</code> trên Telegram hoặc console nếu bạn đã kiểm tra sàn và muốn đồng bộ thật.</i>`
      ).catch(() => {});
    }

    return { tripped: true, reason: _lastBrakeReason };
  }

  return { tripped: false };
}

/**
 * Kích hoạt mở khóa thủ công qua lệnh /forcesync
 */
function overrideSafetyBrake() {
  _forceSyncOverride = true;
  _isBrakeActive = false;
  log.system('[SafetyBrake] ⚡ Đã tiếp nhận yêu cầu /forcesync — Sẽ bypass Safety Brake ở chu kỳ đối chiếu tiếp theo.');
  return { success: true, message: 'Safety brake override queued for next sync cycle' };
}

/**
 * Trả về trạng thái hiện tại của Safety Brake
 */
function isSafetyBrakeActive() {
  return _isBrakeActive;
}

/**
 * Trả về thông tin chi tiết lần kích hoạt gần nhất
 */
function getLastBrakeInfo() {
  return {
    active: _isBrakeActive,
    reason: _lastBrakeReason,
    time: _lastBrakeTriggeredAt,
  };
}

/**
 * Reset hoàn toàn trạng thái Safety Brake (phục vụ test)
 */
function resetSafetyBrake() {
  _isBrakeActive = false;
  _lastBrakeReason = '';
  _lastBrakeTriggeredAt = 0;
  _forceSyncOverride = false;
}

/**
 * Tiến hành chu kỳ Reverse Check 60s đối chiếu vị thế giữa REST và local cache
 */
async function runReverseCheck({
  client,
  activeTradesMetadata = {},
  lastActivePositions = new Map(),
  onPositionClosedMissingWs = null,
}) {
  if (!client || typeof client.getOpenPositions !== 'function') {
    return { success: false, reason: 'CLIENT_NOT_AVAILABLE' };
  }

  try {
    const rawPositions = await client.getOpenPositions();
    const positions = (rawPositions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    const openPosSet = new Set(
      positions.map(p => `${p.symbol.replace(/USDT$/, '')}_${parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'}`)
    );

    // Lọc các lệnh đang theo dõi đã khớp (eligible trades)
    const eligibleTrades = Object.entries(activeTradesMetadata)
      .filter(([sym, meta]) => meta && meta.isFilled === true && !meta.isClosed)
      .map(([sym, meta]) => ({
        sym,
        side: meta.side === 'BUY' || meta.side === 'LONG' ? 'LONG' : 'SHORT',
        meta,
      }));

    // Các lệnh không còn thấy trên sàn
    const wouldClose = eligibleTrades.filter(
      t => !openPosSet.has(`${t.sym}_${t.side}`)
    );

    // ── KIỂM TRA SAFETY BRAKE ──
    const brakeCheck = evaluateSafetyBrake({
      eligibleTradesCount: eligibleTrades.length,
      exchangePositionsCount: positions.length,
      wouldCloseCount: wouldClose.length,
    });

    if (brakeCheck.tripped) {
      return {
        success: false,
        brakeTripped: true,
        reason: brakeCheck.reason,
      };
    }

    // Nếu an toàn -> xử lý các vị thế đã đóng mà miss WebSocket
    let reconciledCount = 0;
    for (const item of wouldClose) {
      log.warn(`[ReverseCheck] ⚠️ Phát hiện ${item.sym} (${item.side}) không còn vị thế trên Binance — Đối chiếu đóng lệnh`);
      if (typeof onPositionClosedMissingWs === 'function') {
        try {
          await onPositionClosedMissingWs(item.sym, item.meta);
          reconciledCount++;
        } catch (err) {
          log.error(`[ReverseCheck] Lỗi xử lý đóng lệnh ${item.sym}: ${err.message}`);
        }
      }
    }

    return {
      success: true,
      eligibleCount: eligibleTrades.length,
      exchangeCount: positions.length,
      wouldCloseCount: wouldClose.length,
      reconciledCount,
    };
  } catch (err) {
    log.warn(`[ReverseCheck] Lỗi trong chu kỳ quét: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  evaluateSafetyBrake,
  overrideSafetyBrake,
  isSafetyBrakeActive,
  getLastBrakeInfo,
  resetSafetyBrake,
  runReverseCheck,
  MASS_CLOSE_PERCENT_THRESHOLD,
  MIN_TRADES_FOR_PERCENT_BRAKE,
};
