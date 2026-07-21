'use strict';

/**
 * Formatter Telegram HTML cho tín hiệu PP369.
 * Không phụ thuộc framework — copy sang bất kỳ project nào.
 */

function fmt369Price(v) {
  if (v == null) return 'N/A';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return String(parseFloat(v.toFixed(4)));
  return String(parseFloat(v.toFixed(6)));
}

/**
 * Tạo thiết lập Binance Futures Grid Bot từ tín hiệu PP369.
 *
 * @param {Object} sig - Tín hiệu PP369
 * @returns {Object|null} Cấu hình khuyến nghị hoặc null nếu không có tín hiệu
 */
function getGridBotConfig(sig) {
  if (!sig || (sig.signal !== 'LONG' && sig.signal !== 'SHORT')) return null;

  const step = sig.step || 0;
  const pairLow = sig.debugInfo?.pairLow ?? Math.min(sig.targetLevel, sig.condLevel) ?? sig.nearestBelow;
  const pairHigh = sig.debugInfo?.pairHigh ?? Math.max(sig.targetLevel, sig.condLevel) ?? sig.nearestAbove;
  const stopLoss = sig.signal === 'LONG' ? (pairLow - step) : (pairHigh + step);

  return {
    direction: sig.signal, // LONG hoặc SHORT
    lowerPrice: pairLow,
    upperPrice: pairHigh,
    grids: 30, // Khuyên dùng 20-50
    leverage: '3x', // Giới hạn an toàn 2x-5x cho tài khoản phổ thông
    stopLoss: stopLoss,
  };
}

