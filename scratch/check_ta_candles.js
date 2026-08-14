const axios = require('axios');

async function fetchKlines(symbol, interval, startTime, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
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
  const start11Aug = new Date('2026-08-11T00:00:00+07:00').getTime();
  
  console.log('=== TAUSDT H1 CANDLES (11/08 - 14/08) ===');
  const h1 = await fetchKlines('TAUSDT', '1h', start11Aug, 100);
  
  // Find daily lows and key levels
  for (const c of h1) {
    if (c.low <= 0.0635) {
      console.log(`[H1] ${c.timeStr} | O: ${c.open.toFixed(6)} | H: ${c.high.toFixed(6)} | L: ${c.low.toFixed(6)} | C: ${c.close.toFixed(6)} | Vol: ${c.volume.toFixed(0)}`);
    }
  }

  console.log('\n=== TAUSDT M15 CANDLES around 21:00 - 23:00 on 13/08 ===');
  const start13AugEvening = new Date('2026-08-13T20:00:00+07:00').getTime();
  const m15 = await fetchKlines('TAUSDT', '15m', start13AugEvening, 20);
  for (const c of m15) {
    console.log(`[M15] ${c.timeStr} | O: ${c.open.toFixed(6)} | H: ${c.high.toFixed(6)} | L: ${c.low.toFixed(6)} | C: ${c.close.toFixed(6)} | Vol: ${c.volume.toFixed(0)}`);
  }
}

main();
