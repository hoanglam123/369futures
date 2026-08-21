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

async function getAllOrders(symbol, startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const params = { symbol, startTime, endTime, limit: 1000, timestamp: serverTime, recvWindow: 60000 };
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await axios.get(`${BASE}/fapi/v1/allOrders?${qs}&signature=${sign(qs)}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    return res.data;
  } catch (e) {
    return [];
  }
}

async function getUserTrades(symbol, startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const params = { symbol, startTime, endTime, limit: 1000, timestamp: serverTime, recvWindow: 60000 };
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await axios.get(`${BASE}/fapi/v1/userTrades?${qs}&signature=${sign(qs)}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    return res.data;
  } catch (e) {
    return [];
  }
}

async function getIncome(startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const params = { incomeType: 'REALIZED_PNL', startTime, endTime, limit: 1000, timestamp: serverTime, recvWindow: 60000 };
  const qs = new URLSearchParams(params).toString();
  const res = await axios.get(`${BASE}/fapi/v1/income?${qs}&signature=${sign(qs)}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function parseLogsForSymbol(symbol, startTimeStr, endTimeStr) {
  const logFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
  const rl = readline.createInterface({
    input: fs.createReadStream(logFile),
    crlfDelay: Infinity
  });

  const matched = [];
  for await (const line of rl) {
    if (line.includes(symbol)) {
      matched.push(line);
    }
  }
  return matched;
}

async function main() {
  const startTime = new Date('2026-08-20T12:00:00+07:00').getTime();
  const endTime = Date.now();

  const incomeList = await getIncome(startTime, endTime);
  const bySymbol = {};
  for (const item of incomeList) {
    if (!bySymbol[item.symbol]) bySymbol[item.symbol] = [];
    bySymbol[item.symbol].push(item);
  }

  const logFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
  const allLogs = fs.readFileSync(logFile, 'utf8').split('\n');

  console.log(`BÁO CÁO CHI TIẾT CÁC VỊ THẾ ĐÃ ĐÓNG TỪ 12:00 20/08/2026 ĐẾN NAY\n`);

  for (const [symbol, incomes] of Object.entries(bySymbol)) {
    const rawSymbol = symbol.replace('USDT', '');
    const totalPnl = incomes.reduce((sum, i) => sum + parseFloat(i.income), 0);
    const trades = await getUserTrades(symbol, startTime - 3600000, endTime);
    const orders = await getAllOrders(symbol, startTime - 3600000, endTime);

    // Find relevant log lines for this window
    const symLogs = allLogs.filter(l => {
      if (!l.includes(rawSymbol)) return false;
      const match = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (!match) return false;
      const t = new Date(match[1].replace(' ', 'T') + '+07:00').getTime();
      return t >= startTime - 3600000;
    });

    console.log(`\n================================================================`);
    console.log(`TOKEN: ${symbol} | TỔNG PNL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT`);
    console.log(`================================================================`);
    
    // Trades overview
    console.log(`- Fills trên Binance (${trades.length} fills):`);
    trades.forEach(t => {
      const timeStr = new Date(t.time).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
      console.log(`  * [${timeStr}] ${t.side} ${t.qty} @ ${t.price} (PnL: ${t.realizedPnl} USDT, Fee: ${t.commission} ${t.commissionAsset})`);
    });

    console.log(`\n- Orders trên Binance (${orders.length} orders):`);
    orders.forEach(o => {
      const timeStr = new Date(o.updateTime || o.time).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
      console.log(`  * [${timeStr}] ID:${o.orderId} Type:${o.type} Side:${o.side} Status:${o.status} OrigQty:${o.origQty} ExecQty:${o.executedQty} StopPrice:${o.stopPrice} Price:${o.price}`);
    });

    console.log(`\n- Logs chi tiết từ bot VPS:`);
    symLogs.forEach(l => {
      if (l.includes('[PP369]') || l.includes('AI Reviewer') || l.includes('AutoTrade') || l.includes('H1Retest')) {
        console.log(`  ${l}`);
      }
    });
  }
}

main().catch(err => console.error(err));
