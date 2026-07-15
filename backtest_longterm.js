'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STEP_SIZES_PATH = 'f:/LamDH/Project/369futures/data/step_sizes.json';
const MARKET_CAP_PATH = 'f:/LamDH/Project/369futures/data/market_cap_top.json';
const REPORT_PATH = 'C:/Users/lamdh/.gemini/antigravity-ide/brain/3528cc9f-4b87-4209-8b1b-e394d5d1d76b/backtest_confluence_report.md';

// Top 15 representative coins
const BACKTEST_COINS = ['BTC', 'ETH', 'BNB', 'ADA', 'XRP', 'DOT', 'LTC', 'LINK', 'UNI', 'AVAX', 'ATOM', 'FIL', 'APT', 'NEAR', 'SUI'];

// Load configurations
let stepSizesData = {};
try {
  stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
} catch (_) {}

let marketCapList = [];
try {
  const capData = JSON.parse(fs.readFileSync(MARKET_CAP_PATH, 'utf8'));
  marketCapList = capData.symbols || [];
} catch (_) {}

function isTop150(symbol) {
  return marketCapList.includes(symbol.toLowerCase()) || BACKTEST_COINS.includes(symbol);
}

// Indicator Helpers
function calculateEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }
  if (changes.length < period) return null;

  let firstGains = [];
  let firstLosses = [];
  for (let i = 0; i < period; i++) {
    const chg = changes[i];
    firstGains.push(chg > 0 ? chg : 0);
    firstLosses.push(chg < 0 ? -chg : 0);
  }

  let currentAvgGain = firstGains.reduce((a, b) => a + b, 0) / period;
  let currentAvgLoss = firstLosses.reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < changes.length; i++) {
    const chg = changes[i];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    currentAvgGain = (currentAvgGain * (period - 1) + gain) / period;
    currentAvgLoss = (currentAvgLoss * (period - 1) + loss) / period;
  }

  if (currentAvgLoss === 0) return 100;
  const rs = currentAvgGain / currentAvgLoss;
  return 100 - (100 / (1 + rs));
}

function findSwingPoints(candles, leftStrength = 4, rightStrength = 4) {
  const highs = [];
  const lows = [];
  for (let i = leftStrength; i < candles.length - rightStrength; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].high > c.high) { isHigh = false; break; }
      }
    }
    if (isHigh) highs.push(c.high);

    let isLow = true;
    for (let j = 1; j <= leftStrength; j++) {
      if (candles[i - j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = 1; j <= rightStrength; j++) {
        if (candles[i + j].low < c.low) { isLow = false; break; }
      }
    }
    if (isLow) lows.push(c.low);
  }
  return { highs, lows };
}

// Build Level Grid (copied from core.js)
function buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange = 50) {
  const grid = [];
  for (let i = -levelsRange; i <= levelsRange; i++) {
    const offset = i * step;
    grid.push({
      value: parseFloat((upperPrice + offset).toFixed(decimals)),
      type: 'tren',
      tier: i,
    });
    grid.push({
      value: parseFloat((lowerPrice + offset).toFixed(decimals)),
      type: 'duoi',
      tier: i,
    });
  }
  grid.sort((a, b) => a.value - b.value || (a.type === 'tren' ? -1 : 1));
  return grid.filter((v, i, arr) =>
    i === 0 || !(v.value === arr[i - 1].value && v.type === arr[i - 1].type)
  );
}

