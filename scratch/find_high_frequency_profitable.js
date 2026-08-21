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

let topSymbols = new Set();
try {
  const capData = JSON.parse(fs.readFileSync('data/market_cap_top.json', 'utf8'));
  topSymbols = new Set((capData.symbols || []).map(s => s.toUpperCase()));
} catch (_) {}

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
          const reasons = item.aiEvaluation?.reason || item.reason || '';
          if (sym && prob) {
            evals[sym] = { prob, reasons, score: item.signal?.score || item.score || 0 };
          }
        } catch (_) {}
      }
    }
  }
  return evals;
}

const klinesCache = {};
async function getKlines(symbol, startTime) {
  const key = `${symbol}_${startTime}`;
  if (klinesCache[key]) return klinesCache[key];

  try {
    const [m15Res, m1Res, m5Res] = await Promise.all([
      axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&limit=16`),
      axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=360`),
      axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${startTime}&limit=24`)
    ]);

    const m15 = m15Res.data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6]
    }));

    const m5 = m5Res.data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6]
    }));

    const m1 = m1Res.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));

    klinesCache[key] = { m15, m5, m1 };
    return klinesCache[key];
  } catch (e) {
    return { m15: [], m5: [], m1: [] };
  }
}

async function evaluateHighFreqConfig(signals, aiEvals, config) {
  let wins = 0;
  let losses = 0;
  let beCount = 0;
  let totalPnl = 0;
  let tradesCount = 0;
  const executedTrades = [];

  for (const sig of signals) {
    const sym = sig.symbol;
    const symUSDT = `${sym}USDT`;
    const entry = sig.targetLevel || sig.price;
    const isLong = sig.signal === 'LONG';
    const sigTime = sig.time;

    const ai = aiEvals[sym] || { prob: 55.0, reasons: '', score: sig.score || 0 };
    const prob = ai.prob;
    const score = sig.score || ai.score || 0;

    // 1. AI Prob filter
    if (prob < config.minAiProb) continue;

    // 2. Score filter
    if (config.minScore && score < config.minScore) continue;

    // 3. Vol dry + OI cooling filter
    if (ai.reasons.includes('VOL_DRY') && ai.reasons.includes('OI_COOLING')) continue;

    // Load klines
    const { m15, m5, m1 } = await getKlines(symUSDT, sigTime);
    if (!m1.length) continue;

    let fillIdx = -1;
    let limitStartTime = sigTime;

    // Entry Confirmation
    if (config.entryMode === 'M5_RUT_CHAN') {
      let rutChan = null;
      let isBroken = false;
      for (let cIdx = 0; cIdx < Math.min(8, m5.length); cIdx++) {
        const c = m5[cIdx];
        if (isLong) {
          if (c.low <= entry) {
            if (c.close >= entry) { rutChan = c; break; }
            else { isBroken = true; break; }
          }
        } else {
          if (c.high >= entry) {
            if (c.close <= entry) { rutChan = c; break; }
            else { isBroken = true; break; }
          }
        }
      }
      if (isBroken || !rutChan) continue;
      limitStartTime = rutChan.closeTime;
    } else if (config.entryMode === 'M15_RUT_CHAN') {
      let rutChan = null;
      let isBroken = false;
      for (let cIdx = 0; cIdx < Math.min(6, m15.length); cIdx++) {
        const c = m15[cIdx];
        if (isLong) {
          if (c.low <= entry) {
            if (c.close >= entry) { rutChan = c; break; }
            else { isBroken = true; break; }
          }
        } else {
          if (c.high >= entry) {
            if (c.close <= entry) { rutChan = c; break; }
            else { isBroken = true; break; }
          }
        }
      }
      if (isBroken || !rutChan) continue;
      limitStartTime = rutChan.closeTime;
    }

    // Check fill in 1m candles
    const klinesAfterStart = m1.filter(k => k.time >= limitStartTime);
    const slDist = entry * (config.slPct || 0.018);
    const tpDist = slDist * (config.tpRatio || 1.5);
    const partialTpDist = slDist * (config.partialTpRatio || 0.40);
    const isTop = topSymbols.has(sym);
    const maxLossUSD = isTop ? (config.lossTop || 4.0) : (config.lossLow || 1.8);

    for (let m = 0; m < klinesAfterStart.length; m++) {
      const k = klinesAfterStart[m];
      if (isLong ? (k.low <= entry) : (k.high >= entry)) {
        fillIdx = m;
        break;
      }
    }

    if (fillIdx === -1) continue;

    tradesCount++;

    // Trade Replay
    const tradeKlines = klinesAfterStart.slice(fillIdx);
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
        const bePrice = isLong ? entry + slDist * 0.03 : entry - slDist * 0.03;
        const isBe = isLong ? (k.low <= bePrice) : (k.high >= bePrice);
        if (isBe) {
          outcome = 'PARTIAL_THEN_BE';
          const partialGain = maxLossUSD * config.partialTpRatio * config.partialSize;
          tradePnl = partialGain - 0.06;
          break;
        }
      }

      // Check Full TP
      const isTp = isLong ? (k.high >= targetTp) : (k.low <= targetTp);
      if (isTp) {
        outcome = 'FULL_TP';
        const p1 = maxLossUSD * config.partialTpRatio * config.partialSize;
        const p2 = maxLossUSD * config.tpRatio * (1 - config.partialSize);
        tradePnl = p1 + p2 - 0.10;
        break;
      }

      // Check Partial TP
      const isEarly = isLong ? (k.high >= targetEarlyTp) : (k.low <= targetEarlyTp);
      if (isEarly && !isPartial) {
        isPartial = true;
        isTrailed = true;
      }
    }

    if (!outcome) {
      if (isPartial) {
        outcome = 'PARTIAL_THEN_BE';
        tradePnl = (maxLossUSD * config.partialTpRatio * config.partialSize) - 0.06;
      } else {
        outcome = 'ESCAPE_BE';
        tradePnl = -0.25;
      }
    }

    totalPnl += tradePnl;
    if (tradePnl > 0.1) wins++;
    else if (tradePnl <= -0.8) losses++;
    else beCount++;

    executedTrades.push({ sym, side: sig.signal, pnl: tradePnl, outcome, time: sig.ts });
  }

  return {
    config,
    tradesCount,
    wins,
    losses,
    beCount,
    winrate: tradesCount > 0 ? (wins / tradesCount) * 100 : 0,
    totalPnl,
    executedTrades
  };
}

async function searchOptimalHighFrequency() {
  const signals = await loadSignals();
  const aiEvals = await loadAiEvals();
  console.log(`Bắt đầu chạy tìm kiếm các chiến lược NHIỀU LỆNH (15-30 lệnh/tuần) và PNL DƯƠNG...\n`);

  const configs = [
    // Combo 1: All coins + M5 Rút Chân + AI >= 55% + Chốt 60% ở 0.35R + Runner 1.5R + Lowcap Loss 1.5$
    { name: '1. Fast Scalper M5 (AI>=55% + Partial 60% @ 0.35R + Runner 1.5R + Loss Low 1.5$)', minAiProb: 55, entryMode: 'M5_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.35, partialSize: 0.6, lossTop: 4.0, lossLow: 1.5 },

    // Combo 2: All coins + M5 Rút Chân + AI >= 58% + Chốt 60% ở 0.35R + Runner 2.0R + Loss Low 1.5$
    { name: '2. High RR Scalper M5 (AI>=58% + Partial 60% @ 0.35R + Runner 2.0R + Loss Low 1.5$)', minAiProb: 58, entryMode: 'M5_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.35, partialSize: 0.6, lossTop: 4.0, lossLow: 1.5 },

    // Combo 3: All coins + M15 Rút Chân + AI >= 55% + Chốt 60% ở 0.40R + Runner 1.5R + Loss Low 1.8$
    { name: '3. Swing Scalper M15 (AI>=55% + Partial 60% @ 0.40R + Runner 1.5R + Loss Low 1.8$)', minAiProb: 55, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.40, partialSize: 0.6, lossTop: 4.0, lossLow: 1.8 },

    // Combo 4: All coins + M15 Rút Chân + AI >= 58% + Chốt 50% ở 0.40R + Runner 1.8R + Loss Low 1.5$
    { name: '4. Precision Pro M15 (AI>=58% + Partial 50% @ 0.40R + Runner 1.8R + Loss Low 1.5$)', minAiProb: 58, entryMode: 'M15_RUT_CHAN', tpRatio: 1.8, partialTpRatio: 0.40, partialSize: 0.5, lossTop: 4.0, lossLow: 1.5 },

    // Combo 5: All coins + Blind Limit + AI >= 60% + Chốt 70% ở 0.30R (Ăn ngắn khóa BE tức thì) + Runner 1.5R + Loss Low 1.5$
    { name: '5. Ultra Fast BE Trail (Limit + AI>=60% + Chốt 70% @ 0.30R + Loss Low 1.5$)', minAiProb: 60, entryMode: 'LIMIT', tpRatio: 1.5, partialTpRatio: 0.30, partialSize: 0.7, lossTop: 4.0, lossLow: 1.5 },

    // Combo 6: All coins + M5 Rút Chân + AI >= 52% + Chốt 70% ở 0.35R + Runner 1.5R + Loss Low 1.2$
    { name: '6. High Volume M5 (AI>=52% + Partial 70% @ 0.35R + Runner 1.5R + Loss Low 1.2$)', minAiProb: 52, entryMode: 'M5_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.35, partialSize: 0.7, lossTop: 3.5, lossLow: 1.2 },

    // Combo 7: All coins + M5 Rút Chân + AI >= 60% + Chốt 50% ở 0.35R + Runner 2.0R + Loss Low 1.8$
    { name: '7. Multi-Asset M5 (AI>=60% + Partial 50% @ 0.35R + Runner 2.0R + Loss Low 1.8$)', minAiProb: 60, entryMode: 'M5_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.35, partialSize: 0.5, lossTop: 4.0, lossLow: 1.8 }
  ];

  const results = [];
  for (const cfg of configs) {
    const res = await evaluateHighFreqConfig(signals, aiEvals, cfg);
    results.push(res);
  }

  results.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log('========================================================================================================');
  console.log('🏆 KẾT QUẢ TÌM KIẾM CHIẾN LƯỢC NHIỀU LỆNH (15-30 LỆNH/TUẦN) VÀ PNL DƯƠNG');
  console.log('========================================================================================================\n');

  console.log('TÊN CHIẾN LƯỢC'.padEnd(60) + 'SỐ LỆNH'.padEnd(10) + 'THẮNG/THUA/HÒA'.padEnd(16) + 'WINRATE'.padEnd(10) + 'TỔNG PNL');
  console.log('-'.repeat(105));
  for (const r of results) {
    const pnlStr = (r.totalPnl >= 0 ? '🟢 +' : '🔴 ') + r.totalPnl.toFixed(2) + ' USDT';
    console.log(
      r.config.name.padEnd(60) +
      String(r.tradesCount).padEnd(10) +
      `${r.wins}W / ${r.losses}L / ${r.beCount}BE`.padEnd(16) +
      (r.winrate.toFixed(1) + '%').padEnd(10) +
      pnlStr
    );
  }
  console.log('-'.repeat(105));

  const best = results.find(r => r.tradesCount >= 15 && r.totalPnl > 0) || results[0];
  console.log(`\n🔥 CHI TIẾT CHIẾN LƯỢC TỐI ƯU NHẤT: [${best.config.name}]`);
  console.log(`• Tổng số lệnh: ${best.tradesCount} lệnh trong 1 tuần (~2-4 lệnh/ngày)`);
  console.log(`• Tỷ lệ thắng: ${best.winrate.toFixed(1)}% (${best.wins} Thắng / ${best.losses} Thua / ${best.beCount} Hòa)`);
  console.log(`• Tổng PnL: ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(2)} USDT\n`);
  console.log('Danh sách 10 lệnh tiêu biểu:');
  for (const t of best.executedTrades.slice(0, 10)) {
    console.log(`  • ${t.sym.padEnd(10)} (${t.side.padEnd(5)}) -> ${t.outcome.padEnd(16)}: ${(t.pnl >= 0 ? '+' : '')}${t.pnl.toFixed(2)}$ (${t.time})`);
  }
}

searchOptimalHighFrequency().catch(e => console.error(e));
