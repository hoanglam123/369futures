'use strict';

/**
 * PP369 Futures Web Dashboard Server (Port 3369) — bot-h4 Dedicated
 *
 * Tính năng:
 *   1. Quản lý và hiển thị dữ liệu RIÊNG BIỆT của tài khoản Binance bot-h4:
 *      - /api/health: Trạng thái bot-h4, ram, lỗi, số vị thế thực tế đang mở, last log
 *      - /api/watched-coins: Danh sách coin theo dõi bot-h4 (từ step_sizes.json & market_cap_top.json)
 *      - /api/stats: Tổng quan hiệu suất bot-h4 (từ shadow_trades_history.jsonl)
 *      - /api/chart: Biểu đồ PnL lũy kế bot-h4
 *      - /api/analytics: Phân tích theo symbol, theo ngày, duration bot-h4
 *      - /api/market: Thị trường tổng quan (BTC, ETH, Fear & Greed, Funding rates Binance)
 *      - /api/trades: Vị thế thực tế trên sàn Binance của bot-h4 (kết hợp active_trades.json)
 *      - /api/live-pnl: PnL thời gian thực cho từng lệnh (array chuẩn)
 *      - /api/history: Lịch sử lệnh đóng của bot-h4
 *      - /api/funding/*: Trả về trạng thái rỗng an toàn (bot-h4 không chạy funding arbitrage)
 *      - /api/signals: Lịch sử tín hiệu 369 của bot-h4 (369_signals.jsonl)
 *      - /api/pp369-context: Nến H1 đầu tháng của các coin có tín hiệu
 *      - /api/log-dates: Danh sách ngày có log của bot-h4 (từ logs/logs-h4/ và logs/)
 *      - /api/logs: Đọc và parse nhật ký PM2 của bot-h4
 *      - /api/trades/update: Cập nhật TP/SL lệnh trong active_trades.json của bot-h4
 *      - /api/sync & /api/forcesync: Override safety brake của bot-h4
 *      - /api/cooldown: Danh sách coin cooldown của bot-h4
 *   2. WebSocket Server push realtime (0ms delay) cho cả 'trades' và 'price'.
 *   3. Phục vụ giao diện Web Dashboard (index.html).
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

// Handler đẩy kèo Shadow -> Lệnh Limit thật & hủy lệnh Limit chờ khớp (được autoTrade.js đăng ký khi khởi động)
let _promoteShadowHandler = null;
function setPromoteShadowHandler(fn) {
  _promoteShadowHandler = typeof fn === 'function' ? fn : null;
}
let _cancelLimitHandler = null;
function setCancelLimitHandler(fn) {
  _cancelLimitHandler = typeof fn === 'function' ? fn : null;
}

function broadcastWs(type, data) {
  if (!_wsClients.size) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const client of _wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch {}
  }
}

// ─── Binance Client của bot-h4 ───────────────────────────────────────────────
let _binanceClient = null;
function getBinanceClient() {
  if (!_binanceClient) {
    const apiKey = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
    if (apiKey && secret) {
      try {
        const { createClient } = require('../trader/binance');
        _binanceClient = createClient(apiKey, secret);
      } catch (err) {
        log.warn(`[Dashboard] Không thể tạo Binance client bot-h4: ${err.message}`);
      }
    }
  }
  return _binanceClient;
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

// ─── Parser Nhật Ký bot-h4 ────────────────────────────────────────────────────

function parseLogLine(line, targetDate) {
  if (!line || !line.trim()) return null;

  // 1. Định dạng chuẩn PM2 của bot-h4: YYYY-MM-DD HH:mm:ss: [Tag1] [Tag2] message
  let m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}):\s*(.+)$/);
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

  // 2. Định dạng có ngoặc vuông: [HH:mm:ss] [CAT] msg
  m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[(\w+)\s*\]\s*(.+)$/);
  if (m) {
    const [, time, rawCat, rest] = m;
    const pi = rest.lastIndexOf(' | {');
    const message = pi >= 0 ? rest.slice(0, pi) : rest;
    let data = null;
    if (pi >= 0) { try { data = JSON.parse(rest.slice(pi + 3)); } catch {} }
    return { time, cat: rawCat.trim(), message, data, date: targetDate, raw: line };
  }

  return { time: '', cat: '', message: line, data: null, date: targetDate, raw: line };
}

function getLogsForDate(date, limit = 300, filter = '') {
  const isToday = (date === todayStr());
  const targetFiles = [];

  // Quét CHỈ thư mục log của bot-h4
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

  filtered.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  return { date, lines: filtered.slice(-limit) };
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

async function apiHealth() {
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

  const activeTradesList = await apiTrades();
  const shadowList = apiShadowTrades();

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

    today,
    lastLog,
    errorCount,
    tradeCount,
    aiCount,
    warnCount,
    activeTrades: activeTradesList.length,
    shadowTrades: shadowList.length,
    fundingActive: 0,
  };
}

async function apiTrades() {
  return cached('live-trades', 15_000, async () => {
    const trades = [];
    const symbolMap = new Map();

    // 1. Lấy vị thế ĐÃ KHỚP + lệnh LIMIT CHỜ KHỚP trực tiếp từ tài khoản Binance của bot-h4
    const client = getBinanceClient();
    if (client) {
      try {
        const [openPos, openOrders] = await Promise.all([
          client.getOpenPositions().catch(() => []),
          typeof client.getOpenOrders === 'function' ? client.getOpenOrders().catch(() => []) : Promise.resolve([]),
        ]);
        for (const p of (openPos || [])) {
          const amt = parseFloat(p.positionAmt);
          if (!amt) continue;
          const sym = p.symbol.replace('USDT', '');
          const isLong = amt > 0;
          const entryPrice = parseFloat(p.entryPrice) || 0;
          const markPrice = parseFloat(p.markPrice) || entryPrice;
          const leverage = parseFloat(p.leverage) || 10;
          const unrealizedPnlUsd = parseFloat(p.unRealizedProfit) || 0;
          const margin = parseFloat(p.isolatedMargin) || (Math.abs(amt) * entryPrice / leverage);
          const roiPct = margin > 0 ? (unrealizedPnlUsd / margin) * 100 : 0;

          const trade = {
            id: sym,
            symbol: sym,
            direction: isLong ? 'LONG' : 'SHORT',
            side: isLong ? 'BUY' : 'SELL',
            entryPrice,
            currentPrice: markPrice,
            targetPrice: null,
            tp1Price: null,
            tp2Price: null,
            tp1Hit: false,
            tp2Hit: false,
            slPrice: null,
            beTriggerPrice: null,
            isBreakeven: false,
            slMovedToBreakeven: false,
            leverage,
            margin: parseFloat(margin.toFixed(2)),
            unrealizedPnlUsd: parseFloat(unrealizedPnlUsd.toFixed(2)),
            roiPct: parseFloat(roiPct.toFixed(2)),
            score: 0,
            confluenceScore: null,
            entryFilled: true,
            tpOrderId: null,
            slOrderId: null,
            binanceTpOrderId: null,
            binanceSlOrderId: null,
            recommendedAt: new Date().toISOString(),
            status: 'active',
            source: 'binance-real',
          };
          symbolMap.set(sym, trade);
          trades.push(trade);
        }

        // Bổ sung các lệnh LIMIT Entry đang CHỜ KHỚP trên sàn Binance (reduceOnly=false)
        const levMap = (openOrders && openOrders.length > 0 && typeof client.getSymbolLeverageMap === 'function')
          ? await client.getSymbolLeverageMap().catch(() => ({}))
          : {};
        for (const o of (openOrders || [])) {
          const isEntryLimit = o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
          if (!isEntryLimit) continue;
          const sym = String(o.symbol || '').replace(/USDT$/i, '');
          if (!sym || symbolMap.has(sym)) continue;
          const isLong = o.side === 'BUY';
          const entryPrice = parseFloat(o.price) || 0;
          const qty = parseFloat(o.origQty) || 0;
          const binanceLev = levMap[sym] || null;
          const estMargin = (binanceLev && entryPrice > 0 && qty > 0)
            ? parseFloat(((qty * entryPrice) / binanceLev).toFixed(2))
            : null;
          const trade = {
            id: `open_${sym}_${o.orderId}`,
            orderId: o.orderId,
            symbol: sym,
            direction: isLong ? 'LONG' : 'SHORT',
            side: o.side,
            entryPrice,
            currentPrice: entryPrice,
            targetPrice: null,
            tp1Price: null,
            tp2Price: null,
            tp1Hit: false,
            tp2Hit: false,
            slPrice: null,
            beTriggerPrice: null,
            isBreakeven: false,
            slMovedToBreakeven: false,
            leverage: binanceLev,
            margin: estMargin,
            origQty: qty,
            unrealizedPnlUsd: 0,
            roiPct: 0,
            score: 0,
            confluenceScore: null,
            entryFilled: false,
            isPendingLimit: true,
            tpOrderId: null,
            slOrderId: null,
            binanceTpOrderId: null,
            binanceSlOrderId: null,
            recommendedAt: o.time ? new Date(o.time).toISOString() : new Date().toISOString(),
            status: 'active',
            source: 'binance-open-order',
          };
          symbolMap.set(sym, trade);
          trades.push(trade);
        }
      } catch (err) {
        log.warn(`[Dashboard] Lỗi lấy vị thế/lệnh chờ Binance cho bot-h4: ${err.message}`);
      }
    }

    // 2. Bổ sung / đồng bộ với active_trades.json của bot-h4
    const activeTrades = readJson('active_trades.json', {});
    for (const [sym, meta] of Object.entries(activeTrades)) {
      if (!meta || meta.isClosed) continue;
      const isLong = meta.side === 'BUY' || meta.side === 'LONG';
      const entryPrice = parseFloat(meta.entryPrice) || 0;
      const markPrice = parseFloat(meta.markPrice) || entryPrice;
      const leverage = parseFloat(meta.leverage) || 10;
      const margin = parseFloat(meta.margin) || 20;

      const existing = symbolMap.get(sym);
      if (existing) {
        existing.targetPrice = meta.tierTpPrice || meta.targetPrice || existing.targetPrice;
        existing.tp1Price = meta.tp1Price || existing.targetPrice;
        existing.tp2Price = meta.tp2Price || null;
        existing.tp1Hit = meta.tp1Hit || false;
        existing.tp2Hit = meta.tp2Hit || false;
        existing.slPrice = meta.currentSlPrice || meta.tierSlPrice || meta.slPrice || existing.slPrice;
        existing.beTriggerPrice = meta.beTriggerPrice || null;
        existing.isBreakeven = meta.isBreakeven || false;
        existing.slMovedToBreakeven = meta.isBreakeven || false;
        existing.leverage = existing.leverage || leverage;
        existing.margin = existing.margin || margin;
        existing.score = meta.score || existing.score;
        existing.confluenceScore = meta.confluenceScore || meta.score || null;
        existing.tpOrderId = meta.tpOrderId || null;
        existing.slOrderId = meta.slOrderId || null;
        existing.binanceTpOrderId = meta.tpOrderId || meta.binanceTpOrderId || null;
        existing.binanceSlOrderId = meta.slOrderId || meta.binanceSlOrderId || null;
        if (meta.time) existing.recommendedAt = new Date(meta.time).toISOString();
      } else {
        const roiPct = isLong
          ? ((markPrice - entryPrice) / entryPrice) * leverage * 100
          : ((entryPrice - markPrice) / entryPrice) * leverage * 100;
        const pnlUsd = (roiPct / 100) * margin;

        const trade = {
          id: meta.id || sym,
          orderId: meta.orderId || null,
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
          isPendingLimit: meta.isFilled === false,
          tpOrderId: meta.tpOrderId || null,
          slOrderId: meta.slOrderId || null,
          binanceTpOrderId: meta.tpOrderId || meta.binanceTpOrderId || null,
          binanceSlOrderId: meta.slOrderId || meta.binanceSlOrderId || null,
          recommendedAt: meta.time ? new Date(meta.time).toISOString() : new Date().toISOString(),
          status: 'active',
          source: 'bot-h4',
        };
        symbolMap.set(sym, trade);
        trades.push(trade);
      }
    }

    return trades;
  });
}

function _estimateH4EnvMargin(sym, fallbackMargin = 10) {
  let isTier1 = false;
  try {
    const { isTop50Symbol } = require('../pp369');
    if (typeof isTop50Symbol === 'function') isTier1 = isTop50Symbol(sym);
  } catch {}
  const tier1Pct = parseFloat(process.env.TRADE_SIZE_PCT_TIER1 || process.env.TRADE_SIZE_PCT || '0');
  const tier2Pct = parseFloat(process.env.TRADE_SIZE_PCT_TIER2 || (tier1Pct > 0 ? tier1Pct : '0'));
  const effPct = isTier1 ? tier1Pct : tier2Pct;
  const tier1Fallback = parseFloat(process.env.TRADE_AMOUNT_TIER1 || process.env.TRADE_AMOUNT || '20');
  const tier2Fallback = parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10');
  const flatMargin = isTier1 ? tier1Fallback : tier2Fallback;
  if (effPct > 0) {
    const accCached = _cache.get('account-summary')?.data;
    const navBal = parseFloat(accCached?.walletBalance || accCached?.availableBalance || '0');
    if (navBal > 0) {
      const minMargin = parseFloat(process.env.TRADE_MIN_USDT || '5.0');
      const maxMargin = parseFloat(process.env.TRADE_MAX_USDT || (isTier1 ? '100.0' : '50.0'));
      return parseFloat(Math.min(Math.max((navBal * effPct) / 100, minMargin), maxMargin).toFixed(2));
    }
  }
  return parseFloat((flatMargin || fallbackMargin).toFixed(2));
}

function apiShadowTrades() {
  const shadowPositions = readJson('shadow_positions.json', {});
  const list = [];
  for (const [id, s] of Object.entries(shadowPositions)) {
    if (!s || (s.status !== 'ACTIVE' && s.status !== 'PENDING_LIMIT')) continue;
    const sym = s.symbol;
    const isLong = s.signal === 'LONG' || s.signal === 'BUY';
    const entryPrice = parseFloat(s.entryPrice) || 0;
    const leverage = parseFloat(s.leverage) || 10;
    const margin = parseFloat(s.margin) || 20;
    const envMargin = _estimateH4EnvMargin(sym, margin);
    const isFilled = s.isFilled !== false && s.status !== 'PENDING_LIMIT';

    list.push({
      id: s.shadowId || id,
      symbol: sym,
      direction: isLong ? 'LONG' : 'SHORT',
      side: isLong ? 'BUY' : 'SELL',
      entryPrice,
      currentPrice: entryPrice,
      targetPrice: s.tierTpPrice || null,
      tp1Price: s.tierTpPrice || null,
      tp2Price: null,
      tp1Hit: false,
      tp2Hit: false,
      slPrice: s.tierSlPrice || s.originalSlPrice || null,
      leverage,
      margin: parseFloat(margin.toFixed(2)),
      envMargin,
      score: s.score || 0,
      confluenceScore: s.score || null,
      vetoCategory: s.vetoCategory || null,
      vetoReason: s.vetoReason || null,
      recommendedAt: s.entryTimestamp ? new Date(s.entryTimestamp).toISOString() : new Date().toISOString(),
      status: isFilled ? 'active' : 'pending_limit',
      shadowStatus: s.status,
      isFilled,
      isShadow: true,
      source: 'bot-h4-shadow',
    });
  }
  return list;
}

async function apiLivePnl() {
  return cached('live-pnl', 10_000, async () => {
    const realTrades = await apiTrades();
    const shadowTrades = apiShadowTrades();
    const allTrades = [...realTrades, ...shadowTrades];
    if (!allTrades.length) return [];

    const symbols = [...new Set(allTrades.map(t => t.symbol))];
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

    return allTrades.map(t => {
      const curr = prices[t.symbol] || t.currentPrice;
      const entry = t.entryPrice;
      if ((t.isShadow && t.isFilled === false) || t.entryFilled === false || t.isPendingLimit === true) {
        return {
          id: t.id || t.symbol,
          symbol: t.symbol,
          currentPrice: curr ?? null,
          unrealizedPct: 0,
          progress: 0,
          isPendingLimit: true,
        };
      }
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

async function apiAccount() {
  return cached('account', 20_000, async () => {
    const client = getBinanceClient();
    if (!client || typeof client.getAccountSummary !== 'function') {
      return { connected: false, error: 'Chưa cấu hình BINANCE_API_KEY / BINANCE_SECRET cho bot-h4' };
    }
    return await client.getAccountSummary();
  });
}

async function apiHistory() {
  return cached('real-history', 30_000, async () => {
    const list = [];

    // 1. Đọc lịch sử LỆNH THẬT từ ai_trade_dataset.jsonl (loại bỏ hoàn toàn isShadow === true)
    const datasetRows = readJsonl('ai_trade_dataset.jsonl', 2000);
    const entryById = new Map();
    for (const r of datasetRows) {
      if (r && r.type === 'ENTRY' && r.isShadow !== true && r.tradeId) {
        entryById.set(r.tradeId, r);
      }
    }
    for (const item of datasetRows) {
      if (!item || item.type !== 'EXIT' || item.isShadow === true) continue;
      const en = item.tradeId ? entryById.get(item.tradeId) : null;
      const pnlPct = typeof item.pnlPercent === 'number' ? item.pnlPercent : (typeof item.pnlPct === 'number' ? item.pnlPct : 0);
      const pnlUsd = typeof item.pnlUsd === 'number' ? item.pnlUsd : 0;
      const exitType = String(item.exitType || item.exitReason || '').toUpperCase();
      const isWin = pnlUsd > 0 || pnlPct > 0 || exitType === 'TP';
      const isBe = exitType === 'BE' || exitType === 'BREAKEVEN' || (pnlUsd === 0 && pnlPct === 0);
      const ts = item.exitTimestamp || item.timestamp || Date.now();
      const lev = Number(item.leverage || en?.leverage || 0) || null;
      const durationMs = typeof item.holdingDurationMinutes === 'number'
        ? Math.round(item.holdingDurationMinutes * 60_000)
        : (item.durationMs || 0);

      list.push({
        symbol: String(item.symbol || '').replace(/USDT$/i, ''),
        direction: item.signal || item.direction || en?.signal || 'LONG',
        entryPrice: item.entryPrice || en?.entryPrice || null,
        closePrice: item.exitPrice || item.closePrice || null,
        pnlPct: lev && Math.abs(pnlPct) > 0 ? parseFloat((pnlPct / lev).toFixed(2)) : parseFloat(pnlPct.toFixed(2)),
        roiPct: parseFloat(pnlPct.toFixed(2)),
        pnlUsd: parseFloat(pnlUsd.toFixed(2)),
        closedAt: new Date(ts).toISOString(),
        closedAtMs: ts,
        exitReason: isBe ? 'sl' : (isWin ? 'tp' : 'sl'),
        hit: isBe ? 'BE' : (isWin ? 'TP' : 'SL'),
        result: isBe ? 'breakeven' : (isWin ? 'win' : 'loss'),
        durationMs,
        leverage: lev,
        source: 'bot-h4-real',
      });
    }

    // 2. Bổ sung trực tiếp từ Binance /fapi/v1/income?incomeType=REALIZED_PNL của tài khoản bot-h4
    const client = getBinanceClient();
    if (client && typeof client.getRealizedIncome === 'function') {
      try {
        const incomeRows = await client.getRealizedIncome(100);
        // Gộp các partial fill cùng symbol trong 5 giây thành 1 lệnh đóng
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
          const dup = list.some(x => x.symbol === g.symbol && Math.abs((x.closedAtMs || 0) - g.time) <= 120_000);
          if (dup) continue;
          const pnlUsd = parseFloat(g.income.toFixed(2));
          const isWin = pnlUsd > 0;
          list.push({
            symbol: g.symbol,
            direction: 'BINANCE',
            entryPrice: null,
            closePrice: null,
            pnlPct: null,
            roiPct: null,
            pnlUsd,
            closedAt: new Date(g.time).toISOString(),
            closedAtMs: g.time,
            exitReason: isWin ? 'tp' : 'sl',
            hit: isWin ? 'TP' : 'SL',
            result: isWin ? 'win' : 'loss',
            durationMs: 0,
            leverage: null,
            source: 'binance-income',
          });
        }
      } catch (err) {
        log.warn(`[Dashboard] Lỗi lấy lịch sử Realized PnL từ Binance bot-h4: ${err.message}`);
      }
    }

    list.sort((a, b) => new Date(b.closedAt || 0) - new Date(a.closedAt || 0));
    return list.slice(0, 300);
  });
}

async function apiStats() {
  const history = await apiHistory();
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
      totalPnlUsd: 0,
      profitFactor: 0.0,
      avgPnl: 0,
      avgDuration: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const metricOf = t => (typeof t.pnlUsd === 'number' && t.pnlUsd !== 0) ? t.pnlUsd : (t.pnlPct || 0);
  const wins = history.filter(t => t.result === 'win' || metricOf(t) > 0).length;
  const losses = history.filter(t => t.result === 'loss' || metricOf(t) < 0).length;
  const breakeven = Math.max(0, totalTrades - wins - losses);
  const winRate = parseFloat(((wins / totalTrades) * 100).toFixed(1));
  const totalPnlPct = parseFloat(history.reduce((sum, t) => sum + (t.pnlPct || 0), 0).toFixed(2));
  const totalPnlUsd = parseFloat(history.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2));
  const winVal = history.filter(t => metricOf(t) > 0).reduce((sum, t) => sum + metricOf(t), 0);
  const lossVal = Math.abs(history.filter(t => metricOf(t) < 0).reduce((sum, t) => sum + metricOf(t), 0));
  const profitFactor = lossVal > 0 ? parseFloat((winVal / lossVal).toFixed(2)) : (winVal > 0 ? 99.9 : 0.0);
  const avgPnl = parseFloat((totalPnlPct / totalTrades).toFixed(2));

  const validDurations = history.filter(t => t.durationMs > 0);
  const avgDuration = validDurations.length > 0
    ? parseFloat((validDurations.reduce((s, t) => s + t.durationMs, 0) / validDurations.length / 3600000).toFixed(1))
    : 0;

  let bestTrade = null;
  let worstTrade = null;
  for (const t of history) {
    if (!bestTrade || metricOf(t) > metricOf(bestTrade)) bestTrade = t;
    if (!worstTrade || metricOf(t) < metricOf(worstTrade)) worstTrade = t;
  }

  const chrono = history.slice().sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  let currentStreak = 0;
  let streakType = 'win';
  for (let i = chrono.length - 1; i >= 0; i--) {
    const val = metricOf(chrono[i]);
    if (val === 0) continue;
    const isWin = val > 0;
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
    totalPnlUsd,
    profitFactor,
    avgPnl,
    avgDuration,
    bestTrade,
    worstTrade,
  };
}

async function apiChart() {
  const history = (await apiHistory()).slice().sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
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
      pnlUsd: t.pnlUsd,
    };
  });
}

async function apiAnalytics() {
  const history = await apiHistory();
  if (!history.length) return { bySymbol: [], byDay: [], duration: [] };

  const symMap = {};
  for (const t of history) {
    if (!t.symbol) continue;
    if (!symMap[t.symbol]) symMap[t.symbol] = { wins: 0, losses: 0, revs: 0, pnl: 0, pnlUsd: 0 };
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
  // Lấy coin theo dõi của bot-h4 từ step_sizes.json và market_cap_top.json
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
        .slice(0, 42); // Top 50 (8 fixed + 42 tier2)
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
  const file = path.join(DATA_DIR, '369_signals.jsonl');
  const list = [];
  try {
    if (fs.existsSync(file)) {
      list.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
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
  return { total: 0, wins: 0, losses: 0, totalNetPct: 0 };
}

function apiFundingTrades() {
  return [];
}

function apiFundingHistory() {
  return [];
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

  // Chỉ quét thư mục log của bot-h4
  const searchDirs = [
    path.join(process.cwd(), 'logs', 'logs-h4'),
    path.join(process.cwd(), 'logs'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        let m = f.match(/__(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.log$/);
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
  const rawDate = String(p.get('date') || todayStr()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return { date: rawDate, lines: [], error: 'Invalid date format (expected YYYY-MM-DD)' };
  }
  const filter = p.get('filter') || '';
  const parsedN = parseInt(p.get('lines') || '300', 10);
  const n = Math.max(1, Math.min(Number.isFinite(parsedN) ? parsedN : 300, 1000));
  return getLogsForDate(rawDate, n, filter);
}

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

  // Cập nhật trong active_trades.json của bot-h4
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

  return { ok: false, error: 'Trade not found in active_trades.json' };
}

const MAX_BODY_BYTES = 64 * 1024;
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

function _isAuthorizedH4(req) {
  const token = (process.env.DASHBOARD_AUTH_TOKEN || '').trim();
  if (!token) return true;
  const auth = String(req?.headers?.authorization || '');
  if (auth === `Bearer ${token}`) return true;
  try {
    const p = new URLSearchParams((req?.url || '').split('?')[1] || '');
    if (p.get('token') === token) return true;
  } catch {}
  return false;
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

    // CORS chỉ cấp cho origin được chỉ định rõ qua DASHBOARD_CORS_ORIGIN (bỏ wildcard *)
    const allowedOrigin = (process.env.DASHBOARD_CORS_ORIGIN || '').trim();
    if (allowedOrigin && req.headers.origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (urlPath.startsWith('/api/') && !_isAuthorizedH4(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
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

      if (urlPath === '/api/trades/update' || urlPath === '/api/shadow-trades/promote') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed — use POST' }));
        return;
      }

      // JSON API Routes
      const routes = {
        '/api/account': apiAccount,
        '/api/health': apiHealth,
        '/api/stats': apiStats,
        '/api/trades': apiTrades,
        '/api/shadow-trades': apiShadowTrades,
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
      if (urlPath === '/api/shadow-trades/promote') {
        try {
          const body = await readBodyJson(req);
          const shadowId = body?.shadowId || body?.id;
          if (!shadowId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Thiếu shadowId' }));
            return;
          }
          if (!_promoteShadowHandler) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'AutoTrade chưa đăng ký bộ xử lý đẩy Limit' }));
            return;
          }
          const result = await _promoteShadowHandler(shadowId);
          _cache.delete('live-trades');
          res.writeHead(result?.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(err?.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (urlPath === '/api/trades/cancel-limit') {
        try {
          const body = await readBodyJson(req);
          const sym = String(body?.symbol || '').toUpperCase().replace(/USDT$/i, '').replace(/[^A-Z0-9]/g, '');
          const orderId = body?.orderId != null && String(body.orderId).trim() !== '' ? String(body.orderId).trim() : null;
          if (!sym) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Thiếu symbol' }));
            return;
          }
          let result;
          if (_cancelLimitHandler) {
            result = await _cancelLimitHandler({ symbol: sym, orderId });
          } else {
            // Fallback khi dashboard chạy độc lập (không gắn autoTrade)
            const client = getBinanceClient();
            if (!client) {
              res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'Chưa cấu hình Binance API Key cho bot-h4' }));
              return;
            }
            const openOrders = await client.getOpenOrders(sym).catch(() => []);
            const targets = (Array.isArray(openOrders) ? openOrders : []).filter(o => {
              const isEntryLimit = o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
              if (!isEntryLimit) return false;
              return orderId ? String(o.orderId) === orderId : true;
            });
            const canceledOrderIds = [];
            for (const o of targets) {
              await client.cancelOrder(sym, o.orderId);
              canceledOrderIds.push(String(o.orderId));
            }
            if (canceledOrderIds.length === 0 && orderId) {
              await client.cancelOrder(sym, orderId);
              canceledOrderIds.push(orderId);
            }
            // Dọn active_trades.json nếu lệnh chưa fill
            const activeFile = path.join(DATA_DIR, 'active_trades.json');
            const activeTrades = readJson('active_trades.json', {});
            if (activeTrades[sym] && !activeTrades[sym].isFilled) {
              delete activeTrades[sym];
              try { fs.writeFileSync(activeFile, JSON.stringify(activeTrades, null, 2), 'utf8'); } catch {}
            }
            result = { ok: true, symbol: sym, canceledOrderIds };
          }
          _cache.delete('live-trades');
          if (result?.ok) {
            try { broadcastWs('trades', await apiTrades()); } catch {}
          }
          res.writeHead(result?.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(err?.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (urlPath === '/api/trades/update') {
        try {
          const body = await readBodyJson(req);
          const result = apiUpdateTrade(req.url, body);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(err?.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (urlPath === '/api/forcesync' || urlPath === '/api/sync') {
        let result = { message: 'Overridden safety brake' };
        try {
          result = overrideSafetyBrake();
        } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        const act = urlPath.replace('/api/', '');
        res.end(JSON.stringify({
          ok: true,
          action: act,
          message: result?.message || 'Sync override triggered successfully',
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
  const host = (process.env.DASHBOARD_HOST || '127.0.0.1').trim();
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

  srv.listen(targetPort, host, () => {
    log.system(`[Dashboard] 🚀 Web Dashboard PP369 sẵn sàng tại: http://${host}:${targetPort}`);

    try {
      _wss = new WebSocketServer({ server: srv });
      _wss.on('error', (err) => {
        log.warn(`[Dashboard] Lỗi WebSocket Server: ${err.message}`);
      });
      _wss.on('connection', async (ws, req) => {
        if (!_isAuthorizedH4(req)) {
          ws.close(1008, 'Unauthorized');
          return;
        }
        _wsClients.add(ws);
        try {
          const tradesList = await apiTrades();
          ws.send(JSON.stringify({
            type: 'trades',
            data: tradesList,
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
  setPromoteShadowHandler,
  setCancelLimitHandler,
  apiHealth,
  apiTrades,
  apiShadowTrades,
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
