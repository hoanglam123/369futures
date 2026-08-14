const axios = require('axios');

async function fetchKlines(symbol, interval, limit = 30) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url);
  return res.data.map(k => ({
    openTime: k[0],
    timeStr: new Date(k[0]).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

async function main() {
  const sym = 'BANANAS31USDT';
  const m15 = await fetchKlines(sym, '15m', 30);
  
  // At 11:15, last closed M15 was 11:00
  const idx1100 = m15.findIndex(c => c.timeStr.includes('11:00:00'));
  if (idx1100 === -1) {
    console.log('Not found');
    return;
  }
  const lastClosedM15 = m15[idx1100];
  const base20 = m15.slice(idx1100 - 20, idx1100);
  const avgBaseVol = base20.reduce((s, c) => s + c.volume, 0) / 20;

  console.log(`=== BANANAS31 at 11:15 ===`);
  console.log(`Last Closed M15 (11:00): Vol ${lastClosedM15.volume.toFixed(0)} | Range: ${(((lastClosedM15.high - lastClosedM15.low)/lastClosedM15.open)*100).toFixed(2)}% | Change: ${(((lastClosedM15.close - lastClosedM15.open)/lastClosedM15.open)*100).toFixed(2)}%`);
  console.log(`Base 20 M15 Avg Vol: ${avgBaseVol.toFixed(0)}`);
  console.log(`Vol Ratio: ${(lastClosedM15.volume / avgBaseVol).toFixed(2)}x`);
  console.log(`=> Is M15 Vol Surge (>= 2.5x): ${lastClosedM15.volume >= 2.5 * avgBaseVol ? '🚨 YES (CHẶN LIMIT, CHỜ RETEST)' : 'NO'}`);
}

main();
