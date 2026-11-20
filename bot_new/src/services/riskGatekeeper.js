'use strict';

/**
 * riskGatekeeper.js — AI Bản Thân Cục Bộ (Local Machine Learning Gatekeeper)
 *
 * - 0ms execution, 0 Token, 0 USD, hoàn toàn offline
 * - Nạp mô hình xác suất Bayes từ data/ai_rule_config.json (10.493 mẫu thực tế)
 * - Đánh giá vi cấu trúc nến M15/H1, biến tốc BTC 180s, orderbook wall
 * - Triệt tiêu phạt kép (nhường chấm điểm trend/volume cho Confluence Scorer)
 * - Cấu hình linh hoạt qua AI_GATEKEEPER_MODE ('LOCAL' hoặc 'DISABLED')
 */

const fs = require('fs');
const path = require('path');
const { getStep } = require('./tierSLTP');
const { log } = require('./logger');

function resolveSharedModelPath() {
  const candidates = [
    path.resolve(process.cwd(), 'data', 'ai_rule_config.json'),
    path.resolve(__dirname, '../../../data', 'ai_rule_config.json'),
    path.resolve(__dirname, '../../data', 'ai_rule_config.json')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const MODEL_PATH = resolveSharedModelPath();
let _modelConfig = null;

function loadModel() {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const raw = fs.readFileSync(MODEL_PATH, 'utf8');
      _modelConfig = JSON.parse(raw);
      log.system(`[PP369] [AI Reviewer] ✓ Đã nạp thành công mô hình AI (v${_modelConfig.version || '1.4.0-auto'}, mẫu N=${_modelConfig.totalSamples || 0})`);
    } else {
      log.warn(`[RiskGatekeeper] Chưa tìm thấy ${MODEL_PATH}. Sử dụng trọng số mặc định.`);
    }
  } catch (err) {
    log.error(`[RiskGatekeeper] Lỗi nạp mô hình: ${err.message}`);
  }
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
 * Thẩm định tín hiệu giao dịch
 * @param {Object} sig - { symbol, signal, targetLevel, score, scoreReasons }
 * @param {Object} marketContext - { candleH1, candleM15, btcFlash, orderbookWall }
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
  }

  const priorWin = _modelConfig?.priorWinProb || 0.565;
  const isLong = (sig.signal === 'LONG' || sig.signal === 'BUY');
  const targetLevel = sig.targetLevel || sig.price || 0;
  const step = getStep(targetLevel);

  let combinedMultiplier = 1.0;
  const keyFactors = [];

  // 1. Đánh giá hình thái nến M15 & H1
  const cM15 = marketContext?.candleM15;
  const cH1 = marketContext?.candleH1;

  if (cM15) {
    const geoM15 = classifyCandleGeometry(cM15, targetLevel, isLong, step, false);
    if (geoM15 === 'REJECT_PINBAR') {
      combinedMultiplier *= 1.15;
      keyFactors.push('M15_PINBAR_REJECTION (+15%)');
    } else if (geoM15 === 'PUNCTURED_DEEP') {
      combinedMultiplier *= 0.40;
      keyFactors.push('M15_PUNCTURED_DEEP (-60%)');
    } else if (geoM15 === 'PUNCTURED_LIGHT') {
      combinedMultiplier *= 0.75;
      keyFactors.push('M15_PUNCTURED_LIGHT (-25%)');
    }
  }

  if (cH1) {
    const geoH1 = classifyCandleGeometry(cH1, targetLevel, isLong, step, false);
    if (geoH1 === 'REJECT_PINBAR') {
      combinedMultiplier *= 1.20;
      keyFactors.push('H1_PINBAR_REJECTION (+20%)');
    } else if (geoH1 === 'PUNCTURED_DEEP') {
      combinedMultiplier *= 0.30;
      keyFactors.push('H1_PUNCTURED_DEEP (-70%)');
    }
  }

  // 2. Kiểm tra biến tốc BTC Flash Guard 180s
  const btcFlash = marketContext?.btcFlash;
  if (btcFlash === 'FLASH_DUMP' && isLong) {
    combinedMultiplier *= 0.15;
    keyFactors.push('BTC_FLASH_DUMP_AGAINST_LONG (-85%)');
  } else if (btcFlash === 'FLASH_PUMP' && !isLong) {
    combinedMultiplier *= 0.15;
    keyFactors.push('BTC_FLASH_PUMP_AGAINST_SHORT (-85%)');
  }

  // 3. Kiểm tra Orderbook Wall
  const wall = marketContext?.orderbookWall;
  if (wall === 'OPPOSING_BLOCK') {
    combinedMultiplier *= 0.45;
    keyFactors.push('ORDERBOOK_WALL_BLOCK (-55%)');
  } else if (wall === 'SUPPORT_SHIELD') {
    combinedMultiplier *= 1.12;
    keyFactors.push('ORDERBOOK_WALL_SHIELD (+12%)');
  }

  // 4. Tính toán xác suất thắng Bayes
  const priorOdds = priorWin / (1 - priorWin);
  const posteriorOdds = priorOdds * combinedMultiplier;
  const winProbability = posteriorOdds / (1 + posteriorOdds);

  const rawThreshold = _modelConfig?.thresholdApprovalPct || 40;
  const approvalThreshold = rawThreshold > 1 ? (rawThreshold / 100) : rawThreshold;
  const isApproved = winProbability >= approvalThreshold;

  let reason = '';
  if (isApproved) {
    reason = `Duyệt lệnh (WinProb ${(winProbability * 100).toFixed(1)}% >= ${(approvalThreshold * 100).toFixed(1)}%) | Yếu tố: ${keyFactors.join(', ') || 'Cấu trúc ổn định'}`;
  } else {
    reason = `VETO từ chối (WinProb ${(winProbability * 100).toFixed(1)}% < ${(approvalThreshold * 100).toFixed(1)}%) | Vi phạm: ${keyFactors.join(', ')}`;
  }

  return {
    isApproved,
    winProbability: parseFloat(winProbability.toFixed(3)),
    confidenceScore: sig.score || 7.0,
    multiplier: parseFloat(combinedMultiplier.toFixed(2)),
    keyFactors,
    reason,
    mode: 'LOCAL'
  };
}

module.exports = {
  evaluateSignal,
  classifyCandleGeometry,
  loadModel
};
