const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log } = require('../pp369/_logger');

const STATE_FILE = path.join(process.cwd(), 'data', 'circuit_breaker.json');

let _globalIpBannedUntil = 0;
let _globalThrottleUntil = 0;
let _wasBannedNotified = false;
let _lastUsedWeight = 0;

// Nạp lại trạng thái ban từ đĩa khi khởi động bot
try {
  if (fs.existsSync(STATE_FILE)) {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && typeof data.bannedUntil === 'number' && Date.now() < data.bannedUntil) {
      _globalIpBannedUntil = data.bannedUntil;
      _wasBannedNotified = true;
      const remainMin = ((_globalIpBannedUntil - Date.now()) / 60000).toFixed(1);
      const timeStr = new Date(_globalIpBannedUntil + 7 * 3600000).toISOString().slice(11, 19);
      log.warn(`[CircuitBreaker] Nạp lại trạng thái: IP đang bị Binance phạt đến ${timeStr} (còn ${remainMin} phút). Tạm dừng toàn bộ REST API.`);
    }
  }
} catch (_) { }

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ bannedUntil: _globalIpBannedUntil }), 'utf8');
  } catch (_) { }
}

let _onUnbanCallback = null;

function setOnUnbanCallback(cb) {
  if (typeof cb === 'function') {
    _onUnbanCallback = cb;
  }
}

function updateUsedWeight(headers) {
  if (!headers) return;
  const weightStr = headers['x-mbx-used-weight-1m'] || headers['x-mbx-used-weight'];
  if (weightStr) {
    const used = parseInt(weightStr, 10);
    if (!isNaN(used) && used > 0) {
      _lastUsedWeight = used;
      // Binance Futures giới hạn 2400 weight/phút.
      // Nếu used >= 1800 (~75%), chủ động hạ nhiệt REST API 6-8s để window 1 phút tự reset
      if (used >= 1800) {
        const throttleMs = Date.now() + 8000;
        if (throttleMs > _globalThrottleUntil) {
          _globalThrottleUntil = throttleMs;
          log.warn(`[RateLimit] ⚠️ Binance IP Weight đạt ${used}/2400 (nguy cơ 429). Tự động hạ nhiệt REST API 8s để bảo vệ bot.`);
        }
      }
    }
  }
}

// Cài đặt Interceptor toàn cục cho axios để tự động giám sát mọi response từ Binance
axios.interceptors.response.use(
  (response) => {
    if (response.config?.url?.includes('binance.com') || response.headers?.['x-mbx-used-weight-1m']) {
      updateUsedWeight(response.headers);
    }
    return response;
  },
  (error) => {
    if (error.response?.headers && (error.config?.url?.includes('binance.com') || error.response.headers['x-mbx-used-weight-1m'])) {
      updateUsedWeight(error.response.headers);
    }
    const status = error.response?.status;
    const data = error.response?.data;

    // Bắt HTTP 418 hoặc mã lỗi -1003 (IP Banned)
    if (status === 418 || data?.code === -1003) {
      triggerCircuitBreaker(error, 'Binance 418');
    }
    // Bắt HTTP 429 (Rate Limit Warning) -> PHẢI NGẮT TOÀN BỘ REST NGAY LẬP TỨC
    // Nếu tiếp tục gọi trong lúc bị 429, Binance sẽ lập tức nâng lên 418 IP BAN 15 phút!
    else if (status === 429) {
      triggerCircuitBreaker(error, 'Binance 429');
    }

    return Promise.reject(error);
  }
);

function isIpBanned() {
  const now = Date.now();
  const banned = now < _globalIpBannedUntil;
  if (!banned && _wasBannedNotified) {
    _wasBannedNotified = false;
    _globalIpBannedUntil = 0;
    saveState();
    log.system(`[CircuitBreaker] 🟢 Hết thời gian phạt IP của Binance! Tự động khôi phục giao dịch REST API bình thường.`);
    if (_onUnbanCallback) {
      try { _onUnbanCallback(); } catch (_) { }
    }
  }
  if (banned) return true;

  // Nếu đang trong trạng thái hạ nhiệt (Rate Limit Throttle)
  if (now < _globalThrottleUntil) {
    return true;
  }

  return false;
}

function getIpBannedUntil() {
  return Math.max(_globalIpBannedUntil, _globalThrottleUntil);
}

function triggerCircuitBreaker(errOrUntilMs, source = 'Binance') {
  let untilMs = 0;
  let isRateLimit429 = false;

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
    // Nếu bị trả 429: lấy retry-after từ header
    if (err.response?.status === 429) {
      isRateLimit429 = true;
      const retryAfterSec = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
      untilMs = Date.now() + Math.max(retryAfterSec, 45) * 1000;
    }
    // Nếu bị trả 418 hoặc -1003 mà không có timestamp trong msg, fallback tạm ngắt 15 phút
    if (!untilMs && (err.response?.status === 418 || data?.code === -1003)) {
      untilMs = Date.now() + 15 * 60 * 1000;
    }
  }

  if (isRateLimit429) {
    if (untilMs > 0 && untilMs > _globalThrottleUntil) {
      _globalThrottleUntil = untilMs;
      const remainSec = Math.max(1, Math.round((_globalThrottleUntil - Date.now()) / 1000));
      const timeStr = new Date(_globalThrottleUntil + 7 * 3600000).toISOString().slice(11, 19);
      log.warn(`[${source}] ⚠️ Kích hoạt Circuit Breaker (Rate Limit 429): Tạm dừng toàn bộ REST API đến ${timeStr} (còn ${remainSec}s) để ngăn chặn Binance phạt IP 418!`);
    }
  } else {
    if (untilMs > 0 && untilMs > _globalIpBannedUntil) {
      _globalIpBannedUntil = untilMs;
      _wasBannedNotified = true;
      saveState();
      const remainMin = ((_globalIpBannedUntil - Date.now()) / 60000).toFixed(1);
      const timeStr = new Date(_globalIpBannedUntil + 7 * 3600000).toISOString().slice(11, 19);
      log.warn(`[${source}] Kích hoạt Circuit Breaker: IP bị phạt đến ${timeStr} (còn ${remainMin} phút). Tạm dừng toàn bộ REST API.`);
    }
  }
}

function checkCircuitBreaker() {
  const now = Date.now();
  if (now < _globalIpBannedUntil) {
    const remainMin = ((_globalIpBannedUntil - now) / 60000).toFixed(1);
    const timeStr = new Date(_globalIpBannedUntil + 7 * 3600000).toISOString().slice(11, 19);
    throw new Error(`[IP_BAN_CIRCUIT_BREAKER] IP đang bị Binance khóa cho đến ${timeStr} (còn ${remainMin} phút). Đã ngắt REST API.`);
  }
  if (now < _globalThrottleUntil) {
    const remainSec = Math.max(1, Math.round((_globalThrottleUntil - now) / 1000));
    throw new Error(`[RATE_LIMIT_THROTTLE] IP đang hạ nhiệt để bảo vệ an toàn (còn ${remainSec}s). Tạm dừng REST API.`);
  }
}

module.exports = {
  isIpBanned,
  getIpBannedUntil,
  triggerCircuitBreaker,
  checkCircuitBreaker,
  setOnUnbanCallback,
  updateUsedWeight,
};


