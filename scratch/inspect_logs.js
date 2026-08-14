const fs = require('fs');
const path = require('path');

const logPath = path.join(process.cwd(), 'logs', 'pm2-out.log');
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

const keywords = ['BOME', 'TA', 'SKYAI', 'BANANAS31', 'TRUST', 'STEEM', 'BANK', 'BICO', 'KAITO', 'HOLO'];
const targetLogs = [];

for (const line of lines) {
  if (line.includes('2026-08-13') || line.includes('2026-08-14')) {
    if (line.includes('BUY') || line.includes('SELL') || line.includes('Trailing SL') || line.includes('Stop Loss') || line.includes('Khớp') || line.includes('Virtual') || line.includes('Khóa Lãi') || line.includes('cắt lỗ') || line.includes('dịch SL')) {
      for (const kw of keywords) {
        if (line.includes(kw)) {
          targetLogs.push(line);
          break;
        }
      }
    }
  }
}

console.log(`Found ${targetLogs.length} relevant log lines:`);
for (const l of targetLogs.slice(-100)) {
  console.log(l);
}