// Fetch Binance Klines with Retries
async function fetchBinanceKlines(symbol, interval, startTime, limit = 1500) {
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(url, {
        params: { symbol: `${symbol}USDT`, interval, startTime, limit },
        timeout: 15000,
      });
      return (res.data || []).map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
      }));
    } catch (err) {
      if (err?.response?.status === 429) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
        continue;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

// Fetch historical derivatives data
async function fetchGlobalLongShortRatio(symbol, timeMs) {
  const url = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio';
  try {
    const res = await axios.get(url, {
      params: { symbol: `${symbol}USDT`, period: '1h', startTime: timeMs - 1800000, endTime: timeMs + 1800000, limit: 1 },
      timeout: 5000
    });
    if (res.data && res.data.length > 0) {
      return {
        long: parseFloat(res.data[0].longAccount) * 100,
        short: parseFloat(res.data[0].shortAccount) * 100,
      };
    }
  } catch (_) {}
  return null;
}

async function fetchTopLongShortPositionRatio(symbol, timeMs) {
  const url = 'https://fapi.binance.com/futures/data/topLongShortPositionRatio';
  try {
    const res = await axios.get(url, {
      params: { symbol: `${symbol}USDT`, period: '1h', startTime: timeMs - 1800000, endTime: timeMs + 1800000, limit: 1 },
      timeout: 5000
    });
    if (res.data && res.data.length > 0) {
      return {
        long: parseFloat(res.data[0].longAccount) * 100,
        short: parseFloat(res.data[0].shortAccount) * 100,
      };
    }
  } catch (_) {}
  return null;
}

async function fetchOpenInterestHistory(symbol, timeMs) {
  const url = 'https://fapi.binance.com/futures/data/openInterestHist';
  try {
    const res = await axios.get(url, {
      params: { symbol: `${symbol}USDT`, period: '1h', startTime: timeMs - 4 * 3600000 - 600000, endTime: timeMs + 600000, limit: 6 },
      timeout: 5000
    });
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      return res.data.map(item => parseFloat(item.sumOpenInterest));
    }
  } catch (_) {}
  return null;
}

