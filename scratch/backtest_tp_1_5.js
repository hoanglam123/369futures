require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const BASE = 'https://fapi.binance.com';

// 21 Trades with exact entry time, side, entry price, SL distance from logs
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
    console.error(`Error fetching klines for ${symbol}:`, e.message);
    return [];
  }
}

async function simulateTrade(trade, tpRatio = 1.5) {
  const isLong = trade.side === 'LONG';
  const slDist = Math.abs(trade.entry - trade.sl);
  const tpDist = slDist * tpRatio; // Target 1.5x
  const partialTpDist = tpDist * 0.5; // 50% TP distance = 0.75x slDist
  const nearTpDist = tpDist * 0.90; // 90% TP distance = 1.35x slDist
  
  const targetTp = isLong ? trade.entry + tpDist : trade.entry - tpDist;
  const targetPartialTp = isLong ? trade.entry + partialTpDist : trade.entry - partialTpDist;
  const targetNearTp = isLong ? trade.entry + nearTpDist : trade.entry - nearTpDist;
  const targetSl = trade.sl;

  // 1m candles for 6 hours after entry
  const klines = await fetchKlines(trade.sym, trade.time, trade.time + 6 * 3600 * 1000);
  if (!klines.length) {
    return { outcome: 'NO_DATA', pnl: 0 };
  }

  let isPartialFilled = false;
  let isTrailedToBe = false;
  let isNearTpLocked = false;
  let exitPrice = null;
  let exitReason = null;
  let pnl = 0;

  // Target loss USD is $5.0 -> Target win full = $5.0 * tpRatio = $7.50
  const maxLossUSD = 5.0;
  const fullWinUSD = maxLossUSD * tpRatio; // $7.50

  for (const k of klines) {
    const favorablePrice = isLong ? k.high : k.low;
    const adversePrice = isLong ? k.low : k.high;

    // Check Stop Loss first (if not trailed)
    if (!isTrailedToBe) {
      const isSlHit = isLong ? (k.low <= targetSl) : (k.high >= targetSl);
      if (isSlHit) {
        exitReason = 'FULL_SL';
        pnl = -maxLossUSD * 1.05; // -5.25$
        break;
      }
    } else {
      // Trailed to BE (+/- small buffer ~0.05 * slDist)
      const bePrice = isLong ? trade.entry + slDist * 0.05 : trade.entry - slDist * 0.05;
      const isBeHit = isLong ? (k.low <= bePrice) : (k.high >= bePrice);
      
      // If Near-TP locked (locks 75% of TP)
      if (isNearTpLocked) {
        const lockPrice = isLong ? trade.entry + tpDist * 0.75 : trade.entry - tpDist * 0.75;
        const isLockHit = isLong ? (k.low <= lockPrice) : (k.high >= lockPrice);
        if (isLockHit) {
          exitReason = 'NEAR_TP_LOCK';
          // 50% partial was taken at partialTpDist ($1.875) + 50% remainder at 75% TP ($2.81) = +$4.685
          pnl = (fullWinUSD * 0.5 * 0.5) + (fullWinUSD * 0.5 * 0.75) - 0.15;
          break;
        }
      } else if (isBeHit) {
        exitReason = 'PARTIAL_THEN_BE';
        // 50% partial was taken ($1.875) + 50% remainder at BE ($0) = +$1.875 - fees = +$1.75
        pnl = (fullWinUSD * 0.5 * 0.5) - 0.12;
        break;
      }
    }

    // Check Full TP (1.5x)
    const isFullTpHit = isLong ? (k.high >= targetTp) : (k.low <= targetTp);
    if (isFullTpHit) {
      exitReason = 'FULL_TP';
      // 50% partial ($1.875) + 50% full ($3.75) = +$5.625 - fees = +$5.45
      pnl = (fullWinUSD * 0.5 * 0.5) + (fullWinUSD * 0.5 * 1.0) - 0.18;
      break;
    }

    // Check Near TP (>= 90% TP)
    const isNearTpHit = isLong ? (k.high >= targetNearTp) : (k.low <= targetNearTp);
    if (isNearTpHit) {
      isNearTpLocked = true;
    }

    // Check Partial TP (50% TP distance)
    const isPartialTpHit = isLong ? (k.high >= targetPartialTp) : (k.low <= targetPartialTp);
    if (isPartialTpHit && !isPartialFilled) {
      isPartialFilled = true;
      isTrailedToBe = true;
    }
  }

  // If still open at end of period, check last price
  if (!exitReason) {
    if (isPartialFilled) {
      exitReason = 'PARTIAL_OPEN';
      pnl = (fullWinUSD * 0.5 * 0.5) - 0.12;
    } else {
      exitReason = 'OPEN_OR_ESCAPE';
      pnl = -0.55;
    }
  }

  return { exitReason, pnl };
}

