'use strict';

const fs = require('fs');
const readline = require('readline');
const axios = require('axios');

async function run() {
  const fileStream = fs.createReadStream('./data/369_signals.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  const signals = [];
  const startMs = new Date('2026-08-16T00:00:00+07:00').getTime();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const sig = JSON.parse(line);
      const ts = new Date(sig.ts || sig.timestamp).getTime();
      if (ts >= startMs && sig.price && sig.symbol) {
        signals.push({ ...sig, timestampMs: ts });
      }
    } catch(e) {}
  }

  console.log('Tổng số tín hiệu từ 16/08:', signals.length);
  // Khử trùng theo symbol + signal + 30 phút
  const deduped = [];
  const seen = new Set();
  for (const s of signals) {
    const key = `${s.symbol}_${s.signal}_${Math.floor(s.timestampMs / (30 * 60 * 1000))}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(s);
    }
  }
  console.log('Số tín hiệu duy nhất (Unique Signals):', deduped.length);

  const results = [];
  let index = 0;

  for (const sig of deduped) {
    index++;
    const sym = sig.symbol;
    const side = sig.signal;
    const entry = sig.price;
    const ts = sig.timestampMs;

    try {
      // 1. Lấy nến M15 trước entry
      const resM15 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: `${sym.toUpperCase()}USDT`, interval: '15m', endTime: ts, limit: 21 },
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

      // 2. Lấy nến H1 trước entry
      const resH1 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: `${sym.toUpperCase()}USDT`, interval: '1h', endTime: ts, limit: 28 },
        timeout: 5000
      });
      const kH1 = resH1.data || [];
      let h1VolRatio = 1.0;
      if (kH1.length >= 27) {
        const base24 = kH1.slice(0, 24).reduce((s, c) => s + parseFloat(c[5]), 0) / 24;
        const max3 = Math.max(...kH1.slice(-3).map(c => parseFloat(c[5])));
        h1VolRatio = base24 > 0 ? (max3 / base24) : 1;
      }

      // 3. Lấy 144 nến 5m (12h) sau entry để xem kết quả khớp & chốt
      const res5m = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: `${sym.toUpperCase()}USDT`, interval: '5m', startTime: ts, limit: 144 },
        timeout: 5000
      });
      const k5m = res5m.data || [];
      if (k5m.length === 0) continue;

      let isFilled = false;
      let outcome = 'TIMEOUT';
      let isBe = false;

      const tpDist = entry * 0.010; // 1.0% TP
      const slDist = entry * 0.010; // 1.0% SL
      const beDist = entry * 0.005; // 0.5% dời SL

      for (const k of k5m) {
        const h = parseFloat(k[2]);
        const l = parseFloat(k[3]);

        if (!isFilled) {
          if (side === 'LONG' && l <= entry) isFilled = true;
          if (side === 'SHORT' && h >= entry) isFilled = true;
          if (!isFilled) continue;
        }

        if (side === 'LONG') {
          if (!isBe && h >= entry + beDist) isBe = true;
          if (h >= entry + tpDist) { outcome = 'TP'; break; }
          if (l <= (isBe ? entry * 1.0003 : entry - slDist)) { outcome = isBe ? 'BE' : 'SL'; break; }
        } else {
          if (!isBe && l <= entry - beDist) isBe = true;
          if (l <= entry - tpDist) { outcome = 'TP'; break; }
          if (h >= (isBe ? entry * 0.9997 : entry + slDist)) { outcome = isBe ? 'BE' : 'SL'; break; }
        }
      }

      if (isFilled) {
        results.push({
          sym, side, score: sig.score || 0,
          m15VolRatio, m15Range, h1VolRatio,
          outcome,
          pnl: outcome === 'TP' ? 5.0 : (outcome === 'SL' ? -5.0 : 0)
        });
      }
    } catch(e) {}
  }

  console.log('\n=== TỔNG HỢP KẾT QUẢ BACKTEST TỪ 16/08 ĐẾN 20/08 ===');
  console.log('Tổng số lệnh khớp:', results.length);

  function printMode(list, name) {
    const wins = list.filter(r => r.outcome === 'TP').length;
    const bes = list.filter(r => r.outcome === 'BE').length;
    const losses = list.filter(r => r.outcome === 'SL').length;
    const finished = wins + bes + losses;
    const winRate = finished > 0 ? (wins / (wins + losses || 1) * 100).toFixed(1) : '0';
    const noLoss = finished > 0 ? ((wins + bes) / finished * 100).toFixed(1) : '0';
    const pnl = list.reduce((s, r) => s + r.pnl, 0);

    console.log(`\n📌 ${name}:`);
    console.log(`• Tổng lệnh đã khớp:     ${list.length} lệnh (Đã chốt: ${finished})`);
    console.log(`• 🟢 Thắng (TP +5$):       ${wins} (${((wins/finished)*100).toFixed(1)}%)`);
    console.log(`• 🟡 Hòa (BE $0):          ${bes} (${((bes/finished)*100).toFixed(1)}%)`);
    console.log(`• 🔴 Thua (SL -5$):        ${losses} (${((losses/finished)*100).toFixed(1)}%)`);
    console.log(`• 🎯 Win Rate (Thắng/Thua): ${winRate}%`);
    console.log(`• 🛡️ Tỷ lệ Không Lỗ:        ${noLoss}%`);
    console.log(`• 💰 LỢI NHUẬN RÒNG (PnL):  ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`);
  }

  // Chế độ 1: Score >= 4.0 (Hiện tại)
  const mode1 = results.filter(r => r.score >= 4.0);
  printMode(mode1, 'CHẾ ĐỘ 1: Score >= 4.0đ (Hiện tại, Chưa lọc M15 Vol)');

  // Chế độ 2: Score >= 4.0 + M15/H1 Vol < 2.5x
  const mode2 = results.filter(r => r.score >= 4.0 && r.m15VolRatio < 2.5 && r.h1VolRatio < 2.5);
  printMode(mode2, 'CHẾ ĐỘ 2: Score >= 4.0đ + Chặn Volume Đột Biến >= 2.5x');

  // Chế độ 3: Score >= 4.0 + M15 Vol < 3.0x & H1 Vol < 2.5x (Ngưỡng thoáng hơn)
  const mode3 = results.filter(r => r.score >= 4.0 && r.m15VolRatio < 3.0 && r.h1VolRatio < 2.5);
  printMode(mode3, 'CHẾ ĐỘ 3: Score >= 4.0đ + Chặn M15 Siêu Bão Giá >= 3.0x');

  // Chi tiết các lệnh bị loại bỏ ở Chế độ 2
  const blocked = mode1.filter(r => r.m15VolRatio >= 2.5 || r.h1VolRatio >= 2.5);
  console.log('\n========================================================================');
  console.log(`🔍 PHÂN TÍCH ${blocked.length} LỆNH BỊ LOẠI BỎ Ở CHẾ ĐỘ 2 (>= 2.5x):`);
  console.log('========================================================================');
  const winBlocked = blocked.filter(r => r.outcome === 'TP').length;
  const beBlocked = blocked.filter(r => r.outcome === 'BE').length;
  const slBlocked = blocked.filter(r => r.outcome === 'SL').length;
  console.log(`• Trong ${blocked.length} lệnh bị loại:`);
  console.log(`  - Tránh được ${slBlocked} LỆNH THUA (SL -5$) -> Cứu được $${slBlocked * 5} USD!`);
  console.log(`  - Bỏ qua ${beBlocked} Lệnh Hòa (BE $0).`);
  console.log(`  - Bị miss ${winBlocked} Lệnh Thắng (TP +5$).`);
  console.log(`  => Hiệu quả ròng của Bộ lọc: Cứu được ${(slBlocked - winBlocked) * 5}$ USD!`);
}

run().catch(console.error);
