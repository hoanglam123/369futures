/**
 * RUN COMPREHENSIVE AI BACKTEST (BACKTEST TOÀN DIỆN MÔ HÌNH AI REVIEWER)
 * Quét toàn bộ dữ liệu lịch sử (Real Trades + Shadow Trades) bằng chính engine aiReviewer.js
 * Xuất báo cáo phân phối WinProb, hiệu quả bộ lọc Veto, và tìm điểm mốc / ngưỡng tối ưu mới.
 */

const fs = require('fs');
const path = require('path');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

const BASE_DIR = path.resolve(__dirname, '..');
const DATASET_PATH = path.join(BASE_DIR, 'data', 'ai_trade_dataset.jsonl');
const SHADOW_PATH = path.join(BASE_DIR, 'data', 'shadow_trades_history.jsonl');
const CONFIG_PATH = path.join(BASE_DIR, 'data', 'ai_rule_config.json');

console.log('=' .repeat(80));
console.log('🚀 KHỞI ĐỘNG HỆ THỐNG BACKTEST TOÀN DIỆN MÔ HÌNH AI REVIEWER');
console.log('=' .repeat(80));

// 1. Nạp config hiện tại
let modelConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    modelConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log(`📋 Config Model v${modelConfig.version || 'unknown'} | Prior WinProb: ${(modelConfig.priorWinProb * 100).toFixed(2)}% | Ngưỡng: Top150=${modelConfig.optimalThresholds?.top150}%, Lowcap=${modelConfig.optimalThresholds?.lowcap}%`);
  } catch (e) {
    console.error('Lỗi đọc config:', e.message);
  }
}

// 2. Thu thập dữ liệu lịch sử hoàn chỉnh
const allTrades = [];

// A. Real Trades (Ghép ENTRY và EXIT)
if (fs.existsSync(DATASET_PATH)) {
  const lines = fs.readFileSync(DATASET_PATH, 'utf8').trim().split('\n');
  const entries = new Map();
  for (const l of lines) {
    if (!l.trim() || l.startsWith('<') || l.startsWith('=')) continue;
    try {
      const rec = JSON.parse(l);
      if (rec.type === 'ENTRY') {
        const id = rec.tradeId || rec.orderId;
        if (id) entries.set(id, rec);
      } else if (rec.type === 'EXIT') {
        const id = rec.tradeId || rec.orderId;
        const entry = entries.get(id);
        if (entry) {
          const isWin = Boolean(rec.isWin);
          const isBe = rec.exitType === 'BE_EXIT' || rec.exitType === 'BE';
          const pnlUsd = parseFloat(rec.pnlUsd) || 0;
          const pnlPct = parseFloat(rec.pnlPercent) || 0;
          allTrades.push({
            id,
            source: 'REAL',
            symbol: entry.symbol,
            signal: entry.signal,
            marketCapRank: parseInt(entry.marketCapRank) || 999,
            score: parseFloat(entry.score) || 0,
            gridWidthPct: parseFloat(entry.gridWidthPct) || 3.5,
            entryRecord: entry,
            isWin,
            isBe,
            isSl: !isWin && !isBe,
            pnlUsd,
            pnlPct,
            exitType: rec.exitType,
            holdingMinutes: parseFloat(rec.holdingDurationMinutes) || 0
          });
        }
      }
    } catch (err) {}
  }
  console.log(`📦 Đã nạp ${allTrades.length} lệnh REAL trades hoàn tất (ghép cặp ENTRY - EXIT).`);
}

// B. Shadow Trades
let shadowCount = 0;
if (fs.existsSync(SHADOW_PATH)) {
  const lines = fs.readFileSync(SHADOW_PATH, 'utf8').trim().split('\n');
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const rec = JSON.parse(l);
      const outcome = rec.outcome;
      if (!['MISSED_TP', 'SAVED_SL', 'SAVED_BE', 'TP', 'SL', 'BE'].includes(outcome)) continue;

      const holdingMins = parseFloat(rec.holdingDurationMinutes) || 0;
      // Chỉ lấy lệnh shadow có thời lượng hợp lý <= 240 phút
      if (holdingMins > 240) continue;

      let isWin = false;
      let isBe = false;
      if (outcome === 'MISSED_TP' || outcome === 'TP') {
        isWin = true;
      } else if (outcome === 'SAVED_BE' || outcome === 'BE') {
        isBe = true;
      }

      const pnlUsd = parseFloat(rec.pnlUsd) || 0;
      const pnlPct = parseFloat(rec.pnlPercent) || 0;

      allTrades.push({
        id: rec.shadowId || `SHADOW-${rec.symbol}-${rec.entryTimestamp}`,
        source: 'SHADOW',
        symbol: rec.symbol,
        signal: rec.signal,
        marketCapRank: parseInt(rec.marketCapRank) || 999,
        score: parseFloat(rec.score) || 0,
        gridWidthPct: parseFloat(rec.gridWidthPct) || 3.5,
        entryRecord: rec,
        isWin,
        isBe,
        isSl: !isWin && !isBe,
        pnlUsd,
        pnlPct,
        exitType: outcome,
        holdingMinutes: holdingMins
      });
      shadowCount++;
    } catch (err) {}
  }
  console.log(`📦 Đã nạp ${shadowCount} lệnh SHADOW trades hợp lệ (holding <= 4h).`);
}

