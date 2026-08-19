const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const path = require('path');

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

async function runBacktest() {
  const fileStream = fs.createReadStream(path.join(__dirname, '..', 'data', '369_signals.jsonl'));
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const rawSignals = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.ts && data.ts >= '2026-08-14') {
        rawSignals.push(data);
      }
    } catch(e){}
  }

  // Debounce signals: Cùng 1 symbol và side trong vòng 15 phút chỉ lấy 1 tín hiệu
  const debouncedSignals = [];
  const lastSignalTime = {};
  for (const s of rawSignals) {
    const key = `${s.symbol}_${s.signal}`;
    const t = new Date(s.ts).getTime();
    if (!lastSignalTime[key] || (t - lastSignalTime[key] > 15 * 60 * 1000)) {
      debouncedSignals.push(s);
      lastSignalTime[key] = t;
    }
  }

  console.log(`\n======================================================`);
  console.log(`BACKTEST CHIẾN LƯỢC MỚI (Từ 14/08/2026 đến 19/08/2026)`);
  console.log(`Số tín hiệu sau debounce: ${debouncedSignals.length}`);
  console.log(`Quy tắc: SL = Tier + Buffer (Clamp 1.0% - 3.5%), TP 1:1, Dời SL hòa vốn tại 50% TP, PnL loss = $5, TP = +$5`);
  console.log(`======================================================\n`);

  let totalWin = 0;
  let totalLoss = 0;
  let totalBreakeven = 0;
  let totalSkipped = 0;
  let totalRunning = 0;
  let totalPnL = 0;

  const tradeLogs = [];

  for (let idx = 0; idx < debouncedSignals.length; idx++) {
    const sig = debouncedSignals[idx];
    const sym = sig.symbol;
    const side = sig.signal;
    const entryPrice = sig.price;
    const entryTime = new Date(sig.ts).getTime();

    const h4 = h4Cache[sym];
    if (!h4 || h4.failed) {
      totalSkipped++;
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
      totalSkipped++;
      continue;
    }

    const tpPrice = side === 'LONG' ? (entryPrice + slDist) : (entryPrice - slDist);
    const beTriggerPrice = side === 'LONG' ? (entryPrice + slDist * 0.5) : (entryPrice - slDist * 0.5);

    // Fetch 1m klines starting from entryTime
    const klines = await fetch1mKlines(sym, entryTime, 1440); // 24 hours max
    if (!klines.length) {
      totalSkipped++;
      continue;
    }

    let isBreakevenActive = false;
    let outcome = 'RUNNING'; // 'WIN', 'LOSS', 'BREAKEVEN', 'RUNNING'
    let exitPrice = 0;
    let exitTimeStr = '';

    for (const k of klines) {
      if (side === 'LONG') {
        // Check 50% TP for Breakeven
        if (!isBreakevenActive && k.high >= beTriggerPrice) {
          isBreakevenActive = true;
        }

        // Check TP
        if (k.high >= tpPrice) {
          outcome = 'WIN';
          exitPrice = tpPrice;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        }

        // Check SL
        if (isBreakevenActive && k.low <= entryPrice) {
          outcome = 'BREAKEVEN';
          exitPrice = entryPrice;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        } else if (!isBreakevenActive && k.low <= rawSL) {
          outcome = 'LOSS';
          exitPrice = rawSL;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        }
      } else { // SHORT
        // Check 50% TP for Breakeven
        if (!isBreakevenActive && k.low <= beTriggerPrice) {
          isBreakevenActive = true;
        }

        // Check TP
        if (k.low <= tpPrice) {
          outcome = 'WIN';
          exitPrice = tpPrice;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        }

        // Check SL
        if (isBreakevenActive && k.high >= entryPrice) {
          outcome = 'BREAKEVEN';
          exitPrice = entryPrice;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        } else if (!isBreakevenActive && k.high >= rawSL) {
          outcome = 'LOSS';
          exitPrice = rawSL;
          exitTimeStr = new Date(k.openTime).toISOString().replace('T', ' ').substring(0, 19);
          break;
        }
      }
    }

    let pnl = 0;
    if (outcome === 'WIN') {
      totalWin++;
      pnl = 5;
      totalPnL += 5;
    } else if (outcome === 'LOSS') {
      totalLoss++;
      pnl = -5;
      totalPnL -= 5;
    } else if (outcome === 'BREAKEVEN') {
      totalBreakeven++;
      pnl = 0;
    } else {
      totalRunning++;
    }

    tradeLogs.push({
      time: sig.ts,
      symbol: sym,
      side: side,
      entry: entryPrice,
      sl: parseFloat(rawSL.toFixed(6)),
      tp: parseFloat(tpPrice.toFixed(6)),
      slPct: slPct.toFixed(2) + '%',
      outcome: outcome,
      pnl: (pnl >= 0 ? '+' : '') + pnl + '$',
      exitTime: exitTimeStr
    });

    // Sleep 15ms to avoid rate limit
    await new Promise(r => setTimeout(r, 15));
  }

  console.log(`--- CHI TIẾT TỪNG LỆNH ---`);
  tradeLogs.slice(0, 20).forEach(t => {
    console.log(`[${t.time}] ${t.symbol.padEnd(8)} ${t.side.padEnd(5)} | Entry: ${t.entry} | SL: ${t.sl} (${t.slPct}) | TP: ${t.tp} | KẾT QUẢ: ${t.outcome.padEnd(9)} | PnL: ${t.pnl}`);
  });
  if (tradeLogs.length > 20) {
    console.log(`... và ${tradeLogs.length - 20} lệnh tiếp theo.`);
  }

  console.log(`\n======================================================`);
  console.log(`TỔNG KẾT HIỆU QUẢ TỪ 14/08/2026 ĐẾN NAY:`);
  console.log(`- Tổng số lệnh thực hiện: ${tradeLogs.length}`);
  console.log(`- Lệnh THẮNG (Chạm TP +$5):       ${totalWin} (${((totalWin/tradeLogs.length)*100).toFixed(1)}%)`);
  console.log(`- Lệnh HÒA VỐN (Dời SL về BE $0): ${totalBreakeven} (${((totalBreakeven/tradeLogs.length)*100).toFixed(1)}%)`);
  console.log(`- Lệnh THUA (Dính Full SL -$5):   ${totalLoss} (${((totalLoss/tradeLogs.length)*100).toFixed(1)}%)`);
  console.log(`- Lệnh chưa đóng (Đang chạy):     ${totalRunning}`);
  console.log(`- Bỏ qua (SL > 3.5% / lỗi data):  ${totalSkipped}`);
  console.log(`------------------------------------------------------`);
  const winRateEffective = ((totalWin / (totalWin + totalLoss)) * 100).toFixed(1);
  console.log(`- Win Rate thực tế (Thắng / (Thắng + Thua)): ${winRateEffective}%`);
  console.log(`- TỔNG LỢI NHUẬN RÒNG (PnL): ${totalPnL >= 0 ? '+' : ''}${totalPnL} USD`);
  console.log(`======================================================\n`);
}

runBacktest().catch(console.error);
