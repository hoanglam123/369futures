'use strict';

require('dotenv').config();
const http = require('http');
const path = require('path');
const {
  start369Stream,
  getMarkPrice,
  get369SignalsForCoins,
  getLevelCache,
  getNearbySymbols,
  getGridBotConfig,
  fmt369Price,
  initH4Cache,
  YEAR_START_MS,
  updatePricesRest,
  syncWebSocketSubscriptions,
  isGridWidthValid,
  GRID_MIN_PCT,
  GRID_MAX_PCT,
} = require('../src/pp369');
const { log } = require('../src/pp369/_logger');

const fs = require('fs');

// Load configurations
let coins = [];

const PORT = parseInt(process.env.PORT || '3000', 10);
const SCAN_INTERVAL_MS = 15_000; // Scan signals every 15s

// Memory cache for calculations
let latestSignals = {};
let lastScanTime = null;

// Will be initialized in bootstrap()

// Periodic signal update scanner
async function runScan() {
  try {
    await updatePricesRest();
    const levelCache = getLevelCache();
    const nearby = getNearbySymbols(coins, levelCache, 0.01);
    
    // Sync WS subscriptions for real-time tracking
    syncWebSocketSubscriptions(nearby);

    if (!nearby.length) {
      lastScanTime = new Date().toLocaleTimeString('vi-VN');
      return;
    }
    const toScan = nearby;

    const signals = await get369SignalsForCoins(toScan);
    for (const [sym, sig] of Object.entries(signals)) {
      if (sig && sig.signal) {
        latestSignals[sym] = sig;
      }
    }
    lastScanTime = new Date().toLocaleTimeString('vi-VN');
    log.system(`[Dashboard Scanner] Đã cập nhật tín hiệu cho: ${toScan.join(', ')}`);
  } catch (err) {
    log.error(`[Dashboard Scanner] Lỗi quét tín hiệu: ${err.message}`);
  }
}

// Set up in bootstrap()

// Helper to assemble final API response
function getDashboardData() {
  return coins.map(sym => {
    const sig = latestSignals[sym] || {};
    const livePrice = getMarkPrice(sym);

    // Merge live price with cached signal info
    const currentPrice = livePrice ?? sig.currentPrice ?? null;
    const gridConfig = getGridBotConfig({ ...sig, currentPrice });

    const levels = getLevelCache()[sym];
    let distancePct = null;
    let nearestBelow = sig.nearestBelow ?? null;
    let nearestAbove = sig.nearestAbove ?? null;

    if (levels && currentPrice) {
      nearestBelow = levels.longEntry;
      nearestAbove = levels.shortEntry;
      const distLong = (currentPrice - levels.longEntry) / currentPrice;
      const distShort = (levels.shortEntry - currentPrice) / currentPrice;
      distancePct = Math.min(Math.abs(distLong), Math.abs(distShort)) * 100;
    }

    return {
      symbol: sym,
      signal: sig.signal || 'NONE',
      strength: sig.strength || 'none',
      touchCount: sig.touchCount ?? 0,
      targetLevel: sig.targetLevel ?? null,
      condLevel: sig.condLevel ?? null,
      nearestAbove,
      nearestBelow,
      currentPrice,
      distancePct,
      openPrice: sig.openPrice ?? null,
      closePrice: sig.closePrice ?? null,
      step: levels ? levels.step : (sig.step ?? null),
      month: sig.month ?? null,
      reason: sig.reason || (distancePct !== null ? `Cách mốc ${distancePct.toFixed(2)}%` : 'Đang quét...'),
      debugInfo: sig.debugInfo || {},
      gridConfig,
      score: sig.score || null,
    };
  });
}

