'use strict';

/**
 * riskGatekeeper.js — AI Bản Thân Cục Bộ (Local Machine Learning Gatekeeper)
 *
 * - 0ms execution, 0 Token, 0 USD, hoàn toàn offline
 * - Nạp & Hot-Reload mô hình xác suất Bayes thực từ data/ai_rule_config.json (featureWeights + riskPenaltyProfile)
 * - Đánh giá vi cấu trúc nến M15/H1, biến động bão H1/M15, biến tốc BTC 180s, spread slippage, orderbook wall
 * - Tích hợp Multi-Factor Risk Interactions (INTERACTION_STALE_BOUNCE_RUNAWAY, INTERACTION_HIGH_VOLATILITY_WEAK_SETUP, INTERACTION_PUNCTURE_RUNAWAY)
 * - Triệt tiêu phạt kép (Double-Counting Prevention + Baseline Anchoring = 1.00)
 * - Cấu hình linh hoạt qua AI_GATEKEEPER_MODE ('LOCAL' hoặc 'DISABLED')
 */

const fs = require('fs');
const path = require('path');
const { getStep } = require('./tierSLTP');
const { log } = require('./logger');

function resolveSharedModelPath() {
  // Ưu tiên mô hình riêng của bot-new (bot_new/data/ai_rule_config.json) nếu đã train tách riêng,
  // fallback sang mô hình dùng chung ở root/data/ai_rule_config.json
  const candidates = [
    path.resolve(__dirname, '../../data', 'ai_rule_config.json'),
    path.resolve(process.cwd(), 'data', 'ai_rule_config.json'),
    path.resolve(__dirname, '../../../data', 'ai_rule_config.json')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const MODEL_PATH = resolveSharedModelPath();
let _modelConfig = null;
let _lastModelMtimeMs = 0;
let _lastMtimeCheckMs = 0;

function loadModel() {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const stat = fs.statSync(MODEL_PATH);
      const raw = fs.readFileSync(MODEL_PATH, 'utf8');
      _modelConfig = JSON.parse(raw);
      _lastModelMtimeMs = stat.mtimeMs;
      log.system(`[PP369] [AI Reviewer] ✓ Đã nạp thành công mô hình AI (v${_modelConfig.version || '1.4.0-auto'}, mẫu N=${_modelConfig.totalSamples || 0})`);
    } else {
      log.warn(`[RiskGatekeeper] Chưa tìm thấy ${MODEL_PATH}. Sử dụng trọng số mặc định.`);
    }
  } catch (err) {
    log.error(`[RiskGatekeeper] Lỗi nạp mô hình: ${err.message}`);
  }
}

function checkModelHotReload(force = false) {
  const now = Date.now();
  if (!force && (now - _lastMtimeCheckMs < 15_000)) return false;
  _lastMtimeCheckMs = now;
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const stat = fs.statSync(MODEL_PATH);
      if (force || stat.mtimeMs > _lastModelMtimeMs) {
        loadModel();
        return true;
      }
    }
  } catch (_) {}
  return false;
}

loadModel();

/**
 * Phân loại hình thái nến đối với mốc Entry (Geometry Classification)
 */
function classifyCandleGeometry(candle, targetLevel, isLong, step, isLive = false) {
  if (!candle || !targetLevel || typeof candle.close !== 'number') return 'HOLD_OR_HOVER';
  const totalRange = Math.max(1e-9, candle.high - candle.low);
  const stepDist = step || (targetLevel * 0.01);

  const deepThreshold = isLive
    ? Math.max(stepDist * 0.40, targetLevel * 0.015)
    : Math.max(stepDist * 0.20, targetLevel * 0.005);
  const lightThreshold = isLive
    ? Math.max(stepDist * 0.25, targetLevel * 0.008)
    : Math.max(stepDist * 0.10, targetLevel * 0.002);

  if (isLong) {
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isWickRejection = (lowerWick / totalRange >= 0.35) && (candle.low <= targetLevel);

    if (isWickRejection) return 'REJECT_PINBAR';
    if (candle.close < targetLevel) {
      if (targetLevel - candle.close >= deepThreshold) return 'PUNCTURED_DEEP';
      if (targetLevel - candle.close >= lightThreshold) return 'PUNCTURED_LIGHT';
    }
    return 'HOLD_OR_HOVER';
  } else {
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const isWickRejection = (upperWick / totalRange >= 0.35) && (candle.high >= targetLevel);

    if (isWickRejection) return 'REJECT_PINBAR';
    if (candle.close > targetLevel) {
      if (candle.close - targetLevel >= deepThreshold) return 'PUNCTURED_DEEP';
      if (candle.close - targetLevel >= lightThreshold) return 'PUNCTURED_LIGHT';
    }
    return 'HOLD_OR_HOVER';
  }
}

