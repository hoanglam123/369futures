'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { get369Signal, score369Method } = require('../src/pp369');

async function main() {
  console.log('================================================================');
  console.log(' 🔎 BACKTEST TOÀN BỘ CÁC TÍN HIỆU GMX TRONG NGÀY 29/07/2026');
  console.log('================================================================\n');

  const symbol = 'GMX';
  // Tải nến 1M từ 00:00 UTC đến 17:00 UTC (07:00 VN -> 24:00 VN)
  const startTime = new Date('2026-07-29T00:00:00Z').getTime();
  const endTime = new Date('2026-07-29T17:00:00Z').getTime();

  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1500`;
  const res = await axios.get(url);
  const m1Candles = (res.data || []).map(c => ({
    openTime: c[0],
    timeStr: new Date(c[0] + 7 * 3600000).toISOString().replace('T', ' ').substring(0, 19),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }));

  console.log(`Đã nạp ${m1Candles.length} nến M1 của GMX trong ngày 29/07/2026\n`);

  const openGoc = 7.709;
  const closeGoc = 7.723;
  const step = 0.3;

  // Quét từng nến M1 để tìm thời điểm chạm mốc hoặc phát tín hiệu
  let signalsFired = [];

  for (let idx = 150; idx < m1Candles.length; idx++) {
    const candle = m1Candles[idx];
    const prev = m1Candles[idx - 1];

    // Mốc LONG: 7.709 ± n*0.3 (Tier -3: 6.809)
    // Mốc SHORT: 7.723 ± n*0.3 (Tier -3: 6.823)
    const longLevel = 6.809;
    const shortLevel = 6.823;

    let sigType = null;
    let targetLevel = 0;
    let condLevel = 0;

    if (candle.low <= longLevel && prev.low > longLevel) {
      sigType = 'LONG';
      targetLevel = longLevel;
      condLevel = shortLevel;
    } else if (candle.high >= shortLevel && prev.high < shortLevel) {
      sigType = 'SHORT';
      targetLevel = shortLevel;
      condLevel = longLevel;
    }

    if (sigType) {
      signalsFired.push({
        idx,
        candle,
        sigType,
        targetLevel,
        condLevel
      });
    }
  }

  console.log(`📌 Tìm thấy ${signalsFired.length} thời điểm nến M1 chạm mốc GMX:\n`);

  for (const item of signalsFired) {
    const idx = item.idx;
    const candle = item.candle;
    const sigType = item.sigType;
    const targetLevel = item.targetLevel;
    const condLevel = item.condLevel;

    console.log(`----------------------------------------------------------------`);
    console.log(`⏱️ Thời điểm: ${candle.timeStr} | Tín hiệu: ${sigType} | Entry: $${targetLevel} | Cond: $${condLevel}`);

    // Trích 150 nến M1 trước đó
    const recentM1 = m1Candles.slice(idx - 150, idx + 1);

    // Kiểm tra Stale Bounce Logic
    const touchThresholdPct = 0.12;
    const gridWidth = Math.abs(condLevel - targetLevel);
    const pct = (gridWidth / Math.min(targetLevel, condLevel)) * 100;
    const preEntryBouncePct = pct / 5.5;

    let startIdx = 0;
    let condTouchCandle = null;
    for (let i = recentM1.length - 1; i >= 0; i--) {
      if (sigType === 'LONG' && recentM1[i].high >= condLevel) {
        startIdx = i;
        condTouchCandle = recentM1[i];
        break;
      } else if (sigType === 'SHORT' && recentM1[i].low <= condLevel) {
        startIdx = i;
        condTouchCandle = recentM1[i];
        break;
      }
    }

    let maxBouncePct = 0;
    let bestTouchPrice = 0;
    let bestPeakPrice = 0;
    let touchCandles = [];
    const touchZoneUpper = targetLevel * (1 + touchThresholdPct / 100);
    const touchZoneLower = targetLevel * (1 - touchThresholdPct / 100);

    for (let i = startIdx; i < recentM1.length; i++) {
      const c = recentM1[i];
      if (sigType === 'LONG' && c.low <= touchZoneUpper) {
        touchCandles.push(c);
        const touchLow = c.low;
        let peakHigh = candle.close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].high > peakHigh) peakHigh = recentM1[j].high;
        }
        const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
        if (bouncePct > maxBouncePct) {
          maxBouncePct = bouncePct;
          bestTouchPrice = touchLow;
          bestPeakPrice = peakHigh;
        }
      } else if (sigType === 'SHORT' && c.high >= touchZoneLower) {
        touchCandles.push(c);
        const touchHigh = c.high;
        let troughLow = candle.close;
        for (let j = i; j < recentM1.length; j++) {
          if (recentM1[j].low < troughLow) troughLow = recentM1[j].low;
        }
        const dropPct = ((touchHigh - troughLow) / touchHigh) * 100;
        if (dropPct > maxBouncePct) {
          maxBouncePct = dropPct;
          bestTouchPrice = touchHigh;
          bestPeakPrice = troughLow;
        }
      }
    }

    console.log(` • Nến mốc condLevel ($${condLevel}) vừa chạm gần nhất: ${condTouchCandle ? condTouchCandle.timeStr : 'Không có'}`);
    console.log(` • Số nến chạm mốc entry ($${targetLevel}) sau condLevel: ${touchCandles.length}`);
    console.log(` • % Nảy thực tế: +${maxBouncePct.toFixed(2)}% (Ngưỡng cho phép: ${preEntryBouncePct.toFixed(2)}%)`);

    const isStaleBlocked = maxBouncePct >= preEntryBouncePct;
    console.log(` • Đánh giá Scan nến 1M: ${isStaleBlocked ? '❌ BỊ BLOCK STALE (Hủy LIMIT)' : '✅ HỢP LỆ (Cho phép LIMIT)'}`);

    // Giả lập diễn biến lệnh trong 180 phút tiếp theo
    const futureCandles = m1Candles.slice(idx, idx + 180);
    let limitFilled = false;
    let finalOutcome = 'CHƯA KHỚP';
    const leverage = 10;

    for (const fc of futureCandles) {
      if (!limitFilled) {
        if (sigType === 'LONG' && fc.low <= targetLevel) limitFilled = true;
        if (sigType === 'SHORT' && fc.high >= targetLevel) limitFilled = true;
      }
      if (limitFilled) {
        const roiHigh = sigType === 'LONG' ? ((fc.high - targetLevel) / targetLevel) * leverage * 100 : ((targetLevel - fc.low) / targetLevel) * leverage * 100;
        const roiLow = sigType === 'LONG' ? ((fc.low - targetLevel) / targetLevel) * leverage * 100 : ((targetLevel - fc.high) / targetLevel) * leverage * 100;

        if (roiHigh >= 10) { finalOutcome = '🏆 WIN (+10% ROI)'; break; }
        if (roiLow <= -10) { finalOutcome = '❌ LOSS (-10% ROI)'; break; }
      }
    }

    console.log(` • Diễn biến lệnh sau đó: ${finalOutcome}`);
  }

  console.log('\n================================================================\n');
}

main();
