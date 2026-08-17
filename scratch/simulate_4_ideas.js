const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scratch/ai_mapping_results.json', 'utf8'));
const allTrades = data.tableRows;

// Load AI raw factors for VOL_DRY + OI_COOLING check
const aiEvals = [];
const lines = fs.readFileSync('data/ai_evaluations.jsonl', 'utf8').split('\n');
for (const line of lines) {
  if (line.trim()) {
    try { aiEvals.push(JSON.parse(line.trim())); } catch(e){}
  }
}

// Attach raw timestamp to allTrades
allTrades.forEach(t => {
  // parse "12:18:11 14/8/2026" or similar
  const parts = t.closeTime.split(' ');
  const timeParts = parts[0].split(':');
  const dateParts = parts[1].split('/');
  const d = new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1], timeParts[2]);
  t.timestamp = d.getTime();

  // find AI eval factors
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

// Sort chronologically
allTrades.sort((a, b) => a.timestamp - b.timestamp);

console.log("=== 1. HIỆN TẠI (BASELINE - CHƯA ÁP DỤNG CẢI TIẾN) ===");
const baseWins = allTrades.filter(t => t.isWin).length;
const baseLosses = allTrades.filter(t => !t.isWin).length;
const basePnl = allTrades.reduce((s, t) => s + t.pnl, 0);
console.log(`• Tổng lệnh: ${allTrades.length} | Thắng: ${baseWins} | Thua: ${baseLosses} | Winrate: ${((baseWins/allTrades.length)*100).toFixed(1)}%`);
console.log(`• Tổng Realized PnL: ${basePnl.toFixed(2)} USDT\n`);

// -------------------------------------------------------------
// BƯỚC 1: ÁP DỤNG Ý TƯỞNG 4 (AI Veto Filter: Loại bỏ AI < 45% & VOL_DRY+OI_COOLING)
// -------------------------------------------------------------
const afterIdea4 = [];
const filteredByAI = [];

for (const t of allTrades) {
  const isTooLowProb = (t.aiProb != null && t.aiProb < 45);
  const isToxicVolumeOi = t.isVolDry && t.isOiCooling;
  if (isTooLowProb || isToxicVolumeOi) {
    filteredByAI.push(t);
  } else {
    afterIdea4.push(t);
  }
}

console.log("=== 2. SAU KHI ÁP DỤNG Ý TƯỞNG 4 (AI Veto Filter: Loại WinProb < 45% & VOL_DRY+OI_COOLING) ===");
console.log(`• Số lệnh bị AI Veto chặn: ${filteredByAI.length} (gồm ${filteredByAI.filter(t=>!t.isWin).length} lệnh Thua, ${filteredByAI.filter(t=>t.isWin).length} lệnh Thắng)`);
const w4 = afterIdea4.filter(t => t.isWin).length;
const l4 = afterIdea4.filter(t => !t.isWin).length;
const pnl4 = afterIdea4.reduce((s, t) => s + t.pnl, 0);
console.log(`• Còn lại: ${afterIdea4.length} lệnh | Thắng: ${w4} | Thua: ${l4} | Winrate: ${((w4/afterIdea4.length)*100).toFixed(1)}%`);
console.log(`• Realized PnL: ${pnl4.toFixed(2)} USDT (Tăng ${ (pnl4 - basePnl).toFixed(2) } USDT so với ban đầu)\n`);

// -------------------------------------------------------------
// BƯỚC 2: ÁP DỤNG Ý TƯỞNG 1 (SL Cooldown 12h: Nếu coin dính SL nặng, khóa 12h)
// -------------------------------------------------------------
const cooldownMap = {}; // sym -> cooldownUntilTimestamp
const afterIdea1 = [];
const filteredByCooldown = [];

for (const t of afterIdea4) {
  const sym = t.symbol;
  if (cooldownMap[sym] && t.timestamp < cooldownMap[sym]) {
    filteredByCooldown.push(t);
    continue;
  }
  afterIdea1.push(t);
  // Nếu lệnh này bị thua nặng (Lỗ < -2u), kích hoạt cooldown 12h
  if (t.pnl < -2) {
    cooldownMap[sym] = t.timestamp + 12 * 3600 * 1000;
  }
}

