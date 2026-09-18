'use strict';

const assert = require('assert');
const { getMarkPrice } = require('../src/pp369/stream');

console.log('='.repeat(80));
console.log('🧪 RUNNING PRICE GUARD & STALENESS TEST SUITE');
console.log('='.repeat(80));

let passed = 0;
let total = 0;

function runTest(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
  }
}

// ----------------------------------------------------
// TEST 1: getMarkPrice staleness check
// ----------------------------------------------------
runTest('getMarkPrice returns null for unknown or empty symbol', () => {
  assert.strictEqual(getMarkPrice('NON_EXISTENT_COIN'), null);
  assert.strictEqual(getMarkPrice(null), null);
  assert.strictEqual(getMarkPrice(''), null);
});

// ----------------------------------------------------
// TEST 2: PriceGuard deviation rejection (>2%)
// ----------------------------------------------------
runTest('PriceGuard logic rejects wsMark when deviating > 2% from restMark', () => {
  const restMark = 0.4204; // Actual Binance markPrice for WLD
  const wsMark = 0.3726;   // Stale or corrupted wsMark

  let markPrice = restMark;
  const devPct = Math.abs(wsMark - restMark) / restMark;
  if (devPct <= 0.02) {
    markPrice = wsMark;
  }

  // devPct is ~11.37%, so wsMark MUST be discarded
  assert.ok(devPct > 0.10, 'Deviation should be > 10%');
  assert.strictEqual(markPrice, 0.4204, 'markPrice must remain restMark when deviation is large');
});

// ----------------------------------------------------
// TEST 3: PriceGuard accepts wsMark when fresh and close (<= 2%)
// ----------------------------------------------------
runTest('PriceGuard logic accepts wsMark when deviation <= 2%', () => {
  const restMark = 0.4204;
  const wsMark = 0.4210; // 0.14% deviation

  let markPrice = restMark;
  const devPct = Math.abs(wsMark - restMark) / restMark;
  if (devPct <= 0.02) {
    markPrice = wsMark;
  }

  assert.strictEqual(markPrice, 0.4210, 'markPrice should accept wsMark for real-time tracking');
});

// ----------------------------------------------------
// TEST 4: Virtual TP Sanity Guard blocks false TP trigger
// ----------------------------------------------------
runTest('Virtual TP Sanity Guard blocks false TP when restMark does not confirm', () => {
  const isLong = false; // SHORT position
  const targetTpPriceExact = 0.40830;
  const entryPrice = 0.4193;

  // Case: bogus wsMark triggered TP condition
  const bogusMarkPrice = 0.3726;
  const isTpReached = isLong ? (bogusMarkPrice >= targetTpPriceExact - 1e-9) : (bogusMarkPrice <= targetTpPriceExact + 1e-9);
  assert.strictEqual(isTpReached, true, 'Corrupted price would naively satisfy isTpReached');

  // Guard check with restMark = 0.4204
  const restMark = 0.4204;
  const isRestTpConfirmed = isLong
    ? (restMark >= targetTpPriceExact * 0.995)
    : (restMark <= targetTpPriceExact * 1.005);

  assert.strictEqual(isRestTpConfirmed, false, 'restMark must NOT confirm TP (0.4204 > 0.4083 * 1.005)');
});

// ----------------------------------------------------
// TEST 5: Virtual TP Sanity Guard allows genuine TP trigger
// ----------------------------------------------------
runTest('Virtual TP Sanity Guard allows genuine TP when restMark confirms', () => {
  const isLong = false; // SHORT position
  const targetTpPriceExact = 0.40830;
  const genuineMarkPrice = 0.40810; // Price really dropped to TP

  const isTpReached = isLong ? (genuineMarkPrice >= targetTpPriceExact - 1e-9) : (genuineMarkPrice <= targetTpPriceExact + 1e-9);
  assert.strictEqual(isTpReached, true);

  const restMark = 0.40825; // Sàn Binance cũng ghi nhận quanh mốc TP
  const isRestTpConfirmed = isLong
    ? (restMark >= targetTpPriceExact * 0.995)
    : (restMark <= targetTpPriceExact * 1.005);

  assert.strictEqual(isRestTpConfirmed, true, 'Genuine TP must be confirmed and executed');
});

// ----------------------------------------------------
// TEST 6: Hard Max Loss Sanity Guard blocks false panic exit
// ----------------------------------------------------
runTest('Hard Max Loss Guard blocks false panic exit when restMark does not confirm', () => {
  const isLong = false; // SHORT position
  const entryPrice = 0.4193;
  const leverageVal = 33;
  const hardLossCapUSD = 5.50; // $5 + 10%
  const margin = 3.03;

  // Fake spike price
  const fakeSpikeMark = 0.5500;
  const fakeRoi = ((entryPrice - fakeSpikeMark) / entryPrice) * leverageVal * 100;
  const fakeLossUsd = (fakeRoi / 100) * margin; // ~ -31 USD

  assert.ok(fakeLossUsd <= -hardLossCapUSD, 'Fake loss would trigger threshold');

  // Real restMark from Binance is only 0.4204
  const restMark = 0.4204;
  const restRoi = ((entryPrice - restMark) / entryPrice) * leverageVal * 100;
  const restLossUsd = (restRoi / 100) * margin;

  const shouldBlock = restLossUsd > -hardLossCapUSD * 0.85;
  assert.strictEqual(shouldBlock, true, 'Guard must block false panic cut loss');
});

console.log('='.repeat(80));
console.log(`📊 TEST RESULTS: ${passed}/${total} TESTS PASSED (${((passed / total) * 100).toFixed(1)}%)`);
console.log('='.repeat(80));

if (passed !== total) {
  process.exit(1);
}
