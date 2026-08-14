const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getAllIncomeHistory(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  const timestamp = Date.now();
  const params = {
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

// Clean dataset JSONL if needed
function getCleanDataset() {
  const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
  if (!fs.existsSync(datasetPath)) return [];
  const lines = fs.readFileSync(datasetPath, 'utf8').split('\n');
  const valid = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('=') || trimmed.startsWith('>')) continue;
    try {
      valid.push(JSON.parse(trimmed));
    } catch (e) {}
  }
  return valid;
}

async function main() {
  const startYesterday = new Date('2026-08-13T00:00:00+07:00').getTime();
  const endYesterday = new Date('2026-08-13T23:59:59+07:00').getTime();
  const endNow = Date.now();

  const incomes = await getAllIncomeHistory(startYesterday, endNow);
  const dataset = getCleanDataset();

  // Group by date: 13/8 and 14/8
  const report = {
    '13/08/2026': { realizedPnl: 0, commission: 0, funding: 0, winCount: 0, lossCount: 0, winPnl: 0, lossPnl: 0, bySymbol: {} },
    '14/08/2026': { realizedPnl: 0, commission: 0, funding: 0, winCount: 0, lossCount: 0, winPnl: 0, lossPnl: 0, bySymbol: {} }
  };

  for (const inc of incomes) {
    const d = new Date(inc.time);
    const dateKey = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    if (!report[dateKey]) continue;

    const rep = report[dateKey];
    const amt = parseFloat(inc.income);
    const sym = inc.symbol.replace('USDT', '');

    if (inc.incomeType === 'REALIZED_PNL') {
      rep.realizedPnl += amt;
      if (!rep.bySymbol[sym]) rep.bySymbol[sym] = { pnl: 0, wins: 0, losses: 0, orders: [] };
      rep.bySymbol[sym].pnl += amt;
      if (amt > 0) {
        rep.winCount++;
        rep.winPnl += amt;
        rep.bySymbol[sym].wins++;
      } else if (amt < 0) {
        rep.lossCount++;
        rep.lossPnl += amt;
        rep.bySymbol[sym].losses++;
      }
      rep.bySymbol[sym].orders.push({
        time: d.toLocaleTimeString('vi-VN', { hour12: false }),
        pnl: amt,
        tradeId: inc.tradeId
      });
    } else if (inc.incomeType === 'COMMISSION') {
      rep.commission += amt;
    } else if (inc.incomeType === 'FUNDING_FEE') {
      rep.funding += amt;
    }
  }

  for (const [date, rep] of Object.entries(report)) {
    console.log(`\n======================================================`);
    console.log(`📊 BÁO CÁO PNL NGÀY ${date}`);
    console.log(`======================================================`);
    console.log(`• Realized PnL (Lãi/Lỗ ròng): ${rep.realizedPnl.toFixed(2)} USDT`);
    console.log(`• Phí Commission:            ${rep.commission.toFixed(2)} USDT`);
    console.log(`• Funding Fee:               ${rep.funding.toFixed(2)} USDT`);
    console.log(`• Tổng PnL thực tế:          ${(rep.realizedPnl + rep.commission + rep.funding).toFixed(2)} USDT`);
    console.log(`• Thống kê lệnh fill:        ${rep.winCount + rep.lossCount} lệnh (${rep.winCount} Thắng / ${rep.lossCount} Thua)`);
    console.log(`• Tổng Lãi (Gross Win):      +${rep.winPnl.toFixed(2)} USDT`);
    console.log(`• Tổng Lỗ (Gross Loss):     ${rep.lossPnl.toFixed(2)} USDT`);
    
    console.log(`\n--- CHI TIẾT TỪNG COIN NGÀY ${date} ---`);
    const sorted = Object.entries(rep.bySymbol).sort((a, b) => a[1].pnl - b[1].pnl);
    for (const [sym, data] of sorted) {
      const matchDataset = dataset.filter(t => t.symbol === sym && (t.exitTimestamp || t.entryTimestamp) >= startYesterday);
      const metaStr = matchDataset.length > 0 ? `[Score: ${matchDataset[0].score || 'N/A'}, Exit: ${matchDataset[0].exitType || 'N/A'}]` : '';
      console.log(`\n🔸 ${sym.padEnd(10)}: PnL = ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)} USDT | ${metaStr}`);
      // Group orders close in time (same trade execution)
      for (const o of data.orders) {
        console.log(`   ${o.time} -> PnL: ${o.pnl >= 0 ? '+' : ''}${o.pnl.toFixed(4)} USDT`);
      }
    }
  }
}

main();
