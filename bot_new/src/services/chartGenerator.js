'use strict';

/**
 * Tạo ảnh chart PNG candlestick (style TradingView dark) dùng @napi-rs/canvas.
 * Không cần browser, không cần Chromium — chạy tốt trên e2-micro VM.
 *
 * Layout (800×540):
 *   Vùng giá  (~385px): nến + đường S/R + TP/SL
 *   Separator (6px)
 *   Vùng volume (75px): bars bán trong suốt
 *   Thanh info (52px): symbol · timeframe · direction · Entry/TP/SL tags
 */

const axios   = require('axios');
const { log } = require('./logger');

// ─── Kích thước canvas ────────────────────────────────────────────────────────

const W        = 800;
const H        = 540;
const CHART_H  = 488;  // tổng vùng chart (không tính bar info phía dưới)
const BAR_H    = 52;   // thanh thông tin phía dưới
const R_AXIS   = 82;   // độ rộng trục giá bên phải
const L_PAD    = 8;    // padding trái
const T_PAD    = 12;   // padding trên vùng giá
const B_PAD    = 10;   // padding dưới (trên thanh info)
const VOL_H    = 75;   // chiều cao vùng volume bars
const VOL_SEP  = 6;    // khoảng trống ngăn cách giá và volume

// vùng giá: từ T_PAD đến (VOL_TOP - VOL_SEP)
const PRICE_H  = CHART_H - T_PAD - B_PAD - VOL_H - VOL_SEP;  // ≈ 385px
// vùng volume: từ VOL_TOP đến VOL_BOT
const VOL_TOP  = CHART_H - B_PAD - VOL_H;  // ≈ 403
const VOL_BOT  = CHART_H - B_PAD;          // ≈ 478

const TIMEFRAME = '1D';

// ─── Màu sắc (TradingView dark theme) ────────────────────────────────────────

const C = {
  bg:         '#131722',
  bgBar:      '#1a1e2e',
  border:     '#2a2e39',
  grid:       '#1e2030',
  text:       '#787b86',
  bright:     '#d1d4dc',
  up:         '#26a69a',
  down:       '#ef5350',
  entry:      '#2196F3',
  tp1:        '#FF9800',
  tp2:        '#8BC34A',
  tp:         '#00C853',
  sl:         '#F44336',
  support:    '#26a69a',
  resistance: '#ef5350',
};

// ─── Fetch klines: Binance trước, OKX fallback ────────────────────────────────

async function fetchKlines(symbol, limit = 90) {
  const HEADERS = { 'User-Agent': 'crypto-news-bot/1.0' };
  try {
    const { data } = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: `${symbol}USDT`, interval: '1d', limit: Math.min(limit, 1500) },
      headers: HEADERS, timeout: 10000,
    });
    if (Array.isArray(data) && data.length > 0) {
      // k[7] = quote asset volume (USDT) — chính xác nhất cho crypto
      return data.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
    }
  } catch { /* fallthrough */ }

  const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId: `${symbol}-USDT-SWAP`, bar: '1D', limit: Math.min(limit, 100) },
    headers: HEADERS, timeout: 10000,
  });
  // OKX: k[7] = volCcyQuote (USDT), fallback k[5] = base vol
  return (data.data || []).reverse().map(k => ({
    o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +(k[7] || k[5] || 0),
  }));
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fp(n) {
  if (n >= 10000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1)     return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + n.toFixed(4);
}

