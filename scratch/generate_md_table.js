const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\lamdh\\.gemini\\antigravity-ide\\brain\\21f56fb5-bede-4357-b32f-5bbfadc48f59\\.system_generated\\tasks\\task-29.log';
const content = fs.readFileSync(logPath, 'utf8');

// Parse JSON from output
const jsonStart = content.indexOf('{');
const jsonEnd = content.lastIndexOf('}');
const jsonStr = content.slice(jsonStart, jsonEnd + 1);

const data = JSON.parse(jsonStr);

for (const [day, list] of Object.entries(data)) {
  console.log(`\n### 📅 Bảng thống kê lệnh đóng ngày ${day}`);
  console.log(`| # | Giờ đóng | Cặp coin | Vị thế | Số lượng | Giá đóng | Lãi/Lỗ (PnL) | Trạng thái |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  list.forEach((p, idx) => {
    const timeStr = new Date(p.startTime).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    const pnlStr = (p.totalPnl >= 0 ? '+' : '') + p.totalPnl.toFixed(4) + ' USDT';
    const tag = p.totalPnl >= 0 ? '🟢 THẮNG' : '🔴 THUA';
    console.log(`| ${idx + 1} | ${timeStr} | **${p.symbol}** | ${p.side} | ${p.qty} | $${p.closePrice} | ${pnlStr} | ${tag} |`);
  });
}
