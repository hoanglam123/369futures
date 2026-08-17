const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scratch/ai_mapping_results.json', 'utf8'));
const rows = data.tableRows;

console.log("=== PHÂN TÍCH TƯƠNG QUAN GIỮA WIN PROBABILITY VÀ KẾT QUẢ THỰC TẾ ===");

// Check average winProbability for winning trades vs losing trades
const winTrades = rows.filter(r => r.isWin);
const lossTrades = rows.filter(r => !r.isWin);

const avgProbWin = winTrades.reduce((acc, r) => acc + (r.aiProb || 0), 0) / winTrades.length;
const avgProbLoss = lossTrades.reduce((acc, r) => acc + (r.aiProb || 0), 0) / lossTrades.length;

console.log(`\n1. Xác suất thắng trung bình do AI dự đoán:`);
console.log(`   • Nhóm lệnh THẮNG thực tế (${winTrades.length} lệnh): Xác suất AI đánh giá = ${avgProbWin.toFixed(2)}%`);
console.log(`   • Nhóm lệnh THUA thực tế (${lossTrades.length} lệnh):   Xác suất AI đánh giá = ${avgProbLoss.toFixed(2)}%`);

// Group by probability thresholds
const thresholds = [40, 45, 50, 52, 55, 58, 60, 65];

console.log(`\n2. Thống kê theo các ngưỡng Win Probability của AI:`);
console.log(`| Ngưỡng Prob | Số lệnh | Thắng | Thua | Winrate | Tổng PnL | Lãi TB/lệnh |`);
console.log(`|---|---|---|---|---|---|---|`);

for (const th of thresholds) {
  const subset = rows.filter(r => (r.aiProb || 0) >= th);
  const w = subset.filter(r => r.isWin).length;
  const l = subset.filter(r => !r.isWin).length;
  const wr = subset.length > 0 ? ((w / subset.length) * 100).toFixed(1) : 0;
  const pnl = subset.reduce((acc, r) => acc + r.pnl, 0);
  const avgPnl = subset.length > 0 ? (pnl / subset.length).toFixed(2) : 0;
  console.log(`| >= ${th}% | ${subset.length} | ${w} | ${l} | ${wr}% | ${pnl.toFixed(2)} USDT | ${avgPnl} USDT |`);
}

// Show biggest losses and AI's warning on them
console.log(`\n3. Chi tiết các lệnh thua lớn nhất (Loss > 4 USDT) và cảnh báo từ AI:`);
const bigLosses = lossTrades.filter(r => r.pnl < -4).sort((a, b) => a.pnl - b.pnl);
bigLosses.forEach((r, idx) => {
  console.log(` ${idx + 1}. [${r.closeTime}] ${r.symbol} (${r.side}) -> PnL: ${r.pnl.toFixed(2)} USDT | AI Prob: ${r.aiProb}% | AI Khuyên: ${r.aiReason}`);
});

// Show all 68 trades in a clean log
console.log(`\n4. Toàn bộ 68 lệnh đã map với AI:`);
rows.forEach((r, idx) => {
  const res = r.isWin ? '🟢 WIN' : '🔴 LOSS';
  console.log(`${String(idx+1).padStart(2, '0')}. [${r.closeTime}] ${res} ${r.symbol.padEnd(14)} (${r.side.padEnd(5)}) PnL: ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2)} USDT | AI: ${r.aiProb}% (${r.aiReason})`);
});
