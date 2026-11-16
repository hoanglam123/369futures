'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { WebSocketServer } = require('ws');

// ─── Dashboard WebSocket broadcast ───────────────────────────────────────────
const _wsClients = new Set();

function broadcastWs(type, data) {
  if (!_wsClients.size) return;
  const msg = JSON.stringify({ type, data });
  for (const c of _wsClients) {
    try { if (c.readyState === 1) c.send(msg); } catch {}
  }
}

// Lazy-load tradeMonitor để tránh circular require khi server.js được import trước tradeMonitor
let _tm = null;
function tm() { if (!_tm) { try { _tm = require('../services/tradeMonitor'); } catch {} } return _tm; }

const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const LOGS_DIR  = path.join(DATA_DIR, 'logs');
const HTML_FILE = path.join(__dirname, 'index.html');
const TIMEZONE  = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';

// ─── Simple TTL cache ────────────────────────────────────────────────────────
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const e = _cache.get(key);
  if (e && e.expireAt > now) return e.data;
  const data = await fn();
  _cache.set(key, { data, expireAt: now + ttlMs });
  return data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch { return fallback; }
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

function readTail(filePath, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function apiStats() {
  const stats   = readJson('trade_stats.json', {});
  const history = readJson('trade_history.json', []);
  const winRate = stats.totalTrades > 0
    ? parseFloat((stats.wins / stats.totalTrades * 100).toFixed(1)) : 0;
  const avgPnl = stats.totalTrades > 0
    ? parseFloat((stats.totalPnlPct / stats.totalTrades).toFixed(2)) : 0;
  const winPnl  = history.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const lossPnl = Math.abs(history.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = lossPnl > 0 ? parseFloat((winPnl / lossPnl).toFixed(2)) : null;
  const avgDuration  = history.length > 0
    ? Math.round(history.reduce((s, t) => s + (t.durationMs || 0), 0) / history.length / 360000) / 10 : 0;
  return { ...stats, winRate, avgPnl, profitFactor, avgDuration };
}

function apiTrades() { return readJson('trades.json', []); }
function apiHistory() { return readJson('trade_history.json', []).slice().reverse(); }

function apiChart() {
  const history = readJson('trade_history.json', []);
  let cum = 0;
  return history.map(t => {
    cum = parseFloat((cum + (t.pnlPct ?? 0)).toFixed(4));
    return { date: t.closedAt, cum, symbol: t.symbol, hit: t.hit, pnl: t.pnlPct };
  });
}

// ─── Analytics ───────────────────────────────────────────────────────────────
function apiAnalytics() {
  const history = readJson('trade_history.json', []);
  if (!history.length) return { bySymbol: [], byDay: [], duration: [] };

  // Win rate + PnL by symbol
  const symMap = {};
  for (const t of history) {
    if (!symMap[t.symbol]) symMap[t.symbol] = { wins: 0, losses: 0, revs: 0, pnl: 0 };
    const s = symMap[t.symbol];
    if (t.hit === 'TP') s.wins++;
    else if (t.hit === 'SL') s.losses++;
    else s.revs++;
    s.pnl += t.pnlPct ?? 0;
  }
  const bySymbol = Object.entries(symMap)
    .map(([symbol, s]) => {
      const closed = s.wins + s.losses;
      return { symbol, wins: s.wins, losses: s.losses, revs: s.revs,
               total: s.wins + s.losses + s.revs,
               winRate: closed > 0 ? parseFloat((s.wins / closed * 100).toFixed(1)) : null,
               pnl: parseFloat(s.pnl.toFixed(2)) };
    })
    .sort((a, b) => b.total - a.total);

  // PnL by day (last 60 days)
  const dayMap = {};
  for (const t of history) {
    if (!t.closedAt || t.pnlPct == null) continue;
    const day = t.closedAt.slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { pnl: 0, wins: 0, losses: 0 };
    dayMap[day].pnl  += t.pnlPct;
    if (t.hit === 'TP') dayMap[day].wins++;
    else if (t.hit === 'SL') dayMap[day].losses++;
  }
  const byDay = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-60)
    .map(([day, d]) => ({ day, pnl: parseFloat(d.pnl.toFixed(2)), wins: d.wins, losses: d.losses }));

  // Duration buckets
  const buckets = { '<1h': 0, '1–4h': 0, '4–12h': 0, '12–24h': 0, '>24h': 0 };
  for (const t of history) {
    if (!t.durationMs) continue;
    const h = t.durationMs / 3_600_000;
    if (h < 1)  buckets['<1h']++;
    else if (h < 4)  buckets['1–4h']++;
    else if (h < 12) buckets['4–12h']++;
    else if (h < 24) buckets['12–24h']++;
    else             buckets['>24h']++;
  }
  const duration = Object.entries(buckets).map(([label, count]) => ({ label, count }));

  return { bySymbol, byDay, duration };
}

// ─── Market data (external fetch, cached 30s) ────────────────────────────────
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
      return { price: +d.lastPrice, change: +d.priceChangePercent,
               high: +d.highPrice, low: +d.lowPrice, volume: +d.quoteVolume };
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

// ─── Live P&L for active trades ──────────────────────────────────────────────
async function apiLivePnl() {
  return cached('live-pnl', 12_000, async () => {
    const HDR = { 'User-Agent': 'crypto-news-bot/1.0' };
    const trades = readJson('trades.json', []).filter(t => t.status === 'active');
    if (!trades.length) return [];

    const symbols = [...new Set(trades.map(t => t.symbol))];
    const prices  = {};
    try {
      const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 5000, headers: HDR });
      for (const item of Array.isArray(data) ? data : []) {
        const sym = item.symbol?.replace(/USDT$/, '');
        if (sym && symbols.includes(sym)) prices[sym] = parseFloat(item.markPrice);
      }
    } catch {}

    return trades.map(t => {
      const curr = prices[t.symbol];
      const entry = t.entryPrice;
      if (!curr || !entry) return { id: t.id, symbol: t.symbol, currentPrice: curr ?? null, unrealizedPct: null, progress: null };
      const dir   = t.direction === 'LONG' ? 1 : -1;
      const rawPct = (curr - entry) / entry * 100 * dir;
      const tpPct  = t.targetPct ?? 0;
      const slPct  = t.slPct ?? 0;
      const range  = tpPct + slPct;
      const progress = range > 0 ? Math.max(0, Math.min(100, (rawPct + slPct) / range * 100)) : 50;
      return { id: t.id, symbol: t.symbol, currentPrice: curr,
               unrealizedPct: parseFloat(rawPct.toFixed(3)),
               progress: parseFloat(progress.toFixed(1)), tpPct, slPct };
    });
  });
}

