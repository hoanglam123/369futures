'use strict';

/**
 * signalEngine.js — Động cơ Xử lý Tín hiệu Định lượng 100% (Pure Deterministic Signal Engine)
 *
 * Chuyển giao hoàn toàn luồng ra quyết định vào lệnh từ AI sang Thuật toán Toán học:
 * 1. Nhận danh sách setups từ Confluence Scorer
 * 2. Phân loại Tier 1 (>= 7.0đ) và Tier 2 (>= 8.0đ)
 * 3. Chốt chặn bảo vệ: Directional Circuit Breaker, SL Cooldown, Bounce Cooldown, BTC Flash Guard
 * 4. Tính toán TP, SL, R:R, Đòn bẩy qua calculateTierSLTP (0.01ms)
 * 5. Thẩm định vi cấu trúc nến qua Risk Gatekeeper (AI Bản thân cục bộ, 0 Token)
 * 6. Kèo bị VETO -> Tự động chuyển giao sang Shadow Tracker để đánh giá mở khóa sớm
 * 7. Sinh danh sách lệnh chuẩn xác đẩy vào addTrades / Binance
 */

const axios                       = require('axios');
const { calculateTierSLTP }       = require('./tierSLTP');
const { evaluateSignal }          = require('./riskGatekeeper');
const { isDirectionLocked }       = require('./directionalCircuitBreaker');
const { isSymbolInCooldown }      = require('./cooldownManager');
const { isLevelBounceCooldown }   = require('./bounceCancel');
const { checkBtcFlashStatus }     = require('./btcFlashGuard');
const { registerShadowTrade, isShadowPositionActive } = require('./shadowTracker');
const { getMarkPrice, getPrices } = require('../pp369/stream');
const { fetchH1Historical, fetchM15Recent } = require('./candleCache');
const { getSymbolInfo, getUsdtBalance } = require('./binanceTrader');
const { isIpBanned }              = require('./rateLimitGuard');
const { log }                     = require('./logger');

const _microCache = new Map(); // sym -> { ts, spreadPct, bidVol, askVol }
const MICRO_TTL_MS = 15_000;

const _engineScanStats = { rejectMath: 0, rejectGatekeeper: 0, ordersDispatched: 0 };
function consumeEngineScanStats() {
  const snap = { ..._engineScanStats };
  _engineScanStats.rejectMath = 0;
  _engineScanStats.rejectGatekeeper = 0;
  _engineScanStats.ordersDispatched = 0;
  return snap;
}

/**
 * Lấy vi cấu trúc sổ lệnh L2 (5 mức giá đầu — weight=2, cache 15s, fail-open).
 * Tính spread_slippage và orderbook_wall thời gian thực tại 0ms cho Top 1–2 ứng viên.
 */
async function fetchOrderbookMicrostructure(symbol, isLong) {
  const fallback = { spreadPct: 0, orderbookWall: 'CLEAR' };
  if (isIpBanned() || process.env.DISABLE_MICROSTRUCTURE_FETCH === 'true') return fallback;
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  const now = Date.now();
  let cached = _microCache.get(cleanSym);

  if (!cached || (now - cached.ts >= MICRO_TTL_MS)) {
    try {
      const res = await axios.get('https://fapi.binance.com/fapi/v1/depth', {
        params: { symbol: `${cleanSym}USDT`, limit: 5 },
        timeout: 2500
      });
      const bids = res.data?.bids || [];
      const asks = res.data?.asks || [];
      if (bids.length > 0 && asks.length > 0) {
        const bestBid = parseFloat(bids[0][0]);
        const bestAsk = parseFloat(asks[0][0]);
        const spreadPct = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
        const bidVol = bids.reduce((s, [p, q]) => s + parseFloat(p) * parseFloat(q), 0);
        const askVol = asks.reduce((s, [p, q]) => s + parseFloat(p) * parseFloat(q), 0);
        cached = { ts: now, spreadPct, bidVol, askVol };
        if (_microCache.size >= 100) _microCache.delete(_microCache.keys().next().value);
        _microCache.set(cleanSym, cached);
      }
    } catch (_) {
      return fallback;
    }
  }

  if (!cached) return fallback;
  const { spreadPct, bidVol, askVol } = cached;
  const supportVol  = isLong ? bidVol : askVol;
  const opposingVol = isLong ? askVol : bidVol;
  let orderbookWall = 'CLEAR';
  if (supportVol > 0 && opposingVol / supportVol >= 3.5) {
    orderbookWall = 'OPPOSING_BLOCK';
  } else if (opposingVol > 0 && supportVol / opposingVol >= 2.5) {
    orderbookWall = 'SUPPORT_SHIELD';
  }
  return { spreadPct: parseFloat(spreadPct.toFixed(4)), orderbookWall };
}

