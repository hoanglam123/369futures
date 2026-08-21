'use strict';

const fs = require('fs');

async function showPassedSignals() {
  const file = 'data/369_signals.jsonl';
  if (!fs.existsSync(file)) {
    console.log('No 369_signals.jsonl');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const recent = lines.slice(-8);

  console.log('='.repeat(80));
  console.log('📋 CÁC KÈO ĐƯỢC BOT CHẤP THUẬN VÀ BẮN SIGNAL GẦN ĐÂY:');
  console.log('='.repeat(80));

  recent.forEach((line, i) => {
    try {
      const s = JSON.parse(line);
      console.log(`\n--- Signal #${i + 1} (${new Date(s.timestamp || Date.now()).toLocaleString('vi-VN')}) ---`);
      console.log(`  • Coin: ${s.symbol} (${s.signal}) | Entry: $${s.targetLevel}`);
      console.log(`  • AI WinProb: ${s.aiEval?.winProbability ? (s.aiEval.winProbability * 100).toFixed(1) + '%' : (s.aiEval?.winRate || 'N/A')}`);
      console.log(`  • Điểm Core PP369: ${s.score}/10`);
      console.log(`  • Lý do & Yếu tố: ${JSON.stringify(s.scoreReasons || s.aiEval?.keyFactors || [])}`);
    } catch (_) {}
  });
}

showPassedSignals();
