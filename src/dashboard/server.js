'use strict';

/**
 * PP369 Futures Web Dashboard Server (Port 3369) — Phase 5 & 6
 *
 * Tính năng:
 *   1. REST API endpoints đầy đủ cung cấp số liệu thời gian thực:
 *      - /api/health: Trạng thái bot, ram, lỗi, số lệnh active, last log
 *      - /api/watched-coins: Danh sách coin theo dõi (fixed, tier2, liquid, gainers)
 *      - /api/stats: Tổng quan hiệu suất (win rate, profit factor, streak, best/worst trade)
 *      - /api/chart: Biểu đồ PnL lũy kế (cumulative)
 *      - /api/analytics: Phân tích chi tiết (theo symbol, theo ngày, duration)
 *      - /api/market: Thị trường tổng quan (BTC, ETH, Fear & Greed, Funding rates)
 *      - /api/trades: Danh sách vị thế đang mở
 *      - /api/live-pnl: PnL thời gian thực cho từng lệnh (array)
 *      - /api/history: Lịch sử lệnh đóng (hợp nhất bot-h4 & bot_new)
 *      - /api/funding/*: Số liệu funding arbitrage
 *      - /api/signals: Lịch sử tín hiệu PP369
 *      - /api/pp369-context: Nến H1 đầu tháng của các coin có tín hiệu
 *      - /api/log-dates: Danh sách ngày có log (từ cả PM2 logs-h4 và bot_new)
 *      - /api/logs: Đọc và parse nhật ký đa định dạng (bot-new + PM2 h4)
 *      - /api/trades/update: Cập nhật TP/SL lệnh đang mở
 *      - /api/sync & /api/forcesync: Đồng bộ vị thế và override safety brake
 *      - /api/cooldown: Danh sách coin đang trong thời gian giãn cách
 *   2. WebSocket Server push realtime (0ms delay) cho cả 'trades' và 'price'.
 *   3. Phục vụ giao diện Web Dashboard hoàn chỉnh (index.html).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const { log } = require('../pp369/_logger');
const { isSafetyBrakeActive, getLastBrakeInfo, overrideSafetyBrake } = require('../trader/safetyBrake');

let isStreamConnected = () => false;
try {
  isStreamConnected = require('../trader/binanceStream').isStreamConnected;
} catch {}

const DATA_DIR = path.join(process.cwd(), 'data');
const HTML_FILE = path.join(__dirname, 'index.html');
const FAVICON_FILE = path.join(__dirname, 'favicon.jpg');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const DEFAULT_PORT = parseInt(process.env.DASHBOARD_PORT || (process.env.PORT && process.env.PORT !== '3000' ? process.env.PORT : '3369'), 10);

// WebSocket clients
const _wsClients = new Set();

function broadcastWs(type, data) {
  if (!_wsClients.size) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const client of _wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch {}
  }
}

// ─── Simple TTL Cache ────────────────────────────────────────────────────────
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const e = _cache.get(key);
  if (e && e.expireAt > now) return e.data;
  const data = await fn();
  _cache.set(key, { data, expireAt: now + ttlMs });
  return data;
}

// ─── Helpers Đọc Dữ Liệu ─────────────────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

function readJson(file, fallback = {}) {
  try {
    const full = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file, limit = 500) {
  try {
    const full = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return [];
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const result = [];
    const start = Math.max(0, lines.length - limit);
    for (let i = lines.length - 1; i >= start; i--) {
      try {
        result.push(JSON.parse(lines[i]));
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

function readTail(filePath, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// ─── Parser Nhật Ký Đa Định Dạng ──────────────────────────────────────────────

function parseLogLine(line, targetDate) {
  if (!line || !line.trim()) return null;

  // Định dạng 1: bot-new: [HH:mm:ss] [CAT  ] message | {optional json}
  let m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[(\w+)\s*\]\s*(.+)$/);
  if (m) {
    const [, time, rawCat, rest] = m;
    const pi = rest.lastIndexOf(' | {');
    const message = pi >= 0 ? rest.slice(0, pi) : rest;
    let data = null;
    if (pi >= 0) { try { data = JSON.parse(rest.slice(pi + 3)); } catch {} }
    return { time, cat: rawCat.trim(), message, data, date: targetDate, raw: line };
  }

  // Định dạng 2: PM2 (bot-h4): YYYY-MM-DD HH:mm:ss: [Tag1] [Tag2] message
  m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}):\s*(.+)$/);
  if (m) {
    const [, date, time, rawRest] = m;
    if (targetDate && date !== targetDate) return null;
    let rest = rawRest;
    let cat = 'SYSTEM';

    if (rest.includes('[AI Reviewer]') || rest.includes('[AutoRetrain]') || rest.includes('[AI]')) {
      cat = 'AI';
    } else if (rest.includes('[AutoTrade]') || rest.includes('[ShadowTracker]') || rest.includes('[CONFLUENCE PASS]') || rest.includes('[ORDER]')) {
      cat = 'TRADE';
    } else if (rest.includes('[Binance]') || rest.includes('[Price]') || rest.includes('[BinanceStream]')) {
      cat = 'PRICE';
    } else if (rest.includes('[DailyReporter]') || rest.includes('[Telegram]') || rest.includes('[TelegramCommands]')) {
      cat = 'TELEGRAM';
    } else if (rest.includes('[WARN]') || rest.includes('⚠️')) {
      cat = 'WARN';
    } else if (rest.includes('Error:') || rest.includes('[ERR]') || rest.includes('Fatal:')) {
      cat = 'ERROR';
    }

    let message = rest
      .replace(/^\[PP369\]\s*/i, '')
      .replace(/^\[(AI Reviewer|AutoTrade|Binance|ShadowTracker|AutoRetrain|DailyReporter|TelegramCommands)\]\s*/i, '')
      .trim();

    return { time, cat, message, data: null, date, raw: line };
  }

  return { time: '', cat: '', message: line, data: null, date: targetDate, raw: line };
}

