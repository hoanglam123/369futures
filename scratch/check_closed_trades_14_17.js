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

async function getUserTrades(symbol, startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/userTrades';
  const timestamp = Date.now();
  const params = {
    symbol,
    startTime,
    endTime,
    limit: 1000,
    timestamp,
    recvWindow: 30000
  };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function main() {
  // Let's determine time range for 14/08 to 17/08
  // Current time
  const now = new Date();
  console.log("Current System Date:", now.toISOString(), "Local:", now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }));
  
  // Try with current year
  const currentYear = now.getFullYear();
  const startTime = new Date(`${currentYear}-08-14T00:00:00+07:00`).getTime();
  const endTime = Date.now();

  console.log(`Querying from ${new Date(startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} to ${new Date(endTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}...`);

  try {
    const incomes = await getAllIncomeHistory(startTime, endTime);
    console.log(`Fetched ${incomes.length} income records.`);

    // Filter REALIZED_PNL
    const pnlRecords = incomes.filter(i => i.incomeType === 'REALIZED_PNL');
    const feeRecords = incomes.filter(i => i.incomeType === 'COMMISSION');
    const fundingRecords = incomes.filter(i => i.incomeType === 'FUNDING_FEE');

    console.log(`Found ${pnlRecords.length} REALIZED_PNL records, ${feeRecords.length} commission records, ${fundingRecords.length} funding records.`);

    // Group by Day and Position/Symbol
    const byDay = {};

    for (const inc of pnlRecords) {
      const d = new Date(inc.time);
      const dayStr = d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      const timeStr = d.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
      const amt = parseFloat(inc.income);

      if (!byDay[dayStr]) {
        byDay[dayStr] = {
          totalRealizedPnl: 0,
          totalCommission: 0,
          totalFunding: 0,
          trades: []
        };
      }
      byDay[dayStr].totalRealizedPnl += amt;
      byDay[dayStr].trades.push({
        time: timeStr,
        timestamp: inc.time,
        symbol: inc.symbol,
        pnl: amt,
        tradeId: inc.tradeId,
        tranId: inc.tranId
      });
    }

    // Add fees
    for (const fee of feeRecords) {
      const d = new Date(fee.time);
      const dayStr = d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      if (byDay[dayStr]) {
        byDay[dayStr].totalCommission += parseFloat(fee.income);
      }
    }
    for (const fund of fundingRecords) {
      const d = new Date(fund.time);
      const dayStr = d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      if (byDay[dayStr]) {
        byDay[dayStr].totalFunding += parseFloat(fund.income);
      }
    }

    let grandTotalPnl = 0;
    let grandTotalComm = 0;
    let grandTotalFunding = 0;
    let grandWinCount = 0;
    let grandLossCount = 0;

    for (const [day, data] of Object.entries(byDay)) {
      console.log(`\n===============================================================`);
      console.log(`📅 NGÀY: ${day}`);
      console.log(`===============================================================`);
      
      // Group trades that happen close to each other for the same symbol
      const symbolMap = {};
      for (const t of data.trades) {
        if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { pnl: 0, count: 0, list: [] };
        symbolMap[t.symbol].pnl += t.pnl;
        symbolMap[t.symbol].count++;
        symbolMap[t.symbol].list.push(t);
        if (t.pnl > 0) grandWinCount++;
        else if (t.pnl < 0) grandLossCount++;
      }

      console.log(`Tổng Realized PnL: ${data.totalRealizedPnl.toFixed(4)} USDT`);
      console.log(`Phí giao dịch:     ${data.totalCommission.toFixed(4)} USDT`);
      console.log(`Funding fee:       ${data.totalFunding.toFixed(4)} USDT`);
      console.log(`Lợi nhuận ròng:    ${(data.totalRealizedPnl + data.totalCommission + data.totalFunding).toFixed(4)} USDT`);
      console.log(`Số lượt đóng vị thế: ${data.trades.length}`);
      console.log(`---------------------------------------------------------------`);
      console.log(`Chi tiết theo từng cặp coin:`);

      const sortedSymbols = Object.entries(symbolMap).sort((a, b) => b[1].pnl - a[1].pnl);
      for (const [sym, sData] of sortedSymbols) {
        const status = sData.pnl >= 0 ? '🟢 THẮNG' : '🔴 THUA';
        console.log(`  ${status} | ${sym.padEnd(14)} | Tổng PnL: ${(sData.pnl >= 0 ? '+' : '') + sData.pnl.toFixed(4)} USDT (${sData.count} lần khớp)`);
        for (const item of sData.list) {
          console.log(`      ⏰ ${item.time} | PnL: ${(item.pnl >= 0 ? '+' : '') + item.pnl.toFixed(4)} USDT | TradeId: ${item.tradeId || item.tranId}`);
        }
      }

      grandTotalPnl += data.totalRealizedPnl;
      grandTotalComm += data.totalCommission;
      grandTotalFunding += data.totalFunding;
    }

    console.log(`\n===============================================================`);
    console.log(`🏆 TỔNG KẾT TỪ 14/08 ĐẾN 17/08`);
    console.log(`===============================================================`);
    console.log(`• Tổng Realized PnL:   ${grandTotalPnl >= 0 ? '+' : ''}${grandTotalPnl.toFixed(4)} USDT`);
    console.log(`• Tổng Commission:     ${grandTotalComm.toFixed(4)} USDT`);
    console.log(`• Tổng Funding Fee:    ${grandTotalFunding.toFixed(4)} USDT`);
    console.log(`• Net PnL (Thực nhận): ${(grandTotalPnl + grandTotalComm + grandTotalFunding).toFixed(4)} USDT`);
    console.log(`• Tổng số lệnh chốt:   ${grandWinCount + grandLossCount} (Thắng: ${grandWinCount}, Thua: ${grandLossCount})`);
    if (grandWinCount + grandLossCount > 0) {
      console.log(`• Win Rate:            ${((grandWinCount / (grandWinCount + grandLossCount)) * 100).toFixed(2)}%`);
    }

  } catch (err) {
    console.error("Error fetching data:", err.response?.data || err.message);
  }
}

main();
