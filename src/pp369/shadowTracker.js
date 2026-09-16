// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SHADOW_POSITIONS_FILE = path.join(DATA_DIR, 'shadow_positions.json');
const SHADOW_HISTORY_FILE = path.join(DATA_DIR, 'shadow_trades_history.jsonl');
const DATASET_FILE = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');

let _logger = {
  info: (...a) => console.log('[ShadowTracker]', ...a),
  warn: (...a) => console.warn('[ShadowTracker]', ...a),
  error: (...a) => console.error('[ShadowTracker]', ...a),
  system: (...a) => console.log('[ShadowTracker]', ...a),
};

function setLogger(logger) {
  _logger = logger;
}

// In-memory active shadow positions: { [shadowId]: ShadowPosition }
let activeShadowPositions = {};

/**
 * Load active shadow positions from disk
 */
function loadActiveShadowPositions() {
  try {
    if (fs.existsSync(SHADOW_POSITIONS_FILE)) {
      const data = fs.readFileSync(SHADOW_POSITIONS_FILE, 'utf8');
      activeShadowPositions = JSON.parse(data || '{}');
      const count = Object.keys(activeShadowPositions).length;
      if (count > 0) {
        _logger.info(`Đã khôi phục ${count} vị thế Shadow PnL đang theo dõi từ ${SHADOW_POSITIONS_FILE}`);
      }
    }
  } catch (e) {
    _logger.warn(`Lỗi nạp ${SHADOW_POSITIONS_FILE}: ${e.message}`);
    activeShadowPositions = {};
  }
}

/**
 * Save active shadow positions to disk
 */
function saveActiveShadowPositions() {
  try {
    fs.writeFileSync(SHADOW_POSITIONS_FILE, JSON.stringify(activeShadowPositions, null, 2), 'utf8');
  } catch (e) {
    _logger.error(`Lỗi lưu ${SHADOW_POSITIONS_FILE}: ${e.message}`);
  }
}

/**
 * Append record to shadow history JSONL
 */
