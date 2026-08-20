'use strict';

const fs = require('fs');
const path = require('path');

function calcHalfQuantity(sym, totalQty) {
  let stepSize = 0.001;
  try {
    const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      stepSize = data.stepSizes?.[`${sym}USDT`] || data.steps?.[`${sym}USDT`] || 0.001;
    }
  } catch (_) {}
  const half = totalQty / 2;
  const qty = Math.floor(half / stepSize) * stepSize;
  const dec = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat(qty.toFixed(dec));
}

// Test với danh sách các coin thực tế và các khối lượng khác nhau
const testCases = [
  { sym: 'BLESS', totalQty: 2900 },
  { sym: 'BTC', totalQty: 0.046 },
  { sym: 'LAYER', totalQty: 476.9 },
  { sym: 'DOGE', totalQty: 1540 },
  { sym: 'SOL', totalQty: 1.48 },
  { sym: 'CRV', totalQty: 125.8 },
  { sym: '1000PEPE', totalQty: 450000 }
];

console.log('=== TEST TÍNH TOÁN KHỐI LƯỢNG CHỐT 50% (calcHalfQuantity) ===\n');
const results = testCases.map(tc => {
  const half = calcHalfQuantity(tc.sym, tc.totalQty);
  return {
    'Symbol': tc.sym,
    'Tổng Qty gốc': tc.totalQty,
    '50% Qty chốt': half,
    'Qty còn lại': parseFloat((tc.totalQty - half).toFixed(6)),
    'Kiểm tra hợp lệ': (half > 0 && half <= tc.totalQty / 2) ? '✅ Chuẩn xác' : '❌ Lỗi'
  };
});
console.table(results);
