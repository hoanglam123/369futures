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

async function runDetailedLossAnalysis() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;

  const timeRes = await axios.get(`${BASE}/fapi/v1/time`);
  const serverTime = timeRes.data.serverTime;

  // Lọc riêng từ 13:00 21/08
  const after1300 = new Date();
  after1300.setHours(13, 0, 0, 0);
  const ms1300 = after1300.getTime();

  const params = {
    startTime: ms1300,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 30000
  };

  const queryString = sign(params, secret);
  const res = await axios.get(`${BASE}/fapi/v1/income?${queryString}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const incomeList = res.data || [];
  const coinSummary = {};

  incomeList.forEach(item => {
    const sym = item.symbol || 'SYSTEM';
    const amount = parseFloat(item.income);

    if (!coinSummary[sym]) {
      coinSummary[sym] = { realizedPnl: 0, commission: 0, firstTrade: null, lastTrade: null };
    }

    if (item.incomeType === 'REALIZED_PNL') {
      coinSummary[sym].realizedPnl += amount;
      if (!coinSummary[sym].firstTrade) coinSummary[sym].firstTrade = new Date(item.time).toLocaleTimeString('vi-VN');
      coinSummary[sym].lastTrade = new Date(item.time).toLocaleTimeString('vi-VN');
    } else if (item.incomeType === 'COMMISSION') {
      coinSummary[sym].commission += amount;
    }
  });

  console.log('='.repeat(90));
  console.log('📋 BẢNG PHÂN TÍCH TOÀN BỘ CÁC MÃ ĐÃ GIAO DỊCH TỪ 13:00 ĐẾN NAY (SẮP XẾP THEO PNL):');
  console.log('='.repeat(90));

  const sortedCoins = Object.entries(coinSummary).sort((a, b) => (a[1].realizedPnl + a[1].commission) - (b[1].realizedPnl + b[1].commission));

  sortedCoins.forEach(([sym, data]) => {
    const net = data.realizedPnl + data.commission;
    const status = net < -4.0 ? '🔴 DÍNH HARD SL (-5$)' : (net < -0.5 ? '🟠 THUA NHẸ / LỖ' : (net >= 0 ? '🟢 THẮNG' : '🟡 THOÁT HÒA VỐN'));
    console.log(`${status.padEnd(25)} | ${sym.padEnd(14)} | PnL: ${(data.realizedPnl >= 0 ? '+' : '') + data.realizedPnl.toFixed(2).padStart(6)}$ | Fee: ${data.commission.toFixed(2).padStart(6)}$ | Net: ${(net >= 0 ? '+' : '') + net.toFixed(2).padStart(6)}$ | Giờ: ${data.lastTrade || 'N/A'}`);
  });
}

runDetailedLossAnalysis();