/**
 * Trích xuất bộ đặc trưng vi cấu trúc (không trùng lặp với Confluence Scorer)
 */
function extractGatekeeperFeatures(sig, marketContext = {}) {
  const isLong = (sig.signal === 'LONG' || sig.signal === 'BUY');
  const targetLevel = sig.targetLevel || sig.price || 0;
  const step = getStep(targetLevel);
  const rank = parseInt(sig.marketCapRank || marketContext?.rank || 100, 10);
  const features = {};

  const cH1  = marketContext?.candleH1 || null;
  const cM15 = marketContext?.candleM15 || null;

  // 1. Hình thái nến H1 & M15 (hỗ trợ isLiveCandle cho nến đang chạy để tránh phạt quá chặt râu live)
  const isLiveCandle = Boolean(marketContext?.isLiveCandle);
  let geoH1 = null;
  let geoM15 = null;
  if (cH1 && targetLevel > 0) {
    geoH1 = classifyCandleGeometry(cH1, targetLevel, isLong, step, isLiveCandle);
    features['h1_candle_geometry'] = `H1_${geoH1}`;
  }
  if (cM15 && targetLevel > 0) {
    geoM15 = classifyCandleGeometry(cM15, targetLevel, isLong, step, isLiveCandle);
    features['m15_candle_geometry'] = `M15_${geoM15}`;
  }

  // 2. Puncture Interaction (Khử phạt kép H1 + M15)
  const h1Punct = geoH1 === 'PUNCTURED_DEEP' || geoH1 === 'PUNCTURED_LIGHT';
  const m15Punct = geoM15 === 'PUNCTURED_DEEP' || geoM15 === 'PUNCTURED_LIGHT';
  if (h1Punct && m15Punct) {
    features['puncture_interaction'] = 'INTERACTION_H1_M15_PUNCTURED';
  } else if (geoH1 === 'PUNCTURED_DEEP') {
    features['puncture_interaction'] = 'INTERACTION_H1_PUNCTURED_DEEP';
  } else if (geoM15 === 'PUNCTURED_DEEP') {
    features['puncture_interaction'] = 'INTERACTION_M15_PUNCTURED_DEEP';
  } else {
    features['puncture_interaction'] = 'INTERACTION_PUNCTURE_NORMAL';
  }

  // 3. Biến động bão H1 & M15 (Volatility Compression / Storm)
  if (cH1 && cH1.low > 0) {
    const h1RangePct = ((cH1.high - cH1.low) / cH1.low) * 100;
    if (h1RangePct >= 8.0) features['h1_volatility'] = 'H1_EXTREME_STORM_PUMP_DUMP';
    else if (h1RangePct >= 4.0) features['h1_volatility'] = 'H1_VOLATILE_DANGER';
    else features['h1_volatility'] = 'H1_VOL_NORMAL';
  }
  if (cM15 && cM15.low > 0) {
    const m15RangePct = ((cM15.high - cM15.low) / cM15.low) * 100;
    if (m15RangePct >= 6.0) features['m15_volatility'] = 'M15_EXTREME_STORM';
    else if (m15RangePct >= 3.0) features['m15_volatility'] = 'M15_VOLATILE_DANGER';
    else features['m15_volatility'] = 'M15_VOL_NORMAL';
  }

  // 4. Động lượng nến ngược chiều (Counter-Train Momentum)
  if (cM15 && cM15.low > 0) {
    const isGreen = cM15.close >= cM15.open;
    const rangePct = ((cM15.high - cM15.low) / cM15.low) * 100;
    const bodyPct  = (Math.abs(cM15.close - cM15.open) / cM15.low) * 100;
    if (!isLong && isGreen && (bodyPct >= 3.0 || rangePct >= 5.0)) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_PUMP_TRAIN';
    } else if (isLong && !isGreen && (bodyPct >= 3.0 || rangePct >= 5.0)) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_DUMP_TRAIN';
    } else {
      features['candle_momentum'] = 'MOMENTUM_NORMAL';
    }
  }

  // 5. Pre-Entry Bounce (Độ cũ của cú nảy)
  const preBounce = parseFloat(marketContext?.preEntryBouncePct ?? sig?.preEntryBouncePct ?? 0);
  if (preBounce >= 1.5) features['pre_entry_bounce'] = 'BOUNCE_STALE_EXTREME';
  else if (preBounce >= 0.8) features['pre_entry_bounce'] = 'BOUNCE_STALE_HIGH';
  else features['pre_entry_bounce'] = 'BOUNCE_FRESH';

  // 6. Biến tốc BTC Flash Guard 180s
  const btcFlash = marketContext?.btcFlash;
  if (btcFlash === 'FLASH_DUMP' && isLong) {
    features['btc_flash'] = 'BTC_FLASH_DUMP_ACTIVE';
  } else if (btcFlash === 'FLASH_PUMP' && !isLong) {
    features['btc_flash'] = 'BTC_FLASH_PUMP_ACTIVE';
  } else {
    features['btc_flash'] = 'BTC_FLASH_NORMAL';
  }

  // 7. Spread Slippage Guard (Thanh khoản 0ms thay cho turnover_guard)
  if (typeof marketContext?.spreadPct === 'number' && marketContext.spreadPct > 0) {
    const dangerTh  = rank <= 50 ? 0.040 : (rank <= 150 ? 0.060 : 0.080);
    const cautionTh = rank <= 50 ? 0.025 : (rank <= 150 ? 0.035 : 0.045);
    if (marketContext.spreadPct > dangerTh) features['spread_slippage'] = 'SPREAD_WIDE_DANGER';
    else if (marketContext.spreadPct > cautionTh) features['spread_slippage'] = 'SPREAD_MEDIUM_CAUTION';
    else features['spread_slippage'] = 'SPREAD_TIGHT_SAFE';
  }

  // 8. Orderbook Wall L2
  const wall = marketContext?.orderbookWall;
  if (wall === 'OPPOSING_BLOCK' || wall === 'WALL_OPPOSING_BLOCK') {
    features['orderbook_wall'] = 'WALL_OPPOSING_BLOCK';
  } else if (wall === 'SUPPORT_SHIELD' || wall === 'WALL_SUPPORT_SHIELD') {
    features['orderbook_wall'] = 'WALL_SUPPORT_SHIELD';
  } else if (wall === 'CLEAR' || wall === 'WALL_CLEAR_PATH') {
    features['orderbook_wall'] = 'WALL_CLEAR_PATH';
  }

  // 9. Multi-Factor Risk Interactions (Chốt chặn rủi ro kép đồng bộ bot-h4)
  const isVolDanger = features['h1_volatility'] === 'H1_VOLATILE_DANGER' ||
    features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP' ||
    features['m15_volatility'] === 'M15_VOLATILE_DANGER' ||
    features['m15_volatility'] === 'M15_EXTREME_STORM';
  const isCounterTrain = features['candle_momentum'] === 'MOMENTUM_COUNTER_PUMP_TRAIN' ||
    features['candle_momentum'] === 'MOMENTUM_COUNTER_DUMP_TRAIN';
  const isBtcFlashActive = features['btc_flash'] !== 'BTC_FLASH_NORMAL';

  if (features['pre_entry_bounce'] === 'BOUNCE_STALE_EXTREME' ||
      (features['pre_entry_bounce'] === 'BOUNCE_STALE_HIGH' && isBtcFlashActive)) {
    features['risk_interaction'] = 'INTERACTION_STALE_BOUNCE_RUNAWAY';
  } else if (isVolDanger && isCounterTrain) {
    features['risk_interaction'] = 'INTERACTION_HIGH_VOLATILITY_WEAK_SETUP';
  } else if (features['puncture_interaction'] === 'INTERACTION_H1_M15_PUNCTURED') {
    features['risk_interaction'] = 'INTERACTION_PUNCTURE_RUNAWAY';
  } else {
    features['risk_interaction'] = 'INTERACTION_BALANCED';
  }

  return features;
}

