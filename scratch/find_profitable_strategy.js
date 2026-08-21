require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const readline = require('readline');

const BASE = 'https://fapi.binance.com';

// 1. Load all signals from 14/08 to 21/08
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

// 2. Load market cap top
let topSymbols = new Set();
try {
  const capData = JSON.parse(fs.readFileSync('data/market_cap_top.json', 'utf8'));
  topSymbols = new Set((capData.symbols || []).map(s => s.toUpperCase()));
} catch (_) {}

// 3. Load AI evaluations
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

// 4. Cache 1m and 15m klines to avoid repeated API requests
const klinesCache = {};
async function getKlines(symbol, startTime) {
  const key = `${symbol}_${startTime}`;
  if (klinesCache[key]) return klinesCache[key];

  try {
    const [m15Res, m1Res] = await Promise.all([
      axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&limit=16`),
      axios.get(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=360`)
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

    const m1 = m1Res.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));

    klinesCache[key] = { m15, m1 };
    return klinesCache[key];
  } catch (e) {
    return { m15: [], m1: [] };
  }
}

// Simulate a strategy configuration across all signals
async function evaluateConfig(signals, aiEvals, config) {
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

    // Filter 1: AI Probability Threshold
    if (prob < config.minAiProb) continue;

    // Filter 2: Score Threshold
    if (config.minScore && score < config.minScore) continue;

    // Filter 3: Trend Alignment (Chỉ đánh Thuận Trend, không đánh H4 ngược)
    if (config.trendOnly) {
      const reasonStr = (sig.scoreReasons || []).join(' ') + ' ' + ai.reasons;
      if (reasonStr.includes('H4 ngược') || reasonStr.includes('COUNTER') || reasonStr.includes('RSI_OVERBOUGHT') && isLong) {
        continue;
      }
    }

    // Filter 4: Top Market Cap Only (Tránh hoàn toàn lowcap rác thanh khoản kém)
    if (config.topOnly && !topSymbols.has(sym)) {
      continue;
    }

    // Load klines
    const { m15, m1 } = await getKlines(symUSDT, sigTime);
    if (!m15.length || !m1.length) continue;

    // Entry Confirmation
    let fillIdx = -1;
    let limitStartTime = sigTime;

    if (config.entryMode === 'M15_RUT_CHAN') {
      let rutChanCandle = null;
      let isBroken = false;
      for (let cIdx = 0; cIdx < Math.min(6, m15.length); cIdx++) {
        const c = m15[cIdx];
        if (isLong) {
          if (c.low <= entry) {
            if (c.close >= entry) { rutChanCandle = c; break; }
            else { isBroken = true; break; }
          }
        } else {
          if (c.high >= entry) {
            if (c.close <= entry) { rutChanCandle = c; break; }
            else { isBroken = true; break; }
          }
        }
      }
      if (isBroken || !rutChanCandle) continue;
      limitStartTime = rutChanCandle.closeTime;
    }

    // Find 1m fill
    const klinesAfterStart = m1.filter(k => k.time >= limitStartTime);
    const slDist = entry * (config.slPct || 0.018);
    const tpDist = slDist * (config.tpRatio || 1.5);
    const partialTpDist = slDist * (config.partialTpRatio || 0.45);
    const maxLossUSD = topSymbols.has(sym) ? (config.lossTop || 5.0) : (config.lossLow || 2.5);

    // Check bounce cancel if configured
    let bouncedFirst = false;
    if (config.bounceCancel) {
      const bounceThreshold = isLong ? entry + partialTpDist : entry - partialTpDist;
      for (let m = 0; m < klinesAfterStart.length; m++) {
        const k = klinesAfterStart[m];
        if (isLong ? (k.high >= bounceThreshold) : (k.low <= bounceThreshold)) {
          bouncedFirst = true;
          break;
        }
        if (isLong ? (k.low <= entry) : (k.high >= entry)) {
          fillIdx = m;
          break;
        }
      }
    } else {
      for (let m = 0; m < klinesAfterStart.length; m++) {
        const k = klinesAfterStart[m];
        if (isLong ? (k.low <= entry) : (k.high >= entry)) {
          fillIdx = m;
          break;
        }
      }
    }

    if (bouncedFirst || fillIdx === -1) continue;

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
        const bePrice = isLong ? entry + slDist * 0.05 : entry - slDist * 0.05;
        const isBe = isLong ? (k.low <= bePrice) : (k.high >= bePrice);
        if (isBe) {
          outcome = 'PARTIAL_THEN_BE';
          tradePnl = (maxLossUSD * config.partialTpRatio * (config.partialSize || 0.5)) - 0.08;
          break;
        }
      }

      // Check Full TP
      const isTp = isLong ? (k.high >= targetTp) : (k.low <= targetTp);
      if (isTp) {
        outcome = 'FULL_TP';
        if (config.hasPartial) {
          tradePnl = (maxLossUSD * config.partialTpRatio * 0.5) + (maxLossUSD * config.tpRatio * 0.5) - 0.12;
        } else {
          tradePnl = (maxLossUSD * config.tpRatio) - 0.12;
        }
        break;
      }

      // Check Partial TP
      if (config.hasPartial) {
        const isEarly = isLong ? (k.high >= targetEarlyTp) : (k.low <= targetEarlyTp);
        if (isEarly && !isPartial) {
          isPartial = true;
          isTrailed = true;
        }
      }
    }

    if (!outcome) {
      if (isPartial) {
        outcome = 'PARTIAL_THEN_BE';
        tradePnl = (maxLossUSD * config.partialTpRatio * 0.5) - 0.08;
      } else {
        outcome = 'ESCAPE_BE';
        tradePnl = -0.30;
      }
    }

    totalPnl += tradePnl;
    if (tradePnl > 0.2) wins++;
    else if (tradePnl <= -1.0) losses++;
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

