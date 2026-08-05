'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');

const { exec } = require('child_process');

const MODEL_PATH = path.join(process.cwd(), 'data', 'ai_rule_config.json');
const AI_EVALUATIONS_FILE = path.join(process.cwd(), 'data', 'ai_evaluations.jsonl');
const RETRAIN_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // Tự động re-train mỗi 3 ngày

let _modelConfig = null;

function loadAIModel() {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const raw = fs.readFileSync(MODEL_PATH, 'utf8');
      _modelConfig = JSON.parse(raw);
      log.system(`[AI Reviewer] ✓ Đã nạp thành công mô hình AI (v${_modelConfig.version || '1.0'}, mẫu N=${_modelConfig.totalSamples})`);
    } else {
      log.warn(`[AI Reviewer] Chưa tìm thấy file mô hình tại ${MODEL_PATH}. Sử dụng bộ lọc mặc định.`);
    }
  } catch (err) {
    log.error(`[AI Reviewer] Lỗi nạp mô hình AI: ${err.message}`);
  }
}

function runAutoRetrain() {
  log.system('[AI Reviewer] 🔄 Tự động kích hoạt Python re-train mô hình AI trong nền...');
  const scriptPath = path.join(process.cwd(), 'scripts', 'train_ai_model.py');
  exec(`python "${scriptPath}"`, (error, stdout, stderr) => {
    if (error) {
      log.warn(`[AI Reviewer] Lỗi tự động re-train mô hình AI: ${error.message}`);
      return;
    }
    log.system('[AI Reviewer] 🎉 Đã hoàn tất tự động re-train mô hình AI! Nạp lại trọng số mới...');
    loadAIModel();
  });
}

function startAutoRetrainTimer() {
  if (_modelConfig && _modelConfig.trainedAt) {
    const lastTrainedMs = new Date(_modelConfig.trainedAt).getTime();
    if (isNaN(lastTrainedMs) || (Date.now() - lastTrainedMs > RETRAIN_INTERVAL_MS)) {
      runAutoRetrain();
    }
  } else {
    runAutoRetrain();
  }
  // Đặt lịch chạy định kỳ mỗi 3 ngày
  setInterval(runAutoRetrain, RETRAIN_INTERVAL_MS);
}

// Nạp mô hình và khởi chạy bộ đếm tự động re-train khi module được load
loadAIModel();
startAutoRetrainTimer();

function extractSignalFeatures(reasons, score, rank, gridWidthPct) {
  const reasonsStr = Array.isArray(reasons) ? reasons.join(' ') : String(reasons || '');
  const features = {};

  // 1. Score Group
  if (score >= 7.0) features['score_group'] = 'SCORE_HIGH_GE7';
  else if (score >= 6.0) features['score_group'] = 'SCORE_MID_6_TO_7';
  else if (score >= 5.0) features['score_group'] = 'SCORE_LOW_5_TO_6';
  else features['score_group'] = 'SCORE_WEAK_LT5';

  // 2. MarketCap Rank
  if (rank <= 10) features['rank_group'] = 'RANK_TOP10';
  else if (rank <= 30) features['rank_group'] = 'RANK_TOP30';
  else if (rank <= 150) features['rank_group'] = 'RANK_MIDCAP_150';
  else features['rank_group'] = 'RANK_LOWCAP_OUT150';

  // 3. Trend
  if (reasonsStr.includes('Dow & Trendline')) features['trend'] = 'TREND_PERFECT';
  else if (reasonsStr.includes('EMA20<EMA50') || reasonsStr.includes('EMA20>EMA50')) features['trend'] = 'TREND_EMA';
  else if (reasonsStr.includes('Ngược/Mâu thuẫn')) features['trend'] = 'TREND_CONFLICT';
  else features['trend'] = 'TREND_NEUTRAL';

  // 4. Volatility
  if (reasonsStr.includes('H1 siêu nén')) features['volatility'] = 'VOL_ULTRA';
  else if (reasonsStr.includes('H1 nén vừa')) features['volatility'] = 'VOL_MID';
  else features['volatility'] = 'VOL_WEAK';

  // 5. RSI
  if (reasonsStr.includes('Quá bán cực đại') || reasonsStr.includes('Quá mua cực đại')) features['rsi'] = 'RSI_EXTREME';
  else if (reasonsStr.includes('Cận quá bán') || reasonsStr.includes('Cận quá mua')) features['rsi'] = 'RSI_NEAR';
  else features['rsi'] = 'RSI_NEUTRAL';

  // 6. Whales vs Retail Flow
  if (reasonsStr.includes('Gold Setup') || reasonsStr.includes('Đồng thuận tuyệt đối')) features['ls_flow'] = 'LS_GOLD';
  else if (reasonsStr.includes('Đồng thuận một phần')) features['ls_flow'] = 'LS_PARTIAL';
  else if (reasonsStr.includes('Không đồng thuận') || reasonsStr.includes('phân kỳ')) features['ls_flow'] = 'LS_DIVERGENCE';
  else features['ls_flow'] = 'LS_NEUTRAL';

  // 7. Price Action S/R Levels
  if (reasonsStr.includes('4 cản cũ')) features['price_action'] = 'PA_4_LEVELS';
  else if (reasonsStr.includes('3 cản cũ')) features['price_action'] = 'PA_3_LEVELS';
  else if (reasonsStr.includes('2 cản cũ')) features['price_action'] = 'PA_2_LEVELS';
  else if (reasonsStr.includes('1 cản cũ')) features['price_action'] = 'PA_1_LEVEL';
  else features['price_action'] = 'PA_0_LEVEL';

  // 8. Open Interest (OI) Change
  if (reasonsStr.includes('Hạ nhiệt vị thế') || reasonsStr.includes('giảm -')) features['oi_change'] = 'OI_COOLING';
  else if (reasonsStr.includes('Tăng mạnh') || reasonsStr.includes('bùng nổ')) features['oi_change'] = 'OI_SURGE';
  else features['oi_change'] = 'OI_STABLE';

  // 9. Volume Momentum
  if (reasonsStr.includes('Volume bùng nổ')) features['volume'] = 'VOL_SURGE';
  else if (reasonsStr.includes('Volume ổn định')) features['volume'] = 'VOL_STABLE';
  else features['volume'] = 'VOL_DRY';

  // 10. Funding Rate
  if (reasonsStr.includes('Short Crowded') || reasonsStr.includes('Long Crowded')) features['funding'] = 'FUNDING_SQUEEZE';
  else if (reasonsStr.includes('Short đu bám') || reasonsStr.includes('Long đu bám') || reasonsStr.includes('Nóng')) features['funding'] = 'FUNDING_DANGER';
  else features['funding'] = 'FUNDING_NORMAL';

  // 11. BTC Wave
  if (reasonsStr.includes('BTC thuận Dow/EMA')) features['btc_wave'] = 'BTC_ALIGNED';
  else if (reasonsStr.includes('BTC đi ngang/trung tính')) features['btc_wave'] = 'BTC_NEUTRAL';
  else features['btc_wave'] = 'BTC_COUNTER';

  // 12. Grid Width Pct
  const gw = parseFloat(gridWidthPct) || 3.5;
  if (gw > 5.0) features['grid_width'] = 'GRID_WIDE';
  else if (gw >= 2.5) features['grid_width'] = 'GRID_NORMAL';
  else features['grid_width'] = 'GRID_NARROW';

  return features;
}