/**
 * Thẩm định tín hiệu giao dịch bằng mô hình Bayes từ ai_rule_config.json
 * @param {Object} sig - { symbol, signal, targetLevel, score, scoreReasons }
 * @param {Object} marketContext - { candleH1, candleM15, btcFlash, orderbookWall, spreadPct, preEntryBouncePct }
 */
function evaluateSignal(sig, marketContext = null) {
  const mode = (process.env.AI_GATEKEEPER_MODE || 'LOCAL').toUpperCase();

  if (mode === 'DISABLED') {
    return {
      isApproved: true,
      winProbability: 0.70,
      confidenceScore: sig.score || 7.0,
      reason: 'GATEKEEPER_DISABLED (Thuần định lượng Confluence Scorer)',
      mode: 'DISABLED'
    };
  }

  if (!_modelConfig) {
    loadModel();
  } else {
    checkModelHotReload();
  }

  const priorWin = _modelConfig?.priorWinProb || 0.565;
  const weights  = _modelConfig?.featureWeights || {};
  const riskPenalties = _modelConfig?.riskPenaltyProfile || {};

  // Trọng số dự phòng nạp trực tiếp từ riskPenaltyProfile của mô hình AI
  const dynamicModifiers = {
    'h1_volatility:H1_EXTREME_STORM_PUMP_DUMP': riskPenalties.h1ExtremeStormRaw ?? 0.60,
    'h1_volatility:H1_VOLATILE_DANGER': 0.75,
    'm15_volatility:M15_EXTREME_STORM': riskPenalties.m15ExtremeStormRaw ?? 0.60,
    'm15_volatility:M15_VOLATILE_DANGER': 0.75,
    'h1_candle_geometry:H1_PUNCTURED_DEEP': 0.22,
    'h1_candle_geometry:H1_PUNCTURED_LIGHT': 0.60,
    'h1_candle_geometry:H1_REJECT_PINBAR': 1.20,
    'h1_candle_geometry:H1_HOLD_OR_HOVER': 1.00,
    'm15_candle_geometry:M15_PUNCTURED_DEEP': 0.40,
    'm15_candle_geometry:M15_PUNCTURED_LIGHT': 0.55,
    'm15_candle_geometry:M15_REJECT_PINBAR': 1.15,
    'm15_candle_geometry:M15_HOLD_OR_HOVER': 1.00,
    'puncture_interaction:INTERACTION_H1_M15_PUNCTURED': 0.32,
    'puncture_interaction:INTERACTION_H1_PUNCTURED_DEEP': 0.22,
    'puncture_interaction:INTERACTION_M15_PUNCTURED_DEEP': 0.40,
    'puncture_interaction:INTERACTION_PUNCTURE_NORMAL': 1.00,
    'candle_momentum:MOMENTUM_COUNTER_PUMP_TRAIN': 0.55,
    'candle_momentum:MOMENTUM_COUNTER_DUMP_TRAIN': 0.55,
    'candle_momentum:MOMENTUM_NORMAL': 1.00,
    'pre_entry_bounce:BOUNCE_STALE_EXTREME': 0.45,
    'pre_entry_bounce:BOUNCE_STALE_HIGH': 0.90,
    'pre_entry_bounce:BOUNCE_FRESH': 1.00,
    'btc_flash:BTC_FLASH_DUMP_ACTIVE': riskPenalties.btcFlashOpposing ?? 0.35,
    'btc_flash:BTC_FLASH_PUMP_ACTIVE': riskPenalties.btcFlashOpposing ?? 0.35,
    'btc_flash:BTC_FLASH_NORMAL': 1.00,
    'spread_slippage:SPREAD_WIDE_DANGER': riskPenalties.spreadWide ?? 0.20,
    'spread_slippage:SPREAD_MEDIUM_CAUTION': 0.95,
    'spread_slippage:SPREAD_TIGHT_SAFE': 1.05,
    'orderbook_wall:WALL_OPPOSING_BLOCK': riskPenalties.wallOpposingBlock ?? 0.35,
    'orderbook_wall:WALL_SUPPORT_SHIELD': 1.12,
    'orderbook_wall:WALL_CLEAR_PATH': 1.00,
    'risk_interaction:INTERACTION_STALE_BOUNCE_RUNAWAY': 0.45,
    'risk_interaction:INTERACTION_HIGH_VOLATILITY_WEAK_SETUP': 0.50,
    'risk_interaction:INTERACTION_PUNCTURE_RUNAWAY': 0.35,
    'risk_interaction:INTERACTION_BALANCED': 1.00,
  };

  const features = extractGatekeeperFeatures(sig, marketContext || {});

  // 🛡️ DOUBLE-COUNTING PREVENTION (Khử phạt kép chồng chéo đồng bộ bot-h4)
  const skip = new Map();
  const riskInteraction = features['risk_interaction'];
  if (riskInteraction === 'INTERACTION_STALE_BOUNCE_RUNAWAY') {
    skip.set('pre_entry_bounce', riskInteraction);
  } else if (riskInteraction === 'INTERACTION_PUNCTURE_RUNAWAY') {
    skip.set('puncture_interaction', riskInteraction);
    skip.set('h1_candle_geometry', riskInteraction);
    skip.set('m15_candle_geometry', riskInteraction);
  } else if (riskInteraction === 'INTERACTION_HIGH_VOLATILITY_WEAK_SETUP') {
    // Volatility + Counter-train đã được gom vào interaction -> tránh nhân phạt 3 lần
    skip.set('m15_volatility', riskInteraction);
    skip.set('candle_momentum', riskInteraction);
  }

  if (features['puncture_interaction'] && features['puncture_interaction'] !== 'INTERACTION_PUNCTURE_NORMAL' && !skip.has('puncture_interaction')) {
    skip.set('h1_candle_geometry', features['puncture_interaction']);
    skip.set('m15_candle_geometry', features['puncture_interaction']);
  }

  // Khử trùng lặp Pinbar H1 & M15 (chỉ lấy khung lớn H1)
  if (features['h1_candle_geometry'] === 'H1_REJECT_PINBAR' && features['m15_candle_geometry'] === 'M15_REJECT_PINBAR') {
    skip.set('m15_candle_geometry', 'H1_REJECT_PINBAR');
  }

  // Khử trùng lặp bão biến động H1 & M15
  if (features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP' || features['h1_volatility'] === 'H1_VOLATILE_DANGER') {
    if (features['m15_volatility'] === 'M15_EXTREME_STORM' || features['m15_volatility'] === 'M15_VOLATILE_DANGER') {
      skip.set('m15_volatility', features['h1_volatility']);
    }
  }

  let combinedMultiplier = 1.0;
  const keyFactors = [];

  for (const [cat, val] of Object.entries(features)) {
    if (skip.has(cat)) continue;

    const key = `${cat}:${val}`;
    let mult = 1.0;

    // Ưu tiên 1: Trọng số đã huấn luyện từ data/ai_rule_config.json (featureWeights)
    // Ngoại lệ: btc_flash / orderbook_wall / spread_slippage ưu tiên riskPenaltyProfile đã hiệu chỉnh
    const useProfileFirst = (cat === 'btc_flash' || cat === 'spread_slippage' || cat === 'orderbook_wall');
    if (!useProfileFirst && weights[key] && typeof weights[key].multiplier === 'number') {
      mult = weights[key].multiplier;
    } else if (dynamicModifiers[key] !== undefined) {
      mult = dynamicModifiers[key];
    } else if (weights[key] && typeof weights[key].multiplier === 'number') {
      mult = weights[key].multiplier;
    }

    // 🎯 Baseline Anchoring: Trạng thái bình thường / chuẩn mực không bao giờ bị hạ dưới 1.00
    const isBaselineNormal = val.endsWith('_NORMAL') ||
      val.endsWith('_NEUTRAL') ||
      val.endsWith('_BALANCED') ||
      val.endsWith('_SAFE') ||
      val === 'H1_HOLD_OR_HOVER' ||
      val === 'M15_HOLD_OR_HOVER' ||
      val === 'BOUNCE_FRESH' ||
      val === 'WALL_CLEAR_PATH';
    if (isBaselineNormal && mult < 1.00) {
      mult = 1.00;
    }

    if (Math.abs(mult - 1.0) >= 0.02) {
      combinedMultiplier *= mult;
      const pctDiff = Math.round((mult - 1) * 100);
      keyFactors.push(`${val} (${pctDiff >= 0 ? '+' : ''}${pctDiff}%)`);
    }
  }

  // Tính xác suất thắng Bayes
  const priorOdds = priorWin / (1 - priorWin);
  const posteriorOdds = priorOdds * combinedMultiplier;
  const winProbability = posteriorOdds / (1 + posteriorOdds);

  const rawThreshold = _modelConfig?.thresholdApprovalPct || 40;
  const approvalThreshold = rawThreshold > 1 ? (rawThreshold / 100) : rawThreshold;

  // 🎯 CỔNG LỢI NHUẬN KỲ VỌNG RÒNG (NET EV SAU PHÍ & TRƯỢT GIÁ)
  const roundtripCostPct = parseFloat(process.env.ROUNDTRIP_FEE_SLIPPAGE_PCT || '0.12');
  const effSlPct = (typeof sig?.slPct === 'number' && sig.slPct > 0)
    ? sig.slPct
    : (typeof marketContext?.slPct === 'number' && marketContext.slPct > 0 ? marketContext.slPct : 2.0);
  const effTpPct = (typeof sig?.tpPct === 'number' && sig.tpPct > 0)
    ? sig.tpPct
    : (typeof marketContext?.tpPct === 'number' && marketContext.tpPct > 0 ? marketContext.tpPct : effSlPct * 1.5);
  const effLev = Math.max(1, parseFloat(sig?.leverage || marketContext?.leverage || 5));
  const feeRoi = roundtripCostPct * effLev;
  const netTpRoi = Math.max(0.5, (effTpPct * effLev) - feeRoi);
  const netSlRoi = (effSlPct * effLev) + feeRoi;
  const netEvRoi = (winProbability * netTpRoi) - ((1 - winProbability) * netSlRoi);
  const minNetEvRoi = parseFloat(process.env.MIN_NET_EV_ROI || '0.5');

  const isWinProbOk = winProbability >= approvalThreshold;
  const isEvOk = netEvRoi >= minNetEvRoi;
  const isApproved = isWinProbOk && isEvOk;

  const reason = isApproved
    ? `Duyệt lệnh (WinProb ${(winProbability * 100).toFixed(1)}% >= ${(approvalThreshold * 100).toFixed(1)}%, NetEV +${netEvRoi.toFixed(2)}% ROI) | Yếu tố: ${keyFactors.join(', ') || 'Cấu trúc ổn định'}`
    : (!isWinProbOk
      ? `VETO từ chối (WinProb ${(winProbability * 100).toFixed(1)}% < ${(approvalThreshold * 100).toFixed(1)}%) | Vi phạm: ${keyFactors.join(', ')}`
      : `VETO NetEV thấp (WinProb ${(winProbability * 100).toFixed(1)}%, NetEV ${netEvRoi.toFixed(2)}% < +${minNetEvRoi.toFixed(2)}% ROI sau phí) | Yếu tố: ${keyFactors.join(', ') || 'R:R không bù phí'}`);

  return {
    isApproved,
    winProbability: parseFloat(winProbability.toFixed(3)),
    expectedValueRoi: parseFloat(netEvRoi.toFixed(2)),
    confidenceScore: sig.score || 7.0,
    multiplier: parseFloat(combinedMultiplier.toFixed(2)),
    keyFactors,
    features,
    riskInteraction,
    modelVersion: _modelConfig?.version || 'default',
    totalSamples: _modelConfig?.totalSamples || 0,
    reason,
    mode: 'LOCAL'
  };
}

module.exports = {
  evaluateSignal,
  extractGatekeeperFeatures,
  classifyCandleGeometry,
  loadModel,
  checkModelHotReload
};
