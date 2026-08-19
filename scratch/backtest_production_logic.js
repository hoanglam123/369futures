const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const path = require('path');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');
const { buildLevelGrid, fetchH4Reference, getStep, getDecimals } = require('../src/pp369/core');

const stepSizesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/step_sizes.json'), 'utf8'));
const tickSizesCache = stepSizesData.tickSizes || {};
const leverageInfoCache = stepSizesData.leverageInfo || {};

function calculateTierSLTP(symbol, side, entryPrice, h4Ref, tickSize, maxExchangeLeverage, targetLossUSD = 5.0) {
  const step = h4Ref?.step || getStep(entryPrice);
  const decimals = h4Ref?.decimals || getDecimals(entryPrice);
  const upperPrice = h4Ref?.upperPrice || entryPrice;
  const lowerPrice = h4Ref?.lowerPrice || entryPrice;

  const distTicks = Math.ceil(Math.max(
    Math.abs(upperPrice - entryPrice),
    Math.abs(lowerPrice - entryPrice)
  ) / step);
  const levelsRange = Math.max(30, distTicks + 10);
  const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);

  let tierLong, tierShort;
  if (side === 'LONG' || side === 'BUY') {
    tierLong = grid.filter(l => l.type === 'tren' && l.value <= entryPrice * 1.005).pop()?.value || entryPrice;
    tierShort = grid.filter(l => l.type === 'duoi' && l.value <= entryPrice * 1.005).pop()?.value || (entryPrice - step * 0.1);
  } else {
    tierShort = grid.find(l => l.type === 'duoi' && l.value >= entryPrice * 0.995)?.value || entryPrice;
    tierLong = grid.find(l => l.type === 'tren' && l.value >= entryPrice * 0.995)?.value || (entryPrice + step * 0.1);
  }

  const effTickSize = tickSize || (decimals === 5 ? 0.00001 : (decimals === 4 ? 0.0001 : 0.000001));
  const buffer = Math.max(33 * effTickSize, step * 0.10, entryPrice * 0.003);
  let rawSL = (side === 'LONG' || side === 'BUY') ? (tierShort - buffer) : (tierLong + buffer);
  let slDist = Math.abs(entryPrice - rawSL);
  let slPct = (slDist / entryPrice) * 100;

  if (slPct < 1.0) {
    slPct = 1.0;
    slDist = entryPrice * 0.01;
    rawSL = (side === 'LONG' || side === 'BUY') ? (entryPrice - slDist) : (entryPrice + slDist);
  } else if (slPct > 3.5) {
    return { valid: false, reason: `SL theo Tier quá rộng (${slPct.toFixed(2)}% > 3.5%)` };
  }

  const calcLeverage = Math.max(1, Math.floor(50 / slPct));
  const leverage = Math.min(calcLeverage, maxExchangeLeverage || 20);
  const actualMargin = targetLossUSD / (leverage * (slPct / 100));
  const tpPrice = (side === 'LONG' || side === 'BUY') ? (entryPrice + slDist) : (entryPrice - slDist);
  const beTriggerPrice = (side === 'LONG' || side === 'BUY') ? (entryPrice + slDist * 0.5) : (entryPrice - slDist * 0.5);

  return {
    valid: true,
    slPrice: parseFloat(rawSL.toFixed(decimals)),
    tpPrice: parseFloat(tpPrice.toFixed(decimals)),
    beTriggerPrice: parseFloat(beTriggerPrice.toFixed(decimals)),
    slDistance: slDist,
    slPct: slPct,
    leverage: leverage,
    margin: actualMargin,
    targetLossUSD: targetLossUSD
  };
}

async function fetch1mKlines(symbol, startTime, limit = 1000) {
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: `${symbol}USDT`, interval: '1m', startTime, limit },
      timeout: 10000
    });
    return res.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));
  } catch (e) {
    return [];
  }
}

