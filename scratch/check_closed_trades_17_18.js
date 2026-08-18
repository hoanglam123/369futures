const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
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
    try {
      const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      const data = res.data;
      if (!data || data.length === 0) break;
      allIncome = allIncome.concat(data);
      if (data.length < 1000) break;
      currentStart = data[data.length - 1].time + 1;
      if (currentStart >= endTime) break;
    } catch (e) {
      console.error("Error fetching income:", e.response?.data || e.message);
      break;
    }
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
  try {
    const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    return res.data || [];
  } catch (e) {
    return [];
  }
}

async function main() {
  const start17 = new Date('2026-08-17T00:00:00+07:00').getTime();
  const endNow = Date.now();

  console.log(`=== TRUY VẤN LỊCH SỬ GIAO DỊCH TỪ 17/08 ĐẾN 18/08 ===`);
  console.log(`Thời gian: ${new Date(start17).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})} -> ${new Date(endNow).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})}\n`);

  const incomes = await getAllIncomeHistory(start17, endNow);
  console.log(`Tổng số bản ghi income nhận được: ${incomes.length}`);

  const pnlRecords = incomes.filter(i => i.incomeType === 'REALIZED_PNL');
  const feeRecords = incomes.filter(i => i.incomeType === 'COMMISSION');
  const fundingRecords = incomes.filter(i => i.incomeType === 'FUNDING_FEE');

  console.log(`- REALIZED_PNL records: ${pnlRecords.length}`);
  console.log(`- COMMISSION records: ${feeRecords.length}`);
  console.log(`- FUNDING_FEE records: ${fundingRecords.length}`);

  const totalFee = feeRecords.reduce((s, r) => s + parseFloat(r.income), 0);
  const totalFunding = fundingRecords.reduce((s, r) => s + parseFloat(r.income), 0);

  // Group by closed positions (close event occurs when income has tradeId or time cluster)
  // Let's inspect unique symbols and get their userTrades to match positions
  const symbols = [...new Set(pnlRecords.map(r => r.symbol))];
  console.log(`Số symbols có PnL: ${symbols.length} (${symbols.join(', ')})`);

  let allTrades = [];
  for (const sym of symbols) {
    const trades = await getUserTrades(sym, start17, endNow);
    allTrades = allTrades.concat(trades);
  }

  allTrades.sort((a, b) => a.time - b.time);

  // Group fills into closed positions
  const closedPositions = [];
  const symbolTrackers = {};

  for (const t of allTrades) {
    const sym = t.symbol;
    if (!symbolTrackers[sym]) {
      symbolTrackers[sym] = {
        posAmt: 0,
        fills: [],
        entrySide: null,
      };
    }

    const tracker = symbolTrackers[sym];
    const qty = parseFloat(t.qty);
    const price = parseFloat(t.price);
    const side = t.side; // 'BUY' or 'SELL'
    const realizedPnl = parseFloat(t.realizedPnl || 0);

    const signedQty = (side === 'BUY') ? qty : -qty;
    const prevAmt = tracker.posAmt;
    const newAmt = prevAmt + signedQty;

    tracker.fills.push(t);

    if (prevAmt === 0 && newAmt !== 0) {
      tracker.entrySide = side === 'BUY' ? 'LONG' : 'SHORT';
    }

    // Check if position was closed or reduced to 0
    if ((prevAmt > 0 && newAmt <= 1e-6) || (prevAmt < 0 && newAmt >= -1e-6)) {
      // Position just fully closed
      const closeFills = tracker.fills.filter(f => parseFloat(f.realizedPnl) !== 0);
      const totalPnl = tracker.fills.reduce((s, f) => s + parseFloat(f.realizedPnl || 0), 0);
      const totalCommission = tracker.fills.reduce((s, f) => s + parseFloat(f.commission || 0), 0);

      closedPositions.push({
        symbol: sym,
        side: tracker.entrySide,
        openTime: tracker.fills[0].time,
        closeTime: t.time,
        closePrice: price,
        totalPnl: parseFloat(totalPnl.toFixed(4)),
        totalCommission: parseFloat(totalCommission.toFixed(4)),
        isWin: totalPnl > 0,
        fillCount: tracker.fills.length
      });

      // reset tracker
      tracker.posAmt = 0;
      tracker.fills = [];
      tracker.entrySide = null;
    } else {
      tracker.posAmt = newAmt;
    }
  }

  // Also handle any remaining standalone realized PnL events if not grouped
  console.log(`\n=== DANH SÁCH CÁC VỊ THẾ ĐÃ ĐÓNG (17/08 - 18/08) [${closedPositions.length} VỊ THẾ] ===\n`);

  let totalWinPnl = 0;
  let totalLossPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  closedPositions.forEach((p, idx) => {
    const timeStr = new Date(p.closeTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const pnlStr = p.totalPnl >= 0 ? `+${p.totalPnl.toFixed(2)}` : `${p.totalPnl.toFixed(2)}`;
    const icon = p.isWin ? '🟢 THẮNG' : (p.totalPnl === 0 ? '⚪ HÒA' : '🔴 THUA');
    console.log(`${(idx + 1).toString().padStart(2, ' ')}. [${timeStr}] ${icon} | ${p.symbol.padEnd(12, ' ')} (${(p.side || 'N/A').padEnd(5, ' ')}) | PnL: ${pnlStr.padStart(8, ' ')} USDT | Phí: -${p.totalCommission.toFixed(2)}u`);

    if (p.isWin) {
      totalWinPnl += p.totalPnl;
      winCount++;
    } else {
      totalLossPnl += p.totalPnl;
      lossCount++;
    }
  });

  const netRealizedPnl = totalWinPnl + totalLossPnl;
  const netProfit = netRealizedPnl + totalFee + totalFunding;
  const winRate = closedPositions.length > 0 ? ((winCount / closedPositions.length) * 100).toFixed(1) : 0;

  console.log(`\n========================================================================`);
  console.log(`📊 TỔNG KẾT HIỆU SUẤT GIAO DỊCH (17/08 - 18/08):`);
  console.log(`========================================================================`);
  console.log(`• Tổng số vị thế đóng: ${closedPositions.length}`);
  console.log(`• Thắng: ${winCount} | Thua: ${lossCount} | Tỷ lệ thắng (Win Rate): ${winRate}%`);
  console.log(`• Tổng Lãi (Gross Win):     +${totalWinPnl.toFixed(2)} USDT`);
  console.log(`• Tổng Lỗ (Gross Loss):     ${totalLossPnl.toFixed(2)} USDT`);
  console.log(`• Realized PnL:              ${netRealizedPnl >= 0 ? '+' : ''}${netRealizedPnl.toFixed(2)} USDT`);
  console.log(`• Phí giao dịch (Fee):       ${totalFee.toFixed(2)} USDT`);
  console.log(`• Phí Funding:               ${totalFunding.toFixed(2)} USDT`);
  console.log(`• 🚀 LỢI NHUẬN THỰC NHẬN:    ${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)} USDT`);
}

main().catch(console.error);
