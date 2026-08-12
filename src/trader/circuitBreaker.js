'use strict';

const { log } = require('../pp369/_logger');

let _globalIpBannedUntil = 0;

function isIpBanned() {
  return Date.now() < _globalIpBannedUntil;
}

function getIpBannedUntil() {
  return _globalIpBannedUntil;
}

function triggerCircuitBreaker(errOrUntilMs, source = 'Binance') {
  let untilMs = 0;
  if (typeof errOrUntilMs === 'number') {
    untilMs = errOrUntilMs;
  } else if (errOrUntilMs) {
    const err = errOrUntilMs;
    const data = err.response?.data;
    if (data && typeof data.msg === 'string') {
      const match = data.msg.match(/banned until (\d+)/);
      if (match) {
        untilMs = parseInt(match[1], 10);
      }
    }
    // Nếu bị trả 418 hoặc -1003 mà không có timestamp trong msg, fallback tạm ngắt 15 phút
    if (!untilMs && (err.response?.status === 418 || data?.code === -1003)) {
      untilMs = Date.now() + 15 * 60 * 1000;
    }
  }

  if (untilMs > 0 && untilMs > _globalIpBannedUntil) {
    _globalIpBannedUntil = untilMs;
    const remainMin = ((_globalIpBannedUntil - Date.now()) / 60000).toFixed(1);
    const timeStr = new Date(_globalIpBannedUntil + 7 * 3600000).toISOString().slice(11, 19);
    log.warn(`[${source}] Kích hoạt Circuit Breaker: IP bị phạt đến ${timeStr} (còn ${remainMin} phút). Tạm dừng toàn bộ REST API.`);
  }
}

function checkCircuitBreaker() {
  if (Date.now() < _globalIpBannedUntil) {
    const remainMin = ((_globalIpBannedUntil - Date.now()) / 60000).toFixed(1);
    const timeStr = new Date(_globalIpBannedUntil + 7 * 3600000).toISOString().slice(11, 19);
    throw new Error(`[IP_BAN_CIRCUIT_BREAKER] IP đang bị Binance khóa cho đến ${timeStr} (còn ${remainMin} phút). Đã ngắt REST API.`);
  }
}

module.exports = {
  isIpBanned,
  getIpBannedUntil,
  triggerCircuitBreaker,
  checkCircuitBreaker,
};
