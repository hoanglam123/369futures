'use strict';

/**
 * Bracket Order & Dynamic SL Ratchet Manager — bot_new Phase 1
 *
 * Nhiệm vụ:
 *   1. Dual On-Exchange Bracket:
 *      Ngay khi Entry khớp (qua WebSocket event < 50ms hoặc Polling):
 *      - Bắn Lệnh 1: LIMIT TP (Reduce-Only) lên sổ lệnh Binance.
 *      - Bắn Lệnh 2: Hard STOP_MARKET SL (closePosition: true via algoOrder) lên sàn Binance.
 *   2. Dynamic SL Ratchet trên sàn:
 *      - Kích hoạt Breakeven khi chạm TP1 (+10% vốn): Hủy SL cũ, đặt STOP_MARKET mới tại Entry ± 1% phí (Risk-Free).
 *      - Kích hoạt Trailing SL: Hủy SL cũ, dời STOP_MARKET bám sát sóng.
 *   3. Auto-Clean đối ứng:
 *      - Khi TP cắn khớp: Tự động hủy lệnh SL Stop-Market còn lại trên sàn.
 *      - Khi SL cắn khớp: Tự động hủy lệnh TP Limit còn lại trên sàn.
 */

const { log } = require('./logger');
const binanceTrader = require('./binanceTrader');

const MIN_RR_RATIO = 1.48; // Chuẩn R:R tối thiểu 1.5 (cho phép sai số làm tròn 0.02)

const NON_RETRYABLE_ERR_RE = /would immediately trigger|ReduceOnly Order is rejected|insufficient|Invalid|precision|margin|min notional|UNKNOWN_ORDER|Order does not exist/i;

/**
 * Exponential Backoff Retry cho các lệnh bảo vệ vị thế trên sàn (1s -> 2s).
 * Không retry các lỗi logic tất định từ Binance (như -2021 immediately trigger) để phản ứng tức thì.
 */
