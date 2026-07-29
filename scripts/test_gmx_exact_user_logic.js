'use strict';

const axios = require('axios');

async function main() {
  console.log('================================================================');
  console.log(' 🔎 TEST CHÍNH XÁC THEO ĐÚNG LOGIC CỦA BẠN CHO GMX TẠI 10:37');
  console.log('================================================================\n');

  const symbol = 'GMX';
  const targetTimeMs = new Date('2026-07-29T10:37:00+07:00').getTime();

  // Tải 300 nến M1 GMX (từ 06:00 đến 11:00 VN)
  const startTime = targetTimeMs - 240 * 60000;
  const endTime = targetTimeMs + 60 * 60000;

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

  const targetCandleIdx = m1Candles.findIndex(c => c.openTime >= targetTimeMs);
  const priceAt1037 = m1Candles[targetCandleIdx].close;

  // Khung mốc theo đúng logic của bạn:
  const condLevel = 7.109;   // Mốc Short trên
  const targetLevel = 6.823; // Mốc Long dưới

  const gridWidth = condLevel - targetLevel; // 0.286
  const gridWidthPct = (gridWidth / targetLevel) * 100; // 4.19%
  const preEntryBouncePct = gridWidthPct / 5.0; // 0.838%
  const touchThresholdPct = 0.12;
  const touchZoneUpper = targetLevel * (1 + touchThresholdPct / 100); // ~6.831

  console.log('📌 1. THÔNG SỐ KHUNG KẸP DÒNG GIÁ:');
  console.log(` • Mốc Short trên (condLevel): $${condLevel}`);
  console.log(` • Mốc Long dưới (targetLevel): $${targetLevel}`);
  console.log(` • Độ rộng Khung: $${gridWidth.toFixed(3)} (${gridWidthPct.toFixed(2)}%)`);
  console.log(` • Ngưỡng cho phép nảy (Khung / 5): ${preEntryBouncePct.toFixed(3)}%`);
  console.log(` • Vùng xát mốc Long (touchZoneUpper): $${touchZoneUpper.toFixed(3)}\n`);

  // Trích xuất các nến M1 tính đến trước 10:37
  const recentM1 = m1Candles.slice(0, targetCandleIdx + 1);

  // BƯỚC 1: Quét tìm nến gần nhất chạm mốc Short trên ($7.109)
  let startIdx = -1;
  let condTouchCandle = null;

  for (let i = recentM1.length - 1; i >= 0; i--) {
    if (recentM1[i].high >= condLevel) {
      startIdx = i;
      condTouchCandle = recentM1[i];
      break;
    }
  }

  console.log('📌 2. BƯỚC 1: XÁC ĐỊNH ĐIỂM CHẠM MỐC SHORT TRÊN ($7.109)');
  if (condTouchCandle) {
    console.log(` ✅ Nến vừa chạm mốc Short trên ($${condLevel}) gần nhất ở chỉ số [${startIdx}]: ${condTouchCandle.timeStr} (High: $${condTouchCandle.high})`);
    console.log(` ➡️ Cắt bỏ tất cả nến trước ${condTouchCandle.timeStr}, chỉ quét từ ${condTouchCandle.timeStr} đến 10:37 (${recentM1.length - startIdx} nến)\n`);
  } else {
    console.log(` ⚠️ Không tìm thấy nến nào trong quá khứ chạm mốc Short $${condLevel}. Quét từ nến đầu tiên.\n`);
    startIdx = 0;
  }

  // BƯỚC 2 & 3: Kiểm tra xem trong các nến từ startIdx đến 10:37 có nến nào xát mốc LONG ($6.823) hay chưa
  console.log('📌 3. BƯỚC 2 & 3: QUÉT NẾN XÁT MỐC LONG ($6.823) VÀ TÍNH ĐỈNH NẢY');

  let touchCandles = [];
  let maxBouncePct = 0;
  let bestTouchLow = 0;
  let bestPeakHigh = 0;
  let touchTimeStr = '';

  for (let i = startIdx; i < recentM1.length; i++) {
    const c = recentM1[i];
    if (c.low <= touchZoneUpper) {
      touchCandles.push(c);
      const touchLow = c.low;
      let peakHigh = priceAt1037;
      let peakTime = recentM1[recentM1.length - 1].timeStr;

      for (let j = i; j < recentM1.length; j++) {
        if (recentM1[j].high > peakHigh) {
          peakHigh = recentM1[j].high;
          peakTime = recentM1[j].timeStr;
        }
      }

      const bouncePct = ((peakHigh - touchLow) / touchLow) * 100;
      if (bouncePct > maxBouncePct) {
        maxBouncePct = bouncePct;
        bestTouchLow = touchLow;
        bestPeakHigh = peakHigh;
        touchTimeStr = c.timeStr;
      }
    }
  }

  console.log(` • Số nến xát mốc LONG ($${targetLevel}) từ lúc chạm $${condLevel} đến 10:37: ${touchCandles.length}`);

  if (touchCandles.length > 0) {
    console.log(` ✅ Đã phát hiện nến xát mốc LONG tại thời điểm: ${touchTimeStr} (Low: $${bestTouchLow})`);
    console.log(` 📈 Đỉnh cao nhất tạo được từ đáy đó đến 10:37: $${bestPeakHigh}`);
    console.log(` 📊 % Nảy thực tế tính được: +${maxBouncePct.toFixed(2)}%`);
  } else {
    console.log(` ✅ Từ lúc chạm $${condLevel} đến 10:37: CHƯA CÓ CÂY NẾN NÀO XÁT MỐC LONG ($${targetLevel}).`);
    console.log(` 📊 % Nảy thực tế: 0.00%`);
  }

  console.log('\n📌 4. BƯỚC 4: SO SÁNH VỚI NGƯỠNG % KHUNG / 5');
  console.log(` • % Nảy tính được: +${maxBouncePct.toFixed(2)}%`);
  console.log(` • Ngưỡng cho phép (% Khung / 5): ${preEntryBouncePct.toFixed(3)}%`);

  if (maxBouncePct >= preEntryBouncePct) {
    console.log(` ❌ KẾT QUẢ: NẢY QUÁ XA! (+${maxBouncePct.toFixed(2)}% >= ${preEntryBouncePct.toFixed(3)}%)`);
    console.log(' ➡️ HỦY LỆNH LIMIT! Ghi nhận mã GMX đã nảy stale.');
  } else {
    console.log(` ✅ KẾT QUẢ: HỢP LỆ (FRESH)! (+${maxBouncePct.toFixed(2)}% < ${preEntryBouncePct.toFixed(3)}%)`);
    console.log(' ➡️ CHO PHÉP ĐẶT LỆNH LIMIT LONG CHỜ SẴN TẠI $6.823.');
  }

  console.log('\n================================================================\n');
}

main();
