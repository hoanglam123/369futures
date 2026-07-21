'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { startAutoTrade } = require('../src/trader/autoTrade');
const { loadLeverageBrackets } = require('../src/trader/binance');
const { initH4Cache, isGridWidthValid, GRID_MIN_PCT, GRID_MAX_PCT, YEAR_START_MS, updatePricesRest, getMarkPrice } = require('../src/pp369');
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
      
      // Gọi initH4Cache để kiểm tra và chỉ lấy nến H4 đầu năm 2026 cho mã chưa có cache
      await initH4Cache(allSymbols);

      // Lấy giá thị trường hiện tại (1 request duy nhất) để lọc coin theo % grid hiện tại
      try {
        await updatePricesRest();
      } catch (err) {
        console.warn('[AutoTrade] Không thể lấy giá hiện tại, fallback về giá openPrice đầu năm:', err.message);
      }

      // Đọc lại tệp sau khi đã lấy nến H4 xong
      const updatedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const updatedH4Cache = updatedData.h4Cache || {};

      // Chỉ dùng mã đã cache H4 thành công (yearStart đúng, không bị failed)
      // và có độ rộng grid nằm trong khoảng cho phép theo GIÁ HIỆN TẠI
      const allValid = Object.entries(updatedH4Cache)
        .filter(([sym, e]) => {
          if (e.yearStart !== YEAR_START_MS || e.failed) return false;
          const currentPrice = getMarkPrice(sym);
          return isGridWidthValid(e, currentPrice, sym);
        })
        .map(([sym]) => sym);

      const filtered = Object.entries(updatedH4Cache)
        .filter(([sym, e]) => {
          if (e.yearStart !== YEAR_START_MS || e.failed) return false;
          const currentPrice = getMarkPrice(sym);
          return !isGridWidthValid(e, currentPrice, sym);
        });

      if (filtered.length > 0) {
        console.info(`[AutoTrade] Bỏ qua ${filtered.length} coin có grid ngoài khoảng ${GRID_MIN_PCT}–${GRID_MAX_PCT}% (theo giá hiện tại):`,
          filtered.map(([sym, e]) => {
            const cp = getMarkPrice(sym);
            const price = cp || e.openPrice;
            return `${sym}(${((e.step / price) * 100).toFixed(1)}%)`;
          }).join(', '));
      }
      coins = allValid;
      
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

  // Lấy max leverage cho từng coin từ Binance Futures và lưu vào cache
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;
  if (apiKey && secret) {
    await loadLeverageBrackets(coins, apiKey, secret);
  } else {
    console.warn('[AutoTrade] Thiếu BINANCE_API_KEY / BINANCE_SECRET — bỏ qua lấy leverage brackets.');
  }

  // Khởi chạy bot tự động giao dịch
  await startAutoTrade(coins);
}

main().catch(err => {
  console.error('[AutoTrade] Fatal:', err.message);
  process.exit(1);
});
