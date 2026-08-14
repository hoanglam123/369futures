const axios = require('axios');
const { getStep, score369Method } = require('../src/pp369/core');

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
  console.log(`=== CHECK M15 BANANAS31 AT 11:00 - 11:15 ===`);
  const m15 = await fetchKlines(sym, '15m', 25);
  const h1 = await fetchKlines(sym, '1h', 30);

  const price = 0.008649;
  const step = getStep(price);
  const unit = step / 3;

  console.log(`Target Price: ${price} | Step: ${step} (${((step/price)*100).toFixed(2)}%) | Unit: ${unit}`);

  console.log('\n--- 10 M15 Candles gần nhất ---');
  for (const c of m15.slice(-10)) {
    const range = ((c.high - c.low) / c.open) * 100;
    const change = ((c.close - c.open) / c.open) * 100;
    console.log(`${c.timeStr} | O: ${c.open.toFixed(6)} | H: ${c.high.toFixed(6)} | L: ${c.low.toFixed(6)} | C: ${c.close.toFixed(6)} | Range: ${range.toFixed(2)}% | Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)}% | Vol: ${c.volume.toFixed(0)}`);
  }

  // Let's run score369Method for BANANAS31
  const sig = {
    symbol: 'BANANAS31',
    signal: 'SHORT',
    targetLevel: 0.008649,
    step: step
  };

  const scoreRes = await score369Method(sig, 'SHORT');
  console.log('\n--- Score369Method Details ---');
  console.log(`Score: ${scoreRes.score}`);
  console.log(`volScore: ${scoreRes.volScore}`);
  console.log(`isM15Volatile: ${scoreRes.isM15Volatile}`);
  console.log(`isStagnant: ${scoreRes.isStagnant}`);
  console.log(`isH1VolSurge: ${scoreRes.isH1VolSurge}`);
  console.log(`Reasons: \n - ${scoreRes.reasons.join('\n - ')}`);
}

main();