const FIXED_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'TON', 'SUI', 'APT', 'NEAR'];
const MIN_SCORE_TIER1 = 7.0; // Tier 1: BTC, ETH, Top coin >= 7.0đ
const MIN_SCORE_TIER2 = 8.0; // Tier 2: Altcoins >= 8.0đ
const MAX_CONCURRENT_NEW_TRADES = 2; // Giới hạn tối đa 2 setup mới mỗi lượt quét

const _loggedSignals = new Map();
function _shouldLogSignal(sym, dir, type, cooldownMs = 10 * 60 * 1000) {
  const key = `${sym}_${dir}_${type}`;
  const now = Date.now();
  if (_loggedSignals.has(key) && (now - _loggedSignals.get(key)) < cooldownMs) {
    return false;
  }
  _loggedSignals.set(key, now);
  return true;
}

// Quản lý VETO Cooldown: Khi một setup bị VETO Toán học (cản cứng) hoặc AI VETO,
// đưa vào hồi chiêu 30 phút để nhường slot duyệt cho các coin khác (Đồng bộ triệt để với bot-h4)
const _vetoCooldown = new Map();

function _setVetoCooldown(sym, dir, cooldownMs = 30 * 60 * 1000) {
  const key = `${sym}_${dir}`;
  _vetoCooldown.set(key, Date.now() + cooldownMs);
}

function _isVetoInCooldown(sym, dir) {
  const key = `${sym}_${dir}`;
  const expire = _vetoCooldown.get(key);
  if (!expire) return false;
  if (Date.now() > expire) {
    _vetoCooldown.delete(key);
    return false;
  }
  return true;
}

function _clearVetoCooldownForTest() {
  _vetoCooldown.clear();
}

/**
 * Thẩm định và tạo lệnh giao dịch định lượng cho một setup
 */
