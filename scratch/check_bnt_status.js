'use strict';

require('dotenv').config();
const { createClient } = require('../src/trader/binance');

async function checkBntStatus() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
  const client = createClient(apiKey, secret);
  const sym = 'BNT';

  console.log('='.repeat(80));
  console.log(`🔍 KIỂM TRA TRẠNG THÁI VỊ THẾ VÀ LỆNH CỦA ${sym} TRÊN BINANCE FUTURES:`);
  console.log('='.repeat(80));

  try {
    const positions = await client.getOpenPositions();
    const bntPos = positions.find(p => p.symbol === `${sym}USDT`);
    if (bntPos) {
      console.log('\n📋 [VỊ THẾ BNT HIỆN TẠI]:');
      console.log(`  • Size: ${bntPos.positionAmt} ${sym} | Entry: $${bntPos.entryPrice} | Mark: $${bntPos.markPrice}`);
      console.log(`  • Leverage: ${bntPos.leverage}x | Unrealized PnL: ${bntPos.unRealizedProfit} USDT`);
    } else {
      console.log('  • Không có vị thế mở BNT.');
    }

    const openOrders = await client.getOpenOrders();
    const bntOrders = openOrders.filter(o => o.symbol === `${sym}USDT`);
    console.log(`\n📋 [CÁC LỆNH CHỜ (SL/TP) CỦA ${sym}]:`);
    bntOrders.forEach((o, i) => {
      console.log(`  • [Order #${i + 1}] Type: ${o.type} | Side: ${o.side} | Price: $${o.price} | StopPrice: $${o.stopPrice} | Qty: ${o.origQty}`);
    });

    const userTrades = await client.getUserTrades(sym, 10);
    console.log(`\n📋 [CÁC GIAO DỊCH GẦN NHẤT CỦA ${sym}]:`);
    userTrades.forEach((t, i) => {
      console.log(`  • [${new Date(t.time).toLocaleTimeString('vi-VN')}] Side: ${t.side} | Qty: ${t.qty} @ $${t.price} | PnL: ${t.realizedPnl} USDT | Fee: ${t.commission} USDT | Maker: ${t.maker}`);
    });

  } catch (err) {
    console.error(`❌ Lỗi kiểm tra: ${err.message}`);
  }
}

checkBntStatus();
