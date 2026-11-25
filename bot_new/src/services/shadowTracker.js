'use strict';

/**
 * Shadow PnL Tracker — Phase 5 Theo dõi ảo các lệnh bị từ chối (Đồng bộ 100% live Exit Engine)
 *
 * Mọi setup đạt điểm Confluence cao nhưng bị Gatekeeper VETO hoặc bị Hard Filter loại bỏ
 * đều được ghi nhận vào danh sách Shadow Position và theo dõi đường đi giá ảo sát thực tế sàn:
 * - Chờ khớp Limit (PENDING_LIMIT -> ACTIVE khi giá/râu chạm Entry; hủy nếu BOUNCE_CANCEL hoặc >90p LIMIT_TIMEOUT)
 * - Giai đoạn 1: Tự động dời BE @ 50% TP (BE_TRIGGER_TP_PCT) về Entry ± 0.14% đệm phí khứ hồi thực
 * - Giai đoạn 2: Dual H1/M15 Williams Fractal Trailing SL (50%–70% TP bám H1, >=70% TP siết M15, đệm 0.15%)
 * - Tính PnL USD & ROI theo margin và leverage thực tế của lệnh (bỏ hardcode $3.00)
 * - Lưu đủ telemetry (outcome, tierSlPrice, tierTpPrice, marketMetrics, microstructure) tương thích train_ai_model.py
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

let _candleCache = null;
function getCandleCache() {
  if (!_candleCache) {
    try { _candleCache = require('./candleCache'); } catch (_) {}
  }
  return _candleCache;
}

const DATA_DIR              = path.join(__dirname, '..', '..', 'data');
const SHADOW_POSITIONS_FILE = path.join(DATA_DIR, 'shadow_positions.json');
const SHADOW_HISTORY_FILE   = path.join(DATA_DIR, 'shadow_trades_history.jsonl');

let _activeShadowPositions = {};
const _recentResolved = new Map(); // key: `${sym}_${side}` -> timestamp (chống spam duplicate)
const SHADOW_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_HOLDING_HOURS  = 48;
const LIMIT_TIMEOUT_MINS = 90;

function isTestSymbol(sym) {
  return /(_TEST|^TEST|^TWIN_)/i.test(String(sym || ''));
}

function loadActiveShadows() {
  try {
    if (fs.existsSync(SHADOW_POSITIONS_FILE)) {
      const raw = fs.readFileSync(SHADOW_POSITIONS_FILE, 'utf8');
      _activeShadowPositions = JSON.parse(raw || '{}');
      const count = Object.keys(_activeShadowPositions).length;
      if (count > 0) {
        log.system(`[ShadowTracker] Đã khôi phục ${count} vị thế Shadow PnL đang theo dõi từ ${SHADOW_POSITIONS_FILE}`);
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
  // Không ghi mẫu test nhân tạo vào file lịch sử thật
  if (isTestSymbol(record?.symbol)) return;
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
 * Áp dụng Williams Fractal Trailing SL (thuần toán học — dùng chung cho live & unit test)
 */
function applyFractalTrailingSl(pos, candles, tfLabel = 'H1', tfMs = 3600_000) {
  if (!pos || !pos.isBeTriggered || !Array.isArray(candles) || candles.length < 6) return false;
  const cache = getCandleCache();
  if (!cache || typeof cache.getRecentFractalSwing !== 'function') return false;

  const isLong = pos.direction === 'LONG' || pos.direction === 'BUY';
  const entryTs = pos.fillTimestamp || pos.openedAtMs || 0;
  const filtered = entryTs > 1e12
    ? candles.filter(c => (c.openTime || c.t || 0) >= (entryTs - 2 * tfMs))
    : candles;
  if (filtered.length < 6) return false;

  const swing = cache.getRecentFractalSwing(filtered, isLong);
  if (!swing || typeof swing.price !== 'number' || swing.price <= 0) return false;

  const candidateSl = isLong ? swing.price * 0.9985 : swing.price * 1.0015;
  const beFloor = isLong ? (pos.entryPrice * 1.0014) : (pos.entryPrice * 0.9986);
  const aboveBeFloor = isLong ? (candidateSl >= beFloor) : (candidateSl <= beFloor);
  const isBetter = isLong ? (candidateSl > pos.slPrice) : (candidateSl < pos.slPrice);

  if (aboveBeFloor && isBetter) {
    pos.slPrice = candidateSl;
    pos.tierSlPrice = candidateSl;
    log.system(`[ShadowTracker] [Shadow PnL] 🌊 [Fractal ${tfLabel} Trailing SL] ${pos.symbol} (${pos.direction}) dời SL ảo về $${candidateSl.toFixed(4)}!`);
    return true;
  }
  return false;
}