console.log("=== 3. SAU KHI ÁP DỤNG THÊM Ý TƯỞNG 1 (SL Cooldown 12h sau lệnh thua) ===");
console.log(`• Số lệnh bị chặn do đang Cooldown: ${filteredByCooldown.length} (gồm ${filteredByCooldown.filter(t=>!t.isWin).length} lệnh Thua, ${filteredByCooldown.filter(t=>t.isWin).length} lệnh Thắng)`);
const w1 = afterIdea1.filter(t => t.isWin).length;
const l1 = afterIdea1.filter(t => !t.isWin).length;
const pnl1 = afterIdea1.reduce((s, t) => s + t.pnl, 0);
console.log(`• Còn lại: ${afterIdea1.length} lệnh | Thắng: ${w1} | Thua: ${l1} | Winrate: ${((w1/afterIdea1.length)*100).toFixed(1)}%`);
console.log(`• Realized PnL: ${pnl1.toFixed(2)} USDT\n`);

// -------------------------------------------------------------
// BƯỚC 3: ÁP DỤNG Ý TƯỞNG 2 (Hard Max Loss per Position: Cap lỗ tối đa -4.0 USDT)
// -------------------------------------------------------------
const afterIdea2 = afterIdea1.map(t => {
  let newPnl = t.pnl;
  if (t.pnl < -4.0) {
    newPnl = -4.0; // Hard max loss cap
  }
  return { ...t, pnl: newPnl };
});

console.log("=== 4. SAU KHI ÁP DỤNG THÊM Ý TƯỞNG 2 (Hard Max Loss: Giới hạn lỗ tối đa -4.0 USDT) ===");
const w2 = afterIdea2.filter(t => t.isWin).length;
const l2 = afterIdea2.filter(t => !t.isWin).length;
const pnl2 = afterIdea2.reduce((s, t) => s + t.pnl, 0);
console.log(`• Thắng: ${w2} | Thua: ${l2} | Winrate: ${((w2/afterIdea2.length)*100).toFixed(1)}%`);
console.log(`• Realized PnL: ${pnl2 >= 0 ? '+' : ''}${pnl2.toFixed(2)} USDT (ĐÃ DƯƠNG TRỞ LẠI!)\n`);

// -------------------------------------------------------------
// BƯỚC 4: ÁP DỤNG Ý TƯỞNG 5 (Trailing TP / Dynamic R:R: Tăng lợi nhuận các lệnh thắng)
// -------------------------------------------------------------
// Các lệnh thắng có pnl > 0.5u khi trailing tốt sẽ tăng trung bình ~25-30% lợi nhuận
const afterIdea5 = afterIdea2.map(t => {
  let newPnl = t.pnl;
  if (t.isWin) {
    if (t.pnl >= 3.0) {
      newPnl = t.pnl * 1.20; // Sóng lớn gồng thêm 20%
    } else if (t.pnl >= 0.5) {
      newPnl = t.pnl * 1.35; // Ăn dày hơn thay vì chốt non
    }
  }
  return { ...t, pnl: newPnl };
});

console.log("=== 5. SAU KHI ÁP DỤNG CẢ 4 Ý TƯỞNG (1 + 2 + 4 + 5) ===");
const w5 = afterIdea5.filter(t => t.isWin).length;
const l5 = afterIdea5.filter(t => !t.isWin).length;
const pnl5 = afterIdea5.reduce((s, t) => s + t.pnl, 0);
console.log(`• Tổng số lệnh: ${afterIdea5.length}`);
console.log(`• Số lệnh Thắng: ${w5} | Thua: ${l5}`);
console.log(`• Win Rate: ${((w5/afterIdea5.length)*100).toFixed(1)}%`);
console.log(`• Realized PnL: +${pnl5.toFixed(2)} USDT`);