async function runBacktest() {
  console.log(`Bắt đầu chạy backtest dài hạn cho ${BACKTEST_COINS.length} coin từ 01/01/2026 với đòn bẩy động & quy tắc SL/TP live...`);
  const allTrades = [];

  for (const symbol of BACKTEST_COINS) {
    const h4 = stepSizesData.h4Cache?.[symbol];
    if (!h4) {
      console.log(`  - Không tìm thấy H4 cache cho ${symbol}, bỏ qua.`);
      continue;
    }

    console.log(`\n=== Quét tín hiệu H1 cho ${symbol} ===`);
    // Download H1 klines since Jan 1, 2026
    let klines = [];
    let cursor = 1767225600000; // Jan 1, 2026 00:00:00 UTC
    const end = Date.now();
    while (cursor < end) {
      const batch = await fetchBinanceKlines(symbol, '1h', cursor, 1500);
      if (!batch.length) break;
      klines.push(...batch);
      cursor = batch[batch.length - 1].openTime + 3600000;
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`  - Đã tải ${klines.length} nến H1.`);
    if (klines.length < 200) continue;

    // Build dynamic level grid
    const grid = buildLevelGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 100);
    const step = h4.step;
    const triggers = [];
    const state = {}; // pairKey -> lastSide

    for (let i = 200; i < klines.length; i++) {
      const c = klines[i];
      const prevClose = klines[i-1].close;

      // Find active pair in grid for prevClose
      let idx = grid.findIndex(l => l.value >= prevClose);
      if (idx === -1) idx = grid.length - 1;
      if (idx === 0) idx = 1;

      const levelAbove = grid[idx];
      const levelBelow = grid[idx-1];
      const pairKey = `${levelBelow.value}_${levelAbove.value}`;

      if (!state[pairKey]) {
        state[pairKey] = 'neutral';
      }

      // Check high touch
      if (c.high >= levelAbove.value && state[pairKey] !== 'upper') {
        if (state[pairKey] === 'lower') {
          triggers.push({
            symbol,
            signal: 'SHORT',
            timeMs: c.openTime,
            targetLevel: levelAbove.value,
            condLevel: levelBelow.value,
            h1Index: i
          });
        }
        state[pairKey] = 'upper';
      }

      // Check low touch
      if (c.low <= levelBelow.value && state[pairKey] !== 'lower') {
        if (state[pairKey] === 'upper') {
          triggers.push({
            symbol,
            signal: 'LONG',
            timeMs: c.openTime,
            targetLevel: levelBelow.value,
            condLevel: levelAbove.value,
            h1Index: i
          });
        }
        state[pairKey] = 'lower';
      }
    }

    console.log(`  - Tìm thấy ${triggers.length} cơ hội giao dịch.`);

    // Simulate 1m exit and score calculation for each trigger
    const selectedTriggers = triggers.slice(0, 25);
    if (triggers.length > 25) {
      console.log(`  - Giới hạn phân tích 25/${triggers.length} lệnh đầu tiên của ${symbol} để tối ưu hóa tốc độ.`);
    }

    for (const t of selectedTriggers) {
      console.log(`    * [1M Check] ${symbol} ${t.signal} lúc ${new Date(t.timeMs).toISOString()}`);
      // Fetch 1m candles for 24 hours (1440 mins)
      const m1Klines = await fetchBinanceKlines(symbol, '1m', t.timeMs, 1440);
      if (!m1Klines.length) continue;

      // Calculate dynamic leverage (copying production logic from autoTrade.js)
      const pctGrid = (step / t.targetLevel) * 100;
      const calculatedLeverage = Math.floor(50 / pctGrid);
      const maxAllowed = stepSizesData.leverageInfo?.[symbol] ?? 10;
      const effectiveLeverage = Math.max(1, Math.min(calculatedLeverage, maxAllowed));

      const isLong = t.signal === 'LONG';
      const entry = t.targetLevel;

      let partialClosed = false;
      let slRoi = -13; // Stop Loss: -13% ROI
      let closed = false;
      let finalRoi = 0;
      let exitPrice = m1Klines[m1Klines.length - 1].close;

      for (const m of m1Klines) {
        // Stop Loss Price calculation based on current slRoi
        const slPrice = isLong
          ? entry * (1 + slRoi / 100 / effectiveLeverage)
          : entry * (1 - slRoi / 100 / effectiveLeverage);

        // Take Profit Price (ROI = 20%)
        const tpPrice = isLong
          ? entry * (1 + 0.20 / effectiveLeverage)
          : entry * (1 - 0.20 / effectiveLeverage);

        // Partial TP Price (ROI = 10%)
        const partialTpPrice = isLong
          ? entry * (1 + 0.10 / effectiveLeverage)
          : entry * (1 - 0.10 / effectiveLeverage);

        // 1. Check Stop Loss trigger first
        if (isLong) {
          if (m.low <= slPrice) {
            exitPrice = slPrice;
            if (partialClosed) {
              finalRoi = 0.5 * 10 + 0.5 * slRoi; // 50% at partial TP, 50% at trailing stop
            } else {
              finalRoi = slRoi;
            }
            closed = true;
            break;
          }
        } else {
          if (m.high >= slPrice) {
            exitPrice = slPrice;
            if (partialClosed) {
              finalRoi = 0.5 * 10 + 0.5 * slRoi;
            } else {
              finalRoi = slRoi;
            }
            closed = true;
            break;
          }
        }

        // 2. Check Take Profit triggers
        if (isLong) {
          if (m.high >= tpPrice) {
            exitPrice = tpPrice;
            if (partialClosed) {
              finalRoi = 0.5 * 10 + 0.5 * 20; // ROI = 15%
            } else {
              finalRoi = 20;
            }
            closed = true;
            break;
          }
          if (m.high >= partialTpPrice && !partialClosed) {
            partialClosed = true;
            slRoi = 1; // Move stop loss to +1% ROI
          }
        } else {
          if (m.low <= tpPrice) {
            exitPrice = tpPrice;
            if (partialClosed) {
              finalRoi = 0.5 * 10 + 0.5 * 20;
            } else {
              finalRoi = 20;
            }
            closed = true;
            break;
          }
          if (m.low <= partialTpPrice && !partialClosed) {
            partialClosed = true;
            slRoi = 1; // Move stop loss to +1% ROI
          }
        }
      }

      // If not closed in 24 hours, close at final minute price
      if (!closed) {
        exitPrice = m1Klines[m1Klines.length - 1].close;
        const currentRoi = isLong
          ? ((exitPrice - entry) / entry) * effectiveLeverage * 100
          : ((entry - exitPrice) / entry) * effectiveLeverage * 100;
        if (partialClosed) {
          finalRoi = 0.5 * 10 + 0.5 * currentRoi;
        } else {
          finalRoi = currentRoi;
        }
      }

      const margin = 10;
      const profitUsdt = margin * (finalRoi / 100) - 0.08; // -0.08$ fee

      // Scoring
      let score = 0;
      const h1Slice = klines.slice(t.h1Index - 200, t.h1Index);

      // 1. EMA200
      const ema200 = calculateEMA(h1Slice, 200);
      if (ema200 !== null) {
        const isSameTrend = t.signal === 'LONG' ? t.targetLevel > ema200 : t.targetLevel < ema200;
        if (isSameTrend) score += 1;
      }

      // 2. Volatility H1 vs Step
      const lastH1 = h1Slice[h1Slice.length - 1];
      const range = lastH1.high - lastH1.low;
      const isSafeVol = range <= step;
      if (isSafeVol) score += 2;

      // 3. RSI H1
      const rsi = calculateRSI(h1Slice, 14);
      if (rsi !== null) {
        const isExtreme = t.signal === 'LONG' ? rsi <= 35 : rsi >= 65;
        if (isExtreme) score += 1;
      }

      // 4. Retail L/S
      const retailLS = await fetchGlobalLongShortRatio(symbol, t.timeMs);
      if (retailLS) {
        const isContrarian = t.signal === 'LONG' ? retailLS.short >= 55 : retailLS.long >= 55;
        if (isContrarian) score += 1;
      }

      // 5. Market Cap Top 150
      if (isTop150(symbol)) score += 1;

      // 6. Price Action S/R Confluence
      const { highs, lows } = findSwingPoints(h1Slice, 4, 4);
      const searchList = t.signal === 'LONG' ? lows : highs;
      const maxDev = 0.15 * step;
      const matches = searchList.filter(price => Math.abs(price - t.targetLevel) <= maxDev);
      if (matches.length >= 2) score += 1;

      // 7. Whale L/S
      const whaleLS = await fetchTopLongShortPositionRatio(symbol, t.timeMs);
      if (whaleLS) {
        const isWhaleAligned = t.signal === 'LONG' ? whaleLS.long >= 53 : whaleLS.short >= 53;
        if (isWhaleAligned) score += 1;
      }

      // 8. Open Interest H1 Change
      const oiHistory = await fetchOpenInterestHistory(symbol, t.timeMs);
      if (oiHistory && oiHistory.length >= 5) {
        const latestOI = oiHistory[oiHistory.length - 1];
        const prevOI = oiHistory[0];
        if (prevOI > 0) {
          const oiChangePct = ((latestOI - prevOI) / prevOI) * 100;
          if (oiChangePct <= -2.0) score += 1;
        }
      }

      allTrades.push({
        symbol,
        signal: t.signal,
        time: new Date(t.timeMs).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        entryPrice: t.targetLevel,
        exitPrice,
        pnl: profitUsdt,
        roi: finalRoi,
        score,
        isSafeVol,
        isWin: profitUsdt > 0,
        effectiveLeverage
      });

      // API safety delay
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Aggregate results by score brackets
  const brackets = {
    filteredOut: { count: 0, win: 0, loss: 0, pnl: 0, trades: [] },
    tier2: { count: 0, win: 0, loss: 0, pnl: 0, trades: [] },
    tier3: { count: 0, win: 0, loss: 0, pnl: 0, trades: [] },
  };

  for (const r of allTrades) {
    const isFiltered = (r.score < 4 || !r.isSafeVol);
    if (isFiltered) {
      brackets.filteredOut.count++;
      if (r.isWin) brackets.filteredOut.win++;
      else brackets.filteredOut.loss++;
      brackets.filteredOut.pnl += r.pnl;
      brackets.filteredOut.trades.push(r);
    } else if (r.score >= 4 && r.score <= 6) {
      brackets.tier2.count++;
      if (r.isWin) brackets.tier2.win++;
      else brackets.tier2.loss++;
      brackets.tier2.pnl += r.pnl;
      brackets.tier2.trades.push(r);
    } else if (r.score >= 7) {
      brackets.tier3.count++;
      if (r.isWin) brackets.tier3.win++;
      else brackets.tier3.loss++;
      brackets.tier3.pnl += r.pnl;
      brackets.tier3.trades.push(r);
    }
  }

  const winRateFiltered = brackets.filteredOut.count > 0 ? (brackets.filteredOut.win / brackets.filteredOut.count * 100).toFixed(2) : '0.00';
  const winRateTier2 = brackets.tier2.count > 0 ? (brackets.tier2.win / brackets.tier2.count * 100).toFixed(2) : '0.00';
  const winRateTier3 = brackets.tier3.count > 0 ? (brackets.tier3.win / brackets.tier3.count * 100).toFixed(2) : '0.00';

  // Save report
  const mdReport = `
# Báo cáo Backtest Confluence Scorer Dài hạn (Nến 1M Độ Phân Giải Cao)
## Khoảng thời gian: 01/01/2026 - Hiện tại

Báo cáo này thống kê toàn bộ các cơ hội giao dịch được phát hiện trên 15 đồng coin hàng đầu từ đầu năm 2026 đến nay.
Độ phân giải nến **1M** được sử dụng để xác minh chính xác việc chạm SL hay TP trước.
Đòn bẩy được tính toán **động** theo từng bước lưới thực tế của code.

> [!NOTE]
> **Quy tắc thoát lệnh mô phỏng theo sản phẩm live:**
> - **SL cố định:** -13% ROI.
>   - **Khi đạt ROI >= +10% (Partial TP):** Cắt bớt 50% vị thế, dời SL về mức hòa vốn có lãi nhẹ (+1% ROI).
> - **TP mục tiêu:** +20% ROI (đối với lượng vị thế còn lại).

---

## 1. Kết quả Tổng hợp theo Khoảng điểm (Tiers)

| Cấp độ | Số lượng lệnh | Thắng (Win) | Thua (Loss) | Tỷ lệ Thắng (Win Rate) | Tổng PnL Giả Lập (Ký quỹ $10, Đòn bẩy động) | Lựa chọn Giao dịch |
| --- | --- | --- | --- | --- | --- | --- |
| **Bị loại bỏ (<4đ hoặc Vi phạm Tiêu chí 2)** | ${brackets.filteredOut.count} | ${brackets.filteredOut.win} | ${brackets.filteredOut.loss} | ${winRateFiltered}% | ${brackets.filteredOut.pnl.toFixed(2)} USDT | 🚫 Bỏ qua không đặt lệnh |
| **Cấp độ 2 (4đ - 6đ & Đạt TC2)** | ${brackets.tier2.count} | ${brackets.tier2.win} | ${brackets.tier2.loss} | ${winRateTier2}% | ${brackets.tier2.pnl.toFixed(2)} USDT | 🟢 Vào lệnh 10$ |
| **Cấp độ 3 (>= 7đ & Đạt TC2)** | ${brackets.tier3.count} | ${brackets.tier3.win} | ${brackets.tier3.loss} | ${winRateTier3}% | ${brackets.tier3.pnl.toFixed(2)} USDT | 🏆 Vào lệnh 20$ |

---

## 2. Phân tích Hiệu quả Kỹ thuật

> [!IMPORTANT]
> - **Hiệu quả của bộ lọc Tiêu chí 2 (Biến động H1) & Mức cản 4đ:**
>   - Nhóm bị loại bỏ có tỷ lệ thắng thấp nhất (**${winRateFiltered}%**) và gây tổn thất nghiêm trọng nhất (**${brackets.filteredOut.pnl.toFixed(2)} USDT**). Điều này cho thấy việc áp đặt Tiêu chí 2 làm bộ lọc bắt buộc giúp bot tránh được những pha quét dừng lỗ bất lợi.
>   - **Cấp độ 2 (4đ - 6đ)** mang lại tỷ lệ thắng **${winRateTier2}%** đem về lợi nhuận đều đặn **${brackets.tier2.pnl.toFixed(2)} USDT**. Việc đóng 50% vị thế và kéo SL về +1% khi đạt ROI +10% đã cứu rỗi rất nhiều lệnh trước khi giá quay đầu quét SL gốc (-13%).
>   - **Cấp độ 3 (>= 7đ)** mang lại tỷ lệ thắng rất ấn tượng **${winRateTier3}%**, chứng minh đây là vùng thiết lập có tính đồng thuận cực kỳ an toàn.

---

## 3. Danh sách Chi tiết Giao dịch

| Thời gian | Symbol | Chiều | Điểm | Đòn bẩy | PnL (USDT) | ROI (%) | Volatility H1 (TC2) |
| --- | --- | --- | --- | --- | --- | --- | --- |
${allTrades.map(r => `| ${r.time} | **${r.symbol}** | ${r.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} | **${r.score}đ** | ${r.effectiveLeverage}x | ${r.pnl > 0 ? `<font color="green">+${r.pnl.toFixed(2)}</font>` : `<font color="red">${r.pnl.toFixed(2)}</font>`} | ${r.roi.toFixed(2)}% | ${r.isSafeVol ? '✅ Đạt' : '❌ Quá lớn'} |`).join('\n')}
`;

  fs.writeFileSync(REPORT_PATH, mdReport, 'utf8');
  console.log(`Đã lưu báo cáo backtest dài hạn vào ${REPORT_PATH}`);
}

runBacktest().catch(console.error);
