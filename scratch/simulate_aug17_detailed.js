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

async function simulateFromAug17() {
  const fileStream = fs.createReadStream(path.join(__dirname, '..', 'data', 'ai_evaluations.jsonl'));
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  // 17/08/2026 00:00:00 UTC = 1786838400000 ms
  const START_MS = new Date('2026-08-17T00:00:00Z').getTime();

  const signals = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.timestamp && data.timestamp >= START_MS) {
        signals.push(data);
      }
    } catch(e){}
  }

  // Debounce signals per symbol+signal within 15 mins
  const debounced = [];
  const lastTime = {};
  for (const s of signals) {
    const key = `${s.symbol}_${s.signal}_${s.targetLevel}`;
    if (!lastTime[key] || (s.timestamp - lastTime[key] > 15 * 60 * 1000)) {
      debounced.push(s);
      lastTime[key] = s.timestamp;
    }
  }

  console.log(`\n========================================================================================`);
  console.log(`BÁO CÁO CHI TIẾT TỪNG LỆNH TỪ NGÀY 17/08/2026 ĐẾN NAY (19/08/2026)`);
  console.log(`Áp dụng Full Logic: AI Veto/Review + LIMIT Entry + Tier SL (1%-3.5%) + Dời SL 50% TP + Trailing`);
  console.log(`Tổng số tín hiệu ghi nhận: ${debounced.length}`);
  console.log(`========================================================================================\n`);

  const results = [];

  for (let i = 0; i < debounced.length; i++) {
    const sig = debounced[i];
    const sym = sig.symbol;
    const side = sig.signal;
    const targetEntry = sig.targetLevel;
    const timeStr = new Date(sig.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const score = sig.score || 0;
    const winProb = sig.winProbability || 0;

    // AI Veto Filter (WinProb < 45% or (VOL_DRY and OI_COOLING))
    const isAiVeto = (winProb < 45.0) || (sig.aiReason && sig.aiReason.includes('VOL_DRY') && sig.aiReason.includes('OI_COOLING'));

    const h4 = h4Cache[sym];
    if (!h4 || h4.failed) {
      results.push({
        timeStr, sym, side, score, winProb,
        status: 'SKIPPED',
        reason: 'Không có nến H4 gốc',
        pnl: 0
      });
      continue;
    }

    if (isAiVeto) {
      results.push({
        timeStr, sym, side, score, winProb,
        status: 'AI_VETO_BLOCKED',
        reason: `AI Phủ quyết (WinProb ${winProb.toFixed(1)}% < 45% hoặc cạn Vol+OI)`,
        pnl: 0
      });
      continue;
    }

    const tickSize = tickSizes[`${sym}USDT`] || (h4.decimals === 5 ? 0.00001 : (h4.decimals === 4 ? 0.0001 : 0.000001));
    const grid = buildGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 40);

    let tierLong, tierShort;
    if (side === 'LONG') {
      tierLong = grid.filter(l => l.type === 'tren' && l.value <= targetEntry * 1.005).pop()?.value || targetEntry;
      tierShort = grid.filter(l => l.type === 'duoi' && l.value <= targetEntry * 1.005).pop()?.value || (targetEntry - h4.step * 0.1);
    } else {
      tierShort = grid.find(l => l.type === 'duoi' && l.value >= targetEntry * 0.995)?.value || targetEntry;
      tierLong = grid.find(l => l.type === 'tren' && l.value >= targetEntry * 0.995)?.value || (targetEntry + h4.step * 0.1);
    }

    const buffer = Math.max(33 * tickSize, h4.step * 0.10, targetEntry * 0.003);
    let rawSL = side === 'LONG' ? (tierShort - buffer) : (tierLong + buffer);
    let slDist = Math.abs(targetEntry - rawSL);
    let slPct = (slDist / targetEntry) * 100;

    if (slPct < 1.0) {
      slPct = 1.0;
      slDist = targetEntry * 0.01;
      rawSL = side === 'LONG' ? (targetEntry - slDist) : (targetEntry + slDist);
    } else if (slPct > 3.5) {
      results.push({
        timeStr, sym, side, score, winProb,
        status: 'SKIPPED',
        reason: `SL quá rộng (${slPct.toFixed(2)}% > 3.5%)`,
        pnl: 0
      });
      continue;
    }

    const tpPrice = side === 'LONG' ? (targetEntry + slDist) : (targetEntry - slDist);
    const beTriggerPrice = side === 'LONG' ? (targetEntry + slDist * 0.5) : (targetEntry - slDist * 0.5);

    // Fetch 1m klines starting from signal time
    const klines = await fetch1mKlines(sym, sig.timestamp, 1440);
    if (!klines.length) {
      results.push({
        timeStr, sym, side, score, winProb,
        status: 'NO_DATA',
        reason: 'Không lấy được nến 1m',
        pnl: 0
      });
      continue;
    }

    // Check if LIMIT order was FILLED or BOUNCE CANCELLED
    let isFilled = false;
    let fillIndex = -1;
    const unit = h4.step / 3;
    const bounceDistance = unit * 0.40;
    const bouncePct = (bounceDistance / targetEntry) * 100;

    for (let kIdx = 0; kIdx < Math.min(klines.length, 60); kIdx++) { // 60 mins limit timeout
      const k = klines[kIdx];
      if (side === 'LONG') {
        if (k.low <= targetEntry) {
          isFilled = true;
          fillIndex = kIdx;
          break;
        }
        // Check bounce cancel
        if (k.high >= targetEntry * (1 + bouncePct / 100)) {
          break; // Bounced away -> Cancel
        }
      } else {
        if (k.high >= targetEntry) {
          isFilled = true;
          fillIndex = kIdx;
          break;
        }
        if (k.low <= targetEntry * (1 - bouncePct / 100)) {
          break; // Bounced away -> Cancel
        }
      }
    }

    if (!isFilled) {
      results.push({
        timeStr, sym, side, score, winProb,
        status: 'BOUNCE_CANCELED',
        reason: 'Giá bật nảy xa mốc mà không khớp LIMIT (Bảo vệ vốn)',
        pnl: 0
      });
      continue;
    }

    // Trade execution simulation after Fill
    let isBreakevenActive = false;
    let outcome = 'RUNNING';
    let exitPrice = 0;
    let exitTimeStr = '';

    for (let kIdx = fillIndex; kIdx < klines.length; kIdx++) {
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
        if (isBreakevenActive && k.low <= targetEntry) {
          outcome = 'BREAKEVEN';
          exitPrice = targetEntry;
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
        if (isBreakevenActive && k.high >= targetEntry) {
          outcome = 'BREAKEVEN';
          exitPrice = targetEntry;
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
      timeStr, sym, side, score, winProb,
      entry: targetEntry,
      sl: parseFloat(rawSL.toFixed(6)),
      tp: parseFloat(tpPrice.toFixed(6)),
      slPct: slPct.toFixed(2) + '%',
      status: outcome,
      pnl: pnl,
      exitTime: exitTimeStr
    });

    await new Promise(r => setTimeout(r, 20));
  }

  console.log('DANH SÁCH CHI TIẾT TỪNG LỆNH:');
  console.log('------------------------------------------------------------------------------------------------------------------------');
  results.forEach((r, idx) => {
    const num = (idx + 1).toString().padStart(2, ' ');
    if (r.status === 'WIN') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | ✅ THẮNG (Chạm TP) | PnL: +5$ | Thoát lúc: ${r.exitTime}`);
    } else if (r.status === 'BREAKEVEN') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | 🛡️ HÒA VỐN (Dời SL 50%) | PnL:  0$ | Thoát lúc: ${r.exitTime}`);
    } else if (r.status === 'LOSS') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Entry: ${r.entry} | SL: ${r.sl} (${r.slPct}) | TP: ${r.tp} | ❌ THUA (Dính Full SL) | PnL: -5$ | Thoát lúc: ${r.exitTime}`);
    } else if (r.status === 'BOUNCE_CANCELED') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Score: +${r.score}đ | WinProb: ${r.winProb}% | 🔄 HỦY LIMIT (Giá nảy xa mốc mà không khớp)`);
    } else if (r.status === 'AI_VETO_BLOCKED') {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Score: +${r.score}đ | WinProb: ${r.winProb}% | 🛑 AI VETO CHẶN (${r.reason})`);
    } else {
      console.log(`[#${num}] ${r.timeStr} | ${r.sym.padEnd(8)} ${r.side.padEnd(5)} | Score: +${r.score}đ | ⏭️ BỎ QUA (${r.reason})`);
    }
  });

  const trades = results.filter(r => ['WIN', 'BREAKEVEN', 'LOSS'].includes(r.status));
  const wins = trades.filter(t => t.status === 'WIN').length;
  const bes = trades.filter(t => t.status === 'BREAKEVEN').length;
  const losses = trades.filter(t => t.status === 'LOSS').length;
  const totalPnL = wins * 5 - losses * 5;

  console.log('\n========================================================================================');
  console.log('TỔNG KẾT TỪ NGÀY 17/08 ĐẾN NAY (19/08/2026):');
  console.log(`- Tổng số tín hiệu AI quét: ${results.length}`);
  console.log(`- Số lệnh thực sự khớp (Filled Trades): ${trades.length}`);
  console.log(`  + 🟢 Thắng (+5$):   ${wins} (${((wins/trades.length)*100).toFixed(1)}%)`);
  console.log(`  + 🟡 Hòa vốn (0$):  ${bes} (${((bes/trades.length)*100).toFixed(1)}%)`);
  console.log(`  + 🔴 Thua (-5$):    ${losses} (${((losses/trades.length)*100).toFixed(1)}%)`);
  console.log(`- Tỷ lệ Không Thua Lỗ (Thắng + Hòa): ${(((wins + bes)/trades.length)*100).toFixed(1)}%`);
  console.log(`- Win Rate thực tế (Thắng / (Thắng + Thua)): ${((wins/(wins+losses))*100).toFixed(1)}%`);
  console.log(`- TỔNG LỢI NHUẬN RÒNG (Net PnL): ${totalPnL >= 0 ? '+' : ''}${totalPnL} USD`);
  console.log('========================================================================================\n');
}

simulateFromAug17().catch(console.error);
