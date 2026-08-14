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

async function testSymbol(sym, checkTime) {
  const startTime = checkTime - 60 * 3600_000;
  const h1Data = await fetchKlines(sym, '1h', startTime, 60);
  // Filter candles before checkTime
  const candlesBefore = h1Data.filter(c => c.openTime <= checkTime);
  const price = candlesBefore[candlesBefore.length - 1].close;

  const sampleCount = Math.min(48, candlesBefore.length);
  const h1Sample = candlesBefore.slice(-sampleCount);
  const sampleHigh = Math.max(...h1Sample.map(c => c.high));
  const sampleLow = Math.min(...h1Sample.map(c => c.low));
  const sampleRangePct = ((sampleHigh - sampleLow) / price) * 100;

  console.log(`[${sym}] tại ${new Date(checkTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
  console.log(`Price: $${price} | Range ${sampleCount} H1: $${sampleLow} - $${sampleHigh} (${sampleRangePct.toFixed(3)}%)`);
  console.log(`=> isStagnant: ${sampleRangePct <= 1.5 ? 'YES (Bị chặn LIMIT, chuyển Watchlist Retest)' : 'NO (An toàn)'}\n`);
}

async function main() {
  // Test TA on 13/8 lúc 21:00 (trước cú sập)
  const timeTA = new Date('2026-08-13T21:00:00+07:00').getTime();
  await testSymbol('TAUSDT', timeTA);

  // Test BOME on 13/8 lúc 15:00
  const timeBOME = new Date('2026-08-13T15:00:00+07:00').getTime();
  await testSymbol('BOMEUSDT', timeBOME);

  // Test ONDO (lệnh Win) on 13/8 lúc 04:00
  const timeONDO = new Date('2026-08-13T04:00:00+07:00').getTime();
  await testSymbol('ONDOUSDT', timeONDO);
}

main();
