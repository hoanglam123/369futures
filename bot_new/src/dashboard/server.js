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

// Lazy-load tradeMonitor & binanceTrader để tránh circular require
let _tm = null;
function tm() { if (!_tm) { try { _tm = require('../services/tradeMonitor'); } catch {} } return _tm; }
let _bt = null;
function bt() { if (!_bt) { try { _bt = require('../services/binanceTrader'); } catch {} } return _bt; }
let _rl = null;
function isRateLimited() {
  if (!_rl) { try { _rl = require('../services/rateLimitGuard'); } catch {} }
  return _rl && typeof _rl.isIpBanned === 'function' ? _rl.isIpBanned() : false;
}

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

async function apiAccount() {
  return cached('account', 20_000, async () => {
    if (isRateLimited()) return { connected: false, error: 'Đang tạm dừng do IP rate limit' };
    const trader = bt();
    if (!trader || typeof trader.getAccountSummary !== 'function') {
      return { connected: false, error: 'Binance trader không khả dụng' };
    }
    return await trader.getAccountSummary();
  });
}

async function apiTrades() {
  return cached('live-trades', 15_000, async () => {
    const localTrades = readJson('trades.json', []);
    const result = localTrades.map(t => ({ ...t }));
    const activeBySym = new Map();
    for (const t of result) {
      if (t.status === 'active' && t.symbol) activeBySym.set(t.symbol, t);
    }

    // Kéo trực tiếp vị thế ĐÃ KHỚP + lệnh LIMIT CHỜ KHỚP từ tài khoản Binance của bot-new
    const trader = bt();
    if (trader && typeof trader.getAllPositions === 'function' && trader.isEnabled() && !isRateLimited() && process.env.NODE_ENV !== 'test') {
      try {
        const [livePos, openOrders] = await Promise.all([
          trader.getAllPositions().catch(() => []),
          typeof trader.getOpenOrders === 'function' ? trader.getOpenOrders().catch(() => []) : Promise.resolve([]),
        ]);
        for (const p of (livePos || [])) {
          const amt = parseFloat(p.positionAmt || '0');
          if (!amt) continue;
          const sym = String(p.symbol || '').replace(/USDT$/i, '');
          const isLong = amt > 0;
          const entryPrice = parseFloat(p.entryPrice || '0');
          const markPrice = parseFloat(p.markPrice || '0') || entryPrice;
          const leverage = parseFloat(p.leverage || '10') || 10;
          const unrealizedPnlUsd = parseFloat(p.unRealizedProfit || '0');
          const existing = activeBySym.get(sym);
          if (existing) {
            if (entryPrice > 0) existing.entryPrice = entryPrice;
            existing.currentPrice = markPrice;
            existing.leverage = leverage;
            existing.entryFilled = true;
            existing.isPendingLimit = false;
            existing.unrealizedPnlUsd = parseFloat(unrealizedPnlUsd.toFixed(2));
          } else {
            const newTrade = {
              id: `binance_${sym}`,
              symbol: sym,
              direction: isLong ? 'LONG' : 'SHORT',
              entryPrice,
              currentPrice: markPrice,
              targetPrice: null,
              slPrice: null,
              leverage,
              entryFilled: true,
              isPendingLimit: false,
              manualEntry: true,
              unrealizedPnlUsd: parseFloat(unrealizedPnlUsd.toFixed(2)),
              recommendedAt: new Date().toISOString(),
              status: 'active',
              source: 'binance-real',
            };
            result.push(newTrade);
            activeBySym.set(sym, newTrade);
          }
        }

        // Bổ sung các lệnh LIMIT Entry đang CHỜ KHỚP trên sàn Binance (reduceOnly=false)
        const levMap = typeof trader.getSymbolLeverageMap === 'function' ? trader.getSymbolLeverageMap() : {};
        for (const o of (openOrders || [])) {
          const isEntryLimit = o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
          if (!isEntryLimit) continue;
          const sym = String(o.symbol || '').replace(/USDT$/i, '');
          if (!sym || activeBySym.has(sym)) continue;
          const isLong = o.side === 'BUY';
          const entryPrice = parseFloat(o.price || '0');
          const newPending = {
            id: `open_${sym}_${o.orderId}`,
            binanceEntryOrderId: String(o.orderId || ''),
            symbol: sym,
            direction: isLong ? 'LONG' : 'SHORT',
            entryPrice,
            currentPrice: entryPrice,
            targetPrice: null,
            slPrice: null,
            leverage: levMap[sym] || null,
            entryFilled: false,
            isPendingLimit: true,
            manualEntry: true,
            unrealizedPnlUsd: 0,
            recommendedAt: o.time ? new Date(o.time).toISOString() : new Date().toISOString(),
            status: 'active',
            source: 'binance-open-order',
          };
          result.push(newPending);
          activeBySym.set(sym, newPending);
        }
      } catch {}
    }

    return result;
  });
}

