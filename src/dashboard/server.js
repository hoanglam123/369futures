'use strict';

/**
 * PP369 Futures Web Dashboard Server (Port 3000) — Phase 5
 *
 * Tính năng:
 *   1. REST API endpoints cung cấp số liệu thời gian thực: Vị thế đang mở, Radar mốc 369, PnL, AI Metrics, Cooldown, Sức khỏe hệ thống.
 *   2. WebSocket Server push số liệu thời gian thực tới trình duyệt (0ms delay).
 *   3. Phục vụ giao diện Web Dashboard hoàn chỉnh (index.html).
 *   4. Endpoint điều khiển từ xa: /api/sync, /api/forcesync (override Safety Brake), /api/pause, /api/resume.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { log } = require('../pp369/_logger');
const { isSafetyBrakeActive, getLastBrakeInfo, overrideSafetyBrake } = require('../trader/safetyBrake');
const { isStreamConnected } = require('../trader/binanceStream');

const DATA_DIR = path.join(process.cwd(), 'data');
const HTML_FILE = path.join(__dirname, 'index.html');
const FAVICON_FILE = path.join(__dirname, 'favicon.jpg');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
// Mặc định port 3369 cho PP369 để tránh xung đột với bot_new (port 3000) trên cùng VPS
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

// ─── Helpers Đọc Dữ Liệu ─────────────────────────────────────────────────────

function readJson(file, fallback = {}) {
  try {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file, limit = 500) {
  try {
    const full = path.join(DATA_DIR, file);
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

// ─── API Handlers ─────────────────────────────────────────────────────────────

function apiHealth() {
  const mem = process.memoryUsage();
  const brakeInfo = getLastBrakeInfo();
  const cooldowns = readJson('sl_cooldown.json', {});
  const now = Date.now();
  const activeCooldownsCount = Object.values(cooldowns).filter(entry => {
    const exp = typeof entry === 'object' ? entry.expiry : entry;
    return exp > now;
  }).length;

  return {
    status: 'ONLINE',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    websocket: {
      userDataStreamConnected: isStreamConnected(),
      wsClientsCount: _wsClients.size,
    },
    safetyBrake: {
      isActive: isSafetyBrakeActive(),
      reason: brakeInfo.reason,
      lastTriggeredAt: brakeInfo.time ? new Date(brakeInfo.time).toISOString() : null,
    },
    cooldownCount: activeCooldownsCount,
    version: '2.0.0-hybrid-quant',
  };
}

function apiTrades() {
  const activeTrades = readJson('active_trades.json', {});
  const trades = [];

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
      symbol: sym,
      direction: isLong ? 'LONG' : 'SHORT',
      side: meta.side,
      entryPrice,
      currentPrice: markPrice,
      targetPrice: meta.tierTpPrice || meta.targetPrice,
      slPrice: meta.currentSlPrice || meta.tierSlPrice || meta.slPrice,
      beTriggerPrice: meta.beTriggerPrice,
      isBreakeven: meta.isBreakeven || false,
      leverage,
      margin,
      unrealizedPnlUsd: parseFloat(pnlUsd.toFixed(2)),
      roiPct: parseFloat(roiPct.toFixed(2)),
      score: meta.score || 0,
      entryFilled: meta.isFilled !== false,
      tpOrderId: meta.tpOrderId || null,
      slOrderId: meta.slOrderId || null,
      recommendedAt: meta.time ? new Date(meta.time).toISOString() : new Date().toISOString(),
      status: 'active',
    });
  }

  return trades;
}

function apiHistory() {
  const shadowHist = readJsonl('shadow_trades_history.jsonl', 200);
  return shadowHist.map(item => {
    const isWin = item.pnlPct > 0;
    return {
      symbol: item.symbol,
      direction: item.direction || item.side || 'LONG',
      entryPrice: item.entryPrice,
      closePrice: item.closePrice || item.exitPrice,
      pnlPct: parseFloat((item.pnlPct || 0).toFixed(2)),
      pnlUsd: parseFloat((item.pnlUsd || 0).toFixed(2)),
      closedAt: item.closedAt || item.timestamp,
      exitReason: item.exitReason || (isWin ? 'TP' : 'SL'),
      hit: isWin ? 'TP' : 'SL',
      durationMs: item.durationMs || 0,
      leverage: item.leverage || 10,
    };
  });
}

function apiStats() {
  const history = apiHistory();
  const totalTrades = history.length;
  if (!totalTrades) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlPct: 0,
      profitFactor: 0,
      avgPnl: 0,
    };
  }

  const wins = history.filter(t => t.pnlPct > 0).length;
  const losses = history.filter(t => t.pnlPct <= 0).length;
  const winRate = parseFloat(((wins / totalTrades) * 100).toFixed(1));
  const totalPnlPct = parseFloat(history.reduce((sum, t) => sum + t.pnlPct, 0).toFixed(2));
  const winPnl = history.filter(t => t.pnlPct > 0).reduce((sum, t) => sum + t.pnlPct, 0);
  const lossPnl = Math.abs(history.filter(t => t.pnlPct < 0).reduce((sum, t) => sum + t.pnlPct, 0));
  const profitFactor = lossPnl > 0 ? parseFloat((winPnl / lossPnl).toFixed(2)) : (winPnl > 0 ? 99.9 : 0);
  const avgPnl = parseFloat((totalPnlPct / totalTrades).toFixed(2));

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    totalPnlPct,
    profitFactor,
    avgPnl,
  };
}

function apiChart() {
  const history = apiHistory().reverse(); // Chronological order
  let cum = 0;
  return history.map(t => {
    cum = parseFloat((cum + (t.pnlPct ?? 0)).toFixed(2));
    return {
      date: t.closedAt,
      cum,
      symbol: t.symbol,
      hit: t.hit,
      pnl: t.pnlPct,
    };
  });
}

function apiSignals() {
  return readJsonl('369_signals.jsonl', 100);
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

// ─── HTTP Server Router ───────────────────────────────────────────────────────

let _server = null;
let _wss = null;
let _activePort = DEFAULT_PORT;

function createDashboardServer() {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

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

      if (urlPath === '/favicon.jpg') {
        if (fs.existsSync(FAVICON_FILE)) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          fs.createReadStream(FAVICON_FILE).pipe(res);
          return;
        }
      }

      // JSON API Endpoints
      const jsonApis = {
        '/api/health': apiHealth,
        '/api/stats': apiStats,
        '/api/trades': apiTrades,
        '/api/history': apiHistory,
        '/api/chart': apiChart,
        '/api/signals': apiSignals,
        '/api/cooldown': apiCooldown,
        '/api/live-pnl': () => ({
          trades: apiTrades(),
          stats: apiStats(),
          timestamp: Date.now(),
        }),
      };

      if (jsonApis[urlPath]) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonApis[urlPath]()));
        return;
      }
    }

    // POST Command Endpoints
    if (req.method === 'POST') {
      if (urlPath === '/api/forcesync' || urlPath === '/api/sync') {
        const result = overrideSafetyBrake();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          action: 'forcesync',
          message: result.message,
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

  // Bắt sự kiện error TRƯỚC KHI listen để triệt tiêu vĩnh viễn unhandled 'error' crash tiến trình
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`[Dashboard] ⚠️ Port ${_activePort} đã bị chiếm dụng (EADDRINUSE).`);
      stopDashboard();

      if (attempt < 5) {
        const nextPort = targetPort + 1;
        log.system(`[Dashboard] 🔄 Đang tự động đổi sang port dự phòng: ${nextPort} (Lần thử ${attempt + 1}/5)...`);
        startDashboard(nextPort, attempt + 1, initialPort);
      } else {
        log.warn(`[Dashboard] ⚠️ Không thể mở Web Dashboard sau 5 lần thử cổng (${initialPort} -> ${_activePort}). Bot vẫn tiếp tục tự động giao dịch bình thường không bị gián đoạn.`);
      }
      return;
    }

    log.warn(`[Dashboard] Lỗi mạng máy chủ Web Dashboard: ${err.message}`);
    stopDashboard();
  });

  srv.listen(targetPort, () => {
    log.system(`[Dashboard] 🚀 Web Dashboard PP369 sẵn sàng tại: http://localhost:${targetPort}`);

    // Chỉ khởi tạo WebSocketServer khi HTTP Server đã BIND thành công cổng
    try {
      _wss = new WebSocketServer({ server: srv });
      _wss.on('error', (err) => {
        log.warn(`[Dashboard] Lỗi WebSocket Server: ${err.message}`);
      });
      _wss.on('connection', (ws) => {
        _wsClients.add(ws);
        try {
          ws.send(JSON.stringify({
            type: 'SNAPSHOT',
            data: {
              trades: apiTrades(),
              stats: apiStats(),
              health: apiHealth(),
            },
          }));
        } catch {}

        ws.on('close', () => _wsClients.delete(ws));
        ws.on('error', () => _wsClients.delete(ws));
      });
    } catch (wsErr) {
      log.warn(`[Dashboard] Lỗi khởi tạo WebSocket Server: ${wsErr.message}`);
    }
  });

  _server = srv;
  return _server;
}

function stopDashboard() {
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
  apiSignals,
  apiCooldown,
};
