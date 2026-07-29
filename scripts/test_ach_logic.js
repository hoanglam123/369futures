'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STEP_SIZES_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');
const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
const h4Cache = stepSizesData.h4Cache || {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchM1Candles(symbol, days = 7) {
  const endTime = Date.now();
  const chunkSizeMs = 1500 * 60000;
  const numChunks = Math.ceil((days * 24 * 3600000) / chunkSizeMs);
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  const allCandles = [];

  for (let i = numChunks - 1; i >= 0; i--) {
    const chunkStart = endTime - (i + 1) * chunkSizeMs;
    const chunkEnd = endTime - i * chunkSizeMs;
    try {
      const res = await axios.get(url, {
        params: {
          symbol: `${symbol}USDT`,
          interval: '1m',
          startTime: chunkStart,
          endTime: chunkEnd,
          limit: 1500
        },
        timeout: 10000
      });
      const data = res.data || [];
      for (const c of data) {
        allCandles.push({
          openTime: c[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        });
      }
      await sleep(50);
    } catch (err) {
      console.error(`Error fetching M1: ${err.message}`);
    }
  }
  return allCandles.sort((a, b) => a.openTime - b.openTime);
}

function checkStaleBounceOld(signal, condLevel, targetLevel, recentM1, preEntryBouncePct) {
  const touchThresholdPct = 0.12;
  if (signal === 'LONG') {
    const touchZoneUpper = targetLevel * (1 + touchThresholdPct / 100);
    let maxBouncePct = 0;
    let bestTouchLow = 0;
    let bestPeakHigh = 0;

    for (let i = 0; i < recentM1.length; i++) {
      const candle = recentM1[i];
      if (candle.low <= touchZoneUpper) {
        const touchLow = candle.low;
        let peakHigh = recentM1[recentM1.length - 1].close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].high > peakHigh) {
            peakHigh = recentM1[j].high;
          }
        }
        const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
        if (bouncePct > maxBouncePct) {
          maxBouncePct = bouncePct;
          bestTouchLow = touchLow;
          bestPeakHigh = peakHigh;
        }
      }
    }
    return { blocked: maxBouncePct >= preEntryBouncePct, maxBouncePct, bestTouchLow, bestPeakHigh };
  } else {
    const touchZoneLower = targetLevel * (1 - touchThresholdPct / 100);
    let maxDropPct = 0;
    let bestTouchHigh = 0;
    let bestTroughLow = 0;

    for (let i = 0; i < recentM1.length; i++) {
      const candle = recentM1[i];
      if (candle.high >= touchZoneLower) {
        const touchHigh = candle.high;
        let troughLow = recentM1[recentM1.length - 1].close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].low < troughLow) {
            troughLow = recentM1[j].low;
          }
        }
        const dropPct = ((touchHigh - troughLow) / touchHigh) * 100;
        if (dropPct > maxDropPct) {
          maxDropPct = dropPct;
          bestTouchHigh = touchHigh;
          bestTroughLow = troughLow;
        }
      }
    }
    return { blocked: maxDropPct >= preEntryBouncePct, maxDropPct, bestTouchHigh, bestTroughLow };
  }
}

function checkStaleBounceNew(signal, condLevel, targetLevel, recentM1, preEntryBouncePct) {
  const touchThresholdPct = 0.12;
  if (signal === 'LONG') {
    let startIdx = 0;
    for (let i = recentM1.length - 1; i >= 0; i--) {
      if (recentM1[i].high >= condLevel) {
        startIdx = i;
        break;
      }
    }

    const touchZoneUpper = targetLevel * (1 + touchThresholdPct / 100);
    let maxBouncePct = 0;
    let bestTouchLow = 0;
    let bestPeakHigh = 0;

    for (let i = startIdx; i < recentM1.length; i++) {
      const candle = recentM1[i];
      if (candle.low <= touchZoneUpper) {
        const touchLow = candle.low;
        let peakHigh = recentM1[recentM1.length - 1].close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].high > peakHigh) {
            peakHigh = recentM1[j].high;
          }
        }
        const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
        if (bouncePct > maxBouncePct) {
          maxBouncePct = bouncePct;
          bestTouchLow = touchLow;
          bestPeakHigh = peakHigh;
        }
      }
    }
    return { blocked: maxBouncePct >= preEntryBouncePct, maxBouncePct, bestTouchLow, bestPeakHigh, startIdx };
  } else {
    let startIdx = 0;
    for (let i = recentM1.length - 1; i >= 0; i--) {
      if (recentM1[i].low <= condLevel) {
        startIdx = i;
        break;
      }
    }

    const touchZoneLower = targetLevel * (1 - touchThresholdPct / 100);
    let maxDropPct = 0;
    let bestTouchHigh = 0;
    let bestTroughLow = 0;

    for (let i = startIdx; i < recentM1.length; i++) {
      const candle = recentM1[i];
      if (candle.high >= touchZoneLower) {
        const touchHigh = candle.high;
        let troughLow = recentM1[recentM1.length - 1].close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].low < troughLow) {
            troughLow = recentM1[j].low;
          }
        }
        const dropPct = ((touchHigh - troughLow) / touchHigh) * 100;
        if (dropPct > maxDropPct) {
          maxDropPct = dropPct;
          bestTouchHigh = touchHigh;
          bestTroughLow = troughLow;
        }
      }
    }
    return { blocked: maxDropPct >= preEntryBouncePct, maxDropPct, bestTouchHigh, bestTroughLow, startIdx };
  }
}

async function run() {
  console.log('=== KẾT QUẢ BACKTEST ACH: MÔ PHỎNG LOGIC CŨ VS LOGIC MỚI ===\n');
  const m1 = await fetchM1Candles('ACH', 7);
  console.log(`Đã nạp ${m1.length} nến M1 (7 ngày) của ACH\n`);

  const gridWidth = 0.0003;
  const targetLevel = 0.004321;
  const condLevel = 0.004764;
  const pct = (gridWidth / targetLevel) * 100;
  const preEntryBouncePct = pct / 5.5;

  let totalWindows = 0;
  let oldBlockedCount = 0;
  let newBlockedCount = 0;

  for (let idx = 150; idx < m1.length; idx += 10) {
    const window = m1.slice(idx - 150, idx);
    const oldRes = checkStaleBounceOld('LONG', condLevel, targetLevel, window, preEntryBouncePct);
    const newRes = checkStaleBounceNew('LONG', condLevel, targetLevel, window, preEntryBouncePct);

    totalWindows++;
    if (oldRes.blocked) oldBlockedCount++;
    if (newRes.blocked) newBlockedCount++;
  }

  console.log(`📊 Kết quả mô phỏng trên ${totalWindows} khung thời gian (7 ngày):`);
  console.log(` ❌ LOGIC CŨ (Chặn nhầm do quét nến trước mốc trên):  Block ${oldBlockedCount} lần`);
  console.log(` ✅ LOGIC MỚI (Chỉ quét từ khi chạm mốc trên):          Block ${newBlockedCount} lần`);
  console.log(` 🚀 Hiệu quả: Logic mới đã loại bỏ ${oldBlockedCount - newBlockedCount} trường hợp BLOCK NHẦM, giúp lệnh chuẩn được phát đi an toàn!\n`);
}

run();
