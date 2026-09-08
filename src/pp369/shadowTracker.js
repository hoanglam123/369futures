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

  // Check if already tracking this symbol in shadow positions within last 30 minutes
  const existing = Object.values(activeShadowPositions).find(p => p.symbol === sym && p.signal === side);
  if (existing && (Date.now() - existing.entryTimestamp) < 30 * 60 * 1000) {
    return existing; // Don't duplicate active shadow position
  }

  // Calculate SL / TP distances
  const gridWidthPct = parseFloat(sig.gridWidthPct || options.gridWidthPct || 4.0);
  const leverage = parseInt(sig.leverage || options.leverage || 10, 10);
  const margin = parseFloat(sig.margin || options.margin || 75.0);

  // Approximate SL: 50% gridWidth or ~2.0% - 3.0%
  const slPct = Math.min(Math.max(gridWidthPct * 0.5, 1.5), 5.0);
  const tpPct = Math.min(Math.max(gridWidthPct * 0.8, 2.0), 6.0);

  const tierSlPrice = options.tierSlPrice || (isLong ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100));
  const tierTpPrice = options.tierTpPrice || (isLong ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100));

  const shadowId = `SHADOW-${sym}-${Date.now()}`;
  const hypotheticalLossUSD = (margin * (slPct / 100) * leverage);
  const hypotheticalProfitUSD = (margin * (tpPct / 100) * leverage);

  const shadowTrade = {
    shadowId,
    symbol: sym,
    signal: side,
    entryPrice,
    tierSlPrice,
    tierTpPrice,
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
    entryTimestamp: Date.now(),
    maxFavorablePrice: entryPrice,
    maxAdversePrice: entryPrice,
    maxFavorableRoi: 0,
    maxAdverseRoi: 0,
    status: 'ACTIVE'
  };

  activeShadowPositions[shadowId] = shadowTrade;
  saveActiveShadowPositions();

  _logger.system(`[Shadow PnL] 👁️ Bắt đầu theo dõi VỊ THẾ BÓNG TỐI: ${sym} (${side}) @ $${entryPrice} | SL: $${tierSlPrice.toFixed(4)} (-${slPct.toFixed(2)}%) | TP: $${tierTpPrice.toFixed(4)} (+${tpPct.toFixed(2)}%) | WinProb: ${shadowTrade.winProbability}% (Lý do Veto: ${shadowTrade.vetoCategory})`);

  // Record entry in ai_trade_dataset.jsonl (marked as shadow)
  _appendDatasetRecord({
    type: 'ENTRY',
    isShadow: true,
    tradeId: shadowId,
    orderId: shadowId,
    symbol: sym,
    signal: side,
    entryPrice,
    markPrice: entryPrice,
    timestamp: shadowTrade.entryTimestamp,
    score: shadowTrade.score,
    scoreReasons: shadowTrade.scoreReasons,
    marketCapRank: shadowTrade.marketCapRank,
    gridWidthPct: shadowTrade.gridWidthPct,
    leverage: shadowTrade.leverage,
    margin: shadowTrade.margin,
    aiWinProbability: shadowTrade.winProbability,
    vetoCategory: shadowTrade.vetoCategory
  });

  return shadowTrade;
}

/**
 * Update shadow positions against latest price map
 * Called periodically or on every websocket ticker update
 *
 * @param {any} priceMap - Map or Object of symbol -> markPrice
 */
