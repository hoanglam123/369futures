const axios = require('axios');
const fs = require('fs');
const path = require('path');
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
  console.log(`=== CHECK SAFEUSDT M15 VOLUME & POSITION ===`);
  
  // Check active trades metadata
  const metaPath = path.join(__dirname, '../data/active_trades_metadata.json');
  let meta = null;
  if (fs.existsSync(metaPath)) {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta = raw['SAFE'] || raw['SAFEUSDT'];
    console.log('Active Metadata for SAFE:', meta);
  }

  const m15 = await fetchKlines(sym, '15m', 25);
  const markRes = await axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
  const markPrice = parseFloat(markRes.data.markPrice);
  const entryPrice = meta ? meta.entryPrice : markPrice;
  const isLong = meta ? (meta.side === 'BUY' || meta.side === 'LONG') : true;

  const step = meta?.step || getStep(entryPrice);
  const unit = step / 3;
  const deepPlungeDistance = unit * 0.40;

  console.log(`MarkPrice: ${markPrice} | Entry: ${entryPrice} | Side: ${isLong ? 'LONG' : 'SHORT'}`);
  console.log(`Step: ${step} | Unit: ${unit} | Deep Plunge Distance (40 ticks): ${deepPlungeDistance.toFixed(6)}`);

  console.log('\n--- 10 M15 Candles gần nhất ---');
  for (let i = 0; i < m15.length; i++) {
    const c = m15[i];
    if (i < m15.length - 10) continue;
    const base20 = m15.slice(Math.max(0, i - 20), i);
    const avgBaseVol = base20.length > 0 ? (base20.reduce((s, x) => s + x.volume, 0) / base20.length) : 0;
    const volRatio = avgBaseVol > 0 ? (c.volume / avgBaseVol) : 0;
    const range = ((c.high - c.low) / c.open) * 100;
    const change = ((c.close - c.open) / c.open) * 100;
    
    // Check deep plunge relative to entry
    const isPlunged = isLong ? (c.low <= entryPrice - deepPlungeDistance) : (c.high >= entryPrice + deepPlungeDistance);

    console.log(
      `${c.timeStr} | O: ${c.open.toFixed(4)} H: ${c.high.toFixed(4)} L: ${c.low.toFixed(4)} C: ${c.close.toFixed(4)} | ` +
      `Range: ${range.toFixed(2)}% | Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)}% | ` +
      `Vol: ${c.volume.toFixed(0)} (Ratio: ${volRatio.toFixed(2)}x) | Plunge >= 40 ticks: ${isPlunged ? 'YES' : 'NO'}`
    );
  }

  // Check current conditions in code
  const currentM15 = m15[m15.length - 1];
  const lastClosedM15 = m15[m15.length - 2];
  const base20 = m15.slice(-22, -2);
  const avgBaseVolM15 = base20.reduce((s, c) => s + c.volume, 0) / 20;

  const nowMs = Date.now();
  const elapsedMin = Math.max(1, Math.min(15, (nowMs - currentM15.openTime) / 60000));
  const projectedCurrentVol = (currentM15.volume / elapsedMin) * 15;
  const currentRatio = avgBaseVolM15 > 0 ? (projectedCurrentVol / avgBaseVolM15) : 0;
  const closedRatio = avgBaseVolM15 > 0 ? (lastClosedM15.volume / avgBaseVolM15) : 0;
  const maxM15Ratio = Math.max(currentRatio, closedRatio);

  const isDeepPlunge = isLong
    ? (Math.min(currentM15.low, lastClosedM15.low) <= entryPrice - deepPlungeDistance)
    : (Math.max(currentM15.high, lastClosedM15.high) >= entryPrice + deepPlungeDistance);

  console.log('\n--- Panic Escape Evaluation ---');
  console.log(`Base 20 Avg Vol: ${avgBaseVolM15.toFixed(0)}`);
  console.log(`Last Closed M15 (${lastClosedM15.timeStr}): Vol ${lastClosedM15.volume.toFixed(0)} (${closedRatio.toFixed(2)}x)`);
  console.log(`Current M15 (${currentM15.timeStr}, ${elapsedMin.toFixed(1)}m): Vol ${currentM15.volume.toFixed(0)}, Projected ${projectedCurrentVol.toFixed(0)} (${currentRatio.toFixed(2)}x)`);
  console.log(`Max Vol Ratio: ${maxM15Ratio.toFixed(2)}x (Yêu cầu >= 2.5x: ${maxM15Ratio >= 2.5 ? 'ĐẠT' : 'CHƯA ĐẠT'})`);
  console.log(`Deep Plunge Check (lún >= 40 ticks qua Entry ${entryPrice}): ${isDeepPlunge ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  console.log(`=> Panic Escape Triggered: ${maxM15Ratio >= 2.5 && isDeepPlunge ? '🚨 YES' : '❌ NO'}`);
}

main();
