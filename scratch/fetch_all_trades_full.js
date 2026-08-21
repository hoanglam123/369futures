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

async function fetchAllTradesFull() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;

  const timeRes = await axios.get(`${BASE}/fapi/v1/time`);
  const serverTime = timeRes.data.serverTime;

  // Lấy toàn bộ lịch sử từ 00:00 ngày hôm nay 21/08/2026
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  console.log('='.repeat(80));
  console.log(`🔍 TRA CỨU ĐẦY ĐỦ 100% LỊCH SỬ GIAO DỊCH TỪ ĐẦU NGÀY ĐẾN NAY TRÊN BINANCE`);
  console.log(`⏰ Thời gian server: ${new Date(serverTime).toLocaleString('vi-VN')}`);
  console.log('='.repeat(80));

  const params = {
    startTime: startMs,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 30000
  };

  const queryString = sign(params, secret);
  const res = await axios.get(`${BASE}/fapi/v1/income?${queryString}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const incomeList = res.data || [];

  // Lọc riêng từ 13:00
  const after1300 = new Date();
  after1300.setHours(13, 0, 0, 0);
  const ms1300 = after1300.getTime();

  console.log(`\n📋 TỔNG SỐ BẢN GHI DÒNG TIỀN TỪ 00:00: ${incomeList.length}`);

  let totalGross13 = 0;
  let totalComm13 = 0;
  const coinStats = {};

  incomeList.forEach(item => {
    const itemTime = item.time;
    if (itemTime < ms1300) return; // Chỉ lấy từ 13:00

    const timeStr = new Date(itemTime).toLocaleTimeString('vi-VN');
    const sym = item.symbol || 'SYSTEM';
    const amount = parseFloat(item.income);

    if (!coinStats[sym]) {
      coinStats[sym] = { realizedPnl: 0, commission: 0, funding: 0, events: [] };
    }

    if (item.incomeType === 'REALIZED_PNL') {
      totalGross13 += amount;
      coinStats[sym].realizedPnl += amount;
      coinStats[sym].events.push(`[${timeStr}] REALIZED PNL: ${amount >= 0 ? '+' : ''}${amount.toFixed(4)} USDT`);
    } else if (item.incomeType === 'COMMISSION') {
      totalComm13 += amount;
      coinStats[sym].commission += amount;
      coinStats[sym].events.push(`[${timeStr}] FEE: ${amount.toFixed(4)} USDT`);
    } else if (item.incomeType === 'FUNDING_FEE') {
      coinStats[sym].funding += amount;
    }
  });

  console.log('\n📋 [DANH SÁCH CHI TIẾT TỪNG MÃ COIN TỪ 13:00]:');
  for (const [sym, data] of Object.entries(coinStats)) {
    const net = data.realizedPnl + data.commission + data.funding;
    console.log(`\n==================================================`);
    console.log(`📌 MÃ: ${sym}`);
    console.log(`   • Realized PnL: ${data.realizedPnl >= 0 ? '+' : ''}${data.realizedPnl.toFixed(4)} USDT`);
    console.log(`   • Phí giao dịch (Commission): ${data.commission.toFixed(4)} USDT`);
    console.log(`   • NET PNL: ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT`);
    console.log(`   • Các lần khớp lệnh:`);
    data.events.forEach(e => console.log(`      ${e}`));
  }

  console.log('\n' + '='.repeat(80));
  console.log(`📊 TỔNG KẾT TOÀN BỘ TỪ 13:00 ĐẾN HIỆN TẠI:`);
  console.log(`  • Tổng Gross Realized PnL: ${totalGross13 >= 0 ? '+' : ''}${totalGross13.toFixed(4)} USDT`);
  console.log(`  • Tổng Phí Sàn: ${totalComm13.toFixed(4)} USDT`);
  console.log(`  • TỔNG NET PNL TỪ 13:00: ${(totalGross13 + totalComm13).toFixed(4)} USDT`);
  console.log('='.repeat(80));
}

fetchAllTradesFull().catch(err => console.error('Lỗi:', err.response?.data || err.message));