async function generateQuantitativeTrade(setup, marketData = null, options = {}) {
  const isReeval = Boolean(options?.isReeval);
  const symbol = setup.symbol;
  const direction = setup.direction;
  const score = setup.total;
  const isTier1 = FIXED_COINS.includes(symbol);
  const rankTierLabel = isTier1 ? 'Tier 1 Top 50' : 'Tier 2 Altcoin';

  const minRequired = isTier1 ? MIN_SCORE_TIER1 : MIN_SCORE_TIER2;
  if (score < minRequired) {
    return null;
  }

  // ─── CHỐT CHẶN 1: DIRECTIONAL CIRCUIT BREAKER (KHÓA THEO CHIỀU) ───
  const dirLock = isDirectionLocked(direction);
  if (dirLock.isLocked) {
    log.system(`[AutoTrade] 🛑 [VETO Directional CB] ${symbol} ${direction}: Chiều ${direction} đang bị khóa còn ${dirLock.remainingMinutes}p (${dirLock.reason})`);
    if (!isReeval) registerShadowTrade(setup, `DIRECTIONAL_CB_LOCKED: ${dirLock.reason}`);
    return null;
  }

  // ─── CHỐT CHẶN 2: COOLDOWN TỪNG COIN (SL COOLDOWN) ───────────────
  if (isSymbolInCooldown(symbol)) {
    log.system(`[AutoTrade] 🛑 [VETO Cooldown] ${symbol} ${direction}: Coin đang trong thời gian hồi chiêu sau SL`);
    if (!isReeval) registerShadowTrade(setup, 'SYMBOL_IN_SL_COOLDOWN');
    return null;
  }

  // ─── CHỐT CHẶN 3: REAL-TIME BTC FLASH GUARD ───────────────────────
  // Chỉ chặn cứng tại đây khi bão thật SEVERE (>= 2.0%), miễn trừ nhóm Vàng/Hàng hóa (PAXG/XAU/XAG).
  // Mức MODERATE đi qua Risk Gatekeeper với mức phạt nhẹ x0.78 để kèo đẹp có cản cứng vẫn vào được.
  const btcFlash = checkBtcFlashStatus();
  const isBtcFlashExempt = ['PAXG', 'XAU', 'XAG'].includes(String(symbol || '').toUpperCase().replace(/USDT$/i, ''));
  if (!isBtcFlashExempt && btcFlash.severity === 'SEVERE' && btcFlash.activeFlash === 'FLASH_DUMP' && direction === 'LONG') {
    log.system(`[AutoTrade] 🛑 [VETO BTC Flash Guard SEVERE] ${symbol} LONG: Đang có bão BTC Flash Dump (${btcFlash.reason})`);
    if (!isReeval) registerShadowTrade(setup, `BTC_FLASH_DUMP: ${btcFlash.reason}`);
    return null;
  }
  if (!isBtcFlashExempt && btcFlash.severity === 'SEVERE' && btcFlash.activeFlash === 'FLASH_PUMP' && direction === 'SHORT') {
    log.system(`[AutoTrade] 🛑 [VETO BTC Flash Guard SEVERE] ${symbol} SHORT: Đang có bão BTC Flash Pump (${btcFlash.reason})`);
    if (!isReeval) registerShadowTrade(setup, `BTC_FLASH_PUMP: ${btcFlash.reason}`);
    return null;
  }

  // 1. Xác định mức giá Entry — ưu tiên giá thực tế live (WebSocket / REST ticker) trước TA cache
  const ta = marketData?.ta?.[symbol];
  const sig369 = marketData?.signals369?.[symbol];
  const liveMark = (typeof getMarkPrice === 'function') ? getMarkPrice(symbol) : null;
  const restPrice = (typeof getPrices === 'function') ? getPrices()?.[symbol] : null;
  const taPrice = ta?.price || ta?.close || ta?.lastPrice || null;
  const topCoinPrice = marketData?.topCoins?.find(c => c.symbol === symbol)?.price || null;

  // TUYỆT ĐỐI KHÔNG fallback về setup.targetLevel để tránh vô hiệu hóa chốt chặn cự ly 0.5% (Fix lỗi PROM LONG)
  const currentPrice = liveMark || restPrice || taPrice || sig369?.currentPrice || topCoinPrice || null;

  if (!currentPrice || currentPrice <= 0) {
    log.warn(`[AutoTrade] ${symbol} ${direction}: Không có giá thị trường thực tế hợp lệ — bỏ qua`);
    return null;
  }

  // Ưu tiên: overrideEntryPrice (luồng Shadow Re-Eval Maker-only) -> setup.targetLevel -> sig369.targetLevel -> currentPrice
  let entryPrice = (isReeval && Number(options.overrideEntryPrice) > 0)
    ? Number(options.overrideEntryPrice)
    : setup.targetLevel;
  if (!entryPrice && sig369 && sig369.signal === direction && sig369.targetLevel) {
    entryPrice = sig369.targetLevel;
  }
  if (!entryPrice) {
    entryPrice = currentPrice;
  }

  // ─── CHỐT CHẶN BẢO VỆ: CỰ LY ENTRY VS GIÁ THỊ TRƯỜNG HIỆN TẠI ─────────
  // Quét thường: tối đa 0.5%. Re-Eval 30m: đã có chốt chặn <= 30% TP & <= 40% SL, cho phép biên an toàn tối đa 3.0% (chờ hồi Maker).
  const maxEntryDistPct = isReeval ? 0.03 : 0.005;
  const entryDistPct = Math.abs(entryPrice - currentPrice) / currentPrice;
  if (entryDistPct > maxEntryDistPct) {
    log.system(`[AutoTrade] 🛑 [VETO Entry Distance] ${symbol} ${direction}: Entry $${entryPrice} cách giá hiện tại $${currentPrice} quá xa (${(entryDistPct * 100).toFixed(2)}% > ${(maxEntryDistPct * 100).toFixed(1)}%) — Hủy`);
    return null;
  }

  // ─── CHỐT CHẶN 4: BOUNCE CANCEL COOLDOWN (MỐC VỪA BẬT NẢY) ─────────
  if (isLevelBounceCooldown(symbol, entryPrice)) {
    log.system(`[AutoTrade] 🛑 [VETO Bounce Cancel] ${symbol} ${direction} @ ${entryPrice}: Mốc vừa nảy giá không khớp, đang cooldown`);
    return null;
  }

  // 2. Tính toán TP/SL & Đòn bẩy bằng Thuật toán Định Lượng (0.01ms)
  let tierSetup = null;
  let symTickSize = null;
  const effGridWidth = setup.gridWidthPct || (sig369?.step && currentPrice > 0 ? (sig369.step / currentPrice) * 100 : null);
  const realRank = setup.marketCapRank
    || marketData?.topCoins?.find(c => c.symbol === symbol)?.rank
    || (isTier1 ? 20 : 180);
  try {
    const symInfo = await getSymbolInfo(symbol).catch(() => null);
    symTickSize = symInfo?.tickSize || null;
    if (isReeval && symTickSize && symTickSize > 0) {
      const decTick = Math.min(8, Math.max(0, Math.round(-Math.log10(symTickSize))));
      const snapped = direction === 'LONG'
        ? Math.floor(entryPrice / symTickSize) * symTickSize
        : Math.ceil(entryPrice / symTickSize) * symTickSize;
      entryPrice = Number(snapped.toFixed(decTick));
      if (!entryPrice || entryPrice <= 0) return null;
      if ((direction === 'LONG' && entryPrice >= currentPrice) || (direction === 'SHORT' && entryPrice <= currentPrice)) {
        return null;
      }
    }

    const tradeSizePct = parseFloat(process.env.TRADE_SIZE_PCT || '0');
    let customMargin = null;
    if (tradeSizePct > 0) {
      try {
        const bal = await getUsdtBalance();
        if (bal > 0) {
          const raw = (bal * tradeSizePct) / 100;
          const minU = parseFloat(process.env.TRADE_MIN_USDT || '5');
          const maxU = parseFloat(process.env.TRADE_MAX_USDT || '200');
          customMargin = Math.min(Math.max(raw, minU), maxU, bal);
        }
      } catch (_) {}
    }
    if (!customMargin) {
      customMargin = isTier1 ? parseFloat(process.env.TRADE_AMOUNT_TIER1 || '20') : parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10');
    }

    const h4RefInput = sig369 ? { step: sig369.step, decimals: sig369.decimals } : null;
    const maxExchLev = symInfo?.maxLeverage || 20;
    // Scale targetLossUSD theo customMargin (tối thiểu $3.0) để không bóp nghẹt đòn bẩy khi tài khoản lớn dùng TRADE_SIZE_PCT
    const envTargetLoss = parseFloat(process.env.TARGET_LOSS_USD || '0');
    const effTargetLossUSD = envTargetLoss > 0
      ? envTargetLoss
      : Math.max(3.0, parseFloat((customMargin * 0.15).toFixed(2)));

    tierSetup = await calculateTierSLTP(
      symbol,
      direction,
      entryPrice,
      h4RefInput,
      symTickSize, // tickSize (từ Binance exchangeInfo)
      maxExchLev,
      effTargetLossUSD,
      1.5,  // target tpRatio
      realRank,
      effGridWidth,
      null, // customKlines
      customMargin
    );
  } catch (err) {
    log.error(`[AutoTrade] Lỗi calculateTierSLTP ${symbol}: ${err.message}`);
    return null;
  }

  if (!tierSetup || !tierSetup.valid) {
    _engineScanStats.rejectMath++;
    const vetoReason = tierSetup?.reason || 'Không đạt chuẩn R:R';
    if (!isReeval) {
      _setVetoCooldown(symbol, direction, 30 * 60 * 1000);
      if (_shouldLogSignal(symbol, direction, 'math_veto', 30 * 60 * 1000)) {
        log.system(`[AutoTrade] 🛑 [VETO Toán học] ${symbol} ${direction}: ${vetoReason}`);
      }
      // Đồng bộ bot-h4: không ghi lệnh bị RR_BLOCKED_BY_MAJOR_SR (R:R bị ép sát cản < 1.48) vào Shadow Tracker
      // để tránh làm sai lệch thống kê Shadow PnL & nhiễu dữ liệu retrain AI.
    } else {
      log.system(`[ShadowReEval] ⏭️ ${symbol} ${direction}: VETO Toán học (${vetoReason})`);
    }
    return null;
  }

  // 3. Thẩm định vi cấu trúc nến H1/M15 + Realtime Volume + Spread + Orderbook Wall qua Risk Gatekeeper (0 Token)
  let lastH1 = ta?.candleH1 || null;
  let h1VolRatio = null;
  try {
    const h1Candles = await fetchH1Historical(symbol);
    if (Array.isArray(h1Candles) && h1Candles.length > 0) {
      if (!lastH1) lastH1 = h1Candles[h1Candles.length - 1];
      if (h1Candles.length >= 21) {
        const past20 = h1Candles.slice(-21, -1);
        const avgH1Vol = past20.reduce((s, c) => s + (c.volume || 0), 0) / past20.length;
        const currH1Vol = h1Candles[h1Candles.length - 1].volume || 0;
        if (avgH1Vol > 0 && currH1Vol > 0) h1VolRatio = parseFloat((currH1Vol / avgH1Vol).toFixed(2));
      }
    }
  } catch (_) {}

  let lastM15 = ta?.candleM15 || null;
  let m15VolRatio = null;
  if (!isIpBanned()) {
    try {
      const m15Candles = await fetchM15Recent(symbol, 25);
      if (Array.isArray(m15Candles) && m15Candles.length > 0) {
        if (!lastM15) lastM15 = m15Candles[m15Candles.length - 1];
        if (m15Candles.length >= 10) {
          const past = m15Candles.slice(-Math.min(21, m15Candles.length), -1);
          const avgM15Vol = past.reduce((s, c) => s + (c.volume || 0), 0) / past.length;
          const currM15Vol = m15Candles[m15Candles.length - 1].volume || 0;
          if (avgM15Vol > 0 && currM15Vol > 0) m15VolRatio = parseFloat((currM15Vol / avgM15Vol).toFixed(2));
        }
      }
    } catch (_) {}
  }

  // Tính preEntryBouncePct thực tế từ nến M15 gần nhất để kích hoạt feature pre_entry_bounce
  let preEntryBouncePct = 0;
  if (lastM15 && entryPrice > 0) {
    const isLongDir = direction === 'LONG';
    const extreme = isLongDir ? (lastM15.high || entryPrice) : (lastM15.low || entryPrice);
    const rawBounce = isLongDir
      ? ((extreme - entryPrice) / entryPrice) * 100
      : ((entryPrice - extreme) / entryPrice) * 100;
    if (rawBounce > 0 && isFinite(rawBounce)) preEntryBouncePct = parseFloat(rawBounce.toFixed(2));
  }

  // Maker Guard: tránh đặt LIMIT BUY cao hơn markPrice > 0.15% (khớp ngay thành Taker khi cản đang vỡ)
  const liveMarkPrice = getMarkPrice(symbol) || currentPrice;
  if (liveMarkPrice && liveMarkPrice > 0) {
    const puncturedPct = direction === 'LONG'
      ? ((entryPrice - liveMarkPrice) / entryPrice) * 100
      : ((liveMarkPrice - entryPrice) / entryPrice) * 100;
    if (puncturedPct > 0.15) {
      _engineScanStats.rejectGatekeeper++;
      log.system(`[AutoTrade] 🛑 [Maker Guard] ${symbol} (${direction}): Giá $${liveMarkPrice} đã đâm thủng mốc $${entryPrice} (${puncturedPct.toFixed(2)}% > 0.15%) — bỏ qua để tránh khớp Taker.`);
      return null;
    }
  }

  const micro = await fetchOrderbookMicrostructure(symbol, direction === 'LONG');

  const marketContext = {
    candleH1: lastH1,
    candleM15: lastM15,
    isLiveCandle: true,
    m15VolRatio,
    h1VolRatio,
    preEntryBouncePct,
    btcFlash: btcFlash.activeFlash || 'NORMAL',
    btcFlashSeverity: btcFlash.severity || 'NORMAL',
    spreadPct: micro.spreadPct,
    tickSize: symTickSize,
    orderbookWall: micro.orderbookWall,
    slPct: tierSetup.slPct,
    tpPct: tierSetup.tpPct,
    leverage: tierSetup.leverage,
    rank: realRank
  };

  const gateResult = evaluateSignal({
    symbol,
    signal: direction,
    targetLevel: entryPrice,
    score: score,
    slPct: tierSetup.slPct,
    tpPct: tierSetup.tpPct,
    leverage: tierSetup.leverage,
    preEntryBouncePct,
    marketCapRank: realRank,
    scoreReasons: setup.reasons || []
  }, marketContext);

  if (!gateResult.isApproved) {
    _engineScanStats.rejectGatekeeper++;
    if (!isReeval) {
      _setVetoCooldown(symbol, direction, 30 * 60 * 1000);
      if (_shouldLogSignal(symbol, direction, 'gatekeeper_veto', 30 * 60 * 1000)) {
        log.system(`[AutoTrade] 🛑 [AI VETO] ${symbol} (${direction}): ${gateResult.reason} — Bỏ qua`);
      }
      const h1RangePct = (lastH1 && lastH1.low > 0) ? parseFloat((((lastH1.high - lastH1.low) / lastH1.low) * 100).toFixed(2)) : null;
      const m15RangePct = (lastM15 && lastM15.low > 0) ? parseFloat((((lastM15.high - lastM15.low) / lastM15.low) * 100).toFixed(2)) : null;
      registerShadowTrade({
        ...setup,
        entryPrice,
        markPrice: liveMarkPrice,
        slPrice: tierSetup.slPrice,
        tpPrice: tierSetup.tpPrice,
        beTriggerPrice: tierSetup.beTriggerPrice,
        slPct: tierSetup.slPct,
        tpPct: tierSetup.tpPct,
        gridWidthPct: effGridWidth,
        marketCapRank: realRank,
        leverage: tierSetup.leverage,
        margin: tierSetup.margin,
        winProbability: gateResult.winProbability,
        scoreReasons: setup.reasons || [],
        microstructure: { spreadPct: micro.spreadPct, wall: micro.orderbookWall },
        marketMetrics: { h1RangePct, m15RangePct, m15VolRatio, h1VolRatio, preEntryBouncePct },
        features: gateResult.features,
        keyFactors: gateResult.keyFactors
      }, `GATEKEEPER_VETO: ${gateResult.reason}`);
    } else {
      log.system(`[ShadowReEval] 🛑 ${symbol} (${direction}): AI VETO (${gateResult.reason}) — giữ nguyên trong Shadow`);
    }
    return null;
  }

  const thPctLabel = typeof gateResult.approvalThresholdPct === 'number' ? gateResult.approvalThresholdPct.toFixed(1) : '50.0';
  log.system(`[AutoTrade] 🟢 [${isReeval ? 'ShadowReEval AI APPROVED' : 'AI APPROVED'}] ${symbol} (${direction}) — Xác suất thắng ${(gateResult.winProbability * 100).toFixed(1)}% >= ${thPctLabel}% | NetEV +${gateResult.expectedValueRoi}% ROI [Risk Gatekeeper]`);

  // 4. Sinh đối tượng trade chuẩn cho bot_new
  const trade = {
    id: `${symbol}_${direction}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    symbol: symbol,
    direction: direction,
    entryPrice: entryPrice,
    targetPrice: tierSetup.tpPrice,
    targetPct: tierSetup.tpPct,
    slPrice: tierSetup.slPrice,
    slPct: tierSetup.slPct,
    beTriggerPrice: tierSetup.beTriggerPrice,
    beSlPrice: tierSetup.beSlPrice,
    leverage: tierSetup.leverage,
    margin: tierSetup.margin,
    confluenceScore: score,
    confidence: setup.confidence || 75,
    rrRatio: tierSetup.rrRatio,
    winProbability: +(gateResult.winProbability * 100).toFixed(1),
    entryFilled: false,
    status: 'active',
    recommendedAt: new Date(),
    reason: `${isReeval ? 'RE-EVAL 30m | ' : ''}QUANT 369 | Score ${score}đ [${setup.verdict}] | SL: ${tierSetup.slScenario} (+${tierSetup.slPct}%) | TP: ${tierSetup.tpAnchorType} (-${tierSetup.tpPct}%) | R:R = ${tierSetup.rrRatio} | Gate: ${(gateResult.winProbability * 100).toFixed(0)}%`,
    source: isReeval ? 'shadow_reeval_30m' : 'quantitative_deterministic'
  };

  _engineScanStats.ordersDispatched++;
  log.system(`[AutoTrade] Set leverage ${symbol}USDT = ${trade.leverage}x (Tier SL: $${trade.slPrice} (-${trade.slPct}%), TP: $${trade.targetPrice} (+${trade.targetPct}%), BE Trigger: $${trade.beTriggerPrice} | Ký quỹ: $${trade.margin})`);
  log.system(`[AutoTrade] ✓ TẠO LỆNH ĐỊNH LƯỢNG HỢP LỆ: ${symbol} ${direction} @ ${entryPrice} | SL: ${trade.slPrice} | TP: ${trade.targetPrice} | R:R: ${trade.rrRatio} | x${trade.leverage}`);
  return trade;
}

/**
 * Xử lý danh sách các setups ứng viên từ Confluence Scorer:
 * - Lọc bỏ setup bị disqualify
 * - Sắp xếp theo score giảm dần
 * - Chọn tối đa Top 2 setups tốt nhất
 * - Chạy tuần tự với giãn cách 600ms
 */
async function processCandidateSetups(allScores, marketData = null, topCap = MAX_CONCURRENT_NEW_TRADES) {
  if (!Array.isArray(allScores) || allScores.length === 0) return [];

  const tradeSizePct = parseFloat(process.env.TRADE_SIZE_PCT || '0');
  let estMargin = null;
  if (tradeSizePct > 0) {
    try {
      const bal = await getUsdtBalance();
      if (bal > 0) {
        const raw = (bal * tradeSizePct) / 100;
        const minU = parseFloat(process.env.TRADE_MIN_USDT || '5');
        const maxU = parseFloat(process.env.TRADE_MAX_USDT || '200');
        estMargin = Math.min(Math.max(raw, minU), maxU, bal);
      }
    } catch (_) {}
  }

  // Ghi nhận log Confluence Filter và Pass tương tự bot-h4
  for (const s of allScores.slice(0, 10)) {
    const isTier1 = FIXED_COINS.includes(s.symbol);
    const minRequired = isTier1 ? MIN_SCORE_TIER1 : MIN_SCORE_TIER2;
    const rankTierLabel = isTier1 ? 'Tier 1 Top 50' : 'Tier 2 Altcoin';
    const marginStr = estMargin
      ? `$${estMargin.toFixed(2)}`
      : (isTier1 ? `$${parseFloat(process.env.TRADE_AMOUNT_TIER1 || '20').toFixed(2)}` : `$${parseFloat(process.env.TRADE_AMOUNT_TIER2 || '10').toFixed(2)}`);

    const isShadow = isShadowPositionActive(s.symbol, s.direction);
    const inVetoCd = _isVetoInCooldown(s.symbol, s.direction);

    if (s.disqualified) {
      if (_shouldLogSignal(s.symbol, s.direction, 'disqualified', 10 * 60 * 1000)) {
        log.system(`[AutoTrade] 🛑 [Confluence Filter] ${s.symbol} (${s.direction}): ${s.disqualifyReason || 'Bị loại'} — Bỏ qua`);
      }
    } else if (isShadow || inVetoCd) {
      if (_shouldLogSignal(s.symbol, s.direction, 'shadow_veto_bypass', 15 * 60 * 1000)) {
        const reason = isShadow ? 'Đang theo dõi Shadow PnL' : 'Đang trong VETO Cooldown (Cản cứng chặn)';
        log.system(`[AutoTrade] 🛑 [Confluence Filter] ${s.symbol} (${s.direction}): ${reason} — Bỏ qua`);
      }
    } else if (s.total < minRequired) {
      if (s.total >= 4.0 && _shouldLogSignal(s.symbol, s.direction, 'low_score', 10 * 60 * 1000)) {
        log.system(`[AutoTrade] 🛑 [Confluence Filter] ${s.symbol} (${s.direction}): Score ${s.total.toFixed(1)}đ < ${minRequired}đ [${rankTierLabel}] — Bỏ qua (Chưa đủ điểm)`);
      }
    } else {
      if (_shouldLogSignal(s.symbol, s.direction, 'confluence_pass', 15 * 60 * 1000)) {
        const estEntry = s.targetLevel || s.price || marketData?.ta?.[s.symbol]?.price || 'Market';
        log.system(`[AutoTrade] 🎯 [CONFLUENCE PASS] ${s.symbol} → ${s.direction} (${s.total.toFixed(1)}đ >= ${minRequired}đ [${rankTierLabel}] | Ký quỹ: ${marginStr}) tại $${estEntry}`);
      }
    }
  }

  const eligible = allScores.filter(s => {
    if (s.disqualified) return false;
    if (isShadowPositionActive(s.symbol, s.direction)) return false;
    if (_isVetoInCooldown(s.symbol, s.direction)) return false;
    const isTier1 = FIXED_COINS.includes(s.symbol);
    const minRequired = isTier1 ? MIN_SCORE_TIER1 : MIN_SCORE_TIER2;
    return s.total >= minRequired;
  });

  if (eligible.length === 0) {
    return [];
  }

  eligible.sort((a, b) => b.total - a.total);

  const topCandidates = eligible.slice(0, topCap);
  log.system(`[SignalEngine] Đang duyệt Top ${topCandidates.length} ứng viên xuất sắc: ${topCandidates.map(c => `${c.symbol} ${c.direction} (${c.total}đ)`).join(', ')}`);

  const generatedTrades = [];

  for (let i = 0; i < topCandidates.length; i++) {
    const candidate = topCandidates[i];
    if (i > 0) {
      await new Promise(r => setTimeout(r, 600)); // Giãn cách 600ms chống spam
    }

    const trade = await generateQuantitativeTrade(candidate, marketData);
    if (trade) {
      generatedTrades.push(trade);
    }
  }

  return generatedTrades;
}

module.exports = {
  generateQuantitativeTrade,
  processCandidateSetups,
  consumeEngineScanStats,
  _clearVetoCooldownForTest,
  MIN_SCORE_TIER1,
  MIN_SCORE_TIER2,
  MAX_CONCURRENT_NEW_TRADES
};