// Inlined Single-page HTML Frontend
const htmlContent = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PP369 Trading Bot Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0c10;
      --card-bg: rgba(22, 24, 35, 0.7);
      --card-bg-active-long: rgba(16, 185, 129, 0.05);
      --card-bg-active-short: rgba(244, 63, 94, 0.05);
      --border: rgba(255, 255, 255, 0.08);
      --border-long: rgba(16, 185, 129, 0.3);
      --border-short: rgba(244, 63, 94, 0.3);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.2);
      --rose: #f43f5e;
      --rose-glow: rgba(244, 63, 94, 0.2);
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.15);
      --gray: #475569;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.04) 0%, transparent 40%);
    }

    header {
      padding: 24px 40px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(11, 12, 16, 0.8);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .logo-area {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 28px;
      background: linear-gradient(135deg, var(--accent), var(--emerald));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-weight: 700;
    }

    .logo-title {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .status-area {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.04);
      padding: 6px 14px;
      border-radius: 99px;
      border: 1px solid var(--border);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--emerald);
      box-shadow: 0 0 10px var(--emerald);
      animation: pulse 1.8s infinite;
    }

    .container {
      max-width: 1440px;
      width: 100%;
      margin: 0 auto;
      padding: 40px;
      flex-grow: 1;
    }

    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .metric-title {
      font-size: 13px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .metric-value {
      font-size: 24px;
      font-weight: 600;
    }

    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      gap: 16px;
      flex-wrap: wrap;
    }

    .filter-tabs {
      display: flex;
      gap: 6px;
      background: rgba(255, 255, 255, 0.02);
      padding: 4px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }

    .filter-tab {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .filter-tab:hover {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.02);
    }

    .filter-tab.active {
      color: var(--text-primary);
      background: var(--accent);
      box-shadow: 0 4px 12px var(--accent-glow);
    }

    .search-box-container {
      min-width: 260px;
    }

    .search-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 16px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: all 0.2s ease;
    }

    .search-input:focus {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.04);
      box-shadow: 0 0 8px var(--accent-glow);
    }

    .grid-container {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 24px;
    }

    .coin-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      position: relative;
      overflow: hidden;
      backdrop-filter: blur(16px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    .coin-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.3);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .coin-card.active-long {
      background: var(--card-bg-active-long);
      border-color: var(--border-long);
      box-shadow: 0 10px 30px rgba(16, 185, 129, 0.08);
    }

    .coin-card.active-short {
      background: var(--card-bg-active-short);
      border-color: var(--border-short);
      box-shadow: 0 10px 30px rgba(244, 63, 94, 0.08);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .symbol-name {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    .symbol-name span {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 400;
      margin-left: 4px;
    }

    .signal-badge {
      padding: 6px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .sig-none {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }

    .sig-long {
      background: rgba(16, 185, 129, 0.15);
      color: var(--emerald);
      border: 1px solid var(--emerald);
      box-shadow: 0 0 12px var(--emerald-glow);
    }

    .sig-short {
      background: rgba(244, 63, 94, 0.15);
      color: var(--rose);
      border: 1px solid var(--rose);
      box-shadow: 0 0 12px var(--rose-glow);
    }

    .price-display {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 12px;
    }

    .live-price {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -1px;
    }

    .live-price.price-up {
      color: var(--emerald);
      text-shadow: 0 0 10px var(--emerald-glow);
    }

    .live-price.price-down {
      color: var(--rose);
      text-shadow: 0 0 10px var(--rose-glow);
    }

    .price-step {
      font-size: 13px;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.03);
      padding: 4px 8px;
      border-radius: 4px;
    }

    .distance-badge {
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-glow);
      padding: 4px 10px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(59, 130, 246, 0.2);
    }
    
    .distance-badge.nearby-hot {
      color: #f97316;
      background: rgba(249, 115, 22, 0.1);
      border-color: rgba(249, 115, 22, 0.2);
    }

    .h1-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 20px;
      background: rgba(255, 255, 255, 0.02);
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .info-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .info-value {
      font-size: 14px;
      font-weight: 500;
    }

    .roundtrip-stats {
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      border-top: 1px dashed var(--border);
      padding-top: 16px;
    }

    .grid-bot-box {
      background: rgba(59, 130, 246, 0.03);
      border: 1px solid rgba(59, 130, 246, 0.15);
      border-radius: 14px;
      padding: 16px;
      margin-top: 16px;
    }

    .grid-bot-box.long-accent {
      background: rgba(16, 185, 129, 0.02);
      border-color: rgba(16, 185, 129, 0.2);
    }

    .grid-bot-box.short-accent {
      background: rgba(244, 63, 94, 0.02);
      border-color: rgba(244, 63, 94, 0.2);
    }

    .grid-bot-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .grid-bot-box.long-accent .grid-bot-title {
      color: var(--emerald);
    }

    .grid-bot-box.short-accent .grid-bot-title {
      color: var(--rose);
    }

    .grid-param {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      margin-bottom: 8px;
    }

    .grid-param:last-child {
      margin-bottom: 0;
    }

    .grid-param-label {
      color: var(--text-secondary);
    }

    .grid-param-value {
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-primary);
      width: 22px;
      height: 22px;
      font-size: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .copy-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--text-secondary);
    }

    .desc-text {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 16px;
      background: rgba(255, 255, 255, 0.01);
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      line-height: 1.4;
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4);
      }
      70% {
        box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    @keyframes pulse-orange {
      0% {
        box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.4);
      }
      70% {
        box-shadow: 0 0 0 8px rgba(249, 115, 22, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(249, 115, 22, 0);
      }
    }

    @media (max-width: 900px) {
      header {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
        padding: 20px;
      }
      
      .container {
        padding: 20px;
      }
      
      .filter-bar {
        flex-direction: column;
        align-items: stretch;
      }
      
      .search-box-container {
        width: 100%;
      }
    }

    @media (max-width: 500px) {
      .grid-container {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-area">
      <div class="logo-icon">📊</div>
      <div>
        <h1 class="logo-title">PP369</h1>
        <div style="font-size: 11px; color: var(--text-secondary)">Monthly Price Reaction Levels Dashboard</div>
      </div>
    </div>
    <div class="status-area">
      <div class="status-badge" id="last-updated-badge">
        Cập nhật: <span id="last-updated" style="margin-left: 4px; font-weight: 500">Đang quét...</span>
      </div>
      <div class="status-badge">
        <span class="status-dot"></span>
        <span>MarkPrice Live Stream</span>
      </div>
    </div>
  </header>

  <div class="container">
    <div class="metrics-bar">
      <div class="metric-card">
        <span class="metric-title">Tổng số mã</span>
        <span class="metric-value" id="stat-total">0</span>
      </div>
      <div class="metric-card">
        <span class="metric-title">Gần mốc &lt; 0.5%</span>
        <span class="metric-value" style="color: #f97316" id="stat-nearby-hot">0</span>
      </div>
      <div class="metric-card">
        <span class="metric-title">Gần mốc &lt; 2.0%</span>
        <span class="metric-value" style="color: var(--accent)" id="stat-nearby-warm">0</span>
      </div>
      <div class="metric-card">
        <span class="metric-title">LONG / SHORT Active</span>
        <span class="metric-value" style="color: var(--emerald)" id="stat-signals">0</span>
      </div>
    </div>

    <div class="filter-bar">
      <div class="filter-tabs">
        <button class="filter-tab active" data-filter="nearby-0.5">🔥 Gần mốc &lt; 0.5%</button>
        <button class="filter-tab" data-filter="nearby-2.0">⏳ Gần mốc &lt; 2.0%</button>
        <button class="filter-tab" data-filter="signals">🔔 Có tín hiệu</button>
        <button class="filter-tab" data-filter="all">Tất cả mã</button>
      </div>
      <div class="search-box-container">
        <input type="text" id="search-input" class="search-input" placeholder="Tìm kiếm symbol...">
      </div>
    </div>

    <div class="grid-container" id="cards-grid">
      <div style="color: var(--text-secondary); text-align: center; grid-column: 1 / -1; padding: 40px;">
        Đang khởi động kết nối dữ liệu...
      </div>
    </div>
  </div>

  <script>
    let previousPrices = {};
    let currentFilter = 'nearby-0.5';
    let searchQuery = '';
    let globalData = [];

    // Set up filter tab click events
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        currentFilter = e.target.getAttribute('data-filter');
        renderDashboard(globalData);
      });
    });

    // Set up search box input event
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toUpperCase();
      renderDashboard(globalData);
    });

    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerHTML;
        btn.innerHTML = '✓';
        btn.style.color = 'var(--emerald)';
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.style.color = '';
        }, 1500);
      });
    }

    async function fetchUpdate() {
      try {
        const res = await fetch('/api/signals');
        if (!res.ok) throw new Error('API Error');
        const data = await res.json();

        globalData = data;
        renderDashboard(data);
      } catch (err) {
        console.error('Error fetching updates:', err);
      }
    }

    function fmtPrice(val) {
      if (val == null) return 'N/A';
      if (val >= 1000) return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
      if (val >= 1) return val.toFixed(4);
      return val.toFixed(6);
    }

    function renderDashboard(data) {
      const grid = document.getElementById('cards-grid');
      grid.innerHTML = '';

      let totalLong = 0;
      let totalShort = 0;
      let nearbyHot = 0;
      let nearbyWarm = 0;

      data.forEach(coin => {
        if (coin.signal === 'LONG') totalLong++;
        if (coin.signal === 'SHORT') totalShort++;
        if (coin.distancePct !== null) {
          if (coin.distancePct <= 0.5) nearbyHot++;
          if (coin.distancePct <= 2.0) nearbyWarm++;
        }
      });

      document.getElementById('stat-total').innerText = data.length;
      document.getElementById('stat-nearby-hot').innerText = nearbyHot;
      document.getElementById('stat-nearby-warm').innerText = nearbyWarm;
      document.getElementById('stat-signals').innerText = \`\${totalLong} L / \${totalShort} S\`;
      document.getElementById('last-updated').innerText = new Date().toLocaleTimeString('vi-VN');

      // 1. Filter by Search Query
      let filtered = data;
      if (searchQuery) {
        filtered = filtered.filter(coin => coin.symbol.toUpperCase().includes(searchQuery));
      }

      // 2. Filter by Tab Selector
      if (currentFilter === 'nearby-0.5') {
        filtered = filtered.filter(coin => coin.distancePct !== null && coin.distancePct <= 0.5);
      } else if (currentFilter === 'nearby-2.0') {
        filtered = filtered.filter(coin => coin.distancePct !== null && coin.distancePct <= 2.0);
      } else if (currentFilter === 'signals') {
        filtered = filtered.filter(coin => coin.signal !== 'NONE');
      }

      // 3. Sort: Signals at top, then sort by distancePct ascending
      filtered.sort((a, b) => {
        const aHasSignal = a.signal !== 'NONE' ? 1 : 0;
        const bHasSignal = b.signal !== 'NONE' ? 1 : 0;
        if (aHasSignal !== bHasSignal) {
          return bHasSignal - aHasSignal;
        }
        const aDist = a.distancePct !== null ? a.distancePct : 9999;
        const bDist = b.distancePct !== null ? b.distancePct : 9999;
        return aDist - bDist;
      });

      if (filtered.length === 0) {
        grid.innerHTML = \`
          <div style="color: var(--text-secondary); text-align: center; grid-column: 1 / -1; padding: 40px; font-size: 15px;">
            Không tìm thấy mã nào thỏa mãn điều kiện lọc.
          </div>
        \`;
        return;
      }

      filtered.forEach(coin => {
        const card = document.createElement('div');
        card.className = 'coin-card';
        if (coin.signal === 'LONG') card.className += ' active-long';
        if (coin.signal === 'SHORT') card.className += ' active-short';

        const prevPrice = previousPrices[coin.symbol];
        let priceClass = '';
        if (prevPrice && coin.currentPrice) {
          if (coin.currentPrice > prevPrice) priceClass = 'price-up';
          else if (coin.currentPrice < prevPrice) priceClass = 'price-down';
        }
        if (coin.currentPrice) {
          previousPrices[coin.symbol] = coin.currentPrice;
        }

        const signalBadgeClass = coin.signal === 'LONG' ? 'sig-long' : (coin.signal === 'SHORT' ? 'sig-short' : 'sig-none');
        const signalText = coin.signal !== 'NONE' ? \`\${coin.signal} (Lần \${coin.touchCount + 1})\` : 'Không có tín hiệu';

        let distanceHTML = '';
        if (coin.distancePct !== null) {
          const isHot = coin.distancePct <= 0.5;
          const badgeClass = isHot ? 'distance-badge nearby-hot' : 'distance-badge';
          distanceHTML = \`
            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;">
              <span class="\${badgeClass}">🎯 Cách mốc: \${coin.distancePct.toFixed(3)}%</span>
            </div>
          \`;
        }

        let gridBotHTML = '';
        if (coin.gridConfig) {
          const cfg = coin.gridConfig;
          const boxClass = coin.signal === 'LONG' ? 'long-accent' : 'short-accent';
          gridBotHTML = \`
            <div class="grid-bot-box \${boxClass}">
              <div class="grid-bot-title">
                🤖 Binance Futures Grid Bot Config
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Direction</span>
                <span class="grid-param-value">
                  <b>\${cfg.direction}</b>
                  <button class="copy-btn" onclick="copyToClipboard('\${cfg.direction}', this)">📄</button>
                </span>
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Price Range</span>
                <span class="grid-param-value">
                  \${fmtPrice(cfg.lowerPrice)} - \${fmtPrice(cfg.upperPrice)}
                  <button class="copy-btn" onclick="copyToClipboard('\${cfg.lowerPrice}-\${cfg.upperPrice}', this)">📄</button>
                </span>
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Grids</span>
                <span class="grid-param-value">
                  \${cfg.grids} (20-50)
                  <button class="copy-btn" onclick="copyToClipboard('\${cfg.grids}', this)">📄</button>
                </span>
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Leverage</span>
                <span class="grid-param-value">
                  \${cfg.leverage} (2x-5x)
                  <button class="copy-btn" onclick="copyToClipboard('3', this)">📄</button>
                </span>
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Stop Loss</span>
                <span class="grid-param-value" style="color: var(--rose)">
                  \${fmtPrice(cfg.stopLoss)}
                  <button class="copy-btn" onclick="copyToClipboard('\${cfg.stopLoss}', this)">📄</button>
                </span>
              </div>
            </div>
          \`;
        } else {
          gridBotHTML = \`
            <div class="grid-bot-box" style="opacity: 0.5">
              <div class="grid-bot-title" style="color: var(--text-secondary)">
                🤖 Config Grid Bot (Chờ tín hiệu)
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Price Range (Dưới-Trên)</span>
                <span class="grid-param-value">
                  \${fmtPrice(coin.nearestBelow)} - \${fmtPrice(coin.nearestAbove)}
                </span>
              </div>
              <div class="grid-param">
                <span class="grid-param-label">Direction</span>
                <span class="grid-param-value">Neutral</span>
              </div>
            </div>
          \`;
        }

        card.innerHTML = \`
          <div class="card-header">
            <h2 class="symbol-name">\${coin.symbol}<span>USDT</span></h2>
            <span class="signal-badge \${signalBadgeClass}">\${signalText}</span>
          </div>

          <div class="price-display">
            <span class="live-price \${priceClass}">$\${coin.currentPrice ? fmtPrice(coin.currentPrice) : '---'}</span>
            <span class="price-step">Bước: $\${fmtPrice(coin.step)}</span>
          </div>

          \${distanceHTML}

          <div class="h1-info">
            <div class="info-item">
              <span class="info-label">H1 Open</span>
              <span class="info-value">$\${fmtPrice(coin.openPrice)}</span>
            </div>
            <div class="info-item">
              <span class="info-label">H1 Close</span>
              <span class="info-value">$\${fmtPrice(coin.closePrice)}</span>
            </div>
          </div>

          <div class="roundtrip-stats">
            <span>Chạm Dưới (LONG): <b>\${coin.debugInfo.lowerCount ?? 0} lần</b></span>
            <span>Chạm Trên (SHORT): <b>\${coin.debugInfo.upperCount ?? 0} lần</b></span>
          </div>

          \${gridBotHTML}

          <div class="desc-text">
            \${coin.reason}
          </div>
        \`;
        grid.appendChild(card);
      });
    }

    // Poll endpoint every 1.5 seconds for live price / updates
    setInterval(fetchUpdate, 1500);
    fetchUpdate();
  </script>
</body>
</html>
`;

// Start native HTTP Server
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  } else if (req.url === '/api/signals' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(getDashboardData()));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

