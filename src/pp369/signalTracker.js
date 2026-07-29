'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SKIPPED_SIGNALS_FILE = path.join(DATA_DIR, 'skipped_signals.jsonl');

let _logger = {
  info: (...a) => console.log('[SignalTracker]', ...a),
  warn: (...a) => console.warn('[SignalTracker]', ...a),
  error: (...a) => console.error('[SignalTracker]', ...a),
};

/**
 * Override logger (optional)
 */
function setLogger(logger) {
  _logger = logger;
}

/**
 * Record a skipped signal for later backfill analysis.
 * This function only WRITES to file - no background monitoring.
 *
 * @param {object} data
 * @param {string} data.symbol
 * @param {string} data.signal - 'LONG' | 'SHORT'
 * @param {number} data.signalPrice - Price at time of signal
 * @param {number} data.score - Signal score
 * @param {string[]} [data.scoreReasons]
 * @param {string} data.skipReason - Why signal was skipped
 * @param {number} [data.markPrice]
 * @param {number} [data.marketCapRank]
 */
function recordSkippedSignal(data) {
  if (!data || !data.symbol || !data.signal) {
    _logger.warn('recordSkippedSignal: missing required fields (symbol, signal)');
    return false;
  }

  const record = {
    type: 'SKIPPED_SIGNAL',
    symbol: data.symbol,
    signal: data.signal,
    signalPrice: data.signalPrice,
    score: data.score,
    scoreReasons: data.scoreReasons || [],
    skipReason: data.skipReason || 'UNKNOWN',
    signalTimestamp: Date.now(),
    markPrice: data.markPrice || null,
    marketCapRank: data.marketCapRank || null,
    hypotheticalTP: data.hypotheticalTP || null,
    hypotheticalSL: data.hypotheticalSL || null,
    tracked: true,
    resolved: false,
  };

  try {
    const line = JSON.stringify(record) + '\n';
    // Async write - không block event loop
    fs.appendFile(SKIPPED_SIGNALS_FILE, line, 'utf8', (err) => {
      if (err) _logger.error('Lỗi ghi skipped signal:', err.message);
    });
    return true;
  } catch (err) {
    _logger.error('Lỗi ghi skipped signal:', err.message);
    return false;
  }
}

/**
 * Get stats from skipped signals file (sync - chỉ gọi khi cần xem stats)
 */
function getSkippedSignalsStats() {
  try {
    if (!fs.existsSync(SKIPPED_SIGNALS_FILE)) {
      return { total: 0, longs: 0, shorts: 0, resolved: 0 };
    }
    const content = fs.readFileSync(SKIPPED_SIGNALS_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    let longs = 0;
    let shorts = 0;
    let resolved = 0;

    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.signal === 'LONG') longs++;
        else if (rec.signal === 'SHORT') shorts++;
        if (rec.resolved) resolved++;
      } catch (_) { /* ignore malformed lines */ }
    }

    return { total: lines.length, longs, shorts, resolved };
  } catch (err) {
    _logger.warn('getSkippedSignalsStats error:', err.message);
    return { total: 0, longs: 0, shorts: 0, resolved: 0 };
  }
}

module.exports = {
  setLogger,
  recordSkippedSignal,
  getSkippedSignalsStats,
};
