require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');
const { checkTurnoverGuard } = require('../src/pp369/turnoverGuard');

// 1. Đọc dữ liệu signals từ data/369_signals.jsonl & ai_evaluations.jsonl
const signalsPath = path.join(process.cwd(), 'data', '369_signals.jsonl');
const datasetPath = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');

let signals = [];
if (fs.existsSync(signalsPath)) {
  signals = fs.readFileSync(signalsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
    .filter(Boolean);
}

let dataset = [];
if (fs.existsSync(datasetPath)) {
  dataset = fs.readFileSync(datasetPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
    .filter(Boolean);
}

// Đọc MarketCap & Volume 24H
const mcData = JSON.parse(fs.readFileSync('data/market_cap_top.json', 'utf8'));

async function getKlines(symbol, startTime, endTime, interval = '1m') {
  try {
    const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1500`);
    return res.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    return [];
  }
}

async function runCoreBacktest() {
  const startTs = new Date('2026-08-21T18:00:00+07:00').getTime();
  const endTs = new Date('2026-08-22T10:00:00+07:00').getTime();

  console.log('='.repeat(95));
  console.log(`🧪 BACKTEST TOÀN DIỆN NGUYÊN TẮC MỚI TỪ CORE CHO GIAI ĐOẠN:`);
  console.log(`   Từ: ${new Date(startTs).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})}`);
  console.log(`   Đến: ${new Date(endTs).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh'})}`);
  console.log(`⚙️ Cấu hình áp dụng:`);
  console.log(`   • MIN_CONFLUENCE_SCORE = 4.5đ`);
  console.log(`   • AI Approval Threshold = 69.0% (Phạt trừ 50% WinProb nếu Score < 4.0đ)`);
  console.log(`   • Abnormal Turnover Guard: MarketCap < 100M & Vol 24H > 8% (Dừng giao dịch)`);
  console.log(`   • Target Loss / Profit: SL = $3.0 USDT | TP = $4.5 USDT (R:R 1:1.5) | Hard Max Loss = -$3.30`);
  console.log('='.repeat(95));

  // Lấy danh sách 23 trade thực tế đã kích hoạt
  const trades = [
    { symbol: 'SNX', side: 'SHORT', score: 4.5, time: '21/8 18:00', oldPnl: 1.0146, actualResult: 'WIN' },
    { symbol: 'RVN', side: 'SHORT', score: 3.6, time: '21/8 18:20', oldPnl: -9.5354, actualResult: 'SL' },
    { symbol: 'C', side: 'SHORT', score: 5.8, time: '21/8 19:32', oldPnl: 3.0286, actualResult: 'WIN' },
    { symbol: 'A', side: 'SHORT', score: 4.6, time: '21/8 19:56', oldPnl: -0.6195, actualResult: 'BE' },
    { symbol: 'ENS', side: 'SHORT', score: 5.8, time: '21/8 22:47', oldPnl: -6.8081, actualResult: 'SL' },
    { symbol: 'DOLO', side: 'SHORT', score: 4.4, time: '22/8 00:07', oldPnl: 1.3662, actualResult: 'WIN' },
    { symbol: '1000PEPE', side: 'SHORT', score: 5.6, time: '22/8 01:03', oldPnl: 0.5436, actualResult: 'WIN' },
    { symbol: 'MEW', side: 'SHORT', score: 4.6, time: '22/8 01:03', oldPnl: -0.0958, actualResult: 'BE' },
    { symbol: '1000FLOKI', side: 'SHORT', score: 5.6, time: '22/8 01:19', oldPnl: -0.2083, actualResult: 'BE' },
    { symbol: 'ATH', side: 'SHORT', score: 5.6, time: '22/8 01:20', oldPnl: 0.3372, actualResult: 'WIN' },
    { symbol: 'XVS', side: 'SHORT', score: 4.2, time: '22/8 00:08', oldPnl: -0.2475, actualResult: 'BE' },
    { symbol: 'SKYAI', side: 'LONG', score: 5.3, time: '22/8 02:05', oldPnl: 5.1109, actualResult: 'WIN' },
    { symbol: '1000LUNC', side: 'LONG', score: 5.6, time: '22/8 01:49', oldPnl: 0.0340, actualResult: 'BE' },
    { symbol: 'STX', side: 'SHORT', score: 4.6, time: '22/8 03:29', oldPnl: 1.1002, actualResult: 'WIN' },
    { symbol: 'VET', side: 'SHORT', score: 4.6, time: '22/8 04:03', oldPnl: -5.0417, actualResult: 'SL' },
    { symbol: 'RONIN', side: 'SHORT', score: 4.6, time: '22/8 04:11', oldPnl: -4.9186, actualResult: 'SL' },
    { symbol: 'ICP', side: 'SHORT', score: 4.2, time: '22/8 05:43', oldPnl: -0.0980, actualResult: 'BE' },
    { symbol: 'INJ', side: 'SHORT', score: 4.1, time: '22/8 06:03', oldPnl: -0.1966, actualResult: 'BE' },
    { symbol: 'KAIA', side: 'SHORT', score: 4.0, time: '22/8 07:12', oldPnl: -5.4523, actualResult: 'SL' },
    { symbol: 'WIF', side: 'SHORT', score: 4.8, time: '22/8 08:16', oldPnl: 1.2818, actualResult: 'WIN' },
    { symbol: 'WAXP', side: 'SHORT', score: 4.6, time: '22/8 07:30', oldPnl: 0.0101, actualResult: 'BE' },
    { symbol: 'FARTCOIN', side: 'SHORT', score: 4.4, time: '22/8 08:10', oldPnl: 1.2502, actualResult: 'WIN' },
    { symbol: 'HYPER', side: 'SHORT', score: 4.7, time: '22/8 08:16', oldPnl: -2.9701, actualResult: 'SL' }
  ];

  const volRes = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const volMap = {};
  volRes.data.forEach(item => {
    const sym = item.symbol.replace(/USDT$/, '');
    volMap[sym] = parseFloat(item.quoteVolume || '0');
  });

  let executedCount = 0;
  let blockedCount = 0;
  let oldPnlSum = 0;
  let newPnlSum = 0;
  let winCount = 0;
  let lossCount = 0;
  let beCount = 0;

  console.log('\n📋 BẢNG ĐÁNH GIÁ TỪNG LỆNH KHI CHẠY QUA NGUYÊN TẮC MỚI:');
  console.log('-'.repeat(95));
  console.log('Mã Coin'.padEnd(10) + 'Hướng'.padEnd(7) + 'Score'.padEnd(7) + 'MC($M)'.padEnd(9) + 'Vol($M)'.padEnd(9) + 'Turnover'.padEnd(10) + 'AI Win%'.padEnd(9) + 'Quyết định'.padEnd(16) + 'PnL Mới'.padEnd(10) + 'Ghi chú');
  console.log('-'.repeat(95));

  for (const t of trades) {
    oldPnlSum += t.oldPnl;
    const cleanSym = t.symbol.replace(/^1000/, '').toUpperCase();
    const mc = mcData.marketCapMap[cleanSym] || mcData.marketCapMap[t.symbol] || (t.symbol === 'RVN' ? 59.3e6 : null);
    const rank = mcData.rankMap[cleanSym] || mcData.rankMap[t.symbol] || 999;
    const vol = volMap[t.symbol] || volMap[cleanSym] || 0;

    const isLowCap = (mc !== null && mc < 100e6) || (mc === null && rank > 150);
    const effectiveMC = mc || (rank > 300 ? 40e6 : 70e6);
    const turnoverRatio = effectiveMC > 0 ? (vol / effectiveMC * 100) : 0;

    // 1. Check Turnover Guard
    const isTurnoverBlocked = isLowCap && (turnoverRatio > 8.0);

    // 2. Check Score >= 4.5
    const isScorePassed = (t.score >= 4.5);

    // 3. Check AI Reviewer
    const aiEval = evaluateSignalWithAI({
      symbol: t.symbol,
      score: t.score,
      marketCapRank: rank,
      scoreReasons: ['H1 siêu nén', 'Quá bán cực đại', 'Ngược/Mâu thuẫn']
    });

    const isAiApproved = aiEval.isApproved && (aiEval.winProbability >= 69.0);

    let decision = 'VÀO LỆNH';
    let newPnl = t.oldPnl;
    let note = '';

    if (isTurnoverBlocked) {
      decision = 'CHẶN (Turnover)';
      newPnl = 0;
      note = `Turnover ${turnoverRatio.toFixed(1)}% > 8% (Low-Cap)`;
      blockedCount++;
    } else if (!isScorePassed) {
      decision = 'BỎ QUA (Score)';
      newPnl = 0;
      note = `Score ${t.score}đ < 4.5đ`;
      blockedCount++;
    } else if (!isAiApproved) {
      decision = 'AI TỪ CHỐI';
      newPnl = 0;
      note = `AI WinProb ${aiEval.winProbability}% < 69%`;
      blockedCount++;
    } else {
      decision = 'ĐƯỢC VÀO';
      executedCount++;
      // Khống chế SL mới tối đa -$3.30
      if (newPnl < -3.30) {
        newPnl = -3.30;
        note = `Khống chế trần SL -$3.30 (Cũ: $${t.oldPnl.toFixed(2)})`;
      } else if (newPnl > 0) {
        note = `Lãi +$${newPnl.toFixed(2)}`;
      } else {
        note = `Hòa vốn / Phí -$${Math.abs(newPnl).toFixed(2)}`;
      }

      if (newPnl > 0.5) winCount++;
      else if (newPnl < -1.0) lossCount++;
      else beCount++;

      newPnlSum += newPnl;
    }

    const mcStr = (effectiveMC / 1e6).toFixed(1);
    const volStr = (vol / 1e6).toFixed(2);
    const turnStr = turnoverRatio.toFixed(1) + '%';
    const winStr = aiEval.winProbability.toFixed(1) + '%';
    const pnlStr = (newPnl >= 0 ? '+' : '') + newPnl.toFixed(2) + '$';

    console.log(
      t.symbol.padEnd(10) +
      t.side.padEnd(7) +
      (t.score + 'đ').padEnd(7) +
      mcStr.padEnd(9) +
      volStr.padEnd(9) +
      turnStr.padEnd(10) +
      winStr.padEnd(9) +
      decision.padEnd(16) +
      pnlStr.padEnd(10) +
      note
    );
  }

  console.log('='.repeat(95));
  console.log('📊 TỔNG KẾT KẾT QUẢ BACKTEST TOÀN DIỆN:');
  console.log(`• Tổng số tín hiệu được quét:               ${trades.length} tín hiệu`);
  console.log(`• Số lệnh BỊ LOẠI BỎ (Không vào):            ${blockedCount} lệnh (${((blockedCount/trades.length)*100).toFixed(1)}%)`);
  console.log(`• Số lệnh ĐẠT CHUẨN ĐƯỢC VÀO:                ${executedCount} lệnh (${winCount} Thắng / ${beCount} Hòa vốn / ${lossCount} Thua)`);
  console.log(`• Tổng PnL Thực tế CŨ:                       ${oldPnlSum >= 0 ? '+' : ''}${oldPnlSum.toFixed(4)} USDT`);
  console.log(`• Tổng PnL MỚI theo nguyên tắc:              ${newPnlSum >= 0 ? '+' : ''}${newPnlSum.toFixed(4)} USDT`);
  console.log(`• Mức Tiết kiệm Thua lỗ / Cải thiện:         +${(newPnlSum - oldPnlSum).toFixed(4)} USDT (${(((newPnlSum - oldPnlSum) / Math.abs(oldPnlSum)) * 100).toFixed(1)}% cải thiện)`);
  console.log('='.repeat(95));
}

runCoreBacktest().catch(console.error);
