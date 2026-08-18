const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getAccountInfo() {
  const endpoint = 'https://fapi.binance.com/fapi/v2/account';
  const timestamp = Date.now();
  const params = { timestamp, recvWindow: 30000 };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function getOpenOrders() {
  const endpoint = 'https://fapi.binance.com/fapi/v1/openOrders';
  const timestamp = Date.now();
  const params = { timestamp, recvWindow: 30000 };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

async function main() {
  console.log("=== KIỂM TRA TRẠNG THÁI TÀI KHOẢN VÀ VỊ THẾ ĐANG MỞ HIỆN TẠI ===");
  const acc = await getAccountInfo();
  console.log(`• Tổng số dư (Total Wallet Balance): ${parseFloat(acc.totalWalletBalance).toFixed(2)} USDT`);
  console.log(`• Số dư khả dụng (Available Balance): ${parseFloat(acc.availableBalance).toFixed(2)} USDT`);
  console.log(`• Tổng PnL chưa chốt (Unrealized PnL): ${parseFloat(acc.totalUnrealizedProfit).toFixed(2)} USDT`);

  const activePositions = acc.positions.filter(p => parseFloat(p.positionAmt) !== 0);
  console.log(`\n• Số vị thế ĐANG MỞ: ${activePositions.length}`);
  activePositions.forEach((p, idx) => {
    const amt = parseFloat(p.positionAmt);
    const entry = parseFloat(p.entryPrice);
    const mark = parseFloat(p.markPrice || '0');
    const uPnl = parseFloat(p.unrealizedProfit);
    const notional = Math.abs(parseFloat(p.notional));
    const side = amt > 0 ? 'LONG' : 'SHORT';
    console.log(`  ${idx + 1}. [${p.symbol}] ${side} | Qty: ${Math.abs(amt)} | Entry: $${entry} | Mark: $${mark} | Notional: $${notional.toFixed(1)} | PnL: ${uPnl >= 0 ? '+' : ''}${uPnl.toFixed(2)} USDT`);
  });

  const orders = await getOpenOrders();
  console.log(`\n• Tổng số lệnh chờ (Open Orders): ${orders.length}`);
  const limitOrders = orders.filter(o => o.type === 'LIMIT');
  const slOrders = orders.filter(o => o.type === 'STOP_MARKET' || o.type === 'STOP');
  const tpOrders = orders.filter(o => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');

  console.log(`  - Lệnh LIMIT chờ khớp: ${limitOrders.length} (${limitOrders.map(o => o.symbol + ' ' + o.side).join(', ')})`);
  console.log(`  - Lệnh SL bảo vệ: ${slOrders.length}`);
  console.log(`  - Lệnh TP mục tiêu: ${tpOrders.length}`);
}

main().catch(console.error);
