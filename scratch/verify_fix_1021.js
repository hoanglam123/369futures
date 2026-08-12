'use strict';

const { isIpBanned, triggerCircuitBreaker, setOnUnbanCallback } = require('../src/trader/circuitBreaker');

console.log('[Verification] Testing circuitBreaker & binance modules...');

let unbanTriggered = false;
setOnUnbanCallback(() => {
  unbanTriggered = true;
  console.log('[Verification] ✓ onUnbanCallback triggered successfully!');
});

// Test trigger circuit breaker and then unban transition
console.log('Initially isIpBanned():', isIpBanned());
triggerCircuitBreaker(Date.now() + 100, 'TestUnit');
console.log('During ban isIpBanned():', isIpBanned());

setTimeout(() => {
  const bannedNow = isIpBanned();
  console.log('After timer expires isIpBanned():', bannedNow);
  console.log('unbanTriggered:', unbanTriggered);

  if (!bannedNow && unbanTriggered) {
    console.log('[Verification] All tests passed cleanly!');
    process.exit(0);
  } else {
    console.error('[Verification] Test failed!');
    process.exit(1);
  }
}, 200);
