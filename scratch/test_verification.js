'use strict';

const circuitBreaker = require('../src/trader/circuitBreaker');
const binance = require('../src/trader/binance');
const core = require('../src/pp369/core');
const stream = require('../src/pp369/stream');
const autoTrade = require('../src/trader/autoTrade');

console.log('Testing Circuit Breaker module:');
console.log('isIpBanned initially:', circuitBreaker.isIpBanned());

// Test triggering circuit breaker
circuitBreaker.triggerCircuitBreaker({ response: { status: 418, data: { msg: 'IP banned until 1786548357000' } } }, 'Test');
console.log('isIpBanned after trigger:', circuitBreaker.isIpBanned());
console.log('getIpBannedUntil:', circuitBreaker.getIpBannedUntil());

try {
  circuitBreaker.checkCircuitBreaker();
  console.error('FAIL: checkCircuitBreaker did not throw!');
} catch (e) {
  console.log('SUCCESS: checkCircuitBreaker threw expected error:', e.message);
}

console.log('All modules loaded and syntax verified successfully!');
