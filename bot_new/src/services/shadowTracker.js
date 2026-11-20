'use strict';

/**
 * Shadow PnL Tracker — Phase 5 Theo dõi ảo các lệnh bị từ chối
 *
 * Mọi setup đạt điểm Confluence cao nhưng bị Gatekeeper VETO hoặc bị Hard Filter loại bỏ
 * đều được ghi nhận vào danh sách Shadow Position và theo dõi đường đi giá ảo:
 * - Khi chạm SL ảo: Ghi nhận "SAVED_SL" -> AI đã cứu thua cho tài khoản!
 * - Khi chạm TP ảo: Ghi nhận "MISSED_TP" -> AI đã bỏ lỡ cơ hội chốt lời.
 * - Tự động tính toán Độ chính xác VETO (AI Accuracy %) và Net USD Giá trị thặng dư.
 * - Đấu nối kết quả vào Directional Circuit Breaker để tự động mở khóa sớm khi thị trường ổn định.
 */

const fs   = require('fs');
const path = require('path');
const { log } = require('./logger');

let _directionalCB = null;
function getDirectionalCB() {
  if (!_directionalCB) {
    try { _directionalCB = require('./directionalCircuitBreaker'); } catch (_) {}
  }
  return _directionalCB;
}

const DATA_DIR               = path.join(__dirname, '..', '..', 'data');
const SHADOW_POSITIONS_FILE = path.join(DATA_DIR, 'shadow_positions.json');
const SHADOW_HISTORY_FILE   = path.join(DATA_DIR, 'shadow_trades_history.jsonl');

let _activeShadowPositions = {};
const _recentResolved = new Map(); // key: `${sym}_${side}` -> timestamp (chống spam duplicate)
const SHADOW_COOLDOWN_MS = 20 * 60 * 1000;

function loadActiveShadows() {
  try {
    if (fs.existsSync(SHADOW_POSITIONS_FILE)) {
      const raw = fs.readFileSync(SHADOW_POSITIONS_FILE, 'utf8');
      _activeShadowPositions = JSON.parse(raw || '{}');
      const count = Object.keys(_activeShadowPositions).length;
      if (count > 0) {
        log.system(`[ShadowTracker] Đã khôi phục ${count} vị thế Shadow PnL từ đĩa`);
      }
    }
  } catch (e) {
    log.warn(`[ShadowTracker] Lỗi nạp ${SHADOW_POSITIONS_FILE}: ${e.message}`);
    _activeShadowPositions = {};
  }
}

function saveActiveShadows() {
  try {
    const dir = path.dirname(SHADOW_POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SHADOW_POSITIONS_FILE, JSON.stringify(_activeShadowPositions, null, 2), 'utf8');
  } catch (e) {
    log.warn(`[ShadowTracker] Lỗi lưu ${SHADOW_POSITIONS_FILE}: ${e.message}`);
  }
}

