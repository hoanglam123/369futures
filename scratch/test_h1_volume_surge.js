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

function checkH1VolumeSurge(h1Candles) {
  if (!h1Candles || h1Candles.length < 27) return { isSurge: false, reason: 'Không đủ 27 nến H1' };
  
  // 3 nến H1 gần nhất (đã đóng)
  const last3 = h1Candles.slice(-3);
  // 24 nến trước 3 nến đó
  const base24 = h1Candles.slice(-27, -3);

  const avgBaseVol = base24.reduce((sum, c) => sum + c.volume, 0) / base24.length;
  const recentMaxVol = Math.max(...last3.map(c => c.volume));
  const recentAvgVol = last3.reduce((sum, c) => sum + c.volume, 0) / 3;

  const maxRatio = avgBaseVol > 0 ? (recentMaxVol / avgBaseVol) : 0;
  const avgRatio = avgBaseVol > 0 ? (recentAvgVol / avgBaseVol) : 0;

  // Ngưỡng: Cây cao nhất gấp >= 2.5x hoặc trung bình 3 cây gấp >= 2.0x
  const isSurge = maxRatio >= 2.5 || avgRatio >= 2.0;

  return {
    isSurge,
    maxRatio,
    avgRatio,
    recentMaxVol,
    recentAvgVol,
    avgBaseVol
  };
}

async function testSymbolAtTime(sym, checkTime) {
  const startTime = checkTime - 40 * 3600_000;
  const klines = await fetchKlines(sym, '1h', startTime, 40);
  const closedCandles = klines.filter(c => (c.openTime + 3600_000) <= checkTime);

  const res = checkH1VolumeSurge(closedCandles);
  console.log(`\n=== [${sym}] at ${new Date(checkTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} ===`);
  console.log(`Base 24 H1 Avg Vol: ${res.avgBaseVol.toFixed(0)} | Last 3 H1 Max: ${res.recentMaxVol.toFixed(0)} (${res.maxRatio.toFixed(2)}x) | Last 3 Avg: ${res.recentAvgVol.toFixed(0)} (${res.avgRatio.toFixed(2)}x)`);
  console.log(`=> isSurge: ${res.isSurge ? '🚨 YES (CHUYỂN WATCHLIST RETEST)' : '✅ NO (Bình thường)'}`);
}

async function main() {
  // 1. PIEVERSE lúc 09:30 ngày 14/8 (trước khi dính SL Short)
  await testSymbolAtTime('PIEVERSEUSDT', new Date('2026-08-14T09:35:00+07:00').getTime());

  // 2. GUA lúc 08:20 ngày 14/8 (trước khi dính SL Long)
  await testSymbolAtTime('GUAUSDT', new Date('2026-08-14T08:20:00+07:00').getTime());

  // 3. TA lúc 21:00 ngày 13/8
  await testSymbolAtTime('TAUSDT', new Date('2026-08-13T21:00:00+07:00').getTime());

  // 4. ONDO lúc 04:20 ngày 13/8 (lệnh Win)
  await testSymbolAtTime('ONDOUSDT', new Date('2026-08-13T04:20:00+07:00').getTime());
}

main();