/**
 * Tạo HTML message Telegram khi PP369 phát hiện tín hiệu mới.
 * signals[].score   (optional) — từ confluence scorer
 * signals[].aiComment (optional) — nhận xét Gemini
 */
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function format369Alert(signals) {
  const lines = [];

  for (const sig of signals) {
    const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
    const scoreStr = (sig.score !== undefined && sig.score !== null) ? ` ${sig.score}đ` : '';

    lines.push(`${emoji} <b>${sig.symbol}</b> → <b>${sig.signal}${scoreStr}</b>`);

    let sigLeverage = sig.leverage;
    if (sigLeverage == null && sig.condLevel && sig.targetLevel) {
      const gridWidth = Math.abs(sig.condLevel - sig.targetLevel);
      const pct = (gridWidth / Math.min(sig.targetLevel, sig.condLevel)) * 100;
      const calculatedLeverage = Math.floor(50 / pct);
      let maxAllowed = 10;
      try {
        const envLeverage = parseInt(process.env.LEVERAGE || '10', 10);
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(process.cwd(), 'data', 'step_sizes.json');
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const leverageInfo = raw.leverageInfo || {};
          maxAllowed = leverageInfo[sig.symbol] ?? envLeverage;
        } else {
          maxAllowed = envLeverage;
        }
      } catch (_) {}
      sigLeverage = Math.max(1, Math.min(calculatedLeverage, maxAllowed));
    }
    const leverageStr = sigLeverage != null ? ` - ${sigLeverage}x` : '';
    lines.push(`  Entry:   <code>${fmt369Price(sig.targetLevel)}</code>${leverageStr}`);

    const step = sig.step || 0;
    const pairLow = sig.debugInfo?.pairLow ?? Math.min(sig.targetLevel, sig.condLevel) ?? sig.nearestBelow;
    const pairHigh = sig.debugInfo?.pairHigh ?? Math.max(sig.targetLevel, sig.condLevel) ?? sig.nearestAbove;
    const stopLoss = sig.signal === 'LONG' ? (pairLow - step) : (pairHigh + step);
    // lines.push(`  SL: <code>${fmt369Price(stopLoss)}</code>`); // Đã ẩn theo yêu cầu
    
    lines.push('  -----------------------------------------');

    if (sig.scoreReasons && sig.scoreReasons.length) {
      sig.scoreReasons.forEach(reason => {
        const formatted = formatReasonTelegram(reason);
        if (formatted) lines.push(formatted);
      });
    } else {
      lines.push('   <i>Không có chi tiết lý do.</i>');
    }

    lines.push('');
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Định dạng rút gọn và tối ưu nội dung lý do gửi lên Telegram.
 */
function formatReasonTelegram(rawReason) {
  if (!rawReason) return null;
  if (rawReason.includes('Cá voi L/S') && rawReason.includes('Đã gộp')) return null;

  const match = rawReason.match(/^\[(.*?)\]\s*(.*)$/);
  if (!match) return `  • <i>${escapeHTML(rawReason)}</i>`;

  const header = match[1];
  let body = match[2];

  // Rút ngắn nội dung theo từng tiêu chí
  if (header === 'Xu hướng H4/H1') {
    body = body
      .replace(/ngược xu hướng/g, 'ngược')
      .replace(/thuận xu hướng/g, 'thuận')
      .replace(/trend yếu/g, 'yếu')
      .replace(/trend mạnh/g, 'mạnh')
      .replace(/Giá\s*\$?[0-9.,]+\s*[<>]\s*EMA200\s*\$?[0-9.,]+/g, '')
      .replace(/:\s*\|\s*/g, ' | ')
      .replace(/:\s*\(/g, ' (')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Biến động H1/M15') {
    body = body
      .replace(/nén vừa:\s*\$?[0-9.,]+\s*<=\s*\$?[0-9.,]+/g, 'nén vừa')
      .replace(/siêu nén:\s*\$?[0-9.,]+\s*<=\s*\$?[0-9.,]+/g, 'siêu nén')
      .replace(/quá biên độ:\s*\$?[0-9.,]+\s*>\s*\$?[0-9.,]+/g, 'quá biên độ')
      .replace(/bình thường:\s*\$?[0-9.,]+\s*<=\s*\$?[0-9.,]+/g, 'bình thường')
      .replace(/:\s*\|\s*/g, ' | ')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'RSI H1') {
    body = body
      .replace(/RSI H1\s*([0-9.]+)\s*(<=|>=|<|>)\s*[0-9.]+/g, 'RSI $1')
      .replace(/cực đại/g, 'cực')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Tương quan dòng tiền L/S') {
    body = body
      .replace(/Đồng thuận tuyệt đối/g, 'Đồng thuận 100%')
      .replace(/Đồng thuận một phần/g, 'Đồng thuận 1 phần')
      .replace(/Cá voi đạt\s*\([0-9.%]+\)/g, 'Whales đạt')
      .replace(/Cá voi không đạt\s*\([0-9.%]+\)/g, 'Whales ko đạt')
      .replace(/Retail đạt\s*\([0-9.%]+\)/g, 'Retail đạt')
      .replace(/Retail không đạt\s*\([0-9.%]+\)/g, 'Retail ko đạt')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Vốn hóa') {
    body = body
      .replace(/Ngoài Top 150\s*\(Rank\s*>\s*150\):\s*/g, '')
      .replace(/Top 30 Blue Chip\s*\(Rank\s*[0-9]+\):\s*/g, '')
      .replace(/Top 31-150 Mid Cap\s*\(Rank\s*[0-9]+\):\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Price Action S/R') {
    body = body
      .replace(/chỉ có/g, '')
      .replace(/cản cũ/g, 'cản')
      .replace(/không cản/g, 'ko cản')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'OI H1') {
    body = body
      .replace(/Hạ nhiệt vị thế:\s*/g, 'Hạ nhiệt: ')
      .replace(/Dòng tiền ổn định:\s*/g, 'Ổn định: ')
      .replace(/Đòn bẩy tăng mạnh\s*\(Nóng\):\s*/g, 'Tăng mạnh: ')
      .replace(/Lượng OI/g, 'OI')
      .replace(/thay đổi/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Động lượng Volume') {
    body = body
      .replace(/Volume cạn kiệt:\s*[0-9.]+\s*<=\s*[0-9.]+/g, 'Volume cạn kiệt')
      .replace(/Volume ổn định:\s*[0-9.]+\s*<=\s*[0-9.]+/g, 'Volume ổn định')
      .replace(/Volume đột biến\s*\(Xả\/Fomo\):\s*[0-9.]+\s*>\s*[0-9.]+/g, 'Volume đột biến')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Funding Rate') {
    body = body
      .replace(/Phí tài trợ bình thường/g, 'Bình thường')
      .replace(/Long đu bám\s*\(Nóng\):/g, 'Phe Long đông:')
      .replace(/Short đu bám\s*\(Nóng\):/g, 'Phe Short đông:')
      .replace(/Bình thường:\s*Funding Rate\s*/g, 'Bình thường: ')
      .replace(/Short Crowded\s*\(Squeeze\):\s*Funding Rate\s*/g, 'Short Squeeze: ')
      .replace(/Long Crowded\s*\(Squeeze\):\s*Funding Rate\s*/g, 'Long Squeeze: ')
      .replace(/Funding Rate/g, 'Funding')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (header === 'Sóng BTC') {
    body = body
      .replace(/BTC đi ngang\s*\(ADX H1 = [0-9.]+\s*<\s*25\):\s*/g, '')
      .replace(/BTC thuận trend mạnh\s*\(ADX H1 = [0-9.]+\s*>=\s*25\):\s*/g, '')
      .replace(/BTC ngược trend mạnh\s*\(ADX H1 = [0-9.]+\s*>=\s*25\):\s*/g, '')
      .replace(/BTC thuận Dow\/EMA LONG\s*\([^)]+\):\s*/g, '')
      .replace(/BTC thuận Dow\/EMA SHORT\s*\([^)]+\):\s*/g, '')
      .replace(/BTC ngược xu hướng Dow\/EMA\s*\([^)]+\):\s*/g, '')
      .replace(/BTC đi ngang\/trung tính\s*\([^)]+\):\s*/g, '')
      .replace(/BTC bão giá:\s*/g, '')
      .replace(/Giao dịch tự do/g, 'BTC đi ngang')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const shortHeaders = {
    'Xu hướng H4/H1': 'Xu hướng',
    'Biến động H1/M15': 'Biến động',
    'RSI H1': 'RSI H1',
    'Tương quan dòng tiền L/S': 'Dòng tiền L/S',
    'Vốn hóa': 'Vốn hóa',
    'Price Action S/R': 'Cản Swing',
    'OI H1': 'OI H1',
    'Động lượng Volume': 'Volume H1',
    'Funding Rate': 'Funding',
    'Sóng BTC': 'Sóng BTC',
  };

  const displayHeader = shortHeaders[header] || header;
  return `  • <b>${displayHeader}</b>: <i>${escapeHTML(body)}</i>`;
}

module.exports = { fmt369Price, format369Alert, getGridBotConfig };
