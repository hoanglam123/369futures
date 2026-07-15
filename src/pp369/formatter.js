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
    lines.push(`  SL: <code>${fmt369Price(stopLoss)}</code>`);
    
    lines.push('  -----------------------------------------');

    if (sig.scoreReasons && sig.scoreReasons.length) {
      sig.scoreReasons.forEach(reason => {
        lines.push(`   <i>${escapeHTML(reason)}</i>`);
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

module.exports = { fmt369Price, format369Alert, getGridBotConfig };
