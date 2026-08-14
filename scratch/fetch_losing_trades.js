const fs = require('fs');
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
  const startYesterday = new Date('2026-08-13T00:00:00+07:00').getTime();
  const endNow = Date.now();

  const symbols = ['TAUSDT', 'BOMEUSDT', 'SKYAIUSDT', 'BANANAS31USDT', 'TRUSTUSDT', 'STEEMUSDT', 'BANKUSDT', 'KAITOUSDT', 'BICOUSDT'];

  for (const sym of symbols) {
    try {
      const trades = await getUserTrades(sym, startYesterday, endNow);
      if (trades.length > 0) {
        console.log(`\n=== [${sym}] Trades Summary ===`);
        let netPnl = 0;
        let totalFee = 0;
        for (const t of trades) {
          const timeStr = new Date(t.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          const pnl = parseFloat(t.realizedPnl);
          netPnl += pnl;
          totalFee += parseFloat(t.commission);
          console.log(`   ${timeStr} | ${t.side.padEnd(4)} | Qty: ${t.qty} @ $${t.price} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDT`);
        }
        console.log(`>>> TOTAL PNL: ${netPnl.toFixed(4)} USDT | FEE: ${totalFee.toFixed(4)} USDT`);
      }
    } catch (e) {
      console.log(`Error ${sym}: ${e.response?.data?.msg || e.message}`);
    }
  }
}

main();