function updateShadowPrices(priceMap) {
  const ids = Object.keys(activeShadowPositions);
  if (ids.length === 0) return;

  const now = Date.now();
  const MAX_HOLDING_HOURS = 48; // Auto-resolve if pending > 48h

  for (const id of ids) {
    const p = activeShadowPositions[id];
    if (!p) continue;

    // Get current price for symbol
    let currentPrice = null;
    if (priceMap instanceof Map) {
      currentPrice = priceMap.get(p.symbol) || priceMap.get(`${p.symbol}USDT`);
    } else if (typeof priceMap === 'object' && priceMap !== null) {
      currentPrice = priceMap[p.symbol] || priceMap[`${p.symbol}USDT`];
    }

    if (!currentPrice || currentPrice <= 0) continue;
    currentPrice = parseFloat(currentPrice);

    const isLong = p.signal === 'LONG';
    const entry = p.entryPrice;

    // Track MFE (Max Favorable Excursion) & MAE (Max Adverse Excursion)
    if (isLong) {
      if (currentPrice > p.maxFavorablePrice) p.maxFavorablePrice = currentPrice;
      if (currentPrice < p.maxAdversePrice) p.maxAdversePrice = currentPrice;
    } else {
      if (currentPrice < p.maxFavorablePrice) p.maxFavorablePrice = currentPrice;
      if (currentPrice > p.maxAdversePrice) p.maxAdversePrice = currentPrice;
    }

    const currentRoi = isLong 
      ? ((currentPrice - entry) / entry) * p.leverage * 100 
      : ((entry - currentPrice) / entry) * p.leverage * 100;

    const holdingHours = (now - p.entryTimestamp) / (3600 * 1000);

    let resolvedOutcome = null; // 'SAVED_SL' | 'MISSED_TP' | 'TIMEOUT_CLOSED'

    if (isLong) {
      if (currentPrice <= p.tierSlPrice) {
        resolvedOutcome = 'SAVED_SL';
      } else if (currentPrice >= p.tierTpPrice) {
        resolvedOutcome = 'MISSED_TP';
      }
    } else {
      if (currentPrice >= p.tierSlPrice) {
        resolvedOutcome = 'SAVED_SL';
      } else if (currentPrice <= p.tierTpPrice) {
        resolvedOutcome = 'MISSED_TP';
      }
    }

    // Check timeout
    if (!resolvedOutcome && holdingHours >= MAX_HOLDING_HOURS) {
      resolvedOutcome = currentRoi >= 0 ? 'TIMEOUT_PROFIT' : 'TIMEOUT_LOSS';
    }

    if (resolvedOutcome) {
      _resolveShadowTrade(p, resolvedOutcome, currentPrice, currentRoi, now);
    }
  }
}

/**
 * Resolve an active shadow trade
 */
function _resolveShadowTrade(p, outcome, exitPrice, exitRoi, exitTimestamp) {
  const isLong = p.signal === 'LONG';
  const isSavedSL = outcome === 'SAVED_SL' || outcome === 'TIMEOUT_LOSS';
  const isMissedTP = outcome === 'MISSED_TP' || outcome === 'TIMEOUT_PROFIT';

  const durationMin = (exitTimestamp - p.entryTimestamp) / (60 * 1000);
  const pnlUsd = (exitRoi / 100) * p.margin;

  const resultRecord = {
    shadowId: p.shadowId,
    symbol: p.symbol,
    signal: p.signal,
    entryPrice: p.entryPrice,
    exitPrice,
    tierSlPrice: p.tierSlPrice,
    tierTpPrice: p.tierTpPrice,
    entryTimestamp: p.entryTimestamp,
    exitTimestamp,
    holdingDurationMinutes: Math.round(durationMin * 10) / 10,
    outcome,
    isSavedSL,
    isMissedTP,
    // From trading perspective: if trade would have hit TP, isWin = true (meaning AI vetoed a winner)
    // if trade would have hit SL, isWin = false (meaning AI correctly vetoed a loser)
    isTradeWin: isMissedTP,
    aiDecisionWasCorrect: isSavedSL,
    pnlPercent: Math.round(exitRoi * 100) / 100,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    savedLossUSD: isSavedSL ? Math.abs(p.hypotheticalLossUSD) : 0,
    missedProfitUSD: isMissedTP ? Math.abs(p.hypotheticalProfitUSD) : 0,
    score: p.score,
    scoreReasons: p.scoreReasons,
    winProbability: p.winProbability,
    vetoCategory: p.vetoCategory,
    vetoReason: p.vetoReason
  };

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
    exitType: isSavedSL ? 'SL' : 'TP',
    pnlPercent: Math.round(exitRoi * 100) / 100,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    holdingDurationMinutes: Math.round(durationMin * 10) / 10,
    isWin: isMissedTP // If it hit TP, it was a winning trade
  });

  // Log notification
  if (isSavedSL) {
    _logger.system(`[Shadow PnL] 🛡️ AI ĐÃ CỨU TÀI KHOẢN! ${p.symbol} (${p.signal}) chạm SL tại $${exitPrice} (Tránh mất -$${Math.abs(p.hypotheticalLossUSD).toFixed(2)} USD | ROI: ${exitRoi.toFixed(2)}% | Veto: ${p.vetoCategory})`);
  } else if (isMissedTP) {
    _logger.system(`[Shadow PnL] ⚠️ AI BỎ LỠ LÃI: ${p.symbol} (${p.signal}) chạm TP tại $${exitPrice} (Bỏ lỡ +$${Math.abs(p.hypotheticalProfitUSD).toFixed(2)} USD | ROI: +${exitRoi.toFixed(2)}% | Veto: ${p.vetoCategory})`);
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
