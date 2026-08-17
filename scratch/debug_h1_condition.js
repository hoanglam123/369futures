const axios = require('axios');

async function testH1Logic() {
  const sym = 'BTCUSDT';
  const nowMs = Date.now();
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${nowMs - 3 * 3600_000}&limit=3`;
  const res = await axios.get(url);
  const h1s = res.data.map(k => ({
    openTime: k[0],
    openTimeStr: new Date(k[0]).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    closeTime: k[6],
    closeTimeStr: new Date(k[6]).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    open: parseFloat(k[1]),
    close: parseFloat(k[4])
  }));

  console.log(`Now: ${new Date(nowMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
  console.log(`Fetched ${h1s.length} candles:`);
  h1s.forEach((c, idx) => {
    console.log(` [${idx}] OpenTime: ${c.openTimeStr} -> CloseTime: ${c.closeTimeStr} | Close: ${c.close}`);
  });

  const lastClosedH1 = h1s[h1s.length - 2];
  console.log(`\nh1s[h1s.length - 2] is:`, lastClosedH1?.openTimeStr);

  // Example trade entered at 09:15
  const metaTime = new Date('2026-08-17T09:15:00+07:00').getTime();
  console.log(`\nExample: Trade entered at 09:15:00 (meta.time = ${new Date(metaTime).toLocaleTimeString('vi-VN')})`);
  console.log(`When checked at 10:01:00 (H1 09:00->10:00 just closed):`);
  const checkTime = new Date('2026-08-17T10:01:00+07:00').getTime();
  const simulatedH1Open = new Date('2026-08-17T09:00:00+07:00').getTime();
  console.log(`  lastClosedH1.openTime = ${new Date(simulatedH1Open).toLocaleTimeString('vi-VN')} (${simulatedH1Open})`);
  console.log(`  meta.time             = ${new Date(metaTime).toLocaleTimeString('vi-VN')} (${metaTime})`);
  console.log(`  Condition (lastClosedH1.openTime > meta.time): ${simulatedH1Open > metaTime}  <--- ❌ BỊ FALSE VÌ 09:00 < 09:15!`);
}

testH1Logic();
