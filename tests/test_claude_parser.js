'use strict';

const { parseTrades } = require('../bot_new/src/services/tradeMonitor');
const { sanitizeAiHtml } = require('../bot_new/src/formatters/message');

console.log('=== TEST 1: Structured JSON Extraction ===');
const aiOutputWithJson = `
<thinking>
BTC score 8, ATR 1200. Entry 91000, TP 94000, SL 89000. R:R = 3000/2000 = 1.5. Good setup.
</thinking>

<b>🎯 Lệnh giao dịch</b>
<code>BTC | LONG | Vào: $91,000 | Target: $94,000 (+3.3%) | SL: $89,000 (-2.2%) | Đòn bẩy: 15x</code>
▸ TA: RSI 4h=55 | MACD Bullish
▸ <b>Lý do:</b> Breakout cản 4H kèm volume lớn

\`\`\`json
{
  "trades": [
    {
      "symbol": "BTC",
      "direction": "LONG",
      "entryPrice": 91000,
      "targetPrice": 94000,
      "slPrice": 89000,
      "leverage": 15,
      "confluenceScore": 8,
      "confidence": 80,
      "reason": "Breakout cản 4H kèm volume lớn"
    }
  ]
}
\`\`\`
`;

const trades1 = parseTrades(aiOutputWithJson);
console.log('Trades parsed count:', trades1.length);
if (trades1.length !== 1) throw new Error('Expected 1 trade');
const t1 = trades1[0];
console.log('Parsed Trade:', t1.symbol, t1.direction, 'entry:', t1.entryPrice, 'tp:', t1.targetPrice, 'sl:', t1.slPrice, 'tpPct:', t1.targetPct, 'slPct:', t1.slPct, 'source:', t1.source);
if (t1.source !== 'json') throw new Error('Expected source=json');
if (t1.targetPct !== 3.3) console.log('targetPct recalculated:', t1.targetPct);

console.log('\n=== TEST 2: Sanitize Telegram HTML ===');
const sanitized = sanitizeAiHtml(aiOutputWithJson);
console.log('Contains <thinking>?', sanitized.includes('<thinking>') || sanitized.includes('ATR 1200'));
console.log('Contains json block?', sanitized.includes('"trades"'));
console.log('Contains Telegram HTML?', sanitized.includes('<b>🎯 Lệnh giao dịch</b>'));
if (sanitized.includes('ATR 1200') || sanitized.includes('"trades"')) {
  throw new Error('Thinking or JSON not stripped properly!');
}

console.log('\n=== TEST 3: Inverted Hallucination Check ===');
const invertedJson = `
\`\`\`json
{
  "trades": [
    {
      "symbol": "ETH",
      "direction": "LONG",
      "entryPrice": 3000,
      "targetPrice": 3200,
      "slPrice": 3100,
      "leverage": 10,
      "confluenceScore": 8
    }
  ]
}
\`\`\`
`;
const tradesInverted = parseTrades(invertedJson);
console.log('Inverted trades parsed count (should be 0):', tradesInverted.length);
if (tradesInverted.length !== 0) throw new Error('Inverted trade was not rejected!');

console.log('\n=== TEST 4: Regex Fallback ===');
const legacyText = `
Confluence: 8đ · Tin cậy: 75%
<code>SOL | SHORT | Vào: $210.5 | Target: $195.0 (+7.36%) | SL: $218.0 (-3.56%) | Đòn bẩy: 10x</code>
Lý do: Đảo chiều tại kháng cự khung ngày kèm whale bán mạnh.
`;
const tradesLegacy = parseTrades(legacyText);
console.log('Legacy trades parsed count:', tradesLegacy.length);
if (tradesLegacy.length !== 1) throw new Error('Legacy regex fallback failed');
const tLegacy = tradesLegacy[0];
console.log('Legacy Trade:', tLegacy.symbol, tLegacy.direction, 'entry:', tLegacy.entryPrice, 'tp:', tLegacy.targetPrice, 'sl:', tLegacy.slPrice, 'source:', tLegacy.source, 'score:', tLegacy.confluenceScore);

console.log('\n=== TEST 5: English & Flexible Syntax Fallback ===');
const englishText = `
Confluence: 8đ · Tin cậy: 70%
<code>ETH | LONG | Entry: 3120.5 | Target: 3300.0 | SL: 3000.0 | Đòn bẩy: 10x</code>
Lý do: Setup test không có dấu dollar và dùng chữ Entry.
`;
const tradesEnglish = parseTrades(englishText);
console.log('English trades parsed count:', tradesEnglish.length);
if (tradesEnglish.length !== 1) throw new Error('English regex fallback failed');
const tEnglish = tradesEnglish[0];
console.log('English Trade:', tEnglish.symbol, tEnglish.direction, 'entry:', tEnglish.entryPrice, 'tp:', tEnglish.targetPrice, 'sl:', tEnglish.slPrice, 'source:', tEnglish.source);

console.log('\n✅ ALL 5 TESTS PASSED SUCCESSFULLY!');
