const axios = require('axios');
const { getStep } = require('../src/pp369/core');

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
  const sym = 'SAFEUSDT';
  const entryPrice = 0.08710;
  const isLong = true;

  const step = getStep(entryPrice);
  const unit = step / 3;
  const deepPlungeDistance = unit * 0.40;
  const h1InvalidationDistance = unit * 0.35;

  console.log(`=== SAFEUSDT POSITION ANALYSIS ===`);
  console.log(`Entry: $${entryPrice} (LONG) | Step: $${step} | Unit: $${unit}`);
  console.log(`- M15 Panic Plunge Threshold (>= 40 ticks): <= $${(entryPrice - deepPlungeDistance).toFixed(5)}`);
  console.log(`- H1 Close Invalidation Threshold (>= 35 ticks): <= $${(entryPrice - h1InvalidationDistance).toFixed(5)}`);
  console.log(`- M15 Panic Escape TP (-10 ticks): $${(entryPrice - unit * 0.10).toFixed(5)}`);

  const m15 = await fetchKlines(sym, '15m', 30);
  console.log('\n--- Chi tiết M15 Candles từ 12:00 ---');
  for (let i = 10; i < m15.length; i++) {
    const c = m15[i];
    const base20 = m15.slice(i - 20, i);
    const avgBaseVol = base20.reduce((s, x) => s + x.volume, 0) / 20;
    const volRatio = c.volume / avgBaseVol;
    const range = ((c.high - c.low) / c.open) * 100;
    const isPlunged40 = c.low <= (entryPrice - deepPlungeDistance);

    console.log(
      `${c.timeStr} | O: ${c.open.toFixed(4)} H: ${c.high.toFixed(4)} L: ${c.low.toFixed(4)} C: ${c.close.toFixed(4)} | ` +
      `Vol: ${c.volume.toFixed(0)} (Ratio: ${volRatio.toFixed(2)}x) | ` +
      `Low vs Plunge 40t ($${(entryPrice - deepPlungeDistance).toFixed(4)}): ${isPlunged40 ? '🚨 ĐÃ ĐÂM QUA' : 'Chưa đâm'}`
    );
  }

  const h1 = await fetchKlines(sym, '1h', 10);
  console.log('\n--- Chi tiết H1 Candles gần nhất ---');
  for (const c of h1.slice(-5)) {
    const isClosedBelow35 = c.close <= (entryPrice - h1InvalidationDistance);
    console.log(
      `${c.timeStr} | O: ${c.open.toFixed(4)} H: ${c.high.toFixed(4)} L: ${c.low.toFixed(4)} C: ${c.close.toFixed(4)} | ` +
      `Vol: ${c.volume.toFixed(0)} | Close vs H1 Inval ($${(entryPrice - h1InvalidationDistance).toFixed(4)}): ${isClosedBelow35 ? '⚠️ GÃY CẢN' : 'OK'}`
    );
  }
}

main();
