'use strict';

/**
 * Theo dõi lệnh funding được AI khuyến nghị.
 * Mỗi khuyến nghị = 1 kỳ 8h. Khi đến giờ thanh toán → ghi kết quả + gửi alert.
 * Sau khi hoàn tất → dừng theo dõi, chờ khuyến nghị kỳ tiếp.
 *
 * Parse format từ AI:
 *   COIN | FUNDING | SHORT_FUTURES | Rate: +X.XXXX%/8h
 *   COIN | FUNDING | LONG_FUTURES  | Rate: -X.XXXX%/8h
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { sendMessages } = require('./telegram');
const { log } = require('./logger');

const DATA_DIR     = path.join(__dirname, '..', '..', 'data');
const TRADES_FILE  = path.join(DATA_DIR, 'funding_trades.json');
const STATS_FILE   = path.join(DATA_DIR, 'funding_stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'funding_history.json');

const TIMEZONE      = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const HEADERS       = { 'User-Agent': 'crypto-news-bot/1.0' };
// Phí round-trip ước tính: Spot buy/sell + Futures open/close ≈ 0.10% tổng
const FEE_ROUNDTRIP = 0.001;

const DEFAULT_STATS = {
  total: 0, wins: 0, losses: 0,
  totalNetPct: 0,
  bestTrade: null, worstTrade: null,
  updatedAt: null,
};

// ─── Persistence ───────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadActiveTrades() {
  try {
    ensureDir();
    if (!fs.existsSync(TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'))
      .filter(t => t.status === 'active');
  } catch { return []; }
}

function saveTrades(trades) {
  try {
    ensureDir();
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) { log.warn('Không thể lưu funding_trades', { error: e.message }); }
}

function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return { ...DEFAULT_STATS };
    return { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) };
  } catch { return { ...DEFAULT_STATS }; }
}

function saveStats(stats) {
  try {
    ensureDir();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (e) { log.warn('Không thể lưu funding_stats', { error: e.message }); }
}

function appendHistory(entry) {
  try {
    ensureDir();
    const history = fs.existsSync(HISTORY_FILE)
      ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
      : [];
    history.push(entry);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) { log.warn('Không thể lưu funding_history', { error: e.message }); }
}

// ─── Next funding payment time ─────────────────────────────────────────────────

function getNextFundingTimeMs() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const nextH = [0, 8, 16].find(h => utcH < h);
  const nextUTC = nextH !== undefined
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextH))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0));
  return nextUTC.getTime();
}

// ─── Fetch actual rate at payment time ────────────────────────────────────────

async function fetchActualRate(symbol) {
  try {
    const { data } = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
      params: { instId: `${symbol}-USDT-SWAP` },
      headers: HEADERS,
      timeout: 8000,
    });
    const item = data?.data?.[0];
    return item ? parseFloat(item.fundingRate) : null;
  } catch { return null; }
}

// ─── Parse AI output ───────────────────────────────────────────────────────────

function parseFundingTrades(aiText) {
  const plain = aiText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const regex = /(\w+)\s*\|\s*FUNDING\s*\|\s*(SHORT_FUTURES|LONG_FUTURES)\s*\|\s*Rate:\s*([+\-]?[\d.]+)%\/8h/gi;
  const trades = [];
  let match;
  while ((match = regex.exec(plain)) !== null) {
    const rate = parseFloat(match[3]) / 100;
    if (isNaN(rate) || rate === 0) continue;
    trades.push({
      id:              `${match[1].toUpperCase()}_FUNDING_${Date.now()}`,
      symbol:          match[1].toUpperCase(),
      type:            match[2].toUpperCase(),
      recommendedRate: rate,
      nextFundingTime: getNextFundingTimeMs(),
      recommendedAt:   new Date().toISOString(),
      status:          'active',
    });
  }
  log.ai(`parseFundingTrades: ${trades.length} lệnh`, trades.map(t => ({
    symbol: t.symbol, type: t.type, rate: `${(t.recommendedRate * 100).toFixed(4)}%`,
  })));
  return trades;
}

// ─── Format helpers ────────────────────────────────────────────────────────────

function fmtRate(r) {
  return `${r >= 0 ? '+' : ''}${(r * 100).toFixed(4)}%`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  });
}

function typeLabel(type) {
  return type === 'SHORT_FUTURES' ? 'Short Futures + Long Spot' : 'Long Futures + Short Spot';
}

// ─── Add / update trades ───────────────────────────────────────────────────────

function addFundingTrades(newTrades) {
  if (!newTrades.length) return;
  const active = loadActiveTrades();
  let changed = false;

  for (const t of newTrades) {
    const existing = active.find(a => a.symbol === t.symbol);
    if (existing) {
      existing.recommendedRate = t.recommendedRate;
      existing.nextFundingTime = t.nextFundingTime;
      existing.recommendedAt   = t.recommendedAt;
      log.funding(`UPDATE funding ${t.symbol}: rate ${fmtRate(t.recommendedRate)}`);
      changed = true;
      continue;
    }

    active.push(t);
    changed = true;
    log.funding(`ADD funding ${t.symbol} ${t.type}: rate ${fmtRate(t.recommendedRate)}`);

    const nextStr  = fmtTime(new Date(t.nextFundingTime).toISOString());
    const netEst   = t.recommendedRate - FEE_ROUNDTRIP;
    const netSign  = netEst >= 0 ? '+' : '';
    sendMessages([
      `💸 <b>THEO DÕI FUNDING MỚI — ${t.symbol}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📌 Chiều: <b>${typeLabel(t.type)}</b>\n` +
      `💰 Rate khuyến nghị: <code>${fmtRate(t.recommendedRate)}/8h</code>\n` +
      `🎯 Ước tính sau phí: <b>${netSign}${(netEst * 100).toFixed(4)}%</b>\n` +
      `⏰ Kỳ thanh toán: <b>${nextStr}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `<i>🤖 Bot ghi nhận kết quả khi đến kỳ — sau đó dừng theo dõi</i>`,
    ]).catch(() => {});
  }

  if (changed) saveTrades(active);
}

// ─── Check & record payment ────────────────────────────────────────────────────

async function checkFundingPayments() {
  const active = loadActiveTrades();
  if (!active.length) return;

  const now = Date.now();
  const due = active.filter(t => now >= t.nextFundingTime);
  if (!due.length) return;

  log.funding(`${due.length} lệnh funding đến kỳ thanh toán`);
  const stats = loadStats();

  for (const trade of due) {
    // Lấy rate thực tế tại thời điểm thanh toán (OKX)
    const actualRate  = await fetchActualRate(trade.symbol);
    const effectiveRate = actualRate !== null ? actualRate : trade.recommendedRate;
    const netPct      = effectiveRate - FEE_ROUNDTRIP;
    const isWin       = netPct > 0;
    const paidAt      = new Date().toISOString();

    // Cập nhật stats
    stats.total++;
    stats.totalNetPct = parseFloat((stats.totalNetPct + netPct * 100).toFixed(6));
    if (isWin) {
      stats.wins++;
      if (!stats.bestTrade || netPct > stats.bestTrade.netPct) {
        stats.bestTrade = { symbol: trade.symbol, type: trade.type, netPct };
      }
    } else {
      stats.losses++;
      if (!stats.worstTrade || netPct < stats.worstTrade.netPct) {
        stats.worstTrade = { symbol: trade.symbol, type: trade.type, netPct };
      }
    }
    stats.updatedAt = paidAt;

    appendHistory({
      id: trade.id, symbol: trade.symbol, type: trade.type,
      recommendedRate: trade.recommendedRate,
      actualRate:      actualRate ?? trade.recommendedRate,
      netPct, isWin,
      recommendedAt: trade.recommendedAt,
      paidAt,
    });

    log.funding(`Funding payment: ${trade.symbol} rec=${fmtRate(trade.recommendedRate)} actual=${fmtRate(effectiveRate)} net=${fmtRate(netPct)} (${isWin ? 'WIN' : 'LOSS'})`);

    const netSign  = netPct >= 0 ? '+' : '';
    const recStr   = fmtTime(trade.recommendedAt);
    const rateNote = actualRate !== null && Math.abs(actualRate - trade.recommendedRate) > 0.0001
      ? `\n<i>Rate thực tế: ${fmtRate(actualRate)}/8h (KN: ${fmtRate(trade.recommendedRate)}/8h)</i>`
      : '';

    await sendMessages([
      `${isWin ? '💚' : '❌'} <b>FUNDING PAYMENT — ${trade.symbol}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📌 ${typeLabel(trade.type)}\n` +
      `💰 Rate: <code>${fmtRate(effectiveRate)}/8h</code>${rateNote}\n` +
      `${isWin ? '✅' : '❌'} Kết quả: <b>${netSign}${(netPct * 100).toFixed(4)}%</b>` +
      `  <i>(phí -${(FEE_ROUNDTRIP * 100).toFixed(2)}%)</i>\n` +
      `\n⏰ Khuyến nghị: <i>${recStr}</i>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `<i>Lệnh đã hoàn tất — bot dừng theo dõi, chờ khuyến nghị kỳ tiếp</i>`,
    ]).catch(e => log.error('Funding payment alert lỗi', { error: e.message }));
  }

  saveStats(stats);
  saveTrades(active.filter(t => !due.includes(t)));
}

// ─── Stats message ─────────────────────────────────────────────────────────────

function buildFundingStatsMessage() {
  const stats  = loadStats();
  const DIVIDER = '━━━━━━━━━━━━━━━━';
  const winRate = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(1) : '0.0';
  const avgNet  = stats.total > 0 ? (stats.totalNetPct / stats.total).toFixed(4) : '0.0000';
  const filled  = stats.total > 0 ? Math.round((stats.wins / stats.total) * 10) : 0;
  const bar     = `<code>${'█'.repeat(filled)}${'░'.repeat(10 - filled)}</code>`;
  const totalStr = stats.totalNetPct >= 0 ? `+${stats.totalNetPct.toFixed(4)}` : stats.totalNetPct.toFixed(4);
  const avgStr   = parseFloat(avgNet) >= 0 ? `+${avgNet}` : avgNet;

  let msg = `💸 <b>THỐNG KÊ FUNDING</b>\n${DIVIDER}\n`;
  msg += `📋 Tổng: <b>${stats.total}</b>  |  ✅ <b>${stats.wins}</b> thắng  ❌ <b>${stats.losses}</b> thua\n`;
  msg += `\n🎯 Win rate: <b>${winRate}%</b>\n${bar} ${stats.wins}/${stats.total}\n`;
  msg += `\n💰 PnL tích lũy: <b>${totalStr}%</b>\n`;
  msg += `📈 Trung bình/kỳ: <b>${avgStr}%</b>\n`;
  if (stats.bestTrade) {
    msg += `\n🏆 Tốt nhất:  <b>${stats.bestTrade.symbol}</b>  <b>+${(stats.bestTrade.netPct * 100).toFixed(4)}%</b>\n`;
  }
  if (stats.worstTrade) {
    msg += `💥 Xấu nhất:  <b>${stats.worstTrade.symbol}</b>  <b>${(stats.worstTrade.netPct * 100).toFixed(4)}%</b>\n`;
  }
  msg += `${DIVIDER}\n`;
  msg += stats.updatedAt
    ? `<i>🕐 Cập nhật: ${new Date(stats.updatedAt).toLocaleString('vi-VN', { timeZone: TIMEZONE })}</i>`
    : `<i>Chưa có kỳ funding nào hoàn tất</i>`;
  return msg;
}

function getActiveFundingTrades() {
  return loadActiveTrades();
}

module.exports = {
  parseFundingTrades,
  addFundingTrades,
  checkFundingPayments,
  getActiveFundingTrades,
  buildFundingStatsMessage,
};
