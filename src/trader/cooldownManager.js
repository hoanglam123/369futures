'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../pp369/_logger');

const COOLDOWN_FILE = path.join(process.cwd(), 'data', 'sl_cooldown.json');

// Memory cache: sym -> expiryTimestampMs
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
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(_cooldownMap, null, 2), 'utf8');
  } catch (err) {
    log.warn(`[CooldownManager] Lỗi ghi sl_cooldown.json: ${err.message}`);
  }
}

// Initial load
loadCooldowns();

/**
 * Kiểm tra xem symbol có đang trong thời gian Cooldown không.
 * @param {string} sym Tên coin (ví dụ 'BTC', 'PIEVERSE')
 * @returns {boolean} true nếu đang cooldown, false nếu được phép giao dịch
 */
function isSymbolInCooldown(sym) {
  const cleanSym = sym.replace('USDT', '');
  const expiry = _cooldownMap[cleanSym];
  if (!expiry) return false;

  const now = Date.now();
  if (now < expiry) {
    return true;
  }

  // Đã hết hạn -> xóa khỏi cache
  delete _cooldownMap[cleanSym];
  saveCooldowns();
  return false;
}

/**
 * Lấy số giờ còn lại trong thời gian Cooldown.
 * @param {string} sym 
 * @returns {number} Số giờ còn lại (ví dụ 5.4)
 */
function getRemainingCooldownHours(sym) {
  const cleanSym = sym.replace('USDT', '');
  const expiry = _cooldownMap[cleanSym];
  if (!expiry) return 0;

  const now = Date.now();
  if (now >= expiry) return 0;

  return parseFloat(((expiry - now) / (3600 * 1000)).toFixed(1));
}

/**
 * Thêm một coin vào danh sách Cooldown sau khi bị dính SL.
 * @param {string} sym 
 * @param {number} hours Số giờ cooldown (mặc định 12h)
 */
function addSymbolToCooldown(sym, hours = 12) {
  const cleanSym = sym.replace('USDT', '');
  const expiry = Date.now() + hours * 3600 * 1000;
  _cooldownMap[cleanSym] = expiry;
  saveCooldowns();

  const expiryTimeStr = new Date(expiry).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  log.system(`[CooldownManager] ⏸️ Kích hoạt Cooldown ${hours}h cho ${cleanSym} đến ${expiryTimeStr}.`);
}

/**
 * Xóa Cooldown thủ công cho một coin (nếu cần).
 */
function clearCooldown(sym) {
  const cleanSym = sym.replace('USDT', '');
  delete _cooldownMap[cleanSym];
  saveCooldowns();
}

module.exports = {
  isSymbolInCooldown,
  getRemainingCooldownHours,
  addSymbolToCooldown,
  clearCooldown,
  loadCooldowns,
};