// ─── PP369 context — nến H1 đầu tiên của tháng (00:00 UTC ngày 1) ────────────
async function apiPp369Context() {
  // Cache 1 giờ — open/close H1 đầu tháng không đổi trong tháng
  return cached('pp369-ctx', 60 * 60_000, async () => {
    const HDR = { 'User-Agent': 'crypto-news-bot/1.0' };

    // Timestamp 00:00 UTC ngày 1 của tháng hiện tại
    const now = new Date();
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);

    // Ưu tiên đọc danh sách coin đang được theo dõi từ file (ghi bởi job.js)
    // Fallback: lấy từ signal log (chỉ coin đã từng bắn tín hiệu)
    let symbols = [];
    try {
      const symFile = path.join(DATA_DIR, 'pp369_symbols.json');
      if (fs.existsSync(symFile)) {
        const { symbols: s } = JSON.parse(fs.readFileSync(symFile, 'utf8'));
        symbols = Array.isArray(s) ? s : [];
      }
    } catch {}
    if (!symbols.length) {
      try {
        const sigFile = path.join(DATA_DIR, '369_signals.jsonl');
        if (fs.existsSync(sigFile)) {
          const lines = fs.readFileSync(sigFile, 'utf8').split('\n').filter(Boolean);
          symbols = [...new Set(lines.map(l => JSON.parse(l).symbol))];
        }
      } catch {}
    }
    if (!symbols.length) return {};

    const ctx = {};
    await Promise.allSettled(symbols.map(async sym => {
      try {
        // Lấy đúng nến H1 tại 00:00 UTC ngày 1 tháng
        const { data } = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
          params: { symbol: `${sym}USDT`, interval: '1h', startTime: monthStartMs, limit: 1 },
          timeout: 4000, headers: HDR,
        });
        if (Array.isArray(data) && data.length) {
          const c = data[0];
          ctx[sym] = {
            h1Open:  parseFloat(c[1]),  // Open  nến H1 đầu tháng → mốc gốc PP369
            h1Close: parseFloat(c[4]),  // Close nến H1 đầu tháng → mốc gốc PP369
            h1High:  parseFloat(c[2]),
            h1Low:   parseFloat(c[3]),
            candleTime: new Date(c[0]).toISOString(),
          };
        }
      } catch {}
    }));
    return ctx;
  });
}

// ─── Funding ─────────────────────────────────────────────────────────────────
function apiFundingStats()   { return readJson('funding_stats.json', {}); }
function apiFundingTrades()  { return readJson('funding_trades.json', []).filter(t => t.status === 'active'); }
function apiFundingHistory() { return readJson('funding_history.json', []).slice().reverse(); }

