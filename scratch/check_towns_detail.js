'use strict';

require('dotenv').config();
const { createClient } = require('../src/trader/binance');

async function checkDetailedTowns() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
  const client = createClient(apiKey, secret);
  const sym = 'TOWNS';

  console.log('='.repeat(80));
  console.log(`🔍 CHI TIẾT LỆNH KHỚP CỦA ${sym} TRÊN BINANCE FUTURES:`);
  console.log('='.repeat(80));

  try {
    const userTrades = await client.getUserTrades(sym, 10);
    userTrades.forEach((t, i) => {
      console.log(`[${new Date(t.time).toLocaleTimeString('vi-VN')}] ${t.side} ${t.qty} ${sym} @ $${t.price} (Notional: $${t.quoteQty}) | PnL: ${parseFloat(t.realizedPnl) >= 0 ? '+' : ''}${t.realizedPnl} USDT | Fee: ${t.commission} USDT | Maker: ${t.maker}`);
    });

    const positions = await client.getOpenPositions();
    const townPos = positions.find(p => p.symbol === `${sym}USDT`);
    if (townPos) {
      console.log('\n📋 [VỊ THẾ TOWNS HIỆN TẠI]:');
      console.log(`  • Size: ${townPos.positionAmt} ${sym} | Entry: $${townPos.entryPrice} | Mark: $${townPos.markPrice}`);
      console.log(`  • Leverage: ${townPos.leverage}x | Unrealized PnL: ${townPos.unRealizedProfit} USDT`);
    }
  } catch (err) {
    console.error(`❌ Lỗi kiểm tra: ${err.message}`);
  }
}

checkDetailedTowns();
