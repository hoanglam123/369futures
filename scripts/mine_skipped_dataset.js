'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { buildLevelGrid, getStep, getDecimals } = require('../src/pp369/core');

const BASE_DIR = path.join(__dirname, '..');
const SKIPPED_FILE = path.join(BASE_DIR, 'data', 'skipped_signals.jsonl');
const STEP_SIZES_FILE = path.join(BASE_DIR, 'data', 'step_sizes.json');
const OUTPUT_MINED_FILE = path.join(BASE_DIR, 'data', 'ai_mined_dataset.jsonl');
const CACHE_DIR = path.join(BASE_DIR, 'data', 'kline_cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_FILE, 'utf8'));
const tickSizesCache = stepSizesData.tickSizes || {};
const h4Cache = stepSizesData.h4Cache || {};

// Helper: sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: fetch Binance 5m klines with local disk cache & retries
async function fetch5mKlinesWithCache(symbol, startTs, durationHours = 24) {
  const sym = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
  // Round down to 6-hour block for efficient caching
  const blockMs = 6 * 3600 * 1000;
  const blockId = Math.floor(startTs / blockMs);
  const cacheFile = path.join(CACHE_DIR, `${sym}_${blockId}.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (_) {}
  }

  // Fetch 288 candles of 5m (= 24 hours of data)
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  let retries = 3;
  while (retries > 0) {
    try {
      const res = await axios.get(url, {
        params: {
          symbol: sym,
          interval: '5m',
          startTime: startTs,
          limit: 288
        },
        timeout: 8000
      });

      const klines = res.data.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6]
      }));

      // Cache to disk
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(klines));
      } catch (_) {}

      return klines;
    } catch (err) {
      retries--;
      if (err.response && err.response.status === 429) {
        console.warn(`[Binance 429 RateLimit] Đang tạm dừng 10 giây...`);
        await sleep(10000);
      } else {
        await sleep(500);
      }
    }
  }
  return [];
}

// Calculate Tier SL/TP exactly matching bot's production logic
function getTierSLTP(sym, side, entryPrice) {
  const h4Ref = h4Cache[sym];
  const step = h4Ref?.step || getStep(entryPrice);
  const decimals = h4Ref?.decimals || getDecimals(entryPrice);
  const upperPrice = h4Ref?.upperPrice || entryPrice;
  const lowerPrice = h4Ref?.lowerPrice || entryPrice;

  const distTicks = Math.ceil(
    Math.max(Math.abs(upperPrice - entryPrice), Math.abs(lowerPrice - entryPrice)) / step
  );
  const levelsRange = Math.max(30, distTicks + 10);
  const grid = buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange);

  let tierLong, tierShort;
  if (side === 'LONG' || side === 'BUY') {
    tierLong = grid.filter((l) => l.type === 'tren' && l.value <= entryPrice * 1.005).pop()?.value || entryPrice;
    tierShort = grid.filter((l) => l.type === 'duoi' && l.value <= entryPrice * 1.005).pop()?.value || (entryPrice - step * 0.1);
  } else {
    tierShort = grid.find((l) => l.type === 'duoi' && l.value >= entryPrice * 0.995)?.value || entryPrice;
    tierLong = grid.find((l) => l.type === 'tren' && l.value >= entryPrice * 0.995)?.value || (entryPrice + step * 0.1);
  }

  const effTickSize = tickSizesCache[`${sym}USDT`] || (decimals === 5 ? 0.00001 : decimals === 4 ? 0.0001 : 0.000001);
  const buffer = Math.max(33 * effTickSize, step * 0.1, entryPrice * 0.003);
  let rawSL = (side === 'LONG' || side === 'BUY') ? tierShort - buffer : tierLong + buffer;
  let slDist = Math.abs(entryPrice - rawSL);
  let slPct = (slDist / entryPrice) * 100;

  if (slPct < 1.0) {
    slPct = 1.0;
    slDist = entryPrice * 0.01;
    rawSL = (side === 'LONG' || side === 'BUY') ? entryPrice - slDist : entryPrice + slDist;
  } else if (slPct > 3.5) {
    slPct = 3.5;
    slDist = entryPrice * 0.035;
    rawSL = (side === 'LONG' || side === 'BUY') ? entryPrice - slDist : entryPrice + slDist;
  }

  const tpPrice = (side === 'LONG' || side === 'BUY') ? entryPrice + slDist * 1.5 : entryPrice - slDist * 1.5;
  const beTriggerPrice = (side === 'LONG' || side === 'BUY') ? entryPrice + slDist * 0.5 : entryPrice - slDist * 0.5;

  return { rawSL, tpPrice, beTriggerPrice, slDist, slPct };
}

// Simulate trade on klines
function simulateExecution(klines, side, entryPrice, setup) {
  let isBe = false;
  let outcome = 'TIMEOUT';
  let exitPrice = entryPrice;
  let holdingMinutes = 0;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    holdingMinutes += 5;

    if (side === 'LONG' || side === 'BUY') {
      if (!isBe && k.high >= setup.beTriggerPrice) {
        isBe = true;
      }
      if (k.high >= setup.tpPrice) {
        outcome = 'TP';
        exitPrice = setup.tpPrice;
        break;
      }
      if (isBe && k.low <= entryPrice) {
        outcome = 'BREAKEVEN';
        exitPrice = entryPrice;
        break;
      } else if (!isBe && k.low <= setup.rawSL) {
        outcome = 'SL';
        exitPrice = setup.rawSL;
        break;
      }
    } else {
      if (!isBe && k.low <= setup.beTriggerPrice) {
        isBe = true;
      }
      if (k.low <= setup.tpPrice) {
        outcome = 'TP';
        exitPrice = setup.tpPrice;
        break;
      }
      if (isBe && k.high >= entryPrice) {
        outcome = 'BREAKEVEN';
        exitPrice = entryPrice;
        break;
      } else if (!isBe && k.high >= setup.rawSL) {
        outcome = 'SL';
        exitPrice = setup.rawSL;
        break;
      }
    }
  }

  const pnlPct = side === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  return {
    outcome,
    isWin: outcome === 'TP',
    exitPrice,
    pnlPct,
    holdingMinutes
  };
}

async function mineSkippedDataset() {
  console.log('================================================================================');
  console.log('⛏️  BẮT ĐẦU KHAI PHÁ TẬP TÍN HIỆU BỊ SKIP (5,992 TÍN HIỆU)');
  console.log('================================================================================\n');

  if (!fs.existsSync(SKIPPED_FILE)) {
    console.error(`Không tìm thấy file: ${SKIPPED_FILE}`);
    return;
  }

  // 1. Đọc và lọc debounce
  console.log('1. Đang đọc và khử trùng lặp (debounce 30 phút/coin)...');
  const fileStream = fs.createReadStream(SKIPPED_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const rawSignals = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      rawSignals.push(d);
    } catch (_) {}
  }
  console.log(`   • Tổng tín hiệu thô: ${rawSignals.length}`);

  const seen = new Set();
  const debounced = [];
  for (const s of rawSignals) {
    const sym = s.symbol;
    const sig = s.signal;
    const ts = s.signalTimestamp || (s.ts ? new Date(s.ts).getTime() : 0);
    if (!sym || !sig || !ts) continue;

    const bucket = Math.floor(ts / (30 * 60 * 1000));
    const key = `${sym}_${sig}_${bucket}`;
    if (!seen.has(key)) {
      seen.add(key);
      debounced.push(s);
    }
  }
  console.log(`   • Sau khi debounce 30p: còn ${debounced.length} tín hiệu độc lập.\n`);

  // 2. Chuẩn bị file output
  // Nếu file đã có một phần, kiểm tra số dòng đã xong để resume
  const processedKeys = new Set();
  if (fs.existsSync(OUTPUT_MINED_FILE)) {
    const existingLines = fs.readFileSync(OUTPUT_MINED_FILE, 'utf8').split('\n');
    for (const l of existingLines) {
      if (!l.trim()) continue;
      try {
        const item = JSON.parse(l);
        processedKeys.add(`${item.symbol}_${item.signal}_${item.timestamp}`);
      } catch (_) {}
    }
    console.log(`2. Đã tìm thấy ${processedKeys.size} tín hiệu đã xử lý trước đó. Đang chạy tiếp (Resume)...`);
  } else {
    console.log('2. Tạo mới tệp dataset khai phá: data/ai_mined_dataset.jsonl');
  }

  const outStream = fs.createWriteStream(OUTPUT_MINED_FILE, { flags: 'a' });

  // 3. Tiến hành đối soát kết quả
  console.log('3. Đang đối soát nến Binance lịch sử và mô phỏng giao dịch...');
  let totalProcessed = processedKeys.size;
  let wins = 0;
  let bes = 0;
  let losses = 0;
  let timeouts = 0;
  let errors = 0;

  const startTime = Date.now();

  for (let i = 0; i < debounced.length; i++) {
    const sig = debounced[i];
    const sym = sig.symbol;
    const side = sig.signal;
    const entryPrice = sig.signalPrice || sig.markPrice;
    const ts = sig.signalTimestamp || (sig.ts ? new Date(sig.ts).getTime() : 0);

    const sigKey = `${sym}_${side}_${ts}`;
    if (processedKeys.has(sigKey)) continue;

    const setup = getTierSLTP(sym, side, entryPrice);
    const klines = await fetch5mKlinesWithCache(sym, ts, 24);

    if (!klines || klines.length === 0) {
      errors++;
      continue;
    }

    const sim = simulateExecution(klines, side, entryPrice, setup);

    if (sim.outcome === 'TP') wins++;
    else if (sim.outcome === 'BREAKEVEN') bes++;
    else if (sim.outcome === 'SL') losses++;
    else timeouts++;

    const record = {
      type: 'MINED_SIGNAL',
      symbol: sym,
      signal: side,
      timestamp: ts,
      entryPrice: entryPrice,
      exitPrice: sim.exitPrice,
      outcome: sim.outcome,
      isWin: sim.isWin,
      pnlPercent: Number(sim.pnlPct.toFixed(2)),
      holdingMinutes: sim.holdingMinutes,
      score: sig.score ?? 0,
      scoreReasons: sig.scoreReasons || [],
      marketCapRank: sig.marketCapRank ?? 999,
      gridWidthPct: sig.gridWidthPct ?? 3.5,
      skipReason: sig.skipReason || 'NONE'
    };

    outStream.write(JSON.stringify(record) + '\n');
    totalProcessed++;
    processedKeys.add(sigKey);

    if (totalProcessed % 100 === 0 || i === debounced.length - 1) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (totalProcessed / Math.max(1, elapsedSec)).toFixed(1);
      console.log(
        `   [Tiến độ: ${totalProcessed}/${debounced.length}] (${((totalProcessed / debounced.length) * 100).toFixed(1)}%) | ` +
        `TP: ${wins} | BE: ${bes} | SL: ${losses} | Timeout: ${timeouts} | Tốc độ: ${rate} mẫu/s`
      );
    }

    // Rate limiting delay (20ms per signal -> ~50 signals/s with cache, ~10-15 calls/s if remote)
    await sleep(25);
  }

  outStream.end();

  console.log('\n================================================================================');
  console.log('🎉 HOÀN TẤT KHAI PHÁ DỮ LIỆU!');
  console.log(`   • Tổng số mẫu đã khai phá & gán nhãn: ${totalProcessed}`);
  console.log(`   • Thắng (TP 1:1.5): ${wins}`);
  console.log(`   • Hòa (Breakeven): ${bes}`);
  console.log(`   • Thua (SL): ${losses}`);
  console.log(`   • Timeout: ${timeouts}`);
  console.log(`   • Tệp lưu: ${OUTPUT_MINED_FILE}`);
  console.log('================================================================================\n');
}

mineSkippedDataset().catch(console.error);
