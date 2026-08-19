const fs = require('fs');
const path = require('path');

const ssPath = path.join(__dirname, '..', 'data', 'step_sizes.json');
const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
const h4 = ss.h4Cache['SKYAI'];

function buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange = 25) {
  const grid = [];
  for (let i = -levelsRange; i <= levelsRange; i++) {
    const offset = i * step;
    grid.push({
      value: parseFloat((upperPrice + offset).toFixed(decimals)),
      type: 'tren',
      tier: i,
    });
    grid.push({
      value: parseFloat((lowerPrice + offset).toFixed(decimals)),
      type: 'duoi',
      tier: i,
    });
  }
  grid.sort((a, b) => a.value - b.value || (a.type === 'tren' ? -1 : 1));
  return grid.filter((v, i, arr) =>
    i === 0 || !(v.value === arr[i - 1].value && v.type === arr[i - 1].type)
  );
}

const grid = buildLevelGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 25);
const currentPrice = 0.05750;

console.log('=== THÔNG SỐ GỐC H4 CỦA SKYAI ===');
console.log(`Open H4:  ${h4.openPrice}`);
console.log(`Close H4: ${h4.closePrice}`);
console.log(`Upper (max Open/Close): ${h4.upperPrice}`);
console.log(`Lower (min Open/Close): ${h4.lowerPrice}`);
console.log(`Step (bước giá): ${h4.step} (bước nhảy = 0.003)`);
console.log(`Decimals: ${h4.decimals}`);
console.log(`Giá hiện tại: ${currentPrice}\n`);

console.log('=== CÁC MỐC QUANH GIÁ HIỆN TẠI (0.050 - 0.065) ===');
const nearby = grid.filter(l => l.value >= 0.048 && l.value <= 0.065);
nearby.forEach(l => {
  console.log(`Tier ${l.tier >= 0 ? '+' : ''}${l.tier}: Mốc [${l.type === 'tren' ? 'TRÊN (LONG entry)' : 'DƯỚI (SHORT entry)'}] = ${l.value.toFixed(5)}`);
});

// Tìm cặp kẹp giá
const longEntry = grid.filter(l => l.type === 'tren' && l.value <= currentPrice).pop();
const shortEntry = grid.find(l => l.type === 'duoi' && l.value > (longEntry ? longEntry.value : currentPrice));

console.log('\n=== ZONE / CẶP MỐC KẸP GIÁ HIỆN TẠI CỦA SKYAI ===');
console.log(`- Mốc HỖ TRỢ DƯỚI (LONG entry - dãy 'tren'):  ${longEntry.value.toFixed(5)} (Tier ${longEntry.tier >= 0 ? '+' : ''}${longEntry.tier})`);
console.log(`- Mốc KHÁNG CỰ TRÊN (SHORT entry - dãy 'duoi'): ${shortEntry.value.toFixed(5)} (Tier ${shortEntry.tier >= 0 ? '+' : ''}${shortEntry.tier})`);
const diff = shortEntry.value - longEntry.value;
const pct = (diff / longEntry.value) * 100;
console.log(`- Độ rộng Range/Zone kẹp giá: ${longEntry.value.toFixed(5)} -> ${shortEntry.value.toFixed(5)} (Chênh lệch: ${diff.toFixed(5)} hay ~${pct.toFixed(2)}%)`);
