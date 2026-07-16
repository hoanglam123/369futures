'use strict';
const fs = require('fs');

const STEP_SIZES_PATH = 'f:/LamDH/Project/369futures/data/step_sizes.json';
const MARKET_CAP_PATH = 'f:/LamDH/Project/369futures/data/market_cap_top.json';

const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
const marketCapList = JSON.parse(fs.readFileSync(MARKET_CAP_PATH, 'utf8')).symbols || [];

function isTop150(symbol) {
  return marketCapList.includes(symbol.toUpperCase()) || marketCapList.includes(symbol.toLowerCase());
}

const h4Cache = stepSizesData.h4Cache || {};
const YEAR_START_MS = Date.UTC(2026, 0, 1);
const GRID_MIN_PCT = 3;
const GRID_MAX_PCT = 20;

function getGridStepPct(e) {
  return (e.step / e.openPrice) * 100;
}

function isGridWidthValid(e) {
  const pct = getGridStepPct(e);
  return pct >= GRID_MIN_PCT && pct <= GRID_MAX_PCT;
}

const allValidCoins = Object.entries(h4Cache)
  .filter(([, e]) => e.yearStart === YEAR_START_MS && !e.failed && isGridWidthValid(e))
  .map(([sym]) => sym);

const validCoins = allValidCoins.filter(isTop150);

console.log('Total Coins in Cache:', Object.keys(h4Cache).length);
console.log('Total Valid Coins:', allValidCoins.length);
console.log('Total Top 150 Valid Coins:', validCoins.length);
console.log('Top 150 Valid Coins list:', validCoins);