async function apiHistory() {
  return cached('real-history', 30_000, async () => {
    const local = readJson('trade_history.json', []).slice().reverse().map(t => ({ ...t }));
    const trader = bt();
    if (trader && typeof trader.getRealizedIncome === 'function' && trader.isEnabled() && !isRateLimited() && process.env.NODE_ENV !== 'test') {
      try {
        const incomeRows = await trader.getRealizedIncome(100);
        const grouped = [];
        const sorted = [...incomeRows].sort((a, b) => (a.time || 0) - (b.time || 0));
        for (const r of sorted) {
          const sym = String(r.symbol || '').replace(/USDT$/i, '');
          const inc = parseFloat(r.income || '0');
          const t = Number(r.time || 0);
          if (!sym || !t || !isFinite(inc) || inc === 0) continue;
          const prev = grouped[grouped.length - 1];
          if (prev && prev.symbol === sym && Math.abs(t - prev.time) <= 5000) {
            prev.income += inc;
            prev.time = t;
          } else {
            grouped.push({ symbol: sym, income: inc, time: t });
          }
        }
        for (const g of grouped) {
          const dup = local.some(x => x.symbol === g.symbol && x.closedAt && Math.abs(new Date(x.closedAt).getTime() - g.time) <= 120_000);
          if (dup) continue;
          const pnlUsd = parseFloat(g.income.toFixed(2));
          const isWin = pnlUsd > 0;
          local.push({
            symbol: g.symbol,
            direction: 'BINANCE',
            entryPrice: null,
            closePrice: null,
            pnlPct: null,
            pnlUsd,
            closedAt: new Date(g.time).toISOString(),
            exitReason: isWin ? 'tp' : 'sl',
            hit: isWin ? 'TP' : 'SL',
            result: isWin ? 'win' : 'loss',
            durationMs: 0,
            leverage: null,
            source: 'binance-income',
          });
        }
        local.sort((a, b) => new Date(b.closedAt || 0) - new Date(a.closedAt || 0));
      } catch {}
    }
    return local.slice(0, 300);
  });
}

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
    const allTrades = await apiTrades();
    const trades = allTrades.filter(t => t.status === 'active');

    let shadowList = [];
    try {
      const shMod = require('../services/shadowTracker');
      shadowList = Object.values(shMod.getActiveShadowPositions() || {});
    } catch {}

    if (!trades.length && !shadowList.length) return [];

    const symbols = [...new Set([
      ...trades.map(t => t.symbol),
      ...shadowList.map(s => s.symbol),
    ].filter(Boolean))];
    const prices = {};
    try {
      const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 5000, headers: HDR });
      for (const item of Array.isArray(data) ? data : []) {
        const sym = item.symbol?.replace(/USDT$/, '');
        if (sym && symbols.includes(sym)) prices[sym] = parseFloat(item.markPrice);
      }
    } catch {}

    const realPnl = trades.map(t => {
      const curr = prices[t.symbol];
      const entry = t.entryPrice;
      if (t.entryFilled === false || t.isPendingLimit === true) {
        return { id: t.id, symbol: t.symbol, currentPrice: curr ?? entry ?? null, unrealizedPct: 0, progress: 0, isPendingLimit: true };
      }
      if (!curr || !entry) return { id: t.id, symbol: t.symbol, currentPrice: curr ?? null, unrealizedPct: null, progress: null };
      const dir = t.direction === 'LONG' ? 1 : -1;
      const rawPct = (curr - entry) / entry * 100 * dir;
      const tpPct = t.targetPct ?? (t.targetPrice ? Math.abs((t.targetPrice - entry) / entry) * 100 : 0);
      const slPct = t.slPct ?? (t.slPrice ? Math.abs((entry - t.slPrice) / entry) * 100 : 0);
      const range = tpPct + slPct;
      const progress = range > 0 ? Math.max(0, Math.min(100, (rawPct + slPct) / range * 100)) : 50;
      return { id: t.id, symbol: t.symbol, currentPrice: curr,
               unrealizedPct: parseFloat(rawPct.toFixed(3)),
               progress: parseFloat(progress.toFixed(1)), tpPct, slPct };
    });

    const shadowPnl = shadowList.map(s => {
      const sid = s.id || s.shadowId || s.symbol;
      const curr = prices[s.symbol];
      const entry = parseFloat(s.entryPrice || 0);
      const isPending = s.isFilled === false || s.status === 'PENDING_LIMIT';
      if (isPending) {
        return { id: sid, symbol: s.symbol, currentPrice: curr ?? entry ?? null, unrealizedPct: 0, progress: 0, isPendingLimit: true, isShadow: true };
      }
      if (!curr || !entry) return { id: sid, symbol: s.symbol, currentPrice: curr ?? null, unrealizedPct: null, progress: null, isShadow: true };
      const isLong = s.direction === 'LONG' || s.direction === 'BUY';
      const dir = isLong ? 1 : -1;
      const rawPct = (curr - entry) / entry * 100 * dir;
      const tpPrice = parseFloat(s.tpPrice || s.tierTpPrice || 0);
      const slPrice = parseFloat(s.slPrice || s.tierSlPrice || 0);
      const tpPct = tpPrice > 0 ? Math.abs((tpPrice - entry) / entry) * 100 : (s.tpPct || 0);
      const slPct = slPrice > 0 ? Math.abs((entry - slPrice) / entry) * 100 : (s.slPct || 0);
      const range = tpPct + slPct;
      const progress = range > 0 ? Math.max(0, Math.min(100, (rawPct + slPct) / range * 100)) : 50;
      return { id: sid, symbol: s.symbol, currentPrice: curr,
               unrealizedPct: parseFloat(rawPct.toFixed(3)),
               progress: parseFloat(progress.toFixed(1)), tpPct, slPct, isShadow: true };
    });

    return [...realPnl, ...shadowPnl];
  });
}

