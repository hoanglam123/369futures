const fs = require('fs');
const readline = require('readline');
const axios = require('axios');

async function testRealVpsOrders() {
  const rl = readline.createInterface({ input: fs.createReadStream('./logs/pm2-out.log'), crlfDelay: Infinity });
  const orders = [];
  let currentScore = {};

  for await (const line of rl) {
    const mScore = line.match(/\[AutoTrade\] ([A-Z0-9]+) → (LONG|SHORT) \(Score: \+([0-9.]+)đ\)/);
    if (mScore) {
      currentScore[mScore[1]] = parseFloat(mScore[3]);
    }

    const mOrder = line.match(/([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}): \[PP369\] \[AutoTrade\] ✓ ([A-Z0-9]+) (BUY|SELL) ([0-9.]+) @ \$([0-9.]+) orderId=([0-9]+)/);
    if (mOrder) {
      const timeStr = mOrder[1];
      const sym = mOrder[2];
      const side = mOrder[3] === 'BUY' ? 'LONG' : 'SHORT';
      const qty = parseFloat(mOrder[4]);
      const price = parseFloat(mOrder[5]);
      const orderId = mOrder[6];
      const score = currentScore[sym] || null;
      
      const d = new Date(timeStr);
      if (d >= new Date('2026-08-16T00:00:00')) {
        orders.push({ time: timeStr, ts: d.getTime(), sym, side, price, qty, score, orderId });
      }
    }
  }

  console.log(`Đã tìm thấy ${orders.length} lệnh đặt Limit thực tế trên VPS từ 16/08.`);

  const detailed = [];
  for (const ord of orders) {
    try {
      // 1. Check nến M15
      const resM15 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: ord.sym + 'USDT', interval: '15m', endTime: ord.ts, limit: 21 },
        timeout: 5000
      });
      const kM15 = resM15.data || [];
      let m15VolRatio = 1.0;
      let m15Range = 0;
      if (kM15.length >= 20) {
        const base20 = kM15.slice(0, 19).reduce((s, c) => s + parseFloat(c[5]), 0) / 19;
        const curr = kM15[kM15.length - 1];
        m15VolRatio = base20 > 0 ? (parseFloat(curr[5]) / base20) : 1;
        m15Range = ((parseFloat(curr[2]) - parseFloat(curr[3])) / parseFloat(curr[4])) * 100;
      }

      // 2. Check nến H1
      const resH1 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: ord.sym + 'USDT', interval: '1h', endTime: ord.ts, limit: 28 },
        timeout: 5000
      });
      const kH1 = resH1.data || [];
      let h1VolRatio = 1.0;
      if (kH1.length >= 27) {
        const base24 = kH1.slice(0, 24).reduce((s, c) => s + parseFloat(c[5]), 0) / 24;
        const max3 = Math.max(...kH1.slice(-3).map(c => parseFloat(c[5])));
        h1VolRatio = base24 > 0 ? (max3 / base24) : 1;
      }

      // 3. Check diễn biến 5m
      const res5m = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: ord.sym + 'USDT', interval: '5m', startTime: ord.ts, limit: 144 },
        timeout: 5000
      });
      const k5m = res5m.data || [];
      let isFilled = false;
      let outcome = 'TIMEOUT';
      let isBe = false;
      const entry = ord.price;
      const side = ord.side;

      for (const k of k5m) {
        const h = parseFloat(k[2]);
        const l = parseFloat(k[3]);
        if (!isFilled) {
          if (side === 'LONG' && l <= entry) isFilled = true;
          if (side === 'SHORT' && h >= entry) isFilled = true;
          if (!isFilled) continue;
        }
        if (side === 'LONG') {
          if (!isBe && h >= entry * 1.005) isBe = true;
          if (h >= entry * 1.010) { outcome = 'TP'; break; }
          if (l <= (isBe ? entry * 1.0003 : entry * 0.990)) { outcome = isBe ? 'BE' : 'SL'; break; }
        } else {
          if (!isBe && l <= entry * 0.995) isBe = true;
          if (l <= entry * 0.990) { outcome = 'TP'; break; }
          if (h >= (isBe ? entry * 0.9997 : entry * 1.010)) { outcome = isBe ? 'BE' : 'SL'; break; }
        }
      }

      detailed.push({
        time: ord.time,
        sym: ord.sym,
        side: ord.side,
        score: ord.score,
        isFilled,
        outcome,
        m15VolRatio,
        m15Range,
        h1VolRatio
      });
    } catch(e) {}
  }

  console.log('\n=== TỔNG HỢP DIỄN BIẾN TOÀN BỘ CÁC LỆNH LIMIT THỰC TẾ TRÊN VPS ===');
  const filledOnly = detailed.filter(d => d.isFilled);
  console.log(`Tổng số lệnh đã khớp thực tế: ${filledOnly.length} / ${detailed.length} lệnh đặt`);

  // Xem các lệnh bị Volume M15 hoặc H1 >= 2.5x
  const volSurgeOrders = filledOnly.filter(d => d.m15VolRatio >= 2.5 || d.h1VolRatio >= 2.5);
  console.log(`\nSố lệnh bị dính Volume Spike (M15 >= 2.5x hoặc H1 >= 2.5x): ${volSurgeOrders.length}`);
  console.table(volSurgeOrders.map(v => ({
    time: v.time,
    coin: v.sym,
    side: v.side,
    score: v.score + 'đ',
    m15Vol: v.m15VolRatio.toFixed(2) + 'x',
    h1Vol: v.h1VolRatio.toFixed(2) + 'x',
    kết_quả: v.outcome === 'TP' ? '🟢 THẮNG (+5$)' : (v.outcome === 'SL' ? '🔴 THUA (-5$)' : '🟡 HÒA ($0)')
  })));

  // Thống kê so sánh
  const normalOrders = filledOnly.filter(d => d.m15VolRatio < 2.5 && d.h1VolRatio < 2.5);
  
  function stats(list, label) {
    const wins = list.filter(d => d.outcome === 'TP').length;
    const bes = list.filter(d => d.outcome === 'BE').length;
    const losses = list.filter(d => d.outcome === 'SL').length;
    const fin = wins + bes + losses;
    const pnl = wins * 5 - losses * 5;
    console.log(`\n📌 ${label} (Tổng: ${list.length} lệnh):`);
    console.log(`- 🟢 Thắng: ${wins} | 🟡 Hòa: ${bes} | 🔴 Thua: ${losses}`);
    console.log(`- 🎯 WinRate (Thắng/Thua): ${fin > 0 ? ((wins / (wins + losses || 1)) * 100).toFixed(1) : 0}%`);
    console.log(`- 🛡️ Tỷ lệ Không Lỗ (Win+BE): ${fin > 0 ? (((wins + bes) / fin) * 100).toFixed(1) : 0}%`);
    console.log(`- 💰 PnL: ${pnl >= 0 ? '+' : ''}${pnl} USD`);
  }

  stats(filledOnly, '1. TẤT CẢ LỆNH KHỚP TRÊN VPS (Chưa lọc Volume)');
  stats(normalOrders, '2. KHI ÁP DỤNG BỘ LỌC VOLUME (Chặn M15 >= 2.5x & H1 >= 2.5x)');
}

testRealVpsOrders().catch(console.error);