function pctStr(a, b) {
  const v = (a - b) / b * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

// ─── Vẽ rounded rectangle ─────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generateTradeChart(symbol, direction, entry, tp1, tp2, tp, sl, ta = null) {
  let createCanvas;
  try {
    ({ createCanvas } = require('@napi-rs/canvas'));
  } catch {
    log.warn('Chart: @napi-rs/canvas chưa cài — bỏ qua ảnh chart');
    return null;
  }

  // 1. Fetch klines
  let klines;
  try {
    klines = await fetchKlines(symbol, 90);
  } catch (err) {
    log.warn(`Chart: lỗi fetch klines ${symbol}`, { error: err.message });
    return null;
  }
  if (!klines || klines.length < 5) {
    log.warn(`Chart: không đủ klines ${symbol} (${klines?.length ?? 0})`);
    return null;
  }

  // 2. Tính vùng giá hiển thị
  const isLong  = direction === 'LONG';
  const chartW  = W - R_AXIS;
  const allP    = [...klines.flatMap(k => [k.h, k.l]), entry, tp1, tp2, tp, sl];
  const pMin    = Math.min(...allP);
  const pMax    = Math.max(...allP);
  const range   = pMax - pMin || pMax * 0.05;
  const pad     = range * 0.13;
  const vMin    = pMin - pad;
  const vMax    = pMax + pad;

  const toY   = p => T_PAD + PRICE_H * (1 - (p - vMin) / (vMax - vMin));
  const step    = (chartW - L_PAD) / klines.length;
  const candleW = Math.max(2, Math.floor(step * 0.65));
  const toX   = i => L_PAD + (i + 0.5) * step;

  // 3. Tạo canvas
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // 4. Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 5. Grid ngang (5 đường — chỉ trong vùng giá)
  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;
  for (let i = 1; i <= 5; i++) {
    const y = T_PAD + PRICE_H * (i / 6);
    ctx.beginPath();
    ctx.moveTo(L_PAD, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();
  }

  // 6. Grid dọc (mỗi 15 nến — xuyên cả vùng giá lẫn volume)
  for (let i = 0; i < klines.length; i += 15) {
    const x = toX(i);
    ctx.beginPath();
    ctx.moveTo(x, T_PAD);
    ctx.lineTo(x, VOL_BOT);
    ctx.stroke();
  }

  // 6.5. Nhãn khung thời gian (top-left overlay trên vùng giá)
  ctx.fillStyle = C.text;
  ctx.font      = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(TIMEFRAME, L_PAD + 4, T_PAD + 14);

  // 7. Candlesticks
  for (let i = 0; i < klines.length; i++) {
    const k     = klines[i];
    const x     = toX(i);
    const isUp  = k.c >= k.o;
    const color = isUp ? C.up : C.down;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(k.h));
    ctx.lineTo(x, toY(k.l));
    ctx.stroke();

    const y1    = toY(Math.max(k.o, k.c));
    const y2    = toY(Math.min(k.o, k.c));
    const bodyH = Math.max(1, y2 - y1);
    ctx.fillStyle = color;
    ctx.fillRect(x - candleW / 2, y1, candleW, bodyH);
  }

  // 7.5. Volume — separator + bars + label
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(L_PAD, VOL_TOP - 1);
  ctx.lineTo(chartW, VOL_TOP - 1);
  ctx.stroke();

  const vols   = klines.map(k => k.v || 0);
  const maxVol = Math.max(...vols, 1);

  for (let i = 0; i < klines.length; i++) {
    const k     = klines[i];
    const vol   = k.v || 0;
    const barH  = Math.max(1, (vol / maxVol) * (VOL_H * 0.88));
    const x     = toX(i);
    const isUp  = k.c >= k.o;
    ctx.fillStyle = (isUp ? C.up : C.down) + '66';
    ctx.fillRect(x - candleW / 2, VOL_BOT - barH, candleW, barH);
  }

  // Label "Vol" + giá trị nến cuối (top-left vùng volume)
  const lastVol = vols[vols.length - 1] || 0;
  ctx.fillStyle = C.text;
  ctx.font      = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Vol  ${fmtVol(lastVol)}`, L_PAD + 4, VOL_TOP + 11);

  // 8. Vẽ đường giá ngang với nhãn bên phải
  function drawLine(price, color, label, showPct, dashed) {
    const y = toY(price);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = label === 'Entry' ? 2 : 1.5;
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(L_PAD, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();
    ctx.restore();

    const LBL_H = 19;
    const LBL_W = R_AXIS - 3;
    const LBL_X = chartW + 2;
    const LBL_Y = y - LBL_H / 2;

    ctx.fillStyle = color;
    roundRect(ctx, LBL_X, LBL_Y, LBL_W, LBL_H, 3);
    ctx.fill();

    ctx.fillStyle = '#000000';
    ctx.font      = 'bold 9.5px sans-serif';
    ctx.textAlign = 'center';
    const cx = LBL_X + LBL_W / 2;
    if (showPct) {
      ctx.fillText(fp(price), cx, LBL_Y + 8);
      ctx.font = '8px sans-serif';
      ctx.fillText(pctStr(price, entry), cx, LBL_Y + 16);
    } else {
      ctx.fillText(fp(price), cx, LBL_Y + 12);
    }
  }

  drawLine(sl,    C.sl,    'SL',    true,  false);
  drawLine(tp,    C.tp,    'TP',    true,  false);
  drawLine(tp2,   C.tp2,   'TP2',   true,  true);
  drawLine(tp1,   C.tp1,   'TP1',   true,  true);
  drawLine(entry, C.entry, 'Entry', false, false);

  // S/R từ TA (nếu có)
  const support    = Array.isArray(ta?.support)    ? ta.support[0]    : ta?.support;
  const resistance = Array.isArray(ta?.resistance) ? ta.resistance[0] : ta?.resistance;
  if (support    > 0 && isFinite(support)    && Math.abs(support    - entry) / entry > 0.005) {
    drawLine(support,    C.support,    'S', false, true);
  }
  if (resistance > 0 && isFinite(resistance) && Math.abs(resistance - entry) / entry > 0.005) {
    drawLine(resistance, C.resistance, 'R', false, true);
  }

  // Viền phân cách trục giá
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(chartW, 0);
  ctx.lineTo(chartW, CHART_H);
  ctx.stroke();

  // 9. Thanh thông tin phía dưới
  ctx.fillStyle = C.bgBar;
  ctx.fillRect(0, CHART_H, W, BAR_H);
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, CHART_H);
  ctx.lineTo(W, CHART_H);
  ctx.stroke();

  const barY = CHART_H + BAR_H / 2;
  let   curX = 12;

  // Symbol
  ctx.fillStyle = C.bright;
  ctx.font      = 'bold 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${symbol}/USDT`, curX, barY + 5);
  curX += ctx.measureText(`${symbol}/USDT`).width + 6;

  // Timeframe badge
  ctx.font = 'bold 10px sans-serif';
  const tfW = ctx.measureText(TIMEFRAME).width + 8;
  roundRect(ctx, curX, barY - 8, tfW, 16, 2);
  ctx.fillStyle   = C.text + '28';
  ctx.fill();
  ctx.strokeStyle = C.text + '80';
  ctx.lineWidth   = 0.8;
  ctx.stroke();
  ctx.fillStyle   = C.text;
  ctx.textAlign   = 'center';
  ctx.fillText(TIMEFRAME, curX + tfW / 2, barY + 4);
  curX += tfW + 10;

  // Separator
  ctx.fillStyle = C.border;
  ctx.fillRect(curX, CHART_H + 12, 1, BAR_H - 24);
  curX += 9;

  // Direction badge
  const dirColor = isLong ? C.up : C.down;
  ctx.font       = 'bold 11px sans-serif';
  const dirW     = ctx.measureText(direction).width + 14;
  roundRect(ctx, curX, barY - 10, dirW, 20, 3);
  ctx.fillStyle   = dirColor + '33';
  ctx.fill();
  ctx.strokeStyle = dirColor;
  ctx.lineWidth   = 1;
  ctx.stroke();
  ctx.fillStyle   = dirColor;
  ctx.textAlign   = 'center';
  ctx.fillText(direction, curX + dirW / 2, barY + 4);
  curX += dirW + 10;

  // Separator
  ctx.fillStyle = C.border;
  ctx.fillRect(curX, CHART_H + 12, 1, BAR_H - 24);
  curX += 9;

  // Tags: Entry / TP1 / TP2 / TP / SL
  const tags = [
    { label: 'Entry', price: entry, pct: null,               color: C.entry },
    { label: 'TP1',   price: tp1,   pct: pctStr(tp1, entry), color: C.tp1   },
    { label: 'TP2',   price: tp2,   pct: pctStr(tp2, entry), color: C.tp2   },
    { label: 'TP',    price: tp,    pct: pctStr(tp,  entry), color: C.tp    },
    { label: 'SL',    price: sl,    pct: pctStr(sl,  entry), color: C.sl    },
  ];

  for (const tag of tags) {
    const txt = tag.pct ? `${tag.label} ${fp(tag.price)} ${tag.pct}` : `${tag.label} ${fp(tag.price)}`;
    ctx.font  = 'bold 10px sans-serif';
    const tw  = ctx.measureText(txt).width + 12;

    if (curX + tw > W - 6) break;

    roundRect(ctx, curX, barY - 10, tw, 20, 3);
    ctx.fillStyle   = tag.color + '33';
    ctx.fill();
    ctx.strokeStyle = tag.color;
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.fillStyle   = tag.color;
    ctx.textAlign   = 'center';
    ctx.fillText(txt, curX + tw / 2, barY + 4);
    curX += tw + 6;
  }

  // 10. Xuất PNG buffer
  const buf = await canvas.encode('png');
  log.system(`Chart: OK ${symbol} ${direction} (${klines.length} nến, ${(buf.length / 1024).toFixed(0)}KB)`);
  return buf;
}

module.exports = { generateTradeChart };
