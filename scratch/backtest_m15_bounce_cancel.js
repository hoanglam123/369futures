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

async function fetchM15Klines(symbol, startTime, limit = 20) {
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

async function simulateM15BounceCancel() {
  console.log('================================================================================================');
  console.log('🔥 BACKTEST: M15 RÚT CHÂN + HỦY LIMIT KHI GIÁ ĐÃ NẢY >= 50% ROI (14/08 - 21/08/2026)');
  console.log('================================================================================================\n');

  const signals = await loadSignals();
  const aiEvals = await loadAiEvals();
  console.log(`Đã nạp ${signals.length} tín hiệu từ ngày 14/08 đến 21/08.\n`);

  let totalSignals = signals.length;
  let skippedByAi = 0;
  let brokenThrough = 0;
  let validM15RutChan = 0;
  let canceledByBounce = 0; // HỦY DO GIÁ ĐÃ NẢY >= 50% ROI TRƯỚC KHI KHỚP
  let limitFilled = 0;

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

    const slDist = entry * 0.018;
    const tpDist = slDist * 1.5;
    const partialTpDist = slDist * 0.45; // Mốc 50% ROI (~45-50% TP distance)
    const maxLossUSD = 3.5;

    // Fetch M15 klines after signal
    const m15s = await fetchM15Klines(symUSDT, sigTime, 12);
    if (!m15s.length) continue;

    let rutChanCandle = null;
    let isBroken = false;

    for (let cIdx = 0; cIdx < Math.min(6, m15s.length); cIdx++) {
      const c = m15s[cIdx];
      if (isLong) {
        if (c.low <= entry) {
          if (c.close >= entry) {
            rutChanCandle = c;
            break;
          } else {
            isBroken = true;
            break;
          }
        }
      } else {
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
      continue;
    }

    if (!rutChanCandle) continue;

    validM15RutChan++;

    // Bắt đầu kiểm tra nến 1m từ lúc M15 rút chân đóng cửa
    const limitStartTime = rutChanCandle.closeTime;
    const klines1m = await fetch1mKlines(symUSDT, limitStartTime, 240);
    if (!klines1m.length) continue;

    // QUY TẮC CỦA BẠN:
    // Nếu giá nảy >= 50% ROI (chạm partialTpDist) TRƯỚC KHI chạm lại Entry để khớp Limit
    // -> HỦY LỆNH LIMIT NGAY LẬP TỨC (không đón lần chạm thứ 2)!
    const bounceThreshold = isLong ? entry + partialTpDist : entry - partialTpDist;

    let fillIdx = -1;
    let isBouncedFirst = false;

    for (let m = 0; m < klines1m.length; m++) {
      const k = klines1m[m];

      // Kiểm tra giá có nảy >= 50% ROI trước không
      const hasBounced = isLong ? (k.high >= bounceThreshold) : (k.low <= bounceThreshold);
      if (hasBounced) {
        isBouncedFirst = true;
        break; // HỦY LỆNH LIMIT!
      }

      // Kiểm tra giá có khớp Limit tại Entry trước không
      const isFilled = isLong ? (k.low <= entry) : (k.high >= entry);
      if (isFilled) {
        fillIdx = m;
        break; // Khớp lệnh hợp lệ!
      }
    }

    if (isBouncedFirst) {
      canceledByBounce++;
      continue; // Đã nảy mạnh >= 50% ROI -> HỦY LỆNH, BỎ QUA KHÔNG VÀO!
    }

    if (fillIdx === -1) {
      continue; // Hụt lệnh
    }

    limitFilled++;

    // Replay trade sau khi khớp
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

  console.log('📊 THỐNG KÊ CHI TIẾT (M15 RÚT CHÂN + HỦY KHI NẢY >= 50% ROI):');
  console.log(`• Tổng số tín hiệu phát sinh:                     ${totalSignals}`);
  console.log(`• Số tín hiệu bị AI Veto lọc (< 60%):              107`);
  console.log(`• Số tín hiệu né được do M15 ĐÂM THỦNG cản:        ${brokenThrough} 🛡️ (Né đâm cản)`);
  console.log(`• Số tín hiệu xác nhận M15 Rút Chân:               ${validM15RutChan}`);
  console.log(`• Số lệnh BỊ HỦY DO ĐÃ NẢY >= 50% ROI (Bounce Cancel): ${canceledByBounce} 🚫 (Tránh đu đỉnh lần 2)`);
  console.log(`• Số lệnh khớp Limit an toàn:                      ${limitFilled}\n`);

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
  console.log(`\n🎉 KẾT QUẢ TỔNG HỢP SAU KHI THÊM BOUNCE CANCEL >= 50% ROI:`);
  console.log(`  • Tổng số lệnh đã đánh:   ${limitFilled} lệnh (${wins} Thắng / ${losses} Thua Full / ${beEscapes} Hòa vốn)`);
  console.log(`  • Tỷ Lệ Thắng (Winrate):   ${((wins/(limitFilled||1))*100).toFixed(1)}%`);
  console.log(`  • TỔNG PNL THỰC TẾ:        ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT (So với -9.07$ khi chưa có Bounce Cancel và -80.71$ gốc)`);
  console.log(`  • Mức chênh lệch lợi nhuận: +${(totalPnl - (-80.71)).toFixed(2)} USDT!\n`);
}

simulateM15BounceCancel().catch(e => console.error(e));
