const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scratch/ai_mapping_results.json', 'utf8'));
const allTrades = data.tableRows;

const aiEvals = [];
const lines = fs.readFileSync('data/ai_evaluations.jsonl', 'utf8').split('\n');
for (const line of lines) {
  if (line.trim()) {
    try { aiEvals.push(JSON.parse(line.trim())); } catch(e){}
  }
}

allTrades.forEach(t => {
  const parts = t.closeTime.split(' ');
  const timeParts = parts[0].split(':');
  const dateParts = parts[1].split('/');
  const d = new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1], timeParts[2]);
  t.timestamp = d.getTime();

  const cleanSym = t.symbol.replace('USDT', '').replace('1000', '');
  const cleanSymFull = t.symbol.replace('USDT', '');
  const match = aiEvals.filter(e => (e.symbol === cleanSym || e.symbol === cleanSymFull) && e.timestamp <= t.timestamp);
  if (match.length > 0) {
    const ev = match[match.length - 1];
    t.aiProb = ev.winProbability;
    t.aiEvRoi = ev.expectedValueRoi;
    t.aiEvUsd = ev.expectedValueUsd;
    t.aiReasonFull = ev.aiReason || '';
    t.isVolDry = t.aiReasonFull.includes('VOL_DRY');
    t.isOiCooling = t.aiReasonFull.includes('OI_COOLING');
  } else {
    t.aiProb = null;
    t.aiEvRoi = null;
    t.aiEvUsd = null;
    t.isVolDry = false;
    t.isOiCooling = false;
  }
});

// Chạy so sánh:
// 1. Chỉ chặn WinProb < 45 hoặc (VOL_DRY && OI_COOLING)
// 2. Chặn thêm EV <= 0 (Kỳ vọng âm)
function simulateFilter(useEvFilter) {
  const executed = [];
  const blocked = [];

  for (const t of allTrades) {
    let isBlocked = false;
    const isBasicVeto = (t.aiProb != null && t.aiProb < 45.0) || (t.isVolDry && t.isOiCooling);
    
    if (useEvFilter) {
      const isEvNegative = (t.aiEvRoi != null && t.aiEvRoi < 0);
      isBlocked = isBasicVeto || isEvNegative;
    } else {
      isBlocked = isBasicVeto;
    }

    if (isBlocked) {
      blocked.push(t);
      continue;
    }

    let pnl = t.pnl;
    if (pnl < -4.0) pnl = -4.0;
    if (t.isWin) {
      if (pnl >= 3.0) pnl *= 1.20;
      else if (pnl >= 0.5) pnl *= 1.35;
    }

    executed.push({ ...t, pnl });
  }

  const w = executed.filter(t => t.isWin).length;
  const l = executed.filter(t => !t.isWin).length;
  const totalPnl = executed.reduce((s, t) => s + t.pnl, 0);

  return {
    useEvFilter,
    totalTrades: executed.length,
    wins: w,
    losses: l,
    winRate: ((w / executed.length) * 100).toFixed(1),
    totalPnl: totalPnl.toFixed(2),
    blockedCount: blocked.length
  };
}

console.log("=== KẾT QUẢ SO SÁNH CÓ DÙNG EV HAY KHÔNG ===");
const resNoEv = simulateFilter(false);
const resWithEv = simulateFilter(true);

console.log(`1. Hiện tại (Chỉ chặn WinProb < 45% & VolDry+OiCooling):`);
console.log(`   • Số lệnh: ${resNoEv.totalTrades} | Thắng: ${resNoEv.wins} | Thua: ${resNoEv.losses} | Winrate: ${resNoEv.winRate}% | PnL: +${resNoEv.totalPnl} USDT`);

console.log(`\n2. Khi tích hợp thêm điều kiện Chặn Lợi Nhuận Kỳ Vọng Âm (EV < 0):`);
console.log(`   • Số lệnh: ${resWithEv.totalTrades} | Thắng: ${resWithEv.wins} | Thua: ${resWithEv.losses} | Winrate: ${resWithEv.winRate}% | PnL: +${resWithEv.totalPnl} USDT`);
