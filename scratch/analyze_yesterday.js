const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getIncomeHistory(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  const timestamp = Date.now();
  const params = {
    incomeType: 'REALIZED_PNL',
    startTime,
    endTime,
    limit: 1000,
    timestamp,
    recvWindow: 30000
  };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function getAllIncomeHistory(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  const timestamp = Date.now();
  const params = {
    startTime,
    endTime,
    limit: 1000,
    timestamp,
    recvWindow: 30000
  };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function main() {
  // Yesterday 2026-08-13 00:00:00 GMT+7 -> 2026-08-13 23:59:59 GMT+7
  // Current time is 2026-08-14 08:45 GMT+7
  const now = new Date();
  const startYesterday = new Date('2026-08-13T00:00:00+07:00').getTime();
  const endYesterday = new Date('2026-08-13T23:59:59+07:00').getTime();
  const endNow = Date.now();

  console.log('=== REALIZED PNL FROM BINANCE (2026-08-13 to NOW) ===');
  try {
    const incomes = await getAllIncomeHistory(startYesterday, endNow);
    console.log(`Total income records: ${incomes.length}`);
    
    let totalRealizedPnl = 0;
    let totalCommission = 0;
    let totalFunding = 0;
    const tradesBySymbol = {};

    incomes.sort((a, b) => a.time - b.time);

    for (const inc of incomes) {
      const amt = parseFloat(inc.income);
      const timeStr = new Date(inc.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      if (inc.incomeType === 'REALIZED_PNL') {
        totalRealizedPnl += amt;
        if (!tradesBySymbol[inc.symbol]) tradesBySymbol[inc.symbol] = { pnl: 0, count: 0, win: 0, loss: 0, records: [] };
        tradesBySymbol[inc.symbol].pnl += amt;
        tradesBySymbol[inc.symbol].count++;
        if (amt > 0) tradesBySymbol[inc.symbol].win++;
        else if (amt < 0) tradesBySymbol[inc.symbol].loss++;
        tradesBySymbol[inc.symbol].records.push({ time: timeStr, pnl: amt, tradeId: inc.tradeId });
      } else if (inc.incomeType === 'COMMISSION') {
        totalCommission += amt;
      } else if (inc.incomeType === 'FUNDING_FEE') {
        totalFunding += amt;
      }
    }

    console.log(`\n--- SUMMARY ---`);
    console.log(`Realized PnL: ${totalRealizedPnl.toFixed(4)} USDT`);
    console.log(`Commission: ${totalCommission.toFixed(4)} USDT`);
    console.log(`Funding Fee: ${totalFunding.toFixed(4)} USDT`);
    console.log(`Net Total: ${(totalRealizedPnl + totalCommission + totalFunding).toFixed(4)} USDT`);

    console.log(`\n--- DETAILS BY SYMBOL ---`);
    const sortedSyms = Object.entries(tradesBySymbol).sort((a, b) => a[1].pnl - b[1].pnl);
    for (const [sym, data] of sortedSyms) {
      console.log(`\n[${sym}] PnL: ${data.pnl.toFixed(4)} USDT (${data.win}W / ${data.loss}L / ${data.count} trades)`);
      for (const r of data.records) {
        console.log(`   ${r.time} | PnL: ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(4)} USDT`);
      }
    }

  } catch (err) {
    console.error('Error fetching Binance income:', err.response?.data || err.message);
  }

  console.log('\n=== DATASET LOGGED TRADES (data/ai_trade_dataset.jsonl) ===');
  try {
    const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
    if (fs.existsSync(datasetPath)) {
      const lines = fs.readFileSync(datasetPath, 'utf8').trim().split('\n').filter(Boolean);
      const trades = lines.map(l => JSON.parse(l));
      const yesterdayTrades = trades.filter(t => {
        const time = t.entryTimestamp || t.exitTimestamp || 0;
        return time >= startYesterday;
      });
      console.log(`Total logged trades in dataset since yesterday: ${yesterdayTrades.length}`);
      for (const t of yesterdayTrades) {
        const timeStr = new Date(t.entryTimestamp || t.exitTimestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`- ${timeStr} | ${t.symbol} ${t.signal || t.side || ''} | Exit: ${t.exitType} | PnL%: ${t.pnlPercent}% | PnL$: ${t.pnlUsd}$ | Score: ${t.score} | Reason: ${t.scoreReasons ? t.scoreReasons.slice(0, 2).join('; ') : ''}`);
      }
    }
  } catch (err) {
    console.error('Error reading dataset:', err.message);
  }
}

main();