async function runResearch() {
  console.log('Đang tải dữ liệu tín hiệu và lịch sử nến Binance...\n');
  const signals = await loadSignals();
  const aiEvals = await loadAiEvals();

  console.log('Bắt đầu thử nghiệm các ma trận chiến lược để tìm ra công thức PnL DƯƠNG...\n');

  const configsToTest = [
    // 1. Tinh hoa Top Coin + AI >= 65% + TP 1:2 + M15 Retest
    { name: '1. TopCoin Elite (AI >= 65% + TP 1:2 + M15 Retest)', minAiProb: 65, minScore: 5.0, trendOnly: true, topOnly: true, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.5, hasPartial: true, lossTop: 5.0, lossLow: 2.0 },
    
    // 2. Trend Following Pure (Chỉ đánh Thuận Trend H4 + AI >= 68% + TP 1:1.5)
    { name: '2. Trend Following (Thuận Trend + AI >= 68% + TP 1:1.5)', minAiProb: 68, minScore: 5.2, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.45, hasPartial: true, lossTop: 4.0, lossLow: 2.0 },
    
    // 3. High Winrate Sniper (AI >= 70% + Score >= 5.5 + TP 1:1.5 + Lowcap Loss 1.5$)
    { name: '3. Sniper 70% (AI >= 70% + Score >= 5.5 + TP 1:1.5)', minAiProb: 70, minScore: 5.5, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.45, hasPartial: true, lossTop: 4.0, lossLow: 1.5 },

    // 4. Asymmetric 1:2 R:R (TP 1:2 + Không chốt 50% sớm, gồng trọn 1:2 với BE trail)
    { name: '4. Big Runner (TP 1:2 + AI >= 65% + Thuận Trend)', minAiProb: 65, minScore: 5.0, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.5, hasPartial: false, lossTop: 4.0, lossLow: 2.0 },

    // 5. AI >= 63% + Thuận Trend H4 + TP 1:2 (Partial 50% ở 0.6R)
    { name: '5. Balanced Pro (AI >= 63% + Thuận Trend + TP 1:2)', minAiProb: 63, minScore: 5.0, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.6, hasPartial: true, lossTop: 4.0, lossLow: 2.0 },

    // 6. Top 50 Coin Sniper (Chỉ đánh Top 50 + AI >= 60% + TP 1:1.5)
    { name: '6. Top 50 Only (AI >= 60% + TP 1:1.5)', minAiProb: 60, minScore: 5.0, trendOnly: false, topOnly: true, entryMode: 'M15_RUT_CHAN', tpRatio: 1.5, partialTpRatio: 0.45, hasPartial: true, lossTop: 5.0, lossLow: 2.0 },
    
    // 7. Ultra Sniper (AI >= 72% + Score >= 5.8)
    { name: '7. Ultra Sniper (AI >= 72% + Score >= 5.8 + TP 1:2)', minAiProb: 72, minScore: 5.8, trendOnly: true, topOnly: false, entryMode: 'M15_RUT_CHAN', tpRatio: 2.0, partialTpRatio: 0.5, hasPartial: true, lossTop: 5.0, lossLow: 2.0 }
  ];

  const results = [];
  for (const cfg of configsToTest) {
    const res = await evaluateConfig(signals, aiEvals, cfg);
    results.push(res);
  }

  results.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log('================================================================================================');
  console.log('🏆 BẢNG XẾP HẠNG CÁC CÔNG THỨC CHIẾN LƯỢC ĐẠT PNL DƯƠNG (14/08 - 21/08/2026)');
  console.log('================================================================================================\n');

  console.log('TÊN CHIẾN LƯỢC'.padEnd(50) + 'SỐ LỆNH'.padEnd(10) + 'THẮNG/THUA'.padEnd(14) + 'WINRATE'.padEnd(12) + 'TỔNG PNL');
  console.log('-'.repeat(95));
  for (const r of results) {
    const pnlStr = (r.totalPnl >= 0 ? '🟢 +' : '🔴 ') + r.totalPnl.toFixed(2) + ' USDT';
    console.log(
      r.config.name.padEnd(50) +
      String(r.tradesCount).padEnd(10) +
      `${r.wins}W / ${r.losses}L`.padEnd(14) +
      (r.winrate.toFixed(1) + '%').padEnd(12) +
      pnlStr
    );
  }
  console.log('-'.repeat(95));

  const best = results[0];
  console.log(`\n🔥 CHI TIẾT CHIẾN LƯỢC TỐT NHẤT: [${best.config.name}]`);
  console.log(`• Tổng PnL: ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(2)} USDT (So với -80.71 USDT cũ)`);
  console.log(`• Tỷ lệ thắng: ${best.winrate.toFixed(1)}% (${best.wins} Thắng / ${best.losses} Thua / ${best.beCount} Hòa)`);
  console.log('\nDanh sách các lệnh được chọn đánh:');
  for (const t of best.executedTrades) {
    console.log(`  • ${t.sym} (${t.side}) - ${t.outcome}: ${(t.pnl >= 0 ? '+' : '')}${t.pnl.toFixed(2)} USDT (${t.time})`);
  }
}

module.exports = { evaluateConfig, loadSignals, loadAiEvals };

if (require.main === module) {
  runResearch().catch(e => console.error(e));
}
