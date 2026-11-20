'use strict';

/**
 * Theo dõi lệnh giao dịch được AI khuyến nghị.
 * Kiểm tra giá mỗi 5 phút, gửi alert khi chạm TP hoặc SL.
 * Lưu trạng thái vào file JSON để khôi phục sau khi restart.
 */

const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const WebSocket = require('ws');
const { sendMessages, sendPhoto } = require('./telegram');
const { generateTradeChart } = require('./chartGenerator');
const { log } = require('./logger');
const { recordTradeResult, updateReversedResult } = require('./tradeStats');
const binanceTrader  = require('./binanceTrader');
const binanceStream  = require('./binanceStream');
const bracketManager = require('./bracketManager');

const NEWS_CHAT_ID = process.env.TELEGRAM_NEWS_CHAT_ID || null;

const HEADERS            = { 'User-Agent': 'crypto-news-bot/1.0' };
const TIMEZONE           = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
const TAKER_FEE          = 0.0004;  // Binance USDT Perpetual taker fee: 0.04% mỗi chiều
const MAINTENANCE_MARGIN = 0.005;   // ~0.5% dùng để tính giá thanh lý gần đúng

// Signal protection: tránh flip-flop liên tục
// MIN_HOLD_HOURS_REVERSAL: số giờ tối thiểu phải giữ lệnh trước khi AI được phép đảo chiều
const MIN_HOLD_BEFORE_REVERSAL_MS  = parseInt(process.env.MIN_HOLD_HOURS_REVERSAL || '8', 10) * 3_600_000;
// MIN_TP_SL_UPDATE_PCT: % thay đổi tối thiểu để chấp nhận cập nhật TP/SL từ AI (tránh update vụn vặt)
const MIN_PRICE_CHANGE_TO_UPDATE   = parseFloat(process.env.MIN_TP_SL_UPDATE_PCT || '1.5');
// ENTRY_EXPIRY_HOURS: hủy lệnh pending nếu không fill sau 90 phút (1.5h) chuẩn theo bot-h4
const ENTRY_EXPIRY_MS              = parseFloat(process.env.ENTRY_EXPIRY_HOURS || '1.5') * 3_600_000;
// WS_FILL_FALLBACK_MINUTES: khoảng cách giữa các lần poll REST để phát hiện WS fill event bị miss (mặc định 5 phút để tiết kiệm API weight)
const WS_FILL_FALLBACK_MS          = parseInt(process.env.WS_FILL_FALLBACK_MINUTES || '5', 10) * 60_000;
// TRADE_COOLDOWN_HOURS: không vào lại cùng coin trong X giờ sau khi đóng lệnh (TP/SL/reversed)
const TRADE_COOLDOWN_MS            = parseInt(process.env.TRADE_COOLDOWN_HOURS || '6', 10) * 3_600_000;
// MIN_SL_ATR_MULT: SL tối thiểu phải cách entry X lần ATR (tránh stop-hunt trong vùng noise)
const MIN_SL_ATR_MULT              = parseFloat(process.env.MIN_SL_ATR_MULT || '1.5');
// MIN_RR_RATIO: R:R tối thiểu (TP%/SL%) — bảo vệ khi AI đặt TP < SL
const MIN_RR_RATIO                 = parseFloat(process.env.MIN_RR_RATIO || '1.5');

const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
const TRADES_FILE   = path.join(DATA_DIR, 'trades.json');
const HISTORY_FILE  = path.join(DATA_DIR, 'trade_history.json');

// Track trades đã thử recovery SL/TP trong session này (tránh đặt trùng)
const _slTpRecoveryDone = new Set();
// Track thời điểm lần cuối poll REST order status cho từng trade (WS fill fallback)
const _fillCheckMs = new Map();

// Flag: syncManualPositions phát hiện position thiếu TP/SL data → yêu cầu chạy signal scan
let _pendingSignalScan = false;

// Mutex: ngăn syncManualPositions chạy đồng thời (cron + API + WS event cùng lúc)
let _syncRunning = false;

// Safety brake: chặn mass-close bất thường trong reverse-check
let _massCloseWarningAt = 0;
let _forceSyncBrake = false;
function consumeSignalScanFlag() {
  const v = _pendingSignalScan;
  _pendingSignalScan = false;
  return v;
}

// Mark price WebSocket connections: symbol → WebSocket
let _combinedMpWs = null;       // single combined mark price WS for all active symbols
const _combinedMpSymbols = new Set();
let _combinedMpRebuildTimer = null;
// Latest mark price per symbol — dùng để broadcast tất cả trades mỗi tick
const _lastMarkPrices = {};

// Dashboard WebSocket push — registered by server.js via onWsPush()
const _wsPushFns = [];
function onWsPush(fn) { _wsPushFns.push(fn); }
function _wsBroadcast(type, data) {
  if (!_wsPushFns.length) return;
  for (const fn of _wsPushFns) { try { fn(type, data); } catch {} }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadTrades() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TRADES_FILE)) return [];
    const rawTrades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    const trades = rawTrades;
    const active = trades
      .map(t => ({
        ...t,
        recommendedAt: new Date(t.recommendedAt),
        closedAt: t.closedAt ? new Date(t.closedAt) : undefined,
      }))
      .filter(t => t.status === 'active');

    // Loại bỏ conflict: mỗi coin chỉ được phép 1 chiều active (giữ lệnh mới nhất)
    const seen = new Map();
    for (const t of active) {
      const existing = seen.get(t.symbol);
      if (!existing || t.recommendedAt > existing.recommendedAt) {
        if (existing) {
          log.warn(`LOAD CONFLICT: ${t.symbol} có cả 2 chiều active → giữ ${t.direction} (mới hơn), bỏ ${existing.direction}`);
        }
        seen.set(t.symbol, t);
      }
    }
    return Array.from(seen.values());
  } catch (e) {
    log.warn('Không thể load trades', { error: e.message });
    return [];
  }
}

function saveTrades() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Giữ lại các bản ghi closed trong 24h gần nhất để recovery block đọc được sau restart
    let recentClosed = [];
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const existing = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
        const activeIds = new Set(activeTrades.map(t => t.id));
        const cutoff = Date.now() - 24 * 3_600_000;
        recentClosed = existing.filter(t =>
          !activeIds.has(t.id) &&
          t.status !== 'active' &&
          t.closedAt &&
          new Date(t.closedAt).getTime() > cutoff
        );
      }
    } catch {}
    fs.writeFileSync(TRADES_FILE, JSON.stringify([...activeTrades, ...recentClosed], null, 2), 'utf8');
    _wsBroadcast('trades', activeTrades.filter(t => t.status === 'active'));
  } catch (e) {
    log.warn('Không thể lưu trades', { error: e.message });
  }
}

// Khởi tạo từ file — khôi phục lệnh còn active sau khi restart
const activeTrades = loadTrades();
if (activeTrades.length > 0) {
  log.system(`Khôi phục ${activeTrades.length} lệnh đang theo dõi từ file`);
  // Kết nối mark price WS cho toàn bộ lệnh active (cả filled lẫn pending limit)
  setTimeout(() => {
    for (const t of activeTrades) {
      if (t.status === 'active') {
        ensureMarkPriceWS(t.symbol);
        if (!t.entryFilled) {
          try { require('./bounceCancel').trackPendingLimit(t); } catch (_) {}
        }
      }
    }
  }, 0);
}

// ─── Price fetch — Binance trước, OKX fallback ───────────────────────────────

// ─── REST price broadcast for dashboard (fallback khi WS Binance không hoạt động) ──
// Poll Binance REST mỗi 5s, cập nhật _lastMarkPrices và broadcast lên dashboard WS.
setTimeout(function _scheduleDashboardPoll() {
  (async () => {
    if (!_wsPushFns.length) return;
    const filled = activeTrades.filter(t => t.status === 'active' && t.entryFilled);
    if (!filled.length) return;
    const symSet = new Set(filled.map(t => t.symbol + 'USDT'));
    try {
      const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
        headers: HEADERS, timeout: 2500,
      });
      for (const item of (Array.isArray(data) ? data : [data])) {
        if (symSet.has(item.symbol)) {
          _lastMarkPrices[item.symbol.replace(/USDT$/, '')] = parseFloat(item.markPrice);
        }
      }
    } catch {}
    const items = filled.map(t => {
      const mp = _lastMarkPrices[t.symbol];
      if (mp == null) return null;
      const isLong = t.direction === 'LONG';
      const rawPct = t.entryPrice
        ? (isLong ? (mp - t.entryPrice) / t.entryPrice * 100
                  : (t.entryPrice - mp) / t.entryPrice * 100) : null;
      const range = (t.targetPct ?? 0) + (t.slPct ?? 0);
      const progress = rawPct != null && range > 0
        ? Math.max(0, Math.min(100, (rawPct + (t.slPct ?? 0)) / range * 100)) : 50;
      return {
        id: t.id, currentPrice: mp,
        unrealizedPct: rawPct != null ? parseFloat(rawPct.toFixed(3)) : null,
        progress: parseFloat(progress.toFixed(1)),
      };
    }).filter(Boolean);
    if (items.length) _wsBroadcast('price', items);
  })().finally(() => setTimeout(_scheduleDashboardPoll, 5000));
}, 5000);


async function getPrices(symbols) {
  if (!symbols.length) return {};
  const symSet = new Set(symbols.map(s => s.toUpperCase()));
  const map = {};

  // 1. Binance Futures mark price (ưu tiên)
  try {
    const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
      headers: HEADERS, timeout: 2000,
    });
    for (const item of (Array.isArray(data) ? data : [data])) {
      const sym = item.symbol?.replace(/USDT$/, '');
      if (sym && symSet.has(sym)) map[sym] = parseFloat(item.markPrice);
    }
  } catch (err) {
    log.warn(`Mark price: Binance thất bại cho [${symbols.join(',')}] — thử OKX fallback`, { error: err.message });
  }

  // 2. OKX fallback — chỉ cho các coin không có trên Binance (không all-or-nothing)
  const missing = symbols.filter(s => map[s] == null);
  if (missing.length > 0) {
    try {
      const missingSet = new Set(missing);
      const { data } = await axios.get('https://www.okx.com/api/v5/public/mark-price', {
        headers: HEADERS, timeout: 10000, params: { instType: 'SWAP' },
      });
      for (const item of data.data ?? []) {
        if (!item.instId.endsWith('-USDT-SWAP')) continue;
        const base = item.instId.slice(0, -'-USDT-SWAP'.length);
        if (missingSet.has(base)) map[base] = parseFloat(item.markPx);
      }
      const filled = missing.filter(s => map[s] != null);
      if (filled.length > 0) {
        log.price(`Mark price: OKX bổ sung ${filled.length} coin (${filled.join(',')})`);
      }
      const stillMissing = missing.filter(s => map[s] == null);
      if (stillMissing.length > 0) {
        log.warn(`Mark price: ${stillMissing.join(',')} không có trên Binance + OKX — bỏ qua trong lần check này`);
      }
    } catch (err) {
      log.warn('Mark price: OKX fallback thất bại', { error: err.message });
    }
  }

  log.price(`Mark price: ${Object.keys(map).length}/${symbols.length} coin (Binance+OKX)`);
  return map;
}

// ─── Finance helpers ──────────────────────────────────────────────────────────

/**
 * Raw price move % cần thiết để lãi ròng trên vốn đúng bằng 10% sau đòn bẩy và phí.
 *   netPct = rawPct × lev − lev × fee × 2
 *   10     = rawPct × lev − lev × 0.08
 *   rawPct = 10 / lev + 0.08
 * Không leverage (lev=1): rawPct ≈ 10.08% ≈ 10% giá.
 */
function calcTp2RawPct(leverage) {
  const lev = leverage && leverage > 1 ? leverage : 1;
  return 10 / lev + TAKER_FEE * 2 * 100;
}

/**
 * Giá thanh lý gần đúng (isolated margin).
 * LONG:  entry × (1 − 1/lev + maintenanceMargin)
 * SHORT: entry × (1 + 1/lev − maintenanceMargin)
 */
function calcLiqPrice(entryPrice, direction, leverage) {
  if (!leverage || leverage <= 1) return null;
  return direction === 'LONG'
    ? entryPrice * (1 - 1 / leverage + MAINTENANCE_MARGIN)
    : entryPrice * (1 + 1 / leverage - MAINTENANCE_MARGIN);
}

/**
 * P&L thực tế:
 * - rawPct:       biến động giá (%)
 * - feeImpactPct: phí 2 chiều tính trên vốn = leverage × fee × 2 × 100
 * - netPct:       lãi/lỗ vốn sau phí = rawPct × leverage − feeImpactPct
 */
function calcPnl(entryPrice, closePrice, direction, leverage) {
  const isLong = direction === 'LONG';
  const rawPct = isLong
    ? (closePrice - entryPrice) / entryPrice * 100
    : (entryPrice - closePrice) / entryPrice * 100;
  const lev = leverage || 1;
  const feeImpactPct = lev * TAKER_FEE * 2 * 100;
  const netPct = rawPct * lev - feeImpactPct;
  return { rawPct, netPct, feeImpactPct };
}

// ─── Parse AI output ──────────────────────────────────────────────────────────

/**
 * Trích xuất lệnh từ phản hồi AI:
 * Ưu tiên 1: Parse khối JSON có cấu trúc (Structured Output - deterministic & zero-hallucination).
 * Ưu tiên 2: Fallback sang Regex bóc tách text (hỗ trợ backward-compatible với format legacy).
 * Bước cuối: Sanity check số học cứng (Price Geometry + tự tính 100% tỷ lệ % targetPct và slPct).
 */
