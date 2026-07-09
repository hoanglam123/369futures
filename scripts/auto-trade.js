'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { startAutoTrade } = require('../src/trader/autoTrade');
const { initH1Cache } = require('../src/pp369');
const { notifyBotStart } = require('../src/pp369/telegram');

async function main() {
  let coins = [];
  const filePath = path.join(__dirname, '../data/step_sizes.json');

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const stepSizes = data.stepSizes || {};
      
      // Lấy toàn bộ danh sách mã có trong stepSizes
      const allSymbols = Object.keys(stepSizes)
        .filter(sym => sym.endsWith('USDT') && !sym.includes('_'))
        .map(sym => sym.replace('USDT', ''));
      
      // Gọi initH1Cache để kiểm tra và chỉ lấy nến H1 cho các mã chưa có cache
      await initH1Cache(allSymbols);
      
      // Đọc lại tệp sau khi đã lấy nến H1 xong
      const updatedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const updatedH1Cache = updatedData.h1Cache || {};
      
      // Các chức năng tiếp theo CHỈ sử dụng mã đã cache H1 thành công (không bị failed)
      coins = Object.keys(updatedH1Cache).filter(sym => !updatedH1Cache[sym].failed);
      
    } catch (err) {
      console.warn('[AutoTrade] Lỗi đọc/ghi danh sách coin từ step_sizes.json:', err.message);
    }
  }

  if (!coins.length) {
    coins = (process.env.COINS || 'BTC,ETH,SOL,BNB,XRP,UNI,DOGE,ADA')
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);
  }

  // Gửi thông báo Telegram khi bot khởi động
  await notifyBotStart(coins.length);

  // Khởi chạy bot tự động giao dịch
  await startAutoTrade(coins);
}

main().catch(err => {
  console.error('[AutoTrade] Fatal:', err.message);
  process.exit(1);
});