function _appendShadowHistory(record) {
  try {
    fs.appendFileSync(SHADOW_HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    _logger.error(`Lỗi ghi ${SHADOW_HISTORY_FILE}: ${e.message}`);
  }
}

/**
 * Append to ai_trade_dataset.jsonl for AI retraining
 */
function _appendDatasetRecord(record) {
  try {
    fs.appendFileSync(DATASET_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    _logger.error(`Lỗi ghi record vào ${DATASET_FILE}: ${e.message}`);
  }
}

/**
 * Register a vetoed signal as a shadow trade
 *
 * @param {any} sig - Signal object from autoTrade / PP369
 * @param {any} [evalResult] - Evaluation result from evaluateSignalWithAI()
 * @param {any} [options]
 */
function registerShadowTrade(sig, evalResult, options = {}) {
  if (!sig || !sig.symbol || !sig.signal) return null;

  const sym = String(sig.symbol).replace(/USDT$/i, '').toUpperCase();
  const side = sig.signal.toUpperCase(); // 'LONG' | 'SHORT'
  const isLong = side === 'LONG';
  const entryPrice = parseFloat(sig.targetLevel || sig.price || sig.entryPrice || sig.markPrice || options.markPrice || options.entryPrice || 0);

  if (!entryPrice || entryPrice <= 0) {
    _logger.warn(`registerShadowTrade: ${sym} không có entryPrice hợp lệ (${entryPrice})`);
    return null;
  }

  // 🛡️ DEDUPLICATION: Không tạo vị thế Shadow trùng lặp nếu vị thế trước đó của cùng coin/cùng chiều vẫn đang chạy (hoặc chưa quá 90 phút)
  const existing = Object.values(activeShadowPositions).find(p => p.symbol === sym && p.signal === side);
  if (existing && (Date.now() - existing.entryTimestamp) < 90 * 60 * 1000) {
    return existing; // Don't duplicate active shadow position
  }

  // Calculate SL / TP distances
  const gridWidthPct = parseFloat(sig.gridWidthPct || options.gridWidthPct || 4.0);
  const coinRank = parseInt(sig.marketCapRank || options.marketCapRank || 999, 10);
  const isLowcap = coinRank > 150;
  const minSlPct = isLowcap ? 1.8 : 1.0;

  // 🛡️ ĐÒN BẨY & MARGIN ĐỘNG: Phản ánh trung thực lệnh thật trên Binance (20x-50x, margin tính theo targetLossUSD)
  const leverage = parseInt(options.leverage || sig.leverage || (isLowcap ? 20 : 35), 10);
  const margin = parseFloat(options.margin || sig.margin || 25.0);

  // 🛡️ SL CHUẨN TIER: Ưu tiên tierSlPrice chuẩn từ calculateTierSLTP của Binance
  let tierSlPrice = options.tierSlPrice || options.slPrice || null;
  let slPct = options.slPct;
  if (!tierSlPrice) {
    slPct = Math.max(gridWidthPct * 0.5, minSlPct);
    tierSlPrice = isLong ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
  } else if (!slPct) {
    slPct = Math.abs((tierSlPrice - entryPrice) / entryPrice) * 100;
  }

  // 🎯 TP CHUẨN TIER: Ưu tiên tierTpPrice chuẩn từ calculateTierSLTP của Binance
  let tierTpPrice = options.tierTpPrice || options.tpPrice || null;
  let tpPct = options.tpPct;
  if (!tierTpPrice) {
    tpPct = Math.min(Math.max(gridWidthPct * 0.45, 1.2), 3.0);
    tierTpPrice = isLong ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
  } else if (!tpPct) {
    tpPct = Math.abs((tierTpPrice - entryPrice) / entryPrice) * 100;
  }

  // 🛡️ BREAKEVEN TRIGGER: Mức giá kích hoạt kéo SL về Hòa vốn (tương ứng ROI >= +20%)
  let beTriggerPrice = options.beTriggerPrice || null;
  if (!beTriggerPrice) {
    const beDeltaPct = 20.0 / leverage; // ví dụ 50x -> 0.4%, 25x -> 0.8%
    beTriggerPrice = isLong ? entryPrice * (1 + beDeltaPct / 100) : entryPrice * (1 - beDeltaPct / 100);
  }

  // 🛡️ MỨC GIÁ THỊ TRƯỜNG HIỆN TẠI VÀ TRẠNG THÁI KHỚP LỆNH LIMIT
  const currentMark = parseFloat(options.markPrice || entryPrice);
  // Nếu giá hiện tại đã chạm hoặc xuyên qua mốc entry thì tính là khớp ngay, ngược lại đặt cờ PENDING_LIMIT
  const isImmediatelyFilled = isLong ? (currentMark <= entryPrice) : (currentMark >= entryPrice);

  const shadowId = `SHADOW-${sym}-${Date.now()}`;
  const hypotheticalLossUSD = (margin * (slPct / 100) * leverage);
  const hypotheticalProfitUSD = (margin * (tpPct / 100) * leverage);

  const shadowTrade = {
    shadowId,
    symbol: sym,
    signal: side,
    entryPrice,
    tierSlPrice,
    originalSlPrice: tierSlPrice,
    tierTpPrice,
    beTriggerPrice,
    isBeTriggered: false,
    isFilled: isImmediatelyFilled,
    fillTimestamp: isImmediatelyFilled ? Date.now() : null,
    targetLossUSD: options.targetLossUSD || (margin * (slPct / 100) * leverage),
    slPct,
    tpPct,
    gridWidthPct,
    leverage,
    margin,
    hypotheticalLossUSD: Math.round(hypotheticalLossUSD * 100) / 100,
    hypotheticalProfitUSD: Math.round(hypotheticalProfitUSD * 100) / 100,
    score: sig.score ?? null,
    scoreReasons: sig.scoreReasons ?? [],
    marketCapRank: sig.marketCapRank ?? 999,
    winProbability: evalResult ? evalResult.winProbability : null,
    vetoCategory: evalResult ? (evalResult.vetoCategory || 'LOW_PROBABILITY') : 'UNKNOWN',
    vetoReason: evalResult ? evalResult.reason : 'AI_VETO',
    keyFactors: evalResult ? (evalResult.keyFactors || []) : [],
    marketMetrics: options.marketMetrics || sig.marketMetrics || null,
    signalMetrics: options.signalMetrics || sig.signalMetrics || null,
    microstructure: options.microstructure || sig.microstructure || null,
    isEconomicBlackout: options.isEconomicBlackout !== undefined ? options.isEconomicBlackout : (sig.isEconomicBlackout || false),
    entryTimestamp: Date.now(),
    maxFavorablePrice: entryPrice,
    maxAdversePrice: entryPrice,
    maxFavorableRoi: 0,
    maxAdverseRoi: 0,
    status: isImmediatelyFilled ? 'ACTIVE' : 'PENDING_LIMIT'
  };

  activeShadowPositions[shadowId] = shadowTrade;
  saveActiveShadowPositions();

  const fillStatusMsg = isImmediatelyFilled ? 'Đã khớp ngay' : 'Đang chờ râu nến khớp Limit';
  _logger.system(`[Shadow PnL] 👁️ Bắt đầu theo dõi VỊ THẾ BÓNG TỐI: ${sym} (${side}) @ $${entryPrice} [${fillStatusMsg}] | Đòn bẩy: ${leverage}x | Margin: $${margin} | SL: $${tierSlPrice.toFixed(4)} (-${slPct.toFixed(2)}%) | TP: $${tierTpPrice.toFixed(4)} (+${tpPct.toFixed(2)}%) | BE Trigger: $${beTriggerPrice.toFixed(4)} | WinProb: ${shadowTrade.winProbability}% (Veto: ${shadowTrade.vetoCategory})`);

  // Record entry in ai_trade_dataset.jsonl (marked as shadow)
  _appendDatasetRecord({
    type: 'ENTRY',
    isShadow: true,
    tradeId: shadowId,
    orderId: shadowId,
    symbol: sym,
    signal: side,
    entryPrice,
    markPrice: currentMark,
    timestamp: shadowTrade.entryTimestamp,
    score: shadowTrade.score,
    scoreReasons: shadowTrade.scoreReasons,
    marketCapRank: shadowTrade.marketCapRank,
    gridWidthPct: shadowTrade.gridWidthPct,
    marketMetrics: shadowTrade.marketMetrics,
    signalMetrics: shadowTrade.signalMetrics,
    microstructure: shadowTrade.microstructure,
    isEconomicBlackout: shadowTrade.isEconomicBlackout,
    leverage: shadowTrade.leverage,
    margin: shadowTrade.margin,
    aiWinProbability: shadowTrade.winProbability,
    vetoCategory: shadowTrade.vetoCategory
  });

  return shadowTrade;
}

/**
 * Update shadow positions against latest price map or candlestick wicks
 * Called periodically or on every websocket ticker/kline update
 *
 * @param {any} priceMap - Map or Object of symbol -> markPrice OR { price, high, low }
 */
function updateShadowPrices(priceMap) {
  const ids = Object.keys(activeShadowPositions);
  if (ids.length === 0) return;

  const now = Date.now();
  const MAX_HOLDING_HOURS = 48; // Auto-resolve if pending > 48h

  for (const id of ids) {
    const p = activeShadowPositions[id];
    if (!p) continue;

    // Get current price, candle high, candle low for symbol
    let priceData = null;
    if (priceMap instanceof Map) {
      priceData = priceMap.get(p.symbol) || priceMap.get(`${p.symbol}USDT`);
    } else if (typeof priceMap === 'object' && priceMap !== null) {
      priceData = priceMap[p.symbol] || priceMap[`${p.symbol}USDT`];
    }

    if (!priceData) continue;

    let currentPrice = 0;
    let candleHigh = 0;
    let candleLow = 0;

    if (typeof priceData === 'object' && priceData !== null) {
      currentPrice = parseFloat(priceData.price || priceData.close || priceData.markPrice || 0);
      candleHigh = parseFloat(priceData.high || priceData.h || currentPrice);
      candleLow = parseFloat(priceData.low || priceData.l || currentPrice);
    } else {
      currentPrice = parseFloat(priceData);
      candleHigh = currentPrice;
      candleLow = currentPrice;
    }

    if (!currentPrice || currentPrice <= 0) continue;

    const isLong = p.signal === 'LONG';
    const entry = p.entryPrice;

    // ─────────────────────────────────────────────────────────────────────────────
    // 1. NẾU LỆNH CHƯA KHỚP LIMIT: Theo dõi râu nến xem có khớp hay bị Bounce Cancel
    // ─────────────────────────────────────────────────────────────────────────────
    if (!p.isFilled) {
      const canFill = isLong ? (candleLow <= entry) : (candleHigh >= entry);
      if (canFill) {
        p.isFilled = true;
        p.fillTimestamp = now;
        p.status = 'ACTIVE';
        p.maxFavorablePrice = entry;
        p.maxAdversePrice = entry;
        _logger.system(`[Shadow PnL] 🎯 [Limit Filled] ${p.symbol} (${p.signal}) đã khớp Limit bóng tối @ $${entry} (Râu nến: ${isLong ? candleLow : candleHigh})`);
      } else {
        // Kiểm tra xem giá có nảy xa mốc trước khi khớp không (BOUNCE_CANCEL)
        const bounceCancelPct = Math.max((p.gridWidthPct || 3.0) * 0.20, 1.5);
        const isBouncedAway = isLong 
          ? (candleHigh >= entry * (1 + bounceCancelPct / 100))
          : (candleLow <= entry * (1 - bounceCancelPct / 100));
        
        const pendingMins = (now - p.entryTimestamp) / (60 * 1000);
        if (isBouncedAway) {
          _logger.system(`[Shadow PnL] ↩️ [Bounce Cancel] ${p.symbol} (${p.signal}) nảy xa mốc ${bounceCancelPct.toFixed(2)}% trước khi khớp -> Hủy lệnh chờ Limit.`);
          _resolveShadowTrade(p, 'BOUNCE_CANCEL', currentPrice, 0, now);
          continue;
        } else if (pendingMins >= 90) { // Quá 90 phút không khớp
          _logger.system(`[Shadow PnL] ⏱️ [Limit Timeout] ${p.symbol} (${p.signal}) chờ khớp Limit quá 90p -> Hủy lệnh.`);
          _resolveShadowTrade(p, 'LIMIT_TIMEOUT', currentPrice, 0, now);
          continue;
        }
        // Vẫn đang chờ râu nến khớp limit -> Bỏ qua kiểm tra TP/SL
        continue;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 2. VỊ THẾ ĐÃ KHỚP (ACTIVE): Theo dõi MFE, MAE, Breakeven, TP, SL y hệt sàn thật
    // ─────────────────────────────────────────────────────────────────────────────

    // Track MFE (Max Favorable Excursion) & MAE (Max Adverse Excursion) bằng râu nến (Wicks)
    if (isLong) {
      if (candleHigh > p.maxFavorablePrice) p.maxFavorablePrice = candleHigh;
      if (candleLow < p.maxAdversePrice) p.maxAdversePrice = candleLow;
    } else {
      if (candleLow < p.maxFavorablePrice) p.maxFavorablePrice = candleLow;
      if (candleHigh > p.maxAdversePrice) p.maxAdversePrice = candleHigh;
    }

    const currentRoi = isLong 
      ? ((currentPrice - entry) / entry) * p.leverage * 100 
      : ((entry - currentPrice) / entry) * p.leverage * 100;

    const favorableRoi = isLong
      ? ((p.maxFavorablePrice - entry) / entry) * p.leverage * 100
      : ((entry - p.maxFavorablePrice) / entry) * p.leverage * 100;
    p.maxFavorableRoi = Math.max(p.maxFavorableRoi || 0, favorableRoi);

    // 🛡️ DỜI SL VỀ HÒA VỐN (BREAKEVEN):
    // Kích hoạt ngay khi râu nến chạm beTriggerPrice HOẶC ROI nảy đạt >= +20%
    if (!p.isBeTriggered && p.beTriggerPrice) {
      const hitBeTrigger = isLong ? (candleHigh >= p.beTriggerPrice) : (candleLow <= p.beTriggerPrice);
      if (hitBeTrigger || favorableRoi >= 20.0) {
        p.isBeTriggered = true;
        p.tierSlPrice = entry; // Dời SL về hòa vốn y hệt bot thật trên Binance
        _logger.system(`[Shadow PnL] 🛡️ [Breakeven Active] ${p.symbol} (${p.signal}) chạm mốc BE ($${p.beTriggerPrice}) / ROI +${favorableRoi.toFixed(1)}% -> Đã kéo SL về Hòa vốn (Entry $${entry})!`);
      }
    }

    const holdingHours = (now - (p.fillTimestamp || p.entryTimestamp)) / (3600 * 1000);
    let resolvedOutcome = null; // 'SAVED_SL' | 'SAVED_BE' | 'MISSED_TP' | 'TIMEOUT_CLOSED'

    // 🚨 HARD MAX LOSS GUARD (Khống chế trần lỗ tối đa)
    const hardLossCapUSD = (p.targetLossUSD || 5.0) * 1.15;
    const unrealizedPnlUsd = (currentRoi / 100) * p.margin;
    if (unrealizedPnlUsd <= -hardLossCapUSD || currentRoi <= -55.0) {
      resolvedOutcome = p.isBeTriggered ? 'SAVED_BE' : 'SAVED_SL';
    }

    // 🎯 KIỂM TRA KHỚP LỆNH THEO RÂU NẾN (WICKS) VÀ GIÁ HIỆN TẠI
    if (!resolvedOutcome) {
      if (isLong) {
        if (candleHigh >= p.tierTpPrice) {
          resolvedOutcome = 'MISSED_TP';
        } else if (candleLow <= p.tierSlPrice) {
          resolvedOutcome = p.isBeTriggered ? 'SAVED_BE' : 'SAVED_SL';
        }
      } else {
        if (candleLow <= p.tierTpPrice) {
          resolvedOutcome = 'MISSED_TP';
        } else if (candleHigh >= p.tierSlPrice) {
          resolvedOutcome = p.isBeTriggered ? 'SAVED_BE' : 'SAVED_SL';
        }
      }
    }

    // Check timeout (tự động đóng sau 48h nếu không cắn TP/SL)
    if (!resolvedOutcome && holdingHours >= MAX_HOLDING_HOURS) {
      resolvedOutcome = currentRoi >= 0 ? 'TIMEOUT_PROFIT' : 'TIMEOUT_LOSS';
    }

    // 🚀 AI DYNAMIC RECOVERY: Nếu coin đang trong Cooldown do dính SL trước đó,
    // hoặc chiều giao dịch (LONG/SHORT) đang bị Circuit Breaker khóa:
    // CHỈ mở khóa sớm khi:
    // 1. Đã trải qua tối thiểu 3 giờ Cooldown để xu hướng xấu được hấp thụ hết.
    // 2. Vị thế Shadow đạt kết quả hồi phục vững chắc (đã chạm TP thực sự 'MISSED_TP' hoặc ROI thực chất >= +25% với favorableRoi >= +35%).
    // Tuyệt đối không mở khóa theo nhiễu râu 1m (0.2% - 0.3% giá).
    const isSolidRecovery = resolvedOutcome === 'MISSED_TP' || (favorableRoi >= 35.0 && currentRoi >= 25.0);
    if (isSolidRecovery) {
      try {
        const { isSymbolInCooldown, clearCooldown, getTimeInCooldownHours } = require('../trader/cooldownManager');
        if (isSymbolInCooldown(p.symbol)) {
          const elapsedCooldownHours = typeof getTimeInCooldownHours === 'function' ? getTimeInCooldownHours(p.symbol) : 0;
          if (elapsedCooldownHours >= 3.0) {
            const pnlStr = currentRoi >= 0 ? `+${currentRoi.toFixed(2)}%` : `${currentRoi.toFixed(2)}%`;
            _logger.system(`[CooldownManager] 🚀 [AI Dynamic Recovery] ${p.symbol} đã hấp thụ sóng xấu (${elapsedCooldownHours.toFixed(1)}h trôi qua) và hồi phục vững chắc (Shadow ROI: ${pnlStr}) -> Tự động giải phóng Cooldown!`);
            clearCooldown(p.symbol);
          }
        }
      } catch (err) {}

      try {
        const { tryEarlyDirectionalRecovery } = require('../trader/directionalCircuitBreaker');
        tryEarlyDirectionalRecovery(p.signal, p.symbol, currentRoi, resolvedOutcome === 'MISSED_TP' ? 'SHADOW_TP' : 'SHADOW_PROFIT');
      } catch (err) {}
    }

    if (resolvedOutcome) {
      const exitPrice = resolvedOutcome === 'MISSED_TP' 
        ? p.tierTpPrice 
        : (resolvedOutcome === 'SAVED_BE' ? entry : p.tierSlPrice);
      _resolveShadowTrade(p, resolvedOutcome, exitPrice, currentRoi, now);
    }
  }
}

/**
 * Resolve an active shadow trade
 */
function _resolveShadowTrade(p, outcome, exitPrice, exitRoi, exitTimestamp) {
  const isLong = p.signal === 'LONG';
  const isSavedBE = outcome === 'SAVED_BE';
  const isSavedSL = outcome === 'SAVED_SL' || outcome === 'TIMEOUT_LOSS';
  const isMissedTP = outcome === 'MISSED_TP' || outcome === 'TIMEOUT_PROFIT';
  const isCancelled = outcome === 'BOUNCE_CANCEL' || outcome === 'LIMIT_TIMEOUT';

  const durationMin = (exitTimestamp - (p.fillTimestamp || p.entryTimestamp)) / (60 * 1000);
  
  // Tính PnL và ROI chuẩn xác tương ứng kết quả
  let finalRoi = 0;
  let pnlUsd = 0;

  if (isMissedTP) {
    finalRoi = p.tpPct * p.leverage;
    pnlUsd = (finalRoi / 100) * p.margin;
  } else if (isSavedSL) {
    finalRoi = -p.slPct * p.leverage;
    pnlUsd = (finalRoi / 100) * p.margin;
  } else if (isSavedBE || isCancelled) {
    finalRoi = 0;
    pnlUsd = 0;
  }

  const resultRecord = {
    shadowId: p.shadowId,
    symbol: p.symbol,
    signal: p.signal,
    entryPrice: p.entryPrice,
    exitPrice,
    tierSlPrice: p.tierSlPrice,
    tierTpPrice: p.tierTpPrice,
    entryTimestamp: p.entryTimestamp,
    fillTimestamp: p.fillTimestamp,
    exitTimestamp,
    holdingDurationMinutes: Math.round(durationMin * 10) / 10,
    outcome,
    isSavedSL,
    isSavedBE,
    isMissedTP,
    isCancelled,
    isTradeWin: isMissedTP,
    aiDecisionWasCorrect: isSavedSL || isSavedBE || isCancelled,
    pnlPercent: Math.round(finalRoi * 100) / 100,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    savedLossUSD: isSavedSL ? Math.abs(p.hypotheticalLossUSD) : 0,
    missedProfitUSD: isMissedTP ? Math.abs(p.hypotheticalProfitUSD) : 0,
    score: p.score,
    scoreReasons: p.scoreReasons,
    winProbability: p.winProbability,
    vetoCategory: p.vetoCategory,
    vetoReason: p.vetoReason,
    marketMetrics: p.marketMetrics || null,
    signalMetrics: p.signalMetrics || null,
    microstructure: p.microstructure || null,
    isEconomicBlackout: p.isEconomicBlackout || false
  };

  // Ghi nhận vào Rolling Performance Guard để AI đánh giá khôi phục nếu đang trong chế độ Stand-Down
  try {
    const { recordShadowTradeOutcome } = require('../trader/rollingPerformanceGuard');
    recordShadowTradeOutcome({
      symbol: p.symbol,
      signal: p.signal,
      outcome,
      pnlUsd,
      roi: finalRoi
    });
  } catch (_) {}

  // Remove from active map
  delete activeShadowPositions[p.shadowId];
  saveActiveShadowPositions();

  // Record to shadow history
  _appendShadowHistory(resultRecord);

  // Record EXIT to ai_trade_dataset.jsonl for AI retraining
  _appendDatasetRecord({
    type: 'EXIT',
    isShadow: true,
    tradeId: p.shadowId,
    orderId: p.shadowId,
    symbol: p.symbol,
    exitPrice,
    exitTimestamp,
    exitType: isCancelled ? outcome : (isSavedBE ? 'BE' : (isSavedSL ? 'SL' : 'TP')),
    pnlPercent: Math.round(finalRoi * 100) / 100,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    holdingDurationMinutes: Math.round(durationMin * 10) / 10,
    isWin: isMissedTP
  });

  // Log notification
  if (isCancelled) {
    _logger.system(`[Shadow PnL] ⚪ ${p.symbol} (${p.signal}) đã kết thúc: ${outcome} (Lệnh Limit không khớp, không tính lãi lỗ)`);
  } else if (isSavedBE) {
    _logger.system(`[Shadow PnL] ⚖️ AI THOÁT HÒA VỐN (BE): ${p.symbol} (${p.signal}) đã kéo SL về Entry và cắn BE tại $${exitPrice} (Không lỗ, bảo toàn vốn thành công | Veto: ${p.vetoCategory})`);
  } else if (isSavedSL) {
    _logger.system(`[Shadow PnL] 🛡️ AI ĐÃ CỨU TÀI KHOẢN! ${p.symbol} (${p.signal}) cắn râu SL tại $${exitPrice} (Tránh mất -$${Math.abs(pnlUsd).toFixed(2)} USD | ROI: ${finalRoi.toFixed(2)}% | Veto: ${p.vetoCategory})`);
  } else if (isMissedTP) {
    _logger.system(`[Shadow PnL] ⚠️ AI BỎ LỠ LÃI: ${p.symbol} (${p.signal}) chạm TP tại $${exitPrice} (Bỏ lỡ +$${Math.abs(pnlUsd).toFixed(2)} USD | ROI: +${finalRoi.toFixed(2)}% | Veto: ${p.vetoCategory})`);
  } else {
    _logger.system(`[Shadow PnL] ⏱️ Vị thế bóng tối kết thúc: ${p.symbol} (${p.signal}) đóng tại $${exitPrice} (${outcome})`);
  }
}

/**
 * Get comprehensive summary statistics of shadow trades
 */
function getShadowStats() {
  const activeCount = Object.keys(activeShadowPositions).length;
  let totalResolved = 0;
  let totalSavedSL = 0;
  let totalMissedTP = 0;
  let totalSavedUSD = 0;
  let totalMissedUSD = 0;
  const categoryStats = {};

  try {
    if (fs.existsSync(SHADOW_HISTORY_FILE)) {
      const lines = fs.readFileSync(SHADOW_HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          totalResolved++;
          const cat = rec.vetoCategory || 'OTHER';
          if (!categoryStats[cat]) categoryStats[cat] = { total: 0, savedSL: 0, missedTP: 0 };
          categoryStats[cat].total++;

          if (rec.isSavedSL) {
            totalSavedSL++;
            totalSavedUSD += (rec.savedLossUSD || 15);
            categoryStats[cat].savedSL++;
          } else if (rec.isMissedTP) {
            totalMissedTP++;
            totalMissedUSD += (rec.missedProfitUSD || 15);
            categoryStats[cat].missedTP++;
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    _logger.warn(`Lỗi tính shadow stats: ${e.message}`);
  }

  const netValueUSD = totalSavedUSD - totalMissedUSD;
  const aiPrecision = totalResolved > 0 ? (totalSavedSL / totalResolved) * 100 : 0;

  return {
    activePositionsCount: activeCount,
    totalResolved,
    totalSavedSL,
    totalMissedTP,
    totalSavedUSD: Math.round(totalSavedUSD * 100) / 100,
    totalMissedUSD: Math.round(totalMissedUSD * 100) / 100,
    netValueUSD: Math.round(netValueUSD * 100) / 100,
    aiVetoAccuracyPct: Math.round(aiPrecision * 10) / 10,
    categoryStats
  };
}

// Initial load
loadActiveShadowPositions();

module.exports = {
  setLogger,
  registerShadowTrade,
  updateShadowPrices,
  getShadowStats,
  getActiveShadowPositions: () => ({ ...activeShadowPositions }),
  loadActiveShadowPositions,
  saveActiveShadowPositions
};
