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

const { calculateTierSLTP }       = require('./tierSLTP');
const { evaluateSignal }          = require('./riskGatekeeper');
const { isDirectionLocked }       = require('./directionalCircuitBreaker');
const { isSymbolInCooldown }      = require('./cooldownManager');
const { isLevelBounceCooldown }   = require('./bounceCancel');
const { checkBtcFlashStatus }     = require('./btcFlashGuard');
const { registerShadowTrade, isShadowPositionActive } = require('./shadowTracker');
const { getMarkPrice, getPrices } = require('../pp369/stream');
const { fetchH1Historical }       = require('./candleCache');
const { getSymbolInfo, getUsdtBalance } = require('./binanceTrader');
const { log }                     = require('./logger');

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
async function generateQuantitativeTrade(setup, marketData = null) {
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
    registerShadowTrade(setup, `DIRECTIONAL_CB_LOCKED: ${dirLock.reason}`);
    return null;
  }

  // ─── CHỐT CHẶN 2: COOLDOWN TỪNG COIN (SL COOLDOWN) ───────────────
  if (isSymbolInCooldown(symbol)) {
    log.system(`[AutoTrade] 🛑 [VETO Cooldown] ${symbol} ${direction}: Coin đang trong thời gian hồi chiêu sau SL`);
    registerShadowTrade(setup, 'SYMBOL_IN_SL_COOLDOWN');
    return null;
  }

  // ─── CHỐT CHẶN 3: REAL-TIME BTC FLASH GUARD ───────────────────────
  const btcFlash = checkBtcFlashStatus();
  if (btcFlash.activeFlash === 'FLASH_DUMP' && direction === 'LONG') {
    log.system(`[AutoTrade] 🛑 [VETO BTC Flash Guard] ${symbol} LONG: Đang có bão BTC Flash Dump (${btcFlash.reason})`);
    registerShadowTrade(setup, `BTC_FLASH_DUMP: ${btcFlash.reason}`);
    return null;
  }
  if (btcFlash.activeFlash === 'FLASH_PUMP' && direction === 'SHORT') {
    log.system(`[AutoTrade] 🛑 [VETO BTC Flash Guard] ${symbol} SHORT: Đang có bão BTC Flash Pump (${btcFlash.reason})`);
    registerShadowTrade(setup, `BTC_FLASH_PUMP: ${btcFlash.reason}`);
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

  // Ưu tiên: setup.targetLevel -> nếu sig369 có targetLevel cùng chiều -> currentPrice
  let entryPrice = setup.targetLevel;
  if (!entryPrice && sig369 && sig369.signal === direction && sig369.targetLevel) {
    entryPrice = sig369.targetLevel;
  }
  if (!entryPrice) {
    entryPrice = currentPrice;
  }

  // ─── CHỐT CHẶN BẢO VỆ: CỰ LY ENTRY VS GIÁ THỊ TRƯỜNG HIỆN TẠI (TỐI ĐA 0.5%) ─────────
  const entryDistPct = Math.abs(entryPrice - currentPrice) / currentPrice;
  if (entryDistPct > 0.005) {
    log.system(`[AutoTrade] 🛑 [VETO Entry Distance] ${symbol} ${direction}: Entry $${entryPrice} cách giá hiện tại $${currentPrice} quá xa (${(entryDistPct * 100).toFixed(2)}% > 0.5%) — Hủy`);
    return null;
  }

  // ─── CHỐT CHẶN 4: BOUNCE CANCEL COOLDOWN (MỐC VỪA BẬT NẢY) ─────────
  if (isLevelBounceCooldown(symbol, entryPrice)) {
    log.system(`[AutoTrade] 🛑 [VETO Bounce Cancel] ${symbol} ${direction} @ ${entryPrice}: Mốc vừa nảy giá không khớp, đang cooldown`);
    return null;
  }

  // 2. Tính toán TP/SL & Đòn bẩy bằng Thuật toán Định Lượng (0.01ms)
  let tierSetup = null;
  const effGridWidth = setup.gridWidthPct || (sig369?.step && currentPrice > 0 ? (sig369.step / currentPrice) * 100 : null);
  try {
    const symInfo = await getSymbolInfo(symbol).catch(() => null);
    const symTickSize = symInfo?.tickSize || null;

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

    tierSetup = await calculateTierSLTP(
      symbol,
      direction,
      entryPrice,
      null, // h4Ref
      symTickSize, // tickSize (từ Binance exchangeInfo)
      10,   // maxExchangeLeverage
      3.0,  // targetLossUSD ($3.00)
      1.5,  // target tpRatio
      isTier1 ? 20 : 100, // rank
      effGridWidth,
      null, // customKlines
      customMargin
    );
  } catch (err) {
    log.error(`[AutoTrade] Lỗi calculateTierSLTP ${symbol}: ${err.message}`);
    return null;
  }

  if (!tierSetup || !tierSetup.valid) {
    const vetoReason = tierSetup?.reason || 'Không đạt chuẩn R:R';
    _setVetoCooldown(symbol, direction, 30 * 60 * 1000);
    if (_shouldLogSignal(symbol, direction, 'math_veto', 30 * 60 * 1000)) {
      log.system(`[AutoTrade] 🛑 [VETO Toán học] ${symbol} ${direction}: ${vetoReason}`);
    }
    registerShadowTrade({
      ...setup,
      entryPrice,
      slPrice: tierSetup?.slPrice,
      tpPrice: tierSetup?.tpPrice
    }, vetoReason);
    return null;
  }

  // 3. Thẩm định vi cấu trúc nến qua Risk Gatekeeper (AI Bản Thân Cục Bộ, 0ms, 0 Token)
  let lastH1 = ta?.candleH1 || null;
  if (!lastH1) {
    try {
      const h1Candles = await fetchH1Historical(symbol);
      if (Array.isArray(h1Candles) && h1Candles.length > 0) {
        lastH1 = h1Candles[h1Candles.length - 1];
      }
    } catch (_) {}
  }

  const marketContext = {
    candleH1: lastH1,
    candleM15: ta?.candleM15 || null,
    btcFlash: btcFlash.activeFlash || 'NORMAL',
    orderbookWall: 'CLEAR'
  };

  const gateResult = evaluateSignal({
    symbol,
    signal: direction,
    targetLevel: entryPrice,
    score: score,
    scoreReasons: setup.reasons || []
  }, marketContext);

  if (!gateResult.isApproved) {
    _setVetoCooldown(symbol, direction, 30 * 60 * 1000);
    if (_shouldLogSignal(symbol, direction, 'gatekeeper_veto', 30 * 60 * 1000)) {
      log.system(`[AutoTrade] 🛑 [AI VETO] ${symbol} (${direction}): ${gateResult.reason} — Bỏ qua`);
    }
    registerShadowTrade({
      ...setup,
      entryPrice,
      slPrice: tierSetup.slPrice,
      tpPrice: tierSetup.tpPrice
    }, `GATEKEEPER_VETO: ${gateResult.reason}`);
    return null;
  }

  log.system(`[AutoTrade] 🟢 [AI APPROVED] ${symbol} (${direction}) — Xác suất thắng ${(gateResult.winProbability * 100).toFixed(1)}% >= 40% [Risk Gatekeeper]`);

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
    entryFilled: false,
    status: 'active',
    recommendedAt: new Date().toISOString(),
    reason: `QUANT 369 | Score ${score}đ [${setup.verdict}] | SL: ${tierSetup.slScenario} (+${tierSetup.slPct}%) | TP: ${tierSetup.tpAnchorType} (-${tierSetup.tpPct}%) | R:R = ${tierSetup.rrRatio} | Gate: ${(gateResult.winProbability * 100).toFixed(0)}%`,
    source: 'quantitative_deterministic'
  };

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
  _clearVetoCooldownForTest,
  MIN_SCORE_TIER1,
  MIN_SCORE_TIER2,
  MAX_CONCURRENT_NEW_TRADES
};