function getLogsForDate(date, limit = 300, filter = '') {
  const isToday = (date === todayStr());
  const targetFiles = [];

  // 1. bot_new log
  const newLog = path.join(process.cwd(), 'bot_new', 'data', 'logs', `bot-${date}.log`);
  if (fs.existsSync(newLog)) targetFiles.push(newLog);

  // 2. bot-h4 rotated logs matching date
  const h4Dirs = [
    path.join(process.cwd(), 'logs', 'logs-h4'),
    path.join(process.cwd(), 'logs'),
  ];
  for (const d of h4Dirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const files = fs.readdirSync(d);
      for (const f of files) {
        if (f.includes(date) && f.endsWith('.log')) {
          const full = path.join(d, f);
          if (!targetFiles.includes(full)) targetFiles.push(full);
        }
      }
      if (isToday) {
        const pm2Out = path.join(d, 'pm2-out.log');
        if (fs.existsSync(pm2Out) && !targetFiles.includes(pm2Out)) targetFiles.push(pm2Out);
        const pm2Err = path.join(d, 'pm2-error.log');
        if (fs.existsSync(pm2Err) && !targetFiles.includes(pm2Err)) targetFiles.push(pm2Err);
      }
    } catch {}
  }

  const rawLines = [];
  const seenRaw = new Set();

  for (const file of targetFiles) {
    const content = readTail(file, 2 * 1024 * 1024);
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      if (seenRaw.has(line)) continue;
      seenRaw.add(line);
      const parsed = parseLogLine(line, date);
      if (parsed) rawLines.push(parsed);
    }
  }

  // Lọc theo danh mục nếu có
  const cats = filter ? filter.toUpperCase().split(',').map(s => s.trim()).filter(Boolean) : [];
  let filtered = cats.length > 0
    ? rawLines.filter(l => cats.some(c => (l.cat && l.cat.toUpperCase().includes(c)) || (l.message && l.message.toUpperCase().includes(`[${c}`))))
    : rawLines;

  // Sắp xếp thời gian tăng dần
  filtered.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  return { date, lines: filtered.slice(-limit) };
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

function apiHealth() {
  const mem = process.memoryUsage();
  let brakeInfo = { reason: null, time: null };
  try { brakeInfo = getLastBrakeInfo(); } catch {}
  let activeBrake = false;
  try { activeBrake = isSafetyBrakeActive(); } catch {}

  const cooldowns = readJson('sl_cooldown.json', {});
  const now = Date.now();
  const activeCooldownsCount = Object.values(cooldowns).filter(entry => {
    const exp = typeof entry === 'object' ? entry.expiry : entry;
    return exp > now;
  }).length;

  const today = todayStr();
  const logsToday = getLogsForDate(today, 1000);
  let lastLog = null;
  let tradeCount = 0;
  let aiCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  if (logsToday.lines.length) {
    const lastWithTime = [...logsToday.lines].reverse().find(l => l.time);
    if (lastWithTime) {
      lastLog = `${today}T${lastWithTime.time}`;
    }
    for (const l of logsToday.lines) {
      if (l.cat === 'ERROR') errorCount++;
      else if (l.cat === 'TRADE') tradeCount++;
      else if (l.cat === 'AI') aiCount++;
      else if (l.cat === 'WARN') warnCount++;
    }
  }

  const activeTradesList = apiTrades();
  const fundingTradesList = apiFundingTrades();

  return {
    status: 'ONLINE',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    websocket: {
      userDataStreamConnected: isStreamConnected ? isStreamConnected() : false,
      wsClientsCount: _wsClients.size,
    },
    safetyBrake: {
      isActive: activeBrake,
      reason: brakeInfo.reason,
      lastTriggeredAt: brakeInfo.time ? new Date(brakeInfo.time).toISOString() : null,
    },
    cooldownCount: activeCooldownsCount,
    version: '2.0.0-hybrid-quant',

    // Các trường tương thích hoàn toàn với index.html:
    today,
    lastLog,
    errorCount,
    tradeCount,
    aiCount,
    warnCount,
    activeTrades: activeTradesList.length,
    fundingActive: fundingTradesList.length,
  };
}