console.log(`🎯 TỔNG CỘNG MẪU DỮ LIỆU ĐỂ BACKTEST: ${allTrades.length} lệnh.\n`);

if (allTrades.length === 0) {
  console.error('❌ Không có dữ liệu để backtest.');
  process.exit(1);
}

// 3. Chạy qua AI Reviewer thực tế
console.log('⏳ Đang chạy toàn bộ dữ liệu qua AI Reviewer...');
const evaluatedResults = [];
const winProbs = [];
const top150Probs = [];
const lowcapProbs = [];

for (const t of allTrades) {
  const sig = t.entryRecord;
  const rawMarketData = {
    ...sig,
    signalMetrics: sig.signalMetrics || null,
    marketMetrics: sig.marketMetrics || null,
  };

  const evalRes = evaluateSignalWithAI(sig, rawMarketData);

  const item = {
    ...t,
    aiWinProb: evalRes.winProbability,
    aiThreshold: evalRes.threshold,
    aiEvRoi: evalRes.expectedValueRoi,
    aiIsApproved: evalRes.isApproved,
    aiVetoCategory: evalRes.vetoCategory,
    aiReason: evalRes.reason,
    aiKeyFactors: evalRes.keyFactors
  };

  evaluatedResults.push(item);
  winProbs.push(item.aiWinProb);
  if (item.marketCapRank <= 150) {
    top150Probs.push(item.aiWinProb);
  } else {
    lowcapProbs.push(item.aiWinProb);
  }
}

// Hàm tính phân vị Percentile
function getPercentiles(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { min: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0, avg: 0 };
  const getP = (p) => sorted[Math.min(n - 1, Math.floor(n * (p / 100)))];
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  return {
    min: sorted[0],
    p10: getP(10),
    p25: getP(25),
    p50: getP(50),
    p75: getP(75),
    p90: getP(90),
    max: sorted[n - 1],
    avg
  };
}

const allStats = getPercentiles(winProbs);
const topStats = getPercentiles(top150Probs);
const lowStats = getPercentiles(lowcapProbs);

console.log('\n' + '=' .repeat(80));
console.log('📊 1. PHÂN PHỐI XÁC SUẤT THẮNG (AI WIN PROBABILITY DISTRIBUTION)');
console.log('=' .repeat(80));
console.log(`• TẤT CẢ LỆNH (N=${winProbs.length}):`);
console.log(`  - Trung bình (Avg): ${allStats.avg.toFixed(2)}% | Trung vị (Median / P50): ${allStats.p50.toFixed(2)}%`);
console.log(`  - Min: ${allStats.min.toFixed(2)}% | P10: ${allStats.p10.toFixed(2)}% | P25: ${allStats.p25.toFixed(2)}% | P75: ${allStats.p75.toFixed(2)}% | P90: ${allStats.p90.toFixed(2)}% | Max: ${allStats.max.toFixed(2)}%`);

console.log(`\n• NHÓM TOP 150 (N=${top150Probs.length}):`);
console.log(`  - Trung vị (P50): ${topStats.p50.toFixed(2)}% | P25: ${topStats.p25.toFixed(2)}% | P75: ${topStats.p75.toFixed(2)}% | Avg: ${topStats.avg.toFixed(2)}%`);

console.log(`\n• NHÓM LOWCAP NGOÀI 150 (N=${lowcapProbs.length}):`);
console.log(`  - Trung vị (P50): ${lowStats.p50.toFixed(2)}% | P25: ${lowStats.p25.toFixed(2)}% | P75: ${lowStats.p75.toFixed(2)}% | Avg: ${lowStats.avg.toFixed(2)}%`);

