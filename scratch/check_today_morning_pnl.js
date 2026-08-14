const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getIncome(startTime, endTime) {
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

async function getCommission(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  const timestamp = Date.now();
  const params = {
    incomeType: 'COMMISSION',
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
  const start7AM = new Date('2026-08-14T07:00:00+07:00').getTime();
  const endNow = Date.now();

  console.log(`Querying Binance from ${new Date(start7AM).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} to ${new Date(endNow).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}...\n`);

  const pnlList = await getIncome(start7AM, endNow);
  const commList = await getCommission(start7AM, endNow);

  let totalPnl = 0;
  let totalFee = 0;
  let winCount = 0;
  let lossCount = 0;

  // Group by symbol
  const symMap = {};

  for (const item of pnlList) {
    const pnl = parseFloat(item.income);
    totalPnl += pnl;
    if (pnl > 0) winCount++;
    else if (pnl < 0) lossCount++;

    const sym = item.symbol;
    if (!symMap[sym]) {
      symMap[sym] = { pnl: 0, items: [] };
    }
    symMap[sym].pnl += pnl;
    symMap[sym].items.push({
      time: item.time,
      timeStr: new Date(item.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      pnl: pnl,
      tradeId: item.tradeId
    });
  }

  for (const c of commList) {
    totalFee += Math.abs(parseFloat(c.income));
  }

  console.log(`=== SUMMARY (07:00 -> NOW) ===`);
  console.log(`Total Closed Fills: ${pnlList.length} (${winCount} Win, ${lossCount} Loss)`);
  console.log(`Realized PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT`);
  console.log(`Commission Fee: -${totalFee.toFixed(4)} USDT`);
  console.log(`NET PNL: ${(totalPnl - totalFee) >= 0 ? '+' : ''}${(totalPnl - totalFee).toFixed(4)} USDT\n`);

  console.log(`=== DETAILS BY SYMBOL ===`);
  for (const [sym, data] of Object.entries(symMap)) {
    console.log(`\n🔹 [${sym}] Net PnL: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)} USDT (${data.items.length} fills)`);
    for (const it of data.items) {
      console.log(`   • ${it.timeStr} | PnL: ${it.pnl >= 0 ? '+' : ''}${it.pnl.toFixed(4)} USDT (tradeId: ${it.tradeId})`);
    }

    // Fetch userTrades for this symbol to see entry/exit prices
    try {
      const trades = await getUserTrades(sym, start7AM - 24 * 3600_000, endNow);
      const recentTrades = trades.filter(t => t.time >= start7AM - 4 * 3600_000);
      console.log(`   Trades context:`);
      for (const t of recentTrades.slice(-6)) {
        const timeStr = new Date(t.time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`      ${timeStr} | ${t.side} ${t.qty} @ $${t.price} | PnL: ${t.realizedPnl}`);
      }
    } catch (e) {
      console.log(`   (Could not fetch trades: ${e.message})`);
    }
  }

  if (pnlList.length === 0) {
    console.log('Không có lệnh nào đóng vị thế trong khoảng thời gian từ 07:00 đến nay.');
  }
}

main();