function apiTrades() {
  const trades = [];

  // 1. Đọc từ active_trades.json của bot-h4
  const activeTrades = readJson('active_trades.json', {});
  for (const [sym, meta] of Object.entries(activeTrades)) {
    if (!meta || meta.isClosed) continue;
    const isLong = meta.side === 'BUY' || meta.side === 'LONG';
    const entryPrice = parseFloat(meta.entryPrice) || 0;
    const markPrice = parseFloat(meta.markPrice) || entryPrice;
    const leverage = parseFloat(meta.leverage) || 10;
    const margin = parseFloat(meta.margin) || 20;

    const roiPct = isLong
      ? ((markPrice - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - markPrice) / entryPrice) * leverage * 100;
    const pnlUsd = (roiPct / 100) * margin;

    trades.push({
      id: meta.id || sym,
      symbol: sym,
      direction: isLong ? 'LONG' : 'SHORT',
      side: meta.side,
      entryPrice,
      currentPrice: markPrice,
      targetPrice: meta.tierTpPrice || meta.targetPrice,
      tp1Price: meta.tp1Price || meta.tierTpPrice || meta.targetPrice,
      tp2Price: meta.tp2Price || null,
      tp1Hit: meta.tp1Hit || false,
      tp2Hit: meta.tp2Hit || false,
      slPrice: meta.currentSlPrice || meta.tierSlPrice || meta.slPrice,
      beTriggerPrice: meta.beTriggerPrice,
      isBreakeven: meta.isBreakeven || false,
      slMovedToBreakeven: meta.isBreakeven || false,
      leverage,
      margin,
      unrealizedPnlUsd: parseFloat(pnlUsd.toFixed(2)),
      roiPct: parseFloat(roiPct.toFixed(2)),
      score: meta.score || 0,
      confluenceScore: meta.confluenceScore || meta.score || null,
      entryFilled: meta.isFilled !== false,
      tpOrderId: meta.tpOrderId || null,
      slOrderId: meta.slOrderId || null,
      binanceTpOrderId: meta.tpOrderId || meta.binanceTpOrderId || null,
      binanceSlOrderId: meta.slOrderId || meta.binanceSlOrderId || null,
      recommendedAt: meta.time ? new Date(meta.time).toISOString() : new Date().toISOString(),
      status: 'active',
      source: 'bot-h4',
    });
  }

  // 2. Đọc từ bot_new/data/trades.json nếu có
  const newTrades = readJson(path.join(process.cwd(), 'bot_new', 'data', 'trades.json'), []);
  if (Array.isArray(newTrades)) {
    for (const nt of newTrades) {
      if (nt.status === 'active' && !trades.some(t => t.symbol === nt.symbol)) {
        trades.push({ ...nt, id: nt.id || nt.symbol });
      }
    }
  }

  return trades;
}

async function apiLivePnl() {
  return cached('live-pnl', 10_000, async () => {
    const trades = apiTrades();
    if (!trades.length) return [];

    const symbols = [...new Set(trades.map(t => t.symbol))];
    const prices = {};

    try {
      const HDR = { 'User-Agent': 'crypto-news-bot/1.0' };
      const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 4000, headers: HDR });
      if (Array.isArray(data)) {
        for (const item of data) {
          const sym = item.symbol?.replace(/USDT$/, '');
          if (sym && symbols.includes(sym)) prices[sym] = parseFloat(item.markPrice);
        }
      }
    } catch {}

    return trades.map(t => {
      const curr = prices[t.symbol] || t.currentPrice;
      const entry = t.entryPrice;
      if (!curr || !entry) {
        return {
          id: t.id || t.symbol,
          symbol: t.symbol,
          currentPrice: curr ?? null,
          unrealizedPct: null,
          progress: null,
        };
      }
      const dir = (t.direction === 'LONG' || t.side === 'BUY') ? 1 : -1;
      const rawPct = ((curr - entry) / entry) * 100 * dir;
      const tpPct = t.targetPrice ? Math.abs((t.targetPrice - entry) / entry * 100) : (t.targetPct ?? 5);
      const slPct = t.slPrice ? Math.abs((entry - t.slPrice) / entry * 100) : (t.slPct ?? 3);
      const range = tpPct + slPct;
      const progress = range > 0 ? Math.max(0, Math.min(100, ((rawPct + slPct) / range) * 100)) : 50;

      return {
        id: t.id || t.symbol,
        symbol: t.symbol,
        currentPrice: curr,
        unrealizedPct: parseFloat(rawPct.toFixed(3)),
        progress: parseFloat(progress.toFixed(1)),
        tpPct,
        slPct,
      };
    });
  });
}

