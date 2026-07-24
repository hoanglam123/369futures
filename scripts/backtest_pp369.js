'use strict';

/**
 * Script Backtest PP369 Strategy trong 1-2 tháng gần đây (60 ngày)
 * 
 * Mô phỏng đầy đủ:
 * - Quét mốc 369 từ nến H4 gốc năm 2026 trong step_sizes.json
 * - Phát hiện điểm chạm mốc 369 trên nến H1
 * - Chấm điểm bằng Scorer mới (Dow Kép H1 15d + M15 3d + Penalties + VSA Vol + OI + Funding + BTC)
 * - Lọc theo quy tắc AutoTrade: Block lệnh < 6.0đ hoặc Ngược Dow
 * - Giả lập khớp lệnh và theo dõi kết quả TP / SL / Trailing SL
 * 
 * Dùng: node scripts/backtest_pp369.js [COINS...] [DAYS]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { score369Method, fmt369Price, getStep, getDecimals } = require('../src/pp369');
const { log } = require('../src/pp369/_logger');

const STEP_SIZES_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');
const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
const h4Cache = stepSizesData.h4Cache || {};

const YEAR_START_MS = Date.UTC(2026, 0, 1);
const allValidCoins = Object.entries(h4Cache)
  .filter(([sym, e]) => e.yearStart === YEAR_START_MS && !e.failed)
  .map(([sym]) => sym);

const daysArg = parseInt(process.argv[process.argv.length - 1], 10);
const DAYS_TO_BACKTEST = (!isNaN(daysArg) && daysArg > 0) ? daysArg : 60; // 60 ngày = 2 tháng

const symbols = process.argv.slice(2).filter(s => isNaN(parseInt(s, 10))).map(s => s.toUpperCase());
const coins = symbols.length ? symbols : allValidCoins.slice(0, 100);

// Tải nến H1 từ Binance Futures
async function fetchH1Klines(symbol, days) {
  const limit = Math.min(1500, days * 24 + 100);
  const startTime = Date.now() - days * 24 * 3600000;
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  try {
    const res = await axios.get(url, {
      params: { symbol: `${symbol}USDT`, interval: '1h', startTime, limit },
      timeout: 15000,
    });
    return (res.data || []).map(c => ({
      openTime: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (err) {
    log.warn(`[Backtest] Không thể nạp nến H1 cho ${symbol}: ${err.message}`);
    return [];
  }
}

// Xây dựng lưới mốc 369 quanh một mức giá
function buildGrid(openPrice, closePrice, step, centerPrice) {
  const upperPrice = Math.max(openPrice, closePrice);
  const lowerPrice = Math.min(openPrice, closePrice);
  const levels = [];

  const distTicks = Math.ceil(Math.abs(centerPrice - upperPrice) / step) + 10;
  for (let i = -distTicks; i <= distTicks; i++) {
    levels.push({ type: 'tren', value: upperPrice + i * 3 * step });
    levels.push({ type: 'duoi', value: lowerPrice + i * 3 * step });
  }

  return levels.sort((a, b) => a.value - b.value);
}

async function runBacktest() {
  console.log(`\n================================================================`);
  console.log(` 🚀 HỆ THỐNG BACKTEST PP369 (DỮ LIỆU ${DAYS_TO_BACKTEST} NGÀY GẦN ĐÂY)`);
  console.log(` Danh sách Coin (${coins.length}): ${coins.join(', ')}`);
  console.log(`================================================================\n`);

  let totalSignalsEvaluated = 0;
  let totalBlockedByFilter = 0;
  let totalExecutedTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalBreakeven = 0;
  let totalPnlUsdt = 0;

  const tradeLogs = [];

  for (const sym of coins) {
    const h1Ref = h4Cache[sym];
    if (!h1Ref || h1Ref.failed) {
      console.log(`⚠️ ${sym}: Chưa có nến H4 gốc 2026 trong step_sizes.json — bỏ qua.`);
      continue;
    }

    console.log(`⏳ Đang tải nến H1 và chạy Backtest cho ${sym}...`);
    const h1Candles = await fetchH1Klines(sym, DAYS_TO_BACKTEST);
    if (!h1Candles || h1Candles.length < 100) {
      console.log(`⚠️ ${sym}: Không đủ nến H1 (${h1Candles.length} nến) — bỏ qua.`);
      continue;
    }

    const openPrice = h1Ref.openPrice;
    const closePrice = h1Ref.closePrice;
    const step = h1Ref.step;

    // Quét chuỗi nến H1 để mô phỏng tín hiệu khi giá chạm mốc
    for (let i = 150; i < h1Candles.length - 24; i += 6) { // Quét nến H1 (bước 6 tiếng)
      const currentCandle = h1Candles[i];
      const prevCandle = h1Candles[i - 1];
      const candlePrice = currentCandle.close;

      const grid = buildGrid(openPrice, closePrice, step, candlePrice);
      
      // Tìm mốc gần nhất
      const targetLong = grid.filter(l => l.value <= candlePrice).pop();
      const targetShort = grid.find(l => l.value >= candlePrice);

      if (!targetLong || !targetShort) continue;

      // Kiểm tra chạm mốc
      let direction = null;
      let targetLevel = 0;

      if (currentCandle.low <= targetLong.value && prevCandle.low > targetLong.value) {
        direction = 'LONG';
        targetLevel = targetLong.value;
      } else if (currentCandle.high >= targetShort.value && prevCandle.high < targetShort.value) {
        direction = 'SHORT';
        targetLevel = targetShort.value;
      }

      if (!direction) continue; // Giá không có nhịp chạm mốc mới

      totalSignalsEvaluated++;

      // Giả lập signal object cho Scorer
      const mockSig = {
        symbol: sym,
        signal: direction,
        targetLevel: targetLevel,
        currentPrice: candlePrice,
        step: step,
        scoreReasons: []
      };

      // Chấm điểm bằng Scorer mới
      const scoreRes = await score369Method(mockSig, direction);
      const score = scoreRes.score;
      const scoreReasons = scoreRes.reasons || [];

      // Bộ lọc Phương án A: Block lệnh < 6.0đ hoặc Ngược Dow & EMA
      const isCounterTrend = scoreReasons.some(r => r.includes('Ngược cấu trúc Dow & EMA'));
      if (score < 6.0 || isCounterTrend) {
        totalBlockedByFilter++;
        continue; // Bị AutoTrade chặn
      }

      // Xác định leverage & margin
      const stepPct = (step / targetLevel) * 100;
      const leverage = Math.min(20, Math.max(5, Math.floor(50 / stepPct)));

      let margin = 20;
      if (score >= 9.0) margin = 50;
      else if (score >= 8.0) margin = 40;
      else if (score >= 7.0) margin = 30;

      // Cấu hình TP / SL theo điểm
      let tpPct = 10;
      let slPct = -10;
      let trailTrigger = 5;

      if (score >= 8.0) {
        tpPct = 25;
        slPct = -15;
        trailTrigger = 9;
      } else if (score >= 7.0) {
        tpPct = 20;
        slPct = -13;
        trailTrigger = 9;
      }

      // Mô phỏng diễn biến lệnh trong tối đa 48h nến tiếp theo
      let outcome = 'OPEN';
      let pnlUsdt = 0;
      let maxRoi = 0;
      let minRoi = 0;
      let isTrailed = false;

      for (let j = i + 1; j < Math.min(h1Candles.length, i + 48); j++) {
        const fCandle = h1Candles[j];
        const isLong = direction === 'LONG';

        const bestPrice = isLong ? fCandle.high : fCandle.low;
        const worstPrice = isLong ? fCandle.low : fCandle.high;

        const candleMaxRoi = isLong 
          ? ((bestPrice - targetLevel) / targetLevel) * leverage * 100
          : ((targetLevel - bestPrice) / targetLevel) * leverage * 100;

        const candleMinRoi = isLong
          ? ((worstPrice - targetLevel) / targetLevel) * leverage * 100
          : ((targetLevel - worstPrice) / targetLevel) * leverage * 100;

        maxRoi = Math.max(maxRoi, candleMaxRoi);
        minRoi = Math.min(minRoi, candleMinRoi);

        // Kích hoạt Trailing SL về Hòa vốn khi ROI đạt threshold
        if (maxRoi >= trailTrigger) {
          isTrailed = true;
        }

        // Kiểm tra dính SL
        if (candleMinRoi <= slPct) {
          if (isTrailed) {
            outcome = 'BREAKEVEN';
            pnlUsdt = margin * 0.01; // +1% ROI hòa vốn
          } else {
            outcome = 'LOSS';
            pnlUsdt = margin * (slPct / 100);
          }
          break;
        }

        // Kiểm tra dính TP
        if (candleMaxRoi >= tpPct) {
          outcome = 'WIN';
          pnlUsdt = margin * (tpPct / 100);
          break;
        }
      }

      if (outcome === 'OPEN') {
        const lastCandle = h1Candles[Math.min(h1Candles.length - 1, i + 48)];
        const isLong = direction === 'LONG';
        const exitRoi = isLong 
          ? ((lastCandle.close - targetLevel) / targetLevel) * leverage * 100
          : ((targetLevel - lastCandle.close) / targetLevel) * leverage * 100;
        
        if (exitRoi > 0) outcome = 'WIN';
        else outcome = 'LOSS';
        pnlUsdt = margin * (exitRoi / 100);
      }

      totalExecutedTrades++;
      totalPnlUsdt += pnlUsdt;

      if (outcome === 'WIN') totalWins++;
      else if (outcome === 'LOSS') totalLosses++;
      else if (outcome === 'BREAKEVEN') totalBreakeven++;

      tradeLogs.push({
        symbol: sym,
        time: new Date(currentCandle.openTime).toISOString().slice(0, 16).replace('T', ' '),
        signal: direction,
        score: score.toFixed(1),
        outcome: outcome,
        pnlUsdt: (pnlUsdt >= 0 ? '+' : '') + pnlUsdt.toFixed(2) + ' USDT',
        margin: `$${margin}`,
        leverage: `${leverage}x`
      });
    }
  }

  // Tổng hợp Báo cáo Backtest
  const winRate = totalExecutedTrades > 0 ? (((totalWins + totalBreakeven) / totalExecutedTrades) * 100).toFixed(1) : '0';
  const pureWinRate = totalExecutedTrades > 0 ? ((totalWins / totalExecutedTrades) * 100).toFixed(1) : '0';
  const blockRate = totalSignalsEvaluated > 0 ? ((totalBlockedByFilter / totalSignalsEvaluated) * 100).toFixed(1) : '0';

  console.log(`\n================================================================`);
  console.log(` 📊 BÁO CÁO KẾT QUẢ BACKTEST PP369 SCORER MỚI (${DAYS_TO_BACKTEST} NGÀY)`);
  console.log(`================================================================`);
  console.log(` • Tổng Tín hiệu chạm mốc:       ${totalSignalsEvaluated}`);
  console.log(` • Lệnh bị BLOCK (Filter):      ${totalBlockedByFilter} (${blockRate}%) [Ngược Dow hoặc < 6.0đ]`);
  console.log(` • Lệnh thực thi AutoTrade:     ${totalExecutedTrades}`);
  console.log(`----------------------------------------------------------------`);
  console.log(` 🏆 Số Lệnh ĐẠT TP (WIN):       ${totalWins}`);
  console.log(` 🛡 Số Lệnh HÒA VỐN (Breakeven): ${totalBreakeven}`);
  console.log(` ❌ Số Lệnh CẮN SL (LOSS):       ${totalLosses}`);
  console.log(` 🔥 TỶ LỆ THẮNG THỰC TẾ:        ${winRate}% (Thuần WIN: ${pureWinRate}%)`);
  console.log(` 💰 TỔNG LỢI NHUẬN (NET PNL):    ${(totalPnlUsdt >= 0 ? '+' : '') + totalPnlUsdt.toFixed(2)} USDT`);
  console.log(`================================================================\n`);

  if (tradeLogs.length > 0) {
    console.log(`📋 Danh sách lệnh gần đây nhất:`);
    console.table(tradeLogs.slice(-15));
  }
}

runBacktest().catch(err => {
  console.error('Fatal backtest error:', err);
});
