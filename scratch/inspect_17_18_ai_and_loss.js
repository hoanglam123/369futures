const fs = require('fs');

const aiEvals = [];
const lines = fs.readFileSync('data/ai_evaluations.jsonl', 'utf8').split('\n');
for (const line of lines) {
  if (line.trim()) {
    try { aiEvals.push(JSON.parse(line.trim())); } catch(e){}
  }
}

const trades = [
  { time: '03:01:34 17/8', sym: 'BANANAS31USDT', side: 'SHORT', pnl: -4.94 },
  { time: '06:29:25 17/8', sym: 'SKYAIUSDT', side: 'LONG', pnl: 4.11 },
  { time: '07:04:27 17/8', sym: 'HOLOUSDT', side: 'LONG', pnl: 5.12 },
  { time: '07:05:59 17/8', sym: '1000XECUSDT', side: 'LONG', pnl: -1.01 },
  { time: '07:18:11 17/8', sym: 'CATIUSDT', side: 'LONG', pnl: -0.74 },
  { time: '09:01:10 17/8', sym: 'NILUSDT', side: 'SHORT', pnl: 0.18 },
  { time: '09:21:22 17/8', sym: 'MEWUSDT', side: 'LONG', pnl: 3.73 },
  { time: '14:00:47 17/8', sym: 'BANANAS31USDT', side: 'LONG', pnl: -0.13 },
  { time: '14:06:24 17/8', sym: 'EPICUSDT', side: 'LONG', pnl: -0.05 },
  { time: '18:40:33 17/8', sym: 'BLESSUSDT', side: 'LONG', pnl: -5.50 },
  { time: '21:21:39 17/8', sym: 'AINUSDT', side: 'LONG', pnl: 3.62 },
  { time: '02:16:21 18/8', sym: 'BANANAS31USDT', side: 'LONG', pnl: -5.31 },
  { time: '05:30:16 18/8', sym: 'B2USDT', side: 'LONG', pnl: -4.49 },
  { time: '07:23:48 18/8', sym: 'KAITOUSDT', side: 'LONG', pnl: -4.17 },
  { time: '08:54:50 18/8', sym: 'GMXUSDT', side: 'LONG', pnl: -4.28 },
  { time: '09:55:36 18/8', sym: 'HYPERUSDT', side: 'LONG', pnl: -5.37 }
];

console.log("=== PHÂN TÍCH CHI TIẾT 16 LỆNH (17/08 - 18/08) VỚI AI VÀ CÁC TIÊU CHÍ MỚI ===\n");

trades.forEach((t, i) => {
  const cleanSym = t.sym.replace('USDT', '').replace('1000', '');
  const cleanSymFull = t.sym.replace('USDT', '');
  const evs = aiEvals.filter(e => (e.symbol === cleanSym || e.symbol === cleanSymFull));
  const latestEv = evs.length > 0 ? evs[evs.length - 1] : null;

  const winProb = latestEv ? latestEv.winProbability : 'N/A';
  const reason = latestEv ? latestEv.aiReason : 'N/A';
  const isVeto = latestEv ? (latestEv.winProbability < 45 || (reason.includes('VOL_DRY') && reason.includes('OI_COOLING'))) : false;

  console.log(`${(i+1).toString().padStart(2, ' ')}. [${t.time}] ${t.pnl >= 0 ? '🟢 WIN ' : '🔴 LOSS'} ${t.sym.padEnd(14, ' ')} (${t.side}) | PnL gốc: ${t.pnl.toFixed(2)}u | AI WinProb: ${winProb}% | AI Veto: ${isVeto ? '🛑 CHẶN' : '🟢 DUYỆT'}`);
  if (latestEv) {
    console.log(`    Lý do AI: ${reason}`);
  }
});
