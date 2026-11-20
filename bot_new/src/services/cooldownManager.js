'use strict';

/**
 * Cooldown Manager — Phase 4 Hồi chiêu từng coin sau khi dính SL
 *
 * Chống tâm lý vào lệnh trả thù (Revenge trading) sau khi vừa bị quét SL.
 * - Mặc định khóa 6.0 giờ cho coin dính SL.
 * - Tự động điều chỉnh thời gian theo lý do:
 *   + BTC Flash Dump/Market Crash: 2.5h
 *   + Thoát bảo vệ hòa vốn / cắt non: 1.5h
 *   + Phá vỡ xu hướng mạnh (Trend broken): 16.0h
 */

const fs   = require('fs');
const path = require('path');
const { log } = require('./logger');

const COOLDOWN_FILE = path.join(__dirname, '..', '..', 'data', 'sl_cooldown.json');

let _cooldownMap = {};

function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const raw = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      _cooldownMap = JSON.parse(raw);
    }
  } catch (err) {
    log.warn(`[CooldownManager] Lỗi nạp sl_cooldown.json: ${err.message}`);
    _cooldownMap = {};
  }
}

function saveCooldowns() {
  try {
    const dir = path.dirname(COOLDOWN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(_cooldownMap, null, 2), 'utf8');
  } catch (err) {
    log.warn(`[CooldownManager] Lỗi ghi sl_cooldown.json: ${err.message}`);
  }
}

loadCooldowns();

function isSymbolInCooldown(sym) {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();
  const entry = _cooldownMap[cleanSym];
  if (!entry) return false;

  const expiry = typeof entry === 'object' ? entry.expiry : entry;
  const now = Date.now();
  if (now < expiry) {
    return true;
  }

  delete _cooldownMap[cleanSym];
  saveCooldowns();
  return false;
}

function getRemainingCooldownHours(sym) {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();
  const entry = _cooldownMap[cleanSym];
  if (!entry) return 0;

  const expiry = typeof entry === 'object' ? entry.expiry : entry;
  const now = Date.now();
  if (now >= expiry) return 0;

  return parseFloat(((expiry - now) / (3600 * 1000)).toFixed(1));
}

function addSymbolToCooldown(sym, hours = null, reason = 'SL_NORMAL') {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();

  let effHours = hours;
  if (!effHours || typeof effHours !== 'number' || isNaN(effHours) || effHours <= 0) {
    const r = (reason || '').toUpperCase();
    if (r.includes('BTC') || r.includes('MARKET') || r.includes('FLASH')) {
      effHours = 2.5;
    } else if (r.includes('DEFENSIVE') || r.includes('EARLY_CUT') || r.includes('BE')) {
      effHours = 1.5;
    } else if (r.includes('HARD') || r.includes('MAX_LOSS') || r.includes('BREAK') || r.includes('TREND_BROKEN')) {
      effHours = 16.0;
    } else if (r.includes('PANIC') || r.includes('EMERGENCY')) {
      effHours = 8.0;
    } else {
      effHours = 6.0; // Chuẩn roadmap bot-new: 6 giờ
    }
  }

  const now = Date.now();
  const expiry = now + effHours * 3600 * 1000;

  _cooldownMap[cleanSym] = {
    expiry,
    setAt: now,
    hours: effHours,
    reason
  };

  saveCooldowns();
  log.warn(`[CooldownManager] ⏳ Đã đưa ${cleanSym} vào Cooldown trong ${effHours}h (Lý do: ${reason})`);
}

function clearSymbolCooldown(sym) {
  const cleanSym = (sym || '').replace('USDT', '').toUpperCase();
  if (_cooldownMap[cleanSym]) {
    delete _cooldownMap[cleanSym];
    saveCooldowns();
    log.system(`[CooldownManager] 🔓 Đã giải phóng cooldown cho ${cleanSym}`);
  }
}

function getAllCooldowns() {
  const now = Date.now();
  const active = {};
  for (const [sym, entry] of Object.entries(_cooldownMap)) {
    const expiry = typeof entry === 'object' ? entry.expiry : entry;
    if (expiry > now) {
      active[sym] = {
        remainingHours: parseFloat(((expiry - now) / (3600 * 1000)).toFixed(1)),
        reason: typeof entry === 'object' ? entry.reason : 'SL'
      };
    }
  }
  return active;
}

module.exports = {
  isSymbolInCooldown,
  getRemainingCooldownHours,
  addSymbolToCooldown,
  clearSymbolCooldown,
  getAllCooldowns
};
