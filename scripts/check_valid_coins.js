'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const { updatePricesRest, getMarkPrice, isGridWidthValid } = require('../src/pp369');

const STEP_SIZES_PATH = 'f:/LamDH/Project/369futures/data/step_sizes.json';
const MARKET_CAP_PATH = 'f:/LamDH/Project/369futures/data/market_cap_top.json';

const stepSizesData = JSON.parse(fs.readFileSync(STEP_SIZES_PATH, 'utf8'));
const marketCapList = JSON.parse(fs.readFileSync(MARKET_CAP_PATH, 'utf8')).symbols || [];

function isTop150(symbol) {
  return marketCapList.includes(symbol.toUpperCase()) || marketCapList.includes(symbol.toLowerCase());
}

const h4Cache = stepSizesData.h4Cache || {};
const YEAR_START_MS = Date.UTC(2026, 0, 1);

async function main() {
  // Lấy giá thị trường hiện tại (1 request)
  try {
    await updatePricesRest();
    console.log('[check_valid_coins] Đã lấy giá thị trường hiện tại.');
  } catch (err) {
    console.warn('[check_valid_coins] Không thể lấy giá hiện tại, fallback về giá openPrice đầu năm:', err.message);
  }

  const allValidCoins = Object.entries(h4Cache)
    .filter(([sym, e]) => {
      if (e.yearStart !== YEAR_START_MS || e.failed) return false;
      const currentPrice = getMarkPrice(sym);
      return isGridWidthValid(e, currentPrice, sym);
    })
    .map(([sym]) => sym);

  const validCoins = allValidCoins.filter(isTop150);

  console.log('Total Coins in Cache:', Object.keys(h4Cache).length);
  console.log('Total Valid Coins (theo giá hiện tại):', allValidCoins.length);
  console.log('Total Top 150 Valid Coins:', validCoins.length);
  console.log('Top 150 Valid Coins list:', validCoins);
}

main().catch(err => {
  console.error('[check_valid_coins] Fatal:', err.message);
  process.exit(1);
});