/**
 * Đăng ký một tín hiệu bị VETO vào danh sách Shadow Position
 */
function registerShadowTrade(sig, vetoReason = 'AI_VETO') {
  if (!sig || !sig.symbol) return null;

  const sym = (sig.symbol || '').replace('USDT', '').toUpperCase();
  const side = (sig.direction || sig.signal || 'LONG').toUpperCase();
  const isLong = side === 'LONG' || side === 'BUY';
  const entry = parseFloat(sig.entryPrice || sig.targetLevel || sig.price || 0);
  if (!entry || entry <= 0) return null;

  // Chống đăng ký trùng trong 20 phút sau khi vừa chốt
  const key = `${sym}_${side}`;
  const now = Date.now();
  if (_recentResolved.has(key) && (now - _recentResolved.get(key)) < SHADOW_COOLDOWN_MS) {
    return null;
  }

  // Đã có trong danh sách active / pending_limit
  for (const pos of Object.values(_activeShadowPositions)) {
    if (pos.symbol === sym && pos.direction === side && (pos.status === 'ACTIVE' || pos.status === 'PENDING_LIMIT')) {
      return null;
    }
  }

  const sl = parseFloat(sig.slPrice || sig.tierSlPrice || (isLong ? entry * 0.98 : entry * 1.02));
  const tp = parseFloat(sig.tpPrice || sig.tierTpPrice || (isLong ? entry * 1.03 : entry * 0.97));
  const slPct = (typeof sig.slPct === 'number' && sig.slPct > 0)
    ? sig.slPct
    : Math.abs((sl - entry) / entry) * 100;
  const tpPct = (typeof sig.tpPct === 'number' && sig.tpPct > 0)
    ? sig.tpPct
    : Math.abs((tp - entry) / entry) * 100;

  const leverage = Number(sig.leverage) > 0 ? Number(sig.leverage) : 3;
  const margin = Number(sig.margin) > 0 ? Number(sig.margin) : 10.0;
  const targetLossUsd = parseFloat((margin * (slPct / 100) * leverage).toFixed(2));
  const winProbPct = typeof sig.winProbability === 'number'
    ? (sig.winProbability <= 1 ? sig.winProbability * 100 : sig.winProbability)
    : null;

  // Đồng bộ mốc BE @ 50% TP (BE_TRIGGER_TP_PCT)
  const beTriggerRatio = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));
  const beTriggerPrice = (typeof sig.beTriggerPrice === 'number' && sig.beTriggerPrice > 0)
    ? sig.beTriggerPrice
    : (isLong ? (entry + (tp - entry) * beTriggerRatio) : (entry - (entry - tp) * beTriggerRatio));

  // Kiểm tra trạng thái khớp Limit: nếu không truyền markPrice (VD unit test), mặc định khớp ngay tại entry
  const currentMark = parseFloat(sig.markPrice ?? sig.currentPrice ?? entry);
  const isImmediatelyFilled = isLong ? (currentMark <= entry) : (currentMark >= entry);

  const id = `shadow_${sym}_${side}_${now}`;
  const shadowPos = {
    id,
    shadowId: id,
    symbol: sym,
    direction: side,
    signal: side,
    entryPrice: entry,
    slPrice: sl,
    tierSlPrice: sl,
    originalSlPrice: sl,
    tpPrice: tp,
    tierTpPrice: tp,
    beTriggerPrice,
    isBeTriggered: false,
    isFilled: isImmediatelyFilled,
    fillTimestamp: isImmediatelyFilled ? now : null,
    slPct: parseFloat(slPct.toFixed(3)),
    tpPct: parseFloat(tpPct.toFixed(3)),
    gridWidthPct: parseFloat(sig.gridWidthPct || 3.5),
    marketCapRank: parseInt(sig.marketCapRank || 999, 10),
    leverage,
    margin,
    winProbability: winProbPct != null ? parseFloat(winProbPct.toFixed(1)) : null,
    targetLossUsd,
    vetoReason: typeof vetoReason === 'string' ? vetoReason : JSON.stringify(vetoReason),
    confluenceScore: sig.total || sig.score || 0,
    score: sig.total || sig.score || 0,
    scoreReasons: Array.isArray(sig.scoreReasons) ? sig.scoreReasons : (Array.isArray(sig.reasons) ? sig.reasons : []),
    marketMetrics: sig.marketMetrics || null,
    microstructure: sig.microstructure || null,
    features: sig.features || null,
    keyFactors: Array.isArray(sig.keyFactors) ? sig.keyFactors : [],
    maxFavorablePrice: entry,
    maxAdversePrice: entry,
    status: isImmediatelyFilled ? 'ACTIVE' : 'PENDING_LIMIT',
    openedAt: new Date(now).toISOString(),
    openedAtMs: now,
    entryTimestamp: now
  };

  _activeShadowPositions[id] = shadowPos;
  saveActiveShadows();

  const probLabel = winProbPct != null ? ` | WinProb: ${winProbPct.toFixed(1)}%` : '';
  const fillLabel = isImmediatelyFilled ? 'Khớp ngay' : 'Chờ Limit';
  log.system(`[ShadowTracker] [Shadow PnL] 👁️ Bắt đầu theo dõi VỊ THẾ BÓNG TỐI: ${sym} (${side}) @ $${entry} [${fillLabel}] | Đòn bẩy: ${leverage}x | Margin: $${margin.toFixed(2)} | SL: $${sl} | TP: $${tp} | BE: $${beTriggerPrice.toFixed(4)}${probLabel} (Veto: ${shadowPos.vetoReason})`);
  return shadowPos;
}

