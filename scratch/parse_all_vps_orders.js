const fs = require('fs');
const readline = require('readline');

async function getAllOrdersFromLog() {
  const rl = readline.createInterface({ input: fs.createReadStream('./logs/pm2-out.log'), crlfDelay: Infinity });
  const orders = [];
  let currentScore = {};

  for await (const line of rl) {
    const mScore = line.match(/\[AutoTrade\] ([A-Z0-9]+) → (LONG|SHORT) \(Score: \+([0-9.]+)đ\)/);
    if (mScore) {
      currentScore[mScore[1]] = parseFloat(mScore[3]);
    }

    const mOrder = line.match(/([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}): \[PP369\] \[AutoTrade\] ✓ ([A-Z0-9]+) (BUY|SELL) ([0-9.]+) @ \$([0-9.]+) orderId=([0-9]+)/);
    if (mOrder) {
      const timeStr = mOrder[1];
      const sym = mOrder[2];
      const side = mOrder[3];
      const qty = parseFloat(mOrder[4]);
      const price = parseFloat(mOrder[5]);
      const orderId = mOrder[6];
      const score = currentScore[sym] || null;
      
      const d = new Date(timeStr);
      if (d >= new Date('2026-08-16T00:00:00')) {
        orders.push({ time: timeStr, sym, side, price, qty, score, orderId });
      }
    }
  }

  console.log('=== TẤT CẢ CÁC LỆNH ĐẶT LIMIT TRÊN VPS TỪ 16/08 ĐẾN NAY ===');
  console.table(orders);
}
getAllOrdersFromLog().catch(console.error);
