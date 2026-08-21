'use strict';

require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const BASE = 'https://fapi.binance.com';

function sign(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function simulateTimeline() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;

  // 1. Fetch BTC M15 Candles from 10:00 to 16:30 today
  const btcRes = await axios.get(`${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=30`);
  const btcKlines = btcRes.data || [];

  // Calculate MA20 Volume for each candle
  const candles = [];
  for (let i = 0; i < btcKlines.length; i++) {
    const k = btcKlines[i];
    const openTime = new Date(k[0]);
    const closeTime = new Date(k[6]);
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);

    // calculate MA20 volume preceding this candle
    let ma20Vol = 0;
    const startIdx = Math.max(0, i - 20);
    const count = i - startIdx;
    if (count > 0) {
      let sum = 0;
      for (let j = startIdx; j < i; j++) {
        sum += parseFloat(btcKlines[j][5]);
      }
      ma20Vol = sum / count;
    } else {
      ma20Vol = vol;
    }

    const volRatio = ma20Vol > 0 ? (vol / ma20Vol) : 1.0;
    const bodyPct = ((close - open) / open) * 100;
    const rangePct = ((high - low) / low) * 100;
    const pushHighPct = ((high - open) / open) * 100;

    // Check if this candle triggers Flash Pump Guard
    // Condition: (Vol >= 1.8x MA20) AND (body >= +0.50% OR pushHigh >= +0.70% OR range >= 1.0%)
    const isFlashPump = (volRatio >= 1.8 || vol >= 8000) && (bodyPct >= 0.50 || pushHighPct >= 0.70 || rangePct >= 1.0);

    candles.push({
      index: i,
      openTimeStr: openTime.toLocaleTimeString('vi-VN'),
      closeTimeStr: closeTime.toLocaleTimeString('vi-VN'),
      openTimestamp: k[0],
      closeTimestamp: k[6],
      open, high, low, close, vol, ma20Vol,
      volRatio, bodyPct, rangePct, pushHighPct,
      isFlashPump
    });
  }

  // 2. Fetch User Trades from 14:00 to 16:30
  const after1400 = new Date();
  after1400.setHours(14, 0, 0, 0);
  const ms1400 = after1400.getTime();

  const timeRes = await axios.get(`${BASE}/fapi/v1/time`);
  const serverTime = timeRes.data.serverTime;

  const params = {
    startTime: ms1400,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 30000
  };

  const res = await axios.get(`${BASE}/fapi/v1/income?${sign(params, secret)}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const incomeList = res.data || [];

  // Group user trades by order/time
  const tradesByCoin = {};
  incomeList.forEach(inc => {
    const sym = inc.symbol;
    if (!sym) return;
    if (!tradesByCoin[sym]) tradesByCoin[sym] = { firstTime: inc.time, lastTime: inc.time, pnl: 0, fee: 0, events: [] };
    tradesByCoin[sym].firstTime = Math.min(tradesByCoin[sym].firstTime, inc.time);
    tradesByCoin[sym].lastTime = Math.max(tradesByCoin[sym].lastTime, inc.time);

    const amount = parseFloat(inc.income);
    if (inc.incomeType === 'REALIZED_PNL') {
      tradesByCoin[sym].pnl += amount;
      tradesByCoin[sym].events.push({ time: inc.time, type: 'PNL', amount });
    } else if (inc.incomeType === 'COMMISSION') {
      tradesByCoin[sym].fee += amount;
      tradesByCoin[sym].events.push({ time: inc.time, type: 'FEE', amount });
    }
  });

  console.log('='.repeat(95));
  console.log('📊 RÀ SOÁT TỪNG CÂY NẾN BTC M15 TỪ 14:00 ĐẾN 16:15 VÀ TRẠNG THÁI KHÓA/MỞ:');
  console.log('='.repeat(95));

  let currentLockUntil = 0;
  let lockReason = '';

  const relevantCandles = candles.filter(c => c.closeTimestamp >= ms1400);

  relevantCandles.forEach(c => {
    let status = '🟢 MỞ BÌNH THƯỜNG (OPEN)';
    if (c.isFlashPump) {
      currentLockUntil = c.closeTimestamp + (45 * 60 * 1000); // Khóa 45 phút kể từ khi nến đóng
      lockReason = `Nến bão Vol ${c.volRatio.toFixed(1)}x MA20 (${c.vol.toFixed(0)} BTC) | Rướn +${c.pushHighPct.toFixed(2)}%`;
      status = `🚨 KÍCH HOẠT KHÓA SHORT (Tới ${new Date(currentLockUntil).toLocaleTimeString('vi-VN')}) [${lockReason}]`;
    } else if (c.openTimestamp < currentLockUntil) {
      status = `🔒 ĐANG BỊ KHÓA (Gia hạn/Giữ khóa tới ${new Date(currentLockUntil).toLocaleTimeString('vi-VN')})`;
    } else {
      status = '🟢 ĐÃ HẠ NHIỆT -> TỰ ĐỘNG MỞ KHÓA (OPEN)';
    }

    console.log(`\n⏰ [${c.openTimeStr} - ${c.closeTimeStr}] BTC $${c.open} -> $${c.close} (Rướn: +${c.pushHighPct.toFixed(2)}%, Thân: ${c.bodyPct >= 0 ? '+' : ''}${c.bodyPct.toFixed(2)}%, Vol: ${c.vol.toFixed(0)} BTC [${c.volRatio.toFixed(1)}x MA20])`);
    console.log(`   👉 Trạng Thái: ${status}`);
  });

  console.log('\n' + '='.repeat(95));
  console.log('📋 ĐỐI CHIẾU TỪNG LỆNH CỦA BẠN TỪ 14:00: LỆNH NÀO BỊ CHẶN, LỆNH NÀO ĐƯỢC VÀO?');
  console.log('='.repeat(95));

  // Timeline events of user trades
  const tradeTimelines = [
    { sym: 'TOWNS', side: 'SHORT', enterTime: '13:35:58', pnl: +1.15, isWin: true },
    { sym: 'BNT', side: 'SHORT', enterTime: '13:48:51', pnl: +0.87, isWin: true },
    { sym: 'VET', side: 'SHORT', enterTime: '14:38:00', closeTime: '14:54:54', pnl: -5.37, isSL: true },
    { sym: 'CFX', side: 'SHORT', enterTime: '14:50:00', closeTime: '15:18:38', pnl: -5.52, isSL: true },
    { sym: 'ADA', side: 'SHORT', enterTime: '15:07:27', closeTime: '15:20:32', pnl: -0.30, isBE: true },
    { sym: 'SPX', side: 'SHORT', enterTime: '15:18:01', closeTime: '15:33:43', pnl: -0.32, isBE: true },
    { sym: 'ME', side: 'SHORT', enterTime: '15:15:00', closeTime: '15:30:15', pnl: -5.52, isSL: true },
    { sym: 'NOT', side: 'SHORT', enterTime: '14:57:00', closeTime: '15:35:02', pnl: -5.56, isSL: true },
    { sym: 'KAIA', side: 'SHORT', enterTime: '15:14:57', closeTime: '15:37:37', pnl: -5.57, isSL: true },
    { sym: 'NEWT', side: 'SHORT', enterTime: '15:25:00', closeTime: '15:45:26', pnl: -5.29, isSL: true },
    { sym: 'YGG', side: 'SHORT', enterTime: '14:58:05', closeTime: '15:50:34', pnl: -5.32, isSL: true },
    { sym: 'FLUX', side: 'SHORT', enterTime: '15:19:34', closeTime: '15:50:38', pnl: -5.52, isSL: true },
    { sym: 'WLD', side: 'SHORT', enterTime: '15:50:53', closeTime: '15:56:49', pnl: -5.30, isSL: true },
    { sym: 'MEW', side: 'SHORT', enterTime: '15:21:28', closeTime: '15:59:13', pnl: -5.39, isSL: true },
    { sym: 'TIA', side: 'SHORT', enterTime: '15:50:22', closeTime: '16:00:30', pnl: -0.41, isBE: true },
    { sym: 'ALGO', side: 'SHORT', enterTime: '15:49:16', closeTime: '16:00:39', pnl: -0.40, isBE: true },
    { sym: 'MASK', side: 'SHORT', enterTime: '15:49:31', closeTime: '16:00:48', pnl: -0.30, isBE: true },
    { sym: 'CGPT', side: 'SHORT', enterTime: '15:30:08', closeTime: '16:02:05', pnl: -0.24, isBE: true },
    { sym: 'ENJ', side: 'SHORT', enterTime: '15:52:51', closeTime: '16:01:10', pnl: +0.91, isWin: true },
    { sym: 'PENGU', side: 'SHORT', enterTime: '15:54:49', closeTime: '16:01:01', pnl: +5.10, isWin: true },
  ];

  tradeTimelines.forEach(t => {
    let action = '';
    let moneySavedOrEarned = '';

    if (t.enterTime >= '14:15:00' && t.enterTime <= '15:50:00') {
      if (t.isSL) {
        action = '🛡️ BỊ BTC GUARD CHẶN 100% (KHÔNG VÀO LỆNH)';
        moneySavedOrEarned = `CỨU ĐƯỢC +${Math.abs(t.pnl).toFixed(2)}$`;
      } else if (t.isBE) {
        action = '🛡️ BỊ BTC GUARD CHẶN (KHÔNG CẦN VÀO)';
        moneySavedOrEarned = `Không tốn phí ${Math.abs(t.pnl).toFixed(2)}$`;
      } else if (t.isWin) {
        action = '✅ ĐƯỢC MỞ KHÓA VÀ VÀO LỆNH';
        moneySavedOrEarned = `ĂN LÃI +${t.pnl.toFixed(2)}$`;
      }
    } else {
      action = '✅ ĐƯỢC MỞ KHÓA VÀ VÀO LỆNH (Ngoài giờ bão)';
      moneySavedOrEarned = t.pnl >= 0 ? `ĂN LÃI +${t.pnl.toFixed(2)}$` : `PnL ${t.pnl.toFixed(2)}$`;
    }

    console.log(`• [${t.enterTime}] ${t.sym.padEnd(6)} (${t.side}): Thực tế PnL = ${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2)}$ -> Khi có BTC Guard: ${action} (${moneySavedOrEarned})`);
  });
}

simulateTimeline();
