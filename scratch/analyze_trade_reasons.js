const fs = require('fs');
const readline = require('readline');
const path = require('path');

const symbols = [
  'BLESS', 'CRV', 'SFP', 'MON', 'SPX', 'VET', 'GUA', 
  '1MBABYDOGE', 'ETHFI', 'ILV', 'STEEM', 'SLP', 'NIL', 
  'LAYER', 'ME', 'EIGEN', 'BNB', 'EDEN', 'AKT', 'ZEREBRO', 'METIS'
];

async function analyzeLogs() {
  const logFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
  if (!fs.existsSync(logFile)) {
    console.log('Log file not found:', logFile);
    return;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(logFile),
    crlfDelay: Infinity
  });

  const matchedLogs = {};
  for (const sym of symbols) {
    matchedLogs[sym] = [];
  }

  for await (const line of rl) {
    for (const sym of symbols) {
      if (line.includes(sym)) {
        // filter interesting lines: entry, SL, TP, breakeven, close, hit, cancel, order, PnL, AI, signal
        matchedLogs[sym].push(line);
      }
    }
  }

  for (const sym of symbols) {
    console.log(`\n================== SYMBOL: ${sym} ==================`);
    const lines = matchedLogs[sym];
    const keyLines = lines.filter(l => 
      l.includes('ĐẶT LỆNH') || l.includes('KHỚP') || l.includes('ENTRY') || 
      l.includes('TP') || l.includes('SL') || l.includes('STOP') || 
      l.includes('DỪNG LỖ') || l.includes('CHỐT LỜI') || l.includes('BREAKEVEN') ||
      l.includes('Cắt') || l.includes('Đóng') || l.includes('Hit') || l.includes('Thoát') ||
      l.includes('Realized') || l.includes('PnL') || l.includes('Tín hiệu') || l.includes('AI')
    );
    console.log(keyLines.slice(-30).join('\n'));
  }
}

analyzeLogs();