async function run() {
  console.log('=== SO SÁNH THỰC TẾ: HIỆN TẠI (TP 1:1) VS NÂNG CẤP (TP 1:1.5) ===\n');

  let currentTotal = 0;
  let newTotal = 0;
  let newTotalWithAi60 = 0;

  const actualPnl = {
    BLESSUSDT: 0.1670, CRVUSDT: 0.3968, SFPUSDT: -6.4085, MONUSDT: -5.0996, SPXUSDT: -4.9977,
    VETUSDT: -0.4480, GUAUSDT: -0.5664, '1MBABYDOGEUSDT': 3.5863, ETHFIUSDT: 0.2033, ILVUSDT: 1.1727,
    STEEMUSDT: -4.1631, SLPUSDT: -0.5081, NILUSDT: -0.6973, LAYERUSDT: 3.6108, MEUSDT: -5.3098,
    EIGENUSDT: -0.6815, BNBUSDT: 2.3903, EDENUSDT: 3.4145, AKTUSDT: -0.5997, ZEREBROUSDT: -5.0058, METISUSDT: 1.0416
  };

  const results = [];

  for (const t of trades) {
    const sim = await simulateTrade(t, 1.5);
    const currPnl = actualPnl[t.sym] || 0;
    currentTotal += currPnl;
    newTotal += sim.pnl;
    if (t.aiProb >= 60.0) {
      newTotalWithAi60 += sim.pnl;
    }

    results.push({
      sym: t.sym.replace('USDT', ''),
      side: t.side,
      aiProb: t.aiProb,
      currPnl: currPnl,
      newPnl: sim.pnl,
      outcome: sim.exitReason
    });
  }

  console.log('TOKEN'.padEnd(12) + 'SIDE'.padEnd(7) + 'AI PROB'.padEnd(10) + 'HIỆN TẠI (1:1)'.padEnd(18) + 'NÂNG TP 1:1.5'.padEnd(18) + 'DIỄN BIẾN LỆNH 1:1.5');
  console.log('-'.repeat(85));
  for (const r of results) {
    console.log(
      r.sym.padEnd(12) +
      r.side.padEnd(7) +
      (r.aiProb + '%').padEnd(10) +
      ((r.currPnl >= 0 ? '+' : '') + r.currPnl.toFixed(2) + '$').padEnd(18) +
      ((r.newPnl >= 0 ? '+' : '') + r.newPnl.toFixed(2) + '$').padEnd(18) +
      r.outcome
    );
  }

  console.log('-'.repeat(85));
  console.log(`TỔNG PNL HIỆN TẠI (TP 1:1):                  ${currentTotal >= 0 ? '+' : ''}${currentTotal.toFixed(2)} USDT`);
  console.log(`TỔNG PNL KHI NÂNG TP 1:1.5:                  ${newTotal >= 0 ? '+' : ''}${newTotal.toFixed(2)} USDT`);
  console.log(`TỔNG PNL KHI NÂNG TP 1:1.5 + AI VETO >=60%:  ${newTotalWithAi60 >= 0 ? '+' : ''}${newTotalWithAi60.toFixed(2)} USDT`);
}

run();
