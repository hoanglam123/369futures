require('dotenv').config();
const { evaluateConfig } = require('./find_profitable_strategy.js');
const fs = require('fs');

async function testExpandedTop100() {
  const readline = require('readline');
  const signals = [];
  const rl = readline.createInterface({ input: fs.createReadStream('data/369_signals.jsonl') });
  const startTime = new Date('2026-08-14T00:00:00+07:00').getTime();
  for await (const line of rl) {
    if (line.trim()) {
      const s = JSON.parse(line);
      const tsStr = s.ts?.includes('+') || s.ts?.includes('Z') ? s.ts : `${s.ts}+07:00`;
      const t = new Date(tsStr).getTime();
      if (t >= startTime) signals.push({ ...s, symbolUSDT: `${s.symbol}USDT`, time: t });
    }
  }

  const aiEvals = {};
  if (fs.existsSync('data/ai_evaluations.jsonl')) {
    const rl2 = readline.createInterface({ input: fs.createReadStream('data/ai_evaluations.jsonl') });
    for await (const l of rl2) {
      if (l.trim()) {
        try {
          const item = JSON.parse(l);
          const sym = item.signal?.symbol || item.symbol;
          const prob = item.aiEvaluation?.winProbability || item.winProbability;
          const reasons = item.aiEvaluation?.reason || item.reason || '';
          if (sym && prob) aiEvals[sym] = { prob, reasons, score: item.signal?.score || item.score || 0 };
        } catch (_) {}
      }
    }
  }

  const capData = JSON.parse(fs.readFileSync('data/market_cap_top.json', 'utf8'));
  const top100 = new Set((capData.symbols || []).map(s => s.toUpperCase()));

  // Test various configs on Top 100
  const configs = [
    { name: 'A. Top100 + AI>=60% + Thuận Trend + TP 1:1.5', minAiProb: 60, minScore: 4.8, trendOnly: true, topOnly: true, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.45, hasPartial: true, lossTop: 5.0, lossLow: 2.5 },
    { name: 'B. Top100 + AI>=60% + TP 1:1.5 + M15 Retest', minAiProb: 60, minScore: 4.5, trendOnly: false, topOnly: true, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.45, hasPartial: true, lossTop: 5.0, lossLow: 2.5 },
    { name: 'C. Top100 + AI>=62% + Thuận Trend + TP 1:2', minAiProb: 62, minScore: 4.8, trendOnly: true, topOnly: true, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.5, hasPartial: true, lossTop: 5.0, lossLow: 2.5 },
    { name: 'D. AllCoins + AI>=63% + Thuận Trend + Lowcap Loss 1.5$', minAiProb: 63, minScore: 5.0, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 1.8, partialTpRatio: 0.5, hasPartial: true, lossTop: 4.0, lossLow: 1.5 },
    { name: 'E. AllCoins + AI>=60% + Thuận Trend + TP 1:2 (No Partial)', minAiProb: 60, minScore: 5.0, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.5, hasPartial: false, lossTop: 4.0, lossLow: 1.5 },
  ];

  console.log('=== KẾT QUẢ TỐI ƯU HÓA TOP 100 VÀ THUẬN TREND ===\n');
  for (const cfg of configs) {
    const res = await evaluateConfig(signals, aiEvals, cfg);
    const pnlColor = res.totalPnl >= 0 ? '🟢 +' : '🔴 ';
    console.log(`${cfg.name.padEnd(55)}: ${res.tradesCount} lệnh | ${res.wins}W / ${res.losses}L / ${res.beCount}BE (${res.winrate.toFixed(1)}%) => PnL: ${pnlColor}${res.totalPnl.toFixed(2)} USDT`);
    for (const t of res.executedTrades) {
      console.log(`     -> ${t.sym} (${t.side}) ${t.outcome}: ${(t.pnl>=0?'+':'')}${t.pnl.toFixed(2)}$ (${t.time})`);
    }
    console.log('-'.repeat(85));
  }
}

testExpandedTop100().catch(e => console.error(e));