// 4. Kiểm tra độ chuẩn hóa hiệu chuẩn (Probability Calibration Bins)
console.log('\n' + '=' .repeat(80));
console.log('📈 2. ĐỘ CHUẨN XÁC GIỮA WINPROB DỰ BÁO VÀ WINRATE THỰC TẾ (CALIBRATION)');
console.log('=' .repeat(80));
const bins = [
  { min: 0, max: 20, label: '< 20%' },
  { min: 20, max: 30, label: '20% - 30%' },
  { min: 30, max: 40, label: '30% - 40%' },
  { min: 40, max: 50, label: '40% - 50%' },
  { min: 50, max: 60, label: '50% - 60%' },
  { min: 60, max: 70, label: '60% - 70%' },
  { min: 70, max: 100, label: '>= 70%' }
];

console.log('Khoảng WinProb Dự Báo | Số Lệnh | Thắng (TP) | Hòa (BE) | Thua (SL) | WinRate Thực Tế | Net PnL ($)');
console.log('-'.repeat(85));
for (const b of bins) {
  const inBin = evaluatedResults.filter(r => r.aiWinProb >= b.min && r.aiWinProb < b.max);
  const total = inBin.length;
  const w = inBin.filter(r => r.isWin).length;
  const be = inBin.filter(r => r.isBe).length;
  const l = inBin.filter(r => r.isSl).length;
  const denom = total - be;
  const realWr = denom > 0 ? (w / denom) * 100 : 0;
  const netPnl = inBin.reduce((acc, r) => acc + r.pnlUsd, 0);
  console.log(`${b.label.padEnd(21)} | ${String(total).padStart(7)} | ${String(w).padStart(10)} | ${String(be).padStart(8)} | ${String(l).padStart(9)} | ${realWr.toFixed(1).padStart(13)}% | $${netPnl.toFixed(1).padStart(10)}`);
}

// 5. Đánh giá cấu hình hiện tại (Current Status)
console.log('\n' + '=' .repeat(80));
console.log('🔍 3. HIỆU QUẢ CỦA CẤU HÌNH HIỆN TẠI (CURRENT THRESHOLDS)');
console.log('=' .repeat(80));

const currApproved = evaluatedResults.filter(r => r.aiIsApproved);
const currVetoed = evaluatedResults.filter(r => !r.aiIsApproved);

const curW = currApproved.filter(r => r.isWin).length;
const curBe = currApproved.filter(r => r.isBe).length;
const curL = currApproved.filter(r => r.isSl).length;
const curDenom = currApproved.length - curBe;
const curWr = curDenom > 0 ? (curW / curDenom) * 100 : 0;
const curNetPnl = currApproved.reduce((acc, r) => acc + r.pnlUsd, 0);

const savedLosses = currVetoed.filter(r => r.isSl).length;
const savedLossUsd = currVetoed.filter(r => r.isSl).reduce((acc, r) => acc + Math.abs(r.pnlUsd), 0);
const missedWins = currVetoed.filter(r => r.isWin).length;
const missedWinUsd = currVetoed.filter(r => r.isWin).reduce((acc, r) => acc + r.pnlUsd, 0);

console.log(`• TỔNG LỆNH ĐƯỢC DUYỆT VÀO SÀN: ${currApproved.length} / ${evaluatedResults.length} (${((currApproved.length / evaluatedResults.length) * 100).toFixed(1)}%)`);
console.log(`  - Thắng: ${curW} | Hòa (BE): ${curBe} | Thua (SL): ${curL}`);
console.log(`  - WinRate thực tế lệnh duyệt: ${curWr.toFixed(2)}%`);
console.log(`  - Tổng Net PnL lệnh duyệt: $${curNetPnl.toFixed(2)} USD`);

console.log(`\n• TỔNG LỆNH BỊ VETO: ${currVetoed.length} / ${evaluatedResults.length}`);
console.log(`  - Cứu tài khoản (Saved SL): ${savedLosses} lệnh (Cứu vốn: +$${savedLossUsd.toFixed(2)} USD)`);
console.log(`  - Bỏ lỡ cơ hội (Missed TP): ${missedWins} lệnh (Bỏ lỡ lãi: -$${missedWinUsd.toFixed(2)} USD)`);
console.log(`  - Chênh lệch Giá trị Veto (Net Veto Value = Saved SL - Missed TP): $${(savedLossUsd - missedWinUsd).toFixed(2)} USD`);

// 6. Thống kê nguyên nhân Veto
const vetoReasons = {};
currVetoed.forEach(r => {
  const cat = r.aiVetoCategory || 'OTHER';
  vetoReasons[cat] = (vetoReasons[cat] || 0) + 1;
});
console.log('\n• CHI TIẾT CÁC NGUYÊN NHÂN BỊ VETO:');
Object.entries(vetoReasons)
  .sort((a, b) => b[1] - a[1])
  .forEach(([cat, cnt]) => {
    console.log(`  - ${cat.padEnd(35)}: ${cnt} lệnh (${((cnt / currVetoed.length) * 100).toFixed(1)}%)`);
  });

