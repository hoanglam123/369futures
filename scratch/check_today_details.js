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

async function main() {
  const symbols = ['BICOUSDT', 'BANANAS31USDT', 'PIEVERSEUSDT', 'GUAUSDT'];
  const start = new Date('2026-08-14T00:00:00+07:00').getTime();
  const end = Date.now();

  for (const sym of symbols) {
    const trades = await getUserTrades(sym, start, end);
    console.log(`\n=================== [${sym}] Trades Today ===================`);
    for (const t of trades) {
      const timeStr = new Date(t.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      console.log(`${timeStr} | ${t.side.padEnd(4)} | Qty: ${t.qty} @ $${t.price} (Notional: $${(parseFloat(t.qty)*parseFloat(t.price)).toFixed(2)}) | PnL: ${parseFloat(t.realizedPnl).toFixed(4)}`);
    }
  }
}

main();
