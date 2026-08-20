'use strict';

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

async function backtestPartialTp() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;

  const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
  const timeOffset = Math.round(timeRes.data.serverTime - Date.now());

  const startMs = new Date('2026-08-17T00:00:00+07:00').getTime();
  const endMs = Date.now();

  const timestamp = Date.now() + timeOffset;
  const params = new URLSearchParams({
    incomeType: 'REALIZED_PNL',
    startTime: startMs,
    endTime: endMs,
    limit: 1000,
    timestamp,
    recvWindow: 60000
  }).toString();
  const sig = crypto.createHmac('sha256', secret).update(params).digest('hex');
  const res = await axios.get(`https://fapi.binance.com/fapi/v1/income?${params}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const rawIncomes = res.data || [];
  const posMap = {};
  rawIncomes.forEach(item => {
    const sym = item.symbol.replace('USDT', '');
    const t = item.time;
    const groupKey = `${sym}_${Math.floor(t / 120000)}`;
    if (!posMap[groupKey]) {
      posMap[groupKey] = {
        symbol: sym,
        exitTime: t,
        exitTimeStr: new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }),
        actualPnl: 0,
      };
    }
    posMap[groupKey].actualPnl += parseFloat(item.income);
  });

  const positions = Object.values(posMap).sort((a, b) => a.exitTime - b.exitTime);
  console.log(`Đã nạp ${positions.length} vị thế thực tế trên Binance từ 17/08.`);

  const comparison = [];

  for (const pos of positions) {
    try {
      const uParams = new URLSearchParams({
        symbol: `${pos.symbol}USDT`,
        startTime: pos.exitTime - 24 * 3600 * 1000,
        endTime: pos.exitTime + 10000,
        limit: 50,
        timestamp: Date.now() + timeOffset,
        recvWindow: 60000
      }).toString();
      const uSig = crypto.createHmac('sha256', secret).update(uParams).digest('hex');
      const uRes = await axios.get(`https://fapi.binance.com/fapi/v1/userTrades?${uParams}&signature=${uSig}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      });
      const trades = (uRes.data || []).sort((a, b) => a.time - b.time);
      if (trades.length === 0) continue;

      const firstTrade = trades[0];
      const isLong = firstTrade.side === 'BUY';
      const entryPrice = parseFloat(firstTrade.price);
      const entryTime = firstTrade.time;
      const exitTime = pos.exitTime;

      // Ước tính cự ly TP 1:1 (~1.0% hoặc tương đương $5 USD trên $50 notional/margin)
      const targetTpDist = entryPrice * 0.010; // 1.0%
      const halfTpDist = targetTpDist * 0.50; // 50% TP
      const targetSlDist = entryPrice * 0.010; // 1.0%

      const halfTpPrice = isLong ? entryPrice + halfTpDist : entryPrice - halfTpDist;
      const fullTpPrice = isLong ? entryPrice + targetTpDist : entryPrice - targetTpDist;
      const fullSlPrice = isLong ? entryPrice - targetSlDist : entryPrice + targetSlDist;

      // Lấy nến 1m từ entryTime đến exitTime + 10p
      const kRes = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: {
          symbol: `${pos.symbol}USDT`,
          interval: '1m',
          startTime: entryTime,
          endTime: exitTime + 30 * 60 * 1000,
          limit: 1000
        }
      });
      const klines1m = kRes.data || [];

      let reachedHalfTp = false;
      let reachedFullTp = false;
      let hitBeAfterHalf = false;
      let hitFullSl = false;

      for (const k of klines1m) {
        const h = parseFloat(k[2]);
        const l = parseFloat(k[3]);

        if (!reachedHalfTp) {
          if (isLong && h >= halfTpPrice) reachedHalfTp = true;
          if (!isLong && l <= halfTpPrice) reachedHalfTp = true;

          if (!reachedHalfTp) {
            if (isLong && l <= fullSlPrice) { hitFullSl = true; break; }
            if (!isLong && h >= fullSlPrice) { hitFullSl = true; break; }
          }
        } else {
          // Sau khi đã chạm 50% TP: SL đã dời về Entry BE
          if (isLong) {
            if (h >= fullTpPrice) { reachedFullTp = true; break; }
            if (l <= entryPrice * 1.0003) { hitBeAfterHalf = true; break; }
          } else {
            if (l <= fullTpPrice) { reachedFullTp = true; break; }
            if (h >= entryPrice * 0.9997) { hitBeAfterHalf = true; break; }
          }
        }
      }

      let simulatedPnl = 0;
      let simOutcome = '';

      if (reachedFullTp) {
        simulatedPnl = 3.75; // 1.25$ ở 50% + 2.50$ ở 100%
        simOutcome = '🟢 Ăn trọn Full TP (+3.75$)';
      } else if (hitBeAfterHalf) {
        simulatedPnl = 1.25; // 1.25$ ở 50% + 0$ ở BE
        simOutcome = '🟢 Chốt 50% TP (+1.25$), Nửa sau hòa BE';
      } else if (hitFullSl) {
        simulatedPnl = -4.50; // Dính full SL ban đầu
        simOutcome = '🔴 Dính full SL (-4.50$)';
      } else {
        // Nếu không rõ thì fallback theo PnL thực tế
        simulatedPnl = pos.actualPnl;
        simOutcome = pos.actualPnl >= 0 ? '🟡 Theo PnL sàn' : '🔴 Theo PnL sàn';
      }

      comparison.push({
        coin: pos.symbol,
        side: isLong ? 'LONG' : 'SHORT',
        time: pos.exitTimeStr,
        actualPnl: pos.actualPnl,
        actualStatus: pos.actualPnl > 0.5 ? '🟢 TP' : (pos.actualPnl > -0.5 ? '🟡 BE' : '🔴 SL'),
        simPnl: simulatedPnl,
        simOutcome
      });
    } catch(err) {}
  }

  console.log('\n=== KẾT QUẢ ĐỐI SOÁT CHI TIẾT TỪNG VỊ THẾ TRÊN BINANCE (17/08 -> 20/08) ===');
  console.table(comparison.map(c => ({
    'Mã': c.coin,
    'Lệnh': c.side,
    'Thời gian đóng': c.time,
    'PnL Thực tế': (c.actualPnl >= 0 ? '+' : '') + c.actualPnl.toFixed(2) + ' $',
    'Trạng thái thực': c.actualStatus,
    'PnL Partial TP 50%': (c.simPnl >= 0 ? '+' : '') + c.simPnl.toFixed(2) + ' $',
    'Diễn biến Partial TP': c.simOutcome
  })));

  const totalActual = comparison.reduce((s, c) => s + c.actualPnl, 0);
  const totalSim = comparison.reduce((s, c) => s + c.simPnl, 0);

  const actualWins = comparison.filter(c => c.actualPnl > 0.5).length;
  const actualBes = comparison.filter(c => c.actualPnl >= -0.5 && c.actualPnl <= 0.5).length;
  const actualLosses = comparison.filter(c => c.actualPnl < -0.5).length;

  const simWins = comparison.filter(c => c.simPnl > 0.5).length;
  const simBes = comparison.filter(c => c.simPnl >= -0.5 && c.simPnl <= 0.5).length;
  const simLosses = comparison.filter(c => c.simPnl < -0.5).length;

  console.log('================================================================================');
  console.log('📊 TỔNG HỢP SO SÁNH HIỆU SUẤT TRÊN 48 LỆNH THỰC CHIẾN BINANCE:');
  console.log('--------------------------------------------------------------------------------');
  console.log(`1. HIỆN TRẠNG (Không Partial TP, Dời SL hòa ở 50%):`);
  console.log(`   • Số lệnh Thắng (TP): ${actualWins} | Hòa (BE): ${actualBes} | Thua (SL): ${actualLosses}`);
  console.log(`   • Tỷ lệ Không Lỗ (Win+BE): ${((actualWins + actualBes) / comparison.length * 100).toFixed(1)}%`);
  console.log(`   • 💰 TỔNG PNL THỰC TẾ TRÊN BINANCE: ${(totalActual >= 0 ? '+' : '') + totalActual.toFixed(4)} USDT`);
  console.log('\n2. CHIẾN LƯỢC MỚI (Chốt 50% ở nửa đường +1.25$, Nửa sau dời SL về Entry BE):');
  console.log(`   • Số lệnh Thắng (>+0.5$): ${simWins} | Hòa (BE): ${simBes} | Thua (SL): ${simLosses}`);
  console.log(`   • Tỷ lệ Không Lỗ (Win+BE): ${((simWins + simBes) / comparison.length * 100).toFixed(1)}%`);
  console.log(`   • 💰 TỔNG PNL THEO PARTIAL TP 50%: ${(totalSim >= 0 ? '+' : '') + totalSim.toFixed(4)} USDT`);
  console.log(`   • 🚀 CHÊNH LỆCH LỢI NHUẬN RÒNG: ${((totalSim - totalActual) >= 0 ? '+' : '') + (totalSim - totalActual).toFixed(4)} USDT`);
  console.log('================================================================================');
}

backtestPartialTp().catch(console.error);
