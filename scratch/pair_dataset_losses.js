const fs = require('fs');
const path = require('path');

const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
const lines = fs.readFileSync(datasetPath, 'utf8').split('\n');

const entries = {};
const exits = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('=') || trimmed.startsWith('>')) continue;
  try {
    const item = JSON.parse(trimmed);
    if (item.type === 'ENTRY') {
      entries[item.tradeId || item.orderId] = item;
    } else if (item.type === 'EXIT') {
      exits.push(item);
    }
  } catch (e) {}
}

console.log(`Total ENTRY records: ${Object.keys(entries).length}, EXIT records: ${exits.length}`);

// Combine paired trades
const paired = [];
for (const exit of exits) {
  const entry = entries[exit.tradeId || exit.orderId];
  if (entry) {
    paired.push({
      ...entry,
      ...exit,
      entryTimestamp: entry.timestamp,
      exitTimestamp: exit.exitTimestamp
    });
  } else {
    paired.push(exit);
  }
}

// Filter for 14/08 onwards
const start14 = new Date('2026-08-14T00:00:00+07:00').getTime();
const recentPaired = paired.filter(p => (p.exitTimestamp || p.timestamp) >= start14);
console.log(`Recent paired trades from 14/08: ${recentPaired.length}`);

const recentLosses = recentPaired.filter(p => !p.isWin || (p.pnlUsd || 0) < 0);
console.log(`Recent losses: ${recentLosses.length}`);

for (const l of recentLosses) {
  const tStr = new Date(l.exitTimestamp || l.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`\n======================================================`);
  console.log(`🔴 [${tStr}] ${l.symbol} (${l.signal}) | PnL: ${l.pnlUsd} USDT (${l.pnlPercent}%) | ExitType: ${l.exitType} | Dur: ${l.holdingDurationMinutes ? l.holdingDurationMinutes.toFixed(1) : 'N/A'} mins`);
  console.log(`   Entry: ${l.entryPrice} -> Exit: ${l.exitPrice} | Score: ${l.score} | GridWidth: ${l.gridWidthPct?.toFixed(2)}% | Rank: ${l.marketCapRank}`);
  if (l.scoreReasons) {
    console.log(`   Score reasons:`);
    l.scoreReasons.forEach(sr => console.log(`     - ${sr}`));
  }
}