function apiHistory() {
  const list = [];

  // 1. Đọc từ shadow_trades_history.jsonl
  const shadowHist = readJsonl('shadow_trades_history.jsonl', 300);
  for (const item of shadowHist) {
    const isWin = (item.pnlPct || 0) > 0;
    list.push({
      symbol: item.symbol,
      direction: item.direction || item.side || 'LONG',
      entryPrice: item.entryPrice,
      closePrice: item.closePrice || item.exitPrice,
      pnlPct: parseFloat((item.pnlPct || 0).toFixed(2)),
      pnlUsd: parseFloat((item.pnlUsd || 0).toFixed(2)),
      closedAt: item.closedAt || (item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString()),
      exitReason: item.exitReason ? item.exitReason.toLowerCase() : (isWin ? 'tp' : 'sl'),
      hit: item.hit || (isWin ? 'TP' : 'SL'),
      result: isWin ? 'win' : 'loss',
      durationMs: item.durationMs || 0,
      leverage: item.leverage || 10,
      tp1Hit: item.tp1Hit || false,
      tp2Hit: item.tp2Hit || false,
      source: 'bot-h4',
    });
  }

  // 2. Đọc từ bot_new/data/trade_history.json nếu có
  const newHist = readJson(path.join(process.cwd(), 'bot_new', 'data', 'trade_history.json'), []);
  if (Array.isArray(newHist)) {
    for (const item of newHist) {
      list.push({
        ...item,
        closedAt: item.closedAt || item.timestamp,
        source: 'bot-new',
      });
    }
  }

  list.sort((a, b) => new Date(b.closedAt || 0) - new Date(a.closedAt || 0));
  return list.slice(0, 300);
}

function apiStats() {
  const history = apiHistory();
  const totalTrades = history.length;
  if (!totalTrades) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      currentStreak: 0,
      streakType: 'win',
      totalPnlPct: 0,
      profitFactor: null,
      avgPnl: 0,
      avgDuration: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const wins = history.filter(t => (t.pnlPct || 0) > 0).length;
  const losses = history.filter(t => (t.pnlPct || 0) < 0).length;
  const breakeven = history.filter(t => (t.pnlPct || 0) === 0).length;
  const winRate = parseFloat(((wins / totalTrades) * 100).toFixed(1));
  const totalPnlPct = parseFloat(history.reduce((sum, t) => sum + (t.pnlPct || 0), 0).toFixed(2));
  const winPnl = history.filter(t => (t.pnlPct || 0) > 0).reduce((sum, t) => sum + t.pnlPct, 0);
  const lossPnl = Math.abs(history.filter(t => (t.pnlPct || 0) < 0).reduce((sum, t) => sum + t.pnlPct, 0));
  const profitFactor = lossPnl > 0 ? parseFloat((winPnl / lossPnl).toFixed(2)) : (winPnl > 0 ? 99.9 : null);
  const avgPnl = parseFloat((totalPnlPct / totalTrades).toFixed(2));

  const validDurations = history.filter(t => t.durationMs > 0);
  const avgDuration = validDurations.length > 0
    ? parseFloat((validDurations.reduce((s, t) => s + t.durationMs, 0) / validDurations.length / 3600000).toFixed(1))
    : 0;

  let bestTrade = null;
  let worstTrade = null;
  for (const t of history) {
    if (!bestTrade || (t.pnlPct || 0) > (bestTrade.pnlPct || 0)) bestTrade = t;
    if (!worstTrade || (t.pnlPct || 0) < (worstTrade.pnlPct || 0)) worstTrade = t;
  }

  const chrono = history.slice().sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  let currentStreak = 0;
  let streakType = 'win';
  for (let i = chrono.length - 1; i >= 0; i--) {
    const pnl = chrono[i].pnlPct || 0;
    if (pnl === 0) continue;
    const isWin = pnl > 0;
    if (currentStreak === 0) {
      streakType = isWin ? 'win' : 'loss';
      currentStreak = 1;
    } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
      currentStreak++;
    } else {
      break;
    }
  }

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate,
    currentStreak,
    streakType,
    totalPnlPct,
    profitFactor,
    avgPnl,
    avgDuration,
    bestTrade,
    worstTrade,
  };
}

