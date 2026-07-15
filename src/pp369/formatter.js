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
function format369Alert(signals) {
  const lines = ['📐 <b>PP369 — Tín hiệu mới xuất hiện</b>', ''];

  for (const sig of signals) {
    const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
    const strength = sig.strength === 'strong' ? '⭐⭐ Mạnh'
      : sig.strength === 'medium' ? '⭐ Trung bình'
        : '⚠️ Yếu';
    // const direction = sig.signal === 'LONG' ? 'xuống' : 'lên';
    const lan = sig.touchCount + 1;

    lines.push(`${emoji} <b>${sig.symbol}</b> → <b>${sig.signal}</b>`);
    lines.push(`  Vào tại:         <code>${fmt369Price(sig.targetLevel)}</code>`);

    const step = sig.step || 0;
    const pairLow = sig.debugInfo?.pairLow ?? Math.min(sig.targetLevel, sig.condLevel) ?? sig.nearestBelow;
    const pairHigh = sig.debugInfo?.pairHigh ?? Math.max(sig.targetLevel, sig.condLevel) ?? sig.nearestAbove;
    const stopLoss = sig.signal === 'LONG' ? (pairLow - step) : (pairHigh + step);
    lines.push(`  Stop Loss:       <code>${fmt369Price(stopLoss)}</code>`);

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
    if (sigLeverage != null) {
      lines.push(`  Đòn bẩy:         <code>${sigLeverage}x</code>`);
    }
    // lines.push(`  Giá đi từ mốc:  <code>${fmt369Price(sig.condLevel)}</code>  ${direction}`);
    // lines.push(`  Open. tháng H4:  <code>${fmt369Price(sig.openPrice)}</code>`);
    // lines.push(`  Close. tháng H4: <code>${fmt369Price(sig.closePrice)}</code>`);

    if (sig.score !== undefined && sig.score !== null) {
      lines.push(`  Confluence:      <b>+${sig.score}đ</b>`);
      if (sig.scoreReasons && sig.scoreReasons.length) {
        sig.scoreReasons.forEach(reason => {
          lines.push(`    <i>${reason}</i>`);
        });
      }
    }

    // if (sig.aiComment) {
    //   lines.push('');
    //   lines.push(`💬 <i>${sig.aiComment}</i>`);
    // }

    const gridConfig = getGridBotConfig(sig);
    if (gridConfig) {
      lines.push('');
      // lines.push('🤖 <b>Binance Futures Grid Bot Config:</b>');
      // lines.push(`  • Direction: <b>${gridConfig.direction}</b>`);
      lines.push(`  • Price Range: <code>${fmt369Price(gridConfig.lowerPrice)}</code> - <code>${fmt369Price(gridConfig.upperPrice)}</code>`);
      // lines.push(`  • Grids: <code>${gridConfig.grids}</code> (Khuyên dùng: 20-50)`);
      // lines.push(`  • Leverage: <code>${gridConfig.leverage}</code> (An toàn: 2x-5x)`);
      // lines.push(`  • Stop Loss: <code>${fmt369Price(gridConfig.stopLoss)}</code> (ngoài khoảng giá mốc xa nhất)`);
    }

    // lines.push('');
  }

  // lines.push('<i>⚠️ Tín hiệu kỹ thuật 369</i>');
  return lines.join('\n');
}

module.exports = { fmt369Price, format369Alert, getGridBotConfig };
