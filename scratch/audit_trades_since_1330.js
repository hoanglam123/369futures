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

async function runAudit() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;

  const timeRes = await axios.get(`${BASE}/fapi/v1/time`);
  const serverTime = timeRes.data.serverTime;

  // 13:30:00 21/08/2026
  const startMs = Date.now() - (3.5 * 60 * 60 * 1000); // 3.5 giờ trước (~12:30 -> 16:00)

  const params = {
    incomeType: '',
    startTime: startMs,
    limit: 100,
    timestamp: serverTime,
    recvWindow: 30000
  };

  const queryString = sign(params, secret);
  const res = await axios.get(`${BASE}/fapi/v1/income?${queryString}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const incomeList = res.data || [];

  console.log('='.repeat(80));
  console.log(`🔍 RÀ SOÁT TẤT CẢ GIAO DỊCH VÀ BIẾN ĐỘNG PNL TỪ 13:00 ĐẾN HIỆN TẠI (BINANCE FUTURES)`);
  console.log('='.repeat(80));

  let totalRealizedPnl = 0;
  let totalCommission = 0;
  let totalFunding = 0;
  const coinSummary = {};

  incomeList.forEach(item => {
    const timeStr = new Date(item.time).toLocaleTimeString('vi-VN');
    const sym = item.symbol || 'SYSTEM';
    const amount = parseFloat(item.income);

    if (!coinSummary[sym]) {
      coinSummary[sym] = { realizedPnl: 0, commission: 0, funding: 0, winCount: 0, lossCount: 0, history: [] };
    }

    if (item.incomeType === 'REALIZED_PNL') {
      totalRealizedPnl += amount;
      coinSummary[sym].realizedPnl += amount;
      if (amount > 0) coinSummary[sym].winCount++;
      else if (amount < 0) coinSummary[sym].lossCount++;
      coinSummary[sym].history.push(`[${timeStr}] PnL: ${amount >= 0 ? '+' : ''}${amount.toFixed(4)}$`);
    } else if (item.incomeType === 'COMMISSION') {
      totalCommission += amount;
      coinSummary[sym].commission += amount;
    } else if (item.incomeType === 'FUNDING_FEE') {
      totalFunding += amount;
      coinSummary[sym].funding += amount;
    }
  });

  console.log('\n📋 [CHI TIẾT THEO TỪNG MÃ COIN]:');
  for (const [sym, data] of Object.entries(coinSummary)) {
    const net = data.realizedPnl + data.commission + data.funding;
    console.log(`\n🔹 ${sym}:`);
    console.log(`   • Realized PnL: ${data.realizedPnl >= 0 ? '+' : ''}${data.realizedPnl.toFixed(4)}$ (Thắng: ${data.winCount}, Thua: ${data.lossCount})`);
    console.log(`   • Phí sàn: ${data.commission.toFixed(4)}$ | Funding: ${data.funding.toFixed(4)}$`);
    console.log(`   • NET PnL: ${net >= 0 ? '+' : ''}${net.toFixed(4)}$`);
    if (data.history.length > 0) {
      console.log(`   • Lịch sử chốt: ${data.history.join(' | ')}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 TỔNG KẾT TÀI KHOẢN TỪ 13:00 ĐẾN HIỆN TẠI:');
  console.log(`  • Tổng Gross Realized PnL: ${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(4)} USDT`);
  console.log(`  • Tổng Phí Giao Dịch: ${totalCommission.toFixed(4)} USDT`);
  console.log(`  • Tổng Phí Funding: ${totalFunding.toFixed(4)} USDT`);
  console.log(`  • TỔNG NET PNL THỰC TẾ: ${(totalRealizedPnl + totalCommission + totalFunding).toFixed(4)} USDT`);
  console.log('='.repeat(80));
}

runAudit().catch(err => console.error('Lỗi:', err.response?.data || err.message));
