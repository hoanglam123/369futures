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
const { registerShadowTrade }     = require('./shadowTracker');
const { log }                     = require('./logger');

const FIXED_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'TON', 'SUI', 'APT', 'NEAR'];
const MIN_SCORE_TIER1 = 7.0; // Tier 1: BTC, ETH, Top coin >= 7.0đ
const MIN_SCORE_TIER2 = 8.0; // Tier 2: Altcoins >= 8.0đ
const MAX_CONCURRENT_NEW_TRADES = 2; // Giới hạn tối đa 2 setup mới mỗi lượt quét

/**
 * Thẩm định và tạo lệnh giao dịch định lượng cho một setup
 */
async function generateQuantitativeTrade(setup, marketData = null) {
  const symbol = setup.symbol;
  const direction = setup.direction;
  const score = setup.total;
  const isTier1 = FIXED_COINS.includes(symbol);

  const minRequired = isTier1 ? MIN_SCORE_TIER1 : MIN_SCORE_TIER2;
  if (score < minRequired) {
    return null;
  }

  // ─── CHỐT CHẶN 1: DIRECTIONAL CIRCUIT BREAKER (KHÓA THEO CHIỀU) ───
  const dirLock = isDirectionLocked(direction);
  if (dirLock.isLocked) {
    log.warn(`[SignalEngine] VETO Directional CB ${symbol} ${direction}: Chiều ${direction} đang bị khóa còn ${dirLock.remainingMinutes}p (${dirLock.reason})`);
    registerShadowTrade(setup, `DIRECTIONAL_CB_LOCKED: ${dirLock.reason}`);
    return null;
  }

  // ─── CHỐT CHẶN 2: COOLDOWN TỪNG COIN (SL COOLDOWN) ───────────────
  if (isSymbolInCooldown(symbol)) {
    log.warn(`[SignalEngine] VETO Cooldown ${symbol} ${direction}: Coin đang trong thời gian hồi chiêu sau SL`);
    registerShadowTrade(setup, 'SYMBOL_IN_SL_COOLDOWN');
    return null;
  }

  // ─── CHỐT CHẶN 3: REAL-TIME BTC FLASH GUARD ───────────────────────
  const btcFlash = checkBtcFlashStatus();
  if (btcFlash.activeFlash === 'FLASH_DUMP' && direction === 'LONG') {
    log.warn(`[SignalEngine] VETO BTC Flash Guard ${symbol} LONG: Đang có bão BTC Flash Dump (${btcFlash.reason})`);
    registerShadowTrade(setup, `BTC_FLASH_DUMP: ${btcFlash.reason}`);
    return null;
  }
  if (btcFlash.activeFlash === 'FLASH_PUMP' && direction === 'SHORT') {
    log.warn(`[SignalEngine] VETO BTC Flash Guard ${symbol} SHORT: Đang có bão BTC Flash Pump (${btcFlash.reason})`);
    registerShadowTrade(setup, `BTC_FLASH_PUMP: ${btcFlash.reason}`);
    return null;
  }

  // 1. Xác định mức giá Entry
  const ta = marketData?.ta?.[symbol];
  const sig369 = marketData?.signals369?.[symbol];
  const currentPrice = ta?.close || sig369?.price || setup.targetLevel || setup.price;

  if (!currentPrice || currentPrice <= 0) {
    log.warn(`[SignalEngine] ${symbol} ${direction}: Không có giá hợp lệ — bỏ qua`);
    return null;
  }

  const entryPrice = setup.targetLevel || currentPrice;

  // ─── CHỐT CHẶN 4: BOUNCE CANCEL COOLDOWN (MỐC VỪA BẬT NẢY) ─────────
  if (isLevelBounceCooldown(symbol, entryPrice)) {
    log.warn(`[SignalEngine] VETO Bounce Cancel ${symbol} ${direction} @ ${entryPrice}: Mốc vừa nảy giá không khớp, đang cooldown`);
    return null;
  }

  // 2. Tính toán TP/SL & Đòn bẩy bằng Thuật toán Định Lượng (0.01ms)
  let tierSetup = null;
  try {
    tierSetup = await calculateTierSLTP(
      symbol,
      direction,
      entryPrice,
      null, // h4Ref
      null, // tickSize (auto detect)
      10,   // maxExchangeLeverage
      3.0,  // targetLossUSD ($3.00)
      1.5,  // target tpRatio
      isTier1 ? 20 : 100, // rank
      setup.gridWidthPct || null
    );
  } catch (err) {
    log.error(`[SignalEngine] Lỗi calculateTierSLTP ${symbol}: ${err.message}`);
    return null;
  }

  if (!tierSetup || !tierSetup.valid) {
    const vetoReason = tierSetup?.reason || 'Không đạt chuẩn R:R';
    log.warn(`[SignalEngine] VETO toán học ${symbol} ${direction}: ${vetoReason}`);
    registerShadowTrade({
      ...setup,
      entryPrice,
      slPrice: tierSetup?.slPrice,
      tpPrice: tierSetup?.tpPrice
    }, vetoReason);
    return null;
  }

  // 3. Thẩm định vi cấu trúc nến qua Risk Gatekeeper (AI Bản Thân Cục Bộ, 0ms, 0 Token)
  const marketContext = {
    candleH1: ta?.candleH1 || null,
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
    log.warn(`[SignalEngine] VETO Risk Gatekeeper ${symbol} ${direction}: ${gateResult.reason}`);
    registerShadowTrade({
      ...setup,
      entryPrice,
      slPrice: tierSetup.slPrice,
      tpPrice: tierSetup.tpPrice
    }, `GATEKEEPER_VETO: ${gateResult.reason}`);
    return null;
  }

  // 4. Sinh đối tượng trade chuẩn cho bot_new
  const trade = {
    id: `${symbol}_${direction}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    symbol: symbol,
    direction: direction,
    entryPrice: entryPrice,
    targetPrice: tierSetup.tpPrice,
    slPrice: tierSetup.slPrice,
    beTriggerPrice: tierSetup.beTriggerPrice,
    beSlPrice: tierSetup.beSlPrice,
    leverage: tierSetup.leverage,
    margin: tierSetup.margin,
    confluenceScore: score,
    confidence: setup.confidence || 75,
    rrRatio: tierSetup.rrRatio,
    reason: `QUANT 369 | Score ${score}đ [${setup.verdict}] | SL: ${tierSetup.slScenario} (+${tierSetup.slPct}%) | TP: ${tierSetup.tpAnchorType} (-${tierSetup.tpPct}%) | R:R = ${tierSetup.rrRatio} | Gate: ${(gateResult.winProbability * 100).toFixed(0)}%`,
    source: 'quantitative_deterministic'
  };

  log.system(`[SignalEngine] ✓ TẠO LỆNH ĐỊNH LƯỢNG HỢP LỆ: ${symbol} ${direction} @ ${entryPrice} | SL: ${trade.slPrice} | TP: ${trade.targetPrice} | R:R: ${trade.rrRatio} | x${trade.leverage}`);
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

  const eligible = allScores.filter(s => {
    if (s.disqualified) return false;
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
  MIN_SCORE_TIER1,
  MIN_SCORE_TIER2,
  MAX_CONCURRENT_NEW_TRADES
};
