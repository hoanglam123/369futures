const fs = require('fs');
const path = require('path');

const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
const lines = fs.readFileSync(datasetPath, 'utf8').split('\n');

const trades = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('=') || trimmed.startsWith('>')) continue;
  try {
    trades.push(JSON.parse(trimmed));
  } catch (e) {}
}

console.log(`Loaded ${trades.length} trades from ai_trade_dataset.jsonl`);

// Filter trades from 14/08/2026 onwards
const start14 = new Date('2026-08-14T00:00:00+07:00').getTime();
const recentTrades = trades.filter(t => (t.exitTimestamp || t.entryTimestamp) >= start14);
console.log(`Found ${recentTrades.length} recent trades in dataset.`);

// Let's inspect properties of losing trades
const losingRecent = recentTrades.filter(t => (t.realizedPnl || t.pnl || 0) < 0);
console.log(`Losing trades count in dataset: ${losingRecent.length}`);

// Print losing trade breakdown
for (const t of losingRecent) {
  const timeStr = new Date(t.exitTimestamp || t.entryTimestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`\n-----------------------------------------------------------`);
  console.log(`Symbol: ${t.symbol} | Side: ${t.side || t.signal} | PnL: ${t.realizedPnl || t.pnl} USDT | ExitType: ${t.exitType || t.exitReason || 'N/A'}`);
  console.log(`Time: ${timeStr} | Entry: ${t.entryPrice} -> Exit: ${t.exitPrice} | Score: ${t.score} | WinProb: ${t.winProbability}`);
  console.log(`Features / Metadata:`, {
    marketCapRank: t.marketCapRank,
    gridWidthPct: t.gridWidthPct,
    btcTrend: t.btcTrend || t.btcTrendH1,
    adxH1: t.adxH1,
    rsiH1: t.rsiH1,
    lsWhale: t.lsWhale || t.topLongShortRatio,
    lsRetail: t.lsRetail || t.retailLongShortRatio,
    fundingRate: t.fundingRate,
    dcaFilledCount: t.dcaFilledCount || t.filledOrdersCount,
    holdDurationMinutes: t.exitTimestamp && t.entryTimestamp ? ((t.exitTimestamp - t.entryTimestamp) / 60000).toFixed(1) : 'N/A'
  });
  if (t.scoreReasons) {
    console.log(`Score reasons:`, t.scoreReasons.slice(0, 3));
  }
}
