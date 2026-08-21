require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const readline = require('readline');

const BASE = 'https://fapi.binance.com';

async function loadSignals() {
  const rl = readline.createInterface({ input: fs.createReadStream('data/369_signals.jsonl') });
  const signals = [];
  const startTime = new Date('2026-08-14T00:00:00+07:00').getTime();
  
  for await (const line of rl) {
    if (line.trim()) {
      const s = JSON.parse(line);
      const tsStr = s.ts?.includes('+') || s.ts?.includes('Z') ? s.ts : `${s.ts}+07:00`;
      const t = new Date(tsStr).getTime();
      if (t >= startTime) {
        signals.push({
          ...s,
          symbolUSDT: `${s.symbol}USDT`,
          time: t
        });
      }
    }
  }
  return signals;
}

// Fetch M15 klines from Binance
async function fetchM15Klines(symbol, startTime, limit = 40) {
  try {
    const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&limit=${limit}`);
    return res.data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6]
    }));
  } catch (e) {
    return [];
  }
}

// Fetch 1m klines from Binance for precise trade execution
async function fetch1mKlines(symbol, startTime, limit = 360) {
  try {
    const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=${limit}`);
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

// Load AI evaluations from log or cache
async function loadAiEvals() {
  const evals = {};
  if (fs.existsSync('data/ai_evaluations.jsonl')) {
    const rl = readline.createInterface({ input: fs.createReadStream('data/ai_evaluations.jsonl') });
    for await (const l of rl) {
      if (l.trim()) {
        try {
          const item = JSON.parse(l);
          const sym = item.signal?.symbol || item.symbol;
          const prob = item.aiEvaluation?.winProbability || item.winProbability;
          if (sym && prob) evals[sym] = prob;
        } catch (_) {}
      }
    }
  }
  return evals;
}

async function simulateM15Retest() {
  console.log('================================================================================================');
  console.log('🔥 BACKTEST CƠ CHẾ VÀO LỆNH: CHỜ M15 RÚT CHÂN TẠI ENTRY MỚI ĐẶT LIMIT (14/08 - 21/08/2026)');
  console.log('================================================================================================\n');

  const signals = await loadSignals();
  const aiEvals = await loadAiEvals();
  console.log(`Đã nạp ${signals.length} tín hiệu từ ngày 14/08 đến 21/08.\n`);

  let totalSignals = signals.length;
  let skippedByAi = 0;
  let noM15Touch = 0;
  let brokenThrough = 0; // Đâm thủng cản, không rút chân -> Bỏ qua thành công
  let validM15RutChan = 0; // Có rút chân M15
  let limitFilled = 0;
  let limitMissed = 0;

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let beEscapes = 0;

  const tradeResults = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const sym = sig.symbol;
    const symUSDT = `${sym}USDT`;
    const entry = sig.targetLevel || sig.price;
    const isLong = sig.signal === 'LONG';
    const sigTime = sig.time;

    // AI Veto check (>= 60%)
    const prob = aiEvals[sym] || 55.0;
    if (prob < 60.0) {
      skippedByAi++;
      continue;
    }

    // SL distance ~ 1.8% of price (tier average)
    const slDist = entry * 0.018;
    const tpDist = slDist * 1.5;
    const partialTpDist = slDist * 0.45;
    const maxLossUSD = 3.5; // Average target loss

    // Fetch M15 klines after signal (next 8 candles = 2 hours)
    const m15s = await fetchM15Klines(symUSDT, sigTime, 12);
    if (!m15s.length) continue;

    // Check M15 Rút chân condition in the first 4 candles
    let rutChanCandle = null;
    let isBroken = false;

    for (let cIdx = 0; cIdx < Math.min(6, m15s.length); cIdx++) {
      const c = m15s[cIdx];
      if (isLong) {
        // Did candle touch entry?
        if (c.low <= entry) {
          // Check if it closed ABOVE entry (rút chân) or BELOW entry (đâm thủng)
          if (c.close >= entry) {
            rutChanCandle = c;
            break;
          } else {
            // Đâm thủng sâu qua cản
            isBroken = true;
            break;
          }
        }
      } else {
        // SHORT
        if (c.high >= entry) {
          if (c.close <= entry) {
            rutChanCandle = c;
            break;
          } else {
            isBroken = true;
            break;
          }
        }
      }
    }

    if (isBroken) {
      brokenThrough++;
      continue; // Cản bị đâm thủng, bot né được 1 quả bom SL!
    }

    if (!rutChanCandle) {
      noM15Touch++;
      continue; // Giá chưa chạm entry
    }

    validM15RutChan++;

    // Sau khi nến M15 rút chân đóng cửa, bot đặt LIMIT tại Entry
    // Check xem các nến 1m sau đó có khớp lại Entry không
    const limitStartTime = rutChanCandle.closeTime;
    const klines1m = await fetch1mKlines(symUSDT, limitStartTime, 240);
    if (!klines1m.length) continue;

    let fillIdx = -1;
    for (let m = 0; m < klines1m.length; m++) {
      const k = klines1m[m];
      const isFilled = isLong ? (k.low <= entry) : (k.high >= entry);
      if (isFilled) {
        fillIdx = m;
        break;
      }
    }

    if (fillIdx === -1) {
      limitMissed++;
      continue; // Không khớp limit (giá bay luôn)
    }

    limitFilled++;

    // Mô phỏng diễn biến lệnh sau khi khớp
    const tradeKlines = klines1m.slice(fillIdx);
    const targetTp = isLong ? entry + tpDist : entry - tpDist;
    const targetEarlyTp = isLong ? entry + partialTpDist : entry - partialTpDist;
    const targetSl = isLong ? entry - slDist : entry + slDist;

    let isPartial = false;
    let isTrailed = false;
    let tradePnl = 0;
    let outcome = null;

    for (const k of tradeKlines) {
      if (!isTrailed) {
        const isSl = isLong ? (k.low <= targetSl) : (k.high >= targetSl);
        if (isSl) {
          outcome = 'FULL_SL';
          tradePnl = -maxLossUSD * 1.05;
          break;
        }
      } else {
        const bePrice = isLong ? entry + slDist * 0.05 : entry - slDist * 0.05;
        const isBe = isLong ? (k.low <= bePrice) : (k.high >= bePrice);
        if (isBe) {
          outcome = 'PARTIAL_THEN_BE';
          tradePnl = (maxLossUSD * 0.45 * 0.5) - 0.08;
          break;
        }
      }

      // Check Full TP 1.5R
      const isTp = isLong ? (k.high >= targetTp) : (k.low <= targetTp);
      if (isTp) {
        outcome = 'FULL_TP_1.5X';
        tradePnl = (maxLossUSD * 0.45 * 0.5) + (maxLossUSD * 1.5 * 0.5) - 0.12;
        break;
      }

      // Check Partial TP (0.45R)
      const isEarly = isLong ? (k.high >= targetEarlyTp) : (k.low <= targetEarlyTp);
      if (isEarly && !isPartial) {
        isPartial = true;
        isTrailed = true;
      }
    }

    if (!outcome) {
      if (isPartial) {
        outcome = 'PARTIAL_THEN_BE';
        tradePnl = (maxLossUSD * 0.45 * 0.5) - 0.08;
      } else {
        outcome = 'ESCAPE_BE';
        tradePnl = -0.30;
      }
    }

    totalPnl += tradePnl;
    if (tradePnl > 0) wins++;
    else if (tradePnl <= -1.0) losses++;
    else beEscapes++;

    tradeResults.push({
      sym,
      side: sig.signal,
      entry,
      timeStr: sig.ts,
      outcome,
      pnl: tradePnl
    });
  }

  console.log('📊 THỐNG KÊ CHI TIẾT CƠ CHẾ M15 RÚT CHÂN (14/08 - 21/08):');
  console.log(`• Tổng số tín hiệu phát sinh:                 ${totalSignals}`);
  console.log(`• Số tín hiệu bị AI Veto lọc (< 60%):          ${skippedByAi}`);
  console.log(`• Số tín hiệu né được do M15 ĐÂM THỦNG cản:    ${brokenThrough} 🛡️ (Né được ${brokenThrough} quả bom SL!)`);
  console.log(`• Số tín hiệu xác nhận M15 RÚT CHÂN chuẩn:     ${validM15RutChan}`);
  console.log(`• Số lệnh khớp Limit thành công:               ${limitFilled} (${((limitFilled/validM15RutChan)*100).toFixed(1)}% khớp)`);
  console.log(`• Số lệnh bị hụt Limit (Miss lệnh):            ${limitMissed}\n`);

  console.log('------------------------------------------------------------------------------------------------');
  console.log('TOKEN'.padEnd(12) + 'SIDE'.padEnd(8) + 'ENTRY'.padEnd(14) + 'THỜI GIAN'.padEnd(22) + 'KẾT QUẢ'.padEnd(18) + 'PNL');
  console.log('------------------------------------------------------------------------------------------------');
  for (const r of tradeResults) {
    console.log(
      r.sym.padEnd(12) +
      r.side.padEnd(8) +
      String(r.entry).padEnd(14) +
      r.timeStr.padEnd(22) +
      r.outcome.padEnd(18) +
      ((r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2) + ' USDT')
    );
  }
  console.log('------------------------------------------------------------------------------------------------');
  console.log(`\n🎉 KẾT QUẢ TỔNG HỢP VỚI CƠ CHẾ M15 RÚT CHÂN:`);
  console.log(`  • Tổng số lệnh đã đánh:   ${limitFilled} lệnh (${wins} Thắng / ${losses} Thua Full / ${beEscapes} Hòa vốn)`);
  console.log(`  • Tỷ Lệ Thắng (Winrate):   ${((wins/limitFilled)*100).toFixed(1)}%`);
  console.log(`  • TỔNG PNL THỰC TẾ:        ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT (So với -80.71 USDT cũ)`);
  console.log(`  • Mức chênh lệch lợi nhuận: +${(totalPnl - (-80.71)).toFixed(2)} USDT!\n`);
}

simulateM15Retest().catch(e => console.error(e));
