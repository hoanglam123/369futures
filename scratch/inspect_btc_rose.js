'use strict';

require('dotenv').config();
const axios = require('axios');

async function inspectBtcAndRose() {
  const BASE = 'https://fapi.binance.com';

  // Lấy các nến M15 của BTCUSDT từ 15:30 đến 16:50
  const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=8`);
  const rawKlines = res.data || [];

  console.log('='.repeat(95));
  console.log('🔍 SOI NẾN M15 BTC TỪ 15:30 ĐẾN 16:50 HÔM NAY:');
  console.log('='.repeat(95));

  rawKlines.forEach((k, i) => {
    const openTime = new Date(k[0]).toLocaleTimeString('vi-VN');
    const closeTime = new Date(k[6]).toLocaleTimeString('vi-VN');
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);

    const rangePct = ((high - low) / low) * 100;
    const bodyPct = ((close - open) / open) * 100;
    const pushHighPct = ((high - open) / open) * 100;
    const plungeLowPct = ((open - low) / open) * 100;

    const candleType = close >= open ? '🟢 TĂNG' : '🔴 GIẢM';

    console.log(`\n--- Nến M15 [${openTime} - ${closeTime}] ${candleType} ---`);
    console.log(`  • Giá: Open $${open} | High $${high} | Low $${low} | Close $${close}`);
    console.log(`  • Thân nến: ${bodyPct >= 0 ? '+' : ''}${bodyPct.toFixed(3)}% ($${(close - open).toFixed(1)})`);
    console.log(`  • Rướn Đỉnh: +${pushHighPct.toFixed(3)}% | Đâm Đáy: -${plungeLowPct.toFixed(3)}% | Range: ${rangePct.toFixed(3)}%`);
    console.log(`  • Volume: ${vol.toFixed(2)} BTC`);
  });

  // Lấy lịch sử giao dịch ROSEUSDT nếu có
  try {
    const roseRes = await axios.get(`${BASE}/fapi/v1/klines?symbol=ROSEUSDT&interval=15m&limit=5`);
    console.log('\n' + '='.repeat(95));
    console.log('🌹 SOI NẾN M15 CỦA ROSEUSDT TỪ 16:00 ĐẾN NAY:');
    console.log('='.repeat(95));
    roseRes.data.forEach(k => {
      const openTime = new Date(k[0]).toLocaleTimeString('vi-VN');
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      console.log(`[${openTime}] ROSE: Open $${open} | High $${high} | Low $${low} | Close $${close} (Biến động: ${(((close - open)/open)*100).toFixed(2)}%)`);
    });
  } catch (_) {}
}

inspectBtcAndRose();
