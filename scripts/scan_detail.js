'use strict';

const axios = require('axios');

async function main() {
  const url = 'https://fapi.binance.com/fapi/v1/klines?symbol=ACHUSDT&interval=1m&limit=150';
  const res = await axios.get(url);
  const m1 = res.data.map(c => ({
    openTime: c[0],
    timeStr: new Date(c[0] + 7*3600000).toISOString().replace('T',' ').substring(0,19),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4])
  }));

  const condLevel = 0.004764;
  const targetLevel = 0.004321;
  const touchThresholdPct = 0.12;
  const touchZoneUpper = targetLevel * (1 + touchThresholdPct / 100);
  const preEntryBouncePct = ((0.0003 / targetLevel) * 100) / 5.5;

  console.log('================================================================');
  console.log(' 🔎 KẾT QUẢ QUÉT 150 NẾN 1M GẦN ĐÂY CỦA ACH (LOGIC MỚI)');
  console.log('================================================================');
  console.log(' • Tổng nến M1 được quét:', m1.length);
  console.log(' • Thời gian nến mới nhất:', m1[m1.length - 1].timeStr, '| Price:', m1[m1.length - 1].close);
  console.log(' • Mốc trên kích hoạt (condLevel):', condLevel);
  console.log(' • Mốc dưới chờ đặt lệnh (targetLevel):', targetLevel);
  console.log(' • Vùng chấp nhận chạm (touchZoneUpper):', touchZoneUpper);
  console.log(' • Ngưỡng nảy Stale (preEntryBouncePct):', preEntryBouncePct.toFixed(3) + '%\n');

  let startIdx = 0;
  let condTouchCandle = null;
  for (let i = m1.length - 1; i >= 0; i--) {
    if (m1[i].high >= condLevel) {
      startIdx = i;
      condTouchCandle = m1[i];
      break;
    }
  }

  console.log('📌 PHASE 1: XÁC ĐỊNH ĐIỂM XUẤT PHÁT TỪ MỐC CHẠM TRÊN');
  if (condTouchCandle) {
    console.log(` ✅ Tìm thấy nến chạm condLevel ($${condLevel}) tại chỉ số [${startIdx}]: ${condTouchCandle.timeStr} (Đỉnh high: $${condTouchCandle.high})`);
    console.log(` ➡️ Hệ thống CẮT BỎ tất cả các nến trước chỉ số [${startIdx}] (không quét nến cũ)`);
  } else {
    console.log(` ⚠️ Trong 150 nến M1 gần nhất, giá chưa từng vượt mốc $${condLevel}. Quét từ đầu nến [0]: ${m1[0].timeStr}`);
  }

  console.log('\n📌 PHASE 2: QUÉT CÁC NẾN TỪ NẾN [' + startIdx + '] ĐẾN HIỆN TẠI (' + m1.length + ' nến)');

  let maxBouncePct = 0;
  let bestTouchLow = 0;
  let bestPeakHigh = 0;
  let touchCandles = [];

  for (let i = startIdx; i < m1.length; i++) {
    const candle = m1[i];
    if (candle.low <= touchZoneUpper) {
      touchCandles.push(candle);
      const touchLow = candle.low;
      let peakHigh = m1[m1.length - 1].close;
      for (let j = i; j < m1.length; j++) {
        if (m1[j].high > peakHigh) peakHigh = m1[j].high;
      }
      const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
      if (bouncePct > maxBouncePct) {
        maxBouncePct = bouncePct;
        bestTouchLow = touchLow;
        bestPeakHigh = peakHigh;
      }
    }
  }

  console.log('\n📌 PHASE 3: KẾT QUẢ PHÂN TÍCH ĐIỀU KIỆN STALE BOUNCE');
  console.log(' • Số nến rơi vào vùng entry ($' + targetLevel + ') sau khi chạm mốc trên:', touchCandles.length);

  if (touchCandles.length > 0) {
    console.log(' • Đáy thấp nhất ghi nhận:', bestTouchLow);
    console.log(' • Đỉnh nảy cao nhất đạt được sau đó:', bestPeakHigh);
    console.log(' • % Nảy thực tế tính được: +' + maxBouncePct.toFixed(2) + '%');
    if (maxBouncePct >= preEntryBouncePct) {
      console.log(` ❌ ĐÁNH GIÁ: LỆNH BỊ BLOCK STALE! (+${maxBouncePct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(3)}%)`);
    } else {
      console.log(` ✅ ĐÁNH GIÁ: LỆNH HỢP LỆ (Không bị block)! (+${maxBouncePct.toFixed(2)}% < ${preEntryBouncePct.toFixed(3)}%)`);
    }
  } else {
    console.log(' ✅ ĐÁNH GIÁ: LỆNH HỢP LỆ!');
    console.log('    Sau khi chạm mốc trên ($' + condLevel + '), giá đang trên đường đi xuống và CHƯA HỀ CHẠM MỐC DƯỚI ($' + targetLevel + ').');
    console.log('    % Nảy Stale = 0.00% < ' + preEntryBouncePct.toFixed(3) + '% — ĐỦ ĐIỀU KIỆN ĐẶT LỆNH WAIT/LIMIT!');
  }
  console.log('================================================================\n');
}

main();