// ─── Update active trade TP/SL (called from dashboard UI) ────────────────────
function apiUpdateTrade(url) {
  const p = new URLSearchParams(url.split('?')[1] || '');
  const id = p.get('id');
  if (!id) return { ok: false, error: 'Missing id' };

  const fields = {};
  for (const key of ['targetPrice', 'slPrice', 'tp1Price', 'tp2Price']) {
    if (p.has(key)) {
      const raw = p.get(key).trim();
      fields[key] = raw === '' ? null : parseFloat(raw) || null;
    }
  }

  const mod = tm();
  if (!mod?.updateActiveTrade) return { ok: false, error: 'Trade monitor not available' };
  const result = mod.updateActiveTrade(id, fields);
  return result ?? { ok: false, error: 'Trade not found' };
}

// ─── Sync manual positions (POST /api/sync) ──────────────────────────────────
async function apiSync(req) {
  let _log;
  try { _log = require('../services/logger').log; } catch {}
  const logTrade = (msg, data) => _log ? _log.trade(msg, data) : console.log('[TRADE]', msg, data ?? '');
  const logWarn  = (msg, data) => _log ? _log.warn(msg, data)  : console.warn('[WARN]',  msg, data ?? '');
  const logError = (msg, data) => _log ? _log.error(msg, data) : console.error('[ERROR]', msg, data ?? '');

  const ip = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const mod = tm();
  if (!mod?.syncManualPositions) {
    logWarn('POST /api/sync: tradeMonitor chưa sẵn sàng', { ip });
    return { ok: false, error: 'tradeMonitor not available', ts: new Date().toISOString() };
  }

  const t0 = Date.now();
  logTrade('POST /api/sync: bắt đầu đồng bộ vị thế thủ công', { trigger: 'api', ip });
  try {
    await mod.syncManualPositions('api');
    const ms = Date.now() - t0;
    logTrade('POST /api/sync: hoàn thành', { trigger: 'api', ip, durationMs: ms });
    return { ok: true, triggeredBy: 'api', ip, durationMs: ms, ts: new Date().toISOString() };
  } catch (e) {
    const ms = Date.now() - t0;
    logError('POST /api/sync: thất bại', { trigger: 'api', ip, error: e.message, durationMs: ms });
    return { ok: false, error: e.message, durationMs: ms, ts: new Date().toISOString() };
  }
}

