'use strict';

/**
 * Script test PP369 strategy — in ra lưới mốc, điều kiện LONG/SHORT,
 * số lần roundtrip, và điểm confluence cho từng coin.
 *
 * Dùng: node scripts/test-369.js [COIN1 COIN2 ...]
 * Mặc định: BTC ETH SOL BNB XRP UNI DOGE ADA
 */

require('dotenv').config();

const { get369Signal, score369Method, fmt369Price } = require('../src/pp369');

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'UNI', 'DOGE', 'ADA'];
const symbols = process.argv.slice(2).map(s => s.toUpperCase());
const coins   = symbols.length ? symbols : DEFAULT_COINS;

function fmt(v) {
  return fmt369Price(v);
}

function bar(label, value, max = 80) {
  const pad = Math.max(0, max - label.length - String(value).length - 3);
  return `${label}: ${value}${' '.repeat(pad)}`;
}

async function printSignal(sig) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${sig.symbol}USDT  |  Tháng: ${sig.month}`);
  console.log(line);

  if (!sig.openPrice) {
    console.log(`  ⚠  Lỗi: ${sig.reason}`);
    return;
  }

  // ── Nến H1 đầu tháng ──
  console.log(`\n  Nến H1 đầu tháng:`);
  console.log(`    Open  = $${fmt(sig.openPrice)}`);
  console.log(`    Close = $${fmt(sig.closePrice)}`);
  console.log(`    Bước  = $${fmt(sig.step)}`);

  // ── Giá hiện tại ──
  console.log(`\n  Giá hiện tại: $${fmt(sig.currentPrice)}`);
  console.log(`    Mốc gần nhất phía trên: $${fmt(sig.nearestAbove)}`);
  console.log(`    Mốc gần nhất phía dưới: $${fmt(sig.nearestBelow)}`);

  // ── Lưới mốc quanh giá ──
  if (sig.nearLevels && sig.nearLevels.length) {
    console.log(`\n  Lưới mốc gần giá hiện tại:`);
    const sorted = [...sig.nearLevels].sort((a, b) => b.value - a.value);
    for (const l of sorted) {
      const marker = Math.abs(l.value - sig.currentPrice) < sig.step * 0.15 ? ' ◄ GIÁ' : '';
      const isEntry = l.value === sig.targetLevel ? ` ★ ${sig.signal} entry` : '';
      const isLong  = l.value === (sig.debugInfo?.pairLow)  ? ' [LONG mốc]'  : '';
      const isShort = l.value === (sig.debugInfo?.pairHigh) ? ' [SHORT mốc]' : '';
      const typeTag = l.type === 'tren' ? '↑Open' : '↓Close';
      console.log(`    $${fmt(l.value).padStart(12)}  ${typeTag}  tier${l.tier >= 0 ? '+' : ''}${l.tier}${isEntry}${isLong}${isShort}${marker}`);
    }
  }

  // ── Roundtrip giữa cặp mốc đang theo dõi ──
  if (sig.debugInfo) {
    const d = sig.debugInfo;
    console.log(`\n  Roundtrip tháng này (giữa $${fmt(d.pairLow)} ↔ $${fmt(d.pairHigh)}):`);
    console.log(`    Đã LONG (xuống Close): ${d.lowerCount} lần`);
    console.log(`    Đã SHORT (lên Open):   ${d.upperCount} lần`);
    console.log(`    Bên chạm cuối:         ${d.lastSide ?? 'chưa rõ'}`);
    console.log(`    Tổng nến 1m đã phân tích: ${d.totalCandles}`);
  }

  // ── Tín hiệu ──
  console.log(`\n  Tín hiệu: ${sig.signal}`);
  if (sig.signal !== 'NONE') {
    const strengthLabel = { strong: '⭐⭐ Mạnh', medium: '⭐ Trung bình', weak: '⚠ Yếu' }[sig.strength] || sig.strength;
    const lan = sig.touchCount + 1;
    console.log(`    Loại:        ${sig.signal} lần ${lan}  (${strengthLabel})`);
    console.log(`    Entry tại:   $${fmt(sig.targetLevel)}`);
    console.log(`    Điều kiện:   Đã chạm $${fmt(sig.condLevel)} trước đó`);

    // Điểm confluence
    const longScore  = await score369Method(sig, 'LONG');
    const shortScore = await score369Method(sig, 'SHORT');
    const sc = longScore.score || shortScore.score;
    const rr = longScore.reasons.concat(shortScore.reasons);
    console.log(`    Confluence:  +${sc}đ`);
    if (rr.length) rr.forEach(r => console.log(`      ${r}`));
  } else {
    console.log(`    ${sig.reason}`);
  }
}

async function main() {
  console.log(`\nPP369 — Test ${coins.length} coin: ${coins.join(', ')}`);
  console.log(`Đang fetch dữ liệu từ Binance Futures...\n`);

  const CONCURRENCY = 3;
  for (let i = 0; i < coins.length; i += CONCURRENCY) {
    const batch = coins.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(sym => get369Signal(sym))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        await printSignal(r.value);
      } else {
        console.error(`\n[${batch[j]}] Lỗi:`, r.reason?.message ?? r.reason);
      }
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Xong!');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
