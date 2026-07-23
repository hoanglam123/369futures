'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const filePath = path.join(process.cwd(), 'data', 'gemini-code-1784771566170.json');

// List of all items with their exact "time" added by user
const timesList = [
  "2026-07-22 12:11:10", "2026-07-22 12:14:09", "2026-07-22 12:19:09", "2026-07-22 12:36:10",
  "2026-07-22 13:21:39", "2026-07-22 13:25:39", "2026-07-22 13:29:38", "2026-07-22 13:31:08",
  "2026-07-22 13:34:08", "2026-07-22 13:44:13", "2026-07-22 14:00:23", "2026-07-22 14:00:51",
  "2026-07-22 14:34:49", "2026-07-22 14:58:21", "2026-07-22 14:59:20", "2026-07-22 15:06:21",
  "2026-07-22 15:11:21", "2026-07-22 16:24:40", "2026-07-22 16:27:09", "2026-07-22 16:33:09",
  "2026-07-22 16:33:11", "2026-07-22 16:39:39", "2026-07-22 16:47:09", "2026-07-22 16:55:10",
  "2026-07-22 17:13:09", "2026-07-22 17:25:09", "2026-07-22 17:42:39", "2026-07-22 17:54:08",
  "2026-07-22 18:12:40", "2026-07-22 18:22:39", "2026-07-22 18:40:08", "2026-07-22 19:13:40",
  "2026-07-22 19:21:09", "2026-07-22 19:28:39", "2026-07-22 19:47:39", "2026-07-22 20:07:40",
  "2026-07-22 21:01:40", "2026-07-22 21:09:09", "2026-07-22 21:24:08", "2026-07-22 21:36:09",
  "2026-07-22 22:16:10", "2026-07-22 22:18:10", "2026-07-22 22:26:40", "2026-07-22 22:36:39",
  "2026-07-22 22:37:39", "2026-07-22 22:54:10", "2026-07-22 23:03:40", "2026-07-22 23:07:40",
  "2026-07-22 23:21:09", "2026-07-22 23:22:10", "2026-07-22 23:34:09", "2026-07-22 23:36:40",
  "2026-07-22 23:41:09", "2026-07-23 00:20:10", "2026-07-23 00:43:09", "2026-07-23 01:36:40",
  "2026-07-23 01:39:10", "2026-07-23 01:58:40", "2026-07-23 02:00:10", "2026-07-23 02:36:40",
  "2026-07-23 03:45:10", "2026-07-23 04:10:11", "2026-07-23 04:32:10", "2026-07-23 05:01:11",
  "2026-07-23 05:02:41", "2026-07-23 05:34:39", "2026-07-23 06:13:11", "2026-07-23 06:19:40",
  "2026-07-23 06:55:40", "2026-07-23 07:00:41", "2026-07-23 07:04:10", "2026-07-23 07:07:11",
  "2026-07-23 07:09:39", "2026-07-23 07:14:11", "2026-07-23 07:23:09", "2026-07-23 07:26:10",
  "2026-07-23 07:48:11", "2026-07-23 08:05:10"
];

const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));

async function rebacktest() {
  console.log(`Bắt đầu backtest chính xác từ timestamp của ${items.length} khuyến nghị...`);
  const finalResults = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const timeStr = timesList[i] || item.time || "2026-07-22 12:00:00";
    const startTimeMs = new Date(timeStr.replace(' ', 'T') + '+07:00').getTime();

    const sym = item.symbol;
    const type = item.type;
    const entryPrice = parseFloat(item.entry.replace('$', '').replace(/,/g, ''));
    const scoreVal = parseFloat(item.score.replace('+', '').replace('đ', ''));

    let marginVal = 20;
    if (scoreVal >= 9.0) marginVal = 50;
    else if (scoreVal >= 8.0) marginVal = 40;
    else if (scoreVal >= 7.0) marginVal = 30;
    else marginVal = 20;

    const leverage = 10;
    let roiStr = '0%';

    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=5m&startTime=${startTimeMs}&limit=400`;
      const res = await axios.get(url, { timeout: 10000 });
      const klines = (res.data || []).map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4])
      }));

      if (klines.length > 0) {
        let maxRoi = -999;
        let minRoi = 999;
        let finalRoi = null;
        let trailed = false;

        for (const k of klines) {
          let candleMaxRoi, candleMinRoi;
          if (type === 'LONG') {
            candleMaxRoi = ((k.high - entryPrice) / entryPrice) * leverage * 100;
            candleMinRoi = ((k.low - entryPrice) / entryPrice) * leverage * 100;
          } else {
            candleMaxRoi = ((entryPrice - k.low) / entryPrice) * leverage * 100;
            candleMinRoi = ((entryPrice - k.high) / entryPrice) * leverage * 100;
          }

          if (candleMaxRoi > maxRoi) maxRoi = candleMaxRoi;
          if (candleMinRoi < minRoi) minRoi = candleMinRoi;

          if (maxRoi >= 5.0) trailed = true;

          // TP (+10% ROI)
          if (candleMaxRoi >= 10.0) {
            finalRoi = 10.0;
            break;
          }

          // SL (-10% ROI hoặc Trailing +1.0% ROI)
          if (candleMinRoi <= -10.0) {
            finalRoi = trailed ? 1.0 : -10.0;
            break;
          }
        }

        if (finalRoi === null) {
          const lastClose = klines[klines.length - 1].close;
          if (type === 'LONG') {
            finalRoi = ((lastClose - entryPrice) / entryPrice) * leverage * 100;
          } else {
            finalRoi = ((entryPrice - lastClose) / entryPrice) * leverage * 100;
          }
        }

        const formattedVal = Number(finalRoi.toFixed(1));
        roiStr = (formattedVal > 0 ? '+' : '') + formattedVal + '%';
      }
    } catch (e) {
      console.warn(`[${sym}] Error: ${e.message}`);
    }

    finalResults.push({
      time: timeStr,
      symbol: item.symbol,
      type: item.type,
      score: item.score,
      entry: item.entry,
      roi: roiStr,
      margin: `${marginVal}$`
    });

    await new Promise(r => setTimeout(r, 60));
  }

  fs.writeFileSync(filePath, JSON.stringify(finalResults, null, 2), 'utf8');
  console.log(`SUCCESSFULLY_BACKTESTED_AND_SAVED_${finalResults.length}_ITEMS`);
}

rebacktest().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
