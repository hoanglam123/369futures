'use strict';

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

async function fetchBinanceRealizedTrades() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;

  if (!apiKey || !secret) {
    console.error('Không tìm thấy BINANCE_API_KEY hoặc BINANCE_SECRET trong .env');
    return;
  }

  // 1. Đồng bộ giờ với Binance
  const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const timeOffset = Math.round(serverTime - Date.now());

  const startMs = new Date('2026-08-17T00:00:00+07:00').getTime();
  const endMs = Date.now();

  console.log(`Đang lấy Realized PnL từ Binance từ: ${new Date(startMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}...`);

  const timestamp = Date.now() + timeOffset;
  const params = new URLSearchParams({
    incomeType: 'REALIZED_PNL',
    startTime: startMs,
    endTime: endMs,
    limit: 1000,
    timestamp,
    recvWindow: 60000
  }).toString();
  const sig = crypto.createHmac('sha256', secret).update(params).digest('hex');

  const res = await axios.get(`https://fapi.binance.com/fapi/v1/income?${params}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const rawIncomes = res.data || [];
  console.log(`Đã lấy được ${rawIncomes.length} bản ghi Realized PnL trên sàn Binance.`);

  // 2. Gộp theo từng vị thế đóng (Symbol + Time trong khoảng 2-3 phút)
  const posMap = {};
  rawIncomes.forEach(item => {
    const sym = item.symbol.replace('USDT', '');
    const t = item.time;
    // Gộp trong vòng 2 phút
    const groupKey = `${sym}_${Math.floor(t / 120000)}`;
    if (!posMap[groupKey]) {
      posMap[groupKey] = {
        symbol: sym,
        exitTime: t,
        exitTimeStr: new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }),
        totalPnl: 0,
        tradeIds: []
      };
    }
    posMap[groupKey].totalPnl += parseFloat(item.income);
    posMap[groupKey].tradeIds.push(item.tradeId);
  });

  const positions = Object.values(posMap).sort((a, b) => a.exitTime - b.exitTime);
  console.log(`\n=== TỔNG CỘNG CÓ ${positions.length} VỊ THẾ ĐÃ ĐÓNG TRÊN BINANCE (TỪ 17/08 ĐẾN NAY) ===\n`);

  // 3. Với từng vị thế: lấy userTrades để biết Entry Time, Entry Price, Side
  const evaluated = [];

  for (const pos of positions) {
    try {
      const uParams = new URLSearchParams({
        symbol: `${pos.symbol}USDT`,
        startTime: pos.exitTime - 24 * 3600 * 1000, // trong vòng 24h trước khi đóng
        endTime: pos.exitTime + 10000,
        limit: 50,
        timestamp: Date.now() + timeOffset,
        recvWindow: 60000
      }).toString();
      const uSig = crypto.createHmac('sha256', secret).update(uParams).digest('hex');
      const uRes = await axios.get(`https://fapi.binance.com/fapi/v1/userTrades?${uParams}&signature=${uSig}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      const trades = uRes.data || [];
      trades.sort((a, b) => a.time - b.time);

      let side = 'UNKNOWN';
      let entryTime = pos.exitTime;
      let entryPrice = 0;

      if (trades.length > 0) {
        const firstTrade = trades[0];
        // Nếu trade đầu tiên là BUY -> Lệnh LONG, nếu trade đầu là SELL -> Lệnh SHORT
        side = firstTrade.side === 'BUY' ? 'LONG' : 'SHORT';
        entryTime = firstTrade.time;
        entryPrice = parseFloat(firstTrade.price);
      }

      // 4. Lấy nến M15 và H1 tại thời điểm Entry Time
      let m15VolRatio = 1.0;
      let m15Range = 0;
      const resM15 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: `${pos.symbol}USDT`, interval: '15m', endTime: entryTime, limit: 22 }
      });
      const kM15 = resM15.data || [];
      if (kM15.length >= 21) {
        const base20 = kM15.slice(0, 20).reduce((s, c) => s + parseFloat(c[5]), 0) / 20;
        const curr = kM15[kM15.length - 1];
        m15VolRatio = base20 > 0 ? (parseFloat(curr[5]) / base20) : 1;
        m15Range = ((parseFloat(curr[2]) - parseFloat(curr[3])) / parseFloat(curr[4])) * 100;
      }

      let h1VolRatio = 1.0;
      const resH1 = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: `${pos.symbol}USDT`, interval: '1h', endTime: entryTime, limit: 28 }
      });
      const kH1 = resH1.data || [];
      if (kH1.length >= 27) {
        const base24 = kH1.slice(0, 24).reduce((s, c) => s + parseFloat(c[5]), 0) / 24;
        const max3 = Math.max(...kH1.slice(-3).map(c => parseFloat(c[5])));
        h1VolRatio = base24 > 0 ? (max3 / base24) : 1;
      }

      const isVolSurge = m15VolRatio >= 2.5 || h1VolRatio >= 2.5;

      evaluated.push({
        symbol: pos.symbol,
        side,
        entryTimeStr: new Date(entryTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }),
        exitTimeStr: pos.exitTimeStr,
        entryPrice,
        pnl: pos.totalPnl,
        pnlStr: (pos.totalPnl >= 0 ? '+' : '') + pos.totalPnl.toFixed(4) + ' $',
        status: pos.totalPnl > 0.5 ? '🟢 TP (Thắng)' : (pos.totalPnl > -0.5 ? '🟡 BE (Hòa)' : '🔴 SL (Thua)'),
        m15Vol: m15VolRatio.toFixed(2) + 'x',
        h1Vol: h1VolRatio.toFixed(2) + 'x',
        filterDecision: isVolSurge ? '🛑 CHẶN (Không vào)' : '✅ HỢP LỆ (Vào lệnh)'
      });
    } catch(err) {
      evaluated.push({
        symbol: pos.symbol,
        side: '?',
        entryTimeStr: '?',
        exitTimeStr: pos.exitTimeStr,
        entryPrice: 0,
        pnl: pos.totalPnl,
        pnlStr: (pos.totalPnl >= 0 ? '+' : '') + pos.totalPnl.toFixed(4) + ' $',
        status: pos.totalPnl > 0.5 ? '🟢 TP' : (pos.totalPnl > -0.5 ? '🟡 BE' : '🔴 SL'),
        m15Vol: '?',
        h1Vol: '?',
        filterDecision: 'Lỗi'
      });
    }
  }

  console.log('=== DANH SÁCH TOÀN BỘ CÁC VỊ THẾ THỰC TẾ TRÊN BINANCE TỪ 17/08 ĐẾN NAY ===');
  console.table(evaluated.map(e => ({
    'Mã': e.symbol,
    'Vị thế': e.side,
    'Thời gian Vào': e.entryTimeStr,
    'Thời gian Đóng': e.exitTimeStr,
    'PnL Thực tế': e.pnlStr,
    'Trạng thái': e.status,
    'Vol M15': e.m15Vol,
    'Vol H1': e.h1Vol,
    'Lọc Volume': e.filterDecision
  })));

  // Thống kê tổng hợp
  const totalActualPnl = evaluated.reduce((s, e) => s + e.pnl, 0);
  const actualWins = evaluated.filter(e => e.status.includes('TP')).length;
  const actualBes = evaluated.filter(e => e.status.includes('BE')).length;
  const actualLosses = evaluated.filter(e => e.status.includes('SL')).length;

  const passedList = evaluated.filter(e => e.filterDecision === '✅ HỢP LỆ (Vào lệnh)');
  const passedPnl = passedList.reduce((s, e) => s + e.pnl, 0);
  const passedWins = passedList.filter(e => e.status.includes('TP')).length;
  const passedBes = passedList.filter(e => e.status.includes('BE')).length;
  const passedLosses = passedList.filter(e => e.status.includes('SL')).length;

  console.log('--------------------------------------------------------------------------------');
  console.log('📊 TỔNG KẾT SO SÁNH TRÊN DỮ LIỆU THỰC BINANCE:');
  console.log('1. THỰC TẾ TRÊN SÀN (Chưa có lọc Volume):');
  console.log(`   • Tổng số vị thế: ${evaluated.length} | Thắng: ${actualWins} | Hòa: ${actualBes} | Thua: ${actualLosses}`);
  console.log(`   • WinRate: ${(actualWins / (actualWins + actualLosses || 1) * 100).toFixed(1)}% | Tỷ lệ không lỗ: ${((actualWins + actualBes) / evaluated.length * 100).toFixed(1)}%`);
  console.log(`   • 💰 TỔNG PNL THỰC TẾ: ${(totalActualPnl >= 0 ? '+' : '') + totalActualPnl.toFixed(4)} USDT`);
  console.log('\n2. NẾU ÁP DỤNG BỘ LỌC VOLUME (Chặn M15 >= 2.5x hoặc H1 >= 2.5x):');
  console.log(`   • Tổng số vị thế: ${passedList.length} | Thắng: ${passedWins} | Hòa: ${passedBes} | Thua: ${passedLosses}`);
  console.log(`   • WinRate: ${(passedWins / (passedWins + passedLosses || 1) * 100).toFixed(1)}% | Tỷ lệ không lỗ: ${((passedWins + passedBes) / passedList.length * 100).toFixed(1)}%`);
  console.log(`   • 💰 TỔNG PNL MỚI: ${(passedPnl >= 0 ? '+' : '') + passedPnl.toFixed(4)} USDT`);
  console.log(`   • 🚀 CHÊNH LỆCH TIẾT KIỆM ĐƯỢC: ${((passedPnl - totalActualPnl) >= 0 ? '+' : '') + (passedPnl - totalActualPnl).toFixed(4)} USDT`);
  console.log('--------------------------------------------------------------------------------');
}

fetchBinanceRealizedTrades().catch(console.error);
