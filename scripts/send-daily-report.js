'use strict';

/**
 * Script gửi Báo Cáo Tổng Kết Giao Dịch 24H về Telegram ngay lập tức
 * Dùng để test hoặc gọi thủ công bất kỳ lúc nào.
 * 
 * Cách dùng:
 *   node scripts/send-daily-report.js
 */

require('dotenv').config();
const { sendDailyReportTelegram, getDailyTradeStats, formatDailyReportHtml } = require('../src/pp369/dailyReporter');

async function main() {
  console.log('[DailyReporter] Đang tính toán dữ liệu 24h qua...');
  const stats = getDailyTradeStats(24 * 60 * 60 * 1000);
  console.log(`[DailyReporter] Tìm thấy: ${stats.totalClosed} lệnh hoàn tất (${stats.tpCount} TP, ${stats.beCount} BE, ${stats.slCount} SL, ${stats.cancelCount} Hủy)`);
  console.log(`[DailyReporter] Tổng PnL: $${stats.totalPnlUsd} | ROI: ${stats.totalRoiPct}% | Đang mở: ${stats.activePositions.length} vị thế`);

  console.log('\n--- NỘI DUNG BÁO CÁO TELEGRAM ---');
  const html = formatDailyReportHtml(stats);
  console.log(html.replace(/<[^>]*>/g, '')); // In bản text ra console
  console.log('---------------------------------\n');

  console.log('[DailyReporter] Đang gửi thông báo về Telegram...');
  await sendDailyReportTelegram();
  console.log('[DailyReporter] ✓ Đã gửi thành công!');
  process.exit(0);
}

main().catch(err => {
  console.error('[DailyReporter] Lỗi:', err.message);
  process.exit(1);
});
