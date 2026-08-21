'use strict';

const axios = require('axios');

async function inspectBtcM15() {
  const BASE = 'https://fapi.binance.com';

  // Lấy 15 nến M15 gần nhất của BTCUSDT
  const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=15`);
  const rawKlines = res.data || [];

  console.log('='.repeat(95));
  console.log('🔍 SOI CHI TIẾT TỪNG CÂY NẾN M15 CỦA BTCUSDT TỪ 14:00 ĐẾN 16:15 HÔM NAY:');
  console.log('='.repeat(95));

  rawKlines.forEach((k, i) => {
    const openTime = new Date(k[0]).toLocaleTimeString('vi-VN');
    const closeTime = new Date(k[6]).toLocaleTimeString('vi-VN');
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const volume = parseFloat(k[5]);

    const rangePct = ((high - low) / low) * 100;
    const bodyPct = ((close - open) / open) * 100;
    const maxPushPct = ((high - open) / open) * 100;

    const candleType = close >= open ? '🟢 TĂNG' : '🔴 GIẢM';

    console.log(`\n--- Nến M15 #${i + 1} [${openTime} - ${closeTime}] ${candleType} ---`);
    console.log(`  • Giá: Open $${open} | High $${high} | Low $${low} | Close $${close}`);
    console.log(`  • Biến động High-Low (Range): ${rangePct.toFixed(3)}% ($${(high - low).toFixed(1)})`);
    console.log(`  • Biến động Thân nến (Close-Open): ${bodyPct >= 0 ? '+' : ''}${bodyPct.toFixed(3)}% ($${(close - open).toFixed(1)})`);
    console.log(`  • Rướn đỉnh tối đa (High-Open): +${maxPushPct.toFixed(3)}% ($${(high - open).toFixed(1)})`);
    console.log(`  • Volume: ${volume.toFixed(2)} BTC`);
  });
}

inspectBtcM15().catch(err => console.error('Lỗi:', err.message));
