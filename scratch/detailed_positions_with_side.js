const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getUserTrades(symbol, startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/userTrades';
  const timestamp = Date.now();
  const params = {
    symbol,
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
  let allIncome = [];
  let currentStart = startTime;

  while (true) {
    const timestamp = Date.now();
    const params = {
      startTime: currentStart,
      endTime: endTime,
      limit: 1000,
      timestamp,
      recvWindow: 30000
    };
    const qs = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = res.data;
    if (!data || data.length === 0) break;
    allIncome = allIncome.concat(data);
    if (data.length < 1000) break;
    currentStart = data[data.length - 1].time + 1;
    if (currentStart >= endTime) break;
  }
  return allIncome;
}

async function main() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const startTime = new Date(`${currentYear}-08-14T00:00:00+07:00`).getTime();
  const endTime = Date.now();

  const incomes = await getAllIncomeHistory(startTime, endTime);
  incomes.sort((a, b) => a.time - b.time);

  // Collect unique symbols
  const symbols = [...new Set(incomes.filter(i => i.incomeType === 'REALIZED_PNL').map(i => i.symbol))];
  
  // Cache user trades per symbol
  const tradeMap = {};
  for (const sym of symbols) {
    try {
      const trades = await getUserTrades(sym, startTime - 24*3600*1000, endTime);
      tradeMap[sym] = trades;
    } catch (e) {}
  }

  const pnlList = incomes.filter(i => i.incomeType === 'REALIZED_PNL');
  
  // Cluster positions
  const positions = [];
  let currentPos = null;

  for (const item of pnlList) {
    const amt = parseFloat(item.income);
    if (!currentPos || currentPos.symbol !== item.symbol || (item.time - currentPos.lastTime > 60000)) {
      if (currentPos) positions.push(currentPos);
      currentPos = {
        symbol: item.symbol,
        startTime: item.time,
        lastTime: item.time,
        totalPnl: amt,
        tradeIds: [item.tradeId],
        fills: 1
      };
    } else {
      currentPos.lastTime = item.time;
      currentPos.totalPnl += amt;
      currentPos.tradeIds.push(item.tradeId);
      currentPos.fills++;
    }
  }
  if (currentPos) positions.push(currentPos);

  // Resolve position side (if closing fill is BUY -> position was SHORT; if closing fill is SELL -> position was LONG)
  for (const pos of positions) {
    const symTrades = tradeMap[pos.symbol] || [];
    const closeFill = symTrades.find(t => String(t.id) === String(pos.tradeIds[0]));
    if (closeFill) {
      // If close fill side is BUY, it closed a SHORT. If SELL, it closed a LONG.
      pos.side = closeFill.side === 'BUY' ? 'SHORT' : 'LONG';
      pos.closePrice = closeFill.price;
      pos.qty = symTrades.filter(t => pos.tradeIds.includes(String(t.id))).reduce((sum, t) => sum + parseFloat(t.qty), 0);
    } else {
      pos.side = 'N/A';
    }
  }

  // Group by day
  const days = ['14/08/2026', '15/08/2026', '16/08/2026', '17/08/2026'];
  const daySummary = {};
  days.forEach(d => {
    daySummary[d] = [];
  });

  for (const pos of positions) {
    const d = new Date(pos.startTime);
    const dayStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    if (daySummary[dayStr]) {
      daySummary[dayStr].push(pos);
    }
  }

  console.log(JSON.stringify(daySummary, null, 2));
}

main();
