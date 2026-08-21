require('dotenv').config();
const { loadSignals, loadAiEvals } = require('./find_profitable_strategy.js');
const axios = require('axios');
const fs = require('fs');

const BASE = 'https://fapi.binance.com';

async function testAsymmetricPayoff() {
  const signals = await loadSignals();
  const aiEvals = await loadAiEvals();

  // Test asymmetric R:R configurations with 15-30 trades
  const configs = [
    // Strategy 1: Asymmetric 1:2.2 (TP 2.2R, No early tiny partial, Step Trailing SL)
    { name: '1. Asymmetric 2.2R (TP 2.2R + SL 1.0R + AI>=58% + M5 Retest)', minAiProb: 58, entryMode: 'M5_RUT_CHAN', tpRatio: 2.2, trailTriggerRatio: 0.8, lossTop: 4.0, lossLow: 2.0 },

    // Strategy 2: Asymmetric 2.0R with 40% Partial at 0.8R + Runner 2.0R
    { name: '2. Pro Runner (Partial 40% @ 0.8R + Runner 2.0R + AI>=56% + M5 Retest)', minAiProb: 56, entryMode: 'M5_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.8, partialSize: 0.4, lossTop: 4.0, lossLow: 2.0 },

    // Strategy 3: Multi-Coin Asymmetric (AI>=55% + TP 2.5R + Lowcap Loss 1.5$)
    { name: '3. Big Trend Scalper (TP 2.5R + Partial 30% @ 0.9R + AI>=55%)', minAiProb: 55, entryMode: 'M5_RUT_CHAN', tpRatio: 2.5, partialTpRatio: 0.9, partialSize: 0.3, lossTop: 4.0, lossLow: 1.5 },

    // Strategy 4: High Quality M15 with 2.0R TP
    { name: '4. High R:R M15 (TP 2.0R + Partial 40% @ 0.75R + AI>=56%)', minAiProb: 56, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.75, partialSize: 0.4, lossTop: 4.0, lossLow: 2.0 }
  ];

  console.log('=== KẾT QUẢ THỬ NGHIỆM ASYMMETRIC R:R (NHIỀU LỆNH + LỢI NHUẬN LỚN) ===\n');

  for (const cfg of configs) {
    let wins = 0, losses = 0, beCount = 0, totalPnl = 0, tradesCount = 0;
    const executedTrades = [];

    for (const sig of signals) {
      const sym = sig.symbol;
      const symUSDT = `${sym}USDT`;
      const entry = sig.targetLevel || sig.price;
      const isLong = sig.signal === 'LONG';
      const sigTime = sig.time;

      const ai = aiEvals[sym] || { prob: 55.0, reasons: '', score: sig.score || 0 };
      if (ai.prob < cfg.minAiProb) continue;
      if (ai.reasons.includes('VOL_DRY') && ai.reasons.includes('OI_COOLING')) continue;

      let m1Res, m5Res, m15Res;
      try {
        const [m15k, m5k, m1k] = await Promise.all([
          axios.get(`${BASE}/fapi/v1/klines?symbol=${symUSDT}&interval=15m&startTime=${sigTime}&limit=16`),
          axios.get(`${BASE}/fapi/v1/klines?symbol=${symUSDT}&interval=5m&startTime=${sigTime}&limit=24`),
          axios.get(`${BASE}/fapi/v1/klines?symbol=${symUSDT}&interval=1m&startTime=${sigTime}&limit=360`)
        ]);
        m15Res = m15k.data.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), closeTime: k[6] }));
        m5Res = m5k.data.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), closeTime: k[6] }));
        m1Res = m1k.data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
      } catch (_) { continue; }

      let limitStartTime = sigTime;
      const candles = cfg.entryMode === 'M15_RUT_CHAN' ? m15Res : m5Res;
      let rutChan = null, isBroken = false;
      for (let cIdx = 0; cIdx < Math.min(8, candles.length); cIdx++) {
        const c = candles[cIdx];
        if (isLong) {
          if (c.low <= entry) { if (c.close >= entry) { rutChan = c; break; } else { isBroken = true; break; } }
        } else {
          if (c.high >= entry) { if (c.close <= entry) { rutChan = c; break; } else { isBroken = true; break; } }
        }
      }
      if (isBroken || !rutChan) continue;
      limitStartTime = rutChan.closeTime;

      const klinesAfterStart = m1Res.filter(k => k.time >= limitStartTime);
      let fillIdx = -1;
      for (let m = 0; m < klinesAfterStart.length; m++) {
        const k = klinesAfterStart[m];
        if (isLong ? (k.low <= entry) : (k.high >= entry)) { fillIdx = m; break; }
      }
      if (fillIdx === -1) continue;

      tradesCount++;
      const slDist = entry * 0.018;
      const tpDist = slDist * cfg.tpRatio;
      const partialTpDist = slDist * (cfg.partialTpRatio || 0.8);
      const maxLossUSD = cfg.lossLow || 2.0;

      const tradeKlines = klinesAfterStart.slice(fillIdx);
      const targetTp = isLong ? entry + tpDist : entry - tpDist;
      const targetEarlyTp = isLong ? entry + partialTpDist : entry - partialTpDist;
      const targetSl = isLong ? entry - slDist : entry + slDist;

      let isPartial = false, isTrailed = false, tradePnl = 0, outcome = null;

      for (const k of tradeKlines) {
        if (!isTrailed) {
          if (isLong ? (k.low <= targetSl) : (k.high >= targetSl)) {
            outcome = 'FULL_SL';
            tradePnl = -maxLossUSD * 1.05;
            break;
          }
        } else {
          const bePrice = isLong ? entry + slDist * 0.05 : entry - slDist * 0.05;
          if (isLong ? (k.low <= bePrice) : (k.high >= bePrice)) {
            outcome = 'PARTIAL_THEN_BE';
            tradePnl = (maxLossUSD * (cfg.partialTpRatio || 0.8) * (cfg.partialSize || 0.4)) - 0.08;
            break;
          }
        }

        if (isLong ? (k.high >= targetTp) : (k.low <= targetTp)) {
          outcome = 'FULL_TP';
          if (cfg.partialSize) {
            tradePnl = (maxLossUSD * cfg.partialTpRatio * cfg.partialSize) + (maxLossUSD * cfg.tpRatio * (1 - cfg.partialSize)) - 0.12;
          } else {
            tradePnl = (maxLossUSD * cfg.tpRatio) - 0.12;
          }
          break;
        }

        if (cfg.partialSize && (isLong ? (k.high >= targetEarlyTp) : (k.low <= targetEarlyTp)) && !isPartial) {
          isPartial = true;
          isTrailed = true;
        }
      }

      if (!outcome) {
        if (isPartial) { outcome = 'PARTIAL_THEN_BE'; tradePnl = (maxLossUSD * cfg.partialTpRatio * (cfg.partialSize || 0.4)) - 0.08; }
        else { outcome = 'ESCAPE_BE'; tradePnl = -0.25; }
      }

      totalPnl += tradePnl;
      if (tradePnl > 0.3) wins++;
      else if (tradePnl <= -0.8) losses++;
      else beCount++;

      executedTrades.push({ sym, side: sig.signal, pnl: tradePnl, outcome, time: sig.ts });
    }

    const pnlColor = totalPnl >= 0 ? '🟢 +' : '🔴 ';
    console.log(`${cfg.name.padEnd(65)}: ${tradesCount} lệnh | ${wins}W / ${losses}L / ${beCount}BE (${((wins/tradesCount)*100).toFixed(1)}%) => PnL: ${pnlColor}${totalPnl.toFixed(2)} USDT`);
    for (const t of executedTrades.slice(0, 8)) {
      console.log(`     -> ${t.sym} (${t.side}) ${t.outcome}: ${(t.pnl>=0?'+':'')}${t.pnl.toFixed(2)}$ (${t.time})`);
    }
    console.log('-'.repeat(95));
  }
}

testAsymmetricPayoff().catch(e => console.error(e));