function apiChart() {
  const history = apiHistory().slice().sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  let cum = 0;
  return history.map(t => {
    cum = parseFloat((cum + (t.pnlPct ?? 0)).toFixed(2));
    return {
      date: t.closedAt,
      cum,
      symbol: t.symbol,
      hit: t.hit,
      exitReason: t.exitReason,
      pnl: t.pnlPct,
    };
  });
}

function apiAnalytics() {
  const history = apiHistory();
  if (!history.length) return { bySymbol: [], byDay: [], duration: [] };

  // 1. Thống kê theo symbol
  const symMap = {};
  for (const t of history) {
    if (!t.symbol) continue;
    if (!symMap[t.symbol]) symMap[t.symbol] = { wins: 0, losses: 0, revs: 0, pnl: 0 };
    const s = symMap[t.symbol];
    const isWin = (t.pnlPct || 0) > 0 || t.hit === 'TP';
    const isLoss = (t.pnlPct || 0) < 0 || t.hit === 'SL';
    if (isWin) s.wins++;
    else if (isLoss) s.losses++;
    else s.revs++;
    s.pnl += (t.pnlPct || 0);
  }

  const bySymbol = Object.entries(symMap)
    .map(([symbol, s]) => {
      const closed = s.wins + s.losses;
      return {
        symbol,
        wins: s.wins,
        losses: s.losses,
        revs: s.revs,
        total: s.wins + s.losses + s.revs,
        winRate: closed > 0 ? parseFloat(((s.wins / closed) * 100).toFixed(1)) : null,
        pnl: parseFloat(s.pnl.toFixed(2)),
      };
    })
    .sort((a, b) => b.total - a.total);

  // 2. PnL theo ngày (60 ngày gần nhất)
  const dayMap = {};
  for (const t of history) {
    if (!t.closedAt || t.pnlPct == null) continue;
    const day = String(t.closedAt).slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { pnl: 0, wins: 0, losses: 0 };
    dayMap[day].pnl += t.pnlPct;
    if ((t.pnlPct || 0) > 0 || t.hit === 'TP') dayMap[day].wins++;
    else if ((t.pnlPct || 0) < 0 || t.hit === 'SL') dayMap[day].losses++;
  }

  const byDay = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-60)
    .map(([day, d]) => ({ day, pnl: parseFloat(d.pnl.toFixed(2)), wins: d.wins, losses: d.losses }));

  // 3. Phân bổ thời gian giữ vị thế
  const buckets = { '<1h': 0, '1–4h': 0, '4–12h': 0, '12–24h': 0, '>24h': 0 };
  for (const t of history) {
    if (!t.durationMs) continue;
    const h = t.durationMs / 3600000;
    if (h < 1) buckets['<1h']++;
    else if (h < 4) buckets['1–4h']++;
    else if (h < 12) buckets['4–12h']++;
    else if (h < 24) buckets['12–24h']++;
    else buckets['>24h']++;
  }
  const duration = Object.entries(buckets).map(([label, count]) => ({ label, count }));

  return { bySymbol, byDay, duration };
}

async function apiMarket() {
  return cached('market', 30_000, async () => {
    const HDR = { 'User-Agent': 'crypto-news-bot/1.0' };
    const [btcR, ethR, fngR, fundR] = await Promise.allSettled([
      axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT', { timeout: 5000, headers: HDR }),
      axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=ETHUSDT', { timeout: 5000, headers: HDR }),
      axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 }),
      axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 6000, headers: HDR }),
    ]);

    function ticker(r) {
      if (r.status !== 'fulfilled') return null;
      const d = r.value.data;
      return {
        price: +d.lastPrice,
        change: +d.priceChangePercent,
        high: +d.highPrice,
        low: +d.lowPrice,
        volume: +d.quoteVolume,
      };
    }

    const fng = fngR.status === 'fulfilled' ? fngR.value.data?.data?.[0] : null;
    const rawFund = fundR.status === 'fulfilled' ? fundR.value.data : [];
    const topFunding = Array.isArray(rawFund)
      ? rawFund
          .filter(f => f.symbol?.endsWith('USDT'))
          .map(f => ({ symbol: f.symbol.replace('USDT', ''), rate: parseFloat(f.lastFundingRate) * 100 }))
          .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
          .slice(0, 20)
      : [];

    return {
      btc: ticker(btcR),
      eth: ticker(ethR),
      fearGreed: fng ? { value: +fng.value, label: fng.value_classification } : null,
      topFunding,
      fetchedAt: new Date().toISOString(),
    };
  });
}

