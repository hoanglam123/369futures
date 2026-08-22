require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Đọc dữ liệu Market Cap hiện tại từ market_cap_top.json
const mcFilePath = path.join(process.cwd(), 'data', 'market_cap_top.json');
let mcData = { marketCapMap: {}, rankMap: {} };
if (fs.existsSync(mcFilePath)) {
  try {
    mcData = JSON.parse(fs.readFileSync(mcFilePath, 'utf8'));
  } catch(_) {}
}

const tradesHistory = [
  { symbol: 'RVN', side: 'SHORT', pnlOld: -9.5354, isWin: false, reason: 'Quét râu SL Low-Cap' },
  { symbol: 'ENS', side: 'SHORT', pnlOld: -6.8081, isWin: false, reason: 'BTC pump đâm cản' },
  { symbol: 'KAIA', side: 'SHORT', pnlOld: -5.4523, isWin: false, reason: 'Low-Cap bão vol' },
  { symbol: 'VET', side: 'SHORT', pnlOld: -5.0417, isWin: false, reason: 'BTC pump đâm cản' },
  { symbol: 'RONIN', side: 'SHORT', pnlOld: -4.9186, isWin: false, reason: 'BTC pump đâm cản' },
  { symbol: 'HYPER', side: 'SHORT', pnlOld: -2.9701, isWin: false, reason: 'Cắn SL' },
  { symbol: 'A', side: 'SHORT', pnlOld: -0.6195, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: 'XVS', side: 'SHORT', pnlOld: -0.2475, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: '1000FLOKI', side: 'SHORT', pnlOld: -0.2083, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: 'INJ', side: 'SHORT', pnlOld: -0.1966, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: 'MEW', side: 'SHORT', pnlOld: -0.0958, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: 'ICP', side: 'SHORT', pnlOld: -0.0980, isWin: false, reason: 'Dời TP hòa vốn' },
  { symbol: 'SKYAI', side: 'LONG', pnlOld: 5.1109, isWin: true, reason: 'TP 1:1.5' },
  { symbol: 'C', side: 'SHORT', pnlOld: 3.0286, isWin: true, reason: 'TP 1:1.5' },
  { symbol: 'DOLO', side: 'SHORT', pnlOld: 1.3662, isWin: true, reason: 'Trailing SL' },
  { symbol: 'WIF', side: 'SHORT', pnlOld: 1.2818, isWin: true, reason: 'Trailing SL' },
  { symbol: 'FARTCOIN', side: 'SHORT', pnlOld: 1.2502, isWin: true, reason: 'Trailing SL' },
  { symbol: 'STX', side: 'SHORT', pnlOld: 1.1002, isWin: true, reason: 'Trailing SL' },
  { symbol: 'SNX', side: 'SHORT', pnlOld: 1.0146, isWin: true, reason: 'Trailing SL' },
  { symbol: '1000PEPE', side: 'SHORT', pnlOld: 0.5436, isWin: true, reason: 'Virtual TP' },
  { symbol: 'ATH', side: 'SHORT', pnlOld: 0.3372, isWin: true, reason: 'Trailing SL' },
  { symbol: '1000LUNC', side: 'LONG', pnlOld: 0.0340, isWin: true, reason: 'Hòa vốn' },
  { symbol: 'WAXP', side: 'SHORT', pnlOld: 0.0101, isWin: true, reason: 'Hòa vốn' },
];

