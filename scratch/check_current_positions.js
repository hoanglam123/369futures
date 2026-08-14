const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getOpenPositions() {
  const endpoint = 'https://fapi.binance.com/fapi/v2/positionRisk';
  const timestamp = Date.now();
  const params = { timestamp, recvWindow: 30000 };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data.filter(p => parseFloat(p.positionAmt) !== 0);
}

async function main() {
  const pos = await getOpenPositions();
  console.log(`=== CURRENT OPEN POSITIONS (${pos.length}) ===`);
  for (const p of pos) {
    console.log(`Symbol: ${p.symbol} | Amt: ${p.positionAmt} | Entry: $${p.entryPrice} | Mark: $${p.markPrice} | UnRealized PnL: ${p.unRealizedProfit} USDT | Leverage: ${p.leverage}x`);
  }
}

main();
