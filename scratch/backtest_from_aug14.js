require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
const BASE = 'https://fapi.binance.com';

function sign(query) {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
}

// 1. Fetch all Realized PnL from 14/08 00:00 to 21/08
async function getIncomeFrom14() {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const startTime = new Date('2026-08-14T00:00:00+07:00').getTime();
  const endTime = Date.now();

  const params = { incomeType: 'REALIZED_PNL', startTime, endTime, limit: 1000, timestamp: serverTime, recvWindow: 60000 };
  const qs = new URLSearchParams(params).toString();
  const res = await axios.get(`${BASE}/fapi/v1/income?${qs}&signature=${sign(qs)}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

// 2. Parse AI Reviewer evaluations from logs for each trade
async function parseLogs() {
  const logFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
  const rl = readline.createInterface({ input: fs.createReadStream(logFile), crlfDelay: Infinity });

  const aiEvals = {};
  const tradeDetails = {};

  for await (const line of rl) {
    // AI Reviewer line
    // e.g. 2026-08-15 10:30:46: [PP369] [AI Reviewer] 🟡 Khuyên BỎ QUA AKT (LONG) - Xác suất thắng 57.4% < 65% ...
    const aiMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): \[PP369\] \[(AI Reviewer|AI Reviewer \(Shadow\)|AI Reviewer \(Shadow Retest H1\)|AI Reviewer \(Retest H1\))\] (🟢|🟡) [^\w]*([A-Z0-9]+) \((LONG|SHORT)\) - (?:Xác suất thắng|Khuyên NÊN ĐẶT LỆNH[^\d]+)?\s*([\d\.]+)%/);
    if (aiMatch) {
      const timeStr = aiMatch[1];
      const sym = aiMatch[4];
      const prob = parseFloat(aiMatch[6]);
      aiEvals[`${sym}_${timeStr.slice(0, 16)}`] = prob;
      // also keep latest by sym
      aiEvals[sym] = prob;
    }

    // Placed trade line
    const placeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): \[PP369\] \[AutoTrade\] ✓ (\w+) (BUY|SELL) ([\d\.]+) @ \$([\d\.]+)/);
    if (placeMatch) {
      const timeStr = placeMatch[1];
      const time = new Date(timeStr.replace(' ', 'T') + '+07:00').getTime();
      const sym = placeMatch[2];
      const side = placeMatch[3] === 'BUY' ? 'LONG' : 'SHORT';
      const qty = parseFloat(placeMatch[4]);
      const price = parseFloat(placeMatch[5]);

      if (time >= new Date('2026-08-14T00:00:00+07:00').getTime()) {
        tradeDetails[`${sym}_${timeStr.slice(0, 13)}`] = { timeStr, time, sym, side, qty, price };
      }
    }
  }
  return { aiEvals, tradeDetails };
}

async function main() {
  console.log('Fetching live trades from 14/08/2026 to present...\n');
  const incomes = await getIncomeFrom14();
  const { aiEvals, tradeDetails } = await parseLogs();

  const bySymbol = {};
  for (const item of incomes) {
    if (!bySymbol[item.symbol]) bySymbol[item.symbol] = [];
    bySymbol[item.symbol].push(item);
  }

  console.log(`Tìm thấy ${incomes.length} lần Realized PnL trên Binance từ 14/08 đến 21/08.`);
  console.log(`Số token đã phát sinh PnL: ${Object.keys(bySymbol).length}\n`);

  const summary = [];
  let totalLivePnl = 0;

  for (const [symbol, list] of Object.entries(bySymbol)) {
    const pnl = list.reduce((s, x) => s + parseFloat(x.income), 0);
    totalLivePnl += pnl;
    const rawSym = symbol.replace('USDT', '');
    const firstTime = new Date(list[0].time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const lastTime = new Date(list[list.length - 1].time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const prob = aiEvals[rawSym] || 50.0;

    summary.push({
      symbol,
      rawSym,
      pnl,
      records: list.length,
      firstTime,
      lastTime,
      prob
    });
  }

  summary.sort((a, b) => b.pnl - a.pnl);

  console.log('TOKEN'.padEnd(14) + 'TỔNG PNL (USDT)'.padEnd(18) + 'SỐ LỆNH'.padEnd(10) + 'AI PROB'.padEnd(10) + 'THỜI GIAN');
  console.log('-'.repeat(80));
  for (const s of summary) {
    console.log(
      s.symbol.padEnd(14) +
      ((s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(4)).padEnd(18) +
      String(s.records).padEnd(10) +
      (s.prob + '%').padEnd(10) +
      s.firstTime
    );
  }
  console.log('-'.repeat(80));
  console.log(`TỔNG PNL THỰC TẾ TRÊN SÀN TỪ 14/08 ĐẾN NAY: ${totalLivePnl >= 0 ? '+' : ''}${totalLivePnl.toFixed(4)} USDT\n`);
}

main().catch(err => console.error(err));
