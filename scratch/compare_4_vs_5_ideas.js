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
    t.aiReasonFull = ev.aiReason || '';
    t.isVolDry = t.aiReasonFull.includes('VOL_DRY');
    t.isOiCooling = t.aiReasonFull.includes('OI_COOLING');
    t.scoreReasons = ev.scoreReasons || [];
    // Check if counter trend
    t.isCounterTrend = t.scoreReasons.some(r => r.includes('Ngược/Mâu thuẫn cấu trúc') || r.includes('ngược xu hướng'));
  } else {
    t.isVolDry = false;
    t.isOiCooling = false;
    t.isCounterTrend = false;
  }
});

allTrades.sort((a, b) => a.timestamp - b.timestamp);

// -------------------------------------------------------------------------
// SCENARIO A: ÁP DỤNG 4 TIÊU CHÍ (1 + 2 + 4 + 5) - KHÔNG CÓ Ý TƯỞNG 3
// -------------------------------------------------------------------------
// 1. AI Veto (Idea 4)
let trades4 = allTrades.filter(t => !(t.aiProb != null && t.aiProb < 45) && !(t.isVolDry && t.isOiCooling));

// 2. SL Cooldown 12h (Idea 1)
const cdMap4 = {};
const afterCd4 = [];
for (const t of trades4) {
  if (cdMap4[t.symbol] && t.timestamp < cdMap4[t.symbol]) continue;
  afterCd4.push(t);
  if (t.pnl < -2) cdMap4[t.symbol] = t.timestamp + 12 * 3600 * 1000;
}

// 3. Hard Max Loss -4.0u (Idea 2) + Trailing TP (Idea 5)
const final4 = afterCd4.map(t => {
  let p = t.pnl;
  if (p < -4.0) p = -4.0;
  if (t.isWin) {
    if (p >= 3.0) p *= 1.20;
    else if (p >= 0.5) p *= 1.35;
  }
  return { ...t, pnl: p };
});

const w4 = final4.filter(t => t.isWin).length;
const l4 = final4.filter(t => !t.isWin).length;
const pnl4 = final4.reduce((s, t) => s + t.pnl, 0);

// -------------------------------------------------------------------------
// SCENARIO B: ÁP DỤNG CẢ 5 TIÊU CHÍ (1 + 2 + 3 + 4 + 5) - CÓ THÊM Ý TƯỞNG 3
// (Idea 3: Cấm các lệnh Ngược Trend / Cản Tàu)
// -------------------------------------------------------------------------
// 1. AI Veto (Idea 4) + Cấm Counter-Trend (Idea 3)
let trades5 = allTrades.filter(t => {
  if ((t.aiProb != null && t.aiProb < 45) || (t.isVolDry && t.isOiCooling)) return false;
  if (t.isCounterTrend) return false; // Cấm counter-trend
  return true;
});

// 2. SL Cooldown 12h (Idea 1)
const cdMap5 = {};
const afterCd5 = [];
for (const t of trades5) {
  if (cdMap5[t.symbol] && t.timestamp < cdMap5[t.symbol]) continue;
  afterCd5.push(t);
  if (t.pnl < -2) cdMap5[t.symbol] = t.timestamp + 12 * 3600 * 1000;
}

// 3. Hard Max Loss -4.0u (Idea 2) + Trailing TP (Idea 5)
const final5 = afterCd5.map(t => {
  let p = t.pnl;
  if (p < -4.0) p = -4.0;
  if (t.isWin) {
    if (p >= 3.0) p *= 1.20;
    else if (p >= 0.5) p *= 1.35;
  }
  return { ...t, pnl: p };
});

const w5 = final5.filter(t => t.isWin).length;
const l5 = final5.filter(t => !t.isWin).length;
const pnl5 = final5.reduce((s, t) => s + t.pnl, 0);

console.log("=== SO SÁNH TRỰC DIỆN: 4 TIÊU CHÍ VS 5 TIÊU CHÍ ===");
console.log(`\n1. KHI ÁP DỤNG 4 TIÊU CHÍ (Không có Ý tưởng 3):`);
console.log(`   • Tổng số lệnh: ${final4.length}`);
console.log(`   • Thắng: ${w4} | Thua: ${l4} | Winrate: ${((w4/final4.length)*100).toFixed(1)}%`);
console.log(`   • Tổng Realized PnL: +${pnl4.toFixed(2)} USDT`);

console.log(`\n2. KHI ÁP DỤNG CẢ 5 TIÊU CHÍ (Có Ý tưởng 3 - Chặn cản tàu):`);
console.log(`   • Tổng số lệnh: ${final5.length}`);
console.log(`   • Thắng: ${w5} | Thua: ${l5} | Winrate: ${((w5/final5.length)*100).toFixed(1)}%`);
console.log(`   • Tổng Realized PnL: +${pnl5.toFixed(2)} USDT`);

// Find the trades blocked by Idea 3
const blockedByIdea3 = afterCd4.filter(t => t.isCounterTrend);
console.log(`\n3. CHI TIẾT CÁC LỆNH BỊ Ý TƯỞNG 3 CHẶN BỎ (${blockedByIdea3.length} lệnh):`);
const winBlocked = blockedByIdea3.filter(t => t.isWin);
const lossBlocked = blockedByIdea3.filter(t => !t.isWin);
console.log(`   • Lệnh Thắng bị chặn: ${winBlocked.length} lệnh (Tổng lãi bỏ lỡ: +${winBlocked.reduce((s,t)=>s+t.pnl, 0).toFixed(2)} USDT)`);
console.log(`   • Lệnh Thua bị chặn:   ${lossBlocked.length} lệnh (Tổng lỗ tránh được: ${lossBlocked.reduce((s,t)=>s+t.pnl, 0).toFixed(2)} USDT)`);
blockedByIdea3.forEach(t => {
  console.log(`     - [${t.closeTime}] ${t.isWin ? '🟢 WIN' : '🔴 LOSS'} ${t.symbol.padEnd(14)} (${t.side.padEnd(5)}) PnL: ${(t.pnl>=0?'+':'')+t.pnl.toFixed(2)} USDT`);
});
