'use strict';

const { updatePricesRest, getLevelCache, getMarkPrice, isGridWidthValid } = require('../src/pp369');
const fs = require('fs');
const path = require('path');

async function diagnose() {
  await updatePricesRest();

  const stepDataPath = path.join(__dirname, '../data/step_sizes.json');
  const stepData = JSON.parse(fs.readFileSync(stepDataPath, 'utf8'));
  const levelCache = getLevelCache();

  const validSymbols = Object.entries(stepData.h4Cache || {})
    .filter(([sym, e]) => {
      if (e.failed) return false;
      const cp = getMarkPrice(sym);
      return isGridWidthValid(e, cp, sym);
    })
    .map(([sym]) => sym);

  console.log(`Valid symbols: ${validSymbols.length}`);

  const distances = [];

  for (const sym of validSymbols) {
    const price = getMarkPrice(sym);
    const levels = levelCache[sym];
    if (!price || !levels?.longEntry || !levels?.shortEntry) continue;

    const gridPct = ((levels.shortEntry - levels.longEntry) / levels.longEntry) * 100;
    const distLongPct = Math.abs(price - levels.longEntry) / price * 100;
    const distShortPct = Math.abs(levels.shortEntry - price) / price * 100;
    const minDistPct = Math.min(distLongPct, distShortPct);

    distances.push({ sym, price, longEntry: levels.longEntry, shortEntry: levels.shortEntry, gridPct, minDistPct });
  }

  distances.sort((a, b) => a.minDistPct - b.minDistPct);

  console.log('\nTop 10 closest coins:');
  distances.slice(0, 10).forEach((item, idx) => {
    console.log(`${idx + 1}. ${item.sym.padEnd(10)} | Price: ${item.price} | Long: ${item.longEntry} | Short: ${item.shortEntry} | GridPct: ${item.gridPct.toFixed(2)}% | MinDist: ${item.minDistPct.toFixed(3)}%`);
  });

  const countUnder03 = distances.filter(d => d.minDistPct <= 0.3 && d.gridPct >= 3 && d.gridPct <= 20).length;
  console.log(`\nCoins with minDist <= 0.3% AND gridPct between 3-20%: ${countUnder03}`);
}

diagnose().catch(console.error);