function apiWatchedCoins() {
  // 1. Thử đọc từ pp369_symbols.json nếu có
  let data = readJson('pp369_symbols.json', null);
  if (!data) data = readJson(path.join(process.cwd(), 'bot_new', 'data', 'pp369_symbols.json'), null);

  if (data && Array.isArray(data.symbols) && data.symbols.length) {
    const symbols = data.symbols;
    const fixed = Array.isArray(data.fixed) ? data.fixed : [];
    const tier2 = Array.isArray(data.tier2) ? data.tier2 : [];
    const liquid = Array.isArray(data.liquid) ? data.liquid : [];
    const gainers = Array.isArray(data.gainers) ? data.gainers : [];
    const resolvedFixed = (!fixed.length && !tier2.length && !liquid.length && !gainers.length && symbols.length)
      ? symbols : fixed;
    return { ...data, symbols, fixed: resolvedFixed, tier2, liquid, gainers };
  }

  // 2. Fallback cho bot-h4: đọc danh sách từ step_sizes.json và market_cap_top.json
  const fixed = (process.env.FIXED_COINS || process.env.COINS || 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,NEAR')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  let symbols = [];
  try {
    const stepData = readJson('step_sizes.json', {});
    if (stepData.stepSizes) {
      symbols = Object.keys(stepData.stepSizes)
        .filter(s => s.endsWith('USDT') && !s.includes('_'))
        .map(s => s.replace('USDT', ''));
    }
  } catch {}

  if (!symbols.length) symbols = fixed.slice();

  let tier2 = [];
  try {
    const mcData = readJson('market_cap_top.json', {});
    if (Array.isArray(mcData.symbols)) {
      tier2 = mcData.symbols
        .filter(s => symbols.includes(s) && !fixed.includes(s))
        .slice(0, 42);
    }
  } catch {}

  const liquid = symbols.filter(s => !fixed.includes(s) && !tier2.includes(s));

  return {
    symbols,
    fixed,
    tier2,
    liquid,
    gainers: [],
    updatedAt: new Date().toISOString(),
    source: 'bot-h4',
  };
}

function apiSignals() {
  const file1 = path.join(DATA_DIR, '369_signals.jsonl');
  const file2 = path.join(process.cwd(), 'bot_new', 'data', '369_signals.jsonl');
  const list = [];
  try {
    if (fs.existsSync(file1)) {
      list.push(...fs.readFileSync(file1, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
    }
  } catch {}
  try {
    if (fs.existsSync(file2)) {
      list.push(...fs.readFileSync(file2, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
    }
  } catch {}
  return list.reverse();
}

async function apiPp369Context() {
  return cached('pp369-ctx', 60 * 60_000, async () => {
    const HDR = { 'User-Agent': 'crypto-news-bot/1.0' };
    const now = new Date();
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);

    let symbols = [];
    try {
      const sigs = apiSignals();
      symbols = [...new Set(sigs.map(s => s.symbol).filter(Boolean))];
    } catch {}
    if (!symbols.length) symbols = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'NEAR'];

    const ctx = {};
    await Promise.allSettled(symbols.slice(0, 30).map(async sym => {
      try {
        const { data } = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
          params: { symbol: `${sym}USDT`, interval: '1h', startTime: monthStartMs, limit: 1 },
          timeout: 4000, headers: HDR,
        });
        if (Array.isArray(data) && data.length) {
          const c = data[0];
          ctx[sym] = {
            h1Open: parseFloat(c[1]),
            h1Close: parseFloat(c[4]),
            h1High: parseFloat(c[2]),
            h1Low: parseFloat(c[3]),
            candleTime: new Date(c[0]).toISOString(),
          };
        }
      } catch {}
    }));
    return ctx;
  });
}

function apiFundingStats() {
  let data = readJson('funding_stats.json', null);
  if (!data) data = readJson(path.join(process.cwd(), 'bot_new', 'data', 'funding_stats.json'), null);
  return { total: 0, wins: 0, losses: 0, totalNetPct: 0, ...(data || {}) };
}

function apiFundingTrades() {
  let data = readJson('funding_trades.json', null);
  if (!data) data = readJson(path.join(process.cwd(), 'bot_new', 'data', 'funding_trades.json'), []);
  return Array.isArray(data) ? data.filter(t => t.status === 'active') : [];
}

function apiFundingHistory() {
  let data = readJson('funding_history.json', null);
  if (!data) data = readJson(path.join(process.cwd(), 'bot_new', 'data', 'funding_history.json'), []);
  return Array.isArray(data) ? data.slice().reverse() : [];
}

function apiCooldown() {
  const raw = readJson('sl_cooldown.json', {});
  const now = Date.now();
  const list = [];
  for (const [sym, entry] of Object.entries(raw)) {
    const exp = typeof entry === 'object' ? entry.expiry : entry;
    const reason = typeof entry === 'object' ? entry.reason : 'SL';
    if (exp > now) {
      const remainingMs = exp - now;
      const remainingHours = parseFloat((remainingMs / 3600000).toFixed(1));
      list.push({
        symbol: sym,
        reason,
        expiresAt: new Date(exp).toISOString(),
        remainingHours,
      });
    }
  }
  return list.sort((a, b) => a.remainingHours - b.remainingHours);
}

function apiLogDates() {
  const dates = new Set();
  const today = todayStr();
  dates.add(today);

  const searchDirs = [
    path.join(process.cwd(), 'logs', 'logs-h4'),
    path.join(process.cwd(), 'logs'),
    path.join(process.cwd(), 'bot_new', 'data', 'logs'),
    path.join(process.cwd(), 'data', 'logs'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        let m = f.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m) { dates.add(m[1]); continue; }

        m = f.match(/__(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.log$/);
        if (m) { dates.add(m[1]); continue; }

        m = f.match(/(\d{4}-\d{2}-\d{2})/);
        if (m && f.endsWith('.log')) { dates.add(m[1]); }
      }
    } catch {}
  }

  return Array.from(dates).sort().reverse();
}

