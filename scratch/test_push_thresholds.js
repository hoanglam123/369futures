'use strict';

const axios = require('axios');

async function testPushThresholds() {
  const BASE = 'https://fapi.binance.com';
  const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=1500`);
  const rawKlines = res.data || [];

  const compareSets = [
    { label: 'Set A (Hiện tại): Body >= 0.50% | Push >= 0.70% | Vol >= 1.8x', body: 0.50, push: 0.70, vol: 1.8 },
    { label: 'Set B (Tăng nhẹ): Body >= 0.55% | Push >= 0.80% | Vol >= 2.0x', body: 0.55, push: 0.80, vol: 2.0 },
    { label: 'Set C (An toàn cao - Khuyên dùng): Body >= 0.60% | Push >= 0.85% | Vol >= 2.0x', body: 0.60, push: 0.85, vol: 2.0 },
    { label: 'Set D (Rất chặt): Body >= 0.75% | Push >= 1.00% | Vol >= 2.5x', body: 0.75, push: 1.00, vol: 2.5 },
  ];

  console.log('='.repeat(90));
  console.log('📊 SO SÁNH CÁC MỨC RƯỚN VÀ THÂN NẾN TRÊN 1,480 CÂY NẾN M15 (15 NGÀY QUA):');
  console.log('='.repeat(90));

  compareSets.forEach(s => {
    let triggers = 0;
    for (let i = 20; i < rawKlines.length; i++) {
      const k = rawKlines[i];
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const vol = parseFloat(k[5]);

      let sum = 0;
      for (let j = i - 20; j < i; j++) sum += parseFloat(rawKlines[j][5]);
      const ma20Vol = sum / 20;

      const bodyPct = (Math.abs(close - open) / open) * 100;
      const pushPct = (Math.max(high - open, open - low) / open) * 100;
      const volRatio = ma20Vol > 0 ? (vol / ma20Vol) : 1;

      if (volRatio >= s.vol && (bodyPct >= s.body || pushPct >= s.push)) {
        triggers++;
      }
    }

    const pct = ((triggers / (rawKlines.length - 20)) * 100).toFixed(2);
    const avgPerDay = (triggers / 15).toFixed(1);
    console.log(`\n🔹 ${s.label}:`);
    console.log(`   • Số lần kích hoạt: ${triggers} nến (${pct}% tổng thời gian)`);
    console.log(`   • Tần suất: ~${avgPerDay} lần / ngày`);
  });
}

testPushThresholds();
