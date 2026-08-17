const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getAllIncomeHistory(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  let allIncome = [];
  let currentStart = startTime;

  while (true) {
    const timestamp = Date.now();
    const params = {
      startTime: currentStart,
      endTime: endTime,
      limit: 1000,
      timestamp,
      recvWindow: 30000
    };
    const qs = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = res.data;
    if (!data || data.length === 0) break;
    allIncome = allIncome.concat(data);
    if (data.length < 1000) break;
    currentStart = data[data.length - 1].time + 1;
    if (currentStart >= endTime) break;
  }
  return allIncome;
}

async function main() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const startTime = new Date(`${currentYear}-08-14T00:00:00+07:00`).getTime();
  const endTime = Date.now();

  const incomes = await getAllIncomeHistory(startTime, endTime);
  incomes.sort((a, b) => a.time - b.time);

  const days = ['14/08/2026', '15/08/2026', '16/08/2026', '17/08/2026'];
  const dayData = {};
  days.forEach(d => {
    dayData[d] = {
      realizedPnl: 0,
      commission: 0,
      funding: 0,
      rawPnlList: []
    };
  });

  for (const inc of incomes) {
    const d = new Date(inc.time);
    const dayStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    if (!dayData[dayStr]) continue;

    const amt = parseFloat(inc.income);
    if (inc.incomeType === 'REALIZED_PNL') {
      dayData[dayStr].realizedPnl += amt;
      dayData[dayStr].rawPnlList.push({
        time: inc.time,
        symbol: inc.symbol,
        pnl: amt,
        tradeId: inc.tradeId
      });
    } else if (inc.incomeType === 'COMMISSION') {
      dayData[dayStr].commission += amt;
    } else if (inc.incomeType === 'FUNDING_FEE') {
      dayData[dayStr].funding += amt;
    }
  }

  // Print full detail for each day
  for (const day of days) {
    const data = dayData[day];
    const positions = [];
    let currentPos = null;

    for (const item of data.rawPnlList) {
      if (!currentPos || currentPos.symbol !== item.symbol || (item.time - currentPos.lastTime > 60000)) {
        if (currentPos) positions.push(currentPos);
        currentPos = {
          symbol: item.symbol,
          startTime: item.time,
          lastTime: item.time,
          totalPnl: item.pnl,
          fillCount: 1
        };
      } else {
        currentPos.lastTime = item.time;
        currentPos.totalPnl += item.pnl;
        currentPos.fillCount += 1;
      }
    }
    if (currentPos) positions.push(currentPos);

    const winPositions = positions.filter(p => p.totalPnl > 0);
    const lossPositions = positions.filter(p => p.totalPnl < 0);
    const totalPosCount = positions.length;
    const winPosRate = totalPosCount > 0 ? ((winPositions.length / totalPosCount) * 100).toFixed(1) : '0.0';

    console.log(`\n======================================================`);
    console.log(`📅 NGÀY ${day}`);
    console.log(`======================================================`);
    console.log(`• Số vị thế đã đóng: ${totalPosCount} vị thế (${winPositions.length} Thắng, ${lossPositions.length} Thua - Winrate: ${winPosRate}%)`);
    console.log(`• Realized PnL:      ${data.realizedPnl >= 0 ? '+' : ''}${data.realizedPnl.toFixed(4)} USDT`);
    console.log(`• Phí Giao dịch:     ${data.commission.toFixed(4)} USDT`);
    console.log(`• Funding Fee:       ${data.funding >= 0 ? '+' : ''}${data.funding.toFixed(4)} USDT`);
    console.log(`• Net PnL (Thực nhận): ${(data.realizedPnl + data.commission + data.funding).toFixed(4)} USDT`);
    console.log(`\n--- Danh sách các vị thế đóng trong ngày: ---`);
    positions.forEach((p, idx) => {
      const timeStr = new Date(p.startTime).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
      const statusIcon = p.totalPnl >= 0 ? '🟢 THẮNG' : '🔴 THUA';
      console.log(` ${String(idx + 1).padStart(2, '0')}. [${timeStr}] ${statusIcon} | ${p.symbol.padEnd(14)} | PnL: ${(p.totalPnl >= 0 ? '+' : '') + p.totalPnl.toFixed(4)} USDT (${p.fillCount} fills)`);
    });
  }
}

main();
