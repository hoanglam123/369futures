'use strict';

/**
 * Script dọn dẹp các bản ghi lỗi và dữ liệu test giả lập:
 * 1. Lọc bỏ các coin test unit test: TEST*, TWIN_*
 * 2. Lọc bỏ các lệnh bóng tối bị cắn BE ảo trong 0-1 phút do lỗi quét râu nến trước khi cập nhật code
 * 3. Chuẩn hóa và làm sạch file:
 *    - data/shadow_trades_history.jsonl
 *    - data/ai_trade_dataset.jsonl
 *    - data/shadow_positions.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SHADOW_HISTORY_FILE = path.join(DATA_DIR, 'shadow_trades_history.jsonl');
const DATASET_FILE = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');
const SHADOW_POS_FILE = path.join(DATA_DIR, 'shadow_positions.json');

function isBogusTrade(rec) {
  if (!rec) return true;
  const sym = String(rec.symbol || '').toUpperCase();
  if (/^(TEST|TWIN_)/i.test(sym)) return true;

  const dur = typeof rec.holdingDurationMinutes === 'number' ? rec.holdingDurationMinutes : 999;
  const outcome = String(rec.outcome || rec.exitType || '').toUpperCase();
  const isBE = outcome === 'SAVED_BE' || outcome === 'BE' || rec.isSavedBE === true;

  // Lỗi nến lookback: Lệnh thoát BE ngay trong <= 1 phút với entryPrice ~ exitPrice
  if (isBE && dur <= 1.0) {
    const entry = parseFloat(rec.entryPrice || 0);
    const exit = parseFloat(rec.exitPrice || 0);
    if (!entry || !exit || Math.abs(entry - exit) / (entry || 1) < 0.005) {
      return true;
    }
  }

  return false;
}

function cleanFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[Clean] File không tồn tại: ${filePath}`);
    return 0;
  }

  const backupPath = `${filePath}.bak`;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return 0;

  fs.writeFileSync(backupPath, content);
  console.log(`[Backup] Đã tạo bản sao lưu an toàn tại: ${backupPath}`);

  const lines = content.split('\n').filter(Boolean);
  const kept = [];
  let removedCount = 0;
  const removedDetails = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (isBogusTrade(rec)) {
        removedCount++;
        removedDetails.push({
          sym: rec.symbol,
          type: rec.outcome || rec.exitType || rec.type,
          dur: rec.holdingDurationMinutes,
          pnl: rec.pnlUsd
        });
      } else {
        kept.push(line);
      }
    } catch (_) {
      kept.push(line);
    }
  }

  fs.writeFileSync(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
  console.log(`[Clean] ${path.basename(filePath)}: Tổng ${lines.length} dòng -> Giữ lại ${kept.length} dòng (Đã dọn dẹp ${removedCount} bản ghi lỗi/test)`);

  if (removedDetails.length > 0) {
    console.log(`[Clean] Danh sách mẫu bản ghi đã dọn (${Math.min(removedDetails.length, 10)}/${removedDetails.length}):`, removedDetails.slice(-10));
  }

  return removedCount;
}

function cleanActiveShadowPositions() {
  if (!fs.existsSync(SHADOW_POS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SHADOW_POS_FILE, 'utf8'));
    let modified = false;
    for (const [id, p] of Object.entries(raw)) {
      if (/^(TEST|TWIN_)/i.test(p.symbol)) {
        delete raw[id];
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(SHADOW_POS_FILE, JSON.stringify(raw, null, 2));
      console.log(`[Clean] Đã dọn dẹp vị thế test trong ${path.basename(SHADOW_POS_FILE)}`);
    }
  } catch (_) {}
}

async function main() {
  console.log('=== BẮT ĐẦU DỌN DẸP DỮ LIỆU LỖI VÀ TEST GIẢ LẬP ===\n');

  cleanFile(SHADOW_HISTORY_FILE);
  console.log('-----------------------------------');
  cleanFile(DATASET_FILE);
  console.log('-----------------------------------');
  cleanActiveShadowPositions();

  console.log('\n=== TỔNG KẾT BÁO CÁO 24H SAU KHI DỌN DẸP ===');
  const { getDailyTradeStats, formatDailyReportHtml } = require('../src/pp369/dailyReporter');
  const stats = getDailyTradeStats();
  console.log(`• Lệnh hợp lệ hoàn tất: ${stats.totalClosed} (TP: ${stats.tpCount}, BE: ${stats.beCount}, SL: ${stats.slCount})`);
  console.log(`• Tỷ lệ thắng (Win Rate): ${stats.winRate}% | Tỷ lệ bảo toàn vốn (Win+BE): ${stats.winBeRate}%`);
  console.log(`• Tổng PnL 24h chuẩn: ${stats.totalPnlUsd >= 0 ? '+' : ''}$${stats.totalPnlUsd} USD`);
  console.log('\n✅ Hoàn tất dọn dẹp thành công 100%!');
}

main().catch(err => {
  console.error('[Clean] Lỗi:', err);
  process.exit(1);
});
