'use strict';

const fs = require('fs');
const readline = require('readline');

async function showRecentSignals() {
  const file = 'data/ai_evaluations.jsonl';
  if (!fs.existsSync(file)) {
    console.log('No ai_evaluations.jsonl file found.');
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const recent = lines.slice(-10);

  console.log('='.repeat(80));
  console.log('📋 10 ĐÁNH GIÁ AI GẦN NHẤT:');
  console.log('='.repeat(80));

  recent.forEach((line, i) => {
    try {
      const data = JSON.parse(line);
      const prob = data.winProbability ? (data.winProbability * 100).toFixed(1) + '%' : (data.finalProb ? (data.finalProb * 100).toFixed(1) + '%' : 'N/A');
      const veto = data.veto ? '❌ BỊ VETO' : '✅ ĐẠT (PASS)';
      const reasons = (data.positiveFactors || data.keyFactors || []).join(', ') || 'N/A';
      console.log(`[${new Date(data.timestamp || Date.now()).toLocaleTimeString('vi-VN')}] ${data.symbol} (${data.signal}) | WinProb: ${prob} | Status: ${veto}`);
      console.log(`   • Yếu tố: ${reasons}`);
      console.log(`   • Score ban đầu: ${data.originalScore || data.score || 'N/A'}/100\n`);
    } catch (_) {}
  });
}

showRecentSignals();