function parseTrades(aiText) {
  if (!aiText) return [];

  const rawTrades = [];

  // ── Ưu tiên 1: Parse từ khối JSON có cấu trúc ──────────────────────────────
  try {
    let jsonStr = null;
    const jsonBlockM = aiText.match(/```(?:json)?\s*(\{[\s\S]*?"trades"[\s\S]*?\})\s*```/i);
    if (jsonBlockM) {
      jsonStr = jsonBlockM[1];
    } else {
      const rawObjM = aiText.match(/\{\s*"trades"\s*:\s*\[[\s\S]*?\]\s*\}/);
      if (rawObjM) {
        jsonStr = rawObjM[0];
      }
    }

    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed.trades) && parsed.trades.length > 0) {
        for (const item of parsed.trades) {
          const symbol    = item.symbol ? String(item.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
          const direction = item.direction ? String(item.direction).toUpperCase().trim() : null;
          const entry     = parseFloat(item.entryPrice ?? item.entry);
          const target    = parseFloat(item.targetPrice ?? item.tp ?? item.target);
          const sl        = parseFloat(item.slPrice ?? item.sl);
          const leverage  = item.leverage ? parseInt(item.leverage, 10) : null;
          const score     = item.confluenceScore != null ? parseInt(item.confluenceScore, 10) : (item.score != null ? parseInt(item.score, 10) : null);
          const conf      = item.confidence != null ? parseInt(item.confidence, 10) : null;
          const reason    = item.reason ? String(item.reason).slice(0, 250).trim() : null;

          if (!symbol || !direction || isNaN(entry) || isNaN(target) || isNaN(sl)) continue;
          if (direction !== 'LONG' && direction !== 'SHORT') continue;

          rawTrades.push({
            id:              `${symbol}_${direction}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            symbol,
            direction,
            entryPrice:      entry,
            targetPrice:     target,
            slPrice:         sl,
            leverage,
            confluenceScore: score,
            confidence:      conf,
            reason,
            entryFilled:     false,
            recommendedAt:   new Date(),
            status:          'active',
            source:          'json',
          });
        }
        if (rawTrades.length > 0) {
          log.ai(`parseTrades: trích xuất thành công ${rawTrades.length} lệnh từ khối JSON có cấu trúc`);
        }
      }
    }
  } catch (jsonErr) {
    log.warn(`parseTrades: không parse được JSON block (${jsonErr.message}) — fallback sang Regex`);
  }

  // ── Ưu tiên 2: Fallback sang Regex bóc tách text ───────────────────────────
  if (rawTrades.length === 0) {
    const plain = aiText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // Regex hỗ trợ: Vào:, Vao:, Entry:, Giá vào:, dấu $ tuỳ chọn, dấu ngoặc % tuỳ chọn
    const regex = /(\w+)\s*\|\s*(LONG|SHORT)\s*\|\s*(?:V[àa]o|Entry|Gi[áa]\s*v[àa]o):\s*\$?([0-9,\.]+)\s*\|\s*Target:\s*\$?([0-9,\.]+)(?:\s*\(\+?([0-9\.]+)%\))?\s*\|\s*SL:\s*\$?([0-9,\.]+)(?:\s*\(-?([0-9\.]+)%\))?(?:\s*\|\s*Đòn bẩy:\s*([0-9]+)x)?/gi;
    let match;
    while ((match = regex.exec(plain)) !== null) {
      const entry  = parseFloat(match[3].replace(/,/g, ''));
      const target = parseFloat(match[4].replace(/,/g, ''));
      const sl     = parseFloat(match[6].replace(/,/g, ''));
      if (!entry || !target || !sl) continue;
      const leverage = match[8] ? parseInt(match[8], 10) : null;

      // Tìm confluence score + confidence trong 300 ký tự TRƯỚC dòng lệnh
      const before = plain.slice(Math.max(0, match.index - 300), match.index);
      const confM  = before.match(/Confluence:\s*(\d+)\s*[đd]\s*[\|·]\s*Tin\s*c[aậ]y:\s*(\d+)%/i);
      const confluenceScore = confM ? parseInt(confM[1], 10) : null;
      const confidence      = confM ? parseInt(confM[2], 10) : null;

      // Tìm "Lý do:" trong 600 ký tự SAU dòng lệnh (trước setup tiếp theo hoặc ⛔)
      const after  = plain.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const reasonM = after.match(/L[yý]\s*do[:\s]+([^▸⛔🎯✅\n]{10,})/i);
      const rawReason = reasonM ? reasonM[1].replace(/\s+/g, ' ').trim() : null;
      const reason = rawReason
        ? (rawReason.length <= 200 ? rawReason : rawReason.slice(0, 200).replace(/\s\S*$/, '') + '…')
        : null;

      rawTrades.push({
        id:            `${match[1].toUpperCase()}_${match[2].toUpperCase()}_${Date.now()}`,
        symbol:        match[1].toUpperCase(),
        direction:     match[2].toUpperCase(),
        entryPrice:    entry,
        targetPrice:   target,
        slPrice:       sl,
        leverage,
        confluenceScore,
        confidence,
        reason,
        entryFilled:   false,
        recommendedAt: new Date(),
        status:        'active',
        source:        'regex',
      });
    }
  }

  // ── Bước 3: Sanity check số học cứng (Price Geometry & Deterministic Math) ──
  const validTrades = [];
  for (const t of rawTrades) {
    if (t.entryPrice <= 0 || t.targetPrice <= 0 || t.slPrice <= 0) {
      log.warn(`[REJECT_TRADE] ${t.symbol} ${t.direction}: Mức giá phải > 0 (Entry: ${t.entryPrice}, TP: ${t.targetPrice}, SL: ${t.slPrice})`);
      continue;
    }

    // Kiểm tra tính hợp lệ hình học (Price Geometry) để chặn đứng ảo giác nghịch đảo của LLM
    if (t.direction === 'LONG') {
      if (t.slPrice >= t.entryPrice) {
        log.warn(`[CRITICAL_AI_HALLUCINATION] ${t.symbol} LONG bị ngược SL: SL (${t.slPrice}) >= Entry (${t.entryPrice}) → HỦY LỆNH`);
        continue;
      }
      if (t.targetPrice <= t.entryPrice) {
        log.warn(`[CRITICAL_AI_HALLUCINATION] ${t.symbol} LONG bị ngược TP: TP (${t.targetPrice}) <= Entry (${t.entryPrice}) → HỦY LỆNH`);
        continue;
      }
    } else if (t.direction === 'SHORT') {
      if (t.slPrice <= t.entryPrice) {
        log.warn(`[CRITICAL_AI_HALLUCINATION] ${t.symbol} SHORT bị ngược SL: SL (${t.slPrice}) <= Entry (${t.entryPrice}) → HỦY LỆNH`);
        continue;
      }
      if (t.targetPrice >= t.entryPrice) {
        log.warn(`[CRITICAL_AI_HALLUCINATION] ${t.symbol} SHORT bị ngược TP: TP (${t.targetPrice}) >= Entry (${t.entryPrice}) → HỦY LỆNH`);
        continue;
      }
    }

    // Tự tính toán lại 100% phần trăm biến động toán học thực tế (không tin text AI sinh ra)
    t.targetPct = parseFloat(((Math.abs(t.targetPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
    t.slPct     = parseFloat(((Math.abs(t.entryPrice - t.slPrice) / t.entryPrice) * 100).toFixed(2));

    validTrades.push(t);
  }

  log.ai(`parseTrades: tìm thấy ${validTrades.length} lệnh hợp lệ (nguồn: ${validTrades.map(t => `${t.symbol}:${t.source}`).join(', ') || 'none'})`, validTrades.map(t => ({
    symbol: t.symbol, direction: t.direction,
    entry: t.entryPrice, tp: t.targetPrice, sl: t.slPrice, leverage: t.leverage,
    score: t.confluenceScore, source: t.source, reason: t.reason?.slice(0, 60),
  })));

  return validTrades;
}

// ─── Trade management ─────────────────────────────────────────────────────────

function addTrades(trades, taMap = {}) {
  let changed = 0;
  for (const t of trades) {
    // Đảm bảo trade luôn có status='active' và entryFilled=false nếu chưa xác định
    t.status = t.status || 'active';
    if (t.entryFilled === undefined) t.entryFilled = false;

    // Cùng coin, cùng chiều → cập nhật TP/SL chỉ khi thay đổi đủ lớn (tránh micro-adjustment)
    const sameDir = activeTrades.find(a => a.symbol === t.symbol && a.direction === t.direction && a.status === 'active');
    if (sameDir) {
      const tpChangePct = Math.abs(t.targetPrice - sameDir.targetPrice) / sameDir.targetPrice * 100;
      const slChangePct = Math.abs(t.slPrice - sameDir.slPrice) / sameDir.slPrice * 100;
      if (tpChangePct < MIN_PRICE_CHANGE_TO_UPDATE && slChangePct < MIN_PRICE_CHANGE_TO_UPDATE) {
        log.trade(`SKIP UPDATE ${t.symbol} ${t.direction}: thay đổi TP/SL không đáng kể (TP Δ${tpChangePct.toFixed(2)}%, SL Δ${slChangePct.toFixed(2)}%) — giữ nguyên`);
        continue;
      }
      const prev = { entry: sameDir.entryPrice, tp: sameDir.targetPrice, sl: sameDir.slPrice, leverage: sameDir.leverage };
      sameDir.entryPrice    = t.entryPrice;
      sameDir.targetPrice   = t.targetPrice;
      sameDir.targetPct     = t.targetPct;
      sameDir.slPrice       = t.slPrice;
      sameDir.slPct         = t.slPct;
      sameDir.leverage      = t.leverage ?? sameDir.leverage;
      // Không reset entryFilled nếu đã fill — tránh duplicate TP và bug UI "(chờ entry)"
      sameDir.recommendedAt = t.recommendedAt;
      // TP1 = +10% vốn (hit trước → dời SL), TP2 = 1:1 R:R (hit sau → alert)
      const tp1RawPctUpd    = calcTp2RawPct(sameDir.leverage);
      sameDir.tp1Price      = parseFloat((t.direction === 'LONG'
        ? t.entryPrice * (1 + tp1RawPctUpd / 100)
        : t.entryPrice * (1 - tp1RawPctUpd / 100)).toFixed(2));
      sameDir.tp1Pct        = parseFloat(tp1RawPctUpd.toFixed(2));
      sameDir.tp1Hit        = false;
      const riskDistUpd     = Math.abs(t.entryPrice - t.slPrice);
      sameDir.tp2Price      = parseFloat((t.direction === 'LONG'
        ? t.entryPrice + riskDistUpd
        : t.entryPrice - riskDistUpd).toFixed(t.entryPrice >= 1 ? 2 : 6));
      sameDir.tp2Pct        = parseFloat((riskDistUpd / t.entryPrice * 100).toFixed(2));
      sameDir.tp2Hit        = false;
      changed++;
      log.trade(`UPDATE ${t.symbol} ${t.direction}`, {
        prev, new: { entry: t.entryPrice, tp: t.targetPrice, sl: t.slPrice, leverage: t.leverage },
      });

      // On-Exchange Dynamic Ratchet: Tự động dịch chuyển TP / SL trực tiếp trên sàn Binance nếu vị thế đã fill
      if (sameDir.entryFilled && binanceTrader.isEnabled()) {
        (async () => {
          if (t.targetPrice && t.targetPrice !== prev.tp) {
            await binanceTrader.replaceTPOrder(sameDir, t.targetPrice).catch(e => {
              log.warn(`UPDATE: Dịch TP sàn thất bại ${t.symbol}`, { error: e.message });
            });
          }
          if (t.slPrice && t.slPrice !== prev.sl && !sameDir.slMovedToBreakeven) {
            await binanceTrader.moveSLToBreakeven(sameDir, t.slPrice).catch(e => {
              log.warn(`UPDATE: Dịch SL sàn thất bại ${t.symbol}`, { error: e.message });
            });
          }
        })();
      }
      const liqPriceUpd = calcLiqPrice(t.entryPrice, t.direction, sameDir.leverage);
      sendMessages([
        `🔄 <b>CẬP NHẬT LỆNH — ${t.symbol} ${t.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${sameDir.leverage ? ` ⚡x${sameDir.leverage}` : ''}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Vào lệnh:  <code>${fmtPrice(t.entryPrice)}</code>\n` +
        `🏳️ TP1 mới:   <code>${fmtPrice(sameDir.tp1Price)}</code>  (+${sameDir.tp1Pct}% giá → lãi +10% vốn)\n` +
        `🥈 TP2 mới:   <code>${fmtPrice(sameDir.tp2Price)}</code>  (+${sameDir.tp2Pct}% → 1:1 R:R ban đầu)\n` +
        `🎯 TP mới:    <code>${fmtPrice(t.targetPrice)}</code>  (+${t.targetPct}%)\n` +
        `🛑 SL mới:    <code>${fmtPrice(t.slPrice)}</code>  (-${t.slPct}%)\n` +
        (liqPriceUpd ? `💀 Thanh lý:  <code>${fmtPrice(liqPriceUpd)}</code>\n` : '') +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>📝 Cập nhật lại TP/SL trên sàn nếu muốn theo tín hiệu mới</i>`,
      ]).catch(() => {});

      // Đóng lệnh ngược chiều nếu đang tồn tại (defensive: không nên xảy ra nhưng phòng hờ)
      const conflict = activeTrades.find(a => a.symbol === t.symbol && a.direction !== t.direction && a.status === 'active');
      if (conflict) {
        conflict.status   = 'reversed';
        conflict.closedAt = new Date();
        const { rawPct: conflictRaw } = calcPnl(conflict.entryPrice, t.entryPrice, conflict.direction, conflict.leverage);
        recordTradeResult({ trade: conflict, exitReason: 'reversed', result: conflictRaw > 0 ? 'win' : conflictRaw < 0 ? 'loss' : 'breakeven', closePrice: t.entryPrice, pnlPct: conflictRaw });
        log.warn(`CONFLICT: ${t.symbol} có cả ${t.direction} lẫn ${conflict.direction} active → đóng ${conflict.direction} (PnL ~${conflictRaw.toFixed(2)}%)`);
      }
      continue;
    }

    // Cùng coin, khác chiều → chỉ đảo chiều nếu đã giữ đủ 8h (tránh flip-flop)
    const oppDir = activeTrades.find(a => a.symbol === t.symbol && a.direction !== t.direction && a.status === 'active');
    if (oppDir) {
      const heldMs = Date.now() - new Date(oppDir.recommendedAt).getTime();
      if (heldMs < MIN_HOLD_BEFORE_REVERSAL_MS) {
        const heldH = (heldMs / 3600000).toFixed(1);
        log.trade(`SKIP REVERSAL ${t.symbol}: lệnh ${oppDir.direction} chỉ mới ${heldH}h (min ${MIN_HOLD_BEFORE_REVERSAL_MS / 3600000}h) — bỏ qua tín hiệu đảo chiều`);
        continue;
      }
      oppDir.status   = 'reversed';
      oppDir.closedAt = new Date();
      const { rawPct: revRaw, netPct: revNet } = calcPnl(oppDir.entryPrice, t.entryPrice, oppDir.direction, oppDir.leverage);
      recordTradeResult({ trade: oppDir, exitReason: 'reversed', result: revRaw > 0 ? 'win' : revRaw < 0 ? 'loss' : 'breakeven', closePrice: t.entryPrice, pnlPct: revRaw });
      log.trade(`REVERSED ${oppDir.symbol}: ${oppDir.direction} → ${t.direction} (PnL ~${revRaw.toFixed(2)}%)`, {
        closedEntry: oppDir.entryPrice, closePrice: t.entryPrice,
      });
      const revIcon   = revRaw >= 0 ? '✅' : '❌';
      const revPnlStr = `${revRaw >= 0 ? '+' : ''}${revRaw.toFixed(2)}%`;
      const revNetStr = oppDir.leverage ? `  (thực ~${revNet >= 0 ? '+' : ''}${revNet.toFixed(1)}%)` : '';
      const closeLev  = oppDir.leverage ? ` ⚡x${oppDir.leverage}` : '';
      sendMessages([
        `🔁 <b>ĐẢO CHIỀU — ${t.symbol}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📤 Đóng: ${oppDir.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${closeLev}  entry: <code>${fmtPrice(oppDir.entryPrice)}</code>\n` +
        `   ${revIcon} P&L ước tính: <b>${revPnlStr}</b>${revNetStr}  (giá ~<code>${fmtPrice(t.entryPrice)}</code>)\n` +
        `📥 Mở:  ${t.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}  <code>${fmtPrice(t.entryPrice)}</code>  TP: <code>${fmtPrice(t.targetPrice)}</code>  SL: <code>${fmtPrice(t.slPrice)}</code>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>⚠️ Nếu đang giữ lệnh ${oppDir.direction} trên sàn, hãy tự quyết định đóng hay giữ.</i>`,
      ]).catch(() => {});
    }

    // ── Cooldown: không vào lại cùng coin trong TRADE_COOLDOWN_MS sau khi đóng ──
    const recentlyClosed = activeTrades.find(a =>
      a.symbol === t.symbol &&
      a.status !== 'active' &&
      a.closedAt &&
      (Date.now() - new Date(a.closedAt).getTime()) < TRADE_COOLDOWN_MS
    );
    if (recentlyClosed) {
      const h = ((Date.now() - new Date(recentlyClosed.closedAt).getTime()) / 3600000).toFixed(1);
      log.trade(`SKIP COOLDOWN ${t.symbol} ${t.direction}: ${recentlyClosed.status} ${h}h trước (cooldown ${TRADE_COOLDOWN_MS / 3600000}h) — bỏ lệnh mới`);
      // Lưu khuyến nghị đảo chiều để tự vào sau khi lệnh reversed đóng thủ công.
      // Chỉ lưu khi: lệnh cũ đang ở trạng thái 'reversed' VÀ chiều mới ngược lại.
      if (recentlyClosed.status === 'reversed' && recentlyClosed.direction !== t.direction) {
        recentlyClosed.pendingReversalEntry = {
          symbol:      t.symbol,
          direction:   t.direction,
          entryPrice:  t.entryPrice,
          targetPrice: t.targetPrice,
          targetPct:   t.targetPct,
          slPrice:     t.slPrice,
          slPct:       t.slPct,
          leverage:    t.leverage,
          score:       t.confluenceScore,
          reason:      t.reason,
          savedAt:     new Date().toISOString(),
        };
        saveTrades();
        log.trade(`SAVE REVERSAL PENDING ${t.symbol} ${t.direction}: entry=${fmtPrice(t.entryPrice)} tp=${fmtPrice(t.targetPrice)} sl=${fmtPrice(t.slPrice)} — chờ đóng reversed ${recentlyClosed.direction}`);
      }
      continue;
    }

    // Reversed trade cùng symbol ngược chiều chưa được đóng thủ công → chờ user đóng
    // Không được đặt lệnh mới vì trong ONE-WAY mode Binance sẽ NET và đóng lệnh cũ ngầm
    const pendingReversed = activeTrades.find(a =>
      a.symbol === t.symbol && a.status === 'reversed' && a.direction !== t.direction
    );
    if (pendingReversed) {
      pendingReversed.pendingReversalEntry = {
        symbol:      t.symbol,
        direction:   t.direction,
        entryPrice:  t.entryPrice,
        targetPrice: t.targetPrice,
        targetPct:   t.targetPct,
        slPrice:     t.slPrice,
        slPct:       t.slPct,
        leverage:    t.leverage,
        score:       t.confluenceScore,
        reason:      t.reason,
        savedAt:     new Date().toISOString(),
      };
      saveTrades();
      log.trade(`SAVE REVERSAL PENDING ${t.symbol} ${t.direction}: entry=${fmtPrice(t.entryPrice)} tp=${fmtPrice(t.targetPrice)} sl=${fmtPrice(t.slPrice)} — reversed ${pendingReversed.direction} chưa đóng, chờ tiếp`);
      continue;
    }

    // Sau restart: reversed trade không load vào activeTrades (loadTrades chỉ load status='active').
    // Đọc trade_history.json để chặn — exitReason='reversed' tự đổi sang 'manual_close' khi user đóng
    // → guard tự nhả khi user đóng lệnh, không cần entry price check.
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const _histRaw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const _pendingReversedInHist = _histRaw.some(h =>
          h.exitReason === 'reversed' &&
          h.symbol     === t.symbol   &&
          h.direction  !== t.direction
        );
        if (_pendingReversedInHist) {
          log.trade(`SKIP REVERSED PENDING ${t.symbol} ${t.direction}: reversed position ngược chiều đang chờ đóng thủ công (detected via history, sau restart) — không đặt lệnh mới`);
          continue;
        }
      }
    } catch (_e) {
      log.warn(`addTrades: không đọc được history để check reversed pending ${t.symbol}`, { error: _e.message });
    }

    const isLongNew = t.direction === 'LONG';

    // ── R:R ban đầu: bắt lỗi AI đặt ngược TP < SL (như ZEC: R:R=0.44) ─────────
    if (!t.slPct || t.slPct <= 0 || !t.targetPct || t.targetPct <= 0) {
      log.trade(`SKIP INVALID ${t.symbol} ${t.direction}: targetPct=${t.targetPct} slPct=${t.slPct} — dữ liệu lệnh không hợp lệ`);
      continue;
    }
    const rrInitial = t.targetPct / t.slPct;
    if (rrInitial < MIN_RR_RATIO) {
      log.trade(`SKIP R:R ${t.symbol} ${t.direction}: R:R ${rrInitial.toFixed(2)} < ${MIN_RR_RATIO} (TP+${t.targetPct}% / SL-${t.slPct}%) — AI đặt TP quá hẹp hoặc SL quá rộng`);
      sendMessages([
        `⚠️ <b>Lọc lệnh R:R — ${t.symbol} ${isLongNew ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `Entry: <code>${fmtPrice(t.entryPrice)}</code>\n` +
        `TP: <code>${fmtPrice(t.targetPrice)}</code> <b>+${t.targetPct}%</b>\n` +
        `SL: <code>${fmtPrice(t.slPrice)}</code> <b>-${t.slPct}%</b>\n` +
        `R:R = <b>${rrInitial.toFixed(2)}</b> < ${MIN_RR_RATIO} → <b>BỎ LỆNH</b>\n` +
        `<i>SL quá rộng hoặc TP quá hẹp — AI đặt setup không đủ lợi thế</i>`,
      ]).catch(() => {});
      continue;
    }

    // ── SL auto-adjust: chỉ áp dụng cho lệnh AI cũ, các lệnh định lượng toán học (tierSLTP) đã tính chuẩn 3 tầng ──
    if (t.source !== 'quantitative_deterministic') {
      const atrAbs = taMap[t.symbol]?.atr ?? null;
      if (atrAbs && atrAbs > 0) {
        const actualSlDist = Math.abs(t.entryPrice - t.slPrice);
        const minSlDist    = atrAbs * MIN_SL_ATR_MULT;
        if (actualSlDist < minSlDist) {
          const adjusted = parseFloat((isLongNew
            ? t.entryPrice - minSlDist
            : t.entryPrice + minSlDist).toFixed(t.entryPrice >= 1 ? 2 : 6));
          log.trade(`SL AUTO-ADJUST ${t.symbol}: AI ${((actualSlDist / t.entryPrice) * 100).toFixed(2)}% < ${MIN_SL_ATR_MULT}×ATR ${((minSlDist / t.entryPrice) * 100).toFixed(2)}% → ${fmtPrice(adjusted)}`);
          t.slPrice = adjusted;
          t.slPct   = parseFloat((Math.abs(t.entryPrice - t.slPrice) / t.entryPrice * 100).toFixed(2));
        }
      }
    }

    // ── R:R sau khi SL được mở rộng: nếu vẫn < ngưỡng → bỏ lệnh ──────────────
    const rrFinal = t.slPct > 0 ? t.targetPct / t.slPct : 0;
    if (rrFinal < MIN_RR_RATIO) {
      log.trade(`SKIP R:R (post-widen) ${t.symbol} ${t.direction}: R:R ${rrFinal.toFixed(2)} < ${MIN_RR_RATIO} sau khi mở SL về ${MIN_SL_ATR_MULT}×ATR — ATR quá cao so với khoảng cách TP`);
      sendMessages([
        `⚠️ <b>Lọc lệnh (SL widen) — ${t.symbol} ${isLongNew ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `SL đã mở rộng về ${MIN_SL_ATR_MULT}×ATR → R:R = <b>${rrFinal.toFixed(2)}</b> < ${MIN_RR_RATIO}\n` +
        `TP <b>+${t.targetPct}%</b> / SL <b>-${t.slPct}%</b> → <b>BỎ LỆNH</b>\n` +
        `<i>ATR quá cao, không đủ room giữa SL an toàn và TP</i>`,
      ]).catch(() => {});
      continue;
    }

    // TP1: +10% vốn — gần entry nhất, chạm TRƯỚC → dời SL về +1% lãi
    const tp1RawPct = calcTp2RawPct(t.leverage);
    const tp1Price  = isLongNew
      ? t.entryPrice * (1 + tp1RawPct / 100)
      : t.entryPrice * (1 - tp1RawPct / 100);
    const tp1Pct = parseFloat(tp1RawPct.toFixed(2));
    t.tp1Price = parseFloat(tp1Price.toFixed(tp1Price >= 1 ? 2 : 6));
    t.tp1Pct   = tp1Pct;

    // TP2: 1:1 R:R — xa entry hơn, chạm SAU → chỉ alert
    const riskDist = Math.abs(t.entryPrice - t.slPrice);
    const tp2Price = isLongNew ? t.entryPrice + riskDist : t.entryPrice - riskDist;
    const tp2Pct   = (riskDist / t.entryPrice * 100).toFixed(2);
    t.tp2Price = parseFloat(tp2Price.toFixed(tp2Price >= 1 ? 2 : 6));
    t.tp2Pct   = parseFloat(tp2Pct);

    t.ta = taMap[t.symbol] ?? null;
    activeTrades.push(t);
    changed++;
    log.trade(`ADD ${t.symbol} ${t.direction}`, {
      entry: t.entryPrice, tp1: tp1Price, tp: t.targetPrice, sl: t.slPrice,
      tpPct: t.targetPct, slPct: t.slPct, leverage: t.leverage,
    });

    const liqPriceNew = calcLiqPrice(t.entryPrice, t.direction, t.leverage);
    const rr       = t.slPct > 0 ? (t.targetPct / t.slPct).toFixed(1) : '—';
    const netTpPct = t.leverage
      ? (t.targetPct * t.leverage - t.leverage * TAKER_FEE * 2 * 100).toFixed(1)
      : null;
    const netSlPct = t.leverage
      ? (t.slPct * t.leverage + t.leverage * TAKER_FEE * 2 * 100).toFixed(1)
      : null;
    const netTp1Pct = t.leverage
      ? (t.tp1Pct * t.leverage - t.leverage * TAKER_FEE * 2 * 100).toFixed(1)
      : null;

    // Dòng lý do + điểm confluence (nếu có)
    let reasonLine = '';
    if (t.reason || t.confluenceScore) {
      const scoreStr = t.confluenceScore
        ? `<b>${t.confluenceScore}đ</b>${t.confidence ? ` · <b>${t.confidence}%</b>` : ''}  `
        : '';
      const reasonStr = t.reason
        ? `<i>${t.reason}</i>`
        : '';
      reasonLine = `━━━━━━━━━━━━━━━━\n🧠 ${scoreStr}${reasonStr}\n`;
    }

    const textMsg =
      `🔔 <b>LỆNH MỚI — ${t.symbol} ${isLongNew ? '🟢 LONG' : '🔴 SHORT'}${t.leverage ? ` ⚡x${t.leverage}` : ''}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Vào lệnh:   <code>${fmtPrice(t.entryPrice)}</code>\n` +
      `🏳️ TP1 (+10%vốn): <code>${fmtPrice(tp1Price)}</code>  <b>+${tp1Pct}% giá</b>${netTp1Pct ? `  <i>(vốn +${netTp1Pct}%)</i>` : ''}\n` +
      `🥈 TP2 (1:1 R:R ban đầu): <code>${fmtPrice(t.tp2Price)}</code>  <b>+${tp2Pct}%</b>\n` +
      `🎯 Chốt lời:   <code>${fmtPrice(t.targetPrice)}</code>  <b>+${t.targetPct}%</b>${netTpPct ? `  <i>(vốn +${netTpPct}%)</i>` : ''}\n` +
      `🛑 Cắt lỗ:     <code>${fmtPrice(t.slPrice)}</code>  <b>-${t.slPct}%</b>${netSlPct ? `  <i>(vốn -${netSlPct}%)</i>` : ''}\n` +
      (liqPriceNew ? `💀 Thanh lý:   <code>${fmtPrice(liqPriceNew)}</code>\n` : '') +
      `\n⚖️ R:R = <b>1 : ${rr}</b>  <i>(TP2 = 1:1 R:R ban đầu)</i>\n` +
      reasonLine +
      `━━━━━━━━━━━━━━━━\n` +
      `<i>🤖 Bot alert khi chạm TP1 / TP2 / TP / SL</i>`;

    sendMessages([textMsg]).catch(() => {});

    // Gửi chart ảnh sau text (non-blocking, không làm delay alert chính)
    // Snapshot để tránh closure over mutable t trong vòng lặp
    const snap = { ...t, tp1Price, tp2Price };
    setImmediate(async () => {
      try {
        const chartBuf = await generateTradeChart(
          snap.symbol, snap.direction, snap.entryPrice, snap.tp1Price, snap.tp2Price, snap.targetPrice, snap.slPrice, snap.ta
        );
        if (chartBuf) {
          const caption = `📊 ${snap.symbol} ${snap.direction} x${snap.leverage || 1}` +
            `  |  Entry ${fmtPrice(snap.entryPrice)}` +
            `  |  TP1 ${fmtPrice(snap.tp1Price)}  |  TP2 ${fmtPrice(snap.tp2Price)}  |  TP ${fmtPrice(snap.targetPrice)}  |  SL ${fmtPrice(snap.slPrice)}`;
          await sendPhoto(chartBuf, caption);
        }
      } catch (chartErr) {
        log.warn(`Chart: không thể gửi ảnh cho ${snap.symbol}`, { error: chartErr.message });
      }
    });

    // Auto-trade: đặt lệnh thực lên Binance Futures nếu TRADE_ENABLED=true
    if (binanceTrader.isEnabled()) {
      const tradeRef = t;
      const dirLabel = tradeRef.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      setImmediate(async () => {
        const result = await binanceTrader.placeNewTrade(tradeRef);
        if (result?.agreementRequired) {
          tradeRef.marketEntryFailed = true;
          saveTrades();
          sendMessages([
            `⚠️ <b>AUTO TRADE — Cần ký TradFi-Perps Agreement</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `${dirLabel} <b>${tradeRef.symbol}</b> yêu cầu ký hợp đồng TradFi Perpetuals trên Binance\n\n` +
            `<b>Cách xử lý:</b>\n` +
            `1. Vào Binance Futures → tìm ${tradeRef.symbol}USDT\n` +
            `2. Ký TradFi-Perps Agreement khi được yêu cầu\n` +
            `3. Sau khi ký, reset flag trên bot để retry\n\n` +
            `<i>Bot đã dừng retry ${tradeRef.symbol} cho đến khi reset thủ công.</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        } else if (result?.symbolNotSupported) {
          tradeRef.marketEntryFailed = true;
          saveTrades();
          sendMessages([
            `⚠️ <b>AUTO TRADE — Symbol không hỗ trợ</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `${dirLabel} <b>${tradeRef.symbol}</b> không tồn tại trên Binance Futures\n` +
            `<i>(có thể đã bị hủy niêm yết)</i>\n\n` +
            `<i>Bot vẫn theo dõi tín hiệu này nhưng KHÔNG đặt lệnh tự động.</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        } else if (result?.insufficientBalance) {
          sendMessages([
            `⚠️ <b>AUTO TRADE — Không đủ balance</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `${dirLabel} <b>${tradeRef.symbol}</b> ⚡x${tradeRef.leverage || 10} — lệnh KHÔNG được đặt lên Binance\n\n` +
            `💵 Balance hiện tại: <b>${result.balance.toFixed(2)} USDT</b>\n` +
            `📉 ${process.env.TRADE_SIZE_PCT || 20}% balance = <b>$${result.sizeUsdt.toFixed(2)}</b> — dưới mức tối thiểu <b>$10/lệnh</b>\n\n` +
            `<i>Bot vẫn theo dõi TP/SL tín hiệu này. Nạp thêm USDT để auto trade hoạt động.</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        } else if (result) {
          ensureMarkPriceWS(tradeRef.symbol);
          try { require('./bounceCancel').trackPendingLimit(tradeRef); } catch (_) {}
          saveTrades();
          sendMessages([
            `🤖 <b>AUTO TRADE BINANCE — ${tradeRef.symbol} ${dirLabel} ⚡x${tradeRef.leverage || 10}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `✅ Entry LIMIT:  <code>#${result.entryOrderId}</code>\n` +
            `   Qty: <b>${result.qty}</b>  (~${result.sizeUsdt.toFixed(1)} USDT)\n` +
            `💵 Balance còn: <b>${result.balance.toFixed(2)} USDT</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `<i>🛑 SL + 🎯 TP sẽ tự động đặt ngay khi entry fill (WebSocket)</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        } else {
          sendMessages([
            `❌ <b>AUTO TRADE LỖI — ${tradeRef.symbol} ${dirLabel}</b>\n` +
            `Không thể đặt lệnh trên Binance (API error). Kiểm tra logs.\n` +
            `<i>Bot vẫn theo dõi tín hiệu này.</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        }
      });
    }
  }
  if (changed > 0) saveTrades();
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtDuration(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} ngày ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m} phút`;
}

function fmtPrice(n) {
  if (n == null) return 'N/A';
  if (n >= 10000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1)     return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  return `$${String(parseFloat(n.toFixed(6)))}`;
}

// ─── Auto market entry khi balance mới có ────────────────────────────────────

/**
 * Khi có balance mới (chốt lời / cắt lỗ / nạp thêm), tự vào MARKET cho lệnh
 * pending chưa có Binance entry. Tiêu chí: giá hiện tại gần SL nhất (risk nhỏ nhất).
 */
async function checkPendingAutoEntry(prices) {
  const pending = activeTrades.filter(t =>
    t.status === 'active' &&
    !t.entryFilled &&
    !t.binanceEntryOrderId &&
    !t.marketEntryFailed
  );
  if (!pending.length) return;

  let balance;
  try {
    balance = await binanceTrader.getUsdtBalance();
  } catch (e) {
    log.warn('Auto-entry: không lấy được balance Binance', { error: e.message });
    return;
  }
  if (balance < 10) return;

  // Tìm lệnh có giá gần SL nhất (vẫn còn phía hợp lệ) → risk nhỏ nhất
  let best            = null;
  let bestImprovePct  = -Infinity;

  for (const t of pending) {
    const price = prices[t.symbol];
    if (price == null) continue;
    const isLong = t.direction === 'LONG';

    // Điều kiện 1: giá không được xấu hơn entry khuyến nghị
    if (isLong  && price > t.entryPrice) continue; // LONG: giá phải ≤ entry
    if (!isLong && price < t.entryPrice) continue; // SHORT: giá phải ≥ entry

    // Điều kiện 2: chưa vượt SL → vẫn còn khoảng bảo vệ
    if (isLong  && price <= t.slPrice) continue;
    if (!isLong && price >= t.slPrice) continue;

    // Ưu tiên: giá cải thiện nhiều nhất so với entry (% của entry)
    const improvePct = isLong
      ? (t.entryPrice - price) / t.entryPrice * 100  // LONG: giá thấp hơn entry càng tốt
      : (price - t.entryPrice) / t.entryPrice * 100; // SHORT: giá cao hơn entry càng tốt
    if (improvePct > bestImprovePct) { bestImprovePct = improvePct; best = { trade: t, price }; }
  }
  if (!best) return;

  const { trade, price } = best;
  const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const improveLabel = bestImprovePct > 0
    ? `giá tốt hơn entry ${bestImprovePct.toFixed(2)}%`
    : `giá đúng vùng entry`;
  log.trade(`AUTO MARKET ENTRY: chọn ${trade.symbol} ${trade.direction} — ${improveLabel} (giá ${fmtPrice(price)} / entry ${fmtPrice(trade.entryPrice)} / SL ${fmtPrice(trade.slPrice)})`);

  const result = await binanceTrader.placeMarketTrade(trade, price);
  if (result?.insufficientBalance) return;

  if (result?.agreementRequired) {
    trade.marketEntryFailed = true;
    saveTrades();
    log.warn(`AUTO MARKET ENTRY: ${trade.symbol} yêu cầu ký TradFi-Perps Agreement — dừng retry`);
    sendMessages([
      `⚠️ <b>AUTO MARKET ENTRY — Cần ký TradFi-Perps Agreement</b>\n` +
      `${dirLabel} <b>${trade.symbol}</b> yêu cầu ký hợp đồng TradFi Perpetuals\n\n` +
      `Vào Binance Futures → ${trade.symbol}USDT → ký Agreement → reset flag trên bot`,
    ], 1500, NEWS_CHAT_ID).catch(() => {});
    return;
  }

  if (result?.symbolNotSupported) {
    trade.marketEntryFailed = true;
    saveTrades();
    log.warn(`AUTO MARKET ENTRY: ${trade.symbol} không được hỗ trợ trên Binance Futures — bỏ qua`);
    sendMessages([
      `⚠️ <b>AUTO MARKET ENTRY — Symbol không hỗ trợ</b>\n` +
      `${dirLabel} <b>${trade.symbol}</b> không tồn tại trên Binance Futures\n` +
      `<i>(có thể đã bị hủy niêm yết — bot bỏ qua lệnh này)</i>`,
    ], 1500, NEWS_CHAT_ID).catch(() => {});
    return;
  }

  if (result) {
    if (result.slOrderId) trade.binanceSlOrderId = result.slOrderId;
    saveTrades();
    const slLine = trade.binanceSlOrderId
      ? `🛑 SL:  <code>#${trade.binanceSlOrderId}</code>  tại  <code>${fmtPrice(trade.slPrice)}</code>  <i>(STOP_MARKET trên Binance)</i>\n`
      : `🛡️ SL:  bot theo dõi tại  <code>${fmtPrice(trade.slPrice)}</code>  <i>(client-side)</i>\n`;
    sendMessages([
      `🚀 <b>AUTO MARKET ENTRY — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💹 Vào MARKET: <code>~${fmtPrice(price)}</code>  Qty: <b>${result.qty}</b>  (~${result.sizeUsdt.toFixed(1)} USDT)\n` +
      `🏳️ TP1: bot theo dõi tại  <code>${fmtPrice(trade.tp1Price)}</code>  <i>(+10% vốn → dời SL)</i>\n` +
      `🥈 TP2: bot theo dõi tại  <code>${fmtPrice(trade.tp2Price)}</code>  <i>(1:1 R:R ban đầu)</i>\n` +
      `🎯 TP:  <code>#${result.tpOrderId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>  <i>(đặt trên Binance)</i>\n` +
      slLine +
      `💵 Balance còn: <b>${result.balance.toFixed(2)} USDT</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `<i>${bestImprovePct > 0 ? `Giá tốt hơn entry ${bestImprovePct.toFixed(2)}%` : `Giá đúng vùng entry`} — vào MARKET thay lệnh chờ (Dual Bracket on-exchange)</i>`,
    ], 1500, NEWS_CHAT_ID).catch(() => {});
  } else {
    // Lỗi API tạm thời (network, timeout...) → KHÔNG set marketEntryFailed, sẽ retry lần sau
    trade.marketEntryRetries = (trade.marketEntryRetries || 0) + 1;
    saveTrades();
    log.warn(`AUTO MARKET ENTRY: thất bại ${trade.symbol} lần ${trade.marketEntryRetries} (lỗi API tạm thời) — sẽ retry phút sau`);
  }
}

// ─── Đồng bộ vị thế thủ công từ Binance ──────────────────────────────────────

/**
 * Quét toàn bộ positions đang mở trên Binance Futures.
 * Nếu phát hiện vị thế không có trong bot → thêm vào theo dõi tự động.
 * Gọi khi khởi động và khi nhận WS fill của lệnh mở mới (không phải bot).
 */
async function syncManualPositions(source = 'internal') {
  if (_syncRunning) {
    log.warn(`syncManualPositions: đang chạy (source=${source}), bỏ qua lần gọi này`);
    return;
  }
  if (!binanceTrader.isEnabled()) return;

  _syncRunning = true;
  const _t0 = Date.now();
  log.trade(`syncManualPositions: bắt đầu quét vị thế Binance | source=${source}`);

  try {
    let positions;
    try { positions = await binanceTrader.getAllPositions(); }
    catch (e) {
      log.error('syncManualPositions: HUỶ — không lấy được positions từ Binance, bỏ qua toàn bộ sync để tránh đóng nhầm lệnh đang theo dõi', { source, error: e.message });
      return;
    }

    for (const pos of positions) {
      const symbol    = pos.symbol.replace(/USDT$/, '');
      const posAmt    = parseFloat(pos.positionAmt);
      const direction = posAmt > 0 ? 'LONG' : 'SHORT';

      // 🛡️ Đồng bộ vị thế như bot-h4:
      // Nếu trade đã có trong activeTrades với trạng thái pending (!entryFilled)
      // mà trên sàn đã xuất hiện vị thế posAmt != 0 -> xác nhận lệnh LIMIT đã khớp!
      const existingPending = activeTrades.find(t =>
        t.symbol === symbol &&
        t.direction === direction &&
        t.status === 'active' &&
        !t.entryFilled
      );
      if (existingPending) {
        log.system(`[TradeMonitor] ✓ Đồng bộ vị thế sàn: Lệnh LIMIT ${symbol} ${direction} đã khớp (posAmt=${posAmt}, entry=${pos.entryPrice})`);
        existingPending.entryFilled = true;
        existingPending.binanceQty = Math.abs(posAmt);
        if (parseFloat(pos.entryPrice) > 0) existingPending.entryPrice = parseFloat(pos.entryPrice);
        saveTrades();
        ensureMarkPriceWS(symbol);

        // Đặt TP & SL On-Exchange nếu chưa có (Dual Bracket)
        if (!existingPending.binanceTpOrderId && existingPending.targetPrice) {
          await binanceTrader.placeTPAfterEntry(existingPending).catch(e => log.warn(`[Sync] Đặt TP ${symbol} thất bại: ${e.message}`));
        }
        if (!existingPending.binanceSlOrderId && existingPending.slPrice) {
          await binanceTrader.placeSLAfterFill(existingPending).catch(e => log.warn(`[Sync] Đặt SL ${symbol} thất bại: ${e.message}`));
        }
        saveTrades();
        continue;
      }

      // Đã theo dõi vị thế này rồi → bỏ qua
      // Bao gồm cả lệnh đã đóng < 30p để tránh re-detect khi position vẫn chưa settle trên Binance
      // Bao gồm cả reversed trade: lệnh REV chỉ đóng khi user tự đóng thủ công — bot không được tự đóng
      const tracked = activeTrades.some(t => {
        if (t.symbol !== symbol || t.direction !== direction) return false;
        if (t.status === 'active') return true;
        if (t.status === 'reversed') return true;
        if (t.closedAt && Date.now() - new Date(t.closedAt).getTime() < 30 * 60_000) return true;
        return false;
      });
      if (tracked) continue;

      const entryPrice = parseFloat(pos.entryPrice);

      // Kiểm tra thêm sau restart: reversed position chưa đóng thủ công.
      // reversed trade không được load vào activeTrades sau restart (loadTrades chỉ load status='active'),
      // nên cần đọc trade_history.json. exitReason='reversed' tự đổi sang 'manual_close' khi user đóng
      // → không cần match theo entry price, chỉ cần symbol+direction là đủ.
      try {
        if (fs.existsSync(HISTORY_FILE)) {
          const histRaw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
          const isReversedPending = histRaw.some(h =>
            h.exitReason === 'reversed' &&
            h.symbol    === symbol &&
            h.direction === direction
          );
          if (isReversedPending) {
            log.trade(`syncManualPositions: SKIP ${symbol} ${direction} — reversed position đang chờ đóng thủ công (entry≈${fmtPrice(entryPrice)})`);
            continue;
          }
        }
      } catch (e) {
        log.warn(`syncManualPositions: không đọc được history để check reversed pending`, { error: e.message });
      }
      const qty        = Math.abs(posAmt);
      const leverage   = parseInt(pos.leverage) || 10;
      const liqPrice   = parseFloat(pos.liquidationPrice) || null;

      // Tìm TP / SL order đang treo cho symbol này
      let _openOrdersFailed = false;
      const openOrders = await binanceTrader.getOpenOrders(symbol).catch(() => {
        _openOrdersFailed = true;
        return [];
      });
      const closingSide = direction === 'LONG' ? 'SELL' : 'BUY';
      let tpOrder = null, slOrder = null;
      for (const o of openOrders) {
        if (o.side !== closingSide) continue;
        const ot = o.type;
        if (!tpOrder && ot === 'LIMIT')                          tpOrder = o;
        if (!slOrder && (ot === 'STOP_MARKET' || ot === 'STOP')) slOrder = o;
      }

      const tpPrice = tpOrder ? parseFloat(tpOrder.price)                       : null;
      const slPrice = slOrder ? parseFloat(slOrder.stopPrice || slOrder.price)
                   : calcLiqPrice(entryPrice, direction, leverage);
      // true khi không có SL order thật — dùng calcLiqPrice fallback (isolated margin) → cho phép origin override
      const _slFromLiqFallback = !slOrder;

      // Tìm lại TP/SL từ trade gốc (nếu bị expire do WS miss)
      // Ưu tiên: trades.json (24h) → trade_history.json (bot-placed, binanceEntryOrderId != null)
      let recoveredTp = tpPrice, recoveredSl = slPrice, recoveredTp1 = null, recoveredTp2 = null;
      let recoveredTargetPct = null, recoveredSlPct = null, recoveredReason = null;
      let wasExpiredBot = false;
      try {
        let origin = null;
        if (fs.existsSync(TRADES_FILE)) {
          const rawAll = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
          const cutoff = Date.now() - 24 * 3_600_000;
          origin = rawAll.find(t =>
            t.symbol === symbol && t.direction === direction &&
            t.status !== 'active' &&
            t.closedAt && new Date(t.closedAt).getTime() > cutoff &&
            t.targetPrice && t.slPrice
          );
        }
        // Fallback: tìm trong trade_history.json — chỉ dùng trade bot đặt (binanceEntryOrderId != null)
        // để tránh pick lại record re-detected có SL từ liqPrice fallback
        if (!origin && fs.existsSync(HISTORY_FILE)) {
          const rawHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
          origin = rawHistory.findLast(t =>
            t.symbol === symbol && t.direction === direction &&
            t.binanceEntryOrderId &&
            t.targetPrice && t.slPrice
          );
        }
        if (origin) {
          wasExpiredBot = true;
          const _isLong = direction === 'LONG';
          const _originSlValid = origin.slPrice != null && (_isLong ? origin.slPrice < entryPrice : origin.slPrice > entryPrice);
          if (!recoveredTp  && origin.targetPrice)                      recoveredTp = origin.targetPrice;
          if ((!recoveredSl || _slFromLiqFallback) && origin.slPrice) {
            if (_originSlValid) {
              recoveredSl    = origin.slPrice;
              if (origin.slPct) recoveredSlPct = origin.slPct;
            } else {
              log.warn(`syncManualPositions: bỏ qua SL từ trade gốc ${symbol} — SL=${fmtPrice(origin.slPrice)} không hợp lệ cho entry mới ${fmtPrice(entryPrice)} (${direction}), giữ liqPrice fallback`);
            }
          }
          if (!recoveredTp1 && origin.tp1Price)   recoveredTp1 = origin.tp1Price;
          if (!recoveredTp2 && origin.tp2Price)   recoveredTp2 = origin.tp2Price;
          if (origin.targetPct) recoveredTargetPct = origin.targetPct;
          if (origin.reason)    recoveredReason    = origin.reason;
          log.trade(`syncManualPositions: phục hồi TP/SL từ trade gốc ${symbol} (${origin.status}) — TP=${fmtPrice(recoveredTp)} SL=${fmtPrice(recoveredSl)}`);
        } else if (_openOrdersFailed) {
          log.warn(`syncManualPositions: ${symbol} getOpenOrders lỗi và không tìm được origin — SL từ liqPrice fallback`);
        }
      } catch (e) {
        log.warn(`syncManualPositions: không đọc được file để phục hồi TP/SL`, { error: e.message });
      }

      const trade = {
        id:                   `manual_${symbol}_${Date.now()}`,
        symbol,
        direction,
        entryPrice,
        targetPrice:          recoveredTp,
        targetPct:            recoveredTargetPct,
        slPrice:              recoveredSl,
        slPct:                recoveredSlPct,
        tp1Price:             recoveredTp1,
        tp2Price:             recoveredTp2,
        reason:               recoveredReason,
        status:               'active',
        entryFilled:          true,
        manualEntry:          true,
        binanceEntryOrderId:  null,
        binanceTpOrderId:     tpOrder  ? tpOrder.orderId  : null,
        binanceSlOrderId:     slOrder  ? slOrder.orderId  : null,
        binanceQty:           qty,
        leverage,
        recommendedAt:        new Date(),
      };

      activeTrades.push(trade);
      saveTrades();
      ensureMarkPriceWS(symbol);

      log.trade(`syncManualPositions: phát hiện vị thế ${wasExpiredBot ? '(bot gốc đã expire)' : 'thủ công'} ${symbol} ${direction} @ ${fmtPrice(entryPrice)}`);

      // Auto-place TP LIMIT trên Binance nếu biết targetPrice và chưa có order
      if (!tpOrder && recoveredTp) {
        setImmediate(async () => {
          const tpId = await binanceTrader.placeTPAfterEntry(trade).catch(e => {
            log.error(`syncManualPositions: đặt TP thất bại ${symbol}`, { error: e.message });
            return null;
          });
          if (tpId) saveTrades();
          const dirLabel2 = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
          sendMessages([
            tpId
              ? `🎯 <b>TP ĐÃ ĐẶT LẠI — ${symbol} ${dirLabel2}</b>\n` +
                `TP LIMIT:  <code>#${tpId}</code>  tại  <code>${fmtPrice(recoveredTp)}</code>\n` +
                `<i>Phục hồi từ trade gốc bị expire do WS miss</i>`
              : `⚠️ <b>TP thất bại — ${symbol} ${dirLabel2}</b>\nKiểm tra và đặt TP thủ công trên Binance!`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        });
      }

      // Auto-place Hard STOP_MARKET SL trên Binance nếu biết slPrice và chưa có order
      if (!slOrder && recoveredSl) {
        setImmediate(async () => {
          const slId = await binanceTrader.placeSLAfterFill(trade).catch(e => {
            log.error(`syncManualPositions: đặt Hard STOP_MARKET SL thất bại ${symbol}`, { error: e.message });
            return null;
          });
          if (slId) saveTrades();
        });
      }

      const dirLabel = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const tpLine   = recoveredTp  ? `🎯 TP:   <code>${fmtPrice(recoveredTp)}</code>${tpOrder ? `  (order #${tpOrder.orderId})` : wasExpiredBot ? '  <i>(phục hồi từ AI gốc — sẽ đặt tự động)</i>' : ''}\n` : '';
      const slLine   = recoveredSl  ? `🛑 SL:   <code>${fmtPrice(recoveredSl)}</code>${slOrder ? `  (order #${slOrder.orderId})` : '  (client-side)'}\n` : '';
      sendMessages([
        `📡 <b>PHÁT HIỆN VỊ THẾ — ${symbol} ${dirLabel} ⚡x${leverage}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Entry:  <code>${fmtPrice(entryPrice)}</code>   Qty: <b>${qty}</b>\n` +
        tpLine + slLine +
        (liqPrice ? `⚠️ Giá TL:  <code>${fmtPrice(liqPrice)}</code>\n` : '') +
        `<i>Bot bắt đầu theo dõi vị thế này</i>`,
      ], 1500, NEWS_CHAT_ID).catch(() => {});
    }

    // ─── Reverse check: phát hiện vị thế đã đóng mà WS event bị miss ──────────
    if (binanceTrader.isEnabled()) {
      const openPosSet = new Set(
        positions
          .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
          .map(p => `${p.symbol.replace(/USDT$/, '')}_${parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'}`)
      );

      // ─── 0. Đồng bộ LỆNH LIMIT PENDING (chưa fill) với Binance openOrders ───
      // Nếu user hủy lệnh limit trên Binance hoặc lệnh bị hủy/hết hạn, gỡ khỏi activeTrades
      try {
        const openOrders = await binanceTrader.getOpenOrders().catch(() => null);
        if (Array.isArray(openOrders)) {
          const openOrderIds = new Set(openOrders.map(o => String(o.orderId)));
          const openPosSymbols = new Set(
            positions
              .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
              .map(p => p.symbol.replace(/USDT$/, ''))
          );

          for (const trade of [...activeTrades]) {
            if (trade.status !== 'active' || trade.entryFilled) continue;

            if (trade.binanceEntryOrderId) {
              const orderIdStr = String(trade.binanceEntryOrderId);
              const isOrderOpen = openOrderIds.has(orderIdStr);
              const hasPosition = openPosSymbols.has(trade.symbol);

              if (!isOrderOpen && !hasPosition) {
                log.warn(`syncManualPositions: Lệnh limit pending #${orderIdStr} (${trade.symbol}) không còn trên Binance & không có vị thế → Đã bị hủy hoặc không tồn tại → Gỡ khỏi activeTrades`);
                trade.status = 'canceled';
                trade.closedAt = new Date();
                trade.cancelReason = 'binance_order_not_found';

                if (trade.binanceTpOrderId) binanceTrader.cancelOrderById(trade.symbol, trade.binanceTpOrderId).catch(() => {});
                if (trade.binanceSlOrderId) binanceTrader.cancelAlgoOrderById(trade.symbol, trade.binanceSlOrderId).catch(() => {});

                saveTrades();
                _wsBroadcast('trades', activeTrades.filter(t => t.status === 'active'));
              }
            }
          }
        }
      } catch (err) {
        log.warn('syncManualPositions: lỗi đồng bộ open orders pending', { error: err.message });
      }

      // ─── Safety brake ──────────────────────────────────────────────────────
      // Chặn mass-close khi Binance trả về ít positions bất thường so với bot đang theo dõi.
      // Scenario A: positions.length === 0 nhưng bot đang theo dõi ≥1 lệnh filled
      // Scenario B: ≥3 lệnh đang theo dõi, >60% sẽ bị đóng cùng lúc
      // Cả hai có thể là dấu hiệu API glitch. Dùng /forcesync hoặc nút Đồng bộ UI để override thủ công.
      const _eligibleTrades = activeTrades.filter(t => t.status === 'active' && t.entryFilled);
      const _wouldClose     = _eligibleTrades.filter(t => !openPosSet.has(`${t.symbol}_${t.direction}`));
      const _massCloseA     = _eligibleTrades.length > 0 && positions.length === 0;
      const _massCloseB     = _eligibleTrades.length >= 3 && _wouldClose.length >= Math.ceil(_eligibleTrades.length * 0.6);

      const isManualSync = source === 'api' || source === 'forcesync' || source === 'manual';
      if ((_massCloseA || _massCloseB) && !_forceSyncBrake && !isManualSync) {
        _massCloseWarningAt = Date.now();
        const _reason = _massCloseA
          ? `Binance trả về 0 positions nhưng bot đang theo dõi ${_eligibleTrades.length} lệnh filled`
          : `${_wouldClose.length}/${_eligibleTrades.length} lệnh (${Math.round(_wouldClose.length / _eligibleTrades.length * 100)}%) sẽ bị đóng cùng lúc`;
        log.error(`syncManualPositions: SAFETY BRAKE — ${_reason} | binancePositions=${positions.length} source=${source} — dùng /forcesync để override`);
        sendMessages([
          `🚨 <b>SAFETY BRAKE — Sync bị huỷ</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<b>${_reason}</b>\n\n` +
          `Có thể do Binance API glitch hoặc mất kết nối tạm thời.\n` +
          `Bot <b>không đóng lệnh nào</b> và sẽ thử lại lần sau.\n\n` +
          `Dùng <code>/forcesync</code> để xác nhận đồng bộ thủ công nếu chắc chắn muốn tiếp tục.`,
        ], 0, NEWS_CHAT_ID).catch(() => {});
        return;
      }
      _forceSyncBrake = false; // consume override flag sau khi bypass thành công
      // ─── End safety brake ──────────────────────────────────────────────────

      for (const trade of [...activeTrades]) {
        if (trade.status !== 'active' || !trade.entryFilled) continue;
        if (openPosSet.has(`${trade.symbol}_${trade.direction}`)) continue;

        log.warn(`syncManualPositions: ${trade.symbol} ${trade.direction} không còn position trên Binance → kiểm tra kết quả (source=${source})`);

        // Bước 1: thử xác định TP qua order status
        let hit = null;
        let closePrice = null;
        if (trade.binanceTpOrderId) {
          const tpOrder = await binanceTrader.getOrderStatus(trade.symbol, trade.binanceTpOrderId).catch(() => null);
          if (tpOrder && tpOrder.status === 'FILLED') {
            hit = 'TP';
            closePrice = parseFloat(tpOrder.avgPrice) > 0 ? parseFloat(tpOrder.avgPrice) : trade.targetPrice;
          }
        }

        // Bước 2: fallback — so sánh mark price với vùng TP/SL (buffer ±0.5%)
        if (!hit) {
          const markPrice = _lastMarkPrices[trade.symbol] || null;
          const isLongT   = trade.direction === 'LONG';
          if (markPrice && trade.targetPrice && trade.slPrice) {
            if (isLongT ? markPrice >= trade.targetPrice * 0.995 : markPrice <= trade.targetPrice * 1.005) {
              hit = 'TP'; closePrice = trade.targetPrice;
            } else if (isLongT ? markPrice <= trade.slPrice * 1.005 : markPrice >= trade.slPrice * 0.995) {
              hit = 'SL'; closePrice = trade.slPrice;
            }
          }
        }

        // Guard: WS có thể đã đóng lệnh trong lúc await getOrderStatus
        if (trade.status !== 'active') continue;

        const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        const lev      = trade.leverage ? ` ⚡x${trade.leverage}` : '';

        if (hit === 'TP' || hit === 'SL') {
          trade.status   = hit === 'TP' ? 'tp_hit' : 'sl_hit';
          trade.closedAt = new Date();
          saveTrades();
          const { rawPct, netPct, feeImpactPct } = calcPnl(trade.entryPrice, closePrice, trade.direction, trade.leverage);
          const isBreakevenAfterTp1 = hit === 'SL' && trade.tp1Hit;
          const syncResult = isBreakevenAfterTp1 ? 'breakeven' : (rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven');
          recordTradeResult({ trade, exitReason: hit === 'TP' ? 'tp' : 'sl', result: syncResult, closePrice, pnlPct: rawPct });
          const netSign = netPct >= 0 ? '+' : '';
          log.trade(`syncManualPositions: ${hit} ${trade.symbol} ${trade.direction} closePrice=${fmtPrice(closePrice)} rawPct=${rawPct.toFixed(2)}%`);
          sendMessages([
            isBreakevenAfterTp1
              ? `🤝 <b>HÒA VỐN (sau TP1) — ${trade.symbol} ${dirLabel}${lev}</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `💰 Entry:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
                `🏳️ TP1 đã hit: <code>${fmtPrice(trade.tp1Price)}</code>\n` +
                `🤝 Đóng hòa:  <code>${fmtPrice(closePrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
                (trade.leverage ? `⚡ x${trade.leverage} → vốn: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n` : '') +
                `━━━━━━━━━━━━━━━━\n` +
                `<i>⚠️ Phát hiện qua sync định kỳ — WS event bị miss</i>`
              : `${hit === 'TP' ? '🎯' : '🛑'} <b>${hit === 'TP' ? 'CHỐT LỜI' : 'CẮT LỖ'} — ${trade.symbol} ${dirLabel}${lev}</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `💰 Entry:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
                `${hit === 'TP' ? '🎯' : '🛑'} Đóng:   <code>${fmtPrice(closePrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
                (trade.leverage ? `⚡ x${trade.leverage} → vốn: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n` : '') +
                `━━━━━━━━━━━━━━━━\n` +
                `<i>⚠️ Phát hiện qua sync định kỳ — WS event bị miss</i>`,
          ]).catch(() => {});
        } else {
          // Bước 3: Manual close — query Binance userTrades để lấy giá đóng thực tế
          trade.status   = 'manual_close';
          trade.closedAt = new Date();
          saveTrades();
          log.warn(`syncManualPositions: manual_close ${trade.symbol} ${trade.direction} — query userTrades để xác định giá đóng`);

          const sinceMs = trade.recommendedAt instanceof Date
            ? trade.recommendedAt.getTime()
            : new Date(trade.recommendedAt).getTime();
          const closeData = await binanceTrader.getRecentClosingTrades(
            trade.symbol, trade.direction, sinceMs, trade.binanceQty
          ).catch(e => {
            log.warn(`syncManualPositions: getRecentClosingTrades thất bại ${trade.symbol}`, { error: e.message });
            return null;
          });

          let manualClosePrice = null, manualRawPct = null, manualResult = null;
          if (closeData) {
            manualClosePrice = closeData.avgPrice;
            const { rawPct, netPct, feeImpactPct } = calcPnl(trade.entryPrice, closeData.avgPrice, trade.direction, trade.leverage);
            manualRawPct = rawPct;
            manualResult = rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven';
            const netSign = netPct >= 0 ? '+' : '';
            log.trade(`syncManualPositions: manual_close ${trade.symbol} ${trade.direction} closePrice=${fmtPrice(manualClosePrice)} rawPct=${rawPct.toFixed(2)}% result=${manualResult}`);
            sendMessages([
              `✋ <b>ĐÓNG THỦ CÔNG — ${trade.symbol} ${dirLabel}${lev}</b>\n` +
              `━━━━━━━━━━━━━━━━\n` +
              `💰 Entry:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
              `✋ Đóng:   <code>${fmtPrice(manualClosePrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
              (trade.leverage ? `⚡ x${trade.leverage} → vốn: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n` : '') +
              `━━━━━━━━━━━━━━━━\n` +
              `<i>Đóng thủ công (không qua TP/SL bot) — đã ghi nhận vào lịch sử</i>`,
            ]).catch(() => {});
          } else {
            log.warn(`syncManualPositions: ${trade.symbol} manual_close — không lấy được close price, ghi history không PnL`);
            sendMessages([
              `✋ <b>ĐÓNG THỦ CÔNG — ${trade.symbol} ${dirLabel}${lev}</b>\n` +
              `━━━━━━━━━━━━━━━━\n` +
              `Position không còn trên Binance — đã đóng thủ công.\n` +
              `⚠️ Không xác định được giá đóng — ghi history nhưng chưa tính vào thống kê.\n` +
              `<i>Kiểm tra Binance app để xác nhận PnL.</i>`,
            ], 1500, NEWS_CHAT_ID).catch(() => {});
          }

          recordTradeResult({
            trade,
            exitReason: 'manual_close',
            result: manualResult,
            closePrice: manualClosePrice,
            pnlPct: manualRawPct,
          });
        }
      }

      // ─── Detect reversed positions user đã đóng thủ công trên Binance ────────────
      // Bot mark reversed → không theo dõi tiếp (status='reversed' bị skip ở reverse-check).
      // Khi user đóng → position biến khỏi openPosSet → cập nhật history với giá thực tế.
      // exitReason đổi 'reversed' → 'manual_close' để không bị re-process lần sau.
      try {
        const histRaw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const pendingReversals = histRaw.filter(h =>
          h.exitReason === 'reversed' &&
          !openPosSet.has(`${h.symbol}_${h.direction}`)
        );
        for (const revEntry of pendingReversals) {
          log.trade(`syncManualPositions: reversed ${revEntry.symbol} ${revEntry.direction} không còn trên Binance → query close price`);
          const sinceMs = new Date(revEntry.closedAt).getTime();
          const closeData = await binanceTrader.getRecentClosingTrades(
            revEntry.symbol, revEntry.direction, sinceMs, null
          ).catch(e => {
            log.warn(`syncManualPositions: getRecentClosingTrades thất bại cho reversed ${revEntry.symbol}`, { error: e.message });
            return null;
          });
          if (!closeData) {
            log.warn(`syncManualPositions: reversed ${revEntry.symbol} ${revEntry.direction} — không lấy được close price, giữ nguyên ước tính`);
            continue;
          }
          const { rawPct, netPct, feeImpactPct } = calcPnl(revEntry.entryPrice, closeData.avgPrice, revEntry.direction, revEntry.leverage ?? null);
          const actualResult = rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven';
          const updated = updateReversedResult({
            symbol:           revEntry.symbol,
            direction:        revEntry.direction,
            entryPrice:       revEntry.entryPrice,
            actualClosePrice: closeData.avgPrice,
            actualPnlPct:     rawPct,
            actualResult,
            actualClosedAt:   closeData.time ? new Date(closeData.time).toISOString() : new Date().toISOString(),
          });
          if (!updated) continue;

          // Nếu lúc đảo chiều có lưu pendingReversalEntry → thêm vào activeTrades (pending).
          // checkPendingAutoEntry sẽ tự vào lệnh khi giá về vùng entry và balance có.
          const activeRevTrade = activeTrades.find(a =>
            a.symbol === revEntry.symbol && a.direction === revEntry.direction
          );
          const pendingRec = activeRevTrade?.pendingReversalEntry;
          if (pendingRec) {
            const alreadyActive = activeTrades.find(a =>
              a.symbol === pendingRec.symbol && a.direction === pendingRec.direction && a.status === 'active'
            );
            if (!alreadyActive) {
              const lev2       = pendingRec.leverage || 10;
              const isLongRev  = pendingRec.direction === 'LONG';
              const tp1RawPct2 = calcTp2RawPct(lev2);
              const prec2      = pendingRec.entryPrice >= 1 ? 2 : 6;
              const tp1P       = parseFloat((isLongRev
                ? pendingRec.entryPrice * (1 + tp1RawPct2 / 100)
                : pendingRec.entryPrice * (1 - tp1RawPct2 / 100)).toFixed(prec2));
              const riskDist2  = Math.abs(pendingRec.entryPrice - pendingRec.slPrice);
              const tp2P       = parseFloat((isLongRev
                ? pendingRec.entryPrice + riskDist2
                : pendingRec.entryPrice - riskDist2).toFixed(prec2));
              const newPendingTrade = {
                id:                  `${pendingRec.symbol}_${pendingRec.direction}_${Date.now()}`,
                symbol:              pendingRec.symbol,
                direction:           pendingRec.direction,
                entryPrice:          pendingRec.entryPrice,
                targetPrice:         pendingRec.targetPrice,
                targetPct:           pendingRec.targetPct,
                slPrice:             pendingRec.slPrice,
                slPct:               pendingRec.slPct,
                tp1Price:            tp1P,
                tp1Pct:              parseFloat(tp1RawPct2.toFixed(2)),
                tp2Price:            tp2P,
                tp2Pct:              parseFloat((riskDist2 / pendingRec.entryPrice * 100).toFixed(2)),
                leverage:            lev2,
                score:               pendingRec.score,
                reason:              pendingRec.reason,
                status:              'active',
                entryFilled:         false,
                manualEntry:         false,
                binanceEntryOrderId: null,
                binanceTpOrderId:    null,
                binanceQty:          null,
                recommendedAt:       pendingRec.savedAt,
              };
              activeTrades.push(newPendingTrade);
              delete activeRevTrade.pendingReversalEntry;
              saveTrades();
              log.trade(`ADD REVERSAL PENDING ${newPendingTrade.symbol} ${newPendingTrade.direction}: entry=${fmtPrice(newPendingTrade.entryPrice)} tp=${fmtPrice(newPendingTrade.targetPrice)} sl=${fmtPrice(newPendingTrade.slPrice)} — chờ checkPendingAutoEntry`);
              const dirLabelPend = newPendingTrade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
              const levPend      = newPendingTrade.leverage ? ` ⚡x${newPendingTrade.leverage}` : '';
              sendMessages([
                `⏳ <b>ĐẢO CHIỀU — CHỜ VÀO LỆNH — ${newPendingTrade.symbol} ${dirLabelPend}${levPend}</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `💰 Entry:  <code>${fmtPrice(newPendingTrade.entryPrice)}</code>\n` +
                `🏳️ TP1:    <code>${fmtPrice(tp1P)}</code>  (+${newPendingTrade.tp1Pct}% giá)\n` +
                `🎯 TP:     <code>${fmtPrice(newPendingTrade.targetPrice)}</code>  (+${newPendingTrade.targetPct}%)\n` +
                `🛑 SL:     <code>${fmtPrice(newPendingTrade.slPrice)}</code>  (-${newPendingTrade.slPct}%)\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `<i>Bot tự vào lệnh khi giá về vùng entry (tìm điểm tốt nhất)</i>`,
              ], 1500, NEWS_CHAT_ID).catch(() => {});
            } else {
              log.trade(`SKIP ADD REVERSAL PENDING ${pendingRec.symbol} ${pendingRec.direction}: đã có lệnh active cùng chiều`);
              delete activeRevTrade.pendingReversalEntry;
              saveTrades();
            }
          }

          const dirLabel = revEntry.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
          const lev      = revEntry.leverage ? ` ⚡x${revEntry.leverage}` : '';
          const netSign  = netPct >= 0 ? '+' : '';
          sendMessages([
            `✋ <b>ĐÓNG THỦ CÔNG (reversed) — ${revEntry.symbol} ${dirLabel}${lev}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `💰 Entry:  <code>${fmtPrice(revEntry.entryPrice)}</code>\n` +
            `✋ Đóng:   <code>${fmtPrice(closeData.avgPrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
            (revEntry.leverage ? `⚡ x${revEntry.leverage} → vốn: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n` : '') +
            `━━━━━━━━━━━━━━━━\n` +
            `<i>Reversed position đóng thủ công — lịch sử đã cập nhật giá thực tế</i>`,
          ]).catch(() => {});
        }
      } catch (e) {
        log.warn(`syncManualPositions: lỗi khi detect reversed close`, { error: e.message });
      }
    }

    if (source !== 'cron') {
      log.trade(`syncManualPositions: hoàn thành | source=${source} durationMs=${Date.now() - _t0} activeTrades=${activeTrades.filter(t => t.status === 'active').length}`);
    }
  } finally {
    _syncRunning = false;
  }
}

// ─── Price check loop ─────────────────────────────────────────────────────────

async function checkActiveTrades() {
  const active = activeTrades.filter(t => t.status === 'active');
  if (!active.length) return;

  const symbols = [...new Set(active.map(t => t.symbol))];
  let prices;
  try {
    prices = await getPrices(symbols);
    log.price(`Giá OK: ${Object.entries(prices).map(([s, p]) => `${s}=$${p}`).join(', ')}`);
  } catch (e) {
    log.warn('Trade Monitor: lỗi lấy giá (Binance + OKX đều thất bại)', { error: e.message });
    return;
  }

  // Tự vào market nếu có lệnh pending chưa được đặt và balance vừa có thêm
  if (binanceTrader.isEnabled()) await checkPendingAutoEntry(prices);

  for (const trade of active) {
    const price = prices[trade.symbol];
    if (price == null) {
      log.warn(`Trade monitor: bỏ qua ${trade.symbol} — không lấy được mark price (Binance+OKX đều thất bại)`);
      continue;
    }

    // Kiểm tra entry có được fill chưa (giá phải chạm vùng entry ±0.3%)
    const isLong = trade.direction === 'LONG';
    if (!trade.entryFilled) {
      // Entry expiry: hủy lệnh pending nếu quá lâu không fill (market đã thay đổi)
      const pendingMs = Date.now() - new Date(trade.recommendedAt).getTime();
      if (pendingMs > ENTRY_EXPIRY_MS) {
        // Trước khi expire: kiểm tra xem position có thực tế trên Binance không.
        // WS fill event có thể bị miss khi kết nối tạm ngắt → entryFilled=false dù lệnh đã fill.
        if (binanceTrader.isEnabled() && trade.binanceEntryOrderId) {
          try {
            const posAmt = await binanceTrader.getPositionAmt(trade.symbol);
            const expectedSign = isLong ? 1 : -1;
            if (posAmt !== null && Math.sign(posAmt) === expectedSign && Math.abs(posAmt) > 0) {
              // Position thực tế tồn tại — WS fill event bị miss, recover thay vì expire
              const pendingH = (pendingMs / 3_600_000).toFixed(1);
              log.warn(`EXPIRY RECOVERY: ${trade.symbol} ${trade.direction} — position tồn tại trên Binance sau ${pendingH}h, WS fill event bị miss → recover`);
              trade.entryFilled = true;
              saveTrades();
              ensureMarkPriceWS(trade.symbol);
              _fillCheckMs.delete(trade.id);
              const erTpOrderId = await binanceTrader.placeTPAfterEntry(trade).catch(e => {
                log.warn(`EXPIRY RECOVERY: đặt TP thất bại ${trade.symbol}`, { error: e.message });
                return null;
              });
              if (!trade.binanceSlOrderId && trade.slPrice) {
                await binanceTrader.placeSLAfterFill(trade).catch(e => {
                  log.warn(`EXPIRY RECOVERY: đặt Hard STOP_MARKET SL thất bại ${trade.symbol}`, { error: e.message });
                  return null;
                });
              }
              saveTrades();
              const slLine = trade.binanceSlOrderId
                ? `🛑 SL sàn đã đặt:  <code>#${trade.binanceSlOrderId}</code>  tại  <code>${fmtPrice(trade.slPrice)}</code>\n`
                : `🛡️ Bot tiếp tục theo dõi TP/SL\n`;
              sendMessages([
                `⚠️ <b>PHỤC HỒI LỆNH — ${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `Bot phát hiện lệnh đã fill trên Binance nhưng WS event bị mất (${pendingH}h)\n` +
                `💰 Entry:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
                (erTpOrderId ? `🎯 TP đã đặt:  <code>#${erTpOrderId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>\n` : `⚠️ TP đặt thất bại — kiểm tra ngay!\n`) +
                slLine,
              ], 1500, NEWS_CHAT_ID).catch(() => {});
              continue;
            }
          } catch (e) {
            log.warn(`EXPIRY CHECK: không lấy được positionAmt ${trade.symbol} — tiến hành expire bình thường`, { error: e.message });
          }
        }

        // Không có position thực tế → expire bình thường
        if (binanceTrader.isEnabled()) {
          binanceTrader.cancelEntryOrder(trade).catch(() => {});
          if (trade.binanceSlOrderId) binanceTrader.cancelAlgoOrderById(trade.binanceSlOrderId).catch(() => {});
          if (trade.binanceTpOrderId) binanceTrader.cancelOrderById(trade.symbol, trade.binanceTpOrderId).catch(() => {});
        }
        trade.status   = 'expired';
        trade.closedAt = new Date();
        saveTrades();
        const pendingH = (pendingMs / 3_600_000).toFixed(1);
        log.trade(`ENTRY EXPIRED: ${trade.symbol} ${trade.direction} sau ${pendingH}h chờ — tự hủy`);
        sendMessages([
          `⏰ <b>HẾT HẠN ENTRY — ${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `💰 Entry:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
          `⌛ Đã chờ: <b>${pendingH}h</b> — giá không về vùng vào lệnh\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<i>🤖 Bot tự hủy lệnh này. Thị trường đã thay đổi, không nên vào muộn.</i>`,
        ], 1500, NEWS_CHAT_ID).catch(() => {});
        continue;
      }

      // Cơ chế đồng bộ vị thế chuẩn bot-h4:
      // Lệnh LIMIT đang treo trên sàn Binance chờ giá khớp.
      // - Khớp lệnh được bắt tức thì qua WebSocket User Data Stream (ORDER_TRADE_UPDATE)
      // - Dự phòng rớt mạng WebSocket qua chu kỳ syncManualPositions() (getAllPositions)
      // - Hủy lệnh tự động nếu giá bật nảy ra xa (checkBounceCancel >= 1.5%) hoặc timeout chạm entry (10p) / timeout chờ (15p)
      if (trade.binanceEntryOrderId) {
        ensureMarkPriceWS(trade.symbol);

        // 1. Nhận diện chạm mốc Entry (chuẩn bot-h4)
        const isTouch = isLong
          ? price <= trade.entryPrice * 1.0015
          : price >= trade.entryPrice * 0.9985;
        if (isTouch) {
          if (!trade.hasTouchedEntry) {
            trade.hasTouchedEntry = true;
            trade.touchedTime = Date.now();
            saveTrades();
            log.trade(`[TradeMonitor] ${trade.symbol} ${trade.direction}: Đã chạm mốc Entry (${fmtPrice(trade.entryPrice)}) — kích hoạt bộ đếm timeout chạm 10p`);
          }
        }

        // 2. Kiểm tra Bounce Cancel (Giá chạm/tiệm cận mốc rồi bật nảy >= 1.5% ra xa)
        try {
          const { checkBounceCancel } = require('./bounceCancel');
          const { shouldCancel, reason } = checkBounceCancel(trade, price);
          if (shouldCancel) {
            log.system(`[AutoTrade] [BounceCancel] ${trade.symbol} ${trade.direction}: ${reason} → Hủy LIMIT ngay lập tức`);
            await binanceTrader.cancelEntryOrder(trade).catch(() => {});
            trade.status = 'canceled';
            trade.closedAt = new Date();
            trade.cancelReason = 'bounce_cancel';
            saveTrades();
            _wsBroadcast('trades', activeTrades.filter(t => t.status === 'active'));
            sendMessages([
              `🔄 <b>[AutoTrade] Hủy LIMIT (Bounce Cancel)</b>\n` +
              `━━━━━━━━━━━━━━━━\n` +
              `• Coin: <b>${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
              `• Entry: <code>${fmtPrice(trade.entryPrice)}</code> | Giá hiện tại: <code>${fmtPrice(price)}</code>\n` +
              `• <b>Giá đã nảy ≥ 1.5% ra xa mốc sau khi chạm entry → Hủy lệnh bảo vệ vốn!</b>\n` +
              `<i>🤖 Tránh rủi ro khi giá quay lại test lần 2 (dễ thủng cản).</i>`
            ], 1500, NEWS_CHAT_ID).catch(() => {});
            continue;
          }
        } catch (_) {}

        // 3. Dual Timeout chuẩn bot-h4:
        // - LIMIT_TOUCHED_TIMEOUT: Đã chạm Entry mà quá 10 phút không khớp -> Hủy
        // - LIMIT_TIMEOUT: Quá 15 phút mà giá không về đón Entry -> Hủy
        const now = Date.now();
        const limitTouchedTimeoutMs = parseInt(process.env.LIMIT_TOUCHED_TIMEOUT_MINUTES || '10', 10) * 60_000;
        const limitTimeoutMs = parseInt(process.env.LIMIT_TIMEOUT_MINUTES || '15', 10) * 60_000;
        const isTouchedTimeout = trade.hasTouchedEntry === true && (now - trade.touchedTime > limitTouchedTimeoutMs);
        const isNormalTimeout  = !trade.hasTouchedEntry && (now - new Date(trade.recommendedAt).getTime() > limitTimeoutMs);

        if (isTouchedTimeout || isNormalTimeout) {
          const typeLabel = isTouchedTimeout
            ? `đã chạm Entry (${fmtPrice(trade.entryPrice)}) quá ${Math.round(limitTouchedTimeoutMs / 60000)} phút không khớp`
            : `chờ quá ${Math.round(limitTimeoutMs / 60000)} phút giá không về vùng Entry`;
          log.system(`[TradeMonitor] Lệnh LIMIT của ${trade.symbol} ${typeLabel} → Tiến hành hủy...`);
          await binanceTrader.cancelEntryOrder(trade).catch(() => {});
          trade.status = 'canceled';
          trade.closedAt = new Date();
          trade.cancelReason = isTouchedTimeout ? 'limit_touched_timeout' : 'limit_timeout';
          saveTrades();
          _wsBroadcast('trades', activeTrades.filter(t => t.status === 'active'));
          sendMessages([
            `⏰ <b>HỦY LỆNH LIMIT (${isTouchedTimeout ? 'TOUCH TIMEOUT' : 'TIMEOUT'})</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `• Coin: <b>${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
            `• Entry: <code>${fmtPrice(trade.entryPrice)}</code>\n` +
            `• Lý do: <b>${typeLabel}</b>\n` +
            `<i>🤖 Tự động hủy lệnh để giải phóng vốn và loại bỏ rủi ro khớp muộn.</i>`
          ], 1500, NEWS_CHAT_ID).catch(() => {});
          continue;
        }

        log.price(`${trade.symbol} ${trade.direction}: chờ Binance LIMIT #${trade.binanceEntryOrderId} fill...`);
        continue;
      }

      // TRADE_ENABLED nhưng chưa có orderId → lần đặt lệnh đầu bị lỗi API, chờ checkPendingAutoEntry retry.
      // Không set entryFilled=true qua giá vì không có vị thế thực trên Binance.
      if (binanceTrader.isEnabled() && !trade.manualEntry) {
        if (trade.marketEntryFailed) {
          log.price(`${trade.symbol} ${trade.direction}: entry thất bại vĩnh viễn (symbol không hỗ trợ hoặc API lỗi liên tục) — không retry`);
        } else {
          log.price(`${trade.symbol} ${trade.direction}: chờ Binance order (API lỗi lần trước, sẽ retry khi giá về vùng entry)...`);
        }
        continue;
      }

      const entryReached = isLong
        ? price <= trade.entryPrice * 1.003
        : price >= trade.entryPrice * 0.997;

      // Gap scenario: giá nhảy qua entry lẫn TP giữa 2 lần check (1 phút) — coi như đã fill
      const gapPastTP = isLong ? price >= trade.targetPrice : price <= trade.targetPrice;

      if (!entryReached && !gapPastTP) {
        log.price(`${trade.symbol} ${trade.direction}: chờ entry ${fmtPrice(trade.entryPrice)}, hiện ${fmtPrice(price)}`);
        continue;
      }
      trade.entryFilled = true;
      saveTrades();
      ensureMarkPriceWS(trade.symbol);
      // Auto: đặt On-Exchange Dual Bracket (LIMIT TP & Hard STOP_MARKET SL) trên Binance ngay khi entry fill
      if (binanceTrader.isEnabled() && trade.binanceEntryOrderId && (!trade.binanceTpOrderId || !trade.binanceSlOrderId)) {
        (async () => {
          await bracketManager.placeDualBracket({
            client: binanceTrader,
            sym: trade.symbol,
            side: trade.direction === 'LONG' ? 'BUY' : 'SELL',
            qty: trade.binanceQty,
            entryPrice: trade.entryPrice,
            targetPrice: trade.targetPrice,
            slPrice: trade.slPrice,
            meta: trade,
          }).catch(e => {
            log.error(`Polling: đặt Dual Bracket thất bại ${trade.symbol}`, { error: e.message });
            return null;
          });
          saveTrades();
          const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
          const tpStr = trade.binanceTpOrderId ? `🎯 TP sàn đã đặt:  <code>#${trade.binanceTpOrderId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>\n` : `⚠️ TP đặt thất bại — kiểm tra ngay!\n`;
          const slStr = trade.binanceSlOrderId ? `🛑 SL sàn đã đặt:  <code>#${trade.binanceSlOrderId}</code>  tại  <code>${fmtPrice(trade.slPrice)}</code>\n` : `⚠️ SL đặt thất bại — kiểm tra ngay!\n`;
          sendMessages([
            `🎯 <b>ENTRY FILL (Dual Bracket) — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            tpStr + slStr +
            `<i>⚡ Cặp lệnh TP/SL đã treo trực tiếp trên Binance (bảo vệ thảm họa 100%)</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        })();
      }
      if (gapPastTP && !entryReached) {
        log.trade(`Entry gap-filled: ${trade.symbol} ${trade.direction} — giá nhảy qua entry+TP, coi như fill tại ${fmtPrice(trade.entryPrice)}`);
      } else {
        log.trade(`Entry filled: ${trade.symbol} ${trade.direction} tại ${fmtPrice(price)}`);
      }
    }

    // Recovery: nếu entry đã fill nhưng TP hoặc SL vẫn chưa được đặt (e.g., API lỗi khi fill hoặc WS miss),
    // Kiểm tra position thực tế trước, thử đặt lại 1 lần/session để tránh trùng lệnh.
    if (trade.entryFilled && trade.binanceEntryOrderId && binanceTrader.isEnabled()) {
      const tradeKey = String(trade.binanceEntryOrderId);
      const needTP = !trade.binanceTpOrderId;
      const needSL = !trade.binanceSlOrderId;
      if ((needTP || needSL) && !_slTpRecoveryDone.has(tradeKey)) {
        _slTpRecoveryDone.add(tradeKey);
        log.warn(`Recovery: ${trade.symbol} ${trade.direction} — thiếu ${needTP ? 'TP' : ''}${needTP && needSL ? ' & ' : ''}${needSL ? 'SL' : ''}, kiểm tra position...`);
        (async () => {
          // Bước 1: kiểm tra position thực tế — tránh báo nhầm khi vị thế đã đóng
          const posAmt = await binanceTrader.getPositionAmt(trade.symbol).catch(() => null);
          if (posAmt !== null) {
            const expectedSign = trade.direction === 'LONG' ? 1 : -1;
            const hasPosition  = Math.sign(posAmt) === expectedSign && Math.abs(posAmt) > 0;
            if (!hasPosition) {
              log.warn(`Recovery: ${trade.symbol} — không có position trên Binance (posAmt=${posAmt}), đóng trade`);
              trade.status   = 'manual_close';
              trade.closedAt = new Date();
              saveTrades();

              const recSinceMs = trade.recommendedAt instanceof Date
                ? trade.recommendedAt.getTime()
                : new Date(trade.recommendedAt).getTime();
              const recCloseData = await binanceTrader.getRecentClosingTrades(
                trade.symbol, trade.direction, recSinceMs, trade.binanceQty
              ).catch(() => null);

              let recClosePrice = null, recRawPct = null, recResult = null;
              if (recCloseData) {
                recClosePrice = recCloseData.avgPrice;
                const { rawPct } = calcPnl(trade.entryPrice, recCloseData.avgPrice, trade.direction, trade.leverage);
                recRawPct = rawPct;
                recResult = rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven';
              }

              recordTradeResult({
                trade,
                exitReason: 'manual_close',
                result: recResult,
                closePrice: recClosePrice,
                pnlPct: recRawPct,
              });

              const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
              sendMessages([
                recCloseData
                  ? `✋ <b>ĐÓNG THỦ CÔNG — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `Không có position trên Binance — đã đóng thủ công.\n` +
                    `💰 Giá đóng: <code>${fmtPrice(recClosePrice)}</code>  PnL: <b>${recRawPct >= 0 ? '+' : ''}${recRawPct.toFixed(2)}%</b>\n` +
                    `<i>Đã ghi nhận vào lịch sử</i>`
                  : `ℹ️ <b>ĐÓNG TỰ ĐỘNG — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `Không tìm thấy position trên Binance — có thể đã đóng thủ công.\n` +
                    `⚠️ Không xác định được giá đóng — ghi history không PnL.`,
              ], 1500, NEWS_CHAT_ID).catch(() => {});
              return;
            }
          }

          // Bước 2: có position → đặt Dual Bracket nếu thiếu cả 2, hoặc bù lệnh thiếu
          if (needTP && needSL) {
            await bracketManager.placeDualBracket({
              client: binanceTrader,
              sym: trade.symbol,
              side: trade.direction === 'LONG' ? 'BUY' : 'SELL',
              qty: trade.binanceQty,
              entryPrice: trade.entryPrice,
              targetPrice: trade.targetPrice,
              slPrice: trade.slPrice,
              meta: trade,
            }).catch(e => {
              log.error(`Recovery: đặt Dual Bracket thất bại ${trade.symbol}`, { error: e.message });
              return null;
            });
          } else {
            if (needTP) {
              await binanceTrader.placeTPAfterEntry(trade).catch(e => {
                log.error(`Recovery: đặt TP thất bại ${trade.symbol}`, { error: e.message });
                return null;
              });
            }
            if (needSL) {
              await binanceTrader.placeSLAfterFill(trade).catch(e => {
                log.error(`Recovery: đặt Hard STOP_MARKET SL thất bại ${trade.symbol}`, { error: e.message });
                return null;
              });
            }
          }

          saveTrades();
          const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
          const tpStr = trade.binanceTpOrderId ? `🎯 TP sàn đã đặt:  <code>#${trade.binanceTpOrderId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>\n` : `⚠️ TP đặt thất bại — kiểm tra ngay!\n`;
          const slStr = trade.binanceSlOrderId ? `🛑 SL sàn đã đặt:  <code>#${trade.binanceSlOrderId}</code>  tại  <code>${fmtPrice(trade.slPrice)}</code>\n` : `⚠️ SL đặt thất bại — kiểm tra ngay!\n`;
          sendMessages([
            `🔄 <b>RECOVERY DUAL BRACKET — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            tpStr + slStr +
            `<i>⚡ Cặp lệnh TP/SL đã tự động đặt lại sau khi phát hiện thiếu trên Binance</i>`,
          ], 1500, NEWS_CHAT_ID).catch(() => {});
        })();
      }
    }

    // Recovery: manualEntry có binanceQty nhưng thiếu TP (targetPrice null hoặc chưa có order).
    // Thử phục hồi targetPrice từ trades.json (expired trade) rồi đặt TP — 1 lần/session.
    if (trade.entryFilled && trade.manualEntry && trade.binanceQty && binanceTrader.isEnabled()) {
      const needTpPlace = !trade.binanceTpOrderId;
      const needTpPrice = !trade.targetPrice;
      const recKey = `manual_tp_${trade.id}`;
      if ((needTpPlace || needTpPrice) && !_slTpRecoveryDone.has(recKey)) {
        _slTpRecoveryDone.add(recKey);
        (async () => {
          // Bước 1: phục hồi targetPrice từ expired trade
          // Ưu tiên: trades.json (24h) → trade_history.json (bot-placed, binanceEntryOrderId != null)
          if (needTpPrice) {
            try {
              let origin = null;
              if (fs.existsSync(TRADES_FILE)) {
                const rawAll = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
                const cutoff = Date.now() - 24 * 3_600_000;
                origin = rawAll.find(t =>
                  t.symbol === trade.symbol && t.direction === trade.direction &&
                  t.status !== 'active' &&
                  t.closedAt && new Date(t.closedAt).getTime() > cutoff &&
                  t.targetPrice && t.slPrice
                );
              }
              if (!origin && fs.existsSync(HISTORY_FILE)) {
                const rawHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                origin = rawHistory.findLast(t =>
                  t.symbol === trade.symbol && t.direction === trade.direction &&
                  t.binanceEntryOrderId &&
                  t.targetPrice && t.slPrice
                );
              }
              if (origin) {
                trade.targetPrice = origin.targetPrice;
                trade.targetPct   = origin.targetPct   ?? trade.targetPct;
                const _isLongR = trade.direction === 'LONG';
                const _originSlValidR = origin.slPrice != null && (_isLongR ? origin.slPrice < trade.entryPrice : origin.slPrice > trade.entryPrice);
                if (_originSlValidR) {
                  trade.slPrice = origin.slPrice;
                  trade.slPct   = origin.slPct   ?? trade.slPct;
                }
                trade.tp1Price    = origin.tp1Price    ?? trade.tp1Price;
                trade.tp2Price    = origin.tp2Price    ?? trade.tp2Price;
                saveTrades();
                log.warn(`Recovery manual: ${trade.symbol} ${trade.direction} — phục hồi TP/SL từ expired trade (TP=${fmtPrice(trade.targetPrice)} SL=${fmtPrice(trade.slPrice)})`);
              } else {
                  // Không tìm thấy expired record → tự tính TP1 tạm thời + trigger signal scan
                  const TAKER_FEE_PCT = 0.04; // 0.04% taker fee per side
                  const lev = trade.leverage || 10;
                  const tp1RawPct = 10 / lev + TAKER_FEE_PCT * 2;
                  const prec = trade.entryPrice >= 1 ? 2 : 6;
                  const isLongDir = trade.direction === 'LONG';
                  const autoTp1 = parseFloat((isLongDir
                    ? trade.entryPrice * (1 + tp1RawPct / 100)
                    : trade.entryPrice * (1 - tp1RawPct / 100)).toFixed(prec));
                  trade.tp1Price = autoTp1;
                  trade.tp1Pct   = parseFloat(tp1RawPct.toFixed(2));
                  const autoSl = calcLiqPrice(trade.entryPrice, trade.direction, trade.leverage);
                  if (autoSl && !trade.slPrice) {
                    trade.slPrice = autoSl;
                    trade.slPct   = parseFloat(((autoSl - trade.entryPrice) / trade.entryPrice * 100).toFixed(2));
                  }
                  saveTrades();
                  _pendingSignalScan = true;
                  const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
                  log.warn(`Recovery manual: ${trade.symbol} ${trade.direction} — không có expired record, tự tính TP1=${fmtPrice(autoTp1)}, trigger signal scan`);
                  sendMessages([
                    `⚠️ <b>THIẾU DỮ LIỆU TP/SL — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `Không tìm thấy khuyến nghị AI gốc (mất dữ liệu sau restart).\n` +
                    `TP1 tạm tính: <code>${fmtPrice(autoTp1)}</code> (+${tp1RawPct.toFixed(1)}% vốn)\n` +
                    `<i>Đang chạy lại phân tích AI để cập nhật TP/SL đầy đủ...</i>`,
                  ], 1500, NEWS_CHAT_ID).catch(() => {});
                  return;
              }
            } catch (e) {
              log.warn(`Recovery manual: không đọc được trades.json cho ${trade.symbol}`, { error: e.message });
              return;
            }
          }
          // Bước 2: đặt TP nếu chưa có order
          if (!trade.binanceTpOrderId && trade.targetPrice) {
            const tpId = await binanceTrader.placeTPAfterEntry(trade).catch(e => {
              log.error(`Recovery manual TP: thất bại ${trade.symbol}`, { error: e.message });
              return null;
            });
            if (tpId) saveTrades();
            const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
            sendMessages([
              tpId
                ? `🎯 <b>TP ĐÃ ĐẶT LẠI — ${trade.symbol} ${dirLabel}</b>\n` +
                  `TP LIMIT:  <code>#${tpId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>\n` +
                  `🛡️ SL client-side:  <code>${fmtPrice(trade.slPrice)}</code>\n` +
                  `<i>Phục hồi tự động sau khi bot restart</i>`
                : `⚠️ <b>TP thất bại — ${trade.symbol} ${dirLabel}</b>\nKiểm tra và đặt TP thủ công trên Binance!`,
            ], 1500, NEWS_CHAT_ID).catch(() => {});
          }
        })();
      }
    }

    // TP1 hit (+10% vốn) → dời SL về +1% lãi — chạm TRƯỚC, chỉ 1 lần
    if (trade.tp1Price && !trade.tp1Hit) {
      const tp1Reached = isLong ? price >= trade.tp1Price : price <= trade.tp1Price;
      if (tp1Reached) {
        const lev          = trade.leverage || 10;
        const rawPctFor1   = 1 / lev + TAKER_FEE * 2 * 100;
        const newSlPrice   = isLong
          ? parseFloat((trade.entryPrice * (1 + rawPctFor1 / 100)).toFixed(trade.entryPrice >= 1 ? 2 : 6))
          : parseFloat((trade.entryPrice * (1 - rawPctFor1 / 100)).toFixed(trade.entryPrice >= 1 ? 2 : 6));

        trade.tp1Hit             = true;
        trade.slMovedToBreakeven = true;
        trade.slPrice            = newSlPrice;
        saveTrades();
        const { rawPct: tp1Raw, netPct: tp1Net } = calcPnl(trade.entryPrice, trade.tp1Price, trade.direction, trade.leverage);
        log.trade(`TP1 ${trade.symbol} ${trade.direction} tại ${fmtPrice(price)} → dời SL về +1% lãi ${fmtPrice(newSlPrice)}`);

        if (binanceTrader.isEnabled() && (trade.binanceEntryOrderId || trade.binanceQty || trade.binanceSlOrderId)) {
          (async () => {
            const res = await bracketManager.ratchetBreakeven({
              client: binanceTrader,
              sym: trade.symbol,
              meta: trade,
              beSlPrice: newSlPrice,
            });
            if (res?.success) saveTrades();
          })();
        }

        sendMessages([
          `🏳️ <b>TP1 (+10% vốn) — ${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `💰 Entry:   <code>${fmtPrice(trade.entryPrice)}</code>\n` +
          `🏳️ TP1 hit: <code>${fmtPrice(price)}</code>  <b>+${tp1Raw.toFixed(2)}%</b>${trade.leverage ? `  <i>(vốn +${tp1Net.toFixed(1)}%)</i>` : ''}\n` +
          `🥈 TP2:     <code>${fmtPrice(trade.tp2Price)}</code>  <i>(1:1 R:R ban đầu)</i>\n` +
          `🎯 TP:      <code>${fmtPrice(trade.targetPrice)}</code>\n` +
          `🔒 SL mới:  <code>${fmtPrice(newSlPrice)}</code>  <i>(khoá lãi +1% vốn trên Binance)</i>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<i>💡 Vị thế vẫn mở, tiếp tục chạy về TP2 / TP</i>`,
        ]).catch(() => {});
      }
    }

    // Alert TP2 (1:1 R:R ban đầu) — chạm SAU, dời SL lên TP1 để khóa lãi
    if (trade.tp2Price && !trade.tp2Hit) {
      const tp2Reached = isLong ? price >= trade.tp2Price : price <= trade.tp2Price;
      if (tp2Reached) {
        trade.tp2Hit = true;
        saveTrades();
        const { rawPct: tp2Raw, netPct: tp2Net } = calcPnl(trade.entryPrice, trade.tp2Price, trade.direction, trade.leverage);
        log.trade(`TP2 ${trade.symbol} ${trade.direction} tại ${fmtPrice(price)}`);

        // Dynamic On-Exchange Ratchet: Dời SL sàn lên mức TP1 (+10% vốn) để khóa lãi
        if (trade.tp1Price && binanceTrader.isEnabled() && (trade.binanceEntryOrderId || trade.binanceQty || trade.binanceSlOrderId)) {
          (async () => {
            const res = await bracketManager.ratchetTrailingFractal({
              client: binanceTrader,
              sym: trade.symbol,
              meta: trade,
              newTrailingSlPrice: trade.tp1Price,
              label: 'TP2 Profit Lock',
            });
            if (res?.success) {
              trade.slPrice = trade.tp1Price;
              saveTrades();
            }
          })();
        }

        const slLine = trade.slMovedToBreakeven
          ? `🔒 SL:      <code>${fmtPrice(trade.slPrice)}</code>  <i>(khoá lãi trên sàn Binance)</i>\n`
          : `🛑 SL:      <code>${fmtPrice(trade.slPrice)}</code>\n`;
        sendMessages([
          `🥈 <b>TP2 (1:1 R:R ban đầu) — ${trade.symbol} ${isLong ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `💰 Entry:   <code>${fmtPrice(trade.entryPrice)}</code>\n` +
          `🥈 TP2 hit: <code>${fmtPrice(price)}</code>  <b>+${tp2Raw.toFixed(2)}%</b>${trade.leverage ? `  <i>(vốn +${tp2Net.toFixed(1)}%)</i>` : ''}\n` +
          `🎯 TP tiếp: <code>${fmtPrice(trade.targetPrice)}</code>\n` +
          slLine +
          `━━━━━━━━━━━━━━━━\n` +
          `<i>💡 Đã kích hoạt Trailing SL khóa lãi trên sàn Binance</i>`,
        ]).catch(() => {});
      }
    }

    // Guard: WS handler có thể đóng lệnh trong khi loop đang await → skip để tránh double-record
    if (trade.status !== 'active') continue;

    let hit = null;
    if (isLong) {
      if (trade.targetPrice != null && price >= trade.targetPrice) hit = 'TP';
      else if (trade.slPrice != null && price <= trade.slPrice) hit = 'SL';
    } else {
      if (trade.targetPrice != null && price <= trade.targetPrice) hit = 'TP';
      else if (trade.slPrice != null && price >= trade.slPrice) hit = 'SL';
    }

    if (!hit) continue;

    trade.status   = hit === 'TP' ? 'tp_hit' : 'sl_hit';
    trade.closedAt = new Date();
    saveTrades();

    // Client-side SL fallback: đặt MARKET close nếu giá chạm SL
    if (hit === 'SL' && binanceTrader.isEnabled() && trade.binanceQty) {
      binanceTrader.placeMarketClose(trade).catch(e => {
        log.error(`SL hit: MARKET close thất bại ${trade.symbol}`, { error: e.message });
      });
    }

    // Tự động dọn dẹp sạch lệnh đối ứng trên Binance (SL algo nếu TP hit, TP LIMIT nếu SL hit)
    if (binanceTrader.isEnabled()) {
      await bracketManager.autoCleanOppositeOrder({ client: binanceTrader, sym: trade.symbol, filledType: hit, meta: trade });
    }

    const closePrice = hit === 'TP' ? trade.targetPrice : trade.slPrice;
    const { rawPct, netPct, feeImpactPct } = calcPnl(trade.entryPrice, closePrice, trade.direction, trade.leverage);
    const isBreakevenAfterTp1 = hit === 'SL' && trade.tp1Hit;
    const tradeResult = isBreakevenAfterTp1 ? 'breakeven' : (rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven');
    const isWin   = hit === 'TP';
    const netSign = netPct >= 0 ? '+' : '';

    recordTradeResult({ trade, exitReason: hit === 'TP' ? 'tp' : 'sl', result: tradeResult, closePrice, pnlPct: rawPct });

    const duration = trade.closedAt - trade.recommendedAt;
    log.trade(`${hit} ${trade.symbol} ${trade.direction}`, {
      entry: trade.entryPrice, closePrice, rawPct: rawPct.toFixed(2), netPct: netPct.toFixed(2),
      leverage: trade.leverage, durationMs: duration,
    });

    const startStr = trade.recommendedAt.toLocaleString('vi-VN', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    });
    const endStr = trade.closedAt.toLocaleString('vi-VN', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    });

    const leverageLine = trade.leverage
      ? `⚡ x${trade.leverage} → vốn thực: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n`
      : '';
    const mfeLine = (!isWin && !isBreakevenAfterTp1 && (trade.mfePct || 0) > 0.05)
      ? `📈 Cao nhất: <code>${fmtPrice(trade.mfePrice)}</code>  <b>+${trade.mfePct.toFixed(2)}%</b>\n`
      : '';

    const manualTag = trade.manualEntry ? `  <i>(thủ công)</i>` : '';
    const msg = isBreakevenAfterTp1
      ? `🤝 <b>HÒA VỐN (sau TP1) — ${trade.symbol} ${trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}${manualTag}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Vào lệnh:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
        `🏳️ TP1 đã hit: <code>${fmtPrice(trade.tp1Price)}</code>\n` +
        `🤝 Đóng hòa:  <code>${fmtPrice(closePrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
        leverageLine +
        `\n` +
        `⌛ Giữ lệnh:  <b>${fmtDuration(duration)}</b>\n` +
        `📅 <i>${startStr} → ${endStr}</i>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>✅ TP1 hit → SL khoá vốn → đóng hòa</i>`
      : `${isWin ? '🏆' : '💥'} <b>${isWin ? 'CHỐT LỜI' : 'DÍNH SL'} — ${trade.symbol} ${trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}${manualTag}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Vào lệnh:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
        `${isWin ? '🎯 Chốt lời' : '🛑 Cắt lỗ'}:  <code>${fmtPrice(closePrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
        leverageLine +
        mfeLine +
        `\n` +
        `⌛ Giữ lệnh:  <b>${fmtDuration(duration)}</b>\n` +
        `📅 <i>${startStr} → ${endStr}</i>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>⚠️ Tham khảo mark price Futures</i>`;

    try {
      await sendMessages([msg]);
      log.telegram(`Gửi alert ${hit} ${trade.symbol} thành công`);
    } catch (e) {
      log.error(`Trade alert lỗi`, { error: e.message });
    }
  }

  // Dọn dẹp lệnh đã đóng > 24h
  const cutoff = Date.now() - 86400000;
  for (let i = activeTrades.length - 1; i >= 0; i--) {
    const t = activeTrades[i];
    if (t.status !== 'active' && t.closedAt && t.closedAt.getTime() < cutoff) {
      log.trade(`CLEANUP ${t.symbol} ${t.direction} (${t.status})`);
      activeTrades.splice(i, 1);
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function getActiveTrades() {
  return activeTrades.filter(t => t.status === 'active');
}

async function sendActiveTradesSummary(chatId = null) {
  const active = activeTrades.filter(t => t.status === 'active');
  if (!active.length) return;

  const lines = [
    `📋 <b>ĐANG THEO DÕI ${active.length} LỆNH</b>`,
    `━━━━━━━━━━━━━━━━`,
    '',
  ];

  for (const t of active) {
    const s = t.recommendedAt.toLocaleString('sv-SE', { timeZone: TIMEZONE });
    const [date, time] = s.split(' ');
    const [, mm, dd] = date.split('-');
    const sinceStr = `${time.slice(0, 5)} ${dd}-${mm}`;
    const duration = fmtDuration(Date.now() - t.recommendedAt.getTime());
    const liqPrice = calcLiqPrice(t.entryPrice, t.direction, t.leverage);
    const dirLabel = t.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    lines.push(`${dirLabel}${t.leverage ? ` ⚡x${t.leverage}` : ''} — <b>${t.symbol}</b>${t.entryFilled ? '' : '  <i>(chờ entry)</i>'}${t.manualEntry ? '  <i>(thủ công)</i>' : ''}`);
    lines.push(`  💰 Entry:  <code>${fmtPrice(t.entryPrice)}</code>`);
    lines.push(`  🎯 TP:  <code>${fmtPrice(t.targetPrice)}</code>  (+${t.targetPct}%)`);
    const slSuffix = t.slMovedToBreakeven ? `  <i>(+1% lãi)</i>` : `  (-${t.slPct}%)`;
    lines.push(`  🛑 SL:  <code>${fmtPrice(t.slPrice)}</code>${slSuffix}`);
    if (liqPrice) lines.push(`  💀 Thanh lý:  <code>${fmtPrice(liqPrice)}</code>`);
    if (t.tp1Price) {
      lines.push(`  🏳️ TP1: <code>${fmtPrice(t.tp1Price)}</code>`);
      lines.push(`  (+${t.tp1Pct}% giá → lãi +10% vốn)${t.tp1Hit ? '  ✅' : ''}`);
    }
    if (t.tp2Price) {
      lines.push(`  🥈 TP2: <code>${fmtPrice(t.tp2Price)}</code>`);
      lines.push(`  (+${t.tp2Pct}% → 1:1 R:R ban đầu)${t.tp2Hit ? '  ✅' : ''}`);
    }
    lines.push(` ⌛ <b>${duration}</b> (từ ${sinceStr})`);
    lines.push('');
  }

  lines.push(`━━━━━━━━━━━━━━━━`);
  lines.push(`<i>🤖 Bot tự động alert khi chạm TP/SL</i>`);

  try {
    await sendMessages([lines.join('\n')], 1500, chatId);
    log.telegram(`Gửi trade summary (${active.length} lệnh) thành công`);
  } catch (e) {
    log.error('Không thể gửi trade summary', { error: e.message });
  }
}

// ─── Backtest: klines 15m — Binance trước, OKX fallback ──────────────────────

/**
 * Tải nến lịch sử 15m cho backtest. Binance ưu tiên, OKX fallback.
 * Trả về mảng candle: [ts, open, high, low, close, ...] — tăng dần theo thời gian.
 */
async function fetchKlines(symbol, startMs, endMs) {
  // 1. Binance Futures mark price klines (ưu tiên, hỗ trợ startTime)
  try {
    const candles = [];
    let curStart = startMs;
    while (curStart < endMs) {
      const { data } = await axios.get('https://fapi.binance.com/fapi/v1/markPriceKlines', {
        headers: HEADERS, timeout: 15000,
        params: { symbol: `${symbol}USDT`, interval: '15m', startTime: curStart, limit: 1000 },
      });
      if (!Array.isArray(data) || !data.length) break;
      for (const k of data) {
        if (k[0] <= endMs) candles.push(k); // [openTime, o, h, l, c, ...]
      }
      const lastTs = data[data.length - 1][0];
      if (lastTs >= endMs || data.length < 1000) break;
      curStart = lastTs + 1;
    }
    if (candles.length > 0) {
      log.system(`Backtest ${symbol}: ${candles.length} nến 15m (Binance)`);
      return candles; // Binance đã tăng dần
    }
  } catch (err) {
    log.warn(`Backtest ${symbol}: Binance thất bại, thử OKX`, { error: err.message });
  }

  // 2. OKX fallback — mark price history candles với pagination
  const candles = [];
  const intervalMs = 15 * 60 * 1000;
  const instId = `${symbol}-USDT-SWAP`;
  let afterTs = endMs + intervalMs;

  while (true) {
    const { data } = await axios.get('https://www.okx.com/api/v5/market/history-mark-price-candles', {
      headers: HEADERS, timeout: 15000,
      params: { instId, bar: '15m', after: String(afterTs), limit: 100 },
    });
    const list = data.data;
    if (!list?.length) break;
    for (const c of list) {
      if (parseInt(c[0]) >= startMs) candles.push(c);
    }
    const oldestTs = parseInt(list[list.length - 1][0]);
    if (oldestTs <= startMs || list.length < 100) break;
    afterTs = oldestTs;
  }

  candles.reverse(); // OKX trả về giảm dần → đảo lại
  log.system(`Backtest ${symbol}: ${candles.length} nến 15m (OKX fallback)`);
  return candles;
}

/**
 * Quét candles để tìm nến đầu tiên chạm TP hoặc SL.
 * Bỏ qua candles cho đến khi giá chạm vùng entry trước.
 * Khi cả TP và SL cùng trong 1 nến → ưu tiên SL (thận trọng hơn).
 */
function scanForHit(trade, candles) {
  const isLong = trade.direction === 'LONG';
  let entryFilled = !!trade.entryFilled;

  for (const c of candles) {
    const high = parseFloat(c[2]);
    const low  = parseFloat(c[3]);

    if (!entryFilled) {
      const entryReached = isLong
        ? low <= trade.entryPrice * 1.003
        : high >= trade.entryPrice * 0.997;
      if (!entryReached) continue;
      entryFilled = true;
    }

    const tpHit = isLong ? high >= trade.targetPrice : low  <= trade.targetPrice;
    const slHit = isLong ? low  <= trade.slPrice     : high >= trade.slPrice;
    if (slHit) return { hit: 'SL', hitAt: new Date(c[0]), hitPrice: trade.slPrice };
    if (tpHit) return { hit: 'TP', hitAt: new Date(c[0]), hitPrice: trade.targetPrice };
  }
  return null;
}

/**
 * Chạy backtest cho tất cả lệnh đang active:
 * - Tải klines từ lúc AI khuyến nghị đến giờ
 * - Tìm TP/SL đã chạm chưa, ghi kết quả, gửi Telegram alert
 * - Trả về số lệnh đã xử lý
 */
async function runBacktest() {
  const pending = activeTrades.filter(t => t.status === 'active');
  if (!pending.length) {
    log.system('Backtest: không có lệnh active cần kiểm tra');
    return { checked: 0, closed: 0 };
  }

  log.system(`Backtest bắt đầu: ${pending.length} lệnh active cần kiểm tra`);
  let closed = 0;

  for (const trade of pending) {
    const fromMs = new Date(trade.recommendedAt).getTime();
    const toMs   = Date.now();
    const hoursAgo = ((toMs - fromMs) / 3600000).toFixed(1);

    log.system(`Backtest ${trade.symbol} ${trade.direction}: fetch klines (~${hoursAgo}h)`);

    let candles;
    try {
      candles = await fetchKlines(trade.symbol, fromMs, toMs);
      log.system(`Backtest ${trade.symbol}: ${candles.length} nến 15m`);
    } catch (e) {
      log.warn(`Backtest: lỗi fetch klines ${trade.symbol}`, { error: e.message });
      continue;
    }

    const result = scanForHit(trade, candles);
    if (!result) {
      log.system(`Backtest ${trade.symbol}: chưa chạm TP/SL — vẫn đang active`);
      continue;
    }

    closed++;
    trade.status   = result.hit === 'TP' ? 'tp_hit' : 'sl_hit';
    trade.closedAt = result.hitAt;
    saveTrades();

    const { rawPct, netPct, feeImpactPct } = calcPnl(trade.entryPrice, result.hitPrice, trade.direction, trade.leverage);
    const isWin   = result.hit === 'TP';
    const netSign = netPct >= 0 ? '+' : '';
    recordTradeResult({ trade, exitReason: result.hit === 'TP' ? 'tp' : 'sl', result: rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven', closePrice: result.hitPrice, pnlPct: rawPct });
    const duration = result.hitAt - new Date(trade.recommendedAt);
    const levLine  = trade.leverage
      ? `⚡ x${trade.leverage} → vốn thực: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n`
      : '';
    const recStr  = new Date(trade.recommendedAt).toLocaleString('vi-VN', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    });
    const hitStr  = result.hitAt.toLocaleString('vi-VN', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    });

    log.trade(`[BACKTEST] ${result.hit} ${trade.symbol} ${trade.direction}`, {
      rawPct: rawPct.toFixed(2), netPct: netPct.toFixed(2), hitPrice: result.hitPrice, durationMs: duration,
    });

    await sendMessages([
      `${isWin ? '🏆' : '💥'} <b>[BACKTEST] ${isWin ? 'CHỐT LỜI' : 'DÍNH SL'} — ${trade.symbol} ${trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Vào lệnh:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
      `${isWin ? '🎯 Chốt lời' : '🛑 Cắt lỗ'}:  <code>${fmtPrice(result.hitPrice)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
      levLine +
      `\n⌛ Giữ lệnh:  <b>${fmtDuration(duration)}</b>\n` +
      `📅 <i>${recStr} → ${hitStr}</i>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `<i>📊 Dữ liệu nến 15m từ Binance Futures</i>`,
    ]).catch(e => log.error('Backtest alert lỗi', { error: e.message }));
  }

  log.system(`Backtest hoàn thành: ${pending.length} kiểm tra, ${closed} lệnh đã đóng, ${pending.length - closed} còn active`);
  return { checked: pending.length, closed };
}

// ─── Mark price WebSocket — real-time SL monitor ─────────────────────────────

/**
 * Mở WebSocket mark price cho symbol. Check TP1/TP2/SL real-time (~3s).
 * TP final không check ở đây — do Binance LIMIT order + user data stream xử lý.
 * Tự reconnect nếu mất kết nối và vẫn còn lệnh active.
 */
function _doRebuildCombinedMpWs() {
  const symbols = [..._combinedMpSymbols];
  if (!symbols.length) return;

  if (_combinedMpWs) {
    try { _combinedMpWs.terminate(); } catch {}
    _combinedMpWs = null;
  }

  const streams = symbols.map(s => `${s.toLowerCase()}usdt@markPrice`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
  _combinedMpWs = ws;
  log.system(`Mark price WS: combined stream [${symbols.join(',')}]`);

  ws.on('message', async (raw) => {
    let streamData;
    try { const d = JSON.parse(raw); streamData = d.data || d; } catch { return; }
    const rawSym    = (streamData.s || '').toUpperCase();
    const symbol    = rawSym.endsWith('USDT') ? rawSym.slice(0, -4) : rawSym;
    const markPrice = parseFloat(streamData.p);
    if (!symbol || !markPrice || isNaN(markPrice)) return;

    _lastMarkPrices[symbol] = markPrice;

    // ─── Tích hợp Phase 4: Real-time BTC Flash Guard 0ms ───────────────
    if (symbol === 'BTC') {
      try {
        const btcFlashGuard = require('./btcFlashGuard');
        btcFlashGuard.processBtcTick(markPrice);
      } catch (_) {}
    }

    // ─── Tích hợp Phase 4: Bounce Cancel cho pending Limit orders ─────────
    try {
      const { checkBounceCancel } = require('./bounceCancel');
      const pendingLimits = activeTrades.filter(t => t.status === 'active' && !t.entryFilled && t.symbol === symbol);
      for (const pTrade of pendingLimits) {
        const { shouldCancel, reason } = checkBounceCancel(pTrade, markPrice);
        if (shouldCancel) {
          log.warn(`[TradeMonitor] Bounce Cancel: Hủy lệnh LIMIT ${symbol} vì nảy mốc: ${reason}`);
          pTrade.status = 'canceled';
          pTrade.closedAt = new Date();
          pTrade.cancelReason = 'bounce_cancel';
          saveTrades();
          _wsBroadcast('trades', activeTrades.filter(t => t.status === 'active'));
          if (binanceTrader.isEnabled() && pTrade.binanceEntryOrderId) {
            binanceTrader.cancelEntryOrder(pTrade).catch(() => {});
          }
        }
      }
    } catch (_) {}

    // ─── Tích hợp Phase 5: Cập nhật giá cho Shadow Tracker ────────────────
    try {
      const shadowTracker = require('./shadowTracker');
      shadowTracker.updateShadowPrices({ [symbol]: markPrice });
    } catch (_) {}

    const trades = activeTrades.filter(t => t.status === 'active' && t.entryFilled && t.symbol === symbol);
    if (trades.length === 0) {
      _combinedMpSymbols.delete(symbol);
      clearTimeout(_combinedMpRebuildTimer);
      _combinedMpRebuildTimer = setTimeout(_doRebuildCombinedMpWs, 500);
      return;
    }

    for (const trade of trades) {
      const isLong   = trade.direction === 'LONG';
      const dirLabel = isLong ? '🟢 LONG' : '🔴 SHORT';

      // ── MFE tracking ─────────────────────────────────────────────────────
      if (trade.entryPrice) {
        const mfePct = isLong
          ? (markPrice - trade.entryPrice) / trade.entryPrice * 100
          : (trade.entryPrice - markPrice) / trade.entryPrice * 100;
        if (mfePct > (trade.mfePct || 0)) {
          trade.mfePct   = mfePct;
          trade.mfePrice = markPrice;
        }
      }

      // ── TP1 hit (+10% vốn) → dời SL về +1% lãi ─────────────────────────
      if (trade.tp1Price && !trade.tp1Hit) {
        const tp1Reached = isLong ? markPrice >= trade.tp1Price : markPrice <= trade.tp1Price;
        if (tp1Reached) {
          const lev        = trade.leverage || 10;
          const rawPctFor1 = 1 / lev + TAKER_FEE * 2 * 100;
          const newSlPrice = isLong
            ? parseFloat((trade.entryPrice * (1 + rawPctFor1 / 100)).toFixed(trade.entryPrice >= 1 ? 2 : 6))
            : parseFloat((trade.entryPrice * (1 - rawPctFor1 / 100)).toFixed(trade.entryPrice >= 1 ? 2 : 6));

          trade.tp1Hit             = true;
          trade.slMovedToBreakeven = true;
          trade.slPrice            = newSlPrice;
          saveTrades();
          const { rawPct: tp1Raw, netPct: tp1Net } = calcPnl(trade.entryPrice, trade.tp1Price, trade.direction, trade.leverage);
          log.trade(`WS TP1 ${symbol} ${trade.direction} tại ${fmtPrice(markPrice)} → dời SL về +1% lãi ${fmtPrice(newSlPrice)}`);
          if (binanceTrader.isEnabled() && (trade.binanceEntryOrderId || trade.binanceQty || trade.binanceSlOrderId)) {
            (async () => {
              const res = await bracketManager.ratchetBreakeven({
                client: binanceTrader,
                sym: trade.symbol,
                meta: trade,
                beSlPrice: newSlPrice,
              });
              if (res?.success) saveTrades();
            })();
          }
          sendMessages([
            `🏳️ <b>TP1 (+10% vốn) — ${symbol} ${dirLabel}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `💰 Entry:   <code>${fmtPrice(trade.entryPrice)}</code>\n` +
            `🏳️ TP1 hit: <code>${fmtPrice(markPrice)}</code>  <b>+${tp1Raw.toFixed(2)}%</b>${trade.leverage ? `  <i>(vốn +${tp1Net.toFixed(1)}%)</i>` : ''}\n` +
            `🥈 TP2:     <code>${fmtPrice(trade.tp2Price)}</code>  <i>(1:1 R:R ban đầu)</i>\n` +
            `🎯 TP:      <code>${fmtPrice(trade.targetPrice)}</code>\n` +
            `🔒 SL mới:  <code>${fmtPrice(newSlPrice)}</code>  <i>(khoá lãi +1% vốn trên Binance)</i>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `<i>💡 Vị thế vẫn mở, tiếp tục chạy về TP2 / TP</i>`,
          ]).catch(() => {});
        }
      }

      // ── Alert TP2 (1:1 R:R) & Dời Trailing SL khóa lãi trên sàn ──────────
      if (trade.tp2Price && !trade.tp2Hit) {
        const tp2Reached = isLong ? markPrice >= trade.tp2Price : markPrice <= trade.tp2Price;
        if (tp2Reached) {
          trade.tp2Hit = true;
          saveTrades();
          const { rawPct: tp2Raw, netPct: tp2Net } = calcPnl(trade.entryPrice, trade.tp2Price, trade.direction, trade.leverage);
          log.trade(`WS TP2 ${symbol} ${trade.direction} tại ${fmtPrice(markPrice)}`);

          // Dynamic On-Exchange Ratchet: Dời SL sàn lên mức TP1 (+10% vốn) để khóa lãi
          if (trade.tp1Price && binanceTrader.isEnabled() && (trade.binanceEntryOrderId || trade.binanceQty || trade.binanceSlOrderId)) {
            (async () => {
              const res = await bracketManager.ratchetTrailingFractal({
                client: binanceTrader,
                sym: trade.symbol,
                meta: trade,
                newTrailingSlPrice: trade.tp1Price,
                label: 'TP2 Profit Lock',
              });
              if (res?.success) {
                trade.slPrice = trade.tp1Price;
                saveTrades();
              }
            })();
          }

          const slLine = trade.slMovedToBreakeven
            ? `🔒 SL:      <code>${fmtPrice(trade.slPrice)}</code>  <i>(khoá lãi trên sàn Binance)</i>\n`
            : `🛑 SL:      <code>${fmtPrice(trade.slPrice)}</code>\n`;
          sendMessages([
            `🥈 <b>TP2 (1:1 R:R ban đầu) — ${symbol} ${dirLabel}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `💰 Entry:   <code>${fmtPrice(trade.entryPrice)}</code>\n` +
            `🥈 TP2 hit: <code>${fmtPrice(markPrice)}</code>  <b>+${tp2Raw.toFixed(2)}%</b>${trade.leverage ? `  <i>(vốn +${tp2Net.toFixed(1)}%)</i>` : ''}\n` +
            `🎯 TP tiếp: <code>${fmtPrice(trade.targetPrice)}</code>\n` +
            slLine +
            `━━━━━━━━━━━━━━━━\n` +
            `<i>💡 Đã kích hoạt Trailing SL khóa lãi trên sàn Binance</i>`,
          ]).catch(() => {});
        }
      }

      // ── SL hit → đóng vị thế ─────────────────────────────────────────────
      const slHit = isLong ? markPrice <= trade.slPrice : markPrice >= trade.slPrice;
      if (!slHit) continue;

      trade.status   = 'sl_hit';
      trade.closedAt = new Date();
      saveTrades();

      log.trade(`WS SL hit ${symbol} — mark=${fmtPrice(markPrice)}, sl=${fmtPrice(trade.slPrice)}`);

      if (binanceTrader.isEnabled()) {
        if (trade.binanceQty) {
          binanceTrader.placeMarketClose(trade).catch(e =>
            log.error(`WS SL: MARKET close thất bại ${symbol}`, { error: e.message })
          );
        }
        await bracketManager.autoCleanOppositeOrder({ client: binanceTrader, sym: trade.symbol, filledType: 'SL', meta: trade });
      }

      const closePrice = trade.slPrice;
      const { rawPct, netPct, feeImpactPct } = calcPnl(trade.entryPrice, closePrice, trade.direction, trade.leverage);
      trade.mfePct   = trade.mfePct   || 0;
      trade.mfePrice = trade.mfePrice || trade.entryPrice;
      recordTradeResult({ trade, exitReason: 'sl', result: rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven', closePrice, pnlPct: rawPct });

      const netSign  = netPct >= 0 ? '+' : '';
      const duration = trade.closedAt - new Date(trade.recommendedAt);
      const startStr = new Date(trade.recommendedAt).toLocaleString('vi-VN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
      const endStr   = trade.closedAt.toLocaleString('vi-VN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
      const leverageLine = trade.leverage
        ? `⚡ x${trade.leverage} → vốn thực: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n`
        : '';
      const mfeLine = trade.mfePct > 0.05
        ? `📈 Cao nhất: <code>${fmtPrice(trade.mfePrice)}</code>  <b>+${trade.mfePct.toFixed(2)}%</b>\n`
        : '';

      sendMessages([
        `💥 <b>DÍNH SL — ${symbol} ${dirLabel}${trade.leverage ? ` ⚡x${trade.leverage}` : ''}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Vào lệnh:  <code>${fmtPrice(trade.entryPrice)}</code>\n` +
        `🛑 Cắt lỗ:   <code>${fmtPrice(closePrice)}</code>  <b>${rawPct.toFixed(2)}%</b>\n` +
        leverageLine +
        mfeLine +
        `\n⌛ Giữ lệnh:  <b>${fmtDuration(duration)}</b>\n` +
        `📅 <i>${startStr} → ${endStr}</i>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>⚡ Real-time mark price</i>`,
      ]).catch(() => {});
    }

    // Broadcast ALL active trades to dashboard WS
    if (_wsPushFns.length) {
      const allFilled = activeTrades.filter(t => t.status === 'active' && t.entryFilled);
      const items = allFilled.map(t => {
        const mp = _lastMarkPrices[t.symbol];
        if (mp == null) return null;
        const isLong = t.direction === 'LONG';
        const rawPct = t.entryPrice
          ? (isLong ? (mp - t.entryPrice) / t.entryPrice * 100
                    : (t.entryPrice - mp) / t.entryPrice * 100)
          : null;
        const range = (t.targetPct ?? 0) + (t.slPct ?? 0);
        const progress = rawPct != null && range > 0
          ? Math.max(0, Math.min(100, (rawPct + (t.slPct ?? 0)) / range * 100)) : 50;
        return {
          id: t.id,
          currentPrice: mp,
          unrealizedPct: rawPct != null ? parseFloat(rawPct.toFixed(3)) : null,
          progress: parseFloat(progress.toFixed(1)),
        };
      }).filter(Boolean);
      if (items.length) _wsBroadcast('price', items);
    }
  });

  ws.on('close', () => {
    _combinedMpWs = null;
    if (_combinedMpSymbols.size > 0) {
      log.warn('Mark price WS: mất kết nối — reconnect sau 5s');
      setTimeout(_doRebuildCombinedMpWs, 5000);
    }
  });

  ws.on('error', (err) => {
    log.warn('Mark price WS: lỗi combined stream', { error: err.message });
  });
}

function ensureMarkPriceWS(symbol) {
  if (_combinedMpSymbols.has(symbol)) return;
  _combinedMpSymbols.add(symbol);
  clearTimeout(_combinedMpRebuildTimer);
  _combinedMpRebuildTimer = setTimeout(_doRebuildCombinedMpWs, 500);
}

// ─── Binance WebSocket fill handler ──────────────────────────────────────────

/**
 * Đăng ký callback với binanceStream để nhận mọi event ORDER_TRADE_UPDATE (FILLED).
 * Xử lý 4 loại fill: entry, TP, SL, và đóng thủ công.
 * Hàm này phải gọi 1 lần duy nhất khi khởi động (trước startStream).
 */
function initBinanceStream() {
  binanceStream.onEntryFill(async ({ orderId, symbol, avgPrice, side, reduceOnly, algoId, orderType }) => {

    // ── Entry fill ──────────────────────────────────────────────────────────────
    const trade = activeTrades.find(
      t => t.status === 'active' &&
        (String(t.binanceEntryOrderId) === String(orderId) || (!t.binanceEntryOrderId && t.symbol === symbol && !t.entryFilled)) &&
        !t.entryFilled
    );
    if (trade) {
      trade.entryFilled = true;
      try { require('./bounceCancel').untrackLimit(trade.symbol, trade.targetLevel || trade.entryPrice); } catch (_) {}

      // Cập nhật TP1 (+10% vốn) theo giá fill thực tế (chính xác hơn entryPrice limit)
      if (avgPrice > 0) {
        const isLong    = trade.direction === 'LONG';
        const lev       = trade.leverage || 10;
        const tp1RawPct = 10 / lev + TAKER_FEE * 2 * 100;
        const tp1Price  = isLong
          ? avgPrice * (1 + tp1RawPct / 100)
          : avgPrice * (1 - tp1RawPct / 100);
        trade.tp1Price = parseFloat(tp1Price.toFixed(2));
        trade.tp1Pct   = parseFloat(tp1RawPct.toFixed(2));
      }

      saveTrades();
      ensureMarkPriceWS(trade.symbol);
      log.trade(`WS: entry fill ${trade.symbol} ${trade.direction} orderId=${orderId} avgPrice=${avgPrice}`);

      // Đặt cặp bảo vệ kép On-Exchange Dual Bracket (LIMIT TP & Hard STOP_MARKET SL) trên Binance
      await bracketManager.placeDualBracket({
        client: binanceTrader,
        sym: trade.symbol,
        side: trade.direction === 'LONG' ? 'BUY' : 'SELL',
        qty: trade.binanceQty,
        entryPrice: avgPrice,
        targetPrice: trade.targetPrice,
        slPrice: trade.slPrice,
        meta: trade,
      }).catch(e => {
        log.warn(`WS: đặt Dual Bracket thất bại ${trade.symbol}`, { error: e.message });
        return null;
      });

      saveTrades();
      const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const tpStr = trade.binanceTpOrderId ? `🎯 TP sàn đã đặt:  <code>#${trade.binanceTpOrderId}</code>  tại  <code>${fmtPrice(trade.targetPrice)}</code>\n` : `⚠️ TP đặt thất bại — kiểm tra ngay!\n`;
      const slStr = trade.binanceSlOrderId ? `🛑 SL sàn đã đặt:  <code>#${trade.binanceSlOrderId}</code>  tại  <code>${fmtPrice(trade.slPrice)}</code>\n` : `⚠️ SL đặt thất bại — kiểm tra ngay!\n`;
      sendMessages([
        `🎯 <b>ENTRY FILL (Dual Bracket) — ${trade.symbol} ${dirLabel} ⚡x${trade.leverage || 10}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💹 Fill tại:   <code>${fmtPrice(avgPrice)}</code>\n` +
        tpStr + slStr +
        `<i>⚡ Cặp lệnh TP/SL đã treo trực tiếp trên Binance (bảo vệ thảm họa 100%)</i>`,
      ], 1500, NEWS_CHAT_ID).catch(() => {});
      return;
    }

    // ── TP fill: TAKE_PROFIT_MARKET tại targetPrice → vị thế đóng ──────────────
    const tpTrade = activeTrades.find(
      t => t.status === 'active' && String(t.binanceTpOrderId) === String(orderId)
    );
    if (tpTrade) {
      await bracketManager.autoCleanOppositeOrder({ client: binanceTrader, sym: tpTrade.symbol, filledType: 'TP', meta: tpTrade });
      tpTrade.status   = 'tp_hit';
      tpTrade.closedAt = new Date();
      saveTrades();
      const fillPx   = avgPrice > 0 ? avgPrice : tpTrade.targetPrice;
      const dirLabel = tpTrade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const { rawPct, netPct, feeImpactPct } = calcPnl(tpTrade.entryPrice, fillPx, tpTrade.direction, tpTrade.leverage);
      log.trade(`WS: TP fill ${tpTrade.symbol} — vị thế đã đóng`);
      recordTradeResult({ trade: tpTrade, exitReason: 'tp', result: rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven', closePrice: fillPx, pnlPct: rawPct });
      sendMessages([
        `🏆 <b>CHỐT LỜI (Binance) — ${tpTrade.symbol} ${dirLabel}${tpTrade.leverage ? ` ⚡x${tpTrade.leverage}` : ''}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Entry:    <code>${fmtPrice(tpTrade.entryPrice)}</code>\n` +
        `🎯 TP fill:  <code>${fmtPrice(fillPx)}</code>  <b>+${rawPct.toFixed(2)}%</b>${tpTrade.leverage ? `  <i>(vốn +${netPct.toFixed(1)}%,  phí -${feeImpactPct.toFixed(2)}%)</i>` : ''}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>Vị thế tự đóng tại TP trên Binance</i>`,
      ], 1500, NEWS_CHAT_ID).catch(() => {});
      return;
    }

    // ── SL fill: STOP_MARKET kích hoạt → vị thế đóng ───────────────────────────
    const slTrade = activeTrades.find(
      t => t.status === 'active' && (
        String(t.binanceSlOrderId) === String(orderId) ||
        (algoId && String(t.binanceSlOrderId) === String(algoId)) ||
        (orderType === 'STOP_MARKET' && t.symbol === symbol)
      )
    );
    if (slTrade) {
      await bracketManager.autoCleanOppositeOrder({ client: binanceTrader, sym: slTrade.symbol, filledType: 'SL', meta: slTrade });
      slTrade.status   = 'sl_hit';
      slTrade.closedAt = new Date();
      saveTrades();
      const fillPx   = avgPrice > 0 ? avgPrice : slTrade.slPrice;
      const dirLabel = slTrade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      const { rawPct, netPct, feeImpactPct } = calcPnl(slTrade.entryPrice, fillPx, slTrade.direction, slTrade.leverage);
      const netSign  = netPct >= 0 ? '+' : '';
      const duration = slTrade.closedAt - new Date(slTrade.recommendedAt);
      const startStr = new Date(slTrade.recommendedAt).toLocaleString('vi-VN', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
      });
      const endStr   = slTrade.closedAt.toLocaleString('vi-VN', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
      });
      const leverageLine = slTrade.leverage
        ? `⚡ x${slTrade.leverage} → vốn thực: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n`
        : '';
      const mfeLine = (slTrade.mfePct || 0) > 0.05
        ? `📈 Cao nhất: <code>${fmtPrice(slTrade.mfePrice)}</code>  <b>+${slTrade.mfePct.toFixed(2)}%</b>\n`
        : '';
      log.trade(`WS: SL fill ${slTrade.symbol} — vị thế đã đóng tại ${fillPx}`);
      recordTradeResult({ trade: slTrade, exitReason: 'sl', result: rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven', closePrice: fillPx, pnlPct: rawPct });
      sendMessages([
        `💥 <b>DÍNH SL (Binance) — ${slTrade.symbol} ${dirLabel}${slTrade.leverage ? ` ⚡x${slTrade.leverage}` : ''}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Entry:    <code>${fmtPrice(slTrade.entryPrice)}</code>\n` +
        `🛑 SL fill:  <code>${fmtPrice(fillPx)}</code>  <b>${rawPct.toFixed(2)}%</b>\n` +
        leverageLine +
        mfeLine +
        `⌛ Giữ lệnh: <b>${fmtDuration(duration)}</b>  —  <i>${startStr} → ${endStr}</i>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>Vị thế tự đóng tại SL trên Binance</i>`,
      ], 1500, NEWS_CHAT_ID).catch(() => {});
      return;
    }

    // ── Manual close: fill không thuộc order nào của bot → đóng thủ công ────────
    const manualTrade = activeTrades.find(t => {
      if (t.status !== 'active' || !t.entryFilled || !t.binanceEntryOrderId) return false;
      if (t.symbol !== symbol) return false;
      const isOurOrder = String(orderId) === String(t.binanceEntryOrderId) ||
                         String(orderId) === String(t.binanceTpOrderId)   ||
                         String(orderId) === String(t.binanceSlOrderId);
      return !isOurOrder;
    });
    if (manualTrade) {
      const t = manualTrade;
      if (t.binanceTpOrderId) {
        binanceTrader.cancelOrderById(t.symbol, t.binanceTpOrderId).catch(() => {});
        t.binanceTpOrderId = null;
      }
      if (t.binanceSlOrderId) {
        binanceTrader.cancelAlgoOrderById(t.binanceSlOrderId).catch(() => {});
        t.binanceSlOrderId = null;
      }
      t.status   = 'manual_close';
      t.closedAt = new Date();
      saveTrades();

      const fillPx   = avgPrice > 0 ? avgPrice : t.entryPrice;
      const isLong   = t.direction === 'LONG';
      const dirLabel = isLong ? '🟢 LONG' : '🔴 SHORT';
      const { rawPct, netPct, feeImpactPct } = calcPnl(t.entryPrice, fillPx, t.direction, t.leverage);
      const netSign  = netPct >= 0 ? '+' : '';
      const duration = t.closedAt - new Date(t.recommendedAt);
      const startStr = new Date(t.recommendedAt).toLocaleString('vi-VN', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
      });
      const endStr   = t.closedAt.toLocaleString('vi-VN', {
        timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
      });

      // Khoảng cách từ giá đóng đến TP / SL hiện tại (tính theo % entry)
      const toTpPct   = isLong
        ? (t.targetPrice - fillPx) / t.entryPrice * 100
        : (fillPx - t.targetPrice) / t.entryPrice * 100;
      const fromSlPct = isLong
        ? (fillPx - t.slPrice) / t.entryPrice * 100
        : (t.slPrice - fillPx) / t.entryPrice * 100;

      const leverageLine = t.leverage
        ? `⚡ x${t.leverage} → vốn thực: <b>${netSign}${netPct.toFixed(1)}%</b>  <i>(phí -${feeImpactPct.toFixed(2)}%)</i>\n`
        : '';
      const mfeLine = (t.mfePct || 0) > 0.05
        ? `📈 Cao nhất: <code>${fmtPrice(t.mfePrice)}</code>  <b>+${t.mfePct.toFixed(2)}%</b>\n`
        : '';
      const slLabel = t.slMovedToBreakeven ? `${fmtPrice(t.slPrice)}  <i>(+1% lãi)</i>` : fmtPrice(t.slPrice);

      log.trade(`WS: manual close ${t.symbol} ${t.direction} fillPx=${fillPx} rawPct=${rawPct.toFixed(2)}%`);
      recordTradeResult({ trade: t, exitReason: 'manual_close', result: rawPct > 0 ? 'win' : rawPct < 0 ? 'loss' : 'breakeven', closePrice: fillPx, pnlPct: rawPct });

      const manualEntryTag = t.manualEntry ? `  <i>(thủ công)</i>` : '';
      const tpSlLines = t.manualEntry
        ? (t.targetPrice ? `🎯 TP:        <code>${fmtPrice(t.targetPrice)}</code>` + (toTpPct > 0.01 ? `  <i>[còn ${toTpPct.toFixed(2)}%]</i>` : `  <i>[đã qua TP]</i>`) + `\n` : '') +
          (t.slPrice ? `🛑 SL:        <code>${slLabel}</code>` + (fromSlPct > 0.01 ? `  <i>[cách ${fromSlPct.toFixed(2)}%]</i>` : `  <i>[dưới SL]</i>`) + `\n` : '')
        : `🎯 TP (AI):   <code>${fmtPrice(t.targetPrice)}</code>  (+${t.targetPct}%)` +
          (toTpPct > 0.01 ? `  <i>[chưa đạt — còn ${toTpPct.toFixed(2)}%]</i>` : `  <i>[đã qua TP]</i>`) + `\n` +
          `🛑 SL hiện:   <code>${slLabel}</code>` +
          (fromSlPct > 0.01 ? `  <i>[cách ${fromSlPct.toFixed(2)}%]</i>` : `  <i>[dưới SL]</i>`) + `\n`;
      sendMessages([
        `🔒 <b>ĐÓNG THỦ CÔNG — ${t.symbol} ${dirLabel}${t.leverage ? ` ⚡x${t.leverage}` : ''}${manualEntryTag}</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💰 Entry:     <code>${fmtPrice(t.entryPrice)}</code>\n` +
        `📤 Đóng tại:  <code>${fmtPrice(fillPx)}</code>  <b>${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(2)}%</b>\n` +
        leverageLine +
        mfeLine +
        `\n` +
        tpSlLines +
        `\n` +
        `⌛ Giữ lệnh:  <b>${fmtDuration(duration)}</b>  —  <i>${startStr} → ${endStr}</i>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<i>🤖 Bot đã hủy theo dõi lệnh này</i>`,
      ], 1500, NEWS_CHAT_ID).catch(() => {});
    }

    // ── Manual entry: fill không thuộc bot + không phải reduce-only → vị thế mới thủ công ──
    if (!reduceOnly) {
      const known = activeTrades.some(
        t => orderId === t.binanceEntryOrderId || orderId === t.binanceTpOrderId || orderId === t.binanceSlOrderId
      );
      if (!known) {
        log.trade(`WS: manual entry ${symbol} #${orderId} — gọi syncManualPositions`);
        syncManualPositions('ws').catch(e => log.warn('syncManualPositions từ WS lỗi', { error: e.message }));
      }
    }
  });

  // ── TP order bị cancel thủ công → xóa tpOrderId để recovery đặt lại ──────────
  binanceStream.onOrderCancel(({ orderId, symbol }) => {
    const trade = activeTrades.find(
      t => t.status === 'active' && t.entryFilled && t.binanceTpOrderId === orderId
    );
    if (!trade) return;
    log.warn(`WS: TP order #${orderId} bị hủy thủ công (${symbol}) — sẽ thử đặt lại`);
    trade.binanceTpOrderId = null;
    // Xóa recovery key để recovery có thể chạy lại trên poll tiếp theo
    _slTpRecoveryDone.delete(String(trade.binanceEntryOrderId));
    saveTrades();
    const dirLabel = trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    sendMessages([
      `⚠️ <b>TP BỊ HỦY — ${trade.symbol} ${dirLabel}</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `TP order #${orderId} bị hủy trên Binance.\n` +
      `Bot sẽ tự đặt lại TP trong vài giây...`,
    ], 1500, NEWS_CHAT_ID).catch(() => {});
  });
}

// Cập nhật TP/SL cho một lệnh (dùng bởi dashboard API)
function updateActiveTrade(id, fields) {
  const trade = activeTrades.find(t => t.id === id);
  if (!trade) return null;

  if ('targetPrice' in fields) {
    trade.targetPrice = fields.targetPrice != null ? parseFloat(fields.targetPrice) || null : null;
    if (trade.targetPrice && trade.entryPrice) {
      trade.targetPct = parseFloat((Math.abs(trade.targetPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2));
    }
  }
  if ('slPrice' in fields) {
    trade.slPrice = fields.slPrice != null ? parseFloat(fields.slPrice) || null : null;
    if (trade.slPrice && trade.entryPrice) {
      trade.slPct = parseFloat((Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2));
    }
  }
  if ('tp1Price' in fields) trade.tp1Price = fields.tp1Price != null ? parseFloat(fields.tp1Price) || null : null;
  if ('tp2Price' in fields) trade.tp2Price = fields.tp2Price != null ? parseFloat(fields.tp2Price) || null : null;

  saveTrades();
  log.trade(`Dashboard update TP/SL: ${trade.symbol} TP=${trade.targetPrice ?? '—'} SL=${trade.slPrice ?? '—'}`);
  return { ok: true };
}

// Xóa một lệnh khỏi activeTrades (gọi từ dashboard API hoặc bot)
async function removeActiveTrade(id) {
  const trade = activeTrades.find(t => String(t.id) === String(id));
  if (!trade) return { ok: false, error: 'Trade not found' };

  if (binanceTrader.isEnabled()) {
    if (trade.binanceEntryOrderId && !trade.entryFilled) {
      await binanceTrader.cancelEntryOrder(trade).catch(() => {});
    }
    if (trade.binanceTpOrderId) {
      await binanceTrader.cancelOrderById(trade.symbol, trade.binanceTpOrderId).catch(() => {});
    }
    if (trade.binanceSlOrderId) {
      await binanceTrader.cancelAlgoOrderById(trade.symbol, trade.binanceSlOrderId).catch(() => {});
    }
  }

  trade.status = 'canceled';
  trade.closedAt = new Date();
  trade.cancelReason = 'dashboard_user_removed';

  const idx = activeTrades.indexOf(trade);
  if (idx !== -1) {
    activeTrades.splice(idx, 1);
  }

  saveTrades();
  log.trade(`Dashboard xóa trade: #${trade.id} (${trade.symbol} ${trade.direction})`);
  return { ok: true, id: trade.id, symbol: trade.symbol };
}

function forceSyncBrakeOverride() { _forceSyncBrake = true; }

module.exports = { parseTrades, addTrades, checkActiveTrades, getActiveTrades, sendActiveTradesSummary, runBacktest, initBinanceStream, syncManualPositions, updateActiveTrade, removeActiveTrade, consumeSignalScanFlag, onWsPush, forceSyncBrakeOverride };