// ─── PP369 context — đọc trực tiếp từ h1RefCache (0 REST weight, chống IP Ban 418) ──
async function apiPp369Context() {
  return cached('pp369-ctx', 60_000, async () => {
    const ctx = {};
    try {
      const h1Ref = require('../services/h1RefCache');
      const cacheMap = typeof h1Ref.getH1RefCache === 'function' ? h1Ref.getH1RefCache() : (h1Ref.loadH1RefCache ? h1Ref.loadH1RefCache() : {});
      if (cacheMap && typeof cacheMap === 'object') {
        for (const [sym, item] of Object.entries(cacheMap)) {
          if (!item || typeof item.openPrice !== 'number') continue;
          ctx[sym] = {
            h1Open:  item.openPrice,
            h1Close: item.closePrice ?? item.openPrice,
            h1High:  item.highPrice ?? item.upperPrice ?? item.openPrice,
            h1Low:   item.lowPrice ?? item.lowerPrice ?? item.openPrice,
            candleTime: item.monthStart ? new Date(item.monthStart).toISOString() : null,
          };
        }
      }
    } catch {}
    // Fallback nhẹ: đọc trực tiếp file h1_ref_cache.json trên đĩa nếu RAM cache chưa khởi tạo
    if (Object.keys(ctx).length === 0) {
      const candidates = [
        path.join(DATA_DIR, 'h1_ref_cache.json'),
        path.resolve(DATA_DIR, '..', '..', 'data', 'h1_ref_cache.json'),
      ];
      for (const f of candidates) {
        try {
          if (!fs.existsSync(f)) continue;
          const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
          const items = raw?.items || raw || {};
          for (const [sym, item] of Object.entries(items)) {
            if (!item || typeof item.openPrice !== 'number') continue;
            ctx[sym] = {
              h1Open:  item.openPrice,
              h1Close: item.closePrice ?? item.openPrice,
              h1High:  item.highPrice ?? item.upperPrice ?? item.openPrice,
              h1Low:   item.lowPrice ?? item.lowerPrice ?? item.openPrice,
              candleTime: raw?.monthStart ? new Date(raw.monthStart).toISOString() : null,
            };
          }
          if (Object.keys(ctx).length > 0) break;
        } catch {}
      }
    }
    return ctx;
  });
}