/**
 * Evaluates signal context before placing order
 *
 * @param {object} sig - Signal object from core.js
 * @returns {object} { winProbability: number, isApproved: boolean, reason: string }
 */
function evaluateSignalWithAI(sig) {
  if (!_modelConfig) loadAIModel();

  const defaultThreshold = 65.0;
  const threshold = _modelConfig?.thresholdApprovalPct || defaultThreshold;
  const priorWin = _modelConfig?.priorWinProb || 0.645;
  const weights = _modelConfig?.featureWeights || {};

  const score = parseFloat(sig.score) || 0;
  const rank = parseInt(sig.marketCapRank) || 999;
  const gridWidthPct = parseFloat(sig.gridWidthPct) || 3.5;
  const reasons = sig.scoreReasons || [];

  const features = extractSignalFeatures(reasons, score, rank, gridWidthPct);

  let combinedMultiplier = 1.0;
  const keyFactors = [];

  for (const [cat, val] of Object.entries(features)) {
    const key = `${cat}:${val}`;
    if (weights[key]) {
      const mult = weights[key].multiplier;
      combinedMultiplier *= mult;

      if (mult >= 1.08) {
        keyFactors.push(`+ ${val} (x${mult})`);
      } else if (mult <= 0.92) {
        keyFactors.push(`- ${val} (x${mult})`);
      }
    }
  }

  // Calculate posterior win probability using odds-ratio Bayesian update
  const priorOdds = priorWin / (1 - priorWin);
  const posteriorOdds = priorOdds * combinedMultiplier;
  let winProb = (posteriorOdds / (1 + posteriorOdds)) * 100;

  // Bound winProbability strictly between 5% and 95%
  winProb = Math.max(5.0, Math.min(95.0, winProb));

  const isApproved = winProb >= threshold;
  const factorSummary = keyFactors.length > 0 ? keyFactors.join(', ') : 'Điều kiện trung tính';
  const reasonText = isApproved
    ? `Xác suất thắng ${winProb.toFixed(1)}% >= ${threshold}% (${factorSummary})`
    : `Xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% (${factorSummary})`;

  return {
    winProbability: parseFloat(winProb.toFixed(1)),
    isApproved,
    reason: reasonText,
  };
}

/**
 * Log evaluation result to data/data/ai_evaluations.jsonl for shadow testing
 */
function recordAIEvaluation(sig, aiEval) {
  try {
    const record = {
      timestamp: Date.now(),
      symbol: sig.symbol || sig.sym,
      signal: sig.signal,
      targetLevel: sig.targetLevel,
      score: sig.score,
      winProbability: aiEval.winProbability,
      isApprovedByAI: aiEval.isApproved,
      aiReason: aiEval.reason,
      marketCapRank: sig.marketCapRank || null,
      gridWidthPct: sig.gridWidthPct || null,
      scoreReasons: sig.scoreReasons || [],
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFile(AI_EVALUATIONS_FILE, line, 'utf8', (err) => {
      if (err) log.error(`[AI Reviewer] Lỗi ghi file ai_evaluations.jsonl: ${err.message}`);
    });
  } catch (err) {
    log.error(`[AI Reviewer] Lỗi ghi log đánh giá AI: ${err.message}`);
  }
}

module.exports = {
  evaluateSignalWithAI,
  recordAIEvaluation,
  loadAIModel,
};
