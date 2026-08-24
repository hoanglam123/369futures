'use strict';

require('dotenv').config();

function getDynamicTargetLossUSD(rank, winProb, score, baseLossUSD = 5.0) {
  let multiplier = 1.0;
  if (rank <= 10 || (score >= 7.0 && winProb >= 75.0 && rank <= 50)) {
    multiplier = 1.5; // ~$7.5 USD
  } else if (rank <= 50 && winProb >= 70.0) {
    multiplier = 1.3; // ~$6.5 USD
  } else if (winProb >= 68.0 && rank <= 150) {
    multiplier = 1.15; // ~$5.75 USD
  }
  return Number((baseLossUSD * multiplier).toFixed(2));
}

console.log('=== KIỂM THỬ PHÂN BỔ MARGIN SMART SIZING ===\n');

const testCases = [
  { sym: 'BTC', rank: 1, winProb: 76.5, score: 7.2, desc: 'Top 10 Ultra Setup' },
  { sym: 'SOL', rank: 5, winProb: 72.0, score: 6.8, desc: 'Top 10 High Setup' },
  { sym: 'NEAR', rank: 33, winProb: 71.5, score: 6.5, desc: 'Top 50 High Conviction' },
  { sym: 'ENS', rank: 119, winProb: 68.6, score: 6.4, desc: 'Top 150 Good Setup' },
  { sym: 'AKT', rank: 140, winProb: 65.3, score: 6.4, desc: 'Top 150 Standard Setup' },
  { sym: 'IOST', rank: 642, winProb: 68.2, score: 6.1, desc: 'Low-Cap Standard' }
];

testCases.forEach(tc => {
  const lossUSD = getDynamicTargetLossUSD(tc.rank, tc.winProb, tc.score, 5.0);
  const slPct = 1.2; // 1.2% SL giả định
  const lev = 40; // 40x leverage
  const margin = (lossUSD / (lev * (slPct / 100))).toFixed(2);
  const winProfit1_5 = (lossUSD * 1.5).toFixed(2);
  console.log(`[${tc.sym.padEnd(5)}] (Rank #${tc.rank.toString().padEnd(3)} | WinProb: ${tc.winProb}% | Score: ${tc.score})`);
  console.log(`  -> Phân loại: ${tc.desc}`);
  console.log(`  -> Target Loss: $${lossUSD} USD | Margin Ký Quỹ: ~$${margin} USDT | Lãi TP 1:1.5: +$${winProfit1_5} USDT\n`);
});
