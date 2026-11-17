'use strict';

/**
 * Bracket Order & Dynamic SL Ratchet Manager — Phase 4
 *
 * Nhiệm vụ:
 *   1. Dual On-Exchange Bracket:
 *      Ngay khi Entry khớp (qua WebSocket event < 50ms):
 *      - Bắn Lệnh 1: LIMIT TP (Reduce-Only) lên sổ lệnh Binance (hưởng Maker fee rẻ 60%, khớp tức thì khi râu quét).
 *      - Bắn Lệnh 2: STOP_MARKET (Hard Disaster SL) lên sàn Binance (bảo vệ thảm họa 100% nếu VPS/máy sập).
 *   2. Dynamic SL Ratchet trên sàn:
 *      - Kích hoạt Breakeven 35% TP: Hủy SL cũ, đặt STOP_MARKET mới tại Entry ± 1% phí (Risk-Free).
 *      - Kích hoạt Trailing Fractal H1/M15: Hủy SL cũ, dời STOP_MARKET bám sát đáy/đỉnh cấu trúc sóng.
 *   3. Auto-Clean đối ứng:
 *      - Khi TP cắn khớp: Tự động hủy lệnh SL Stop-Market còn lại trên sàn.
 *      - Khi SL cắn khớp: Tự động hủy lệnh TP Limit còn lại trên sàn.
 */

const { log } = require('../pp369/_logger');
const { getSymbolTickSizeSync, getSymbolStepSizeSync } = require('./binance');

const MIN_RR_RATIO = 1.48; // Chuẩn R:R tối thiểu 1.5 (cho phép sai số làm tròn 0.02)

/**
 * Tính số chữ số thập phân từ tickSize hoặc giá
 */
function getDecimalsFromPrice(price, tickSize) {
  if (typeof tickSize === 'number' && tickSize > 0) {
    return Math.max(0, Math.round(-Math.log10(tickSize)));
  }
  const str = String(price);
  if (!str.includes('.')) return 2;
  return str.split('.')[1].length;
}

/**
 * 1. Đặt cặp lệnh bảo vệ kép (Dual Bracket: Limit TP & Hard Stop-Market SL) trực tiếp lên sàn Binance.
 */
async function placeDualBracket({ client, sym, side, qty, entryPrice, targetPrice, slPrice, meta = {} }) {
  if (!client) {
    throw new Error('placeDualBracket: client không được cung cấp');
  }

  const isLong = side === 'BUY' || side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';

  // 1. Kiểm tra tỷ lệ R:R
  const tpDist = Math.abs(targetPrice - entryPrice);
  const slDist = Math.abs(entryPrice - slPrice);
  const rrRatio = slDist > 0 ? (tpDist / slDist) : 0;

  if (rrRatio < MIN_RR_RATIO) {
    log.warn(`[BracketManager] ⚠️ ${sym} R:R = ${rrRatio.toFixed(2)} < 1.5 — Không thỏa mãn chuẩn bảo vệ!`);
    return {
      success: false,
      reason: `RR_BELOW_MIN: ${rrRatio.toFixed(2)} < 1.5`,
      rrRatio,
    };
  }

  const tickSize = getSymbolTickSizeSync(sym);
  const decimals = getDecimalsFromPrice(entryPrice, tickSize);

  let tpOrderId = null;
  let slOrderId = null;

  try {
    // 2. Lệnh 1: LIMIT TP (Reduce-Only) treo sẵn trên sổ lệnh
    log.system(`[BracketManager] 🎯 Bắn LIMIT TP ${sym} ${oppositeSide} qty=${qty} @ $${targetPrice} (R:R=${rrRatio.toFixed(2)})`);
    const tpRes = await client.placeLimit(sym, oppositeSide, qty, targetPrice, decimals, true);
    tpOrderId = tpRes?.orderId || tpRes?.id || 'unknown';
    log.system(`[BracketManager] ✓ LIMIT TP đã treo thành công: orderId=${tpOrderId}`);
  } catch (err) {
    log.error(`[BracketManager] ❌ Đặt LIMIT TP ${sym} thất bại: ${err.message}`);
  }

  try {
    // 3. Lệnh 2: STOP_MARKET (Hard Disaster SL) treo trên hệ thống sàn
    log.system(`[BracketManager] 🛑 Bắn Hard STOP_MARKET SL ${sym} ${oppositeSide} @ $${slPrice}`);
    const slRes = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', slPrice);
    slOrderId = slRes?.orderId || slRes?.algoId || 'unknown';
    log.system(`[BracketManager] ✓ Hard STOP_MARKET SL đã treo thành công: orderId=${slOrderId}`);
  } catch (err) {
    log.error(`[BracketManager] ❌ Đặt Hard STOP_MARKET SL ${sym} thất bại: ${err.message}`);
  }

  // 4. Cập nhật metadata
  meta.tpOrderId = tpOrderId;
  meta.slOrderId = slOrderId;
  meta.targetTpPrice = targetPrice;
  meta.tierSlPrice = slPrice;
  meta.currentSlPrice = slPrice;
  meta.rrRatio = rrRatio;
  meta.isDualBracketActive = !!(tpOrderId && slOrderId);

  return {
    success: !!(tpOrderId || slOrderId),
    tpOrderId,
    slOrderId,
    tpPrice: targetPrice,
    slPrice: slPrice,
    rrRatio,
    isLong,
    oppositeSide,
  };
}

