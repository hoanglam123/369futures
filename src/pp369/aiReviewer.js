'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');
const { isTurnoverBlocked } = require('./turnoverGuard');

const { exec } = require('child_process');

const MODEL_PATH = path.join(process.cwd(), 'data', 'ai_rule_config.json');
const AI_EVALUATIONS_FILE = path.join(process.cwd(), 'data', 'ai_evaluations.jsonl');
const RETRAIN_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // Tự động re-train mỗi 3 ngày

let _modelConfig = null;
let _lastModelMtimeMs = 0;
let _lastMtimeCheckMs = 0;

function loadAIModel() {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const stats = fs.statSync(MODEL_PATH);
      const raw = fs.readFileSync(MODEL_PATH, 'utf8');
      _modelConfig = JSON.parse(raw);
      _lastModelMtimeMs = stats.mtimeMs;
      log.system(`[AI Reviewer] ✓ Đã nạp thành công mô hình AI (v${_modelConfig.version || '1.0'}, mẫu N=${_modelConfig.totalSamples})`);
    } else {
      log.warn(`[AI Reviewer] Chưa tìm thấy file mô hình tại ${MODEL_PATH}. Sử dụng bộ lọc mặc định.`);
    }
  } catch (err) {
    log.error(`[AI Reviewer] Lỗi nạp mô hình AI: ${err.message}`);
  }
}

function checkModelHotReload(force = false) {
  const now = Date.now();
  if (!force && (now - _lastMtimeCheckMs < 15000)) return { reloaded: false }; // Throttle 15 giây
  _lastMtimeCheckMs = now;
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const stats = fs.statSync(MODEL_PATH);
      if (force || stats.mtimeMs > _lastModelMtimeMs) {
        log.system('[AI Reviewer] ⚡ Phát hiện file mô hình AI mới trên đĩa! Đang tự động nạp lại (Hot-Reload)...');
        loadAIModel();
        return { reloaded: true, version: _modelConfig ? _modelConfig.version : null };
      }
    }
  } catch (e) {
    // bỏ qua lỗi kiểm tra mtime
  }
  return { reloaded: false };
}

