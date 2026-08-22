require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
const BASE = 'https://fapi.binance.com';

function sign(query) {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
}

async function getIncome(startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  
  const params = {
    incomeType: 'REALIZED_PNL',
    startTime,
    endTime,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 60000
  };
  
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  
  const res = await axios.get(`${BASE}/fapi/v1/income?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function getUserTrades(symbol, startTime, endTime) {
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  
  const params = {
    symbol,
    startTime,
    endTime,
    limit: 1000,
    timestamp: serverTime,
    recvWindow: 60000
  };
  
  const qs = new URLSearchParams(params).toString();
  const signature = sign(qs);
  
  const res = await axios.get(`${BASE}/fapi/v1/userTrades?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function analyze() {
  const startTime = new Date('2026-08-21T18:00:00+07:00').getTime();
  const endTime = Date.now();
  
  console.log('='.repeat(80));
  console.log(`🔍 PHÂN TÍCH LỆNH TÀI KHOẢN TỪ ${new Date(startTime).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})} ĐẾN ${new Date(endTime).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})}`);
  console.log('='.repeat(80));
  
  const incomeList = await getIncome(startTime, endTime);
  console.log(`Tổng số bản ghi Realized PnL: ${incomeList.length}`);
  
  // Nhóm theo Trade/Position
  const symbols = [...new Set(incomeList.map(i => i.symbol))];
  
  // Đọc dataset
  const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
  let dataset = [];
  if (fs.existsSync(datasetPath)) {
    dataset = fs.readFileSync(datasetPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
      .filter(Boolean);
  }

  // Đọc pm2 logs nếu có
  const logPath = path.join(process.cwd(), 'logs', 'pm2-out.log');
  let logLines = [];
  if (fs.existsSync(logPath)) {
    logLines = fs.readFileSync(logPath, 'utf8').split('\n');
  }

  let totalPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const sym of symbols) {
    const symIncomes = incomeList.filter(i => i.symbol === sym);
    const symPnl = symIncomes.reduce((acc, i) => acc + parseFloat(i.income), 0);
    totalPnl += symPnl;
    if (symPnl > 0) winCount++;
    else if (symPnl < 0) lossCount++;

    console.log(`\n------------------------------------------------------------`);
    console.log(`📌 Mã: ${sym} | Tổng PnL: ${symPnl >= 0 ? '+' : ''}${symPnl.toFixed(4)} USDT (${symPnl > 0 ? '🟢 THẮNG' : '🔴 LỖ'})`);
    console.log(`------------------------------------------------------------`);

    const trades = await getUserTrades(sym, startTime, endTime);
    for (const t of trades) {
      const tTime = new Date(t.time).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
      console.log(`  • [${tTime}] ${t.side} Qty: ${t.qty} @ $${t.price} | PnL: ${t.realizedPnl} USDT | Fee: ${t.commission} ${t.commissionAsset} (OrderId: ${t.orderId})`);
    }

    // Tìm trong dataset
    const cleanSym = sym.replace('USDT', '');
    const matchedData = dataset.filter(d => (d.symbol === cleanSym || d.symbol === sym) && (d.entryTimestamp >= startTime - 2 * 3600000));
    if (matchedData.length > 0) {
      console.log(`  📊 Dữ liệu tín hiệu & AI ghi nhận:`);
      for (const d of matchedData) {
        const eTime = new Date(d.entryTimestamp).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'});
        const xTime = d.exitTimestamp ? new Date(d.exitTimestamp).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'}) : 'Chưa đóng';
        console.log(`    - Entry: [${eTime}] ${d.signal} @ $${d.entryPrice} | Leverage: ${d.leverage}x | Margin: $${d.margin}`);
        console.log(`    - AI Review: WinProb ${d.winProbability}% | Reasons: ${(d.scoreReasons || []).join(', ')}`);
        console.log(`    - Exit: [${xTime}] Type: ${d.exitType || 'N/A'} @ $${d.exitPrice || 'N/A'} | PnL: ${d.pnlPercent}% ($${d.pnlUsd})`);
      }
    }

    // Tìm trong logs
    const relevantLogs = logLines.filter(l => l.includes(cleanSym) && (l.includes('2026-08-21 18:') || l.includes('2026-08-21 19:') || l.includes('2026-08-21 20:') || l.includes('2026-08-21 21:') || l.includes('2026-08-21 22:') || l.includes('2026-08-21 23:') || l.includes('2026-08-22')));
    if (relevantLogs.length > 0) {
      console.log(`  📜 Log hệ thống liên quan (${relevantLogs.length} dòng):`);
      relevantLogs.slice(-10).forEach(l => console.log(`    ${l.trim()}`));
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`📊 TỔNG KẾT: Thắng: ${winCount} | Thua: ${lossCount} | Tổng Realized PnL: ${totalPnl.toFixed(4)} USDT`);
  console.log('='.repeat(80));
}

analyze().catch(console.error);