// ─── Signals ─────────────────────────────────────────────────────────────────
function apiSignals() {
  try {
    const file = path.join(DATA_DIR, '369_signals.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}

// ─── Logs ────────────────────────────────────────────────────────────────────
function apiLogs(url) {
  const p      = new URLSearchParams(url.split('?')[1] || '');
  const date   = p.get('date') || todayStr();
  const filter = p.get('filter') || '';
  const n      = Math.min(parseInt(p.get('lines') || '300', 10), 1000);

  const file = path.join(LOGS_DIR, `bot-${date}.log`);
  if (!fs.existsSync(file)) return { date, lines: [] };

  const cats = filter ? filter.toUpperCase().split(',').map(s => s.trim()) : [];
  const raw  = readTail(file, 2 * 1024 * 1024);
  const all  = raw.split('\n').filter(Boolean);

  const filtered = cats.length > 0
    ? all.filter(l => cats.some(c => l.includes(`[${c}`)))
    : all;

  const lines = filtered.slice(-n).map(line => {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] \[(\w+)\s*\] (.+)$/);
    if (!m) return { raw: line };
    const [, time, cat, rest] = m;
    const pi = rest.lastIndexOf(' | {');
    const message = pi >= 0 ? rest.slice(0, pi) : rest;
    let data = null;
    if (pi >= 0) { try { data = JSON.parse(rest.slice(pi + 3)); } catch {} }
    return { time, cat: cat.trim(), message, data };
  });

  return { date, lines };
}

function apiLogDates() {
  try {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs.readdirSync(LOGS_DIR)
      .filter(f => f.match(/^bot-\d{4}-\d{2}-\d{2}\.log$/))
      .map(f => f.replace('bot-', '').replace('.log', ''))
      .sort().reverse();
  } catch { return []; }
}

function apiWatchedCoins() {
  const data = readJson('pp369_symbols.json', null);
  if (!data) {
    const fixed = process.env.FIXED_COINS
      ? process.env.FIXED_COINS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA'];
    return { symbols: fixed, fixed, tier2: [], liquid: [], gainers: [], updatedAt: null, source: 'env' };
  }
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  const fixed   = Array.isArray(data.fixed)   ? data.fixed   : [];
  const tier2   = Array.isArray(data.tier2)   ? data.tier2   : [];
  const liquid  = Array.isArray(data.liquid)  ? data.liquid  : [];
  const gainers = Array.isArray(data.gainers) ? data.gainers : [];
  // Nếu breakdown rỗng nhưng symbols có data → đổ tất cả vào fixed
  const resolvedFixed = (!fixed.length && !tier2.length && !liquid.length && !gainers.length && symbols.length)
    ? symbols : fixed;
  return { ...data, symbols, fixed: resolvedFixed, tier2, liquid, gainers };
}

function apiHealth() {
  const today   = todayStr();
  const logFile = path.join(LOGS_DIR, `bot-${today}.log`);
  let lastLog = null, errorCount = 0, tradeCount = 0, aiCount = 0, warnCount = 0;
  if (fs.existsSync(logFile)) {
    const raw   = readTail(logFile, 512 * 1024);
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length) {
      const m = lines[lines.length - 1].match(/^\[(\d{2}:\d{2}:\d{2})\]/);
      if (m) lastLog = `${today}T${m[1]}`;
    }
    for (const l of lines) {
      if (l.includes('[ERROR'))   errorCount++;
      if (l.includes('[TRADE'))   tradeCount++;
      if (l.includes('[AI   '))   aiCount++;
      if (l.includes('[WARN '))   warnCount++;
    }
  }
  return {
    lastLog, errorCount, tradeCount, aiCount, warnCount, today,
    activeTrades:  readJson('trades.json', []).filter(t => t.status === 'active').length,
    fundingActive: readJson('funding_trades.json', []).filter(t => t.status === 'active').length,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
const ROUTES = {
  '/api/stats':           () => apiStats(),
  '/api/trades':          () => apiTrades(),
  '/api/history':         () => apiHistory(),
  '/api/chart':           () => apiChart(),
  '/api/analytics':       () => apiAnalytics(),
  '/api/market':          () => apiMarket(),
  '/api/live-pnl':        () => apiLivePnl(),
  '/api/pp369-context':   () => apiPp369Context(),
  '/api/funding/stats':   () => apiFundingStats(),
  '/api/funding/trades':  () => apiFundingTrades(),
  '/api/funding/history': () => apiFundingHistory(),
  '/api/signals':         () => apiSignals(),
  '/api/watched-coins':   () => apiWatchedCoins(),
  '/api/health':          () => apiHealth(),
  '/api/log-dates':       () => apiLogDates(),
};

function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];

  // ── POST endpoints ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (urlPath === '/api/sync') {
      Promise.resolve().then(() => apiSync(req)).then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      }).catch(e => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
      return true;
    }
    return false;
  }

  // ── GET endpoints ───────────────────────────────────────────────────────────
  let handler = ROUTES[urlPath];
  if (!handler && urlPath === '/api/logs') handler = () => apiLogs(req.url);
  if (!handler && urlPath === '/api/trades/update') handler = () => apiUpdateTrade(req.url);
  if (!handler) return false;

  Promise.resolve().then(() => handler()).then(data => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }).catch(e => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });
  return true;
}

// ─── Server ───────────────────────────────────────────────────────────────────
function createServer(port) {
  port = port || parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      if (!handleApi(req, res)) { res.writeHead(404); res.end('Not found'); }
      return;
    }
    if (req.url === '/favicon.jpg' || req.url === '/favicon.ico') {
      const faviconPath = path.join(__dirname, 'favicon.jpg');
      try {
        const img = fs.readFileSync(faviconPath);
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(img);
      } catch { res.writeHead(404); res.end('Not found'); }
      return;
    }
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(500); res.end('Dashboard HTML not found'); }
  });
  server.listen(port, () => {
    try { require('../services/logger').log.system(`Dashboard running at http://localhost:${port}`); }
    catch { console.log(`Dashboard running at http://localhost:${port}`); }
  });

  // WebSocket server — dùng chung port với HTTP
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    _wsClients.add(ws);
    // Gửi trạng thái lệnh hiện tại ngay khi kết nối
    try {
      const tmMod = tm();
      if (tmMod?.getActiveTrades) {
        ws.send(JSON.stringify({ type: 'trades', data: tmMod.getActiveTrades() }));
      }
    } catch {}
    ws.on('close', () => _wsClients.delete(ws));
    ws.on('error', () => _wsClients.delete(ws));
  });

  // Ping định kỳ để giữ kết nối qua proxy/nginx
  setInterval(() => broadcastWs('ping', null), 25_000);

  return server;
}

module.exports = { createServer, broadcastWs };