function runAutoRetrain() {
  log.system('[AI Reviewer] 🔄 Tự động kích hoạt Python re-train mô hình AI trong nền...');
  const scriptPath = path.join(process.cwd(), 'scripts', 'train_ai_model.py');
  const pyCmd = process.env.PYTHON_BIN || 'python3';

  exec(`${pyCmd} "${scriptPath}"`, (error, stdout, stderr) => {
    if (error) {
      // Fallback thử tiếp lệnh 'python' nếu 'python3' thất bại (hoặc ngược lại)
      const fallbackCmd = pyCmd === 'python3' ? 'python' : 'python3';
      exec(`${fallbackCmd} "${scriptPath}"`, (err2, stdout2, stderr2) => {
        if (err2) {
          log.warn(`[AI Reviewer] Lỗi tự động re-train mô hình AI: ${error.message} (Fallback '${fallbackCmd}' cũng thất bại: ${err2.message})`);
          return;
        }
        log.system('[AI Reviewer] 🎉 Đã hoàn tất tự động re-train mô hình AI! Nạp lại trọng số mới...');
        loadAIModel();
      });
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

function extractSignalFeatures(reasons, score, rank, gridWidthPct, rawMarketData = null, signal = 'LONG', entryPrice = null, timestamp = null) {
  const reasonsStr = Array.isArray(reasons) ? reasons.join(' ') : String(reasons || '');
  const features = {};

  // 1. Score Group
  if (score >= 7.0) features['score_group'] = 'SCORE_HIGH_GE7';
  else if (score >= 6.0) features['score_group'] = 'SCORE_MID_6_TO_7';
  else if (score >= 5.0) features['score_group'] = 'SCORE_LOW_5_TO_6';
  else if (score >= 4.0) features['score_group'] = 'SCORE_WEAK_4_TO_5';
  else features['score_group'] = 'SCORE_DANGER_LT4';

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
  else if (reasonsStr.includes('Không đồng thuận') || reasonsStr.includes('phân kỳ') || reasonsStr.includes('Cá voi không đạt')) features['ls_flow'] = 'LS_DIVERGENCE';
  else if (reasonsStr.includes('Đồng thuận một phần')) features['ls_flow'] = 'LS_PARTIAL';
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

  // ── [MỚI] 13. Candlestick Geometry AI (Đo hình thái nến M15/H1 thực tế) ──
  if (rawMarketData?.lastM15) {
    const { open, high, low, close } = rawMarketData.lastM15;
    const totalRange = Math.max(1e-9, high - low);
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const isLong = signal === 'LONG' || signal === 'BUY';
    const m15VolRatio = parseFloat(rawMarketData?.m15VolRatio) || 1.0;
    const m15RangePct = parseFloat(rawMarketData?.m15RangePct) || 0.0;
    const isSpike = m15RangePct > 1.4 && m15VolRatio >= 2.5;

    if (isLong) {
      if (lowerWick / totalRange >= 0.40 && !isSpike) {
        features['candle_shape'] = 'CANDLE_PINBAR_HAMMER';
      } else if (isSpike || (close < open && (body / totalRange >= 0.70) && (entryPrice ? close <= entryPrice : true))) {
        features['candle_shape'] = 'CANDLE_MARUBOZU_DUMP';
      } else {
        features['candle_shape'] = 'CANDLE_NORMAL';
      }
    } else {
      if (upperWick / totalRange >= 0.40 && !isSpike) {
        features['candle_shape'] = 'CANDLE_PINBAR_SHOOTING';
      } else if (isSpike || (close > open && (body / totalRange >= 0.70) && (entryPrice ? close >= entryPrice : true))) {
        features['candle_shape'] = 'CANDLE_MARUBOZU_PUMP';
      } else {
        features['candle_shape'] = 'CANDLE_NORMAL';
      }
    }
  }

  // ── [MỚI] 14. Touch Count / Level Freshness ──
  if (typeof rawMarketData?.touchCount === 'number') {
    if (rawMarketData.touchCount <= 1) {
      features['level_freshness'] = 'FRESH_LEVEL_TOUCH1';
    } else if (rawMarketData.touchCount === 2) {
      features['level_freshness'] = 'RETEST_LEVEL_TOUCH2';
    } else {
      features['level_freshness'] = 'EXHAUSTED_LEVEL_TOUCH3';
    }
  }

  // ── [MỚI] 15. BTC Flash Pump / Dump Market Regime ──
  const isShort = signal === 'SHORT' || signal === 'SELL';
  const isLong = signal === 'LONG' || signal === 'BUY';
  if (rawMarketData?.btcFlashPump && isShort) {
    features['btc_flash'] = 'BTC_FLASH_PUMP_ACTIVE';
  } else if (rawMarketData?.btcFlashDump && isLong) {
    features['btc_flash'] = 'BTC_FLASH_DUMP_ACTIVE';
  } else {
    features['btc_flash'] = 'BTC_FLASH_NORMAL';
  }

  // ── [MỚI] 16. Abnormal Turnover Guard (MarketCap < 100M & Vol 24H / MC > 8%) ──
  const sym = rawMarketData?.symbol || '';
  if (rawMarketData?.isTurnoverBlocked || (sym && isTurnoverBlocked(sym))) {
    features['turnover_guard'] = 'TURNOVER_RISK_BLOCKED';
  } else {
    features['turnover_guard'] = 'TURNOVER_NORMAL';
  }

  // ── [MỚI] 17. Trading Session & Time-of-Day ──
  const now = new Date(timestamp || Date.now());
  const vnHour = (now.getUTCHours() + 7) % 24;
  const vnDay = now.getUTCDay(); // 0: CN, 6: T7

  if (vnDay === 0 || vnDay === 6) {
    features['trading_session'] = 'SESSION_WEEKEND';
  } else if (vnHour >= 7 && vnHour < 14) {
    features['trading_session'] = 'SESSION_ASIA'; // 07h - 14h VN: Nén đẹp, sóng êm
  } else if (vnHour >= 14 && vnHour < 19.5) {
    features['trading_session'] = 'SESSION_EUROPE'; // 14h - 19h30 VN: Âu vào lệnh
  } else if (vnHour >= 19.5 && vnHour < 23.5) {
    features['trading_session'] = 'SESSION_US_OPEN'; // 19h30 - 23h30 VN: Biến động giật mạnh nhất ngày
  } else {
    features['trading_session'] = 'SESSION_US_LATE'; // Đêm/Rạng sáng VN
  }

  // ── [MỚI] 18. Multi-Factor Risk Interactions (Tương tác rủi ro do AI tự lượng hóa) ──
  const isTrendConflict = features['trend'] === 'TREND_CONFLICT';
  const isLsDiv = features['ls_flow'] === 'LS_DIVERGENCE';
  const isNoSR = features['price_action'] === 'PA_0_LEVEL';
  const isDryVol = features['volume'] === 'VOL_DRY';
  const isCoolingOi = features['oi_change'] === 'OI_COOLING';

  if (isTrendConflict && isLsDiv) {
    features['risk_interaction'] = 'INTERACTION_TREND_FLOW_CONFLICT';
  } else if (isNoSR && (isTrendConflict || isLsDiv || features['trend'] === 'TREND_NEUTRAL')) {
    features['risk_interaction'] = 'INTERACTION_NO_SR_WEAK_SETUP';
  } else if (isDryVol && isCoolingOi) {
    features['risk_interaction'] = 'INTERACTION_DRY_VOL_COOLING_OI';
  } else {
    features['risk_interaction'] = 'INTERACTION_BALANCED';
  }

  // ── 19. Phân loại vốn hóa Lowcap vs Majors được đảm nhiệm qua:
  // - Đặc trưng rank_group (RANK_LOWCAP_OUT150 vs RANK_TOP10/30/MIDCAP)
  // - Ngưỡng phê duyệt WinProbability (68% cho Lowcap vs 60% cho Majors)
  // Không tạo thêm các feature lowcap_* trùng lặp để tuân thủ Naive Bayes.

  return features;
}

/**
 * Evaluates signal context before placing order
 *
 * @param {object} sig - Signal object from core.js
 * @param {object} [rawMarketData=null] - Optional raw market metrics (candle geometry, touch count, btc flash)
 * @returns {object} { winProbability: number, isApproved: boolean, reason: string }
 */
function evaluateSignalWithAI(sig, rawMarketData = null) {
  if (!_modelConfig) {
    loadAIModel();
  } else {
    checkModelHotReload();
  }

  const priorWin = _modelConfig?.priorWinProb || 0.565;
  const weights = _modelConfig?.featureWeights || {};

  // Custom weights for raw market features and risk interactions
  const dynamicModifiers = {
    'score_group:SCORE_DANGER_LT4': 0.50,         // Phạt trừ 50% WinProb cho Score < 4đ -> Veto ngay
    'score_group:SCORE_WEAK_4_TO_5': 0.85,
    'candle_shape:CANDLE_PINBAR_HAMMER': 1.08,    // [HẠ NHIỆT] Giảm từ 1.25 (+25%) xuống 1.08 (+8%) để tránh râu nến M15 thổi phồng WinProb
    'candle_shape:CANDLE_PINBAR_SHOOTING': 1.08,  // [HẠ NHIỆT] Giảm từ 1.25 (+25%) xuống 1.08 (+8%) để tránh râu nến M15 thổi phồng WinProb
    'candle_shape:CANDLE_MARUBOZU_DUMP': 0.45,  // Phạt nặng nến đâm cản -> Tự động Veto
    'candle_shape:CANDLE_MARUBOZU_PUMP': 0.45,  // Phạt nặng nến đâm cản -> Tự động Veto
    'candle_shape:CANDLE_NORMAL': 1.00,
    'level_freshness:FRESH_LEVEL_TOUCH1': 1.12,
    'level_freshness:RETEST_LEVEL_TOUCH2': 0.95,
    'level_freshness:EXHAUSTED_LEVEL_TOUCH3': 0.70,
    'btc_flash:BTC_FLASH_PUMP_ACTIVE': 0.35,     // Phạt nặng bão BTC Flash Pump khi đánh SHORT -> Veto ngay
    'btc_flash:BTC_FLASH_DUMP_ACTIVE': 0.35,     // Phạt nặng bão BTC Flash Dump khi đánh LONG -> Veto ngay
    'btc_flash:BTC_FLASH_NORMAL': 1.00,
    'turnover_guard:TURNOVER_RISK_BLOCKED': 0.30, // Phạt nặng coin Low-Cap bị bơm xả Turnover > 8% -> AI Veto ngay
    'turnover_guard:TURNOVER_NORMAL': 1.00,
    'price_action:PA_0_LEVEL': 0.85,              // [LÕI AI] Rỗng cản S/R là rủi ro rất cao, phạt 15% (x0.85) thay vì chỉ trừ 5%
    'ls_flow:LS_DIVERGENCE': 0.80,                // [CÂN BẰNG] Phạt vừa phải 20% khi dòng tiền Cá voi và Retail phân kỳ ngược nhau
    'risk_interaction:INTERACTION_TREND_FLOW_CONFLICT': 1.00, // Tự động thích ứng hoàn toàn theo weights học được (fallback trung tính 1.00)
    'risk_interaction:INTERACTION_NO_SR_WEAK_SETUP': 0.65,      // Fallback nếu chưa có trong weights
    'risk_interaction:INTERACTION_DRY_VOL_COOLING_OI': 0.80,     // Fallback nếu chưa có trong weights
    'risk_interaction:INTERACTION_BALANCED': 1.00,
    'trading_session:SESSION_ASIA': 1.02,        // Phiên Á nén chuẩn, sóng êm -> Thưởng nhẹ +2%
    'trading_session:SESSION_EUROPE': 1.01,      // Phiên Âu sóng đều -> Thưởng nhẹ +1%
    'trading_session:SESSION_US_OPEN': 0.98,     // Phiên Mỹ mở cửa -> Thận trọng nhẹ -2%
    'trading_session:SESSION_US_LATE': 1.00,     // Bình thường
    'trading_session:SESSION_WEEKEND': 0.98      // Cuối tuần vol mỏng -> Thận trọng nhẹ -2%
  };

  const score = parseFloat(sig.score) || 0;
  const rank = parseInt(sig.marketCapRank) || 999;
  const gridWidthPct = parseFloat(sig.gridWidthPct) || 3.5;
  const reasons = sig.scoreReasons || [];
  const entryPrice = sig.targetLevel || sig.price || null;
  const sym = sig.symbol || sig.sym || '';

  const mergedMarketData = { ...(rawMarketData || {}), symbol: sym };
  const features = extractSignalFeatures(reasons, score, rank, gridWidthPct, mergedMarketData, sig.signal, entryPrice, sig.timestamp);

  let combinedMultiplier = 1.0;
  const keyFactors = [];

  // 🛡️ DOUBLE-COUNTING PREVENTION:
  // risk_interaction là feature tổng hợp của (trend + ls_flow + price_action + volume + oi).
  // Khi một conflict tương tác đã được capture bởi INTERACTION_*, bỏ qua
  // feature thành phần tương ứng để tránh âm 2 lần vào cùng một riủi ro.
  const riskInteraction = features['risk_interaction'];
  const skipForInteraction = new Set();
  if (riskInteraction === 'INTERACTION_TREND_FLOW_CONFLICT') {
    // Trend conflict + LS_DIVERGENCE đã capture bởi interaction → bỏ qua riêng lẽ
    skipForInteraction.add('trend');
    skipForInteraction.add('ls_flow');
  } else if (riskInteraction === 'INTERACTION_NO_SR_WEAK_SETUP') {
    // PA_0_LEVEL đã capture bời interaction → bỏ qua riêng lẽ
    skipForInteraction.add('price_action');
  } else if (riskInteraction === 'INTERACTION_DRY_VOL_COOLING_OI') {
    // VOL_DRY + OI_COOLING đã capture bởi interaction → bỏ qua riêng lẽ
    skipForInteraction.add('volume');
    skipForInteraction.add('oi_change');
  }

  for (const [cat, val] of Object.entries(features)) {
    const key = `${cat}:${val}`;
    let mult = 1.0;

    // 🚫 Bỏ qua feature đã được capture bởi risk_interaction (tránh double-counting)
    if (skipForInteraction.has(cat)) {
      keyFactors.push(`∅ ${val} (skip: included in ${riskInteraction})`);
      continue;
    }

    // 🧠 Ưu tiên số 1: Trọng số do AI tự học từ dữ liệu thực tế (weights[key])
    if (weights[key]) {
      mult = weights[key].multiplier;
    } else if (dynamicModifiers[key]) {
      mult = dynamicModifiers[key];
    }

    // 🛡️ SANITY GUARD: Không thưởng Pinbar M15 nếu đang ngược Trend Dow H1 & EMA
    if (features['trend'] === 'TREND_CONFLICT' && (val === 'CANDLE_PINBAR_HAMMER' || val === 'CANDLE_PINBAR_SHOOTING')) {
      mult = 1.00;
    }

    combinedMultiplier *= mult;

    if (mult >= 1.03) {
      keyFactors.push(`+ ${val} (x${mult.toFixed(2)})`);
    } else if (mult <= 0.97) {
      keyFactors.push(`- ${val} (x${mult.toFixed(2)})`);
    }
  }

  // Calculate posterior win probability using odds-ratio Bayesian update
  const priorOdds = priorWin / (1 - priorWin);
  const posteriorOdds = priorOdds * combinedMultiplier;
  let winProb = (posteriorOdds / (1 + posteriorOdds)) * 100;

  // Bound winProbability strictly between 5% and 95%
  winProb = Math.max(5.0, Math.min(95.0, winProb));

  // ── [MỚI] TỰ ĐỘNG NẠP NGƯỠNG TỐI ƯU DO AI TỰ HỌC (AUTONOMOUS THRESHOLD CALIBRATION) ──
  // Ngưỡng không bao giờ cố định cứng (hardcoded) mà được mô hình AI tự tính toán tối ưu từ dữ liệu thực tế
  const optimalTh = _modelConfig?.optimalThresholds || {};
  const baseTop150 = optimalTh.top150 ?? 46.0;
  const baseLowcap = optimalTh.lowcap ?? 48.0;
  let threshold = (rank <= 150) ? baseTop150 : baseLowcap;

  // 🌊 MARKET REGIME FLEXIBILITY (Co giãn theo nhịp thở thị trường)
  // Thuận sóng BTC: Tự tin nới nhẹ -0.5% để đón sóng
  // Ngược sóng BTC hoặc bão Flash: Tự động siết thêm +1.0% để bảo vệ vốn
  if (features['btc_wave'] === 'BTC_ALIGNED') {
    threshold = Math.max(40.0, threshold - 0.5);
  } else if (features['btc_wave'] === 'BTC_COUNTER' || features['btc_flash'] !== 'BTC_FLASH_NORMAL') {
    threshold += 1.0;
  }

  // ── 🎯 TÍNH TOÁN LỢI NHUẬN KỲ VỌNG (EXPECTED VALUE - EV) CHUẨN XÁC THEO TIER VÀ GRID ──
  const minEvRoiThreshold = optimalTh.minExpectedEvRoi ?? _modelConfig?.minExpectedEvRoi ?? 0.0;

  // Với hệ thống Tier Leverage: calcLeverage = 50 / slPct -> Lỗ khi dính SL luôn chuẩn ~50.0% ROI
  const estSlRoi = 50.0;

  // TP neo theo tỷ lệ 45% độ rộng Grid (dao động 1.2% - 3.0%), quy đổi sang ROI % theo tỷ lệ đòn bẩy:
  const isLowcap = rank > 150;
  const defaultSlPct = isLowcap ? 1.8 : 1.0;
  // Lấy khoảng cách SL thực tế từ mốc cản của tín hiệu nếu có, fallback về defaultSlPct:
  const effSlPct = (typeof sig.actualSlPct === 'number' && sig.actualSlPct > 0) ? sig.actualSlPct : defaultSlPct;
  const tpGridPct = Math.min(Math.max(gridWidthPct * 0.45, 1.2), 3.0);
  const estTpRoi = Math.max(10.0, Math.min(100.0, (tpGridPct / effSlPct) * 50.0));

  const winProbDec = winProb / 100.0;
  const evRoi = (winProbDec * estTpRoi) - ((1.0 - winProbDec) * estSlRoi);
  const tradeMargin = parseFloat(sig.margin) || 75;
  const evUsd = (evRoi / 100.0) * tradeMargin;

  // ── AI LÀ NGƯỜI RA QUYẾT ĐỊNH 100% ──
  // Quyết định duyệt hay phủ quyết hoàn toàn dựa trên Xác suất thắng dự đoán (WinProbability >= threshold)
  // và Lợi Nhuận Kỳ Vọng (EV >= minEvRoiThreshold), được AI tổng hợp từ toàn bộ các tiêu chí thị trường.
  const isApproved = winProb >= threshold && evRoi >= minEvRoiThreshold;
  const factorSummary = keyFactors.length > 0 ? keyFactors.join(', ') : 'Điều kiện trung tính';

  let vetoCategory = null;
  let reasonText = '';

  if (!isApproved) {
    if (features['risk_interaction'] && features['risk_interaction'].startsWith('INTERACTION_') && features['risk_interaction'] !== 'INTERACTION_BALANCED') {
      vetoCategory = features['risk_interaction'];
      reasonText = `[ĐÁNH GIÁ RỦI RO AI: ${features['risk_interaction']}] Xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% [Rank #${rank}] (${factorSummary})`;
    } else if (winProb < threshold) {
      vetoCategory = `WINPROB_LT_${threshold}`;
      reasonText = `Xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% [Rank #${rank}] (${factorSummary})`;
    } else if (evRoi < minEvRoiThreshold) {
      vetoCategory = 'EV_BELOW_THRESHOLD';
      const rrNotice = (effSlPct > tpGridPct) ? ` [R:R bất lợi: Cản SL ${effSlPct.toFixed(2)}% > TP ${tpGridPct.toFixed(2)}%]` : '';
      reasonText = `Xác suất thắng ${winProb.toFixed(1)}% >= ${threshold}%, nhưng Lợi Nhuận Kỳ Vọng (EV) âm/thấp (${evRoi.toFixed(2)}% ROI, $${evUsd.toFixed(2)})${rrNotice} (${factorSummary})`;
    } else {
      vetoCategory = 'AI_VETO';
      reasonText = `Phủ quyết bởi AI [Rank #${rank}] (${factorSummary})`;
    }
  } else {
    reasonText = `Xác suất thắng ${winProb.toFixed(1)}% >= ${threshold}% [Rank #${rank}] & EV = +${evRoi.toFixed(2)}% ROI ($${evUsd.toFixed(2)}) (${factorSummary})`;
  }

  return {
    winProbability: parseFloat(winProb.toFixed(1)),
    threshold: parseFloat(threshold.toFixed(1)),
    expectedValueRoi: parseFloat(evRoi.toFixed(2)),
    expectedValueUsd: parseFloat(evUsd.toFixed(2)),
    isApproved,
    vetoCategory,
    reason: reasonText,
    keyFactors,
  };
}

/**
 * Log evaluation result to data/ai_evaluations.jsonl for shadow testing
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
      expectedValueRoi: aiEval.expectedValueRoi,
      expectedValueUsd: aiEval.expectedValueUsd,
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
  checkModelHotReload,
};