async function bootstrap() {
  const filePath = path.join(__dirname, '../data/step_sizes.json');

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const cacheToUse = data.h4Cache || {};
      
      const filteredCache = {};
      for (const [sym, e] of Object.entries(cacheToUse)) {
        const isValid = e.yearStart === YEAR_START_MS && !e.failed;
        if (isValid) {
          filteredCache[sym] = e;
        }
      }

      const excluded = Object.entries(filteredCache)
        .filter(([, e]) => !isGridWidthValid(e));
      
      coins = Object.entries(filteredCache)
        .filter(([, e]) => isGridWidthValid(e))
        .map(([sym]) => sym);
      
      if (excluded.length > 0) {
        log.system(`[Dashboard] Dùng h4Cache. Bỏ qua ${excluded.length} coin grid ngoài ${GRID_MIN_PCT}-${GRID_MAX_PCT}%: ` +
          excluded.map(([sym, e]) => `${sym}(${((e.step / e.openPrice) * 100).toFixed(1)}%)`).join(', '));
      } else {
        log.system(`[Dashboard] Dùng h4Cache. Quét ${coins.length} coin hợp lệ.`);
      }
    } catch (err) {
      log.warn(`[Dashboard] Lỗi đọc danh sách coin từ step_sizes.json: ${err.message}`);
    }
  }

  if (!coins.length) {
    coins = (process.env.COINS || 'BTC,ETH,SOL,BNB,XRP,UNI,DOGE,ADA')
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);
  }

  // Lấy giá REST lần đầu để xác định các coin gần mốc
  await updatePricesRest();
  const initialLevelCache = getLevelCache();
  const initialNearby = getNearbySymbols(coins, initialLevelCache, 0.01);

  // Khởi động WebSocket stream và đăng ký chỉ các mã đang gần mốc
  start369Stream(initialNearby);

  setTimeout(() => {
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
  }, 4000);

  server.listen(PORT, () => {
    console.log('\n======================================================');
    console.log(`[Dashboard] Server is running at: http://localhost:${PORT}`);
    console.log(`[Dashboard] Coins monitored: ${coins.join(', ')}`);
    console.log('======================================================\n');
  });
}

bootstrap().catch(err => {
  log.error(`[Dashboard] Lỗi bootstrap: ${err.message}`);
});

process.on('SIGINT', () => {
  server.close(() => {
    log.system('[Dashboard] Server closed.');
    process.exit(0);
  });
});
