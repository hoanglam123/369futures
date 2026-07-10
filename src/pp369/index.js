'use strict';

/**
 * PP369 Strategy — Public API
 *
 * Dùng trong project hiện tại (news-noti):
 *   const pp369 = require('./pp369');
 *   const { log } = require('./services/logger');
 *   pp369.setLogger(log);  // dùng logger của project (ghi file)
 *
 * Dùng standalone / project khác:
 *   const pp369 = require('./pp369');
 *   // Không cần setLogger — mặc định dùng console
 *   // Không cần setDataDir — mặc định là <cwd>/data/
 *
 * Dependencies cần có: axios, ws
 */

const { setLogger }  = require('./_logger');
const core           = require('./core');
const stream         = require('./stream');
const signalLog      = require('./signalLog');
const formatter      = require('./formatter');
const telegram       = require('./telegram');

module.exports = {
  // ── Cấu hình (optional) ──────────────────────────────────────────────────
  setLogger,                             // override logger (mặc định: console)
  setDataDir: signalLog.setDataDir,      // override thư mục lưu signal log

  // ── Core strategy ────────────────────────────────────────────────────────
  get369Signal:          core.get369Signal,
  get369SignalsForCoins: core.get369SignalsForCoins,
  score369Method:        core.score369Method,
  format369ForPrompt:    core.format369ForPrompt,
  getLevelCache:         core.getLevelCache,
  initH4Cache:           core.initH4Cache,
  YEAR_START_MS:         core.YEAR_START_MS,
  PROXIMITY_PCT:         core.PROXIMITY_PCT,
  getDecimals:           core.getDecimals,
  getStep:               core.getStep,
  getGridStepPct:        core.getGridStepPct,
  isGridWidthValid:      core.isGridWidthValid,
  GRID_MIN_PCT:          core.GRID_MIN_PCT,
  GRID_MAX_PCT:          core.GRID_MAX_PCT,

  // ── WebSocket stream ─────────────────────────────────────────────────────
  start369Stream:   stream.start369Stream,
  stop369Stream:    stream.stop369Stream,
  getMarkPrice:     stream.getMarkPrice,
  getNearbySymbols: stream.getNearbySymbols,
  updatePricesRest: stream.updatePricesRest,
  syncWebSocketSubscriptions: stream.syncWebSocketSubscriptions,

  // ── Signal log ───────────────────────────────────────────────────────────
  logSignal369:      signalLog.logSignal369,
  loadSignalHistory: signalLog.loadSignalHistory,

  // ── Telegram formatter ───────────────────────────────────────────────────
  fmt369Price:      formatter.fmt369Price,
  format369Alert:   formatter.format369Alert,
  getGridBotConfig: formatter.getGridBotConfig,

  // ── Telegram notifier ────────────────────────────────────────────────────
  sendTelegram:   telegram.sendTelegram,
  notifyBotStart: telegram.notifyBotStart,
  notifySignals:  telegram.notifySignals,
};
