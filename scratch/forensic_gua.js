const axios = require('axios');
const { getStep, getBaseUnit } = require('../src/pp369/core');

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

function calculateEMA(candles, period) {
  if (!candles || candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function main() {
  const entryTime = new Date('2026-08-14T08:21:17+07:00').getTime();
  
  console.log('=== GUAUSDT FORENSIC AT 08:21:17 14/08 ===');
  const h1 = await fetchKlines('GUAUSDT', '1h', entryTime - 50 * 3600_000, 50);
  const m15 = await fetchKlines('GUAUSDT', '15m', entryTime - 10 * 3600_000, 40);

  // Candles prior to 08:21
  const h1Prior = h1.filter(c => (c.openTime + 3600_000) <= entryTime);
  const m15Prior = m15.filter(c => (c.openTime + 15 * 60_000) <= entryTime);

  const price = 0.04366;
  const step = getStep(price);
  const unit = step / 3;

  console.log(`Entry: $${price} | Step: $${step} (${((step/price)*100).toFixed(2)}%) | Unit: $${unit}`);

  // H1 Indicators
  const ema20H1 = calculateEMA(h1Prior, 20);
  const ema50H1 = calculateEMA(h1Prior, 50);
  const rsiH1 = calculateRSI(h1Prior, 14);

  console.log(`\n--- H1 Prior Context (Total ${h1Prior.length} candles) ---`);
  console.log(`EMA20 H1: $${ema20H1?.toFixed(6)} | EMA50 H1: $${ema50H1?.toFixed(6)} | Price vs EMA: Price < EMA20 < EMA50 (${price < ema20H1 && ema20H1 < ema50H1 ? 'BEAR DOWNTREND DỐC ĐỨNG' : 'Khác'})`);
  console.log(`RSI 14 H1: ${rsiH1?.toFixed(2)}`);

  console.log('\n--- 10 H1 Candles before Entry ---');
  for (const c of h1Prior.slice(-10)) {
    const change = ((c.close - c.open) / c.open) * 100;
    console.log(`${c.timeStr} | O: ${c.open.toFixed(5)} | H: ${c.high.toFixed(5)} | L: ${c.low.toFixed(5)} | C: ${c.close.toFixed(5)} | ${change >= 0 ? '+' : ''}${change.toFixed(2)}% | Vol: ${c.volume.toFixed(0)}`);
  }

  console.log('\n--- 6 M15 Candles before & at Entry ---');
  for (const c of m15.slice(-8)) {
    const change = ((c.close - c.open) / c.open) * 100;
    const isEntryCandle = entryTime >= c.openTime && entryTime < (c.openTime + 15 * 60_000);
    console.log(`${c.timeStr} | O: ${c.open.toFixed(5)} | H: ${c.high.toFixed(5)} | L: ${c.low.toFixed(5)} | C: ${c.close.toFixed(5)} | Range: ${((c.high-c.low)/price*100).toFixed(2)}% | ${change >= 0 ? '+' : ''}${change.toFixed(2)}% | Vol: ${c.volume.toFixed(0)} ${isEntryCandle ? '>>> [ENTRY KHỚP TẠI ĐÂY]' : ''}`);
  }
}

main();
