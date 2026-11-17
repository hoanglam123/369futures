'use strict';

const binance = require('./binance');
const binanceStream = require('./binanceStream');
const bracketManager = require('./bracketManager');
const safetyBrake = require('./safetyBrake');
const cooldownManager = require('./cooldownManager');
const circuitBreaker = require('./circuitBreaker');
const directionalCircuitBreaker = require('./directionalCircuitBreaker');
const economicCalendar = require('./economicCalendar');
const microstructureScanner = require('./microstructureScanner');
const rollingPerformanceGuard = require('./rollingPerformanceGuard');

module.exports = {
  // Binance REST
  createClient: binance.createClient,
  loadStepSizes: binance.loadStepSizes,
  loadLeverageBrackets: binance.loadLeverageBrackets,
  calcQuantity: binance.calcQuantity,
  syncTimeOffset: binance.syncTimeOffset,
  getSymbolTickSizeSync: binance.getSymbolTickSizeSync,
  getSymbolStepSizeSync: binance.getSymbolStepSizeSync,

  // Binance WebSocket User Data Stream (Phase 4)
  startBinanceStream: binanceStream.startStream,
  stopBinanceStream: binanceStream.stopStream,
  onEntryFill: binanceStream.onEntryFill,
  onOrderFill: binanceStream.onOrderFill,
  onOrderCancel: binanceStream.onOrderCancel,
  onOrderPartialFill: binanceStream.onOrderPartialFill,
  onAccountUpdate: binanceStream.onAccountUpdate,
  isStreamConnected: binanceStream.isStreamConnected,
  getListenKey: binanceStream.getListenKey,
  handleStreamMessage: binanceStream.handleMessage,

  // Bracket Orders & Dynamic SL Ratchet (Phase 4)
  placeDualBracket: bracketManager.placeDualBracket,
  ratchetBreakeven: bracketManager.ratchetBreakeven,
  ratchetTrailingFractal: bracketManager.ratchetTrailingFractal,
  autoCleanOppositeOrder: bracketManager.autoCleanOppositeOrder,
  MIN_RR_RATIO: bracketManager.MIN_RR_RATIO,

  // Safety Brake & Reverse Check (Phase 4)
  evaluateSafetyBrake: safetyBrake.evaluateSafetyBrake,
  overrideSafetyBrake: safetyBrake.overrideSafetyBrake,
  isSafetyBrakeActive: safetyBrake.isSafetyBrakeActive,
  getLastBrakeInfo: safetyBrake.getLastBrakeInfo,
  resetSafetyBrake: safetyBrake.resetSafetyBrake,
  runReverseCheck: safetyBrake.runReverseCheck,

  // Cooldown Manager (Phase 2)
  isSymbolInCooldown: cooldownManager.isSymbolInCooldown,
  setSymbolCooldown: cooldownManager.setSymbolCooldown,
  getCooldownRemainingHours: cooldownManager.getCooldownRemainingHours,
  clearAllCooldowns: cooldownManager.clearAllCooldowns,

  // Safety Guards & Scanners
  circuitBreaker,
  directionalCircuitBreaker,
  economicCalendar,
  microstructureScanner,
  rollingPerformanceGuard,
};
