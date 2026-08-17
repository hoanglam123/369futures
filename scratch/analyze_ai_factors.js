const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scratch/ai_mapping_results.json', 'utf8'));
const rows = data.tableRows;

const aiEvals = [];
const lines = fs.readFileSync('data/ai_evaluations.jsonl', 'utf8').split('\n');
for (const line of lines) {
  if (line.trim()) {
    try { aiEvals.push(JSON.parse(line.trim())); } catch(e){}
  }
}

const factorStats = {};

for (const r of rows) {
  const cleanSym = r.symbol.replace('USDT', '').replace('1000', '');
  const cleanSymFull = r.symbol.replace('USDT', '');

  const match = aiEvals.filter(e => (e.symbol === cleanSym || e.symbol === cleanSymFull));
  if (match.length > 0) {
    const ev = match[match.length - 1];
    const isWin = r.isWin;
    const pnl = r.pnl;
    
    const factorMatches = (ev.aiReason || '').match(/([+-]\s*[A-Z0-9_]+)/g) || [];
    for (const f of factorMatches) {
      const fName = f.trim();
      if (!factorStats[fName]) {
        factorStats[fName] = { count: 0, wins: 0, losses: 0, pnl: 0 };
      }
      factorStats[fName].count++;
      if (isWin) factorStats[fName].wins++;
      else factorStats[fName].losses++;
      factorStats[fName].pnl += pnl;
    }
  }
}

console.log("=== THỐNG KÊ CÁC YẾU TỐ ĐÁNH GIÁ CỦA AI (AI FACTORS) TRÊN 68 LỆNH ===");
console.log("| Yếu tố AI đánh giá | Số lệnh | Thắng | Thua | Winrate | Tổng PnL |");
console.log("|---|---|---|---|---|---|");
const sortedFactors = Object.entries(factorStats).filter(e => e[1].count >= 3).sort((a,b) => b[1].pnl - a[1].pnl);
for (const [fname, s] of sortedFactors) {
  const wr = ((s.wins / s.count) * 100).toFixed(1);
  console.log(`| ${fname.padEnd(20)} | ${s.count} | ${s.wins} | ${s.losses} | ${wr}% | ${(s.pnl>=0?'+':'')+s.pnl.toFixed(2)} USDT |`);
}
