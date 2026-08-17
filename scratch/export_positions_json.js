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

  // Group by days
  const days = ['14/08/2026', '15/08/2026', '16/08/2026', '17/08/2026'];
  const dayData = {};
  days.forEach(d => {
    dayData[d] = {
      realizedPnl: 0,
      commission: 0,
      funding: 0,
      positions: [], // clustered positions
      rawPnlList: []
    };
  });

  // Sort income chronologically
  incomes.sort((a, b) => a.time - b.time);

  // Filter and group
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

  // Cluster raw fills into distinct position closes (fills of same symbol within 60s belong to 1 position)
  for (const day of days) {
    const list = dayData[day].rawPnlList;
    const positions = [];
    let currentPos = null;

    for (const item of list) {
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
    dayData[day].positions = positions;
  }

  console.log(JSON.stringify(dayData, null, 2));
}

main();
