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
  const entry = _cooldownMap[cleanSym];
  if (!entry) return false;

  const expiry = typeof entry === 'object' ? entry.expiry : entry;
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
  const entry = _cooldownMap[cleanSym];
  if (!entry) return 0;

  const expiry = typeof entry === 'object' ? entry.expiry : entry;
  const now = Date.now();
  if (now >= expiry) return 0;

  return parseFloat(((expiry - now) / (3600 * 1000)).toFixed(1));
}

/**
 * Thêm một coin vào danh sách Cooldown sau khi bị dính SL / thoát lệnh.
 * Thời gian cooldown được tính toán động (AI dynamic) dựa trên nguyên nhân và loại thoát lệnh:
 * - 'BTC_DUMP' / 'MARKET_CRASH' / 'FLASH': 2.5h (sốc nến toàn thị trường, coin riêng lẻ chưa hẳn vỡ cản)
 * - 'HARD_MAX_LOSS' / 'BREAK_SUPPORT' / 'TREND_BROKEN': 16.0h (vỡ cản mạnh/trend xả dài hạn, tránh bắt dao rơi liên tục)
 * - 'PANIC' / 'EMERGENCY': 8.0h (thoát khẩn cấp)
 * - 'SL_NORMAL' / default: 5.0h (đủ 1-2 chu kỳ M15/H1 tái tích luỹ thay vì 12h cứng)
 * 
 * @param {string} sym 
 * @param {number|null} hours Nếu truyền số cụ thể sẽ dùng số đó, nếu null/undefined sẽ tự tính theo reason
 * @param {string} reason Nguyên nhân dính SL / exit
 */
function addSymbolToCooldown(sym, hours = null, reason = 'SL_NORMAL') {
  const cleanSym = sym.replace('USDT', '');
  
  let effHours = hours;
  if (!effHours || typeof effHours !== 'number' || isNaN(effHours) || effHours <= 0) {
    const r = (reason || '').toUpperCase();
    if (r.includes('BTC') || r.includes('MARKET') || r.includes('FLASH')) {
      effHours = 2.5;
    } else if (r.includes('HARD') || r.includes('MAX_LOSS') || r.includes('BREAK') || r.includes('TREND_BROKEN')) {
      effHours = 16.0;
    } else if (r.includes('PANIC') || r.includes('EMERGENCY')) {
      effHours = 8.0;
    } else {
      effHours = 5.0; // SL bình thường do biến động ngắn hạn
    }
  }

  const expiry = Date.now() + effHours * 3600 * 1000;
  _cooldownMap[cleanSym] = {
    expiry,
    hours: effHours,
    reason: reason || 'SL_NORMAL',
    updatedAt: Date.now()
  };
  saveCooldowns();

  const expiryTimeStr = new Date(expiry).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  log.system(`[CooldownManager] ⏸️ Kích hoạt Dynamic Cooldown ${effHours}h cho ${cleanSym} (Lý do: ${reason}) đến ${expiryTimeStr}.`);
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
