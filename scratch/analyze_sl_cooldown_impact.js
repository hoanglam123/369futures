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
  } else {
    t.isVolDry = false;
    t.isOiCooling = false;
  }
});

allTrades.sort((a, b) => a.timestamp - b.timestamp);

// Filter out AI Veto trades first (as Criterion 3 is active)
const validTrades = allTrades.filter(t => !(t.aiProb != null && t.aiProb < 45) && !(t.isVolDry && t.isOiCooling));

console.log(`=== TẬP LỆNH HỢP LỆ SAU AI VETO: ${validTrades.length} LỆNH ===\n`);

// 1. Phân tích chi tiết từng lần 1 coin có lệnh sau khi dính SL
console.log("=== CHI TIẾT CÁC LỆNH XẢY RA SAU KHI DÍNH SL TRÊN CÙNG 1 COIN ===");

const coinHistory = {}; // sym -> list of trades
for (const t of validTrades) {
  if (!coinHistory[t.symbol]) coinHistory[t.symbol] = [];
  coinHistory[t.symbol].push(t);
}

const followUpTrades = [];

for (const [sym, trades] of Object.entries(coinHistory)) {
  if (trades.length > 1) {
    for (let i = 0; i < trades.length - 1; i++) {
      const prev = trades[i];
      if (prev.pnl <= -2.0) { // vừa dính SL
        for (let j = i + 1; j < trades.length; j++) {
          const curr = trades[j];
          const diffHours = (curr.timestamp - prev.timestamp) / (3600 * 1000);
          if (diffHours <= 12) {
            followUpTrades.push({
              sym,
              prevTrade: prev,
              currTrade: curr,
              diffHours: diffHours.toFixed(1),
              isSameSide: prev.side === curr.side
            });
          }
        }
      }
    }
  }
}

console.log(`Tìm thấy ${followUpTrades.length} lệnh phát sinh trong vòng 12h sau 1 lệnh thua nặng:`);
followUpTrades.forEach((f, idx) => {
  const prevStr = `${f.prevTrade.side} (${f.prevTrade.pnl.toFixed(2)}u)`;
  const currStr = `${f.currTrade.side} (${f.currTrade.pnl >= 0 ? '+' : ''}${f.currTrade.pnl.toFixed(2)}u)`;
  const outcome = f.currTrade.isWin ? '🟢 THẮNG' : '🔴 THUA';
  console.log(` ${idx + 1}. [${f.sym}] Trước: ${prevStr} ➔ Sau ${f.diffHours}h: ${currStr} | Chiều: ${f.isSameSide ? 'CÙNG CHIỀU' : 'ĐẢO CHIỀU'} | Kết quả: ${outcome}`);
});

// -----------------------------------------------------------------
// SO SÁNH 3 PHƯƠNG ÁN:
// -----------------------------------------------------------------
// Option A: CÓ COOLDOWN 12H TOÀN BỘ (Chặn cả Long lẫn Short)
// Option B: KHÔNG COOLDOWN (Bỏ hẳn tiêu chí này)
// Option C: COOLDOWN CÙNG CHIỀU (Same-Side Cooldown: chỉ cấm cùng chiều, cho phép đảo chiều)

function evaluateStrategy(cooldownMode) {
  // cooldownMode: 'NONE' | 'FULL_12H' | 'SAME_SIDE_12H'
  const cdMap = {}; // key -> expiryTimestamp
  const executed = [];
  const blocked = [];

  for (const t of validTrades) {
    const fullKey = t.symbol;
    const sideKey = `${t.symbol}_${t.side}`;

    let isBlocked = false;
    if (cooldownMode === 'FULL_12H') {
      if (cdMap[fullKey] && t.timestamp < cdMap[fullKey]) isBlocked = true;
    } else if (cooldownMode === 'SAME_SIDE_12H') {
      if (cdMap[sideKey] && t.timestamp < cdMap[sideKey]) isBlocked = true;
    }

    if (isBlocked) {
      blocked.push(t);
      continue;
    }

    // Áp dụng Hard Max Loss -4.0u và Trailing TP
    let pnl = t.pnl;
    if (pnl < -4.0) pnl = -4.0;
    if (t.isWin) {
      if (pnl >= 3.0) pnl *= 1.20;
      else if (pnl >= 0.5) pnl *= 1.35;
    }

    executed.push({ ...t, pnl });

    // Cập nhật Cooldown nếu thua nặng
    if (t.pnl <= -2.0) {
      if (cooldownMode === 'FULL_12H') {
        cdMap[fullKey] = t.timestamp + 12 * 3600 * 1000;
      } else if (cooldownMode === 'SAME_SIDE_12H') {
        cdMap[sideKey] = t.timestamp + 12 * 3600 * 1000;
      }
    }
  }

  const w = executed.filter(t => t.isWin).length;
  const l = executed.filter(t => !t.isWin).length;
  const totalPnl = executed.reduce((s, t) => s + t.pnl, 0);

  return {
    mode: cooldownMode,
    totalTrades: executed.length,
    wins: w,
    losses: l,
    winRate: ((w / executed.length) * 100).toFixed(1),
    totalPnl: totalPnl.toFixed(2),
    blockedCount: blocked.length
  };
}

console.log("\n==========================================================================");
console.log("📊 BẢNG SO SÁNH GIỮA CÁC LỰA CHỌN COOLDOWN:");
console.log("==========================================================================");

const resNone = evaluateStrategy('NONE');
const resSameSide = evaluateStrategy('SAME_SIDE_12H');
const resFull = evaluateStrategy('FULL_12H');

console.log(`1. KHÔNG DÙNG COOLDOWN (Bỏ hẳn tiêu chí này):`);
console.log(`   • Số lệnh: ${resNone.totalTrades} | Thắng: ${resNone.wins} | Thua: ${resNone.losses} | Winrate: ${resNone.winRate}%`);
console.log(`   • Realized PnL: +${resNone.totalPnl} USDT 🚀 (CAO NHẤT!)\n`);

console.log(`2. COOLDOWN CÙNG CHIỀU (Same-side Cooldown - Chỉ cấm cùng chiều, cho phép đảo chiều):`);
console.log(`   • Số lệnh: ${resSameSide.totalTrades} | Thắng: ${resSameSide.wins} | Thua: ${resSameSide.losses} | Winrate: ${resSameSide.winRate}%`);
console.log(`   • Realized PnL: +${resSameSide.totalPnl} USDT\n`);

console.log(`3. COOLDOWN TOÀN PHẦN (Khóa cứng cả 2 chiều 12h - Code cũ):`);
console.log(`   • Số lệnh: ${resFull.totalTrades} | Thắng: ${resFull.wins} | Thua: ${resFull.losses} | Winrate: ${resFull.winRate}%`);
console.log(`   • Realized PnL: +${resFull.totalPnl} USDT (Bị giảm do chặn nhầm lệnh thắng)\n`);
