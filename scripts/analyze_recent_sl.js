import fs from 'fs';
import readline from 'readline';

const START_TIME = '2026-10-22 10:00:00';

async function analyzeRecent() {
  const file = 'logs/pm2-out.log';
  if (!fs.existsSync(file)) return;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  const slTrades = [];
  const tpTrades = [];
  const beTrades = [];
  const guardEvents = [];
  const standDownEvents = [];

  for await (const line of rl) {
    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!timeMatch) continue;
    const logTime = timeMatch[1];
    if (logTime < START_TIME) continue;

    // SL
    if (line.includes('[DirectionalCB]') || line.includes('dính SL') || line.includes('dnh SL') || (line.includes('CỨU TÀI KHOẢN') || line.includes('C?U TAI KHO') || line.includes('C"U TA?I KHO'))) {
      slTrades.push({ time: logTime, line: line.trim() });
    }

    // TP
    if (line.includes('Partial TP') || line.includes('Chạm TP') || line.includes('Ch?m TP') || line.includes('BỎ LỠ LÃI') || line.includes('B? L? LAI')) {
      tpTrades.push({ time: logTime, line: line.trim() });
    }

    // BE
    if (line.includes('THOÁT HÒA VỐN') || line.includes('THOA?T HA') || line.includes('cắn BE') || line.includes('c?n BE')) {
      beTrades.push({ time: logTime, line: line.trim() });
    }

    // PerformanceGuard
    if (line.includes('[PerformanceGuard]') || line.includes('Stand-Down Mode') || line.includes('Stand-Down')) {
      guardEvents.push({ time: logTime, line: line.trim() });
    }
  }

  console.log('=== CÁC SỰ KIỆN TỪ 10:00 ĐẾN 13:20 SÁNG/TRƯA 22/10 ===');
  console.log('\n--- SL TRADES (REAL + SHADOW) ---');
  slTrades.forEach(s => console.log(`[${s.time}] ${s.line}`));

  console.log('\n--- TP TRADES ---');
  tpTrades.forEach(t => console.log(`[${t.time}] ${t.line}`));

  console.log('\n--- PERFORMANCE GUARD / STAND-DOWN EVENTS ---');
  guardEvents.forEach(g => console.log(`[${g.time}] ${g.line}`));
}

analyzeRecent().catch(console.error);
