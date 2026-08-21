require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const BASE = 'https://fapi.binance.com';

const trades = [
  { sym: 'BLESSUSDT', side: 'LONG', entry: 0.00712, sl: 0.007037, time: 1787212037000, aiProb: 52.0 },
  { sym: 'CRVUSDT', side: 'SHORT', entry: 0.268, sl: 0.2743, time: 1787209687000, aiProb: 69.5 },
  { sym: 'SFPUSDT', side: 'SHORT', entry: 0.2612, sl: 0.2667, time: 1787212955000, aiProb: 69.0 },
  { sym: 'MONUSDT', side: 'SHORT', entry: 0.02577, sl: 0.02628, time: 1787227753000, aiProb: 63.2 },
  { sym: 'SPXUSDT', side: 'SHORT', entry: 0.3809, sl: 0.389, time: 1787219561000, aiProb: 74.1 },
  { sym: 'VETUSDT', side: 'SHORT', entry: 0.00499, sl: 0.005047, time: 1787231868000, aiProb: 72.6 },
  { sym: 'GUAUSDT', side: 'LONG', entry: 0.04374, sl: 0.04282, time: 1787231308000, aiProb: 50.7 },
  { sym: '1MBABYDOGEUSDT', side: 'SHORT', entry: 0.0003617, sl: 0.0003716, time: 1787231736000, aiProb: 70.0 },
  { sym: 'ETHFIUSDT', side: 'LONG', entry: 0.5376, sl: 0.5322, time: 1787236092000, aiProb: 65.3 },
  { sym: 'ILVUSDT', side: 'SHORT', entry: 3.193, sl: 3.251, time: 1787237243000, aiProb: 70.0 },
  { sym: 'STEEMUSDT', side: 'SHORT', entry: 0.03826, sl: 0.0388, time: 1787245856000, aiProb: 70.0 },
  { sym: 'SLPUSDT', side: 'SHORT', entry: 0.0005761, sl: 0.0005875, time: 1787240561000, aiProb: 70.7 },
  { sym: 'NILUSDT', side: 'LONG', entry: 0.04035, sl: 0.03985, time: 1787248127000, aiProb: 48.8 },
  { sym: 'LAYERUSDT', side: 'SHORT', entry: 0.0659, sl: 0.06656, time: 1787251287000, aiProb: 63.0 },
  { sym: 'MEUSDT', side: 'SHORT', entry: 0.0632, sl: 0.06403, time: 1787250357000, aiProb: 59.1 },
  { sym: 'EIGENUSDT', side: 'SHORT', entry: 0.1945, sl: 0.2011, time: 1787247028000, aiProb: 64.9 },
  { sym: 'BNBUSDT', side: 'SHORT', entry: 654.71, sl: 662.67, time: 1787251177000, aiProb: 62.7 },
  { sym: 'EDENUSDT', side: 'LONG', entry: 0.05361, sl: 0.05307, time: 1787259871000, aiProb: 51.6 },
  { sym: 'AKTUSDT', side: 'SHORT', entry: 0.53, sl: 0.5358, time: 1787267104000, aiProb: 57.6 },
  { sym: 'ZEREBROUSDT', side: 'LONG', entry: 0.04243, sl: 0.04201, time: 1787271701000, aiProb: 47.3 },
  { sym: 'METISUSDT', side: 'SHORT', entry: 2.603, sl: 2.642, time: 1787281092000, aiProb: 64.9 }
];

