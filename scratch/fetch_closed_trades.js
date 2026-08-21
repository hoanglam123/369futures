require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;

const BASE = 'https://fapi.binance.com';

function sign(query) {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
}

async function getIncome(startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  
  const params = {
    incomeType: 'REALIZED_PNL',
    startTime,
    endTime,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 60000
  };
  
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  
  const res = await axios.get(`${BASE}/fapi/v1/income?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function getUserTrades(symbol, startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  
  const params = {
    symbol,
    startTime,
    endTime,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 60000
  };
  
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  
  const res = await axios.get(`${BASE}/fapi/v1/userTrades?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function main() {
  const startTime = new Date('2026-08-20T12:00:00+07:00').getTime();
  const endTime = Date.now();
  
  console.log(`Querying from ${new Date(startTime).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})} to ${new Date(endTime).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})}`);
  
  const incomeList = await getIncome(startTime, endTime);
  console.log(`Found ${incomeList.length} realized PnL records.`);
  
  const symbols = [...new Set(incomeList.map(i => i.symbol))];
  console.log('Symbols traded:', symbols);
  
  for (const item of incomeList) {
    const timeStr = new Date(item.time).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
    console.log(`[${timeStr}] Symbol: ${item.symbol}, Income (PnL): ${item.income} USDT, TradeID/TranID: ${item.tranId}, Info: ${item.info}`);
  }

  // Also query user trades for each symbol to get full execution details (entry, exit, price, qty, commission)
  console.log('\n--- Detailed User Trades ---');
  for (const sym of symbols) {
    try {
      const trades = await getUserTrades(sym, startTime, endTime);
      console.log(`\nSymbol: ${sym} (${trades.length} fills):`);
      for (const t of trades) {
        const timeStr = new Date(t.time).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
        console.log(`  [${timeStr}] Side: ${t.side}, Price: ${t.price}, Qty: ${t.qty}, RealizedPnL: ${t.realizedPnl}, Commission: ${t.commission} ${t.commissionAsset}, OrderId: ${t.orderId}`);
      }
    } catch (err) {
      console.error(`Error fetching trades for ${sym}:`, err.message);
    }
  }
}

main().catch(err => {
  console.error(err);
});
