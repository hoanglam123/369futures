'use strict';

const axios = require('axios');

async function analyzeBtcVolatilityDistribution() {
  const BASE = 'https://fapi.binance.com';

  // Lấy 1500 nến M15 của BTCUSDT (~ 15 ngày qua)
  const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=1500`);
  const rawKlines = res.data || [];

  const bodyPcts = [];
  const pushPcts = [];
  const rangePcts = [];
  const volRatios = [];

  for (let i = 20; i < rawKlines.length; i++) {
    const k = rawKlines[i];
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);

    // calculate MA20 vol
    let sum = 0;
    for (let j = i - 20; j < i; j++) {
      sum += parseFloat(rawKlines[j][5]);
    }
    const ma20Vol = sum / 20;

    const bodyPct = (Math.abs(close - open) / open) * 100;
    const rangePct = ((high - low) / low) * 100;
    const pushPct = (Math.max(high - open, open - low) / open) * 100;
    const volRatio = ma20Vol > 0 ? (vol / ma20Vol) : 1;

    bodyPcts.push(bodyPct);
    pushPcts.push(pushPct);
    rangePcts.push(rangePct);
    volRatios.push(volRatio);
  }

  // Calculate percentiles
  const getPercentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[idx];
  };

  console.log('='.repeat(90));
  console.log(`📊 PHÂN TÍCH THỐNG KÊ ${bodyPcts.length} NẾN M15 CỦA BTC TRÊN BINANCE (15 NGÀY QUA):`);
  console.log('='.repeat(90));

  console.log(`• Biến động thân nến (Body %):`);
  console.log(`   - P50 (Trung vị - ngày thường): ${getPercentile(bodyPcts, 50).toFixed(3)}%`);
  console.log(`   - P80 (Bắt đầu có lực đẩy):    ${getPercentile(bodyPcts, 80).toFixed(3)}%`);
  console.log(`   - P90 (Biến động mạnh):         ${getPercentile(bodyPcts, 90).toFixed(3)}%`);
  console.log(`   - P95 (Bão / Biến động cực mạnh): ${getPercentile(bodyPcts, 95).toFixed(3)}%`);
  console.log(`   - P98 (Siêu bão / Squeeze):     ${getPercentile(bodyPcts, 98).toFixed(3)}%`);

  console.log(`\n• Rướn nến tối đa (Push/Wick %):`);
  console.log(`   - P50 (Bình thường):            ${getPercentile(pushPcts, 50).toFixed(3)}%`);
  console.log(`   - P80 (Giật cản nhẹ):          ${getPercentile(pushPcts, 80).toFixed(3)}%`);
  console.log(`   - P90 (Giật cản mạnh):          ${getPercentile(pushPcts, 90).toFixed(3)}%`);
  console.log(`   - P95 (Quét sạch cản):         ${getPercentile(pushPcts, 95).toFixed(3)}%`);
  console.log(`   - P98 (Bão quét diện rộng):     ${getPercentile(pushPcts, 98).toFixed(3)}%`);

  console.log(`\n• Tỷ lệ Volume so với MA20 (Vol Ratio):`);
  console.log(`   - P50 (Bình thường):            ${getPercentile(volRatios, 50).toFixed(2)}x`);
  console.log(`   - P80 (Volume tăng):           ${getPercentile(volRatios, 80).toFixed(2)}x`);
  console.log(`   - P90 (Volume bùng nổ):         ${getPercentile(volRatios, 90).toFixed(2)}x`);
  console.log(`   - P95 (Dòng tiền cá mập):       ${getPercentile(volRatios, 95).toFixed(2)}x`);

  // Thống kê số lần kích hoạt theo các ngưỡng khác nhau
  const testThresholds = [
    { name: 'Ngưỡng Rất Nhạy (Body >= 0.40% HOẶC Push >= 0.55% & Vol >= 1.5x)', body: 0.40, push: 0.55, vol: 1.5 },
    { name: 'Ngưỡng Hiện Tại (Body >= 0.50% HOẶC Push >= 0.70% & Vol >= 1.8x)', body: 0.50, push: 0.70, vol: 1.8 },
    { name: 'Ngưỡng Chặt Chẽ (Body >= 0.65% HOẶC Push >= 0.85% & Vol >= 2.0x)', body: 0.65, push: 0.85, vol: 2.0 },
    { name: 'Ngưỡng Rất Chặt (Body >= 0.80% HOẶC Push >= 1.00% & Vol >= 2.5x)', body: 0.80, push: 1.00, vol: 2.5 },
  ];

  console.log('\n' + '='.repeat(90));
  console.log('📋 ĐÁNH GIÁ TẦN SUẤT KÍCH HOẠT THEO CÁC BỘ THÔNG SỐ (TRONG 15 NGÀY = 1440 NẾN M15):');
  console.log('='.repeat(90));

  testThresholds.forEach(t => {
    let triggers = 0;
    for (let i = 0; i < bodyPcts.length; i++) {
      if (volRatios[i] >= t.vol && (bodyPcts[i] >= t.body || pushPcts[i] >= t.push)) {
        triggers++;
      }
    }
    const pct = (triggers / bodyPcts.length) * 100;
    const avgPerDay = (triggers / 15).toFixed(1);
    console.log(`\n🔹 ${t.name}:`);
    console.log(`   • Số nến kích hoạt: ${triggers}/${bodyPcts.length} nến (${pct.toFixed(2)}% tổng thời gian)`);
    console.log(`   • Tần suất trung bình: ~${avgPerDay} lần / ngày (Mỗi lần bảo vệ ~45 phút)`);
  });
}

analyzeBtcVolatilityDistribution().catch(err => console.error(err.message));