async function runProductionBacktest() {
  console.log('========================================================================');
  console.log('🚀 BACKTEST ĐỐI SOÁT PRODUCTION LOGIC MỚI (Tier SL/TP + Dời SL 50% + AI)');
  console.log('========================================================================');

  const fileStream = fs.createReadStream(path.join(__dirname, '../data/369_signals.jsonl'));
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const signals = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const sig = JSON.parse(line);
      if (sig.ts && sig.ts >= '2026-08-14') {
        signals.push(sig);
      }
    } catch (e) {}
  }

  console.log(`✓ Đã nạp ${signals.length} tín hiệu từ ngày 14/08/2026 đến nay.`);

  const results = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const sym = sig.symbol;
    const entry = sig.targetLevel || sig.price;
    const h4Ref = await fetchH4Reference(sym);
    const tickSize = tickSizesCache[`${sym}USDT`] || 0.00001;
    const maxAllowed = leverageInfoCache[sym] || 20;

    const setup = calculateTierSLTP(sym, sig.signal, entry, h4Ref, tickSize, maxAllowed, 5.0);
    if (!setup.valid) continue;

    const aiEval = evaluateSignalWithAI({ ...sig, targetLevel: entry });
    const sigTimeMs = new Date(sig.ts).getTime();

    // Tải nến 1m để mô phỏng khớp lệnh thực tế
    const klines = await fetch1mKlines(sym, sigTimeMs, 1000);
    if (klines.length === 0) continue;

    const isLong = sig.signal === 'LONG';
    const sl = setup.slPrice;
    const tp = setup.tpPrice;
    const beTrigger = setup.beTriggerPrice;

    let isFilled = false;
    let fillTime = 0;
    let isBreakeven = false;
    let outcome = 'RUNNING';
    let exitTime = 0;

    for (const k of klines) {
      if (!isFilled) {
        if (isLong && k.low <= entry) {
          isFilled = true;
          fillTime = k.time;
        } else if (!isLong && k.high >= entry) {
          isFilled = true;
          fillTime = k.time;
        }
        continue;
      }

      // Khi đã khớp lệnh:
      if (isLong) {
        // Kiểm tra xem đã đạt 50% TP để dời SL về hòa vốn chưa
        if (k.high >= beTrigger) {
          isBreakeven = true;
        }

        // Kiểm tra dính SL hoặc SL Hòa vốn
        const activeSL = isBreakeven ? entry : sl;
        if (k.low <= activeSL) {
          outcome = isBreakeven ? 'BREAKEVEN' : 'LOSS';
          exitTime = k.time;
          break;
        }

        // Kiểm tra chốt lời TP 1:1
        if (k.high >= tp) {
          outcome = 'WIN';
          exitTime = k.time;
          break;
        }
      } else {
        // SHORT
        if (k.low <= beTrigger) {
          isBreakeven = true;
        }

        const activeSL = isBreakeven ? entry : sl;
        if (k.high >= activeSL) {
          outcome = isBreakeven ? 'BREAKEVEN' : 'LOSS';
          exitTime = k.time;
          break;
        }

        if (k.low <= tp) {
          outcome = 'WIN';
          exitTime = k.time;
          break;
        }
      }
    }

    if (isFilled) {
      results.push({
        sig,
        setup,
        aiEval,
        outcome,
        fillTime,
        exitTime
      });
    }

    if (i % 20 === 0 && i > 0) {
      process.stdout.write(`... Đang xử lý ${i}/${signals.length} tín hiệu\r`);
    }
  }

  console.log('\n========================================================================');
  console.log('📊 TỔNG HỢP HIỆU SUẤT BACKTEST THEO CÁC CHẾ ĐỘ LỌC');
  console.log('========================================================================');

  function printModeStats(title, list) {
    const total = list.length;
    const wins = list.filter(r => r.outcome === 'WIN').length;
    const bes = list.filter(r => r.outcome === 'BREAKEVEN').length;
    const losses = list.filter(r => r.outcome === 'LOSS').length;
    const runnings = list.filter(r => r.outcome === 'RUNNING').length;

    const netPnl = wins * 5.0 - losses * 5.0;
    const noLossRate = total > 0 ? (((wins + bes) / (total - runnings)) * 100).toFixed(1) : '0.0';
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

    console.log(`\n📌 ${title}`);
    console.log(`------------------------------------------------------------------------`);
    console.log(`• Tổng số lệnh đã khớp:     ${total} lệnh (Đang chạy: ${runnings})`);
    console.log(`• 🟢 Lệnh Thắng (+5$):       ${wins} (${total > 0 ? ((wins/total)*100).toFixed(1) : 0}%)`);
    console.log(`• 🟡 Lệnh Hòa Vốn ($0):      ${bes} (${total > 0 ? ((bes/total)*100).toFixed(1) : 0}%)`);
    console.log(`• 🔴 Lệnh Thua (-5$):        ${losses} (${total > 0 ? ((losses/total)*100).toFixed(1) : 0}%)`);
    console.log(`• 🛡️ TỶ LỆ KHÔNG LỖ (W+BE):  ${noLossRate}%`);
    console.log(`• 🎯 WIN RATE THỰC TẾ:       ${winRate}%`);
    console.log(`• 💰 LỢI NHUẬN RÒNG (PnL):   ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} USD`);
    console.log(`------------------------------------------------------------------------`);
  }

  printModeStats('CHẾ ĐỘ 1: TẤT CẢ TÍN HIỆU 369 (RAW)', results);
  printModeStats('CHẾ ĐỘ 2: LỌC SCORE >= 3.5đ', results.filter(r => (r.sig.score || 0) >= 3.5));
  printModeStats('CHẾ ĐỘ 3: LỌC SCORE >= 4.0đ', results.filter(r => (r.sig.score || 0) >= 4.0));
  printModeStats('CHẾ ĐỘ 4: LỌC SCORE >= 4.5đ', results.filter(r => (r.sig.score || 0) >= 4.5));
  printModeStats('CHẾ ĐỘ 5: LỌC SCORE >= 5.0đ (HIGH CONFIDENCE)', results.filter(r => (r.sig.score || 0) >= 5.0));

  console.log('\n========================================================================');
  console.log('✅ HOÀN TẤT KIỂM THỬ TOÀN DIỆN');
  console.log('========================================================================\n');
}

runProductionBacktest().catch(console.error);
