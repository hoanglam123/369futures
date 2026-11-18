'use strict';

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const {
  fetchH1Historical,
  fetchH4Historical,
  fetchD1Historical,
  YEAR_START_MS,
} = require('../src/pp369/core');

let getKlinesNew = null;
try {
  getKlinesNew = require('../bot_new/src/collectors/technicalAnalysis').getKlines;
} catch (_) {}

async function main() {
  console.log('================================================================');
  console.log('🚀 CÔNG CỤ NẠP NẾN LỊCH SỬ TRƯỚC (PRELOAD KLINES) CHO BOT-H4');
  console.log('================================================================\n');

  // 1. Xác định danh sách coin cần nạp
  let symbols = [];
  const args = process.argv.slice(2);
  const customListArg = args.find(a => !a.startsWith('--'));
  const topArg = args.find(a => a.startsWith('--top='));

  const stepSizesPath = path.join(process.cwd(), 'data', 'step_sizes.json');
  if (customListArg) {
    symbols = customListArg.split(',').map(s => s.trim().toUpperCase().replace(/USDT$/, '')).filter(Boolean);
  } else if (fs.existsSync(stepSizesPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(stepSizesPath, 'utf8'));
      const h4Cache = data.h4Cache || {};
      symbols = Object.entries(h4Cache)
        .filter(([sym, e]) => e.yearStart === YEAR_START_MS && !e.failed)
        .map(([sym]) => sym);
    } catch (e) {
      console.warn('Lỗi đọc step_sizes.json:', e.message);
    }
  }

  if (topArg) {
    const limit = parseInt(topArg.split('=')[1], 10);
    if (!isNaN(limit) && limit > 0) {
      symbols = symbols.slice(0, limit);
    }
  }

  if (symbols.length === 0) {
    symbols = (process.env.COINS || 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,LINK,AVAX,NEAR')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
  }

  // Luôn đảm bảo BTC có mặt đầu tiên vì BTC dùng cho BTC Flash Guard & Confluence Scorer
  if (!symbols.includes('BTC')) symbols.unshift('BTC');
  else {
    symbols = ['BTC', ...symbols.filter(s => s !== 'BTC')];
  }

  console.log(`📋 Chuẩn bị nạp nến H1, H4, D1 cho ${symbols.length} coin...`);
  console.log(`⏱️ Thời gian giãn cách: 80ms/request (giữ IP Weight an toàn < 500/2400).\n`);

  let successCount = 0;
  let skippedCount = 0;
  let failCount = 0;

  const startTime = Date.now();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const prefix = `[${i + 1}/${symbols.length}] ${sym.padEnd(8)}`;

    try {
      const t0 = Date.now();
      const promises = [
        fetchH1Historical(sym),
        fetchH4Historical(sym),
        fetchD1Historical(sym),
      ];
      if (typeof getKlinesNew === 'function') {
        promises.push(getKlinesNew(sym, '1w', 52).catch(() => []));
      }
      const [h1, h4, d1, w1 = []] = await Promise.all(promises);
      const elapsed = Date.now() - t0;

      const isSkipped = elapsed < 15; // Nếu < 15ms chứng tỏ lấy 100% từ disk cache
      if (isSkipped) {
        skippedCount++;
        process.stdout.write(`${prefix} ⚡ Đã có sẵn trên đĩa (H1:${h1.length}, H4:${h4.length}, D1:${d1.length}, W1:${w1.length}) [${elapsed}ms]\n`);
      } else {
        successCount++;
        process.stdout.write(`${prefix} ✓ Nạp thành công (H1:${h1.length}, H4:${h4.length}, D1:${d1.length}, W1:${w1.length}) [${elapsed}ms]\n`);
        // Giãn cách nhẹ để giữ IP Weight cực thấp
        await new Promise(r => setTimeout(r, 80));
      }
    } catch (err) {
      failCount++;
      process.stdout.write(`${prefix} ❌ Lỗi: ${err.message}\n`);
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Chờ 1.5s để debounce flush file ra đĩa
  console.log('\n💾 Đang đồng bộ hóa toàn bộ dữ liệu vào đĩa cứng...');
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n================================================================');
  console.log(`🏁 HOÀN TẤT NẠP NẾN TRONG ${totalDuration}s!`);
  console.log(`  • Tổng số coin xử lý: ${symbols.length}`);
  console.log(`  • Đã có sẵn từ trước:  ${skippedCount} coin (0 calls)`);
  console.log(`  • Vừa nạp mới/bù nến:  ${successCount} coin`);
  console.log(`  • Thất bại:            ${failCount} coin`);
  console.log('================================================================');

  const files = [
    'data/h1_history_cache.json',
    'data/h4_history_cache.json',
    'data/d1_history_cache.json',
    'data/w1_history_cache.json',
  ];

  console.log('\n📂 Kích thước file cache trên máy:');
  for (const f of files) {
    if (fs.existsSync(f)) {
      const stat = fs.statSync(f);
      const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
      console.log(`  - ${f}: ${sizeMb} MB`);
    }
  }

  console.log('\n💡 HƯỚNG DẪN ĐẨY LÊN VPS:');
  console.log('  Cách 1 (Qua Git):');
  console.log('    git add data/*_history_cache.json');
  console.log('    git commit -m "chore: update preloaded klines cache"');
  console.log('    git push origin main');
  console.log('    (Sau đó trên VPS chỉ cần gõ: git pull)');
  console.log('\n  Cách 2 (Copy trực tiếp qua SCP):');
  console.log('    scp data/*_history_cache.json root@103.176.179.170:/path/to/369futures/data/\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
