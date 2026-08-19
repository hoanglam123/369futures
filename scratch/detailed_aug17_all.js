const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const path = require('path');
const { evaluateSignalWithAI } = require('../src/pp369/aiReviewer');

const ssPath = path.join(__dirname, '..', 'data', 'step_sizes.json');
const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
const h4Cache = ss.h4Cache || {};
const tickSizes = ss.tickSizes || {};

async function fetch1mKlines(symbol, startTime, limit = 1500) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=1m&startTime=${startTime}&limit=${limit}`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    return res.data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));
  } catch (err) {
    return [];
  }
}

function buildGrid(upperPrice, lowerPrice, step, decimals, levelsRange = 30) {
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

async function runDetailedAug17All() {
  const fileStream = fs.createReadStream(path.join(__dirname, '..', 'data', '369_signals.jsonl'));
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const rawSignals = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.ts && data.ts >= '2026-08-17') {
        rawSignals.push(data);
      }
    } catch(e){}
  }

  console.log(`\n========================================================================================`);
  console.log(`CHI TIẾT TOÀN BỘ ${rawSignals.length} TÍN HIỆU TỪ NGÀY 17/08/2026 ĐẾN NAY (19/08/2026)`);
  console.log(`Mô phỏng khớp lệnh trực tiếp tại Mốc + Stoploss theo Tier (1.0% - 3.5%) + Dời SL 50% TP`);
  console.log(`========================================================================================\n`);

  const results = [];

  for (let i = 0; i < rawSignals.length; i++) {
    const sig = rawSignals[i];
    const sym = sig.symbol;
    const side = sig.signal;
    const entryPrice = sig.price;
    const entryTime = new Date(sig.ts).getTime();
    const timeStr = new Date(sig.ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const score = sig.score || 0;

    const aiRes = evaluateSignalWithAI(sig);
    const winProb = aiRes.winProbability || 50;

    const h4 = h4Cache[sym];
    if (!h4 || h4.failed) {
      results.push({
        num: i + 1, timeStr, sym, side, score, winProb,
        outcome: 'SKIPPED',
        reason: 'Không có nến H4 gốc',
        pnl: 0
      });
      continue;
    }

    const tickSize = tickSizes[`${sym}USDT`] || (h4.decimals === 5 ? 0.00001 : (h4.decimals === 4 ? 0.0001 : 0.000001));
    const grid = buildGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 40);

    let tierLong, tierShort;
    if (side === 'LONG') {
      tierLong = grid.filter(l => l.type === 'tren' && l.value <= entryPrice * 1.005).pop()?.value || entryPrice;
      tierShort = grid.filter(l => l.type === 'duoi' && l.value <= entryPrice * 1.005).pop()?.value || (entryPrice - h4.step * 0.1);
    } else {
      tierShort = grid.find(l => l.type === 'duoi' && l.value >= entryPrice * 0.995)?.value || entryPrice;
      tierLong = grid.find(l => l.type === 'tren' && l.value >= entryPrice * 0.995)?.value || (entryPrice + h4.step * 0.1);
    }

    const buffer = Math.max(33 * tickSize, h4.step * 0.10, entryPrice * 0.003);
    let rawSL = side === 'LONG' ? (tierShort - buffer) : (tierLong + buffer);
    let slDist = Math.abs(entryPrice - rawSL);
    let slPct = (slDist / entryPrice) * 100;

    if (slPct < 1.0) {
      slPct = 1.0;
      slDist = entryPrice * 0.01;
      rawSL = side === 'LONG' ? (entryPrice - slDist) : (entryPrice + slDist);
    } else if (slPct > 3.5) {
      results.push({
        num: i + 1, timeStr, sym, side, score, winProb,
        outcome: 'SKIPPED',
        reason: `SL quá rộng (${slPct.toFixed(2)}% > 3.5%)`,
        pnl: 0
      });
      continue;
    }

    const tpPrice = side === 'LONG' ? (entryPrice + slDist) : (entryPrice - slDist);
    const beTriggerPrice = side === 'LONG' ? (entryPrice + slDist * 0.5) : (entryPrice - slDist * 0.5);

    const klines = await fetch1mKlines(sym, entryTime, 1440);
    if (!klines.length) {
      results.push({
        num: i + 1, timeStr, sym, side, score, winProb,
        outcome: 'NO_DATA',
        reason: 'Không lấy được nến 1m',
        pnl: 0
      });
      continue;
    }

    let isBreakevenActive = false;
    let outcome = 'RUNNING';
    let exitPrice = 0;
    let exitTimeStr = '';

    for (let kIdx = 0; kIdx < klines.length; kIdx++) {
      const k = klines[kIdx];
      if (side === 'LONG') {
        if (!isBreakevenActive && k.high >= beTriggerPrice) {
          isBreakevenActive = true;
        }
        if (k.high >= tpPrice) {
          outcome = 'WIN';
          exitPrice = tpPrice;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        }
        if (isBreakevenActive && k.low <= entryPrice) {
          outcome = 'BREAKEVEN';
          exitPrice = entryPrice;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        } else if (!isBreakevenActive && k.low <= rawSL) {
          outcome = 'LOSS';
          exitPrice = rawSL;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        }
      } else {
        if (!isBreakevenActive && k.low <= beTriggerPrice) {
          isBreakevenActive = true;
        }
        if (k.low <= tpPrice) {
          outcome = 'WIN';
          exitPrice = tpPrice;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        }
        if (isBreakevenActive && k.high >= entryPrice) {
          outcome = 'BREAKEVEN';
          exitPrice = entryPrice;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        } else if (!isBreakevenActive && k.high >= rawSL) {
          outcome = 'LOSS';
          exitPrice = rawSL;
          exitTimeStr = new Date(k.openTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          break;
        }
      }
    }

    let pnl = 0;
    if (outcome === 'WIN') pnl = 5;
    else if (outcome === 'LOSS') pnl = -5;
    else if (outcome === 'BREAKEVEN') pnl = 0;

    results.push({
      num: i + 1,
      timeStr, sym, side, score, winProb,
      entry: entryPrice,
      sl: parseFloat(rawSL.toFixed(6)),
      tp: parseFloat(tpPrice.toFixed(6)),
      slPct: slPct.toFixed(2) + '%',
      outcome: outcome,
      pnl: pnl,
      exitTime: exitTimeStr
    });

    await new Promise(r => setTimeout(r, 20));
  }

  results.forEach(r => {
    const num = r.num.toString().padStart(2, ' ');
    if (r.outcome === 'WIN') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(9)} ${r.side.padEnd(5)} | Score: +${r.score}đ | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | ✅ THẮNG (+5$) | Thoát: ${r.exitTime}`);
    } else if (r.outcome === 'BREAKEVEN') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(9)} ${r.side.padEnd(5)} | Score: +${r.score}đ | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | 🛡️ HÒA VỐN ($0)  | Thoát: ${r.exitTime}`);
    } else if (r.outcome === 'LOSS') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(9)} ${r.side.padEnd(5)} | Score: +${r.score}đ | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | ❌ THUA (-5$)   | Thoát: ${r.exitTime}`);
    } else {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(9)} ${r.side.padEnd(5)} | Score: +${r.score}đ | ⏭️ ${r.outcome} (${r.reason})`);
    }
  });

  const validTrades = results.filter(r => ['WIN', 'BREAKEVEN', 'LOSS'].includes(r.outcome));
  const wins = validTrades.filter(t => t.outcome === 'WIN').length;
  const bes = validTrades.filter(t => t.outcome === 'BREAKEVEN').length;
  const losses = validTrades.filter(t => t.outcome === 'LOSS').length;
  const totalPnL = wins * 5 - losses * 5;

  console.log('\n========================================================================================');
  console.log('TỔNG KẾT TOÀN DIỆN (17/08 - 19/08/2026):');
  console.log(`- Tổng số lệnh phát sinh: ${validTrades.length}`);
  console.log(`  + 🟢 Lệnh Thắng (+5$):   ${wins} (${((wins/validTrades.length)*100).toFixed(1)}%)`);
  console.log(`  + 🟡 Lệnh Hòa Vốn (0$):  ${bes} (${((bes/validTrades.length)*100).toFixed(1)}%)`);
  console.log(`  + 🔴 Lệnh Thua (-5$):    ${losses} (${((losses/validTrades.length)*100).toFixed(1)}%)`);
  console.log(`- Tỷ lệ Không Thua Lỗ: ${(((wins + bes)/validTrades.length)*100).toFixed(1)}%`);
  console.log(`- Win Rate thực tế: ${((wins/(wins+losses))*100).toFixed(1)}%`);
  console.log(`- TỔNG LỢI NHUẬN RÒNG: ${totalPnL >= 0 ? '+' : ''}${totalPnL} USD`);
  console.log('========================================================================================\n');
}

runDetailedAug17All().catch(console.error);