function apiLogs(url) {
  const p = new URLSearchParams((url || '').split('?')[1] || '');
  const date = p.get('date') || todayStr();
  const filter = p.get('filter') || '';
  const n = Math.min(parseInt(p.get('lines') || '300', 10), 1000);
  return getLogsForDate(date, n, filter);
}

function apiUpdateTrade(url) {
  const p = new URLSearchParams((url || '').split('?')[1] || '');
  const id = p.get('id');
  if (!id) return { ok: false, error: 'Missing id' };

  const fields = {};
  for (const key of ['targetPrice', 'slPrice', 'tp1Price', 'tp2Price']) {
    if (p.has(key)) {
      const raw = p.get(key).trim();
      fields[key] = raw === '' ? null : parseFloat(raw) || null;
    }
  }

  // 1. Thử cập nhật trong bot-h4 active_trades.json
  const activeFile = path.join(DATA_DIR, 'active_trades.json');
  if (fs.existsSync(activeFile)) {
    try {
      const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      for (const [sym, meta] of Object.entries(active)) {
        if (sym === id || meta.id === id) {
          if (fields.targetPrice != null) meta.tierTpPrice = meta.targetPrice = fields.targetPrice;
          if (fields.slPrice != null) meta.currentSlPrice = meta.tierSlPrice = meta.slPrice = fields.slPrice;
          if (fields.tp1Price != null) meta.tp1Price = fields.tp1Price;
          if (fields.tp2Price != null) meta.tp2Price = fields.tp2Price;
          fs.writeFileSync(activeFile, JSON.stringify(active, null, 2), 'utf8');
          return { ok: true, symbol: sym, fields };
        }
      }
    } catch (err) {
      log.warn(`[Dashboard] Lỗi cập nhật active_trades.json: ${err.message}`);
    }
  }

  // 2. Thử cập nhật qua tradeMonitor của bot_new nếu có
  try {
    const tm = require(path.join(process.cwd(), 'bot_new', 'src', 'services', 'tradeMonitor'));
    if (tm?.updateActiveTrade) {
      const res = tm.updateActiveTrade(id, fields);
      if (res?.ok) return res;
    }
  } catch {}

  return { ok: false, error: 'Trade not found' };
}

// ─── HTTP Server Router ───────────────────────────────────────────────────────

let _server = null;
let _wss = null;
let _activePort = DEFAULT_PORT;
let _pricePushTimer = null;