async function withRetryBackoff(fn, { maxRetries = 2, baseDelayMs = 1000, label = 'BinanceOrder' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      if (attempt >= maxRetries || NON_RETRYABLE_ERR_RE.test(msg)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s
      log.warn(`[BracketManager] ⏳ ${label} lỗi tạm thời (${msg}) — thử lại lần ${attempt + 1}/${maxRetries} sau ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * 1. Đặt cặp lệnh bảo vệ kép (Dual Bracket: Limit TP & Hard Stop-Market SL) trực tiếp lên sàn Binance.
 */
async function placeDualBracket({ client = binanceTrader, sym, side, qty, entryPrice, targetPrice, slPrice, meta = {}, retryDelayMs = 1000 }) {
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

  let tpOrderId = null;
  let slOrderId = null;

  try {
    // 2. Lệnh 1: LIMIT TP (Reduce-Only) treo sẵn trên sổ lệnh (có Exponential Backoff Retry 1s/2s)
    log.trade(`[BracketManager] 🎯 Bắn LIMIT TP ${sym} ${oppositeSide} qty=${qty} @ $${targetPrice} (R:R=${rrRatio.toFixed(2)})`);
    const tpRes = await withRetryBackoff(
      async () => {
        const res = await client.placeTPAfterEntry({
          symbol: sym,
          direction: isLong ? 'LONG' : 'SHORT',
          targetPrice,
          binanceQty: qty,
          binanceEntryOrderId: meta.binanceEntryOrderId || 'bracket_entry',
        });
        const id = (res && typeof res === 'object') ? (res.orderId || res.id) : res;
        if (!id) throw new Error('placeTPAfterEntry returned empty orderId');
        return String(id);
      },
      { maxRetries: 2, baseDelayMs: retryDelayMs, label: `LIMIT TP ${sym}` }
    );
    tpOrderId = tpRes;
    log.trade(`[BracketManager] ✓ LIMIT TP đã treo thành công: orderId=${tpOrderId}`);
  } catch (err) {
    log.error(`[BracketManager] ❌ Đặt LIMIT TP ${sym} thất bại: ${err.message}`);
  }

  try {
    // 3. Lệnh 2: STOP_MARKET (Hard Disaster SL) treo trên hệ thống sàn (có Exponential Backoff Retry 1s/2s)
    log.trade(`[BracketManager] 🛑 Bắn Hard STOP_MARKET SL ${sym} ${oppositeSide} @ $${slPrice}`);
    const slRes = await withRetryBackoff(
      async () => {
        const res = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', slPrice);
        const id = res?.algoId ?? res?.orderId ?? null;
        if (!id) throw new Error('placeStopOrder returned empty algoId/orderId');
        return String(id);
      },
      { maxRetries: 2, baseDelayMs: retryDelayMs, label: `Hard SL ${sym}` }
    );
    slOrderId = slRes;
    log.trade(`[BracketManager] ✓ Hard STOP_MARKET SL đã treo thành công: orderId=${slOrderId}`);
  } catch (err) {
    log.error(`[BracketManager] ❌ Đặt Hard STOP_MARKET SL ${sym} thất bại: ${err.message}`);
  }

  // 4. Cập nhật metadata (chỉ ghi đè ID khi đặt thành công, không ghi đè 'unknown' hay undefined)
  if (tpOrderId) meta.binanceTpOrderId = tpOrderId;
  if (slOrderId) meta.binanceSlOrderId = slOrderId;
  meta.targetPrice = targetPrice;
  meta.slPrice = slPrice;
  meta.currentSlPrice = slPrice;
  meta.rrRatio = rrRatio;
  meta.isDualBracketActive = Boolean(meta.binanceTpOrderId && meta.binanceSlOrderId);

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
 * Lấy mức SL bảo vệ chặt nhất hiện tại (so sánh slPrice, currentSlPrice, fractalSlPrice)
 */
function getTightestCurrentSl(meta, isLong) {
  const vals = [meta?.slPrice, meta?.currentSlPrice, meta?.fractalSlPrice]
    .filter(v => typeof v === 'number' && v > 0 && !isNaN(v));
  if (vals.length === 0) return null;
  return isLong ? Math.max(...vals) : Math.min(...vals);
}

/**
 * 2. Dời SL lên mốc Breakeven (+1% phí) trên sàn Binance khi đạt 35% TP.
 * Bảo vệ vị thế: chốt chặn 1 chiều (không kéo lùi SL), kiểm tra giá hiện tại để tránh -2021,
 * có retry backoff và tự khôi phục SL cũ nếu đặt SL mới thất bại.
 */
async function ratchetBreakeven({ client = binanceTrader, sym, meta, beSlPrice, currentPrice = null, retryDelayMs = 1000 }) {
  if (!client || !meta || typeof beSlPrice !== 'number' || !isFinite(beSlPrice) || beSlPrice <= 0) {
    return { success: false, reason: 'INVALID_PARAMS' };
  }

  if (meta.slMovedToBreakeven === true) {
    return { success: true, alreadyBreakeven: true };
  }

  const isLong = meta.direction === 'LONG' || meta.side === 'BUY' || meta.side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';
  const prevSl = getTightestCurrentSl(meta, isLong);

  // Chốt chặn 1 chiều (One-way ratchet): tuyệt đối không kéo SL đi lùi so với SL hiện tại (VD Fractal SL đã tốt hơn BE)
  if (prevSl != null) {
    if (isLong && beSlPrice <= prevSl) {
      meta.slMovedToBreakeven = true;
      return { success: true, alreadyBetterSl: true, currentSl: prevSl };
    }
    if (!isLong && beSlPrice >= prevSl) {
      meta.slMovedToBreakeven = true;
      return { success: true, alreadyBetterSl: true, currentSl: prevSl };
    }
  }

  // Chốt chặn: SL mới không được vượt qua giá hiện tại (gây "Order would immediately trigger")
  if (currentPrice && currentPrice > 0) {
    if (isLong && beSlPrice >= currentPrice * 0.999) {
      log.warn(`[BracketManager] ⚠️ Bỏ qua Breakeven SL ${sym} LONG: SL mới $${beSlPrice} >= giá hiện tại $${currentPrice} — giữ nguyên SL cũ $${prevSl}`);
      return { success: false, reason: 'WOULD_IMMEDIATELY_TRIGGER' };
    }
    if (!isLong && beSlPrice <= currentPrice * 1.001) {
      log.warn(`[BracketManager] ⚠️ Bỏ qua Breakeven SL ${sym} SHORT: SL mới $${beSlPrice} <= giá hiện tại $${currentPrice} — giữ nguyên SL cũ $${prevSl}`);
      return { success: false, reason: 'WOULD_IMMEDIATELY_TRIGGER' };
    }
  }

  log.trade(`[BracketManager] 🛡️ [Breakeven SL] ${sym}: Dời SL sàn về Entry ± 1% ($${beSlPrice}) (Risk-Free)`);

  // Hủy SL cũ trên sàn
  await cancelExistingSl(client, sym, meta);

  // Đặt SL mới tại mốc Breakeven (Exponential Backoff Retry 1s/2s)
  try {
    const slRes = await withRetryBackoff(
      () => client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', beSlPrice),
      { maxRetries: 2, baseDelayMs: retryDelayMs, label: `Breakeven SL ${sym}` }
    );
    const rawId = slRes?.algoId ?? slRes?.orderId ?? null;
    if (!rawId) throw new Error('placeStopOrder returned empty algoId/orderId');
    const newSlId = String(rawId);

    meta.slMovedToBreakeven = true;
    meta.currentSlPrice = beSlPrice;
    meta.slPrice = beSlPrice;
    meta.binanceSlOrderId = newSlId;
    log.trade(`[BracketManager] ✓ Đã dời SL Breakeven ${sym} thành công: orderId=${newSlId} @ $${beSlPrice}`);

    return { success: true, newSlOrderId: newSlId, beSlPrice };
  } catch (err) {
    log.error(`[BracketManager] ❌ Dời SL Breakeven ${sym} thất bại: ${err.message}`);
    meta.binanceSlOrderId = null;
    // Khôi phục lại SL cũ để vị thế KHÔNG BAO GIỜ bị trần trên sàn
    if (prevSl && prevSl !== beSlPrice) {
      try {
        const restoreRes = await withRetryBackoff(
          () => client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', prevSl),
          { maxRetries: 2, baseDelayMs: retryDelayMs, label: `Restore SL ${sym}` }
        );
        const rId = restoreRes?.algoId ?? restoreRes?.orderId ?? null;
        if (rId) meta.binanceSlOrderId = String(rId);
        log.warn(`[BracketManager] ♻️ Đã khôi phục SL cũ cho ${sym} @ $${prevSl}`);
      } catch (reErr) {
        log.error(`[BracketManager] ❌ Khôi phục SL cũ ${sym} cũng thất bại: ${reErr.message}`);
      }
    }
    return { success: false, error: err.message };
  }
}

/**
 * 3. Dời SL theo Trailing Stop (Bám sát sóng Williams Fractal H1/M15).
 * Bảo vệ vị thế: kiểm tra 1 chiều & giá hiện tại trước khi hủy SL cũ, có retry backoff và khôi phục SL cũ nếu đặt mới lỗi.
 */
async function ratchetTrailingFractal({ client = binanceTrader, sym, meta, newTrailingSlPrice, label = 'Trailing', currentPrice = null, retryDelayMs = 1000 }) {
  if (!client || !meta) return { success: false, reason: 'INVALID_PARAMS' };

  const isLong = meta.direction === 'LONG' || meta.side === 'BUY' || meta.side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';
  const currentSl = getTightestCurrentSl(meta, isLong);

  // Kiểm tra: SL mới phải có lợi hơn SL hiện tại
  if (currentSl != null) {
    if (isLong && newTrailingSlPrice <= currentSl) {
      return { success: false, reason: 'SL_NOT_IMPROVED_LONG' };
    }
    if (!isLong && newTrailingSlPrice >= currentSl) {
      return { success: false, reason: 'SL_NOT_IMPROVED_SHORT' };
    }
  }

  // Chốt chặn: SL mới bắt buộc phải nằm an toàn dưới giá hiện tại (LONG) hoặc trên giá hiện tại (SHORT)
  if (currentPrice && currentPrice > 0) {
    if (isLong && newTrailingSlPrice >= currentPrice * 0.999) {
      log.warn(`[BracketManager] ⚠️ Bỏ qua ${label} SL ${sym} LONG: SL mới $${newTrailingSlPrice} >= giá hiện tại $${currentPrice} — giữ nguyên SL cũ $${currentSl}`);
      return { success: false, reason: 'WOULD_IMMEDIATELY_TRIGGER' };
    }
    if (!isLong && newTrailingSlPrice <= currentPrice * 1.001) {
      log.warn(`[BracketManager] ⚠️ Bỏ qua ${label} SL ${sym} SHORT: SL mới $${newTrailingSlPrice} <= giá hiện tại $${currentPrice} — giữ nguyên SL cũ $${currentSl}`);
      return { success: false, reason: 'WOULD_IMMEDIATELY_TRIGGER' };
    }
  }

  log.trade(`[BracketManager] 🌊 [${label} SL] ${sym}: Dời SL sàn từ $${currentSl} -> $${newTrailingSlPrice}`);

  // Hủy SL cũ
  await cancelExistingSl(client, sym, meta);

  // Đặt SL mới (Exponential Backoff Retry 1s/2s)
  try {
    const slRes = await withRetryBackoff(
      () => client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', newTrailingSlPrice),
      { maxRetries: 2, baseDelayMs: retryDelayMs, label: `${label} SL ${sym}` }
    );
    const rawId = slRes?.algoId ?? slRes?.orderId ?? null;
    if (!rawId) throw new Error('placeStopOrder returned empty algoId/orderId');
    const newSlId = String(rawId);

    meta.currentSlPrice = newTrailingSlPrice;
    meta.slPrice = newTrailingSlPrice;
    meta.binanceSlOrderId = newSlId;
    log.trade(`[BracketManager] ✓ Đã dời ${label} SL cho ${sym}: orderId=${newSlId} @ $${newTrailingSlPrice}`);

    return { success: true, newSlOrderId: newSlId, newSlPrice: newTrailingSlPrice };
  } catch (err) {
    log.error(`[BracketManager] ❌ Dời ${label} SL ${sym} thất bại: ${err.message}`);
    meta.binanceSlOrderId = null;
    // Khôi phục lại SL cũ ngay lập tức để vị thế không bao giờ bị trống SL
    if (currentSl && currentSl !== newTrailingSlPrice) {
      try {
        const restoreRes = await withRetryBackoff(
          () => client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', currentSl),
          { maxRetries: 2, baseDelayMs: retryDelayMs, label: `Restore SL ${sym}` }
        );
        const rId = restoreRes?.algoId ?? restoreRes?.orderId ?? null;
        if (rId) meta.binanceSlOrderId = String(rId);
        log.warn(`[BracketManager] ♻️ Đã khôi phục SL cũ cho ${sym} @ $${currentSl}`);
      } catch (reErr) {
        log.error(`[BracketManager] ❌ Khôi phục SL cũ ${sym} cũng thất bại: ${reErr.message}`);
      }
    }
    return { success: false, error: err.message };
  }
}

/**
 * 3b. Thay thế SL thông thường (không gắn cờ slMovedToBreakeven, có rollback về SL cũ nếu lỗi).
 */
async function replaceSLOrder({ client = binanceTrader, sym, meta, newSlPrice, currentPrice = null, retryDelayMs = 1000 }) {
  if (!client || !meta || !newSlPrice) return { success: false, reason: 'INVALID_PARAMS' };
  const isLong = meta.direction === 'LONG' || meta.side === 'BUY' || meta.side === 'LONG';
  const oppositeSide = isLong ? 'SELL' : 'BUY';
  const prevSl = meta.currentSlPrice || meta.slPrice;

  if (currentPrice && currentPrice > 0) {
    if ((isLong && newSlPrice >= currentPrice * 0.999) || (!isLong && newSlPrice <= currentPrice * 1.001)) {
      return { success: false, reason: 'WOULD_IMMEDIATELY_TRIGGER' };
    }
  }

  await cancelExistingSl(client, sym, meta);
  try {
    const slRes = await withRetryBackoff(
      () => client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', newSlPrice),
      { maxRetries: 2, baseDelayMs: retryDelayMs, label: `Replace SL ${sym}` }
    );
    const rawId = slRes?.algoId ?? slRes?.orderId ?? null;
    if (!rawId) throw new Error('placeStopOrder returned empty algoId/orderId');
    meta.binanceSlOrderId = String(rawId);
    meta.slPrice = newSlPrice;
    meta.currentSlPrice = newSlPrice;
    return { success: true, newSlOrderId: meta.binanceSlOrderId, newSlPrice };
  } catch (err) {
    log.error(`[BracketManager] ❌ Thay SL ${sym} thất bại: ${err.message}`);
    meta.binanceSlOrderId = null;
    if (prevSl && prevSl !== newSlPrice) {
      try {
        const restoreRes = await client.placeStopOrder(sym, oppositeSide, 'STOP_MARKET', prevSl);
        const rId = restoreRes?.algoId ?? restoreRes?.orderId ?? null;
        if (rId) meta.binanceSlOrderId = String(rId);
        log.warn(`[BracketManager] ♻️ Đã khôi phục SL cũ cho ${sym} @ $${prevSl}`);
      } catch (reErr) {
        log.error(`[BracketManager] ❌ Khôi phục SL cũ ${sym} cũng thất bại: ${reErr.message}`);
      }
    }
    return { success: false, error: err.message };
  }
}

/**
 * 4. Tự động dọn sạch lệnh đối ứng (Auto-Clean) khi TP hoặc SL khớp.
 */
async function autoCleanOppositeOrder({ client = binanceTrader, sym, filledType, meta = {} }) {
  if (!client) return { cleaned: false };

  log.trade(`[BracketManager] 🧹 Auto-Clean cho ${sym} (Sự kiện: ${filledType} khớp)`);

  let cancelledSL = false;
  let cancelledTP = false;

  if (filledType === 'TP') {
    // TP đã khớp -> Hủy SL Stop-Market còn lại trên sàn
    if (meta.binanceSlOrderId) {
      try {
        await client.cancelAlgoOrder(sym, meta.binanceSlOrderId);
        cancelledSL = true;
      } catch {
        try {
          await client.cancelOrderById(sym, meta.binanceSlOrderId);
          cancelledSL = true;
        } catch { /* ignored */ }
      }
    }
    // Dọn các lệnh Algo STOP_MARKET còn sót của symbol
    try {
      const algos = await client.getOpenAlgoOrders(sym);
      for (const a of (algos || [])) {
        await client.cancelAlgoOrder(sym, a.algoId || a.orderId).catch(() => {});
        cancelledSL = true;
      }
    } catch { /* ignored */ }

    meta.binanceSlOrderId = null;
    meta.isClosed = true;
    return { cleaned: true, cancelledSL };
  }

  if (filledType === 'SL') {
    // SL đã khớp -> Hủy LIMIT TP còn lại trên sàn
    if (meta.binanceTpOrderId) {
      try {
        await client.cancelOrderById(sym, meta.binanceTpOrderId);
        cancelledTP = true;
      } catch { /* ignored */ }
    }
    meta.binanceTpOrderId = null;
    meta.isClosed = true;
    return { cleaned: true, cancelledTP };
  }

  // Trường hợp đóng thủ công hoặc thoát lệnh khẩn cấp -> Hủy cả LIMIT lẫn Algo
  try {
    if (meta.binanceTpOrderId) {
      await client.cancelOrderById(sym, meta.binanceTpOrderId).catch(() => {});
    }
    if (meta.binanceSlOrderId) {
      await client.cancelAlgoOrder(sym, meta.binanceSlOrderId).catch(() => {});
    }
    const algos = await client.getOpenAlgoOrders(sym).catch(() => []);
    for (const a of (algos || [])) {
      await client.cancelAlgoOrder(sym, a.algoId || a.orderId).catch(() => {});
    }
    meta.binanceTpOrderId = null;
    meta.binanceSlOrderId = null;
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
  if (meta?.binanceSlOrderId) {
    try {
      await client.cancelAlgoOrder(sym, meta.binanceSlOrderId);
    } catch {
      try { await client.cancelOrderById(sym, meta.binanceSlOrderId); } catch { /* ignored */ }
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
  replaceSLOrder,
  autoCleanOppositeOrder,
  getTightestCurrentSl,
  withRetryBackoff,
  MIN_RR_RATIO,
};