/**
 * 2. Dời SL lên mốc Breakeven 35% (Entry ± 1% phí) trên sàn Binance.
 */
async function ratchetBreakeven({ client, sym, meta, beSlPrice }) {
  if (!client || !meta) return { success: false, reason: 'INVALID_PARAMS' };

  if (meta.isBreakeven === true) {
    return { success: true, alreadyBreakeven: true };
  }

  const isLong = meta.side === 'BUY' || meta.side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';

  log.system(`[BracketManager] 🛡️ [Breakeven 35% TP] ${sym}: Dời SL sàn về Entry ± 1% ($${beSlPrice}) (Risk-Free)`);

  // Hủy SL cũ trên sàn
  await cancelExistingSl(client, sym, meta);

  // Đặt SL mới tại mốc Breakeven
  try {
    const slRes = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', beSlPrice);
    const newSlId = slRes?.orderId || slRes?.algoId || 'unknown';

    meta.isBreakeven = true;
    meta.currentSlPrice = beSlPrice;
    meta.slOrderId = newSlId;
    log.system(`[BracketManager] ✓ Đã dời SL Breakeven ${sym} thành công: orderId=${newSlId} @ $${beSlPrice}`);

    return { success: true, newSlOrderId: newSlId, beSlPrice };
  } catch (err) {
    log.error(`[BracketManager] ❌ Dời SL Breakeven ${sym} thất bại: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 3. Dời SL theo Williams Fractal H1/M15 (Bám sát sóng).
 */
async function ratchetTrailingFractal({ client, sym, meta, newFractalSlPrice, timeframe = 'H1' }) {
  if (!client || !meta) return { success: false, reason: 'INVALID_PARAMS' };

  const isLong = meta.side === 'BUY' || meta.side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';
  const currentSl = meta.currentSlPrice || meta.tierSlPrice;

  // Kiểm tra: SL mới phải có lợi hơn SL hiện tại
  if (currentSl) {
    if (isLong && newFractalSlPrice <= currentSl) {
      return { success: false, reason: 'SL_NOT_IMPROVED_LONG' };
    }
    if (!isLong && newFractalSlPrice >= currentSl) {
      return { success: false, reason: 'SL_NOT_IMPROVED_SHORT' };
    }
  }

  log.system(`[BracketManager] 🌊 [Fractal ${timeframe} Trailing SL] ${sym}: Dời SL sàn từ $${currentSl} -> $${newFractalSlPrice}`);

  // Hủy SL cũ
  await cancelExistingSl(client, sym, meta);

  // Đặt SL Fractal mới
  try {
    const slRes = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', newFractalSlPrice);
    const newSlId = slRes?.orderId || slRes?.algoId || 'unknown';

    meta.currentSlPrice = newFractalSlPrice;
    meta.slOrderId = newSlId;
    meta.fractalTf = timeframe;
    log.system(`[BracketManager] ✓ Đã dời SL Fractal ${timeframe} cho ${sym}: orderId=${newSlId} @ $${newFractalSlPrice}`);

    return { success: true, newSlOrderId: newSlId, newSlPrice: newFractalSlPrice, timeframe };
  } catch (err) {
    log.error(`[BracketManager] ❌ Dời SL Fractal ${sym} thất bại: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 4. Tự động dọn sạch lệnh đối ứng (Auto-Clean) khi TP hoặc SL khớp.
 */
async function autoCleanOppositeOrder({ client, sym, filledType, meta = {} }) {
  if (!client) return { cleaned: false };

  log.system(`[BracketManager] 🧹 Auto-Clean cho ${sym} (Sự kiện: ${filledType} khớp)`);

  let cancelledSL = false;
  let cancelledTP = false;

  if (filledType === 'TP') {
    // TP đã khớp -> Hủy SL Stop-Market còn lại trên sàn
    if (meta.slOrderId) {
      try {
        await client.cancelAlgoOrder(sym, meta.slOrderId);
        cancelledSL = true;
      } catch {
        try {
          await client.cancelOrder(sym, meta.slOrderId);
          cancelledSL = true;
        } catch { /* ignored */ }
      }
    }
    // Dọn các lệnh Algo STOP_MARKET còn sót
    try {
      const algos = await client.getOpenAlgoOrders(sym);
      for (const a of (algos || [])) {
        await client.cancelAlgoOrder(sym, a.algoId || a.orderId).catch(() => {});
        cancelledSL = true;
      }
    } catch { /* ignored */ }

    meta.slOrderId = null;
    meta.isClosed = true;
    return { cleaned: true, cancelledSL };
  }

  if (filledType === 'SL') {
    // SL đã khớp -> Hủy LIMIT TP còn lại trên sàn
    if (meta.tpOrderId) {
      try {
        await client.cancelOrder(sym, meta.tpOrderId);
        cancelledTP = true;
      } catch { /* ignored */ }
    }
    // Dọn các lệnh LIMIT còn sót
    try {
      await client.cancelAllOpenOrders(sym);
      cancelledTP = true;
    } catch { /* ignored */ }

    meta.tpOrderId = null;
    meta.isClosed = true;
    return { cleaned: true, cancelledTP };
  }

  // Trường hợp đóng thủ công hoặc thoát lệnh khẩn cấp -> Hủy toàn bộ cả LIMIT lẫn Algo
  try {
    await client.cancelAllOpenOrders(sym).catch(() => {});
    const algos = await client.getOpenAlgoOrders(sym).catch(() => []);
    for (const a of (algos || [])) {
      await client.cancelAlgoOrder(sym, a.algoId || a.orderId).catch(() => {});
    }
    meta.tpOrderId = null;
    meta.slOrderId = null;
    meta.isClosed = true;
    return { cleaned: true, cancelledAll: true };
  } catch (err) {
    return { cleaned: false, error: err.message };
  }
}

/**
 * Helper hủy SL cũ (thường hoặc algo)
 */
async function cancelExistingSl(client, sym, meta) {
  if (meta?.slOrderId) {
    try {
      await client.cancelAlgoOrder(sym, meta.slOrderId);
    } catch {
      try { await client.cancelOrder(sym, meta.slOrderId); } catch { /* ignored */ }
    }
  }

  // Quét dọn thêm các lệnh Algo STOP_MARKET treo trùng
  try {
    const algos = await client.getOpenAlgoOrders(sym);
    if (Array.isArray(algos)) {
      for (const a of algos) {
        const oType = a.type || a.orderType;
        if (oType === 'STOP_MARKET' || oType === 'STOP') {
          await client.cancelAlgoOrder(sym, a.algoId || a.orderId).catch(() => {});
        }
      }
    }
  } catch { /* ignored */ }
}

module.exports = {
  placeDualBracket,
  ratchetBreakeven,
  ratchetTrailingFractal,
  autoCleanOppositeOrder,
  MIN_RR_RATIO,
};
