const fs = require('fs');
const path = require('path');

const ssPath = path.join(__dirname, '..', 'data', 'step_sizes.json');
const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
const h4Cache = ss.h4Cache || {};

const results = [];
for (const [sym, h4] of Object.entries(h4Cache)) {
  if (h4 && !h4.failed && h4.openPrice && h4.closePrice) {
    const open = h4.openPrice;
    const close = h4.closePrice;
    const step = h4.step;
    const x = (Math.abs(open - close) / open) * 100;
    const y = ((step - Math.abs(open - close)) / open) * 100;
    const isBlacklist = (x * 2 > y);
    const isValidY = y >= 2 && y <= 25;
    if (isValidY && !isBlacklist) {
      results.push({ sym, x: parseFloat(x.toFixed(3)), y: parseFloat(y.toFixed(3)), stepPct: parseFloat(((step/open)*100).toFixed(3)) });
    }
  }
}

results.sort((a, b) => a.x - b.x);
console.log('Tổng số coin hợp lệ trong DB:', results.length);
console.log('Min x%:', results[0]);
console.log('Max x%:', results[results.length - 1]);

const p25 = results[Math.floor(results.length * 0.25)];
const p50 = results[Math.floor(results.length * 0.50)];
const p75 = results[Math.floor(results.length * 0.75)];
console.log('25% coin có x% <=', p25.x + '%');
console.log('Trung vị (50% coin có x% <=)', p50.x + '%');
console.log('75% coin có x% <=', p75.x + '%');

console.log('\nTop 5 coin có x% nhỏ nhất:');
console.log(results.slice(0, 5));
console.log('\nTop 5 coin có x% ở mức trung bình:');
console.log(results.slice(Math.floor(results.length/2) - 2, Math.floor(results.length/2) + 3));
console.log('\nTop 5 coin có x% lớn nhất (vẫn hợp lệ):');
console.log(results.slice(-5));
