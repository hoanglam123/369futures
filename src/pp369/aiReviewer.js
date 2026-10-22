'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./_logger');
const { isTurnoverBlocked } = require('./turnoverGuard');
const { classifyCandleGeometry, getStep } = require('./core');
const { checkEconomicBlackout } = require('../trader/economicCalendar');

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
  const timer = setInterval(runAutoRetrain, RETRAIN_INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
}

// Nạp mô hình và khởi chạy bộ đếm tự động re-train khi module được load
loadAIModel();
startAutoRetrainTimer();

function extractSignalFeatures(reasons, score, rank, gridWidthPct, rawMarketData = null, signal = 'LONG', entryPrice = null, timestamp = null) {
  const reasonsStr = Array.isArray(reasons) ? reasons.join(' ') : String(reasons || '');
  const features = {};

  const sm = rawMarketData?.signalMetrics || null;

  // 1. MarketCap Rank
  if (rank <= 10) features['rank_group'] = 'RANK_TOP10';
  else if (rank <= 30) features['rank_group'] = 'RANK_TOP30';
  else if (rank <= 150) features['rank_group'] = 'RANK_MIDCAP_150';
  else features['rank_group'] = 'RANK_LOWCAP_OUT150';

  // 3. Trend Alignment
  if (sm?.trend || rawMarketData?.trend) {
    features['trend'] = sm?.trend || rawMarketData?.trend;
  } else if (rawMarketData?.currH1 && rawMarketData?.currH1.ema20 && rawMarketData?.currH1.ema50) {
    const isEmaBull = rawMarketData.currH1.ema20 > rawMarketData.currH1.ema50;
    const isLong = signal === 'LONG' || signal === 'BUY';
    features['trend'] = (isLong === isEmaBull) ? 'TREND_EMA' : 'TREND_CONFLICT';
  } else if (reasonsStr.includes('Dow & Trendline')) features['trend'] = 'TREND_PERFECT';
  else if (reasonsStr.includes('H1 Sideway nhưng M15 có cấu trúc')) features['trend'] = 'TREND_M15_ALIGNED';
  else if (reasonsStr.includes('EMA20<EMA50') || reasonsStr.includes('EMA20>EMA50')) features['trend'] = 'TREND_EMA';
  else if (reasonsStr.includes('Ngược/Mâu thuẫn')) features['trend'] = 'TREND_CONFLICT';
  else features['trend'] = 'TREND_NEUTRAL';

  // 3b. ADX Momentum Strength
  if (sm?.adxStrength) {
    features['adx_strength'] = sm.adxStrength;
  } else if (typeof sm?.adx === 'number') {
    features['adx_strength'] = sm.adx >= 25.0 ? 'ADX_STRONG_TREND' : 'ADX_WEAK_TREND';
  } else {
    const adxMatch = reasonsStr.match(/ADX=(\d+\.?\d*)/);
    if (adxMatch) {
      const adxVal = parseFloat(adxMatch[1]);
      features['adx_strength'] = adxVal >= 25.0 ? 'ADX_STRONG_TREND' : 'ADX_WEAK_TREND';
    } else {
      features['adx_strength'] = 'ADX_NORMAL';
    }
  }

  // 4 & 4b. H1 & M15 Volatility Compression (Tách biệt 100% Số Học Thuần Túy)
  const mm = rawMarketData?.marketMetrics;
  const hasCandleData = Boolean(mm || rawMarketData?.currH1 || rawMarketData?.currM15);

  if (hasCandleData) {
    // Nhánh 1: Dữ liệu số học chuẩn xác (Độc lập 100%, không dính dáng text)
    const currH1Range = mm?.h1RangePct ?? (rawMarketData?.currH1 ? ((rawMarketData.currH1.high - rawMarketData.currH1.low) / (rawMarketData.currH1.low || 1)) * 100 : null);
    const lastH1Range = mm?.lastClosedH1RangePct ?? (rawMarketData?.lastClosedH1 ? ((rawMarketData.lastClosedH1.high - rawMarketData.lastClosedH1.low) / (rawMarketData.lastClosedH1.low || 1)) * 100 : null);
    let maxKlinesH1Range = null;
    if (Array.isArray(rawMarketData?.h1Klines) && rawMarketData.h1Klines.length > 0) {
      maxKlinesH1Range = Math.max(...rawMarketData.h1Klines.slice(-3).map(k => (((k.high ?? k[2]) - (k.low ?? k[3])) / ((k.low ?? k[3]) || 1)) * 100));
    }
    const maxH1Range = Math.max(...[currH1Range, lastH1Range, mm?.max3H1RangePct, maxKlinesH1Range].filter(r => typeof r === 'number' && !isNaN(r)), 0.0);

    if (maxH1Range >= 8.0) {
      features['h1_volatility'] = 'H1_EXTREME_STORM_PUMP_DUMP';
    } else if (maxH1Range >= 4.0) {
      features['h1_volatility'] = 'H1_VOLATILE_DANGER';
    } else if (maxH1Range <= 1.5) {
      features['h1_volatility'] = 'H1_ULTRA_COMPRESSED';
    } else if (maxH1Range <= 2.5) {
      features['h1_volatility'] = 'H1_MID_COMPRESSED';
    } else {
      features['h1_volatility'] = 'H1_VOL_NORMAL';
    }

    const m15Vol = mm?.m15VolRatio ?? (parseFloat(rawMarketData?.m15VolRatio) || 1.0);
    const currM15Range = mm?.m15RangePct ?? (rawMarketData?.currM15 ? ((rawMarketData.currM15.high - rawMarketData.currM15.low) / (rawMarketData.currM15.low || 1)) * 100 : null);
    const lastM15Range = mm?.lastClosedM15RangePct ?? (rawMarketData?.lastClosedM15 ? ((rawMarketData.lastClosedM15.high - rawMarketData.lastClosedM15.low) / (rawMarketData.lastClosedM15.low || 1)) * 100 : null);
    const maxM15Range = Math.max(...[currM15Range, lastM15Range].filter(r => typeof r === 'number'), 0.0);

    if (maxM15Range >= 6.0) {
      features['m15_volatility'] = 'M15_EXTREME_STORM';
    } else if (m15Vol >= 3.0 || maxM15Range >= 3.0) {
      features['m15_volatility'] = 'M15_VOLATILE_DANGER';
    } else if (m15Vol >= 2.0) {
      features['m15_volatility'] = 'M15_VOLUME_SURGE';
    } else if (maxM15Range <= 0.8) {
      features['m15_volatility'] = 'M15_ULTRA_COMPRESSED';
    } else if (maxM15Range <= 1.5) {
      features['m15_volatility'] = 'M15_MID_COMPRESSED';
    } else {
      features['m15_volatility'] = 'M15_VOL_NORMAL';
    }
  } else {
    // Nhánh 2: Dự phòng (Fallback) cho các bản ghi cũ chưa có số liệu nến
    if (reasonsStr.includes('H1 bão giá') || reasonsStr.includes('biến động cực đại')) {
      features['h1_volatility'] = 'H1_EXTREME_STORM_PUMP_DUMP';
    } else if (reasonsStr.includes('H1 biến động mạnh') || reasonsStr.includes('đều biến động mạnh')) {
      features['h1_volatility'] = 'H1_VOLATILE_DANGER';
    } else if (reasonsStr.includes('H1 siêu nén')) {
      features['h1_volatility'] = 'H1_ULTRA_COMPRESSED';
    } else if (reasonsStr.includes('H1 nén vừa')) {
      features['h1_volatility'] = 'H1_MID_COMPRESSED';
    } else {
      features['h1_volatility'] = 'H1_VOL_NORMAL';
    }

    if (reasonsStr.includes('M15 bão giá')) {
      features['m15_volatility'] = 'M15_EXTREME_STORM';
    } else if (reasonsStr.includes('M15 đột biến Volume') || reasonsStr.includes('đột biến Volume')) {
      features['m15_volatility'] = 'M15_VOLUME_SURGE';
    } else if (reasonsStr.includes('M15 biến động mạnh') || reasonsStr.includes('đều biến động mạnh')) {
      features['m15_volatility'] = 'M15_VOLATILE_DANGER';
    } else if (reasonsStr.includes('M15 siêu nén')) {
      features['m15_volatility'] = 'M15_ULTRA_COMPRESSED';
    } else if (reasonsStr.includes('M15 nén vừa')) {
      features['m15_volatility'] = 'M15_MID_COMPRESSED';
    } else {
      features['m15_volatility'] = 'M15_VOL_NORMAL';
    }
  }


  // 5. RSI (Số học thuần túy từ giá trị RSI 14 nến)
  if (sm?.rsiCondition) {
    features['rsi'] = sm.rsiCondition;
  } else if (typeof sm?.rsi === 'number' || typeof rawMarketData?.rsi === 'number') {
    const rsiVal = sm?.rsi ?? rawMarketData?.rsi;
    if (rsiVal >= 75 || rsiVal <= 25) features['rsi'] = 'RSI_EXTREME';
    else if (rsiVal >= 65 || rsiVal <= 35) features['rsi'] = 'RSI_NEAR';
    else features['rsi'] = 'RSI_NEUTRAL';
  } else if (reasonsStr.includes('Quá bán cực đại') || reasonsStr.includes('Quá mua cực đại')) {
    features['rsi'] = 'RSI_EXTREME';
  } else if (reasonsStr.includes('Cận quá bán') || reasonsStr.includes('Cận quá mua')) {
    features['rsi'] = 'RSI_NEAR';
  } else {
    features['rsi'] = 'RSI_NEUTRAL';
  }

  // 6. Whales vs Retail Flow (Số học từ tỷ lệ Long/Short cá voi vs retail)
  if (sm?.lsFlow) {
    features['ls_flow'] = sm.lsFlow;
  } else if (typeof sm?.whaleLongRatio === 'number' && typeof sm?.retailLongRatio === 'number') {
    const w = sm.whaleLongRatio;
    const r = sm.retailLongRatio;
    const isL = signal === 'LONG' || signal === 'BUY';
    const whaleAligned = isL ? (w >= 60.0) : (w <= 40.0);
    const retailAligned = isL ? (r <= 45.0) : (r >= 55.0);
    if (whaleAligned && retailAligned) features['ls_flow'] = 'LS_GOLD';
    else if (whaleAligned) features['ls_flow'] = 'LS_PARTIAL';
    else if (!whaleAligned && !retailAligned) features['ls_flow'] = 'LS_DIVERGENCE';
    else features['ls_flow'] = 'LS_NEUTRAL';
  } else if (reasonsStr.includes('Gold Setup') || reasonsStr.includes('Đồng thuận tuyệt đối')) {
    features['ls_flow'] = 'LS_GOLD';
  } else if (reasonsStr.includes('Đồng thuận một phần')) {
    features['ls_flow'] = 'LS_PARTIAL';
  } else if (reasonsStr.includes('Không đồng thuận') || reasonsStr.includes('phân kỳ') || reasonsStr.includes('Cá voi không đạt')) {
    features['ls_flow'] = 'LS_DIVERGENCE';
  } else {
    features['ls_flow'] = 'LS_NEUTRAL';
  }

  // 7. Price Action S/R Levels (Số học từ số lượng cản H4 + D1)
  if (sm?.priceAction) {
    features['price_action'] = sm.priceAction;
  } else if (typeof sm?.h4SrCount === 'number' || typeof sm?.d1SrCount === 'number') {
    const totalSr = (sm?.h4SrCount || 0) + (sm?.d1SrCount || 0);
    if (totalSr >= 4) features['price_action'] = 'PA_4_LEVELS';
    else if (totalSr === 3) features['price_action'] = 'PA_3_LEVELS';
    else if (totalSr === 2) features['price_action'] = 'PA_2_LEVELS';
    else if (totalSr === 1) features['price_action'] = 'PA_1_LEVEL';
    else features['price_action'] = 'PA_0_LEVEL';
  } else if (reasonsStr.includes('4 cản cũ')) {
    features['price_action'] = 'PA_4_LEVELS';
  } else if (reasonsStr.includes('3 cản cũ')) {
    features['price_action'] = 'PA_3_LEVELS';
  } else if (reasonsStr.includes('2 cản cũ')) {
    features['price_action'] = 'PA_2_LEVELS';
  } else if (reasonsStr.includes('1 cản cũ')) {
    features['price_action'] = 'PA_1_LEVEL';
  } else {
    features['price_action'] = 'PA_0_LEVEL';
  }

  // 7b. Price Action S/R Quality (Phân cấp cản D1 bảo trợ vs H4 ngắn hạn vs Không cản)
  if (sm?.srQuality) {
    features['sr_quality'] = sm.srQuality;
  } else if (typeof sm?.d1SrCount === 'number' || typeof sm?.h4SrCount === 'number') {
    if ((sm?.d1SrCount || 0) >= 1) features['sr_quality'] = 'SR_DAILY_D1_INCLUDED';
    else if ((sm?.h4SrCount || 0) >= 1) features['sr_quality'] = 'SR_H4_ONLY';
    else features['sr_quality'] = 'SR_NONE';
  } else {
    const d1Part = reasonsStr.includes('D1:') ? reasonsStr.split('D1:')[1] : '';
    const hasD1 = Boolean(d1Part && !d1Part.includes('không cản') && !d1Part.includes('thiếu nến'));
    const h4Part = reasonsStr.includes('H4:') ? reasonsStr.split('H4:')[1].split('|')[0] : '';
    const hasH4 = Boolean(h4Part && !h4Part.includes('chỉ có 0 cản') && !h4Part.includes('0 cản cũ') && !h4Part.includes('thiếu nến'));

    if (hasD1) {
      features['sr_quality'] = 'SR_DAILY_D1_INCLUDED';
    } else if (hasH4) {
      features['sr_quality'] = 'SR_H4_ONLY';
    } else {
      features['sr_quality'] = 'SR_NONE';
    }
  }

  // 8. Open Interest (OI) Change (Số học từ % thay đổi OI)
  if (sm?.oiState) {
    features['oi_change'] = sm.oiState;
  } else if (typeof sm?.oiChangePct === 'number') {
    if (sm.oiChangePct <= -1.0) features['oi_change'] = 'OI_COOLING';
    else if (sm.oiChangePct >= 2.0) features['oi_change'] = 'OI_SURGE';
    else features['oi_change'] = 'OI_STABLE';
  } else if (reasonsStr.includes('Hạ nhiệt vị thế') || reasonsStr.includes('giảm -')) {
    features['oi_change'] = 'OI_COOLING';
  } else if (reasonsStr.includes('Tăng mạnh') || reasonsStr.includes('bùng nổ')) {
    features['oi_change'] = 'OI_SURGE';
  } else {
    features['oi_change'] = 'OI_STABLE';
  }

  // 9. Volume Momentum (Số học từ tỷ lệ volume / trung bình 20 nến)
  if (sm?.volumeState) {
    features['volume'] = sm.volumeState;
  } else if (typeof sm?.volumeRatio === 'number') {
    if (sm.volumeRatio >= 2.0) features['volume'] = 'VOL_SURGE';
    else if (sm.volumeRatio >= 0.8) features['volume'] = 'VOL_STABLE';
    else features['volume'] = 'VOL_DRY';
  } else if (reasonsStr.includes('Volume bùng nổ')) {
    features['volume'] = 'VOL_SURGE';
  } else if (reasonsStr.includes('Volume ổn định')) {
    features['volume'] = 'VOL_STABLE';
  } else {
    features['volume'] = 'VOL_DRY';
  }

  // 9b. H1 3-Candle Volume Burst (Bão Volume H1 số học)
  if (sm?.h1VolumeBurst) {
    features['h1_volume_burst'] = sm.h1VolumeBurst;
  } else if (Array.isArray(rawMarketData?.h1Klines) && rawMarketData.h1Klines.length >= 24) {
    const klines = rawMarketData.h1Klines;
    const past20 = klines.slice(-24, -3);
    const avgVol = past20.reduce((s, c) => s + (typeof c.volume === 'number' ? c.volume : (c[5] || 0)), 0) / past20.length;
    const last3 = klines.slice(-3);
    const maxLast3Vol = Math.max(...last3.map(c => (typeof c.volume === 'number' ? c.volume : (c[5] || 0))));
    features['h1_volume_burst'] = (avgVol > 0 && (maxLast3Vol / avgVol >= 2.5)) ? 'H1_VOL_BURST_DANGER' : 'H1_VOL_BURST_NORMAL';
  } else if (reasonsStr.includes('Đột biến Volume 3 H1')) {
    features['h1_volume_burst'] = 'H1_VOL_BURST_DANGER';
  } else {
    features['h1_volume_burst'] = 'H1_VOL_BURST_NORMAL';
  }

  // 10. Funding Rate (Số học từ tỷ lệ Funding)
  if (sm?.fundingState) {
    features['funding'] = sm.fundingState;
  } else if (typeof sm?.fundingRate === 'number') {
    const isL = signal === 'LONG' || signal === 'BUY';
    const fr = sm.fundingRate;
    if (isL && fr <= -0.05) features['funding'] = 'FUNDING_SQUEEZE';
    else if (!isL && fr >= 0.05) features['funding'] = 'FUNDING_SQUEEZE';
    else if (Math.abs(fr) >= 0.05) features['funding'] = 'FUNDING_DANGER';
    else features['funding'] = 'FUNDING_NORMAL';
  } else if (reasonsStr.includes('Short Crowded') || reasonsStr.includes('Long Crowded')) {
    features['funding'] = 'FUNDING_SQUEEZE';
  } else if (reasonsStr.includes('Short đu bám') || reasonsStr.includes('Long đu bám') || reasonsStr.includes('Nóng')) {
    features['funding'] = 'FUNDING_DANGER';
  } else {
    features['funding'] = 'FUNDING_NORMAL';
  }

  // 11. BTC Wave
  if (sm?.btcWave) {
    features['btc_wave'] = sm.btcWave;
  } else if (rawMarketData?.btcWave) {
    features['btc_wave'] = rawMarketData.btcWave;
  } else if (reasonsStr.includes('BTC thuận Dow/EMA')) {
    features['btc_wave'] = 'BTC_ALIGNED';
  } else if (reasonsStr.includes('BTC đi ngang/trung tính')) {
    features['btc_wave'] = 'BTC_NEUTRAL';
  } else {
    features['btc_wave'] = 'BTC_COUNTER';
  }

  // 11b. BTC M15 Extreme Volatility Storm (> 1.0% số học)
  if (sm?.btcStorm) {
    features['btc_storm'] = sm.btcStorm;
  } else if (typeof rawMarketData?.btcM15Pct === 'number') {
    features['btc_storm'] = rawMarketData.btcM15Pct > 1.0 ? 'BTC_STORM_VOLATILE' : 'BTC_STORM_NORMAL';
  } else if (reasonsStr.includes('BTC bão giá')) {
    features['btc_storm'] = 'BTC_STORM_VOLATILE';
  } else {
    features['btc_storm'] = 'BTC_STORM_NORMAL';
  }

  // 12. Grid Width Pct
  const gw = parseFloat(gridWidthPct) || 3.5;
  if (gw > 5.0) features['grid_width'] = 'GRID_WIDE';
  else if (gw >= 2.5) features['grid_width'] = 'GRID_NORMAL';
  else features['grid_width'] = 'GRID_NARROW';

  // 12b. Pre-Entry Bounce (Đo đạc số học độ nảy trước khi khớp lệnh)
  let bouncePct = null;
  if (typeof rawMarketData?.maxRecentBouncePct === 'number') {
    bouncePct = rawMarketData.maxRecentBouncePct;
  }
  const preEntryThreshold = (typeof rawMarketData?.preEntryBouncePct === 'number')
    ? rawMarketData.preEntryBouncePct
    : 1.25;

  const extremeBounceThreshold = Math.max(3.0, preEntryThreshold * 1.8);
  if (bouncePct !== null) {
    if (bouncePct >= extremeBounceThreshold || rawMarketData?.isPreEntryExtremeStale) {
      features['pre_entry_bounce'] = 'BOUNCE_STALE_EXTREME';
    } else if (bouncePct >= preEntryThreshold || rawMarketData?.isPreEntryStale) {
      features['pre_entry_bounce'] = 'BOUNCE_STALE_HIGH';
    } else if (bouncePct >= 0.40) {
      features['pre_entry_bounce'] = 'BOUNCE_MODERATE';
    } else {
      features['pre_entry_bounce'] = 'BOUNCE_FRESH';
    }
  } else if (reasonsStr.includes('nảy cực xa') || rawMarketData?.isPreEntryExtremeStale) {
    features['pre_entry_bounce'] = 'BOUNCE_STALE_EXTREME';
  } else if (reasonsStr.includes('Giá đã nảy xa mốc') || rawMarketData?.isPreEntryStale) {
    features['pre_entry_bounce'] = 'BOUNCE_STALE_HIGH';
  } else if (reasonsStr.includes('Giá chớm nảy')) {
    features['pre_entry_bounce'] = 'BOUNCE_MODERATE';
  } else {
    features['pre_entry_bounce'] = 'BOUNCE_FRESH';
  }

  // ── [MỚI] 13. Candlestick Geometry AI (Đo hình thái nến M15 & H1 so với Entry) ──
  let h1Geom = sm?.h1CandleGeometry || 'H1_HOLD_OR_HOVER';
  let m15Geom = sm?.m15CandleGeometry || 'M15_HOLD_OR_HOVER';

  // 13a. Đọc từ reasonsStr nếu có sẵn (fallback khi không có signalMetrics)
  if (!sm?.h1CandleGeometry) {
    if (reasonsStr.includes('H1 đóng nến lụt sâu')) h1Geom = 'H1_PUNCTURED_DEEP';
    else if (reasonsStr.includes('H1 đóng nến chớm lụt')) h1Geom = 'H1_PUNCTURED_LIGHT';
    else if (reasonsStr.includes('H1 rút chân') || reasonsStr.includes('H1 rút râu')) h1Geom = 'H1_REJECT_PINBAR';
  }

  if (!sm?.m15CandleGeometry) {
    if (reasonsStr.includes('M15 đóng nến lụt sâu')) m15Geom = 'M15_PUNCTURED_DEEP';
    else if (reasonsStr.includes('M15 đóng nến chớm lụt')) m15Geom = 'M15_PUNCTURED_LIGHT';
    else if (reasonsStr.includes('M15 rút chân') || reasonsStr.includes('M15 rút râu')) m15Geom = 'M15_REJECT_PINBAR';
  }

  // 13b. Đo đạc trực tiếp từ rawMarketData nếu có dữ liệu nến thực tế
  const isLong = signal === 'LONG' || signal === 'BUY';
  const isShort = signal === 'SHORT' || signal === 'SELL';
  const targetLevel = entryPrice || rawMarketData?.targetLevel || rawMarketData?.lastM15?.open;
  const step = rawMarketData?.step || (targetLevel ? getStep(targetLevel) : 0);

  if (targetLevel && (rawMarketData?.currH1 || rawMarketData?.lastClosedH1)) {
    const c1 = rawMarketData.currH1;
    const c2 = rawMarketData.lastClosedH1;
    const g1 = classifyCandleGeometry(c1, targetLevel, isLong, step);
    const g2 = classifyCandleGeometry(c2, targetLevel, isLong, step);
    if (g1 === 'PUNCTURED_DEEP' || g2 === 'PUNCTURED_DEEP') h1Geom = 'H1_PUNCTURED_DEEP';
    else if (g1 === 'PUNCTURED_LIGHT' || g2 === 'PUNCTURED_LIGHT') h1Geom = 'H1_PUNCTURED_LIGHT';
    else if (g1 === 'REJECT_PINBAR' || g2 === 'REJECT_PINBAR') h1Geom = 'H1_REJECT_PINBAR';
  }

  if (targetLevel && (rawMarketData?.currM15 || rawMarketData?.lastClosedM15 || rawMarketData?.lastM15)) {
    const c1 = rawMarketData.currM15 || rawMarketData.lastM15;
    const c2 = rawMarketData.lastClosedM15;
    const g1 = classifyCandleGeometry(c1, targetLevel, isLong, step);
    const g2 = classifyCandleGeometry(c2, targetLevel, isLong, step);
    if (g1 === 'PUNCTURED_DEEP' || g2 === 'PUNCTURED_DEEP') m15Geom = 'M15_PUNCTURED_DEEP';
    else if (g1 === 'PUNCTURED_LIGHT' || g2 === 'PUNCTURED_LIGHT') m15Geom = 'M15_PUNCTURED_LIGHT';
    else if (g1 === 'REJECT_PINBAR' || g2 === 'REJECT_PINBAR') m15Geom = 'M15_REJECT_PINBAR';
  }

  features['h1_candle_geometry'] = h1Geom;
  features['m15_candle_geometry'] = m15Geom;

  // 13c. Tương tác đóng nến đâm lụt
  if (h1Geom === 'H1_PUNCTURED_DEEP' && (m15Geom === 'M15_PUNCTURED_DEEP' || m15Geom === 'M15_PUNCTURED_LIGHT')) {
    features['puncture_interaction'] = 'INTERACTION_H1_M15_PUNCTURED';
  } else if (h1Geom === 'H1_PUNCTURED_DEEP') {
    features['puncture_interaction'] = 'INTERACTION_H1_PUNCTURED_DEEP';
  } else if (m15Geom === 'M15_PUNCTURED_DEEP') {
    features['puncture_interaction'] = 'INTERACTION_M15_PUNCTURED_DEEP';
  } else {
    features['puncture_interaction'] = 'INTERACTION_PUNCTURE_NORMAL';
  }

  // 13d. Tương thích ngược: Candlestick Geometry Shape (Pinbar / Marubozu)
  if (rawMarketData?.lastM15) {
    const { open, high, low, close } = rawMarketData.lastM15;
    const totalRange = Math.max(1e-9, high - low);
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const m15VolRatio = parseFloat(rawMarketData?.m15VolRatio) || 1.0;
    const m15RangePct = parseFloat(rawMarketData?.m15RangePct) || 0.0;
    const isSpike = m15RangePct > 1.4 && m15VolRatio >= 2.5;

    if (isLong) {
      if (lowerWick / totalRange >= 0.40 && !isSpike) {
        features['candle_shape'] = 'CANDLE_PINBAR_HAMMER';
      } else if (isSpike || (close < open && (body / totalRange >= 0.70) && (targetLevel ? close <= targetLevel : true))) {
        features['candle_shape'] = 'CANDLE_MARUBOZU_DUMP';
      } else {
        features['candle_shape'] = 'CANDLE_NORMAL';
      }
      if (upperWick / totalRange >= 0.50) {
        features['wick_rejection'] = 'OPPOSING_WICK_TRAP';
      }
    } else {
      if (upperWick / totalRange >= 0.40 && !isSpike) {
        features['candle_shape'] = 'CANDLE_PINBAR_SHOOTING';
      } else if (isSpike || (close > open && (body / totalRange >= 0.70) && (targetLevel ? close >= targetLevel : true))) {
        features['candle_shape'] = 'CANDLE_MARUBOZU_PUMP';
      } else {
        features['candle_shape'] = 'CANDLE_NORMAL';
      }
      if (lowerWick / totalRange >= 0.50) {
        features['wick_rejection'] = 'OPPOSING_WICK_TRAP';
      }
    }
  }

  if (sm?.m15WickRejection) {
    features['wick_rejection'] = sm.m15WickRejection;
  }

  // ── [MỚI] 15. BTC Flash Pump / Dump Market Regime ──
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

  // ── 18. M15 Dynamic Candle Momentum vs Signal Direction (Chống chặn đầu xe lửa Pump/Dump) ──
  const sigDir = (signal || '').toUpperCase();
  const mmData = rawMarketData?.marketMetrics;
  if (mmData) {
    const isGreen = mmData.m15IsGreen;
    const m15Range = mmData.m15RangePct || 0.0;
    const m15Body = mmData.m15BodyPct || 0.0;
    const m15Vol = mmData.m15VolRatio || 1.0;

    if ((sigDir === 'SHORT' || sigDir === 'SELL') && isGreen === true && (m15Body >= 3.0 || m15Range >= 5.0 || (m15Range >= 3.5 && m15Vol >= 3.0))) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_PUMP_TRAIN';
    } else if ((sigDir === 'LONG' || sigDir === 'BUY') && isGreen === false && (m15Body >= 3.0 || m15Range >= 5.0 || (m15Range >= 3.5 && m15Vol >= 3.0))) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_DUMP_TRAIN';
    } else {
      features['candle_momentum'] = 'MOMENTUM_NORMAL';
    }
  } else if (rawMarketData?.currM15) {
    const c = rawMarketData.currM15;
    const isGreen = c.close >= c.open;
    const rangePct = ((c.high - c.low) / (c.low || 1)) * 100;
    const bodyPct = (Math.abs(c.close - c.open) / (c.low || 1)) * 100;
    const volRatio = parseFloat(rawMarketData?.m15VolRatio) || 1.0;

    if ((sigDir === 'SHORT' || sigDir === 'SELL') && isGreen && (bodyPct >= 3.0 || rangePct >= 5.0 || (rangePct >= 3.5 && volRatio >= 3.0))) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_PUMP_TRAIN';
    } else if ((sigDir === 'LONG' || sigDir === 'BUY') && !isGreen && (bodyPct >= 3.0 || rangePct >= 5.0 || (rangePct >= 3.5 && volRatio >= 3.0))) {
      features['candle_momentum'] = 'MOMENTUM_COUNTER_DUMP_TRAIN';
    } else {
      features['candle_momentum'] = 'MOMENTUM_NORMAL';
    }
  } else {
    features['candle_momentum'] = 'MOMENTUM_NORMAL';
  }

  // ── [MỚI] 19. Multi-Factor Risk Interactions (Tương tác rủi ro do AI tự lượng hóa) ──
  const isTrendConflict = features['trend'] === 'TREND_CONFLICT';
  const isLsDiv = features['ls_flow'] === 'LS_DIVERGENCE';
  const isNoSR = features['price_action'] === 'PA_0_LEVEL';
  const isDryVol = features['volume'] === 'VOL_DRY';
  const isCoolingOi = features['oi_change'] === 'OI_COOLING';
  const isVolDanger = features['h1_volatility'] === 'H1_VOLATILE_DANGER' ||
    features['m15_volatility'] === 'M15_VOLATILE_DANGER' ||
    features['m15_volatility'] === 'M15_VOLUME_SURGE';
  const isCounterTrain = features['candle_momentum'] === 'MOMENTUM_COUNTER_PUMP_TRAIN' ||
    features['candle_momentum'] === 'MOMENTUM_COUNTER_DUMP_TRAIN';

  // 🛡️ TƯƠNG TÁC ĐA NHÂN TỐ RỦI RO: Nảy cực xa kết hợp Bão BTC / Ngược sóng BTC (áp dụng bình đẳng mọi coin)
  const isStaleExtreme = features['pre_entry_bounce'] === 'BOUNCE_STALE_EXTREME';
  const isStaleHigh = features['pre_entry_bounce'] === 'BOUNCE_STALE_HIGH';
  const isBtcCounter = features['btc_wave'] === 'BTC_COUNTER';
  const isBtcVolatileRegime = features['btc_storm'] === 'BTC_STORM_VOLATILE' || 
                              (features['btc_flash'] && features['btc_flash'] !== 'BTC_FLASH_NORMAL');

  // Giá đã nảy quá xa cản kết hợp bão hoặc ngược sóng BTC -> Kích hoạt rủi ro thoát vị thế
  if (isStaleExtreme || (isStaleHigh && (isBtcVolatileRegime || isTrendConflict || isBtcCounter))) {
    features['risk_interaction'] = 'INTERACTION_STALE_BOUNCE_RUNAWAY';
  } else if (isVolDanger && (isTrendConflict || isLsDiv || isCounterTrain)) {
    features['risk_interaction'] = 'INTERACTION_HIGH_VOLATILITY_WEAK_SETUP';
  } else if (isTrendConflict && isLsDiv) {
    features['risk_interaction'] = 'INTERACTION_TREND_FLOW_CONFLICT';
  } else if (isNoSR && (isTrendConflict || isLsDiv || features['trend'] === 'TREND_NEUTRAL')) {
    features['risk_interaction'] = 'INTERACTION_NO_SR_WEAK_SETUP';
  } else if (isDryVol && isCoolingOi) {
    features['risk_interaction'] = 'INTERACTION_DRY_VOL_COOLING_OI';
  } else {
    features['risk_interaction'] = 'INTERACTION_BALANCED';
  }

  // ── [MỚI] 20. Lịch Kinh Tế Đỏ (CPI, FOMC, NFP Blackout Window) ──
  let isBlackout = false;
  if (rawMarketData?.isEconomicBlackout !== undefined) {
    isBlackout = Boolean(rawMarketData.isEconomicBlackout);
  } else {
    const checkTime = timestamp || rawMarketData?.timestamp || Date.now();
    const eco = checkEconomicBlackout(checkTime, 30);
    isBlackout = eco.isBlackout;
  }
  features['economic_calendar'] = isBlackout ? 'CALENDAR_RED_DANGER' : 'CALENDAR_SAFE';

  // ── [MỚI] 21. Bid-Ask Spread Guard (Độ dãn Spread & Trượt giá Scalping) ──
  let spreadCat = rawMarketData?.microstructure?.spread || rawMarketData?.spreadCategory;
  if (!spreadCat) {
    const spreadPct = parseFloat(rawMarketData?.spreadPct || 0);
    const rk = parseInt(rank || 999, 10);
    let dangerTh = 0.060;
    let cautionTh = 0.035;
    if (rk <= 50) {
      dangerTh = 0.040;
      cautionTh = 0.025;
    } else if (rk <= 150) {
      dangerTh = 0.060;
      cautionTh = 0.035;
    } else {
      dangerTh = 0.080;
      cautionTh = 0.045;
    }

    if (spreadPct > dangerTh) spreadCat = 'SPREAD_WIDE_DANGER';
    else if (spreadPct > cautionTh) spreadCat = 'SPREAD_MEDIUM_CAUTION';
    else spreadCat = 'SPREAD_TIGHT_SAFE';
  }
  features['spread_slippage'] = spreadCat;

  // ── [MỚI] 22. CVD Momentum (Cumulative Volume Delta M1/M5) ──
  let cvdCat = rawMarketData?.microstructure?.cvd || rawMarketData?.cvdCategory || 'CVD_NEUTRAL';
  features['cvd_momentum'] = cvdCat;

  // ── [MỚI] 23. Orderbook Wall Distance (Tường cản L2 trước mắt) ──
  let wallCat = rawMarketData?.microstructure?.wall || rawMarketData?.wallCategory || 'WALL_CLEAR_PATH';
  features['orderbook_wall'] = wallCat;



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

  // 🛡️ Nạp hồ sơ điểm phạt định lượng từ mô hình AI (loại bỏ hoàn toàn hardcode)
  const riskPenalties = _modelConfig?.riskPenaltyProfile || {};
  const stormH1Raw = riskPenalties.h1ExtremeStormRaw ?? 0.60;
  const stormH1Rej = riskPenalties.h1ExtremeStormRejection ?? 0.85;
  const stormM15Raw = riskPenalties.m15ExtremeStormRaw ?? 0.60;
  const stormM15Rej = riskPenalties.m15ExtremeStormRejection ?? 0.85;
  const counterTrendMult = riskPenalties.counterStrongTrend ?? 0.40;
  const oppWickMult = riskPenalties.opposingWickTrap ?? 0.45;
  const ecoRedMult = riskPenalties.economicRed ?? 0.10;
  const spreadWideMult = riskPenalties.spreadWide ?? 0.20;
  const wallBlockMult = riskPenalties.wallOpposingBlock ?? 0.35;
  const btcFlashMult = riskPenalties.btcFlashOpposing ?? 0.08;

  // Custom weights for raw market features and risk interactions
  const dynamicModifiers = {
    'h1_volatility:H1_EXTREME_STORM_PUMP_DUMP': stormH1Raw, // Điểm phạt bão nến từ riskPenaltyProfile (giảm mức phạt từ 0.20 -> 0.60)
    'h1_volatility:H1_VOLATILE_DANGER': 0.75,     // H1 biến động mạnh nguy cơ quét SL (nới từ 0.65 -> 0.75)
    'm15_volatility:M15_EXTREME_STORM': stormM15Raw, // Điểm phạt bão nến từ riskPenaltyProfile (giảm mức phạt từ 0.20 -> 0.60)
    'm15_volatility:M15_VOLATILE_DANGER': 0.75,   // M15 biến động mạnh (nới từ 0.60 -> 0.75)
    'm15_volatility:M15_VOLUME_SURGE': 0.65,      // Đột biến volume M15
    'h1_stagnant:H1_STAGNANT_TRAP': 0.65,         // Nén bế tắc bẫy thanh khoản
    'h1_candle_geometry:H1_PUNCTURED_DEEP': 0.22, // Tỷ lệ thắng thực nghiệm 19.8% (x0.22) -> Veto dứt khoát
    'h1_candle_geometry:H1_PUNCTURED_LIGHT': 0.60,
    'h1_candle_geometry:H1_REJECT_PINBAR': 1.72,  // Tỷ lệ thắng thực nghiệm 65.6% (x1.72)
    'h1_candle_geometry:H1_HOLD_OR_HOVER': 1.55,
    'm15_candle_geometry:M15_PUNCTURED_DEEP': 0.40, // Tỷ lệ thắng thực nghiệm 30.6% (x0.40)
    'm15_candle_geometry:M15_PUNCTURED_LIGHT': 0.46,
    'm15_candle_geometry:M15_REJECT_PINBAR': 1.21,
    'm15_candle_geometry:M15_HOLD_OR_HOVER': 1.19,
    'puncture_interaction:INTERACTION_H1_M15_PUNCTURED': 0.32,
    'puncture_interaction:INTERACTION_H1_PUNCTURED_DEEP': 0.22,
    'puncture_interaction:INTERACTION_M15_PUNCTURED_DEEP': 0.85,
    'puncture_interaction:INTERACTION_PUNCTURE_NORMAL': 1.34,
    'candle_shape:CANDLE_PINBAR_HAMMER': 1.15,
    'candle_shape:CANDLE_PINBAR_SHOOTING': 1.15,
    'candle_shape:CANDLE_MARUBOZU_DUMP': 0.45,
    'candle_shape:CANDLE_MARUBOZU_PUMP': 0.45,
    'candle_shape:CANDLE_NORMAL': 1.00,
    'wick_rejection:OPPOSING_WICK_TRAP': 0.40, // Bẫy rút râu ngược chiều >= 50% -> Phạt -60%
    'pre_entry_bounce:BOUNCE_STALE_EXTREME': 0.45, // Nảy cực xa (>= 3.0% hoặc >= 1.8x mốc khung): Quán tính phá cản mạnh -> Phạt -55%
    'pre_entry_bounce:BOUNCE_STALE_HIGH': 0.90,  // Nảy xa mốc rồi quay đầu: phạt nhẹ thay vì thưởng
    'pre_entry_bounce:BOUNCE_MODERATE': 1.00,
    'pre_entry_bounce:BOUNCE_FRESH': 1.00,
    'trend:TREND_M15_ALIGNED': 1.34,             // M15 cấu trúc hoàn chỉnh khi H1 sideway -> Thưởng +34%
    'adx_strength:ADX_STRONG_TREND': 0.82,       // ADX >= 25 trend mạnh dễ xuyên thủng lưới 369 -> Phạt -18%
    'adx_strength:ADX_WEAK_TREND': 1.29,         // ADX < 25 nén đẹp, dao động mốc chuẩn xác -> Thưởng +29%
    'adx_strength:ADX_NORMAL': 1.00,
    'sr_quality:SR_DAILY_D1_INCLUDED': 1.01,     // Có cản Daily bảo trợ
    'sr_quality:SR_H4_ONLY': 0.93,               // Chỉ có cản H4
    'sr_quality:SR_NONE': 1.00,
    'h1_volume_burst:H1_VOL_BURST_DANGER': 0.81, // Đột biến Volume 3 nến H1 -> Phạt -19%
    'h1_volume_burst:H1_VOL_BURST_NORMAL': 1.05,
    'btc_storm:BTC_STORM_VOLATILE': 0.43,        // BTC bão M15 > 1% -> Phạt -57%
    'btc_storm:BTC_STORM_NORMAL': 1.03,
    'btc_flash:BTC_FLASH_PUMP_ACTIVE': btcFlashMult, // Bão BTC Flash Pump từ riskPenaltyProfile
    'btc_flash:BTC_FLASH_DUMP_ACTIVE': btcFlashMult, // Bão BTC Flash Dump từ riskPenaltyProfile
    'btc_flash:BTC_FLASH_NORMAL': 1.00,
    'turnover_guard:TURNOVER_RISK_BLOCKED': 0.30, // Phạt nặng coin Low-Cap bị bơm xả Turnover > 8%
    'turnover_guard:TURNOVER_NORMAL': 1.00,
    'price_action:PA_0_LEVEL': 1.00,              // Thực nghiệm N=1825 WinRate 51.84%, mốc 369 tự thân là cản chuẩn, không phạt PA_0_LEVEL
    'ls_flow:LS_DIVERGENCE': 0.80,                // [CÂN BẰNG] Phạt vừa phải 20% khi dòng tiền Cá voi và Retail phân kỳ ngược nhau
    'risk_interaction:INTERACTION_STALE_BOUNCE_RUNAWAY': 0.45, // Quán tính nảy cực xa kết hợp Lowcap/Bão BTC -> Phạt dứt khoát -55%
    'risk_interaction:INTERACTION_HIGH_VOLATILITY_WEAK_SETUP': 0.50, // Biến động mạnh kết hợp thế nến/cản yếu -> Veto
    'risk_interaction:INTERACTION_TREND_FLOW_CONFLICT': 0.65, // Phạt 35% khi vừa ngược trend vừa phân kỳ dòng tiền
    'risk_interaction:INTERACTION_NO_SR_WEAK_SETUP': 1.00,      // Trung tính theo dữ liệu thực tế
    'risk_interaction:INTERACTION_DRY_VOL_COOLING_OI': 0.80,     // Fallback nếu chưa có trong weights
    'risk_interaction:INTERACTION_BALANCED': 1.00,
    'economic_calendar:CALENDAR_RED_DANGER': 1.00,  // Thực nghiệm N=39 WinRate 65.4% ~ trung tính, không phạt định kiến
    'economic_calendar:CALENDAR_SAFE': 1.00,
    'spread_slippage:SPREAD_WIDE_DANGER': 1.00,      // Thực nghiệm N=128 WinRate 73.3% ~ coin có sóng mạnh
    'spread_slippage:SPREAD_MEDIUM_CAUTION': 0.95,
    'spread_slippage:SPREAD_TIGHT_SAFE': 1.05,
    'cvd_momentum:CVD_SURGE_ALIGNED': 1.25,        // Taker Buy/Sell đẩy mạnh thuận hướng -> Thưởng +25%
    'cvd_momentum:CVD_DIVERGENCE_OPPOSING': 1.00,  // Thực nghiệm N=484 WinRate 63.2%
    'cvd_momentum:CVD_NEUTRAL': 1.00,
    'orderbook_wall:WALL_CLEAR_PATH': 1.15,        // Đường tới TP thông thoáng -> Thưởng +15%
    'orderbook_wall:WALL_SUPPORT_SHIELD': 1.12,    // Có tường dày bảo vệ sau Entry -> Thưởng +12%
    'orderbook_wall:WALL_OPPOSING_BLOCK': 0.45,
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

  const mergedMarketData = {
    ...(rawMarketData || {}),
    symbol: sym,
    signalMetrics: rawMarketData?.signalMetrics || sig?.signalMetrics || null,
    maxRecentBouncePct: rawMarketData?.maxRecentBouncePct ?? sig?.maxRecentBouncePct ?? null,
    preEntryBouncePct: rawMarketData?.preEntryBouncePct ?? sig?.preEntryBouncePct ?? null,
  };
  const features = extractSignalFeatures(reasons, score, rank, gridWidthPct, mergedMarketData, sig.signal, entryPrice, sig.timestamp);

  let combinedMultiplier = 1.0;
  const keyFactors = [];

  // 🛡️ DOUBLE-COUNTING PREVENTION:
  // risk_interaction là feature tổng hợp của (trend + ls_flow + price_action + volume + oi).
  // Khi một conflict tương tác đã được capture bởi INTERACTION_*, bỏ qua
  // feature thành phần tương ứng để tránh âm 2 lần vào cùng một rủi ro.
  const riskInteraction = features['risk_interaction'];
  const skipForInteraction = new Map();
  if (riskInteraction === 'INTERACTION_TREND_FLOW_CONFLICT') {
    // Trend conflict + LS_DIVERGENCE đã capture bởi interaction → bỏ qua riêng lẽ
    skipForInteraction.set('trend', riskInteraction);
    skipForInteraction.set('ls_flow', riskInteraction);
  } else if (riskInteraction === 'INTERACTION_NO_SR_WEAK_SETUP') {
    // PA_0_LEVEL đã capture bởi interaction → bỏ qua riêng lẻ
    skipForInteraction.set('price_action', riskInteraction);
  } else if (riskInteraction === 'INTERACTION_DRY_VOL_COOLING_OI') {
    // VOL_DRY + OI_COOLING đã capture bởi interaction → bỏ qua riêng lẽ
    skipForInteraction.set('volume', riskInteraction);
    skipForInteraction.set('oi_change', riskInteraction);
  } else if (riskInteraction === 'INTERACTION_HIGH_VOLATILITY_WEAK_SETUP') {
    // 🛡️ DE-DUPLICATE MULTI-PENALTY:
    // Đã tính rủi ro biến động ở h1_volatility & m15_volatility riêng lẻ,
    // bỏ qua INTERACTION_HIGH_VOLATILITY_WEAK_SETUP để triệt tiêu hoàn toàn cơ chế phạt kép 2-3 lần vào cùng một rủi ro!
    skipForInteraction.set('risk_interaction', 'h1_m15_volatility');
  } else if (riskInteraction === 'INTERACTION_STALE_BOUNCE_RUNAWAY') {
    // 🛡️ Khi đã có INTERACTION_STALE_BOUNCE_RUNAWAY tổng hợp, bỏ qua pre_entry_bounce riêng lẻ để tránh phạt âm 2 lần
    skipForInteraction.set('pre_entry_bounce', riskInteraction);
  }

  // 🛡️ DOUBLE-COUNTING PREVENTION CHO THẾ NẾN:
  // puncture_interaction là feature tổng hợp của (h1_candle_geometry + m15_candle_geometry + candle_shape).
  // Khi một trạng thái đâm lụt/rút chân đã capture bởi puncture_interaction, bỏ qua
  // các feature thành phần để tránh nhân dồn phạt/thưởng tới 3-4 lần!
  const punctureInteraction = features['puncture_interaction'];
  if (punctureInteraction && punctureInteraction !== 'INTERACTION_PUNCTURE_NORMAL') {
    skipForInteraction.set('h1_candle_geometry', punctureInteraction);
    skipForInteraction.set('m15_candle_geometry', punctureInteraction);
    skipForInteraction.set('candle_shape', punctureInteraction);
  }

  // 🛡️ DE-DUPLICATE PINBAR / CANDLE REJECTION (KHỬ TRÙNG LẶP & NHÂN DỒN THẾ NẾN RÚT CHÂN):
  // Tránh việc cùng 1 hành vi rút chân bị tính tới 3 lần:
  // H1_REJECT_PINBAR (x1.40) * M15_REJECT_PINBAR (x1.25) * CANDLE_PINBAR_HAMMER (x1.25) = x2.19!
  // Gói gọn về 1 tiêu chí uy tín duy nhất theo thứ bậc khung thời gian:
  // 1. Nếu khung H1 đã xác nhận rút chân (H1_REJECT_PINBAR):
  //    Chỉ giữ H1_REJECT_PINBAR (khung lớn có độ tin cậy áp đảo),
  //    tự động bỏ qua M15_REJECT_PINBAR và các biến thể nến đơn M15 (CANDLE_PINBAR_HAMMER / CANDLE_PINBAR_SHOOTING).
  // 2. Nếu H1 không có rút chân nhưng M15 có (M15_REJECT_PINBAR):
  //    Chỉ giữ M15_REJECT_PINBAR, tự động bỏ qua CANDLE_PINBAR_HAMMER / CANDLE_PINBAR_SHOOTING vì cả 2 cùng đo nến M15.
  const isH1Pinbar = features['h1_candle_geometry'] === 'H1_REJECT_PINBAR';
  const isM15Pinbar = features['m15_candle_geometry'] === 'M15_REJECT_PINBAR';
  const isShapePinbar = features['candle_shape'] === 'CANDLE_PINBAR_HAMMER' || features['candle_shape'] === 'CANDLE_PINBAR_SHOOTING';

  if (isH1Pinbar) {
    if (isM15Pinbar) skipForInteraction.set('m15_candle_geometry', 'H1_REJECT_PINBAR');
    if (isShapePinbar) skipForInteraction.set('candle_shape', 'H1_REJECT_PINBAR');
  } else if (isM15Pinbar) {
    if (isShapePinbar) skipForInteraction.set('candle_shape', 'M15_REJECT_PINBAR');
  }

  // 🛡️ DE-DUPLICATE STORM & VOLATILITY OVERLAP (KHỬ PHẠT BÃO CHỒNG CHÉO H1 & M15):
  // Nến bão H1 đương nhiên chứa nến bão M15 bên trong (cùng một đợt bùng nổ biến động giá).
  // Khi H1 đã dính bão cực đại (H1_EXTREME_STORM_PUMP_DUMP), nó đã phản ánh đầy đủ rủi ro biến động lớn.
  // Nếu tiếp tục phạt M15_EXTREME_STORM (x0.60 * x0.60 = x0.36) sẽ tạo ra mức phạt kép dìm xác suất ảo xuống 5%,
  // làm bỏ lỡ các lệnh bắt cản nảy phản ứng kỹ thuật (Mean Reversion) rất chuẩn xác của Grid 369.
  // Vì vậy, khi H1 đã chịu phạt bão cực đại, m15_volatility được bỏ qua để tránh phạt chồng chéo.
  if (features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP') {
    if (features['m15_volatility'] === 'M15_EXTREME_STORM' || features['m15_volatility'] === 'M15_VOLATILE_DANGER') {
      skipForInteraction.set('m15_volatility', 'H1_EXTREME_STORM');
    }
  } else if (features['h1_volatility'] === 'H1_VOLATILE_DANGER' && features['m15_volatility'] === 'M15_VOLATILE_DANGER') {
    // Khi cả 2 khung cùng là VOLATILE_DANGER (biến động thường): H1 đã phạt x0.75,
    // m15_volatility cũng được bỏ qua để tránh phạt kép x0.75 * x0.75 = x0.56
    skipForInteraction.set('m15_volatility', 'H1_VOLATILE_DANGER');
  }

  for (const [cat, val] of Object.entries(features)) {
    const key = `${cat}:${val}`;
    let mult = 1.0;

    // 🚫 Bỏ qua feature đã được capture / trùng lặp (tránh double-counting)
    if (skipForInteraction.has(cat)) {
      keyFactors.push(`∅ ${val} (skip: included in ${skipForInteraction.get(cat)})`);
      continue;
    }

    // 🧠 Ưu tiên số 1: Trọng số do AI tự học từ dữ liệu thực tế (weights[key])
    if (weights[key]) {
      mult = weights[key].multiplier;
    } else if (dynamicModifiers[key]) {
      mult = dynamicModifiers[key];
    }

    // 🎯 BASELINE ANCHORING: Các trạng thái chuẩn mực / bình thường / trung tính là mốc quy chiếu (baseline = 1.00)
    // Triệt tiêu hoàn toàn hiện tượng 15-20 nhãn "bình thường" cùng nhân dồn hệ số 0.85-0.95 dìm xác suất ảo xuống 15-25%!
    const isBaselineNormal = val.endsWith('_NORMAL') || 
                             val.endsWith('_NEUTRAL') || 
                             val.endsWith('_BALANCED') || 
                             val.endsWith('_SAFE') ||
                             val === 'HOLD_OR_HOVER' ||
                             val === 'H1_HOLD_OR_HOVER' ||
                             val === 'M15_HOLD_OR_HOVER' ||
                             val === 'H1_NOT_STAGNANT' ||
                             val === 'INTERACTION_PUNCTURE_NORMAL' ||
                             val === 'OI_STABLE' ||
                             val === 'BOUNCE_FRESH' ||
                             val === 'PA_0_LEVEL' ||
                             val === 'SR_NONE' ||
                             val === 'INTERACTION_NO_SR_WEAK_SETUP' ||
                             val === 'SESSION_ASIA' ||
                             val === 'SESSION_EUROPE' ||
                             val === 'SESSION_US_LATE';
    if (isBaselineNormal && mult < 1.00) {
      mult = 1.00;
    }

    // 🛡️ SANITY GUARD: Bỏ thưởng nén M15 (M15 chỉ dùng để bắt xung lực/phạt biến động, không cộng thưởng nén)
    if (cat === 'm15_volatility' && (val === 'M15_ULTRA_COMPRESSED' || val === 'M15_MID_COMPRESSED')) {
      mult = Math.min(1.00, mult);
    }

    // 🛡️ SANITY GUARD: Không thưởng Pinbar nếu đang ngược Trend Dow H1 & EMA
    if (features['trend'] === 'TREND_CONFLICT' && (val === 'CANDLE_PINBAR_HAMMER' || val === 'CANDLE_PINBAR_SHOOTING' || val === 'M15_REJECT_PINBAR' || val === 'H1_REJECT_PINBAR')) {
      mult = 1.00;
    }

    // 🛡️ SANITY GUARD: Khống chế trần an toàn cho Pinbar (H1 tối đa x1.30, M15 tối đa x1.20, nến đơn tối đa x1.15)
    if (cat === 'h1_candle_geometry' && val === 'H1_REJECT_PINBAR') {
      mult = Math.min(mult, 1.30);
    }
    if (cat === 'm15_candle_geometry' && val === 'M15_REJECT_PINBAR') {
      mult = Math.min(mult, 1.20);
    }
    if (cat === 'candle_shape' && (val === 'CANDLE_PINBAR_HAMMER' || val === 'CANDLE_PINBAR_SHOOTING')) {
      mult = Math.min(mult, 1.15);
    }

    // 🛡️ SANITY GUARD: Không để điểm thưởng Pinbar lấn át rủi ro khi Altcoin đang ngược đà BTC (BTC_COUNTER)
    if (features['btc_wave'] === 'BTC_COUNTER' && (val === 'H1_REJECT_PINBAR' || val === 'M15_REJECT_PINBAR' || val === 'CANDLE_PINBAR_HAMMER' || val === 'CANDLE_PINBAR_SHOOTING')) {
      mult = Math.min(mult, 1.05); // Khi BTC ngược hướng, nến rút râu Altcoin chỉ tối đa x1.05
    }

    // 🛡️ SANITY GUARD: Khống chế trần an toàn cho BOUNCE_STALE_HIGH (giá nảy xa mốc rồi quay lại test, tối đa x1.20 tránh thổi phồng xác suất)
    if (cat === 'pre_entry_bounce' && val === 'BOUNCE_STALE_HIGH') {
      mult = Math.min(mult, 1.20);
    }
    if (cat === 'pre_entry_bounce' && val === 'BOUNCE_MODERATE') {
      mult = Math.min(mult, 1.25);
    }
    if (features['trend'] === 'TREND_CONFLICT' && val === 'BOUNCE_STALE_HIGH') {
      mult = Math.min(mult, 1.00);
    }

    // 🛡️ SANITY GUARD: Trung tính hóa Rank (coi mọi coin bình đẳng như nhau, không cộng thưởng ảo hay phạt)
    if (cat === 'rank_group') {
      mult = 1.00;
    }

    // 🛡️ SANITY GUARD: Không thưởng OI_SURGE nếu dòng tiền đang phân kỳ (LS_DIVERGENCE) hoặc ngược trend (TREND_CONFLICT)
    // Bản chất: OI tăng vọt khi đang phân kỳ là dòng tiền bão phá cản (Breakout), không phải cản nảy!
    if (cat === 'oi_change' && val === 'OI_SURGE') {
      if (features['ls_flow'] === 'LS_DIVERGENCE' || features['trend'] === 'TREND_CONFLICT') {
        mult = Math.min(1.00, mult);
      } else {
        mult = Math.min(1.25, mult);
      }
    }
    if (cat === 'ls_flow' && val === 'LS_GOLD') {
      mult = Math.min(1.25, mult);
    }

    // 🛡️ SANITY GUARD: Triệt tiêu toàn bộ điểm thưởng khi có rủi ro cấu trúc nghiêm trọng
    const isTurnoverBlockedRisk = features['turnover_guard'] === 'TURNOVER_RISK_BLOCKED';
    const hasCriticalRisk = isTurnoverBlockedRisk ||
                            features['h1_volatility'] === 'H1_VOLATILE_DANGER' ||
                            features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP' ||
                            features['h1_volume_burst'] === 'H1_VOL_BURST_DANGER' ||
                            features['risk_interaction'] === 'INTERACTION_TREND_FLOW_CONFLICT' ||
                            features['risk_interaction'] === 'INTERACTION_STALE_BOUNCE_RUNAWAY';
    if (hasCriticalRisk) {
      // Khi đã dính rủi ro cấu trúc nghiêm trọng, không cho phép các điểm cộng OI, dòng tiền, nến đơn lẻ lấp liếm rủi ro
      if (['oi_change', 'ls_flow', 'volume', 'candle_shape', 'm15_candle_geometry', 'pre_entry_bounce', 'h1_candle_geometry'].includes(cat)) {
        mult = Math.min(1.00, mult);
      }
      // Riêng với Turnover Blocked (MarketCap nhỏ nhưng volume đột biến > 12-15%, rủi ro xả / quét râu Lowcap):
      // Tuyệt đối không cho phép bất kỳ điểm kỹ thuật phụ nào kéo điểm lên (> 1.00)
      if (isTurnoverBlockedRisk && mult > 1.00) {
        mult = Math.min(1.00, mult);
      }
    }

    // 🛡️ BÃO NẾN H1 / M15: Nếu có nến Pinbar / Hammer xác nhận từ chối giá và không bị Marubozu đè bẹp,
    // nới lỏng hệ số phạt theo cấu hình riskPenaltyProfile (mặc định 0.55 / 0.60 thay vì 0.20)
    // 🌊 NỚI LỎNG KHI THUẬN CHIỀU BTC: Nếu bão nến bùng nổ thuận chiều với sóng BTC, đây là xung lực trend expansion
    const isLongSig = sig.signal === 'LONG' || sig.signal === 'BUY';
    const isShortSig = sig.signal === 'SHORT' || sig.signal === 'SELL';
    const isBtcAligned = features['btc_wave'] === 'BTC_ALIGNED' ||
                         (rawMarketData?.btcFlashDump && isShortSig) ||
                         (rawMarketData?.btcFlashPump && isLongSig);
    const isRunaway = isLongSig
      ? (features['candle_shape'] === 'CANDLE_MARUBOZU_DUMP')
      : (features['candle_shape'] === 'CANDLE_MARUBOZU_PUMP');
    const hasRejection = features['h1_candle_geometry'] === 'H1_REJECT_PINBAR' ||
                         features['m15_candle_geometry'] === 'M15_REJECT_PINBAR' ||
                         features['candle_shape'] === 'CANDLE_PINBAR_HAMMER' ||
                         features['candle_shape'] === 'CANDLE_PINBAR_SHOOTING';

    if (cat === 'h1_volatility' && val === 'H1_EXTREME_STORM_PUMP_DUMP') {
      if (isBtcAligned && !isRunaway) {
        mult = hasRejection ? Math.max(stormH1Rej, 0.95) : Math.max(stormH1Raw, 0.85);
      } else if (hasRejection && !isRunaway) {
        mult = stormH1Rej;
      } else {
        mult = stormH1Raw;
      }
    }
    if (cat === 'm15_volatility' && val === 'M15_EXTREME_STORM') {
      if (isBtcAligned && !isRunaway) {
        mult = hasRejection ? Math.max(stormM15Rej, 0.95) : Math.max(stormM15Raw, 0.85);
      } else if (hasRejection && !isRunaway) {
        mult = stormM15Rej;
      } else {
        mult = stormM15Raw;
      }
    }
    if (cat === 'h1_volatility' && val === 'H1_VOLATILE_DANGER') {
      if (isBtcAligned && !isRunaway) {
        mult = Math.max(mult, 0.88); // Nới nhẹ biến động H1 khi thuận đà BTC
      }
    }
    if (cat === 'm15_volatility' && val === 'M15_VOLATILE_DANGER') {
      if (isBtcAligned && !isRunaway) {
        mult = Math.max(mult, 0.88); // Nới nhẹ biến động M15 khi thuận đà BTC
      }
    }

    // 🛡️ SANITY GUARD: Khắc chế các yếu tố rủi ro ngược xu hướng và phân kỳ dòng tiền
    if (cat === 'risk_interaction' && val === 'INTERACTION_TREND_FLOW_CONFLICT') {
      mult = Math.min(mult, 0.70); // Bắt buộc phạt >= 30% khi vừa ngược trend vừa lệch dòng tiền
    }
    if (cat === 'trend' && val === 'TREND_CONFLICT') {
      mult = Math.min(mult, 0.78); // Ngược xu hướng Dow/EMA không bao giờ được phép > 0.78
    }
    if (cat === 'ls_flow' && val === 'LS_DIVERGENCE') {
      mult = Math.min(mult, 0.82); // Dòng tiền phân kỳ không bao giờ được phép > 0.82
    }
    if (cat === 'trend' && val === 'TREND_M15_ALIGNED') {
      mult = Math.max(mult, 1.20); // M15 cấu trúc hoàn chỉnh khi H1 sideway đảm bảo được cộng thưởng
    }

    // 🛡️ SANITY GUARD: Bắt đỉnh/đáy ngược xu hướng mạnh (Counter-Trend vs Strong ADX)
    // Nếu có mốc cản Price Action H4/D1 (PA_1_LEVEL, PA_2_LEVELS) hoặc nến H1 đã giữ cấu trúc/rút chân (H1_HOLD_OR_HOVER, H1_REJECT_PINBAR):
    // Nhịp nảy kỹ thuật tại cản PP369 đạt WinRate cao trong thực nghiệm!
    // Giữ mức phạt vừa phải x0.70 thay vì phạt gắt x0.40 dìm xác suất ảo
    if (features['trend'] === 'TREND_CONFLICT' && cat === 'adx_strength' && val === 'ADX_STRONG_TREND') {
      const hasSolidSR = features['price_action'] === 'PA_1_LEVEL' || features['price_action'] === 'PA_2_LEVELS';
      const hasH1Support = features['h1_candle_geometry'] === 'H1_HOLD_OR_HOVER' || features['h1_candle_geometry'] === 'H1_REJECT_PINBAR';
      const effectiveCounterMult = (hasSolidSR || hasH1Support) ? Math.max(counterTrendMult, 0.70) : counterTrendMult;
      mult = Math.min(mult, effectiveCounterMult);
    }

    // 🛡️ SANITY GUARD: Khắc chế hệ số Ngược Sóng BTC (BTC_COUNTER)
    // Khi Altcoin đi ngược xu hướng chính của BTC (BTC đang có trend/đà ngược chiều):
    // - Tuyệt đối KHÔNG ĐƯỢC nhân hệ số thưởng (> 1.0)
    // 🛡️ SANITY GUARD: Khắc chế hệ số Ngược Sóng BTC (BTC_COUNTER)
    // Khi Altcoin đi ngược xu hướng chính của BTC:
    // - Nếu Altcoin thuận trend (TREND_PERFECT / TREND_M15_ALIGNED): Phạt nhẹ x0.85
    // - Nếu Altcoin cũng ngược trend (TREND_CONFLICT): Phạt nặng x0.75
    if (cat === 'btc_wave' && val === 'BTC_COUNTER') {
      const isAlignedTrend = features['trend'] === 'TREND_PERFECT' || features['trend'] === 'TREND_M15_ALIGNED';
      if (!isAlignedTrend) {
        mult = 0.65;
      } else {
        mult = Math.min(mult, 0.85);
      }
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

  // 🛡️ SANITY CAP: Nếu đồng coin bị TURNOVER_RISK_BLOCKED (Rủi ro bơm xả / quét râu Lowcap),
  // khống chế trần xác suất nghiêm ngặt tối đa 48.0% (dưới sàn duyệt 50.0%) để tuyệt đối không cho phép
  // coin thanh khoản rỗng lọt lưới chỉ vì một vài chỉ báo kỹ thuật nhỏ lẻ!
  if (features['turnover_guard'] === 'TURNOVER_RISK_BLOCKED') {
    winProb = Math.min(48.0, winProb);
  }

  // ── [MỚI] TỰ ĐỘNG NẠP NGƯỠNG TỐI ƯU DO AI TỰ HỌC (AUTONOMOUS THRESHOLD CALIBRATION) ──
  // Ngưỡng hoàn toàn do AI tự động quyết định (tối ưu hóa Net PnL từ dữ liệu thị trường)
  // Bỏ phân tách thủ công Topcap vs Lowcap: Toàn bộ danh mục tuân theo ngưỡng AI tối ưu
  const optimalTh = _modelConfig?.optimalThresholds || {};
  const aiLearnedThreshold = typeof optimalTh.uniform === 'number'
    ? optimalTh.uniform
    : (typeof optimalTh.top150 === 'number' ? optimalTh.top150 : (typeof optimalTh.thresholdApprovalPct === 'number' ? optimalTh.thresholdApprovalPct : 53.0));
  let threshold = Math.max(50.0, aiLearnedThreshold);

  // 🌊 MARKET REGIME FLEXIBILITY (Co giãn linh hoạt theo nhịp thở thị trường do AI quyết định)
  if (features['btc_wave'] === 'BTC_ALIGNED') {
    threshold = Math.max(50.0, threshold - 0.5);
  } else if (features['btc_wave'] === 'BTC_COUNTER' || features['btc_flash'] !== 'BTC_FLASH_NORMAL') {
    threshold += 2.0;
  }

  // ── 🎯 TÍNH TOÁN LỢI NHUẬN KỲ VỌNG (EXPECTED VALUE - EV) CHUẨN XÁC THEO TIER VÀ GRID ──
  const minEvRoiThreshold = optimalTh.minExpectedEvRoi ?? _modelConfig?.minExpectedEvRoi ?? 0.0;

  // Với hệ thống Tier Leverage: calcLeverage = 50 / slPct -> Lỗ khi dính SL luôn chuẩn ~50.0% ROI
  const estSlRoi = 50.0;

  // ── [MỚI] KHOẢNG CÁCH CẮT LỖ HOÀN TOÀN DO AI QUYẾT ĐỊNH (ADAPTIVE DYNAMIC SL FLOOR) ──
  // Bỏ phân biệt Topcap vs Lowcap, sử dụng ngưỡng cắt lỗ tối ưu do AI tự học từ phân phối nến và rung lắc thị trường
  const slCfg = _modelConfig?.adaptiveSlProfile;
  const aiLearnedMinSl = typeof slCfg?.optimalMinSlPct === 'number'
    ? slCfg.optimalMinSlPct
    : (typeof slCfg?.top150MinSlPct === 'number' ? slCfg.top150MinSlPct : 1.3);
  const defaultSlPct = aiLearnedMinSl;
  const effSlPct = (typeof sig.actualSlPct === 'number' && sig.actualSlPct > 0)
    ? sig.actualSlPct
    : Math.max(defaultSlPct, Math.min(3.0, (typeof gridWidthPct === 'number' && gridWidthPct > 0 ? gridWidthPct : 3.0) * 0.5));

  const mfeMaeCfg = _modelConfig?.mfeMaeProfile;
  const learnedTpGridRatio = typeof mfeMaeCfg?.optimalTpGridRatio === 'number'
    ? mfeMaeCfg.optimalTpGridRatio
    : 0.50;
  const tpGridPct = (typeof sig.actualTpPct === 'number' && sig.actualTpPct > 0)
    ? sig.actualTpPct
    : Math.max(effSlPct * 1.0, gridWidthPct * learnedTpGridRatio);
  const estTpRoi = Math.max(10.0, Math.min(100.0, (tpGridPct / effSlPct) * 50.0));

  const winProbDec = winProb / 100.0;
  const evRoi = (winProbDec * estTpRoi) - ((1.0 - winProbDec) * estSlRoi);
  const tradeMargin = parseFloat(sig.margin) || 75;
  const evUsd = (evRoi / 100.0) * tradeMargin;

  // 🛡️ TỶ LỆ R:R SCALPING HỢP LÝ — Đọc trực tiếp từ adaptiveRrProfile trong mô hình AI:
  const rrRatio = effSlPct > 0 ? (tpGridPct / effSlPct) : 1.0;
  const rrProfile = _modelConfig?.adaptiveRrProfile?.minRrByWinProb;
  let minRequiredRr = 0.80;
  if (rrProfile) {
    if (winProb >= 65.0 && typeof rrProfile['65.0'] === 'number') minRequiredRr = rrProfile['65.0'];
    else if (winProb >= 60.0 && typeof rrProfile['60.0'] === 'number') minRequiredRr = rrProfile['60.0'];
    else if (winProb >= 57.5 && typeof rrProfile['57.5'] === 'number') minRequiredRr = rrProfile['57.5'];
    else if (winProb >= 55.0 && typeof rrProfile['55.0'] === 'number') minRequiredRr = rrProfile['55.0'];
    else minRequiredRr = typeof rrProfile['floor'] === 'number' ? rrProfile['floor'] : 0.80;
  } else {
    minRequiredRr = (winProb >= 65.0) ? 0.55
                  : (winProb >= 60.0) ? 0.60
                  : (winProb >= 57.5) ? 0.65
                  : (winProb >= 55.0) ? 0.70
                  : 0.80;
  }
  const isRrAcceptable = rrRatio >= minRequiredRr;

  // ── AI LÀ NGƯỜI RA QUYẾT ĐỊNH 100% ĐỊNH LƯỢNG — XÓA BỎ HOÀN TOÀN LỆNH CẤM CỨNG (NO HARD BOOLEAN VETOES) ──
  // Quyết định phê duyệt hoàn toàn dựa trên 3 trụ cột định lượng:
  // 1. Xác suất thắng Bayesian (winProb >= threshold) sau khi đã tích lũy toàn bộ điểm thưởng/phạt
  // 2. Lợi nhuận kỳ vọng thực nghiệm dương (evRoi >= minEvRoiThreshold)
  // 3. Tỷ lệ R:R đáp ứng tiêu chuẩn thích ứng (isRrAcceptable)
  const isApproved = winProb >= threshold && evRoi >= minEvRoiThreshold && isRrAcceptable;
  const factorSummary = keyFactors.length > 0 ? keyFactors.join(', ') : 'Điều kiện trung tính';

  // Chẩn đoán nhân tố rủi ro nổi bật (nếu có) khi không được phê duyệt
  const hasRejectionConfirmation =
    features['h1_candle_geometry'] === 'H1_REJECT_PINBAR' ||
    features['m15_candle_geometry'] === 'M15_REJECT_PINBAR' ||
    features['candle_shape'] === 'CANDLE_PINBAR_HAMMER' ||
    features['candle_shape'] === 'CANDLE_PINBAR_SHOOTING';
  const isOpposingRunaway = (sig.signal === 'LONG' || sig.signal === 'BUY')
    ? (features['candle_shape'] === 'CANDLE_MARUBOZU_DUMP')
    : (features['candle_shape'] === 'CANDLE_MARUBOZU_PUMP');
  const isBtcAlignedSig = features['btc_wave'] === 'BTC_ALIGNED' ||
                          (rawMarketData?.btcFlashDump && (sig.signal === 'SHORT' || sig.signal === 'SELL')) ||
                          (rawMarketData?.btcFlashPump && (sig.signal === 'LONG' || sig.signal === 'BUY'));
  const isExtremeStormCondition = (features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP' || features['m15_volatility'] === 'M15_EXTREME_STORM') &&
                                  (!hasRejectionConfirmation || isOpposingRunaway) &&
                                  !(isBtcAlignedSig && !isOpposingRunaway);
  const isStrongCounterTrendCondition = (features['trend'] === 'TREND_CONFLICT' || features['trend'] === 'TREND_COUNTER') &&
                                        features['adx_strength'] === 'ADX_STRONG_TREND';
  const isOpposingWickCondition = features['wick_rejection'] === 'OPPOSING_WICK_TRAP';
  const isEconomicRedCondition = features['economic_calendar'] === 'CALENDAR_RED_DANGER';
  const isSpreadDangerCondition = features['spread_slippage'] === 'SPREAD_WIDE_DANGER';
  const isBtcFlashCondition = (features['btc_flash'] === 'BTC_FLASH_DUMP_ACTIVE' && (sig.signal === 'LONG' || sig.signal === 'BUY')) ||
                              (features['btc_flash'] === 'BTC_FLASH_PUMP_ACTIVE' && (sig.signal === 'SHORT' || sig.signal === 'SELL'));
  const isWallBlockedCondition = features['orderbook_wall'] === 'WALL_OPPOSING_BLOCK' && features['cvd_momentum'] !== 'CVD_SURGE_ALIGNED';

  let vetoCategory = null;
  let reasonText = '';

  if (!isApproved) {
    if (winProb < threshold) {
      if (isBtcFlashCondition) {
        vetoCategory = features['btc_flash'];
        reasonText = `[AI VETO BÃO BTC FLASH] Phát hiện ${features['btc_flash']} ngược chiều lệnh kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (features['btc_wave'] === 'BTC_COUNTER' && features['trend'] === 'TREND_CONFLICT') {
        vetoCategory = 'BTC_COUNTER_TREND_CONFLICT';
        reasonText = `[AI VETO NGƯỢC SÓNG KÉP BTC] Altcoin ngược xu hướng và đi ngược đà sóng BTC kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (isStrongCounterTrendCondition) {
        vetoCategory = 'COUNTER_STRONG_TREND_DANGER';
        reasonText = `[AI VETO CẢN TÀU XU HƯỚNG] Tín hiệu ngược xu hướng trong khi xung lực xu hướng đối lập quá mạnh (TREND_CONFLICT + ADX_STRONG_TREND) kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (isOpposingWickCondition) {
        vetoCategory = 'OPPOSING_WICK_TRAP';
        reasonText = `[AI VETO BẪY RÚT RÂU] Nến M15 bị rút râu ngược chiều >= 50% (OPPOSING_WICK_TRAP), phe đối lập vừa đẩy giá cực mạnh kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (isExtremeStormCondition) {
        vetoCategory = features['h1_volatility'] === 'H1_EXTREME_STORM_PUMP_DUMP' ? 'H1_EXTREME_STORM' : 'M15_EXTREME_STORM';
        reasonText = `[AI VETO BÃO NẾN CỰC ĐẠI] ${vetoCategory} (Biên độ nến vượt ngưỡng an toàn kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%) [Rank #${rank}] (${factorSummary})`;
      } else if (isEconomicRedCondition) {
        vetoCategory = 'ECONOMIC_BLACKOUT_DANGER';
        reasonText = `[AI VETO LỊCH KINH TẾ ĐỎ] Đang trong cửa sổ bão giá CPI / FOMC / NFP kéo xác suất an toàn ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (isSpreadDangerCondition) {
        vetoCategory = 'SPREAD_WIDE_DANGER';
        const maxTh = rank <= 50 ? '0.04%' : (rank <= 150 ? '0.06%' : '0.08%');
        reasonText = `[AI VETO ĐỘ DÃN SPREAD] Chênh lệch Bid-Ask vượt ngưỡng (>${maxTh}), trượt giá kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (isWallBlockedCondition) {
        vetoCategory = 'ORDERBOOK_WALL_BLOCK';
        reasonText = `[AI VETO TƯỜNG CẢN SỔ LỆNH] Phát hiện bức tường thanh khoản khổng lồ chắn trước TP kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (features['puncture_interaction'] && (features['puncture_interaction'] === 'INTERACTION_H1_M15_PUNCTURED' || features['puncture_interaction'].startsWith('INTERACTION_H1_'))) {
        vetoCategory = features['puncture_interaction'];
        reasonText = `[ĐÁNH GIÁ RỦI RO AI: ${features['puncture_interaction']}] Nến đâm lụt qua Entry, xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% [Rank #${rank}] (${factorSummary})`;
      } else if (features['risk_interaction'] === 'INTERACTION_STALE_BOUNCE_RUNAWAY') {
        vetoCategory = 'INTERACTION_STALE_BOUNCE_RUNAWAY';
        reasonText = `[AI VETO ĐỘ NẢY MẠNH PHÁ CẢN] Giá đã nảy cực xa mốc cản kết hợp rủi ro Lowcap/Bão kéo xác suất ${winProb.toFixed(1)}% < ${threshold}%! [Rank #${rank}] (${factorSummary})`;
      } else if (features['risk_interaction'] && features['risk_interaction'].startsWith('INTERACTION_') && features['risk_interaction'] !== 'INTERACTION_BALANCED') {
        vetoCategory = features['risk_interaction'];
        reasonText = `[ĐÁNH GIÁ RỦI RO AI: ${features['risk_interaction']}] Xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% [Rank #${rank}] (${factorSummary})`;
      } else {
        vetoCategory = `WINPROB_LT_${threshold}`;
        reasonText = `Xác suất thắng ${winProb.toFixed(1)}% < ${threshold}% [Rank #${rank}] (${factorSummary})`;
      }
    } else if (!isRrAcceptable) {
      vetoCategory = 'BAD_RR_LESS_THAN_1';
      reasonText = `[RỦI RO R:R < 1.0] Tỷ lệ R:R không đạt chuẩn (TP ${tpGridPct.toFixed(2)}% / SL ${effSlPct.toFixed(2)}% = ${rrRatio.toFixed(2)}:1 < ${minRequiredRr.toFixed(2)}:1) [Rank #${rank}] (${factorSummary})`;
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

function getAIModelConfig() {
  if (!_modelConfig) loadAIModel();
  return _modelConfig;
}

module.exports = {
  evaluateSignalWithAI,
  recordAIEvaluation,
  loadAIModel,
  checkModelHotReload,
  getAIModelConfig,
};
