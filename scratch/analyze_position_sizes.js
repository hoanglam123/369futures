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

  const symbols = ['TAUSDT', 'BOMEUSDT', 'SKYAIUSDT', 'BANANAS31USDT', 'TRUSTUSDT', 'STEEMUSDT', 'BANKUSDT', 'KAITOUSDT', 'BICOUSDT', 'ONDOUSDT', 'BTRUSDT', 'LUMIAUSDT', 'HYPEUSDT', 'PIEVERSEUSDT'];

  for (const sym of symbols) {
    try {
      const trades = await getUserTrades(sym, startYesterday, endNow);
      if (trades.length > 0) {
        // Group by position open vs close
        let buyQty = 0, buyQuote = 0, sellQty = 0, sellQuote = 0;
        let totalPnl = 0;
        for (const t of trades) {
          const qty = parseFloat(t.qty);
          const quote = parseFloat(t.quoteQty);
          const pnl = parseFloat(t.realizedPnl);
          totalPnl += pnl;
          if (t.side === 'BUY') {
            buyQty += qty;
            buyQuote += quote;
          } else {
            sellQty += qty;
            sellQuote += quote;
          }
        }
        console.log(`\n=== [${sym}] ===`);
        console.log(`Total Buy Quote: $${buyQuote.toFixed(2)} | Total Sell Quote: $${sellQuote.toFixed(2)} | Net PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`);
        for (const t of trades.slice(0, 4)) {
          const timeStr = new Date(t.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          console.log(`   ${timeStr} | ${t.side} ${t.qty} @ $${t.price} (Notional: $${(parseFloat(t.qty)*parseFloat(t.price)).toFixed(2)}) | PnL: ${parseFloat(t.realizedPnl).toFixed(2)}`);
        }
      }
    } catch (e) {
      console.log(`Error ${sym}: ${e.message}`);
    }
  }
}

main();
