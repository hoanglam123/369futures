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

async function runScoreBreakdown() {
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

  const processed = [];
  for (const sig of debouncedSignals) {
    const sym = sig.symbol;
    const side = sig.signal;
    const entryPrice = sig.price;
    const entryTime = new Date(sig.ts).getTime();
    const score = sig.score || 0;

    const h4 = h4Cache[sym];
    if (!h4 || h4.failed) continue;

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
      continue;
    }

    const tpPrice = side === 'LONG' ? (entryPrice + slDist) : (entryPrice - slDist);
    const beTriggerPrice = side === 'LONG' ? (entryPrice + slDist * 0.5) : (entryPrice - slDist * 0.5);

    const klines = await fetch1mKlines(sym, entryTime, 1440);
    if (!klines.length) continue;

    let isBreakevenActive = false;
    let outcome = 'RUNNING';

    for (const k of klines) {
      if (side === 'LONG') {
        if (!isBreakevenActive && k.high >= beTriggerPrice) isBreakevenActive = true;
        if (k.high >= tpPrice) {
          outcome = 'WIN';
          break;
        }
        if (isBreakevenActive && k.low <= entryPrice) {
          outcome = 'BREAKEVEN';
          break;
        } else if (!isBreakevenActive && k.low <= rawSL) {
          outcome = 'LOSS';
          break;
        }
      } else {
        if (!isBreakevenActive && k.low <= beTriggerPrice) isBreakevenActive = true;
        if (k.low <= tpPrice) {
          outcome = 'WIN';
          break;
        }
        if (isBreakevenActive && k.high >= entryPrice) {
          outcome = 'BREAKEVEN';
          break;
        } else if (!isBreakevenActive && k.high >= rawSL) {
          outcome = 'LOSS';
          break;
        }
      }
    }

    processed.push({ symbol: sym, side, score, outcome });
    await new Promise(r => setTimeout(r, 15));
  }

  const scoreThresholds = [0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
  console.log('=== SO SÁNH HIỆU QUẢ THEO CÁC MỨC SCORE (CORE CONFLUENCE) ===');
  console.log('Score Min | Lệnh | Thắng | Hòa | Thua | WinRate% | KhôngLỗ% | Net PnL');
  console.log('----------------------------------------------------------------------');

  scoreThresholds.forEach(th => {
    const list = processed.filter(p => p.score >= th);
    const wins = list.filter(p => p.outcome === 'WIN').length;
    const bes = list.filter(p => p.outcome === 'BREAKEVEN').length;
    const losses = list.filter(p => p.outcome === 'LOSS').length;
    const total = wins + bes + losses;
    const wr = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';
    const noLoss = total > 0 ? (((wins + bes) / total) * 100).toFixed(1) : '0.0';
    const pnl = wins * 5 - losses * 5;
    console.log(`${th.toFixed(1).toString().padEnd(9)} | ${total.toString().padEnd(4)} | ${wins.toString().padEnd(5)} | ${bes.toString().padEnd(3)} | ${losses.toString().padEnd(4)} | ${wr.padEnd(8)} | ${noLoss.padEnd(8)} | ${pnl >= 0 ? '+' : ''}${pnl}$`);
  });
}

runScoreBreakdown().catch(console.error);
