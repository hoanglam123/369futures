const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scratch/ai_mapping_results.json', 'utf8'));
const rows = data.tableRows;
const lossTrades = rows.filter(r => !r.isWin);

console.log(`Total loss trades: ${lossTrades.length}`);

// Split into Big Losses (<-4u) and Minor Losses (>-4u)
const bigLosses = lossTrades.filter(r => r.pnl <= -4);
const minorLosses = lossTrades.filter(r => r.pnl > -4);

console.log(`\n=== 1. PHÂN BỐ LỆNH THUA ===`);
console.log(`• Thua nặng (Lỗ > 4 USDT): ${bigLosses.length} lệnh | Tổng thiệt hại: ${bigLosses.reduce((a,b)=>a+b.pnl, 0).toFixed(2)} USDT`);
console.log(`• Thua nhẹ (Lỗ <= 1 USDT / BE / Panic): ${minorLosses.length} lệnh | Tổng thiệt hại: ${minorLosses.reduce((a,b)=>a+b.pnl, 0).toFixed(2)} USDT`);

// Analyze characteristics of Big Losses
console.log(`\n=== 2. CHI TIẾT 19 LỆNH THUA NẶNG (> 4 USDT) ===`);
bigLosses.sort((a,b)=>a.pnl - b.pnl).forEach((t, i) => {
  console.log(`${i+1}. [${t.closeTime}] ${t.symbol.padEnd(14)} (${t.side.padEnd(5)}) -> Lỗ: ${t.pnl.toFixed(2)} USDT | AI Prob: ${t.aiProb}%`);
});

// Check coins with repeated big losses
const coinLossCount = {};
for (const t of bigLosses) {
  if (!coinLossCount[t.symbol]) coinLossCount[t.symbol] = { count: 0, totalPnl: 0, sides: [] };
  coinLossCount[t.symbol].count++;
  coinLossCount[t.symbol].totalPnl += t.pnl;
  coinLossCount[t.symbol].sides.push(t.side);
}

console.log(`\n=== 3. CÁC COIN DÍNH THUA NẶNG NHIỀU LẦN (REPEATED LOSSES) ===`);
Object.entries(coinLossCount).filter(e => e[1].count >= 2).forEach(([sym, d]) => {
  console.log(`• ${sym}: ${d.count} lần thua nặng (${d.sides.join(', ')}) | Tổng lỗ: ${d.totalPnl.toFixed(2)} USDT`);
});