async function runSimulation() {
  console.log('='.repeat(80));
  console.log('🧪 BACKTEST MÔ PHỎNG: ÁP DỤNG ABNORMAL TURNOVER GUARD & SL $3.0 VÀO 23 LỆNH HÔM QUA');
  console.log('='.repeat(80));

  // Lấy Volume 24H từ Binance
  const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const volMap = {};
  res.data.forEach(item => {
    const sym = item.symbol.replace(/USDT$/, '');
    volMap[sym] = parseFloat(item.quoteVolume || '0');
  });

  let oldTotalPnl = 0;
  let newTotalPnl = 0;
  let blockedCount = 0;
  let executedCount = 0;
  let savedLossUsd = 0;

  console.log('\nChi tiết từng lệnh:');
  console.log('-'.repeat(80));

  for (const t of tradesHistory) {
    const cleanSym = t.symbol.replace(/^1000/, '').toUpperCase();
    const mc = mcData.marketCapMap[cleanSym] || mcData.marketCapMap[t.symbol] || null;
    const rank = mcData.rankMap[cleanSym] || mcData.rankMap[t.symbol] || 999;
    const vol = volMap[t.symbol] || volMap[cleanSym] || 0;

    const isLowCap = (mc !== null && mc < 100e6) || (mc === null && rank > 150);
    const effectiveMC = mc || (rank > 300 ? 40e6 : 70e6);
    const turnoverRatio = effectiveMC > 0 ? (vol / effectiveMC * 100) : 0;
    const isBlockedByTurnover = isLowCap && (turnoverRatio > 8.0);

    oldTotalPnl += t.pnlOld;

    let newPnl = t.pnlOld;
    let status = '';

    if (isBlockedByTurnover) {
      blockedCount++;
      newPnl = 0; // Lệnh bị chặn không vào -> PnL = 0
      status = `🛑 BỊ CHẶN BỞI TURNOVER GUARD (Turnover ${turnoverRatio.toFixed(1)}% > 8% | MC $${(effectiveMC/1e6).toFixed(1)}M)`;
      if (t.pnlOld < 0) {
        savedLossUsd += Math.abs(t.pnlOld);
      }
    } else {
      executedCount++;
      // Nếu là lệnh SL đầy đủ cũ (lỗ > 3.3$), với cơ chế mới SL $3.0 + Hard Cap $3.3 -> Lỗ tối đa chỉ là -3.3$
      if (t.pnlOld < -3.3) {
        newPnl = -3.30;
        status = `✅ ĐƯỢC VÀO LỆNH (Khống chế SL mới: -$3.30 thay vì $${t.pnlOld.toFixed(2)})`;
      } else {
        status = `✅ ĐƯỢC VÀO LỆNH (${t.isWin ? '🟢 Thắng' : '🟡 Hòa vốn'} $${newPnl >= 0 ? '+' : ''}${newPnl.toFixed(2)})`;
      }
      newTotalPnl += newPnl;
    }

    const mcStr = mc ? `$${(mc/1e6).toFixed(1)}M` : (rank > 150 ? `<$70M (R#${rank})` : 'TopCap');
    const volStr = `$${(vol/1e6).toFixed(2)}M`;
    console.log(`${t.symbol.padEnd(10)} | Old PnL: ${t.pnlOld >= 0 ? '+' : ''}${t.pnlOld.toFixed(2).padEnd(6)} | New PnL: ${newPnl >= 0 ? '+' : ''}${newPnl.toFixed(2).padEnd(6)} | MC: ${mcStr.padEnd(10)} | Vol: ${volStr.padEnd(8)} | ${status}`);
  }

  console.log('='.repeat(80));
  console.log('📊 KẾT QUẢ SO SÁNH TRƯỚC VÀ SAU KHI ÁP DỤNG:');
  console.log(`• Tổng PnL CŨ (Chưa có Turnover Guard & SL $5): ${oldTotalPnl.toFixed(4)} USDT`);
  console.log(`• Tổng PnL MỚI (Có Turnover Guard & SL $3):     ${newTotalPnl.toFixed(4)} USDT`);
  console.log(`• Số tiền THUA LỖ ĐÃ TIẾT KIỆM ĐƯỢC:           +${(newTotalPnl - oldTotalPnl).toFixed(4)} USDT (${(((newTotalPnl - oldTotalPnl) / Math.abs(oldTotalPnl)) * 100).toFixed(1)}% cải thiện!)`);
  console.log(`• Số lệnh rủi ro cao đã loại bỏ:               ${blockedCount} lệnh (tránh mất ${savedLossUsd.toFixed(2)} USDT)`);
  console.log('='.repeat(80));
}

runSimulation().catch(console.error);
