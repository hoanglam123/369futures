'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const DATASET_FILE = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');

let _logger = {
  info: (...a) => console.log('[DatasetCollector]', ...a),
  warn: (...a) => console.warn('[DatasetCollector]', ...a),
  error: (...a) => console.error('[DatasetCollector]', ...a),
};

/**
 * Override logger (optional)
 */
function setLogger(logger) {
  _logger = logger;
}

/**
 * Append a single JSON object as a line to the JSONL file.
 */
function _appendLine(record) {
  try {
    const line = JSON.stringify(record);
    fs.appendFileSync(DATASET_FILE, line + '\n', 'utf8');
    return true;
  } catch (err) {
    _logger.error('Lỗi ghi record vào ai_trade_dataset.jsonl:', err.message);
    return false;
  }
}

/**
 * Record a trade entry snapshot.
 *
 * @param {object} entryData
 * @param {string} entryData.tradeId
 * @param {string} entryData.orderId
 * @param {string} entryData.symbol
 * @param {string} entryData.signal  - 'LONG' | 'SHORT'
 * @param {number} entryData.entryPrice
 * @param {number} entryData.markPrice
 * @param {number} [entryData.score]
 * @param {string[]} [entryData.scoreReasons]
 * @param {number} [entryData.marketCapRank]
 * @param {number} [entryData.gridWidthPct]
 * @param {number} [entryData.maxRecentBouncePct]
 * @param {number} entryData.leverage
 * @param {number} entryData.margin
 */
function recordTradeEntry(entryData) {
  if (!entryData || !entryData.symbol) {
    _logger.warn('recordTradeEntry: missing required fields (symbol)');
    return false;
  }

  const record = {
    type: 'ENTRY',
    tradeId: entryData.tradeId || entryData.orderId || null,
    orderId: entryData.orderId || null,
    symbol: entryData.symbol,
    signal: entryData.signal,
    entryPrice: entryData.entryPrice,
    markPrice: entryData.markPrice,
    timestamp: Date.now(),
    // Market context
    score: entryData.score ?? null,
    scoreReasons: entryData.scoreReasons ?? [],
    marketCapRank: entryData.marketCapRank ?? null,
    gridWidthPct: entryData.gridWidthPct ?? null,
    maxRecentBouncePct: entryData.maxRecentBouncePct ?? null,
    // Position sizing
    leverage: entryData.leverage,
    margin: entryData.margin,
  };

  return _appendLine(record);
}

/**
 * Record a trade exit result.
 *
 * @param {object} exitData
 * @param {string} exitData.tradeId
 * @param {string} exitData.orderId
 * @param {string} exitData.symbol
 * @param {number} exitData.exitPrice
 * @param {number} exitData.exitTimestamp
 * @param {string} exitData.exitType - 'TP' | 'SL' | 'TRAILING_SL' | 'LIMIT_TIMEOUT' | 'BOUNCE_CANCEL'
 * @param {number} exitData.pnlPercent  - ROI %
 * @param {number} exitData.pnlUsd     - Profit/Loss in USD
 * @param {number} exitData.holdingDurationMinutes
 * @param {boolean} exitData.isWin
 */
function recordTradeExit(exitData) {
  if (!exitData || !exitData.symbol) {
    _logger.warn('recordTradeExit: missing required fields (symbol)');
    return false;
  }

  const record = {
    type: 'EXIT',
    tradeId: exitData.tradeId || exitData.orderId || null,
    orderId: exitData.orderId || null,
    symbol: exitData.symbol,
    exitPrice: exitData.exitPrice,
    exitTimestamp: exitData.exitTimestamp || Date.now(),
    exitType: exitData.exitType,
    // PnL metrics
    pnlPercent: exitData.pnlPercent ?? null,
    pnlUsd: exitData.pnlUsd ?? null,
    holdingDurationMinutes: exitData.holdingDurationMinutes ?? null,
    isWin: exitData.isWin ?? null,
  };

  return _appendLine(record);
}

/**
 * Get simple stats from the dataset file.
 */
function getDatasetStats() {
  try {
    if (!fs.existsSync(DATASET_FILE)) {
      return { total: 0, entries: 0, exits: 0 };
    }
    const content = fs.readFileSync(DATASET_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    let entries = 0;
    let exits = 0;
    let wins = 0;
    let totalPnlUsd = 0;

    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'ENTRY') entries++;
        else if (rec.type === 'EXIT') {
          exits++;
          if (rec.isWin) wins++;
          if (typeof rec.pnlUsd === 'number') totalPnlUsd += rec.pnlUsd;
        }
      } catch (_) { /* ignore malformed lines */ }
    }

    return {
      total: lines.length,
      entries,
      exits,
      winRate: exits > 0 ? (wins / exits * 100).toFixed(2) + '%' : 'N/A',
      totalPnlUsd: totalPnlUsd.toFixed(2),
    };
  } catch (err) {
    _logger.warn('getDatasetStats error:', err.message);
    return { total: 0, entries: 0, exits: 0 };
  }
}

module.exports = {
  setLogger,
  recordTradeEntry,
  recordTradeExit,
  getDatasetStats,
};
