'use strict';

require('dotenv').config();
const { createClient } = require('../src/trader/binance');

async function checkCurrentOpenPositions() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
  const client = createClient(apiKey, secret);

  console.log('='.repeat(80));
  console.log('🔍 KIỂM TRA CÁC VỊ THẾ ĐANG CHẠY TRÊN SÀN (OPEN POSITIONS):');
  console.log('='.repeat(80));

  const positions = await client.getOpenPositions();
  if (!positions || positions.length === 0) {
    console.log('Hiện tại không có vị thế nào đang mở.');
    return;
  }

  let totalUnrealized = 0;
  positions.forEach(p => {
    const unPnl = parseFloat(p.unRealizedProfit);
    const notional = Math.abs(parseFloat(p.notional || (p.positionAmt * p.markPrice)));
    totalUnrealized += unPnl;
    console.log(`\n🔹 ${p.symbol} (${parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'}):`);
    console.log(`   • Size: ${p.positionAmt} | Entry: $${p.entryPrice} | Mark: $${p.markPrice}`);
    console.log(`   • Leverage: ${p.leverage}x | Margin: $${(notional / p.leverage).toFixed(2)} | Notional: $${notional.toFixed(2)}`);
    console.log(`   • Unrealized PnL: ${unPnl >= 0 ? '+' : ''}${unPnl.toFixed(4)} USDT`);
  });

  console.log('\n' + '='.repeat(80));
  console.log(`📊 TỔNG UNREALIZED PNL TẤT CẢ VỊ THẾ: ${totalUnrealized.toFixed(4)} USDT`);
  console.log('='.repeat(80));
}

checkCurrentOpenPositions();
