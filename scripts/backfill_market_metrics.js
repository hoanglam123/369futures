/**
 * backfill_market_metrics.js
 * Làm giàu dữ liệu số học (marketMetrics: Range %, Vol Ratio của M15 & H1)
 * cho toàn bộ bản ghi trong data/ai_trade_dataset.jsonl và data/shadow_trades_history.jsonl
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AI_DATASET_PATH = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');
const SHADOW_PATH = path.join(DATA_DIR, 'shadow_trades_history.jsonl');
const CACHE_DIR = path.join(DATA_DIR, 'klines_cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function fetchBinanceKlines(symbol, interval, endTime, limit = 1000) {
  return new Promise((resolve) => {
    let sym = symbol.toUpperCase();
    if (!sym.endsWith('USDT')) sym += 'USDT';
    let url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            const mapped = parsed.map(c => ({
              openTime: c[0],
              open: parseFloat(c[1]),
              high: parseFloat(c[2]),
              low: parseFloat(c[3]),
              close: parseFloat(c[4]),
              volume: parseFloat(c[5]),
              closeTime: c[6],
            }));
            resolve(mapped);
            return;
          }
        } catch (e) {}
        resolve([]);
      });
    }).on('error', () => resolve([]));
  });
}

async function getCachedKlines(symbol, interval, minTime, maxTime) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  let klines = [];
  if (fs.existsSync(cacheFile)) {
    try {
      klines = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
  }

  const klinesMin = klines.length ? klines[0].openTime : Infinity;
  const klinesMax = klines.length ? klines[klines.length - 1].closeTime : -Infinity;

  if (!klines.length || klinesMin > minTime || klinesMax < maxTime) {
    const batch1 = await fetchBinanceKlines(symbol, interval, null, 1000);
    let allKlines = [...batch1];

    if (allKlines.length && allKlines[0].openTime > minTime) {
      const oldestTime = allKlines[0].openTime - 1;
      const batch2 = await fetchBinanceKlines(symbol, interval, oldestTime, 1000);
      allKlines = [...batch2, ...allKlines];
    }

    const map = new Map();
    [...klines, ...allKlines].forEach(k => map.set(k.openTime, k));
    klines = Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);

    try {
      fs.writeFileSync(cacheFile, JSON.stringify(klines));
    } catch (_) {}
  }

  return klines;
}

function findCandleIndexAtTime(klines, timestamp) {
  if (!klines || !klines.length) return -1;
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].openTime <= timestamp && timestamp <= klines[i].closeTime + 60000) {
      return i;
    }
  }
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].openTime <= timestamp) return i;
  }
  return -1;
}

function computeMetrics(k15mList, idx15m, k1hList, idx1h) {
  if (idx15m < 0 || !k15mList[idx15m]) return null;
  const c15m = k15mList[idx15m];
  const m15RangePct = Number((((c15m.high - c15m.low) / (c15m.low || 1)) * 100).toFixed(2));
  const m15BodyPct = Number(((Math.abs(c15m.close - c15m.open) / (c15m.low || 1)) * 100).toFixed(2));
  const m15IsGreen = c15m.close >= c15m.open;

  let m15VolRatio = 1.0;
  if (idx15m >= 1) {
    const startIdx = Math.max(0, idx15m - 20);
    const base = k15mList.slice(startIdx, idx15m);
    if (base.length > 0) {
      const avg = base.reduce((s, c) => s + c.volume, 0) / base.length;
      if (avg > 0) m15VolRatio = Number((c15m.volume / avg).toFixed(2));
    }
  }

  const lastClosedM15 = idx15m >= 1 ? k15mList[idx15m - 1] : null;
  const lastClosedM15RangePct = lastClosedM15 ? Number((((lastClosedM15.high - lastClosedM15.low) / (lastClosedM15.low || 1)) * 100).toFixed(2)) : null;

  let h1RangePct = null;
  let h1VolRatio = 1.0;
  let lastClosedH1RangePct = null;

  if (idx1h >= 0 && k1hList[idx1h]) {
    const c1h = k1hList[idx1h];
    h1RangePct = Number((((c1h.high - c1h.low) / (c1h.low || 1)) * 100).toFixed(2));
    if (idx1h >= 1) {
      const startIdx = Math.max(0, idx1h - 24);
      const baseH1 = k1hList.slice(startIdx, idx1h);
      if (baseH1.length > 0) {
        const avgH1 = baseH1.reduce((s, c) => s + c.volume, 0) / baseH1.length;
        if (avgH1 > 0) h1VolRatio = Number((c1h.volume / avgH1).toFixed(2));
      }
    }
    const lastClosedH1 = idx1h >= 1 ? k1hList[idx1h - 1] : null;
    lastClosedH1RangePct = lastClosedH1 ? Number((((lastClosedH1.high - lastClosedH1.low) / (lastClosedH1.low || 1)) * 100).toFixed(2)) : null;
  }

  return {
    m15RangePct,
    m15VolRatio,
    h1RangePct,
    h1VolRatio,
    lastClosedM15RangePct,
    lastClosedH1RangePct,
    m15BodyPct,
    m15IsGreen
  };
}

async function runBackfill() {
  console.log('🚀 BẮT ĐẦU BACKFILL SỐ LIỆU THỊ TRƯỜNG CHO TẬP DỮ LIỆU AI...');

  const symbolsMeta = new Map();

  function trackSym(sym, time) {
    if (!sym || !time) return;
    if (!symbolsMeta.has(sym)) {
      symbolsMeta.set(sym, { minTime: time, maxTime: time });
    } else {
      const m = symbolsMeta.get(sym);
      m.minTime = Math.min(m.minTime, time);
      m.maxTime = Math.max(m.maxTime, time);
    }
  }

  const aiRecords = [];
  if (fs.existsSync(AI_DATASET_PATH)) {
    fs.readFileSync(AI_DATASET_PATH, 'utf8').split('\n').forEach(l => {
      if (l.trim()) {
        try {
          const r = JSON.parse(l);
          aiRecords.push(r);
          if (r.type === 'ENTRY' && r.symbol && r.timestamp) {
            trackSym(r.symbol, r.timestamp);
          }
        } catch (_) {}
      }
    });
  }

  const shadowRecords = [];
  if (fs.existsSync(SHADOW_PATH)) {
    fs.readFileSync(SHADOW_PATH, 'utf8').split('\n').forEach(l => {
      if (l.trim()) {
        try {
          const r = JSON.parse(l);
          shadowRecords.push(r);
          if (r.symbol && (r.entryTimestamp || r.timestamp)) {
            trackSym(r.symbol, r.entryTimestamp || r.timestamp);
          }
        } catch (_) {}
      }
    });
  }

  console.log(`📊 Tìm thấy ${aiRecords.length} records trong ai_trade_dataset.jsonl`);
  console.log(`📊 Tìm thấy ${shadowRecords.length} records trong shadow_trades_history.jsonl`);
  console.log(`📊 Cần nạp nến cho ${symbolsMeta.size} symbols duy nhất.`);

  const symArray = Array.from(symbolsMeta.keys());
  const klines1hMap = new Map();
  const klines15mMap = new Map();

  for (let i = 0; i < symArray.length; i += 8) {
    const batch = symArray.slice(i, i + 8);
    await Promise.all(batch.map(async (sym) => {
      const m = symbolsMeta.get(sym);
      const k1h = await getCachedKlines(sym, '1h', m.minTime - 36 * 3600000, m.maxTime);
      const k15m = await getCachedKlines(sym, '15m', m.minTime - 12 * 3600000, m.maxTime);
      klines1hMap.set(sym, k1h);
      klines15mMap.set(sym, k15m);
    }));
    process.stdout.write(`\r[${Math.min(i + 8, symArray.length)}/${symArray.length}] symbols klines cached...`);
  }
  console.log('\n✅ Đã tải và nạp xong toàn bộ klines vào RAM.');

  let enrichedAICount = 0;
  for (const r of aiRecords) {
    if (r.type === 'ENTRY' && r.symbol && r.timestamp) {
      const sym = r.symbol;
      const time = r.timestamp;
      const k15m = klines15mMap.get(sym) || [];
      const k1h = klines1hMap.get(sym) || [];
      const idx15m = findCandleIndexAtTime(k15m, time);
      const idx1h = findCandleIndexAtTime(k1h, time);
      const metrics = computeMetrics(k15m, idx15m, k1h, idx1h);
      if (metrics) {
        r.marketMetrics = metrics;
        enrichedAICount++;
      }
    }
  }

  let enrichedShadowCount = 0;
  for (const r of shadowRecords) {
    const sym = r.symbol;
    const time = r.entryTimestamp || r.timestamp;
    if (sym && time) {
      const k15m = klines15mMap.get(sym) || [];
      const k1h = klines1hMap.get(sym) || [];
      const idx15m = findCandleIndexAtTime(k15m, time);
      const idx1h = findCandleIndexAtTime(k1h, time);
      const metrics = computeMetrics(k15m, idx15m, k1h, idx1h);
      if (metrics) {
        r.marketMetrics = metrics;
        enrichedShadowCount++;
      }
    }
  }

  console.log(`\n💾 Đang tạo bản sao lưu (.bak) và ghi lại file dữ liệu...`);
  if (fs.existsSync(AI_DATASET_PATH)) {
    fs.copyFileSync(AI_DATASET_PATH, `${AI_DATASET_PATH}.bak`);
    const aiOutput = aiRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(AI_DATASET_PATH, aiOutput, 'utf8');
    console.log(`✓ Đã cập nhật ${enrichedAICount} bản ghi ENTRY trong ai_trade_dataset.jsonl`);
  }

  if (fs.existsSync(SHADOW_PATH)) {
    fs.copyFileSync(SHADOW_PATH, `${SHADOW_PATH}.bak`);
    const shadowOutput = shadowRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(SHADOW_PATH, shadowOutput, 'utf8');
    console.log(`✓ Đã cập nhật ${enrichedShadowCount} bản ghi trong shadow_trades_history.jsonl`);
  }

  console.log('\n🎉 HOÀN TẤT BACKFILL MARKET METRICS THÀNH CÔNG!');
}

runBackfill().catch(console.error);