/**
 * Cập nhật giá thị trường và đánh giá kết quả các lệnh Shadow
 * @param {Object} prices { BTC: 95000, SOL: { price: 190, high: 191, low: 189 }, ... }
 */
function updateShadowPrices(prices) {
  if (!prices || typeof prices !== 'object') return [];

  const resolved = [];
  let stateMutated = false;
  const now = Date.now();
  const beTriggerRatioLive = Math.max(0.35, Math.min(0.85, parseFloat(process.env.BE_TRIGGER_TP_PCT || '50') / 100));

  for (const [id, pos] of Object.entries(_activeShadowPositions)) {
    if (pos.status !== 'ACTIVE' && pos.status !== 'PENDING_LIMIT') continue;

    // Tương thích ngược với các shadow cũ lưu từ trước bản nâng cấp (chưa có isFilled)
    if (typeof pos.isFilled !== 'boolean') {
      pos.isFilled = pos.status === 'ACTIVE';
      pos.fillTimestamp = pos.isFilled ? (pos.openedAtMs || now) : null;
    }

    const rawPriceData = prices[pos.symbol] ?? prices[`${pos.symbol}USDT`];
    if (rawPriceData == null) {
      if ((now - (pos.openedAtMs || now)) > MAX_HOLDING_HOURS * 3600 * 1000) {
        pos.status = 'EXPIRED';
        pos.outcome = 'EXPIRED';
        pos.closedAt = new Date(now).toISOString();
        pos.exitTimestamp = now;
        appendShadowHistory(pos);
        delete _activeShadowPositions[id];
        resolved.push(pos);
        stateMutated = true;
      }
      continue;
    }

    let price = 0;
    let candleHigh = 0;
    let candleLow = 0;
    if (typeof rawPriceData === 'object' && rawPriceData !== null) {
      price = parseFloat(rawPriceData.price || rawPriceData.close || rawPriceData.markPrice || 0);
      candleHigh = parseFloat(rawPriceData.high || rawPriceData.h || price);
      candleLow = parseFloat(rawPriceData.low || rawPriceData.l || price);
    } else {
      price = parseFloat(rawPriceData);
      candleHigh = price;
      candleLow = price;
    }
    if (!price || price <= 0) continue;

    const isLong = pos.direction === 'LONG' || pos.direction === 'BUY';
    const entry = pos.entryPrice;
    const lev = Number(pos.leverage) > 0 ? Number(pos.leverage) : 3;
    const margin = Number(pos.margin) > 0 ? Number(pos.margin) : 10.0;

    // ─── 1. NẾU ĐANG CHỜ KHỚP LIMIT (PENDING_LIMIT) ────────────────────────
    if (!pos.isFilled) {
      const canFill = isLong ? (candleLow <= entry) : (candleHigh >= entry);
      if (canFill) {
        pos.isFilled = true;
        pos.fillTimestamp = now;
        pos.status = 'ACTIVE';
        pos.maxFavorablePrice = entry;
        pos.maxAdversePrice = entry;
        stateMutated = true;
        log.system(`[ShadowTracker] [Shadow PnL] 🎯 [Limit Filled] ${pos.symbol} (${pos.direction}) đã khớp Limit bóng tối @ $${entry}!`);
      } else {
        const bounceCancelPct = Math.max((pos.gridWidthPct || 3.0) * 0.20, 1.5);
        const isBouncedAway = isLong
          ? (candleHigh >= entry * (1 + bounceCancelPct / 100))
          : (candleLow <= entry * (1 - bounceCancelPct / 100));
        const pendingMins = (now - (pos.openedAtMs || now)) / 60_000;

        let cancelOutcome = null;
        if (isBouncedAway) cancelOutcome = 'BOUNCE_CANCEL';
        else if (pendingMins >= LIMIT_TIMEOUT_MINS) cancelOutcome = 'LIMIT_TIMEOUT';

        if (cancelOutcome) {
          pos.status = cancelOutcome;
          pos.outcome = cancelOutcome;
          pos.closedAt = new Date(now).toISOString();
          pos.exitTimestamp = now;
          pos.exitPrice = price;
          pos.pnlPct = 0;
          pos.roi = 0;
          pos.pnlUsd = 0;
          pos.holdingDurationMinutes = parseFloat(pendingMins.toFixed(1));
          pos.isSavedSL = false;
          pos.isSavedBE = false;
          pos.isMissedTP = false;
          pos.isTradeWin = false;
          appendShadowHistory(pos);
          delete _activeShadowPositions[id];
          _recentResolved.set(`${pos.symbol}_${pos.direction}`, now);
          resolved.push(pos);
          stateMutated = true;
          log.system(`[ShadowTracker] [Shadow PnL] ↩️ [${cancelOutcome}] ${pos.symbol} (${pos.direction}) hủy chờ Limit (không khớp Entry $${entry}).`);
        }
        continue;
      }
    }

    // ─── 2. VỊ THẾ ĐÃ KHỚP (ACTIVE): BE 50% TP + FRACTAL TRAILING SL ───────
    if (isLong) {
      if (!pos.maxFavorablePrice || candleHigh > pos.maxFavorablePrice) pos.maxFavorablePrice = candleHigh;
      if (!pos.maxAdversePrice || candleLow < pos.maxAdversePrice) pos.maxAdversePrice = candleLow;
    } else {
      if (!pos.maxFavorablePrice || candleLow < pos.maxFavorablePrice) pos.maxFavorablePrice = candleLow;
      if (!pos.maxAdversePrice || candleHigh > pos.maxAdversePrice) pos.maxAdversePrice = candleHigh;
    }

    const wasBeTriggeredBefore = pos.isBeTriggered === true;
    const prevSlPrice = pos.slPrice;

    const totalTpDist = Math.abs(pos.tpPrice - entry);
    const liveBeTriggerPrice = totalTpDist > 0
      ? (isLong ? entry + totalTpDist * beTriggerRatioLive : entry - totalTpDist * beTriggerRatioLive)
      : pos.beTriggerPrice;

    // Giai đoạn 1: Dời BE @ 50% TP kèm đệm phí 0.14%
    if (!pos.isBeTriggered && typeof liveBeTriggerPrice === 'number' && liveBeTriggerPrice > 0) {
      const hitBeTrigger = isLong ? (candleHigh >= liveBeTriggerPrice) : (candleLow <= liveBeTriggerPrice);
      if (hitBeTrigger) {
        pos.isBeTriggered = true;
        pos.beTriggerPrice = liveBeTriggerPrice;
        const beFeeSl = isLong ? (entry * 1.0014) : (entry * 0.9986);
        const isBetter = isLong ? (beFeeSl > pos.slPrice) : (beFeeSl < pos.slPrice);
        if (isBetter) {
          pos.slPrice = beFeeSl;
          pos.tierSlPrice = beFeeSl;
          stateMutated = true;
          log.system(`[ShadowTracker] [Shadow PnL] ⚖️ [Breakeven ${Math.round(beTriggerRatioLive * 100)}% TP] ${pos.symbol} (${pos.direction}) chạm mốc BE ($${liveBeTriggerPrice.toFixed(4)}) -> Khóa SL hòa vốn + phí 0.14% @ $${beFeeSl.toFixed(4)}!`);
        }
      }
    }

    // Giai đoạn 2: Dual H1/M15 Williams Fractal Trailing SL (50%-70% TP bám H1, >=70% TP siết M15, throttle 60s)
    if (pos.isBeTriggered && totalTpDist > 0 && !isTestSymbol(pos.symbol) &&
        (!pos._lastFractalCheck || (now - pos._lastFractalCheck >= 60_000))) {
      pos._lastFractalCheck = now;
      const curGainDist = isLong ? (price - entry) : (entry - price);
      const progressPct = (curGainDist / totalTpDist) * 100;
      const useM15 = progressPct >= 70;
      const tfLabel = useM15 ? 'M15' : 'H1';
      const tfMs = useM15 ? 15 * 60_000 : 3600_000;
      const cache = getCandleCache();
      if (cache) {
        const fetchPromise = useM15
          ? (typeof cache.fetchM15Recent === 'function' ? cache.fetchM15Recent(pos.symbol, 30) : Promise.resolve([]))
          : (typeof cache.fetchH1Historical === 'function' ? cache.fetchH1Historical(pos.symbol) : Promise.resolve([]));
        fetchPromise.then((candles) => {
          if (applyFractalTrailingSl(pos, candles, tfLabel, tfMs)) {
            saveActiveShadows();
          }
        }).catch(() => {});
      }
    }

    // ─── 3. KIỂM TRA CHỐT LỆNH (TP -> SAVED_BE -> SAVED_SL -> TIMEOUT 48H) ─
    let outcome = null;
    let exitPrice = price;

    if (isLong) {
      if (candleHigh >= pos.tpPrice) {
        outcome = 'MISSED_TP';
        exitPrice = pos.tpPrice;
      } else if (wasBeTriggeredBefore) {
        if (candleLow <= pos.slPrice) {
          outcome = 'SAVED_BE';
          exitPrice = pos.slPrice;
        }
      } else if (candleLow <= prevSlPrice) {
        outcome = 'SAVED_SL';
        exitPrice = prevSlPrice;
      }
    } else {
      if (candleLow <= pos.tpPrice) {
        outcome = 'MISSED_TP';
        exitPrice = pos.tpPrice;
      } else if (wasBeTriggeredBefore) {
        if (candleHigh >= pos.slPrice) {
          outcome = 'SAVED_BE';
          exitPrice = pos.slPrice;
        }
      } else if (candleHigh >= prevSlPrice) {
        outcome = 'SAVED_SL';
        exitPrice = prevSlPrice;
      }
    }

    const activeSinceMs = pos.fillTimestamp || pos.openedAtMs || now;
    const holdingHours = (now - activeSinceMs) / (3600 * 1000);
    const livePnlPct = isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;

    if (!outcome && holdingHours >= MAX_HOLDING_HOURS) {
      outcome = livePnlPct >= 0 ? 'TIMEOUT_PROFIT' : 'TIMEOUT_LOSS';
      exitPrice = price;
    }

    if (outcome) {
      const distPct = isLong
        ? ((exitPrice - entry) / entry) * 100
        : ((entry - exitPrice) / entry) * 100;
      const roi = distPct * lev;
      const pnlUsd = (roi / 100) * margin;
      const holdingMins = (now - activeSinceMs) / 60_000;

      pos.status = outcome;
      pos.outcome = outcome;
      pos.closedAt = new Date(now).toISOString();
      pos.exitTimestamp = now;
      pos.exitPrice = exitPrice;
      pos.pnlPct = parseFloat(distPct.toFixed(2));
      pos.roi = parseFloat(roi.toFixed(2));
      pos.pnlUsd = parseFloat(pnlUsd.toFixed(2));
      pos.holdingDurationMinutes = parseFloat(holdingMins.toFixed(1));
      pos.isSavedSL = outcome === 'SAVED_SL' || outcome === 'TIMEOUT_LOSS';
      pos.isSavedBE = outcome === 'SAVED_BE';
      pos.isMissedTP = outcome === 'MISSED_TP' || outcome === 'TIMEOUT_PROFIT';
      pos.isTradeWin = outcome === 'MISSED_TP' || outcome === 'SAVED_BE' || outcome === 'TIMEOUT_PROFIT';

      appendShadowHistory(pos);
      delete _activeShadowPositions[id];
      _recentResolved.set(`${pos.symbol}_${pos.direction}`, now);

      resolved.push(pos);
      stateMutated = true;

      const dirCB = getDirectionalCB();
      if (dirCB && typeof dirCB.recordDirectionalShadowOutcome === 'function') {
        dirCB.recordDirectionalShadowOutcome({
          symbol: pos.symbol,
          signal: pos.direction,
          outcome,
          pnlUsd: pos.pnlUsd,
          roi: pos.roi
        });
      }

      if (outcome === 'SAVED_SL') {
        log.system(`[ShadowTracker] [Shadow PnL] 🛡️ [AI SAVED SL] ${pos.symbol} ${pos.direction} đã dính SL ảo (${pos.pnlPct}%)! AI VETO chính xác, cứu thua $${Math.abs(pos.pnlUsd).toFixed(2)} USD!`);
      } else if (outcome === 'SAVED_BE') {
        log.system(`[ShadowTracker] [Shadow PnL] ⚖️ [AI SAVED BE] ${pos.symbol} ${pos.direction} chốt hòa vốn/trailing (+${pos.pnlPct}%, +$${pos.pnlUsd.toFixed(2)} USD)!`);
      } else if (outcome === 'MISSED_TP') {
        log.warn(`[ShadowTracker] [Shadow PnL] ⚠️ [AI MISSED TP] ${pos.symbol} ${pos.direction} đã chạm TP ảo (+${pos.pnlPct}%)! AI bỏ lỡ cơ hội lãi $${pos.pnlUsd.toFixed(2)} USD.`);
      }
    }
  }

  if (stateMutated) {
    saveActiveShadows();
  }

  return resolved;
}

