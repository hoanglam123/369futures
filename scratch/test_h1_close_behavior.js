const axios = require('axios');

async function fetchKlines(symbol, interval, startTime, limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
  const res = await axios.get(url);
  return res.data.map(k => ({
    openTime: k[0],
    timeStr: new Date(k[0]).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

async function analyzeTrades() {
  // 1. SKYAI: Khớp lúc 12:58 (H1 12:00->13:00 đóng lúc 13:00). Entry ~0.08009. Cắt lỗ lúc 17:02
  const skyaiKlines = await fetchKlines('SKYAIUSDT', '1h', new Date('2026-08-13T12:00:00+07:00').getTime(), 8);
  console.log('=== SKYAI H1 Candles after entry 0.08009 ===');
  for (const c of skyaiKlines) {
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close}`);
  }

  // 2. TRUST: Khớp lúc 16:48 (Entry 0.05310). H1 đóng lúc 17:00. Cắt lỗ lúc 17:35 @ 0.05206
  const trustKlines = await fetchKlines('TRUSTUSDT', '1h', new Date('2026-08-13T16:00:00+07:00').getTime(), 4);
  console.log('\n=== TRUST H1 Candles after entry 0.05310 ===');
  for (const c of trustKlines) {
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close}`);
  }

  // 3. STEEM: Khớp lúc 12:43 (Entry 0.03545). H1 đóng lúc 13:00. Cắt lỗ lúc 13:07 @ 0.03485
  const steemKlines = await fetchKlines('STEEMUSDT', '1h', new Date('2026-08-13T12:00:00+07:00').getTime(), 4);
  console.log('\n=== STEEM H1 Candles after entry 0.03545 ===');
  for (const c of steemKlines) {
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close}`);
  }

  // 4. BOME (Lệnh 2): Khớp lúc 23:20 (Entry 0.0007522). H1 đóng lúc 00:00. Cắt lỗ lúc 23:42
  const bomeKlines = await fetchKlines('BOMEUSDT', '1h', new Date('2026-08-13T23:00:00+07:00').getTime(), 4);
  console.log('\n=== BOME H1 Candles around 23:00 ===');
  for (const c of bomeKlines) {
    console.log(`${c.timeStr} | O: ${c.open} | H: ${c.high} | L: ${c.low} | C: ${c.close}`);
  }
}

analyzeTrades();
