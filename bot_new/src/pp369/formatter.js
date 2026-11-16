'use strict';

/**
 * Formatter Telegram HTML cho tín hiệu PP369.
 * Không phụ thuộc framework — copy sang bất kỳ project nào.
 */

function fmt369Price(v) {
  if (v == null) return 'N/A';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1)    return String(parseFloat(v.toFixed(4)));
  return String(parseFloat(v.toFixed(6)));
}

/**
 * Tạo HTML message Telegram khi PP369 phát hiện tín hiệu mới.
 * signals[].score   (optional) — từ confluence scorer
 * signals[].aiComment (optional) — nhận xét Gemini
 */
function format369Alert(signals) {
  const lines = ['📐 <b>PP369 — Tín hiệu mới xuất hiện</b>', ''];

  for (const sig of signals) {
    const emoji     = sig.signal === 'LONG' ? '🟢' : '🔴';
    const strength  = sig.strength === 'strong' ? '⭐⭐ Mạnh'
                    : sig.strength === 'medium' ? '⭐ Trung bình'
                    : '⚠️ Yếu';
    const direction = sig.signal === 'LONG' ? 'xuống' : 'lên';
    const lan       = sig.touchCount + 1;

    lines.push(`${emoji} <b>${sig.symbol}</b> → <b>${sig.signal}</b> lần ${lan}  ${strength}`);
    lines.push(`  Vào tại:         <code>${fmt369Price(sig.targetLevel)}</code>`);
    lines.push(`  Giá đi từ mốc:  <code>${fmt369Price(sig.condLevel)}</code>  ${direction}`);
    lines.push(`  Open. tháng H1:  <code>${fmt369Price(sig.openPrice)}</code>`);
    lines.push(`  Close. tháng H1: <code>${fmt369Price(sig.closePrice)}</code>`);
    lines.push(`  Tháng: ${sig.month}`);

    if (sig.score) {
      const sc = sig.score;
      const verdictEmoji = sc.total >= 9 ? '🔥' : sc.total >= 7 ? '✅' : sc.total >= 5 ? '⚠️' : '❌';
      lines.push(`  Confluence: ${verdictEmoji} <b>${sc.total}đ</b> [${sc.verdict}]`);
      const parts = [
        `TA=${sc.breakdown.ta}`,
        `Whale=${sc.breakdown.whale}`,
        `Deriv=${sc.breakdown.derivatives}`,
        sc.breakdown.pp369 ? `PP369=${sc.breakdown.pp369}` : null,
      ].filter(Boolean).join(' | ');
      lines.push(`  <i>${parts}</i>`);
    }

    if (sig.aiComment) {
      lines.push('');
      lines.push(`💬 <i>${sig.aiComment}</i>`);
    }

    lines.push('');
  }

  lines.push('<i>⚠️ Tín hiệu kỹ thuật 369</i>');
  return lines.join('\n');
}

module.exports = { fmt369Price, format369Alert };