function createDashboardServer() {
  const server = http.createServer(async (req, res) => {
    const urlParts = (req.url || '/').split('?');
    const urlPath = urlParts[0];

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static Files
    if (req.method === 'GET') {
      if (urlPath === '/' || urlPath === '/index.html') {
        if (fs.existsSync(HTML_FILE)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(HTML_FILE).pipe(res);
          return;
        }
      }

      if (urlPath === '/favicon.jpg' || urlPath === '/favicon.ico') {
        if (fs.existsSync(FAVICON_FILE)) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          fs.createReadStream(FAVICON_FILE).pipe(res);
          return;
        }
      }

      // JSON API Routes
      const routes = {
        '/api/health': apiHealth,
        '/api/stats': apiStats,
        '/api/trades': apiTrades,
        '/api/history': apiHistory,
        '/api/chart': apiChart,
        '/api/analytics': apiAnalytics,
        '/api/market': apiMarket,
        '/api/live-pnl': apiLivePnl,
        '/api/watched-coins': apiWatchedCoins,
        '/api/signals': apiSignals,
        '/api/pp369-context': apiPp369Context,
        '/api/funding/stats': apiFundingStats,
        '/api/funding/trades': apiFundingTrades,
        '/api/funding/history': apiFundingHistory,
        '/api/cooldown': apiCooldown,
        '/api/log-dates': apiLogDates,
        '/api/logs': () => apiLogs(req.url),
        '/api/trades/update': () => apiUpdateTrade(req.url),
      };

      if (routes[urlPath]) {
        try {
          const result = await routes[urlPath]();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    // POST Command Endpoints
    if (req.method === 'POST') {
      if (urlPath === '/api/forcesync' || urlPath === '/api/sync') {
        let result = { message: 'Overridden safety brake' };
        try {
          result = overrideSafetyBrake();
        } catch {}

        try {
          const tm = require(path.join(process.cwd(), 'bot_new', 'src', 'services', 'tradeMonitor'));
          if (tm?.syncManualPositions) await tm.syncManualPositions('api');
        } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          action: 'sync',
          message: result?.message || 'Sync triggered successfully',
          timestamp: new Date().toISOString(),
        }));
        return;
      }
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found', path: urlPath }));
  });

  return server;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function startDashboard(port = DEFAULT_PORT, attempt = 1, originalPort = null) {
  if (_server) return _server;

  const targetPort = port || DEFAULT_PORT;
  const initialPort = originalPort || targetPort;
  _activePort = targetPort;

  const srv = createDashboardServer();

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`[Dashboard] ⚠️ Port ${_activePort} đã bị chiếm dụng (EADDRINUSE).`);
      stopDashboard();

      if (attempt < 5) {
        const nextPort = targetPort + 1;
        log.system(`[Dashboard] 🔄 Đang tự động đổi sang port dự phòng: ${nextPort} (Lần thử ${attempt + 1}/5)...`);
        startDashboard(nextPort, attempt + 1, initialPort);
      } else {
        log.warn(`[Dashboard] ⚠️ Không thể mở Web Dashboard sau 5 lần thử cổng (${initialPort} -> ${_activePort}).`);
      }
      return;
    }

    log.warn(`[Dashboard] Lỗi mạng máy chủ Web Dashboard: ${err.message}`);
    stopDashboard();
  });

  srv.listen(targetPort, () => {
    log.system(`[Dashboard] 🚀 Web Dashboard PP369 sẵn sàng tại: http://localhost:${targetPort}`);

    try {
      _wss = new WebSocketServer({ server: srv });
      _wss.on('error', (err) => {
        log.warn(`[Dashboard] Lỗi WebSocket Server: ${err.message}`);
      });
      _wss.on('connection', async (ws) => {
        _wsClients.add(ws);
        try {
          ws.send(JSON.stringify({
            type: 'trades',
            data: apiTrades(),
          }));
          const pnlList = await apiLivePnl();
          ws.send(JSON.stringify({
            type: 'price',
            data: pnlList,
          }));
        } catch {}

        ws.on('close', () => _wsClients.delete(ws));
        ws.on('error', () => _wsClients.delete(ws));
      });

      // Đẩy cập nhật giá định kỳ qua WebSocket mỗi 15 giây
      if (!_pricePushTimer) {
        _pricePushTimer = setInterval(async () => {
          if (_wsClients.size > 0) {
            try {
              const pnl = await apiLivePnl();
              broadcastWs('price', pnl);
            } catch {}
          }
        }, 15_000);
      }
    } catch (wsErr) {
      log.warn(`[Dashboard] Lỗi khởi tạo WebSocket Server: ${wsErr.message}`);
    }
  });

  _server = srv;
  return _server;
}

function stopDashboard() {
  if (_pricePushTimer) {
    clearInterval(_pricePushTimer);
    _pricePushTimer = null;
  }
  if (_wss) {
    try {
      for (const ws of _wsClients) {
        try { ws.terminate(); } catch {}
      }
      _wsClients.clear();
      _wss.close(() => {});
    } catch {}
    _wss = null;
  }
  if (_server) {
    try {
      _server.close(() => {});
    } catch {}
    _server = null;
    log.system('[Dashboard] Đã dừng Web Dashboard Server');
  }
}

function getActivePort() {
  return _activePort;
}

module.exports = {
  startDashboard,
  stopDashboard,
  getActivePort,
  broadcastWs,
  apiHealth,
  apiTrades,
  apiHistory,
  apiStats,
  apiChart,
  apiAnalytics,
  apiMarket,
  apiWatchedCoins,
  apiSignals,
  apiPp369Context,
  apiFundingStats,
  apiFundingTrades,
  apiFundingHistory,
  apiCooldown,
  apiLogDates,
  apiLogs,
  apiLivePnl,
};
