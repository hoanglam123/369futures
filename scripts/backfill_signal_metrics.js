/**
 * scripts/backfill_signal_metrics.js
 * Tạo và điền cấu trúc signalMetrics trực tiếp từ scoreReasons
 * cho toàn bộ bản ghi lịch sử trong:
 * - data/ai_trade_dataset.jsonl
 * - data/shadow_trades_history.jsonl
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATASET_FILE = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');
const SHADOW_FILE = path.join(DATA_DIR, 'shadow_trades_history.jsonl');

function parseMetricsFromReasons(reasons) {
  const reasonsStr = Array.isArray(reasons) ? reasons.join(' ') : String(reasons || '');

  // 1. Trend
  let trend = 'TREND_NEUTRAL';
  if (reasonsStr.includes('Dow & Trendline')) trend = 'TREND_PERFECT';
  else if (reasonsStr.includes('H1 Sideway nhưng M15 có cấu trúc')) trend = 'TREND_M15_ALIGNED';
  else if (reasonsStr.includes('EMA20<EMA50') || reasonsStr.includes('EMA20>EMA50')) trend = 'TREND_EMA';
  else if (reasonsStr.includes('Ngược/Mâu thuẫn')) trend = 'TREND_CONFLICT';

  // 2. ADX
  const adxMatch = reasonsStr.match(/ADX=(\d+\.?\d*)/);
  const adx = adxMatch ? parseFloat(adxMatch[1]) : null;
  const adxStrength = adx !== null ? (adx >= 25.0 ? 'ADX_STRONG_TREND' : 'ADX_WEAK_TREND') : 'ADX_NORMAL';

  // 3. Candle Geometry
  let h1CandleGeometry = 'H1_HOLD_OR_HOVER';
  if (reasonsStr.includes('H1 đóng nến lụt sâu')) h1CandleGeometry = 'H1_PUNCTURED_DEEP';
  else if (reasonsStr.includes('H1 đóng nến chớm lụt')) h1CandleGeometry = 'H1_PUNCTURED_LIGHT';
  else if (reasonsStr.includes('H1 rút chân') || reasonsStr.includes('H1 rút râu')) h1CandleGeometry = 'H1_REJECT_PINBAR';

  let m15CandleGeometry = 'M15_HOLD_OR_HOVER';
  if (reasonsStr.includes('M15 đóng nến lụt sâu')) m15CandleGeometry = 'M15_PUNCTURED_DEEP';
  else if (reasonsStr.includes('M15 đóng nến chớm lụt')) m15CandleGeometry = 'M15_PUNCTURED_LIGHT';
  else if (reasonsStr.includes('M15 rút chân') || reasonsStr.includes('M15 rút râu')) m15CandleGeometry = 'M15_REJECT_PINBAR';

  // 4. RSI
  let rsiCondition = 'RSI_NEUTRAL';
  if (reasonsStr.includes('Quá bán cực đại') || reasonsStr.includes('Quá mua cực đại')) rsiCondition = 'RSI_EXTREME';
  else if (reasonsStr.includes('Cận quá bán') || reasonsStr.includes('Cận quá mua')) rsiCondition = 'RSI_NEAR';

  // 5. L/S Flow
  let lsFlow = 'LS_NEUTRAL';
  if (reasonsStr.includes('Gold Setup') || reasonsStr.includes('Đồng thuận tuyệt đối')) lsFlow = 'LS_GOLD';
  else if (reasonsStr.includes('Đồng thuận một phần')) lsFlow = 'LS_PARTIAL';
  else if (reasonsStr.includes('Không đồng thuận') || reasonsStr.includes('phân kỳ') || reasonsStr.includes('Cá voi không đạt')) lsFlow = 'LS_DIVERGENCE';

  // 6. Price Action S/R
  let priceAction = 'PA_0_LEVEL';
  if (reasonsStr.includes('4 cản cũ')) priceAction = 'PA_4_LEVELS';
  else if (reasonsStr.includes('3 cản cũ')) priceAction = 'PA_3_LEVELS';
  else if (reasonsStr.includes('2 cản cũ')) priceAction = 'PA_2_LEVELS';
  else if (reasonsStr.includes('1 cản cũ')) priceAction = 'PA_1_LEVEL';

  const d1Part = reasonsStr.includes('D1:') ? reasonsStr.split('D1:')[1] : '';
  const hasD1 = Boolean(d1Part && !d1Part.includes('không cản') && !d1Part.includes('thiếu nến'));
  const h4Part = reasonsStr.includes('H4:') ? reasonsStr.split('H4:')[1].split('|')[0] : '';
  const hasH4 = Boolean(h4Part && !h4Part.includes('chỉ có 0 cản') && !h4Part.includes('0 cản cũ') && !h4Part.includes('thiếu nến'));
  const srQuality = hasD1 ? 'SR_DAILY_D1_INCLUDED' : (hasH4 ? 'SR_H4_ONLY' : 'SR_NONE');

  // 7. OI
  let oiState = 'OI_STABLE';
  if (reasonsStr.includes('Hạ nhiệt vị thế') || reasonsStr.includes('giảm -')) oiState = 'OI_COOLING';
  else if (reasonsStr.includes('Tăng mạnh') || reasonsStr.includes('bùng nổ')) oiState = 'OI_SURGE';

  // 8. Volume
  let volumeState = 'VOL_DRY';
  if (reasonsStr.includes('Volume bùng nổ')) volumeState = 'VOL_SURGE';
  else if (reasonsStr.includes('Volume ổn định')) volumeState = 'VOL_STABLE';

  const h1VolumeBurst = reasonsStr.includes('Đột biến Volume 3 H1') ? 'H1_VOL_BURST_DANGER' : 'H1_VOL_BURST_NORMAL';

  // 9. Funding Rate
  let fundingState = 'FUNDING_NORMAL';
  if (reasonsStr.includes('Short Crowded') || reasonsStr.includes('Long Crowded')) fundingState = 'FUNDING_SQUEEZE';
  else if (reasonsStr.includes('Short đu bám') || reasonsStr.includes('Long đu bám') || reasonsStr.includes('Nóng')) fundingState = 'FUNDING_DANGER';

  // 10. BTC Wave
  let btcWave = 'BTC_COUNTER';
  if (reasonsStr.includes('BTC thuận Dow/EMA') || reasonsStr.includes('Chính là BTC')) btcWave = 'BTC_ALIGNED';
  else if (reasonsStr.includes('BTC đi ngang/trung tính')) btcWave = 'BTC_NEUTRAL';

  const btcStorm = reasonsStr.includes('BTC bão giá') ? 'BTC_STORM_VOLATILE' : 'BTC_STORM_NORMAL';

  return {
    trend,
    adx,
    adxStrength,
    h1CandleGeometry,
    m15CandleGeometry,
    rsi: null,
    rsiCondition,
    whaleLongRatio: null,
    retailLongRatio: null,
    lsFlow,
    h4SrCount: hasH4 ? 1 : 0,
    d1SrCount: hasD1 ? 1 : 0,
    priceAction,
    srQuality,
    oiChangePct: null,
    oiState,
    volumeRatio: 1.0,
    volumeState,
    h1VolumeBurst,
    fundingRate: null,
    fundingState,
    btcWave,
    btcStorm
  };
}

function processFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[Backfill] Không tìm thấy file: ${filePath}`);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let updatedCount = 0;
  const newLines = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (!record.signalMetrics && record.scoreReasons && record.scoreReasons.length) {
        record.signalMetrics = parseMetricsFromReasons(record.scoreReasons);
        updatedCount++;
      }
      newLines.push(JSON.stringify(record));
    } catch (e) {
      newLines.push(line);
    }
  }

  fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf8');
  console.log(`[Backfill] File ${path.basename(filePath)}: Đã cập nhật ${updatedCount}/${lines.length} bản ghi với signalMetrics.`);
}

console.log('=== BẮT ĐẦU BACKFILL SIGNAL METRICS CHO DATASET & SHADOW TRADES ===');
processFile(DATASET_FILE);
processFile(SHADOW_FILE);
console.log('=== HOÀN TẤT BACKFILL SIGNAL METRICS ===');
