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

async function analyzeSymbol(sym, entryTime, direction, entryPrice) {
  console.log(`\n============================ [${sym}] ${direction} @ $${entryPrice} (Khớp: ${new Date(entryTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}) ============================`);
  
  // 15m candles around entry
  const m15 = await fetchKlines(sym, '15m', entryTime - 4 * 3600_000, 16);
  console.log(`--- M15 Candles before & after entry ---`);
  for (const c of m15) {
    const isEntryCandle = entryTime >= c.openTime && entryTime < (c.openTime + 15 * 60_000);
    const mark = isEntryCandle ? ' >>> [ENTRY]' : '';
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close} | Vol: ${c.volume.toFixed(0)}${mark}`);
  }

  // H1 candles around entry
  const h1 = await fetchKlines(sym, '1h', entryTime - 12 * 3600_000, 16);
  console.log(`--- H1 Candles ---`);
  for (const c of h1) {
    const isEntryCandle = entryTime >= c.openTime && entryTime < (c.openTime + 3600_000);
    const mark = isEntryCandle ? ' >>> [ENTRY]' : '';
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close} | Vol: ${c.volume.toFixed(0)}${mark}`);
  }
}

async function main() {
  // 1. PIEVERSE SHORT @ 0.7876 (entry 09:36:17 14/8)
  await analyzeSymbol('PIEVERSEUSDT', new Date('2026-08-14T09:36:17+07:00').getTime(), 'SHORT', 0.7876);

  // 2. GUA LONG @ 0.04366 (entry 08:21:17 14/8)
  await analyzeSymbol('GUAUSDT', new Date('2026-08-14T08:21:17+07:00').getTime(), 'LONG', 0.04366);

  // 3. BICO LONG @ 0.02718 (entry 05:51:52 14/8)
  await analyzeSymbol('BICOUSDT', new Date('2026-08-14T05:51:52+07:00').getTime(), 'LONG', 0.02718);
}

main();
