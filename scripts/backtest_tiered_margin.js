'use strict';

/**
 * Script Backtest so sánh Phân bổ Ký quỹ (Tiered Margin Sizing)
 * 
 * So sánh 3 Chiến lược:
 * 1. Phương án A: Thuần PP369 + H1/M15 Volatility (Fixed Margin $50 cho TẤT CẢ lệnh pass H1/M15 Vol)
 * 2. Phương án B: Tiered Margin Sizing (Lệnh cơ bản $50, Lệnh hội tụ cao Score >= 6.5 / Trend+RSI+Flow $90)
 * 3. Phương án C: Chỉ đánh Lệnh hội tụ cao (Score >= 6.5 / Trend+RSI+Flow) với Margin $90
 *
 * Dùng: node scripts/backtest_tiered_margin.js [DAYS] [LIMIT_COINS]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { score369Method, getStep, getDecimals } = require('../src/pp369');

const STEP_SIZES_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');
const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
const h4Cache = stepSizesData.h4Cache || {};

const YEAR_START_MS = Date.UTC(2026, 0, 1);
const allValidCoins = Object.entries(h4Cache)
  .filter(([sym, e]) => e.yearStart === YEAR_START_MS && !e.failed)
  .map(([sym]) => sym);

const args = process.argv.slice(2);
const daysArg = parseInt(args[0], 10);
const limitCoinsArg = parseInt(args[1], 10);

const DAYS_TO_BACKTEST = (!isNaN(daysArg) && daysArg > 0) ? daysArg : 30;
const COIN_LIMIT = (!isNaN(limitCoinsArg) && limitCoinsArg > 0) ? limitCoinsArg : 40;

const coins = allValidCoins.slice(0, COIN_LIMIT);

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
    return [];
  }
}

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
  console.log(` 🚀 BACKTEST PHÂN BỔ MARGIN (TIERED MARGIN) - ${DAYS_TO_BACKTEST} NGÀY`);
  console.log(` Số lượng Coin (${coins.length}): ${coins.join(', ')}`);
  console.log(`================================================================\n`);

  let totalSignalsDetected = 0;
  let totalFailedVolFilter = 0;
  let totalPassVolFilter = 0;

  // Stats cho Option A (Fixed $50 cho tất cả lệnh pass H1/M15 Vol)
  const statsA = { trades: 0, wins: 0, losses: 0, breakeven: 0, pnl: 0, totalMargin: 0 };

  // Stats cho Option B (Tiered Margin: $50 basic / $90 high confluence)
  const statsB = { trades: 0, wins: 0, losses: 0, breakeven: 0, pnl: 0, totalMargin: 0 };

  // Stats cho Option C (High Confluence Score >= 6.5 / Trend+RSI+Flow only - Margin $90)
  const statsC = { trades: 0, wins: 0, losses: 0, breakeven: 0, pnl: 0, totalMargin: 0 };

  for (const sym of coins) {
    const h1Ref = h4Cache[sym];
    if (!h1Ref || h1Ref.failed) continue;

    const h1Candles = await fetchH1Klines(sym, DAYS_TO_BACKTEST);
    if (!h1Candles || h1Candles.length < 100) continue;

    const openPrice = h1Ref.openPrice;
    const closePrice = h1Ref.closePrice;
    const step = h1Ref.step;

    for (let i = 100; i < h1Candles.length - 24; i += 4) {
      const currentCandle = h1Candles[i];
      const prevCandle = h1Candles[i - 1];
      const candlePrice = currentCandle.close;

      const grid = buildGrid(openPrice, closePrice, step, candlePrice);
      const targetLong = grid.filter(l => l.value <= candlePrice).pop();
      const targetShort = grid.find(l => l.value >= candlePrice);

      if (!targetLong || !targetShort) continue;

      let direction = null;
      let targetLevel = 0;

      if (currentCandle.low <= targetLong.value && prevCandle.low > targetLong.value) {
        direction = 'LONG';
        targetLevel = targetLong.value;
      } else if (currentCandle.high >= targetShort.value && prevCandle.high < targetShort.value) {
        direction = 'SHORT';
        targetLevel = targetShort.value;
      }

      if (!direction) continue;

      totalSignalsDetected++;

      const mockSig = {
        symbol: sym,
        signal: direction,
        targetLevel: targetLevel,
        currentPrice: candlePrice,
        step: step,
        scoreReasons: []
      };

      const scoreRes = await score369Method(mockSig, direction);
      const score = scoreRes.score || 0;
      const scoreReasons = scoreRes.reasons || [];
      const reasonsStr = scoreReasons.join(' ');

      // Kiểm tra Tiêu chí 2 (Biến động H1/M15 an toàn - không bị +0đ)
      const hasVolFilter = scoreReasons.some(r => r.includes('[Biến động H1/M15]') && !r.includes('(+0đ)'));
      if (!hasVolFilter) {
        totalFailedVolFilter++;
        continue;
      }

      totalPassVolFilter++;

      // Xác định loại tín hiệu:
      // High Confluence nếu score >= 6.5 HOẶC (score >= 5.5 + Thuận Trend + có RSI/LS support)
      const isCounterTrend = reasonsStr.includes('Ngược/Mâu thuẫn') || reasonsStr.includes('H4 ngược');
      const hasRsiSupport = reasonsStr.includes('Quá bán') || reasonsStr.includes('Quá mua');
      const hasLsSupport = reasonsStr.includes('Gold Setup') || reasonsStr.includes('Đồng thuận');
      const isHighConfluence = (score >= 6.5 && !isCounterTrend) || (score >= 5.5 && !isCounterTrend && (hasRsiSupport || hasLsSupport));

      const stepPct = (step / targetLevel) * 100;
      const leverage = Math.min(20, Math.max(3, Math.floor(39 / stepPct)));

      const unit = step / 3;
      const posGridWidthPct = stepPct;
      const trailMultiplier = posGridWidthPct <= 5.0 ? 0.70 : 0.45;
      const tpDistance = unit * (score >= 7.5 ? 1.5 : (score >= 6.5 ? 1.2 : 0.9));
      const trailDistance = unit * trailMultiplier;
      const slDistance = unit * 1.03; // -13% margin equivalent + 3 ticks buffer

      const tpPct = ((tpDistance / targetLevel) * leverage) * 100;
      const slPct = -((slDistance / targetLevel) * leverage) * 100;
      const trailTrigger = ((trailDistance / targetLevel) * leverage) * 100;

      // Mô phỏng diễn biến
      let outcome = 'OPEN';
      let roi = 0;
      let maxRoi = 0;
      let minRoi = 0;
      let isTrailed = false;

      for (let j = i + 1; j < Math.min(h1Candles.length, i + 36); j++) {
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

        if (maxRoi >= trailTrigger) {
          isTrailed = true;
        }

        if (candleMinRoi <= slPct) {
          if (isTrailed) {
            outcome = 'BREAKEVEN';
            roi = 2.0; // +2% ROI khi hòa vốn (+5 ticks)
          } else {
            outcome = 'LOSS';
            roi = slPct;
          }
          break;
        }

        if (candleMaxRoi >= tpPct) {
          outcome = 'WIN';
          roi = tpPct;
          break;
        }
      }

      if (outcome === 'OPEN') {
        const lastCandle = h1Candles[Math.min(h1Candles.length - 1, i + 36)];
        const isLong = direction === 'LONG';
        const exitRoi = isLong 
          ? ((lastCandle.close - targetLevel) / targetLevel) * leverage * 100
          : ((targetLevel - lastCandle.close) / targetLevel) * leverage * 100;
        
        if (exitRoi > 0) outcome = 'WIN';
        else outcome = 'LOSS';
        roi = exitRoi;
      }

      // ── Option A (Fixed $50 Margin) ──
      const marginA = 50;
      const pnlA = marginA * (roi / 100);
      statsA.trades++;
      statsA.pnl += pnlA;
      statsA.totalMargin += marginA;
      if (outcome === 'WIN') statsA.wins++;
      else if (outcome === 'LOSS') statsA.losses++;
      else if (outcome === 'BREAKEVEN') statsA.breakeven++;

      // ── Option B (Dynamic Margin: Base $50 + $5 per 1.0đ extra criteria, max $100) ──
      const volScore = scoreRes.volScore || 0;
      const otherScore = scoreRes.otherScore != null ? scoreRes.otherScore : Math.max(0, score - volScore);
      const marginB = Math.min(100, 50 + Math.floor(otherScore) * 5);
      const pnlB = marginB * (roi / 100);
      statsB.trades++;
      statsB.pnl += pnlB;
      statsB.totalMargin += marginB;
      if (outcome === 'WIN') statsB.wins++;
      else if (outcome === 'LOSS') statsB.losses++;
      else if (outcome === 'BREAKEVEN') statsB.breakeven++;

      // ── Option C (High Confluence Only - Margin $90) ──
      if (isHighConfluence) {
        const marginC = 90;
        const pnlC = marginC * (roi / 100);
        statsC.trades++;
        statsC.pnl += pnlC;
        statsC.totalMargin += marginC;
        if (outcome === 'WIN') statsC.wins++;
        else if (outcome === 'LOSS') statsC.losses++;
        else if (outcome === 'BREAKEVEN') statsC.breakeven++;
      }
    }
  }

  console.log(`================================================================`);
  console.log(` 📊 THỐNG KÊ TÍN HIỆU DỮ LIỆU (${DAYS_TO_BACKTEST} NGÀY - ${coins.length} COINS)`);
  console.log(`================================================================`);
  console.log(` • Tổng Tín hiệu phát hiện:           ${totalSignalsDetected}`);
  console.log(` • Bị loại do Biến động H1/M15 kém:   ${totalFailedVolFilter} (${((totalFailedVolFilter/totalSignalsDetected)*100).toFixed(1)}%)`);
  console.log(` • Đạt tiêu chuẩn PP369 + H1/M15 Vol: ${totalPassVolFilter} (${((totalPassVolFilter/totalSignalsDetected)*100).toFixed(1)}%)\n`);

  console.log(`================================================================`);
  console.log(` 🏆 BẢNG SO SÁNH KẾT QUẢ HIỆU SUẤT 3 PHƯƠNG ÁN`);
  console.log(`================================================================\n`);

  function formatStats(name, s) {
    const winRate = s.trades > 0 ? (((s.wins + s.breakeven) / s.trades) * 100).toFixed(1) : '0';
    const pureWinRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0';
    return {
      'Phương án': name,
      'Số lệnh': s.trades,
      'WIN': s.wins,
      'BE (Hòa)': s.breakeven,
      'LOSS': s.losses,
      'Winrate (BE)': `${winRate}%`,
      'Pure Winrate': `${pureWinRate}%`,
      'Tổng Lợi Nhuận (PnL)': `${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)} USDT`,
      'Margin Avg': `$${(s.totalMargin / (s.trades || 1)).toFixed(0)}`,
    };
  }

  console.table([
    formatStats('A. Cố định $50 (Tất cả lệnh pass H1/M15 Vol)', statsA),
    formatStats('B. Thưởng Margin ($50 gốc + $5/1.0đ tiêu chí bổ trợ)', statsB),
    formatStats('C. Chỉ đánh Hội tụ cao ($90 cố định)', statsC),
  ]);
}

runBacktest().catch(err => {
  console.error('Lỗi backtest:', err);
});