function getActiveShadowPositions() {
  return { ..._activeShadowPositions };
}

/**
 * Kiểm tra xem symbol có đang có vị thế Shadow PnL active hoặc đang chờ Limit không (Đồng bộ bot-h4)
 */
function isShadowPositionActive(sym, side = null) {
  if (!sym) return false;
  const cleanSym = sym.replace('USDT', '').toUpperCase();
  for (const pos of Object.values(_activeShadowPositions)) {
    if (pos.symbol === cleanSym && (pos.status === 'ACTIVE' || pos.status === 'PENDING_LIMIT')) {
      if (!side || pos.direction === side.toUpperCase()) {
        return true;
      }
    }
  }
  return false;
}

function getShadowStats() {
  let totalSavedSl = 0;
  let totalSavedBe = 0;
  let totalMissedTp = 0;
  let savedUsd = 0;
  let missedUsd = 0;

  try {
    if (fs.existsSync(SHADOW_HISTORY_FILE)) {
      const lines = fs.readFileSync(SHADOW_HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const t = JSON.parse(line);
          if (isTestSymbol(t.symbol)) continue;
          const st = t.outcome || t.status;
          if (st === 'SAVED_SL' || st === 'TIMEOUT_LOSS') {
            totalSavedSl++;
            savedUsd += Math.abs(t.pnlUsd || 3.0);
          } else if (st === 'SAVED_BE') {
            totalSavedBe++;
            if (typeof t.pnlUsd === 'number' && t.pnlUsd > 0) {
              missedUsd += t.pnlUsd;
            }
          } else if (st === 'MISSED_TP' || st === 'TIMEOUT_PROFIT') {
            totalMissedTp++;
            missedUsd += Math.max(0, t.pnlUsd || 0);
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
    totalSavedBe,
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
  applyFractalTrailingSl,
  getActiveShadowPositions,
  isShadowPositionActive,
  getShadowStats,
  clearActiveShadowsForTest
};