function appendShadowHistory(record) {
  try {
    const dir = path.dirname(SHADOW_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SHADOW_HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    log.warn(`[ShadowTracker] Lỗi ghi history: ${e.message}`);
  }
}

loadActiveShadows();

/**
 * Đăng ký một tín hiệu bị VETO vào danh sách Shadow Position
 */
function registerShadowTrade(sig, vetoReason = 'AI_VETO') {
  if (!sig || !sig.symbol) return null;

  const sym = (sig.symbol || '').replace('USDT', '').toUpperCase();
  const side = (sig.direction || sig.signal || 'LONG').toUpperCase();
  const entry = sig.entryPrice || sig.targetLevel || sig.price;
  if (!entry || entry <= 0) return null;

  // Chống đăng ký trùng trong 20 phút
  const key = `${sym}_${side}`;
  const now = Date.now();
  if (_recentResolved.has(key) && (now - _recentResolved.get(key)) < SHADOW_COOLDOWN_MS) {
    return null;
  }

  // Đã có trong danh sách active
  for (const pos of Object.values(_activeShadowPositions)) {
    if (pos.symbol === sym && pos.direction === side && pos.status === 'ACTIVE') {
      return null;
    }
  }

  const sl = sig.slPrice || (side === 'LONG' ? entry * 0.98 : entry * 1.02);
  const tp = sig.tpPrice || (side === 'LONG' ? entry * 1.03 : entry * 0.97);

  const id = `shadow_${sym}_${side}_${now}`;
  const shadowPos = {
    id,
    symbol: sym,
    direction: side,
    entryPrice: entry,
    slPrice: sl,
    tpPrice: tp,
    targetLossUsd: 3.0,
    vetoReason: typeof vetoReason === 'string' ? vetoReason : JSON.stringify(vetoReason),
    confluenceScore: sig.total || sig.score || 0,
    status: 'ACTIVE',
    openedAt: new Date(now).toISOString(),
    openedAtMs: now
  };

  _activeShadowPositions[id] = shadowPos;
  saveActiveShadows();

  log.system(`[ShadowTracker] 👁️ Đăng ký Shadow Trade: ${sym} ${side} @ ${entry} (SL: ${sl} | TP: ${tp} | Lý do VETO: ${shadowPos.vetoReason})`);
  return shadowPos;
}

/**
 * Cập nhật giá thị trường và đánh giá kết quả các lệnh Shadow
 * @param {Object} prices { BTC: 95000, SOL: 190, ... }
 */
function updateShadowPrices(prices) {
  if (!prices || typeof prices !== 'object') return [];

  const resolved = [];
  const now = Date.now();

  for (const [id, pos] of Object.entries(_activeShadowPositions)) {
    if (pos.status !== 'ACTIVE') continue;

    const price = prices[pos.symbol];
    if (!price || price <= 0) continue;

    const isLong = pos.direction === 'LONG' || pos.direction === 'BUY';
    let outcome = null;
    let pnlPct  = 0;
    let pnlUsd  = 0;

    if (isLong) {
      pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (price >= pos.tpPrice) {
        outcome = 'MISSED_TP'; // AI bỏ lỡ lệnh ăn
        pnlPct  = ((pos.tpPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pnlUsd  = 3.0 * (pnlPct / (Math.abs(pos.entryPrice - pos.slPrice) / pos.entryPrice * 100));
      } else if (price <= pos.slPrice) {
        outcome = 'SAVED_SL';  // AI đã cứu thua!
        pnlPct  = ((pos.slPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pnlUsd  = -3.0;
      }
    } else {
      pnlPct = ((pos.entryPrice - price) / pos.entryPrice) * 100;
      if (price <= pos.tpPrice) {
        outcome = 'MISSED_TP';
        pnlPct  = ((pos.entryPrice - pos.tpPrice) / pos.entryPrice) * 100;
        pnlUsd  = 3.0 * (pnlPct / (Math.abs(pos.slPrice - pos.entryPrice) / pos.entryPrice * 100));
      } else if (price >= pos.slPrice) {
        outcome = 'SAVED_SL';
        pnlPct  = ((pos.entryPrice - pos.slPrice) / pos.entryPrice) * 100;
        pnlUsd  = -3.0;
      }
    }

    // Quá hạn 24h không chạm TP hay SL -> TIMEOUT
    if (!outcome && (now - pos.openedAtMs) > 24 * 3600 * 1000) {
      outcome = pnlPct >= 0 ? 'TIMEOUT_PROFIT' : 'TIMEOUT_LOSS';
      pnlUsd  = (pnlPct / 100) * 50.0;
    }

    if (outcome) {
      pos.status   = outcome;
      pos.closedAt = new Date(now).toISOString();
      pos.exitPrice = price;
      pos.pnlPct   = parseFloat(pnlPct.toFixed(2));
      pos.pnlUsd   = parseFloat(pnlUsd.toFixed(2));

      appendShadowHistory(pos);
      delete _activeShadowPositions[id];
      _recentResolved.set(`${pos.symbol}_${pos.direction}`, now);

      resolved.push(pos);

      const dirCB = getDirectionalCB();
      if (dirCB && typeof dirCB.recordDirectionalShadowOutcome === 'function') {
        dirCB.recordDirectionalShadowOutcome({
          symbol: pos.symbol,
          signal: pos.direction,
          outcome,
          pnlUsd: pos.pnlUsd,
          roi: pos.pnlPct
        });
      }

      if (outcome === 'SAVED_SL') {
        log.system(`[ShadowTracker] 🛡️ [AI SAVED SL] ${pos.symbol} ${pos.direction} đã dính SL ảo! AI VETO chính xác, đã cứu thua $3.00 USD!`);
      } else if (outcome === 'MISSED_TP') {
        log.warn(`[ShadowTracker] ⚠️ [AI MISSED TP] ${pos.symbol} ${pos.direction} đã chạm TP ảo (+${pos.pnlPct}%)! AI đã bỏ lỡ cơ hội lãi $${pos.pnlUsd.toFixed(2)} USD.`);
      }
    }
  }

  if (resolved.length > 0) {
    saveActiveShadows();
  }

  return resolved;
}

function getActiveShadowPositions() {
  return { ..._activeShadowPositions };
}

function getShadowStats() {
  let totalSavedSl = 0;
  let totalMissedTp = 0;
  let savedUsd = 0;
  let missedUsd = 0;

  try {
    if (fs.existsSync(SHADOW_HISTORY_FILE)) {
      const lines = fs.readFileSync(SHADOW_HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const t = JSON.parse(line);
          if (t.status === 'SAVED_SL') {
            totalSavedSl++;
            savedUsd += Math.abs(t.pnlUsd || 3.0);
          } else if (t.status === 'MISSED_TP') {
            totalMissedTp++;
            missedUsd += (t.pnlUsd || 0);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  const totalEvaluated = totalSavedSl + totalMissedTp;
  const vetoAccuracyPct = totalEvaluated > 0 ? parseFloat(((totalSavedSl / totalEvaluated) * 100).toFixed(1)) : 100.0;
  const netSavedUsd = parseFloat((savedUsd - missedUsd).toFixed(2));

  return {
    activeCount: Object.keys(_activeShadowPositions).length,
    totalSavedSl,
    totalMissedTp,
    vetoAccuracyPct,
    savedUsd: parseFloat(savedUsd.toFixed(2)),
    missedUsd: parseFloat(missedUsd.toFixed(2)),
    netSavedUsd
  };
}

function clearActiveShadowsForTest() {
  _activeShadowPositions = {};
  _recentResolved.clear();
  saveActiveShadows();
}

module.exports = {
  registerShadowTrade,
  updateShadowPrices,
  getActiveShadowPositions,
  getShadowStats,
  clearActiveShadowsForTest
};
