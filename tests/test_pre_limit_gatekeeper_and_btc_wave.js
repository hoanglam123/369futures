'use strict';

const assert = require('assert');
const { checkPreLimitTacticalGatekeeper } = require('../src/trader/autoTrade');

console.log('--- RUNNING TESTS FOR PRE-LIMIT GATEKEEPER & BTC WAVE ---');

let testsPassed = 0;
let testsTotal = 0;

function runTest(name, fn) {
  testsTotal++;
  try {
    fn();
    console.log(`  ✓ [PASS] ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

// 1. Normal safe condition
runTest('Gatekeeper passes when conditions are calm and balanced', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'SOL',
    signal: 'LONG',
    targetLevel: 150.0,
    markPrice: 150.1,
    currM15: {
      open: 150.5,
      close: 150.2,
      high: 150.8,
      low: 150.0 // 0.5% move, lower wick exists
    },
    microstructure: {
      takerBuyRatio: 0.52,
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, true);
});

// 2. M15 Marubozu Dump into LONG
runTest('Gatekeeper BLOCKS when M15 is a dumping Marubozu into LONG', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'SOL',
    signal: 'LONG',
    targetLevel: 150.0,
    markPrice: 150.05,
    currM15: {
      open: 152.0,
      close: 150.1, // Body 1.9 (1.26%), High 152.0, Low 150.0 -> Wick below is 0.1 / 2.0 = 5%
      high: 152.0,
      low: 150.0
    },
    microstructure: {
      takerBuyRatio: 0.45,
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, false);
  assert.ok(result.reason.includes('Marubozu xả dốc'));
});

// 3. M15 with lower wick rejection into LONG -> should pass Marubozu check
runTest('Gatekeeper PASSES when M15 has formed a lower wick rejection (absorption)', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'SOL',
    signal: 'LONG',
    targetLevel: 150.0,
    markPrice: 150.8,
    currM15: {
      open: 151.5,
      close: 150.8,
      high: 151.8,
      low: 149.5 // Wick below is 150.8 - 149.5 = 1.3 out of 2.3 = 56% wick!
    },
    microstructure: {
      takerBuyRatio: 0.48,
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, true);
});

// 4. M15 Marubozu Rocket Pump into SHORT -> should block
runTest('Gatekeeper BLOCKS when M15 is a rocket pumping Marubozu into SHORT', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'ETH',
    signal: 'SHORT',
    targetLevel: 2600.0,
    markPrice: 2598.0,
    currM15: {
      open: 2560.0,
      close: 2598.0, // Body 38 (1.48%), High 2600.0, Low 2560.0 -> Wick above is 2.0 / 40 = 5%
      high: 2600.0,
      low: 2560.0
    },
    microstructure: {
      takerBuyRatio: 0.55,
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, false);
  assert.ok(result.reason.includes('Marubozu bơm dốc'));
});

// 5. High Taker Sell ratio into LONG
runTest('Gatekeeper BLOCKS when Taker Sell is >= 75% into LONG', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'AVAX',
    signal: 'LONG',
    targetLevel: 30.0,
    markPrice: 30.05,
    currM15: {
      open: 30.1,
      close: 30.05,
      high: 30.2,
      low: 30.0
    },
    microstructure: {
      takerBuyRatio: 0.20, // 80% Taker Sell!
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, false);
  assert.ok(result.reason.includes('Taker Sell'));
});

// 6. High Taker Buy ratio into SHORT
runTest('Gatekeeper BLOCKS when Taker Buy is >= 75% into SHORT', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'AVAX',
    signal: 'SHORT',
    targetLevel: 30.0,
    markPrice: 29.95,
    currM15: {
      open: 29.9,
      close: 29.95,
      high: 30.0,
      low: 29.8
    },
    microstructure: {
      takerBuyRatio: 0.82, // 82% Taker Buy!
      wall: 'WALL_CLEAR_PATH'
    }
  });

  assert.strictEqual(result.passed, false);
  assert.ok(result.reason.includes('Taker Buy'));
});

// 7. Orderbook Wall Crushing into LONG
runTest('Gatekeeper BLOCKS when an ask wall is crushing down on Entry for LONG', () => {
  const result = checkPreLimitTacticalGatekeeper({
    sym: 'NEAR',
    signal: 'LONG',
    targetLevel: 5.0,
    markPrice: 5.01,
    currM15: {
      open: 5.02,
      close: 5.01,
      high: 5.03,
      low: 5.0
    },
    microstructure: {
      takerBuyRatio: 0.50,
      wall: 'WALL_CRUSHING_ENTRY'
    }
  });

  assert.strictEqual(result.passed, false);
  assert.ok(result.reason.includes('Orderbook Wall Crushing'));
});

console.log(`\nTests Completed: ${testsPassed}/${testsTotal} passed.`);
if (testsPassed !== testsTotal) {
  process.exit(1);
} else {
  console.log('All tests passed successfully!');
}