// 7. GRID SEARCH TÌM ĐIỂM NGƯỠNG TỐI ƯU MỚI (DYNAMIC THRESHOLD GRID SEARCH)
console.log('\n' + '=' .repeat(80));
console.log('🎯 4. KHẢO SÁT & TỐI ƯU HÓA ĐIỂM NGƯỠNG THỰC NGHIỆM (OPTIMAL THRESHOLD SEARCH)');
console.log('=' .repeat(80));

const testTopRange = [30.0, 32.0, 35.0, 38.0, 40.0, 42.0, 45.0, 48.0, 50.0];
const testLowRange = [35.0, 38.0, 40.0, 42.0, 45.0, 48.0, 50.0, 55.0, 60.0];

let bestConfig = null;
let maxNetPnl = -999999;
const gridResults = [];

for (const thTop of testTopRange) {
  for (const thLow of testLowRange) {
    if (thLow < thTop) continue;

    let passTrades = 0;
    let wins = 0;
    let bes = 0;
    let losses = 0;
    let pnl = 0;

    for (const r of evaluatedResults) {
      // Giữ nguyên các chốt chặn Veto an toàn bắt buộc (Extreme Storm, Economic Red, Spread Danger, Wall Block, Bad RR)
      if (['H1_EXTREME_STORM', 'M15_EXTREME_STORM', 'ECONOMIC_BLACKOUT_DANGER', 'SPREAD_WIDE_DANGER', 'ORDERBOOK_WALL_BLOCK', 'BAD_RR_LESS_THAN_1'].includes(r.aiVetoCategory)) {
        continue;
      }

      const th = r.marketCapRank <= 150 ? thTop : thLow;
      if (r.aiWinProb >= th) {
        passTrades++;
        if (r.isWin) wins++;
        else if (r.isBe) bes++;
        else if (r.isSl) losses++;
        pnl += r.pnlUsd;
      }
    }

    const denom = passTrades - bes;
    const wr = denom > 0 ? (wins / denom) * 100 : 0;
    const item = { thTop, thLow, passTrades, wins, bes, losses, wr, pnl };
    gridResults.push(item);

    // Tiêu chí tối ưu: Tối đa hóa Net PnL với điều kiện số lệnh đủ lớn (passTrades >= 50) và WinRate >= 50%
    if (passTrades >= 50 && wr >= 52.0 && pnl > maxNetPnl) {
      maxNetPnl = pnl;
      bestConfig = item;
    }
  }
}

// Sắp xếp top 10 cấu hình Net PnL tốt nhất
gridResults.sort((a, b) => b.pnl - a.pnl);

console.log('Top 10 Cặp Ngưỡng Tối Ưu Lợi Nhuận Net PnL:');
console.log('Th_Top150 | Th_Lowcap | Lệnh Duyệt | Thắng | Hòa | Thua | WinRate (%) | Net PnL ($)');
console.log('-'.repeat(80));
gridResults.slice(0, 10).forEach(g => {
  console.log(`${(g.thTop + '%').padEnd(9)} | ${(g.thLow + '%').padEnd(9)} | ${String(g.passTrades).padStart(10)} | ${String(g.wins).padStart(5)} | ${String(g.bes).padStart(3)} | ${String(g.losses).padStart(4)} | ${g.wr.toFixed(2).padStart(11)}% | $${g.pnl.toFixed(2).padStart(10)}`);
});

if (bestConfig) {
  console.log('\n🏆 ĐIỂM NGƯỠNG ĐỀ XUẤT TỐI ƯU NHẤT:');
  console.log(`   • Ngưỡng Top 150 : ${bestConfig.thTop}%`);
  console.log(`   • Ngưỡng Lowcap  : ${bestConfig.thLow}%`);
  console.log(`   • Số lệnh duyệt  : ${bestConfig.passTrades} lệnh (${bestConfig.wins} TP, ${bestConfig.bes} BE, ${bestConfig.losses} SL)`);
  console.log(`   • WinRate đạt được: ${bestConfig.wr.toFixed(2)}% (Loại trừ BE)`);
  console.log(`   • Lợi nhuận Net PnL: +$${bestConfig.pnl.toFixed(2)} USD`);
}

console.log('\n' + '=' .repeat(80));
console.log('✅ HOÀN TẤT BÁO CÁO BACKTEST TOÀN DIỆN');
console.log('=' .repeat(80));
