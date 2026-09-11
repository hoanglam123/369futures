/**
 * enrich_candle_geometry.js
 * Tải klines lịch sử từ Binance và làm giàu đặc trưng nến M15 & H1 so với Entry
 * cho các lệnh trong ai_trade_dataset.jsonl và shadow_trades_history.jsonl
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { getStep } = require('../src/pp369');

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

function classifyCandleGeometry(candle, targetLevel, isLong, step) {
  if (!candle || !targetLevel || typeof candle.close !== 'number') return 'HOLD_OR_HOVER';
  const totalRange = Math.max(1e-9, candle.high - candle.low);
  const stepDist = step || (targetLevel * 0.01);
  const deepThreshold = Math.max(stepDist * 0.10, targetLevel * 0.002);

  if (isLong) {
    if (candle.close < targetLevel) {
      return (targetLevel - candle.close >= deepThreshold) ? 'PUNCTURED_DEEP' : 'PUNCTURED_LIGHT';
    } else {
      if (candle.low <= targetLevel) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick / totalRange >= 0.30) return 'REJECT_PINBAR';
      }
      return 'HOLD_OR_HOVER';
    }
  } else {
    if (candle.close > targetLevel) {
      return (candle.close - targetLevel >= deepThreshold) ? 'PUNCTURED_DEEP' : 'PUNCTURED_LIGHT';
    } else {
      if (candle.high >= targetLevel) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / totalRange >= 0.30) return 'REJECT_PINBAR';
      }
      return 'HOLD_OR_HOVER';
    }
  }
}

async function getCachedKlines(symbol, interval, minTime, maxTime) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  let klines = [];
  if (fs.existsSync(cacheFile)) {
    try {
      klines = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
  }

  // Nếu klines chưa phủ đủ minTime, fetch thêm
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

    fs.writeFileSync(cacheFile, JSON.stringify(klines));
  }

  return klines;
}

function findCandleAtTime(klines, timestamp) {
  if (!klines || !klines.length) return null;
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].openTime <= timestamp && timestamp <= klines[i].closeTime + 60000) {
      return klines[i];
    }
  }
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].openTime <= timestamp) return klines[i];
  }
  return null;
}

async function runEnrichment() {
  console.log('🚀 BẮT ĐẦU LÀM GIÀU ĐẶC TRƯNG HÌNH THÁI NẾN M15/H1 CHO TẬP DỮ LIỆU...');

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

  const aiEntries = [];
  if (fs.existsSync(AI_DATASET_PATH)) {
    fs.readFileSync(AI_DATASET_PATH, 'utf8').split('\n').forEach(l => {
      if (l.trim()) {
        try {
          const r = JSON.parse(l);
          aiEntries.push(r);
          if (r.type === 'ENTRY') trackSym(r.symbol, r.timestamp);
        } catch (e) {}
      }
    });
  }

  const shadowEntries = [];
  if (fs.existsSync(SHADOW_PATH)) {
    fs.readFileSync(SHADOW_PATH, 'utf8').split('\n').forEach(l => {
      if (l.trim()) {
        try {
          const r = JSON.parse(l);
          shadowEntries.push(r);
          trackSym(r.symbol, r.entryTimestamp);
        } catch (e) {}
      }
    });
  }

  console.log(`📊 Tổng ${symbolsMeta.size} symbols duy nhất cần nạp klines.`);

  const symArray = Array.from(symbolsMeta.keys());
  const klines1hMap = new Map();
  const klines15mMap = new Map();

  for (let i = 0; i < symArray.length; i += 8) {
    const batch = symArray.slice(i, i + 8);
    await Promise.all(batch.map(async (sym) => {
      const m = symbolsMeta.get(sym);
      const k1h = await getCachedKlines(sym, '1h', m.minTime - 3600000, m.maxTime);
      const k15m = await getCachedKlines(sym, '15m', m.minTime - 1800000, m.maxTime);
      klines1hMap.set(sym, k1h);
      klines15mMap.set(sym, k15m);
    }));
    process.stdout.write(`\r[${Math.min(i + 8, symArray.length)}/${symArray.length}] symbols klines cached...`);
  }
  console.log('\n✅ Hoàn tất nạp klines.');

  let enrichedAICount = 0;
  aiEntries.forEach(r => {
    if (r.type === 'ENTRY' && r.entryPrice && r.signal) {
      const sym = r.symbol;
      const time = r.timestamp;
      const isLong = r.signal === 'LONG' || r.signal === 'BUY';
      const step = getStep(r.entryPrice);

      const k1h = klines1hMap.get(sym);
      const k15m = klines15mMap.get(sym);
      const c1h = findCandleAtTime(k1h, time);
      const c15m = findCandleAtTime(k15m, time);

      const h1Geom = classifyCandleGeometry(c1h, r.entryPrice, isLong, step);
      const m15Geom = classifyCandleGeometry(c15m, r.entryPrice, isLong, step);

      r.h1CandleGeometry = h1Geom;
      r.m15CandleGeometry = m15Geom;

      let reasons = r.scoreReasons || [];
      reasons = reasons.filter(s => !s.startsWith('[Hình thái nến M15/H1]'));

      const h1Txt = h1Geom === 'PUNCTURED_DEEP' ? `🚨 H1 đóng nến lụt sâu qua Entry (Close $${c1h?.close} vs Entry $${r.entryPrice})`
        : (h1Geom === 'PUNCTURED_LIGHT' ? `⚠️ H1 đóng nến chớm lụt qua Entry`
        : (h1Geom === 'REJECT_PINBAR' ? `✓ H1 rút chân/rút râu giữ vững Entry` : `H1 giữ cấu trúc bình thường`));

      const m15Txt = m15Geom === 'PUNCTURED_DEEP' ? `🚨 M15 đóng nến lụt sâu qua Entry (Close $${c15m?.close} vs Entry $${r.entryPrice})`
        : (m15Geom === 'PUNCTURED_LIGHT' ? `⚠️ M15 đóng nến chớm lụt qua Entry`
        : (m15Geom === 'REJECT_PINBAR' ? `✓ M15 rút chân/rút râu phản ứng tại Entry` : `M15 giữ cấu trúc bình thường`));

      reasons.push(`[Hình thái nến M15/H1] ${h1Txt} | ${m15Txt}`);
      r.scoreReasons = reasons;
      enrichedAICount++;
    }
  });

  fs.writeFileSync(AI_DATASET_PATH, aiEntries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`✅ Đã làm giàu ${enrichedAICount} mẫu trong ai_trade_dataset.jsonl`);

  let enrichedShadowCount = 0;
  shadowEntries.forEach(r => {
    if (r.entryPrice && r.signal) {
      const sym = r.symbol;
      const time = r.entryTimestamp;
      const isLong = r.signal === 'LONG' || r.signal === 'BUY';
      const step = getStep(r.entryPrice);

      const k1h = klines1hMap.get(sym);
      const k15m = klines15mMap.get(sym);
      const c1h = findCandleAtTime(k1h, time);
      const c15m = findCandleAtTime(k15m, time);

      const h1Geom = classifyCandleGeometry(c1h, r.entryPrice, isLong, step);
      const m15Geom = classifyCandleGeometry(c15m, r.entryPrice, isLong, step);

      r.h1CandleGeometry = h1Geom;
      r.m15CandleGeometry = m15Geom;

      let reasons = r.scoreReasons || [];
      reasons = reasons.filter(s => !s.startsWith('[Hình thái nến M15/H1]'));

      const h1Txt = h1Geom === 'PUNCTURED_DEEP' ? `🚨 H1 đóng nến lụt sâu qua Entry (Close $${c1h?.close} vs Entry $${r.entryPrice})`
        : (h1Geom === 'PUNCTURED_LIGHT' ? `⚠️ H1 đóng nến chớm lụt qua Entry`
        : (h1Geom === 'REJECT_PINBAR' ? `✓ H1 rút chân/rút râu giữ vững Entry` : `H1 giữ cấu trúc bình thường`));

      const m15Txt = m15Geom === 'PUNCTURED_DEEP' ? `🚨 M15 đóng nến lụt sâu qua Entry (Close $${c15m?.close} vs Entry $${r.entryPrice})`
        : (m15Geom === 'PUNCTURED_LIGHT' ? `⚠️ M15 đóng nến chớm lụt qua Entry`
        : (m15Geom === 'REJECT_PINBAR' ? `✓ M15 rút chân/rút râu phản ứng tại Entry` : `M15 giữ cấu trúc bình thường`));

      reasons.push(`[Hình thái nến M15/H1] ${h1Txt} | ${m15Txt}`);
      r.scoreReasons = reasons;
      enrichedShadowCount++;
    }
  });

  fs.writeFileSync(SHADOW_PATH, shadowEntries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`✅ Đã làm giàu ${enrichedShadowCount} mẫu trong shadow_trades_history.jsonl`);
  console.log('🎉 TOÀN BỘ DỮ LIỆU ĐÃ ĐƯỢC CHUẨN HÓA VÀ LÀM GIÀU!');
}

runEnrichment().catch(console.error);
