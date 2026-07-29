'use strict';

const axios = require('axios');

async function main() {
  console.log('================================================================');
  console.log(' 🔎 SOI CHI TIẾT NẾN M1 CỦA GMX TRƯỚC VÀ TẠI THỜI ĐIỂM 10:37');
  console.log('================================================================\n');

  const symbol = 'GMX';
  const targetTimeMs = new Date('2026-07-29T10:37:00+07:00').getTime();

  // Tải nến M1 từ 09:00:00 đến 10:45:00 (trước và sau 10:37)
  const startTime = targetTimeMs - 90 * 60000; // 90 phút trước 10:37
  const endTime = targetTimeMs + 15 * 60000;  // 15 phút sau 10:37

  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=500`;
  const res = await axios.get(url);
  const candles = (res.data || []).map(c => ({
    openTime: c[0],
    timeStr: new Date(c[0] + 7 * 3600000).toISOString().replace('T', ' ').substring(0, 19),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }));

  console.log(`Đã tải ${candles.length} nến M1 GMX từ ${candles[0].timeStr} đến ${candles[candles.length - 1].timeStr}\n`);

  // In danh sách nến M1 từ 10:00:00 đến 10:40:00
  console.log('📋 CHI TIẾT GIÁ GMX TỪ 10:00 ĐẾN 10:40:');
  console.log('─'.repeat(70));
  console.log('STT  | Thời gian (VN)    | Open     | High     | Low      | Close    | Vol');
  console.log('─'.repeat(70));

  let minLowBefore1037 = 999;
  let minLowTime = '';
  let maxHighAfterMinLow = -999;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.openTime <= targetTimeMs && c.openTime >= targetTimeMs - 45 * 60000) {
      if (c.low < minLowBefore1037) {
        minLowBefore1037 = c.low;
        minLowTime = c.timeStr;
      }
    }
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const isTarget = c.openTime === targetTimeMs;
    const marker = isTarget ? ' ◄◄ 10:37 (TÍN HIỆU)' : '';
    if (c.openTime >= targetTimeMs - 37 * 60000 && c.openTime <= targetTimeMs + 5 * 60000) {
      console.log(
        `${String(i).padStart(4)} | ${c.timeStr} | $${c.open.toFixed(3)} | $${c.high.toFixed(3)} | $${c.low.toFixed(3)} | $${c.close.toFixed(3)} | ${Math.round(c.volume)}${marker}`
      );
    }
  }

  console.log('─'.repeat(70));

  // Phân tích cú rớt và nảy trước 10:37:
  // Giả sử mốc LONG của GMX là $6.809 (hoặc mốc lân cận):
  console.log(`\n📌 PHÂN TÍCH DIỄN BIẾN TRƯỚC 10:37:`);
  console.log(` • Đáy thấp nhất trước 10:37 (trong 45m trước): $${minLowBefore1037} (lúc ${minLowTime})`);
  console.log(` • Giá tại nến 10:37: $${candles.find(c => c.openTime === targetTimeMs)?.close}`);

  // Tìm đỉnh nảy cao nhất từ đáy minLowBefore1037 đến 10:37
  let peakBetweenMinLowAnd1037 = -999;
  let peakTime = '';
  let minLowIdx = candles.findIndex(c => c.timeStr === minLowTime);
  let targetIdx = candles.findIndex(c => c.openTime === targetTimeMs);

  if (minLowIdx !== -1 && targetIdx !== -1) {
    for (let j = minLowIdx; j <= targetIdx; j++) {
      if (candles[j].high > peakBetweenMinLowAnd1037) {
        peakBetweenMinLowAnd1037 = candles[j].high;
        peakTime = candles[j].timeStr;
      }
    }
    const bouncePct = ((peakBetweenMinLowAnd1037 - minLowBefore1037) / minLowBefore1037) * 100;
    console.log(` • Từ đáy $${minLowBefore1037} (${minLowTime}), giá đã NẢY LÊN ĐỈNH $${peakBetweenMinLowAnd1037} (${peakTime})`);
    console.log(` • % Nảy thu được trước 10:37: +${bouncePct.toFixed(2)}%`);
  }

  console.log('================================================================\n');
}

main();