async function fetchKlines(symbol, startTime, endTime) {
  try {
    const res = await axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`);
    return res.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      vol: parseFloat(k[5])
    }));
  } catch (e) {
    return [];
  }
}

// Strategy Model:
// - Partial TP 50% & Trailing SL triggered EARLY at 0.45x - 0.50x SL distance (giữ nguyên an toàn, không bị nhả lãi)
// - Phần 50% còn lại gồng lên TP 1.5x (hoặc 1.0x như hiện tại)
async function simulateHybrid(trade, finalTpMultiplier = 1.5) {
  const isLong = trade.side === 'LONG';
  const slDist = Math.abs(trade.entry - trade.sl);
  
  // Early trigger: 0.45x SL distance (như bot hiện tại)
  const earlyTriggerDist = slDist * 0.45;
  const finalTpDist = slDist * finalTpMultiplier;
  const nearFinalTpDist = finalTpDist * 0.90;

  const targetEarly = isLong ? trade.entry + earlyTriggerDist : trade.entry - earlyTriggerDist;
  const targetFinalTp = isLong ? trade.entry + finalTpDist : trade.entry - finalTpDist;
  const targetNearFinal = isLong ? trade.entry + nearFinalTpDist : trade.entry - nearFinalTpDist;
  const targetSl = trade.sl;

  const klines = await fetchKlines(trade.sym, trade.time, trade.time + 6 * 3600 * 1000);
  if (!klines.length) return { outcome: 'NO_DATA', pnl: 0 };

  let isPartialFilled = false;
  let isTrailedToBe = false;
  let isNearTpLocked = false;
  let exitReason = null;
  let pnl = 0;

  const maxLossUSD = 5.0;
  // Partial 50% ăn ở 0.45x slDist -> $5.0 * 0.45 * 0.5 = +$1.125
  const partialWinUSD = maxLossUSD * 0.45 * 0.5; // +$1.125
  // Final 50% ăn ở finalTpMultiplier -> $5.0 * 1.5 * 0.5 = +$3.75
  const finalWinUSD = maxLossUSD * finalTpMultiplier * 0.5; // +$3.75

  for (const k of klines) {
    // 1. Check SL
    if (!isTrailedToBe) {
      const isSlHit = isLong ? (k.low <= targetSl) : (k.high >= targetSl);
      if (isSlHit) {
        exitReason = 'FULL_SL';
        pnl = -maxLossUSD * 1.05;
        break;
      }
    } else {
      // Trailed to BE + buffer
      const bePrice = isLong ? trade.entry + slDist * 0.05 : trade.entry - slDist * 0.05;
      const isBeHit = isLong ? (k.low <= bePrice) : (k.high >= bePrice);

      if (isNearTpLocked) {
        const lockPrice = isLong ? trade.entry + finalTpDist * 0.75 : trade.entry - finalTpDist * 0.75;
        const isLockHit = isLong ? (k.low <= lockPrice) : (k.high >= lockPrice);
        if (isLockHit) {
          exitReason = 'NEAR_TP_LOCK';
          pnl = partialWinUSD + (maxLossUSD * finalTpMultiplier * 0.75 * 0.5) - 0.15;
          break;
        }
      } else if (isBeHit) {
        exitReason = 'PARTIAL_THEN_BE';
        pnl = partialWinUSD - 0.12;
        break;
      }
    }

    // 2. Check Final TP (1.5x)
    const isFinalHit = isLong ? (k.high >= targetFinalTp) : (k.low <= targetFinalTp);
    if (isFinalHit) {
      exitReason = 'FULL_TP_1.5X';
      pnl = partialWinUSD + finalWinUSD - 0.18;
      break;
    }

    // 3. Check Near Final TP
    const isNearFinalHit = isLong ? (k.high >= targetNearFinal) : (k.low <= targetNearFinal);
    if (isNearFinalHit) {
      isNearTpLocked = true;
    }

    // 4. Check Early Partial TP (0.45x)
    const isEarlyHit = isLong ? (k.high >= targetEarly) : (k.low <= targetEarly);
    if (isEarlyHit && !isPartialFilled) {
      isPartialFilled = true;
      isTrailedToBe = true;
    }
  }

  if (!exitReason) {
    if (isPartialFilled) {
      exitReason = 'PARTIAL_THEN_BE';
      pnl = partialWinUSD - 0.12;
    } else {
      exitReason = 'ESCAPE_OR_SL';
      pnl = -0.55;
    }
  }

  return { exitReason, pnl };
}

async function run() {
  console.log('=== SO SÁNH 3 CHIẾN LƯỢC ===\n');

  const actualPnl = {
    BLESSUSDT: 0.1670, CRVUSDT: 0.3968, SFPUSDT: -6.4085, MONUSDT: -5.0996, SPXUSDT: -4.9977,
    VETUSDT: -0.4480, GUAUSDT: -0.5664, '1MBABYDOGEUSDT': 3.5863, ETHFIUSDT: 0.2033, ILVUSDT: 1.1727,
    STEEMUSDT: -4.1631, SLPUSDT: -0.5081, NILUSDT: -0.6973, LAYERUSDT: 3.6108, MEUSDT: -5.3098,
    EIGENUSDT: -0.6815, BNBUSDT: 2.3903, EDENUSDT: 3.4145, AKTUSDT: -0.5997, ZEREBROUSDT: -5.0058, METISUSDT: 1.0416
  };

  let totalActual = 0;
  let totalHybrid15 = 0;
  let totalHybrid15_Ai60 = 0;

  const rows = [];

  for (const t of trades) {
    const sim15 = await simulateHybrid(t, 1.5);
    const curr = actualPnl[t.sym] || 0;
    totalActual += curr;
    totalHybrid15 += sim15.pnl;
    if (t.aiProb >= 60.0) {
      totalHybrid15_Ai60 += sim15.pnl;
    }

    rows.push({
      sym: t.sym.replace('USDT', ''),
      aiProb: t.aiProb,
      curr: curr,
      sim15: sim15.pnl,
      outcome15: sim15.exitReason
    });
  }

  console.log('TOKEN'.padEnd(12) + 'AI PROB'.padEnd(10) + 'HIỆN TẠI (1:1)'.padEnd(18) + 'HYBRID (TP 1:1.5)'.padEnd(20) + 'DIỄN BIẾN LỆNH');
  console.log('-'.repeat(85));
  for (const r of rows) {
    console.log(
      r.sym.padEnd(12) +
      (r.aiProb + '%').padEnd(10) +
      ((r.curr >= 0 ? '+' : '') + r.curr.toFixed(2) + '$').padEnd(18) +
      ((r.sim15 >= 0 ? '+' : '') + r.sim15.toFixed(2) + '$').padEnd(20) +
      r.outcome15
    );
  }

  console.log('-'.repeat(85));
  console.log(`1. HIỆN TẠI (TP 1:1, Veto 45%):                           ${totalActual >= 0 ? '+' : ''}${totalActual.toFixed(2)} USDT`);
  console.log(`2. GIỮ CHỐT 50% SỚM + NÂNG RUNNER 50% LÊN 1:1.5:           ${totalHybrid15 >= 0 ? '+' : ''}${totalHybrid15.toFixed(2)} USDT`);
  console.log(`3. KẾT HỢP: HYBRID TP 1:1.5 + NÂNG AI VETO >= 60%:        ${totalHybrid15_Ai60 >= 0 ? '+' : ''}${totalHybrid15_Ai60.toFixed(2)} USDT`);
}

run();
