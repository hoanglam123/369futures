'use strict';

const { updatePricesRest, getLevelCache, getNearbySymbols, getMarkPrice, isGridWidthValid } = require('../src/pp369');
const fs = require('fs');
const path = require('path');

async function test() {
  // Simulate startup when prices are empty
  const levelCacheBefore = getLevelCache();
  console.log('1. levelCache initialized BEFORE prices fetched.');
  console.log('BTC levels before:', levelCacheBefore['BTC']);

  // Fetch prices
  await updatePricesRest();

  const stepDataPath = path.join(__dirname, '../data/step_sizes.json');
  const stepData = JSON.parse(fs.readFileSync(stepDataPath, 'utf8'));

  const validSymbols = Object.entries(stepData.h4Cache || {})
    .filter(([sym, e]) => {
      if (e.failed) return false;
      const cp = getMarkPrice(sym);
      return isGridWidthValid(e, cp, sym);
    })
    .map(([sym]) => sym);

  // Check nearby with stale levelCache (without forceRefresh)
  const nearbyStale = getNearbySymbols(validSymbols, getLevelCache(), 0.003, true);
  console.log(`\n2. Nearby count with stale levelCache: ${nearbyStale.length}`);

  // Now forceRefresh levelCache AFTER prices fetched
  const levelCacheFresh = getLevelCache(true);
  console.log('\n3. BTC levels AFTER forceRefresh:', levelCacheFresh['BTC']);
  const nearbyFresh = getNearbySymbols(validSymbols, levelCacheFresh, 0.003, true);
  console.log(`4. Nearby count with FRESH levelCache: ${nearbyFresh.length}`);
}

test().catch(console.error);
