'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const filePath = path.join(process.cwd(), 'data', 'gemini-code-1784771566170.json');
const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const TIMEZONE_OFFSET = '+07:00'; // Giờ Việt Nam

async function main() {
  console.log(`Bắt đầu backtest chính xác theo timestamps cho ${items.length} khuyến nghị...`);

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const sym = item.symbol;
    const type = item.type;
    const entryPrice = parseFloat(item.entry.replace('$', '').replace(/,/g, ''));
    const scoreVal = parseFloat(item.score.replace('+', '').replace('đ', ''));

    // Chuyển chuỗi "YYYY-MM-DD HH:mm:ss" sang timestamp UTC ms
    let itemTime;
    if (item.time) {
      const isoStr = item.time.replace(' ', 'T') + TIMEZONE_OFFSET;
      itemTime = new Date(isoStr).getTime();
    } else {
      itemTime = Date.now() - 24 * 3600 * 1000;
    }

    // Phân bổ ký quỹ theo điểm Scorer PP369
    let marginVal = 20;
    if (scoreVal >= 9.0) marginVal = 50;
    else if (scoreVal >= 8.0) marginVal = 40;
    else if (scoreVal >= 7.0) marginVal = 30;
    else marginVal = 20;

    item.margin = `${marginVal}$`;

    const leverage = 10; // Đòn bẩy chuẩn 10x

    try {
      // Tải tối đa 500 nến 5m kể từ thời điểm phát khuyến nghị
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=5m&startTime=${itemTime}&limit=500`;
      const res = await axios.get(url, { timeout: 10000 });
      const klines = (res.data || []).map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4])
      }));

      if (klines.length > 0) {
        let maxRoi = -999;
        let minRoi = 999;
        let finalRoi = null;
        let trailed = false;

        for (const k of klines) {
          let candleMaxRoi, candleMinRoi;
          if (type === 'LONG') {
            candleMaxRoi = ((k.high - entryPrice) / entryPrice) * leverage * 100;
            candleMinRoi = ((k.low - entryPrice) / entryPrice) * leverage * 100;
          } else { // SHORT
            candleMaxRoi = ((entryPrice - k.low) / entryPrice) * leverage * 100;
            candleMinRoi = ((entryPrice - k.high) / entryPrice) * leverage * 100;
          }

          if (candleMaxRoi > maxRoi) maxRoi = candleMaxRoi;
          if (candleMinRoi < minRoi) minRoi = candleMinRoi;

          // Trailing SL kích hoạt khi ROI đạt +5%
          if (maxRoi >= 5.0) trailed = true;

          // Chốt lời TP (+10% ROI)
          if (candleMaxRoi >= 10.0) {
            finalRoi = 10.0;
            break;
          }

          // Cắt lỗ SL (-10% ROI) hoặc kéo về hòa vốn (+1.0% ROI)
          if (candleMinRoi <= -10.0) {
            finalRoi = trailed ? 1.0 : -10.0;
            break;
          }
        }

        if (finalRoi === null) {
          const lastClose = klines[klines.length - 1].close;
          if (type === 'LONG') {
            finalRoi = ((lastClose - entryPrice) / entryPrice) * leverage * 100;
          } else {
            finalRoi = ((entryPrice - lastClose) / entryPrice) * leverage * 100;
          }
        }

        const formattedVal = Number(finalRoi.toFixed(1));
        item.roi = (formattedVal > 0 ? '+' : '') + formattedVal + '%';
      } else {
        item.roi = '0%';
      }
    } catch (e) {
      console.warn(`[${sym}] Lỗi nạp dữ liệu: ${e.message}`);
      item.roi = '0%';
    }

    await new Promise(r => setTimeout(r, 60));
  }

  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8');
  console.log(`\n✓ Đã backtest và cập nhật thành công ${items.length} khuyến nghị vào ${filePath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