// ─── Funding ─────────────────────────────────────────────────────────────────
function apiFundingStats()   { return readJson('funding_stats.json', {}); }
function apiFundingTrades()  { return readJson('funding_trades.json', []).filter(t => t.status === 'active'); }
function apiFundingHistory() { return readJson('funding_history.json', []).slice().reverse(); }

// ─── Update active trade TP/SL (called from dashboard UI via POST) ───────────
function apiUpdateTrade(url, body = null) {
  const p = new URLSearchParams((url || '').split('?')[1] || '');
  const id = body?.id || p.get('id');
  if (!id) return { ok: false, error: 'Missing id' };

  const fields = {};
  for (const key of ['targetPrice', 'slPrice', 'tp1Price', 'tp2Price']) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      const raw = body[key];
      fields[key] = (raw === '' || raw == null) ? null : (parseFloat(raw) || null);
    } else if (p.has(key)) {
      const raw = p.get(key).trim();
      fields[key] = raw === '' ? null : parseFloat(raw) || null;
    }
  }

  const mod = tm();
  if (!mod?.updateActiveTrade) return { ok: false, error: 'Trade monitor not available' };
  const result = mod.updateActiveTrade(id, fields);
  return result ?? { ok: false, error: 'Trade not found' };
}

// ─── Delete active trade (called from dashboard UI) ──────────────────────────
async function apiDeleteTrade(url, body = null) {
  const p = new URLSearchParams(url.split('?')[1] || '');
  const id = body?.id || p.get('id');
  if (!id) return { ok: false, error: 'Missing id' };

  const mod = tm();
  if (!mod?.removeActiveTrade) return { ok: false, error: 'Trade monitor not available' };
  return await mod.removeActiveTrade(id);
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

// ─── Logs (Chống Path Traversal & NaN slice) ─────────────────────────────────
function apiLogs(url) {
  const p      = new URLSearchParams((url || '').split('?')[1] || '');
  const rawDate = String(p.get('date') || todayStr()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return { date: rawDate, lines: [], error: 'Invalid date format (expected YYYY-MM-DD)' };
  }
  const date   = rawDate;
  const filter = p.get('filter') || '';
  const parsedN = parseInt(p.get('lines') || '300', 10);
  const n      = Math.max(1, Math.min(Number.isFinite(parsedN) ? parsedN : 300, 1000));

  const logsRoot = path.resolve(LOGS_DIR);
  const file = path.resolve(logsRoot, `bot-${date}.log`);
  if (!file.startsWith(logsRoot + path.sep)) {
    return { date, lines: [], error: 'Forbidden path' };
  }
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

async function apiHealth() {
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
  let activeCount = readJson('trades.json', []).filter(t => t.status === 'active').length;
  try {
    const liveList = await apiTrades();
    activeCount = liveList.filter(t => t.status === 'active').length;
  } catch {}
  let shadowCount = 0;
  try {
    const shMod = require('../services/shadowTracker');
    shadowCount = Object.keys(shMod.getActiveShadowPositions() || {}).length;
  } catch {}
  return {
    lastLog, errorCount, tradeCount, aiCount, warnCount, today,
    activeTrades:  activeCount,
    shadowTrades:  shadowCount,
    fundingActive: readJson('funding_trades.json', []).filter(t => t.status === 'active').length,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
const ROUTES = {
  '/api/account':         () => apiAccount(),
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
  '/api/circuit-breaker':    () => { try { return require('../services/directionalCircuitBreaker').getDirectionalStatus(); } catch (e) { return { error: e.message }; } },
  '/api/btc-flash-guard':    () => { try { const g = require('../services/btcFlashGuard'); return { ...g.checkBtcFlashStatus(), velocityPct: g.getBtcVelocity() }; } catch (e) { return { error: e.message }; } },
  '/api/cooldowns':          () => { try { return require('../services/cooldownManager').getAllCooldowns(); } catch (e) { return { error: e.message }; } },
  '/api/shadow-trades':      () => { try { const s = require('../services/shadowTracker'); return { active: s.getActiveShadowPositions(), stats: s.getShadowStats() }; } catch (e) { return { error: e.message }; } },
  '/api/proximity-heatmap':  () => {
    try {
      const { getPrices, getLevelCache } = require('../pp369');
      const prices = getPrices() || {};
      const cache  = getLevelCache() || {};
      const rows = [];
      for (const [sym, lvl] of Object.entries(cache)) {
        const p = prices[sym];
        if (!p || !lvl?.longEntry || !lvl?.shortEntry) continue;
        const distLong  = Math.abs(p - lvl.longEntry) / p * 100;
        const distShort = Math.abs(lvl.shortEntry - p) / p * 100;
        const nearestSide = distLong <= distShort ? 'LONG' : 'SHORT';
        const distPct = Math.min(distLong, distShort);
        const stepPct = lvl.step ? (lvl.step / p * 100) : null;
        rows.push({
          symbol: sym,
          price: p,
          longEntry: lvl.longEntry,
          shortEntry: lvl.shortEntry,
          nearestSide,
          distPct: parseFloat(distPct.toFixed(3)),
          stepPct: stepPct != null ? parseFloat(stepPct.toFixed(2)) : null,
        });
      }
      rows.sort((a, b) => a.distPct - b.distPct);
      return { totalTracked: Object.keys(cache).length, totalPriced: rows.length, items: rows.slice(0, 48) };
    } catch (e) {
      return { totalTracked: 0, totalPriced: 0, items: [], error: e.message };
    }
  },
  '/api/bot-controls':       () => {
    try {
      const job = require('../job');
      return {
        scanPaused: typeof job.isScanPaused === 'function' ? job.isScanPaused() : false,
        shadowOnlyMode: typeof job.isShadowOnlyMode === 'function' ? job.isShadowOnlyMode() : false,
        fractalTrailingEnabled: process.env.ENABLE_FRACTAL_TRAILING !== 'false',
        aiGatekeeperMode: (process.env.AI_GATEKEEPER_MODE || 'LOCAL').toUpperCase(),
      };
    } catch (e) {
      return { scanPaused: false, shadowOnlyMode: false, error: e.message };
    }
  },
};

const MAX_BODY_BYTES = 64 * 1024; // Giới hạn 64 KB chống DoS tràn RAM

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let totalBytes = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => { if (!aborted) resolve({}); });
  });
}

