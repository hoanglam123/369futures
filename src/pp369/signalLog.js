'use strict';

const fs   = require('fs');
const path = require('path');
const { log } = require('./_logger');

// Data dir có thể override bằng setDataDir() — mặc định là <cwd>/data
let _dataDir = path.join(process.cwd(), 'data');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';

function signalFile() {
  return path.join(_dataDir, '369_signals.jsonl');
}

function nowVN() {
  return new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', 'T');
}

function setDataDir(dir) {
  _dataDir = dir;
}

/**
 * Ghi 1 dòng JSON vào 369_signals.jsonl mỗi khi có tín hiệu LONG/SHORT.
 * @param {Object} sig — kết quả từ get369Signal()
 */
function logSignal369(sig) {
  if (!sig || (sig.signal !== 'LONG' && sig.signal !== 'SHORT')) return;

  const entry = {
    ts:          nowVN(),
    symbol:      sig.symbol,
    month:       sig.month,
    signal:      sig.signal,
    price:       sig.currentPrice,
    h1Open:      sig.openPrice,    // Open nến H1 đầu tháng — mốc gốc PP369
    h1Close:     sig.closePrice,   // Close nến H1 đầu tháng — mốc gốc PP369
    targetLevel: sig.targetLevel,
    condLevel:   sig.condLevel,
    touchCount:  sig.touchCount,
    lan:         sig.touchCount + 1,
    strength:    sig.strength,
    pairLow:     sig.debugInfo?.pairLow,
    pairHigh:    sig.debugInfo?.pairHigh,
  };

  try {
    if (!fs.existsSync(_dataDir)) fs.mkdirSync(_dataDir, { recursive: true });
    fs.appendFileSync(signalFile(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    log.warn('[369Log] Không thể ghi signal log', { error: e.message });
  }
}

/**
 * Đọc toàn bộ lịch sử tín hiệu, trả về mảng object.
 */
function loadSignalHistory() {
  try {
    if (!fs.existsSync(signalFile())) return [];
    return fs.readFileSync(signalFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (e) {
    log.warn('[369Log] Không thể đọc signal log', { error: e.message });
    return [];
  }
}

module.exports = { logSignal369, loadSignalHistory, setDataDir };