function _getCorsHeaders(req) {
  const headers = { 'Content-Type': 'application/json' };
  const allowedOrigin = (process.env.DASHBOARD_CORS_ORIGIN || '').trim();
  const reqOrigin = req?.headers?.origin;
  if (allowedOrigin && reqOrigin && reqOrigin === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function _isAuthorized(req) {
  const token = (process.env.DASHBOARD_AUTH_TOKEN || '').trim();
  if (!token) return true; // Cho phép truy cập nội bộ khi không cấu hình token (server mặc định chỉ bind 127.0.0.1)
  const auth = String(req?.headers?.authorization || '');
  if (auth === `Bearer ${token}`) return true;
  try {
    const p = new URLSearchParams((req?.url || '').split('?')[1] || '');
    if (p.get('token') === token) return true;
  } catch {}
  return false;
}

function _sendJson(req, res, statusCode, payload) {
  res.writeHead(statusCode, _getCorsHeaders(req));
  res.end(JSON.stringify(payload));
}

function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];

  if (!_isAuthorized(req)) {
    _sendJson(req, res, 401, { error: 'Unauthorized' });
    return true;
  }

  // ── POST endpoints ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const handlePostErr = (e) => _sendJson(req, res, e?.statusCode || 500, { error: e.message });

    if (urlPath === '/api/sync') {
      Promise.resolve().then(() => apiSync(req)).then(data => _sendJson(req, res, 200, data)).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/circuit-breaker/unlock') {
      readBodyJson(req).then(body => {
        const { clearDirectionLock } = require('../services/directionalCircuitBreaker');
        clearDirectionLock(body.side || 'LONG');
        _sendJson(req, res, 200, { ok: true, unlocked: body.side || 'LONG' });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/circuit-breaker/clear-cooldown') {
      readBodyJson(req).then(body => {
        const { clearSymbolCooldown } = require('../services/cooldownManager');
        if (body.symbol) clearSymbolCooldown(body.symbol);
        _sendJson(req, res, 200, { ok: true, cleared: body.symbol });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/btc-flash-guard/reset') {
      try {
        require('../services/btcFlashGuard').resetFlashGuard();
        _sendJson(req, res, 200, { ok: true });
      } catch (e) { handlePostErr(e); }
      return true;
    }

    if (urlPath === '/api/bot-controls') {
      readBodyJson(req).then(body => {
        const job = require('../job');
        if (typeof body.scanPaused === 'boolean' && typeof job.setScanPaused === 'function') {
          job.setScanPaused(body.scanPaused);
        }
        if (typeof body.shadowOnlyMode === 'boolean' && typeof job.setShadowOnlyMode === 'function') {
          job.setShadowOnlyMode(body.shadowOnlyMode);
        }
        _sendJson(req, res, 200, {
          ok: true,
          scanPaused: typeof job.isScanPaused === 'function' ? job.isScanPaused() : false,
          shadowOnlyMode: typeof job.isShadowOnlyMode === 'function' ? job.isShadowOnlyMode() : false,
        });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/emergency/close-all') {
      Promise.resolve().then(async () => {
        const mod = tm();
        const active = mod?.getActiveTrades ? mod.getActiveTrades() : [];
        let closedCount = 0;
        const errors = [];
        try {
          const binanceTrader = require('../services/binanceTrader');
          const bracketManager = require('../services/bracketManager');
          for (const t of active) {
            if (!binanceTrader.isEnabled()) continue;
            try {
              if (t.entryFilled === false && t.binanceEntryOrderId) {
                await binanceTrader.cancelOrderById(t.symbol, t.binanceEntryOrderId);
              } else if (t.binanceQty) {
                await binanceTrader.placeMarketClose(t);
              }
              await bracketManager.autoCleanOppositeOrder({ client: binanceTrader, sym: t.symbol, filledType: 'MANUAL', meta: t }).catch(() => {});
              if (typeof mod.removeActiveTrade === 'function') {
                mod.removeActiveTrade(t.id, { exitReason: 'emergency_close' });
              }
              closedCount++;
            } catch (eTrade) {
              errors.push(`${t.symbol}: ${eTrade.message}`);
            }
          }
        } catch (eOuter) {
          errors.push(eOuter.message);
        }
        _sendJson(req, res, 200, { ok: true, closedCount, total: active.length, errors });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/trades/cancel-limit') {
      readBodyJson(req).then(async (body) => {
        const sym = String(body?.symbol || '').toUpperCase().replace(/USDT$/i, '').replace(/[^A-Z0-9]/g, '');
        const orderId = body?.orderId != null && String(body.orderId).trim() !== '' ? String(body.orderId).trim() : null;
        if (!sym) return _sendJson(req, res, 400, { ok: false, error: 'Thiếu symbol' });

        const trader = bt();
        const mod = tm();
        const canceledOrderIds = [];

        if (trader && trader.isEnabled()) {
          const openOrders = await trader.getOpenOrders(sym).catch(() => []);
          const targets = (Array.isArray(openOrders) ? openOrders : []).filter(o => {
            const isEntryLimit = o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
            if (!isEntryLimit) return false;
            return orderId ? String(o.orderId) === orderId : true;
          });
          for (const o of targets) {
            await trader.cancelOrderById(sym, o.orderId);
            canceledOrderIds.push(String(o.orderId));
          }
          if (canceledOrderIds.length === 0 && orderId) {
            await trader.cancelOrderById(sym, orderId);
            canceledOrderIds.push(orderId);
          }
        }

        // Gỡ khỏi tradeMonitor nếu lệnh chưa khớp thành vị thế
        if (mod && typeof mod.getActiveTrades === 'function' && typeof mod.removeActiveTrade === 'function') {
          const tracked = mod.getActiveTrades().find(t => t.symbol === sym && t.entryFilled === false);
          if (tracked) {
            await mod.removeActiveTrade(tracked.id).catch(() => {});
          }
        }

        _cache.delete('live-trades');
        _cache.delete('live-pnl');
        try { broadcastWs('trades', await apiTrades()); } catch {}
        _sendJson(req, res, 200, { ok: true, symbol: sym, canceledOrderIds });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/shadow-trades/promote') {
      readBodyJson(req).then(async (body) => {
        const shadowId = body?.shadowId || body?.id;
        if (!shadowId) return _sendJson(req, res, 400, { ok: false, error: 'Thiếu shadowId' });
        const shadowMod = require('../services/shadowTracker');
        const activeShadows = shadowMod.getActiveShadowPositions();
        const sh = activeShadows[shadowId];
        if (!sh) return _sendJson(req, res, 404, { ok: false, error: 'Không tìm thấy vị thế Shadow đang hoạt động' });

        const mod = tm();
        const trader = bt();
        if (!mod || typeof mod.addTrades !== 'function') {
          return _sendJson(req, res, 503, { ok: false, error: 'TradeMonitor không khả dụng' });
        }
        if (!trader || !trader.isEnabled()) {
          return _sendJson(req, res, 400, { ok: false, error: 'Binance trading chưa bật (kiểm tra TRADE_ENABLED và API Key trong bot_new/.env)' });
        }
        const existingLocal = (typeof mod.getActiveTrades === 'function' ? mod.getActiveTrades() : [])
          .find(t => t.symbol === sh.symbol && t.status === 'active');
        if (existingLocal) {
          return _sendJson(req, res, 400, { ok: false, error: `${sh.symbol} đã có lệnh đang theo dõi trên bot-new` });
        }
        try {
          const [livePos, openOrders] = await Promise.all([
            trader.getAllPositions().catch(() => []),
            trader.getOpenOrders(sh.symbol).catch(() => []),
          ]);
          if ((livePos || []).some(p => p.symbol === `${sh.symbol}USDT` && parseFloat(p.positionAmt || '0') !== 0)) {
            return _sendJson(req, res, 400, { ok: false, error: `${sh.symbol} đang có vị thế mở trên Binance` });
          }
          if (Array.isArray(openOrders) && openOrders.length > 0) {
            return _sendJson(req, res, 400, { ok: false, error: `${sh.symbol} đã có lệnh chờ mở trên Binance` });
          }
        } catch {}

        const isLong = sh.direction === 'LONG' || sh.direction === 'BUY';
        const entryPrice = parseFloat(sh.entryPrice);
        const tpPrice = parseFloat(sh.tpPrice || sh.tierTpPrice);
        const slPrice = parseFloat(sh.slPrice || sh.tierSlPrice);
        const slPct = sh.slPct || Math.abs((slPrice - entryPrice) / entryPrice) * 100;
        const tpPct = sh.tpPct || Math.abs((tpPrice - entryPrice) / entryPrice) * 100;
        const beTriggerPrice = sh.beTriggerPrice || (isLong ? entryPrice + (tpPrice - entryPrice) * 0.5 : entryPrice - (entryPrice - tpPrice) * 0.5);
        const beSlPrice = isLong ? entryPrice * 1.0014 : entryPrice * 0.9986;

        // Đồng bộ margin hiển thị theo đúng công thức .env của bot-new (tính % theo NAV/Wallet Balance, chặn trần theo Available)
        let envMargin = parseFloat(process.env.FLAT_TRADE_USDT || sh.margin || '10');
        try {
          const pct = parseFloat(process.env.TRADE_SIZE_PCT || '5');
          const minU = parseFloat(process.env.TRADE_MIN_USDT || '5');
          const maxU = parseFloat(process.env.TRADE_MAX_USDT || '200');
          const thresh = parseFloat(process.env.BALANCE_THRESHOLD || '0');
          const bInfo = typeof trader.getBalanceInfo === 'function'
            ? await trader.getBalanceInfo()
            : { walletBalance: await trader.getUsdtBalance(), availableBalance: await trader.getUsdtBalance() };
          const navBal = bInfo.walletBalance > 0 ? bInfo.walletBalance : bInfo.availableBalance;
          if (navBal > thresh && pct > 0) {
            envMargin = parseFloat(Math.min(Math.max((navBal * pct) / 100, minU), maxU, bInfo.availableBalance).toFixed(2));
          }
        } catch {}

        const trade = {
          id: `${sh.symbol}_${sh.direction}_${Date.now()}_shadow`,
          symbol: sh.symbol,
          direction: sh.direction,
          entryPrice,
          targetPrice: tpPrice,
          targetPct: parseFloat(tpPct.toFixed(2)),
          slPrice,
          slPct: parseFloat(slPct.toFixed(2)),
          beTriggerPrice,
          beSlPrice,
          leverage: sh.leverage || 3,
          margin: envMargin,
          confluenceScore: sh.confluenceScore || sh.score || 0,
          confidence: 80,
          rrRatio: slPct > 0 ? parseFloat((tpPct / slPct).toFixed(2)) : 1.5,
          entryFilled: false,
          status: 'active',
          recommendedAt: new Date(),
          reason: `MANUAL SHADOW PROMOTE | Score ${sh.confluenceScore || sh.score || 0}đ | SL -${slPct.toFixed(2)}% | TP +${tpPct.toFixed(2)}%`,
          source: 'manual_shadow_promote',
        };

        mod.addTrades([trade]);
        shadowMod.removeShadowPosition(shadowId);
        if (typeof shadowMod.removeShadowBySymbolDirection === 'function') {
          shadowMod.removeShadowBySymbolDirection(trade.symbol, trade.direction);
        }
        _cache.delete('live-trades');
        _sendJson(req, res, 200, {
          ok: true,
          symbol: trade.symbol,
          direction: trade.direction,
          entryPrice: trade.entryPrice,
          tpPrice: trade.targetPrice,
          slPrice: trade.slPrice,
          leverage: trade.leverage,
          margin: trade.margin,
        });
      }).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/trades/update') {
      readBodyJson(req).then(body => apiUpdateTrade(req.url, body)).then(data => _sendJson(req, res, 200, data)).catch(handlePostErr);
      return true;
    }

    if (urlPath === '/api/trades/delete') {
      readBodyJson(req).then(body => apiDeleteTrade(req.url, body)).then(data => _sendJson(req, res, 200, data)).catch(handlePostErr);
      return true;
    }

    return false;
  }

  // Từ chối các hành động ghi/xóa qua GET (chống CSRF)
  if (req.method === 'GET' && (urlPath === '/api/trades/update' || urlPath === '/api/trades/delete' || urlPath === '/api/shadow-trades/promote')) {
    _sendJson(req, res, 405, { error: 'Method Not Allowed — use POST' });
    return true;
  }

  // ── GET endpoints ───────────────────────────────────────────────────────────
  let handler = ROUTES[urlPath];
  if (!handler && urlPath === '/api/logs') handler = () => apiLogs(req.url);
  if (!handler) return false;

  Promise.resolve().then(() => handler()).then(data => {
    _sendJson(req, res, 200, data);
  }).catch(e => {
    _sendJson(req, res, 500, { error: e.message });
  });
  return true;
}

// ─── Server ───────────────────────────────────────────────────────────────────
function createServer(port) {
  port = port || parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  const host = (process.env.DASHBOARD_HOST || '127.0.0.1').trim();
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
  server.listen(port, host, () => {
    try { require('../services/logger').log.system(`Dashboard running at http://${host}:${port}`); }
    catch { console.log(`Dashboard running at http://${host}:${port}`); }
  });

  // WebSocket server — dùng chung port với HTTP (kiểm tra auth nếu DASHBOARD_AUTH_TOKEN được đặt)
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (!_isAuthorized(req)) {
      ws.close(1008, 'Unauthorized');
      return;
    }
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

module.exports = { createServer, broadcastWs, apiLogs, apiUpdateTrade, handleApi };
