'use strict';

/**
 * Job chính: Điều phối toàn bộ quá trình thu thập → phân tích → gửi Telegram
 *
 * Luồng xử lý:
 *   1. Thu thập dữ liệu song song từ tất cả nguồn (CoinGecko, Alternative.me, CryptoPanic)
 *   2. Phân tích dữ liệu bằng Claude AI
 *   3. Format thành HTML và gửi lên Telegram (2 tin nhắn)
 *
 * Thiết kế fault-tolerant: nếu một nguồn dữ liệu lỗi, job vẫn chạy với dữ liệu còn lại
 */

require('dotenv').config();

const { getGlobalMarket, getTopCoins } = require('./collectors/marketData');
const { getFearGreedIndex } = require('./collectors/fearGreed');
const { getCryptoNews } = require('./collectors/cryptoNews');
const { getFundingRates } = require('./collectors/fundingRates');
const { analyzeMarket } = require('./services/aiAnalysis');
const { sendMessages, sendErrorAlert } = require('./services/telegram');
const { buildMarketMessage, buildAnalysisMessage } = require('./formatters/message');
const { parseTrades, addTrades, registerPromotedTrade, getActiveTrades } = require('./services/tradeMonitor');
const { generateQuantitativeTrade, processCandidateSetups, consumeEngineScanStats, MIN_SCORE_TIER1, MIN_SCORE_TIER2 } = require('./services/signalEngine');
const { getAllActiveFuturesSymbols, filterSymbolsByGrid } = require('./services/dynamicUniverse');
const { parseFundingTrades, addFundingTrades } = require('./services/fundingTracker');
const { getTAReport, getFullTA, STABLECOINS } = require('./collectors/technicalAnalysis');
const { getWhaleData } = require('./collectors/whaleData');
const { getDerivatives } = require('./collectors/derivatives');
const { getBTCOnchain } = require('./collectors/onchain');
const { getRedditSentiment } = require('./collectors/socialSentiment');
const { log } = require('./services/logger');
const { getRecentHistoryText } = require('./services/tradeStats');
const { scoreSetup, scoreAllSetups, formatScoresForPrompt } = require('./services/confluenceScorer');
const pp369 = require('./pp369');
pp369.setLogger(log); // dùng logger của project (ghi file data/logs/)
const {
  get369SignalsForCoins, format369ForPrompt, getLevelCache, PROXIMITY_PCT,
  logSignal369, start369Stream, getNearbySymbols, getMarkPrice, format369Alert,
  syncWebSocketSubscriptions, getPrices, updatePricesRest
} = pp369;
const { registerShadowTrade, updateShadowPrices, getShadowStats, getActiveShadowPositions, removeShadowPosition, removeShadowBySymbolDirection } = require('./services/shadowTracker');
const { initH1RefCache, prePopulateLevelCache, checkMonthTransition } = require('./services/h1RefCache');
const { isLevelBounceCooldown } = require('./services/bounceCancel');
const { isIpBanned } = require('./services/rateLimitGuard');
const binanceTrader = require('./services/binanceTrader');
const { isDirectionLocked } = require('./services/directionalCircuitBreaker');
const { isSymbolInCooldown } = require('./services/cooldownManager');

const POLL_ROTATION_TTL_MS = parseInt(process.env.POLL_ROTATION_TTL_MS || String(2 * 60 * 1000), 10); // 2 phút xoay vòng sang 8 coin tiếp theo
const _recentPollingScan = new Map(); // sym -> { level, ts }
const ONDEMAND_MACRO_TTL_MS = 15 * 60 * 1000; // 15 phút cache Whale + Derivatives on-demand cho từng Altcoin
const _onDemandMacroFetchedAt = new Map(); // sym -> ts

function mergeWhaleCache(existing, incoming) {
  if (!incoming) return existing || {};
  const base = existing || {};
  return {
    ...base,
    ...incoming,
    takerFlow:    { ...(base.takerFlow || {}),    ...(incoming.takerFlow || {}) },
    binanceLarge: { ...(base.binanceLarge || {}), ...(incoming.binanceLarge || {}) },
    crossSignals: { ...(base.crossSignals || {}), ...(incoming.crossSignals || {}) },
    liquidations: { ...(base.liquidations || {}), ...(incoming.liquidations || {}) },
    onchain:      { ...(base.onchain || {}),      ...(incoming.onchain || {}) },
  };
}

/**
 * Nạp On-Demand Whale + Derivatives riêng cho 1 Altcoin khi có tín hiệu 369 tiềm năng (đồng bộ bot-h4).
 * Chỉ kích hoạt khi chưa có cache trong 15 phút gần nhất để tiết kiệm tối đa API weight.
 */
async function ensureSymbolOnDemandMacro(sym) {
  if (!sym || isIpBanned()) return false;
  const now = Date.now();
  const lastTs = _onDemandMacroFetchedAt.get(sym) || 0;
  if (now - lastTs < ONDEMAND_MACRO_TTL_MS) return false;

  _onDemandMacroFetchedAt.set(sym, now);
  if (_onDemandMacroFetchedAt.size > 200) {
    const oldest = _onDemandMacroFetchedAt.keys().next().value;
    if (oldest) _onDemandMacroFetchedAt.delete(oldest);
  }

  try {
    const [wRes, dRes] = await Promise.allSettled([
      getWhaleData([sym], 1),
      getDerivatives([sym], 1),
    ]);
    if (!_lastMarketData) _lastMarketData = {};
    const whale = resolveSettled(wRes, null);
    if (whale) {
      _lastMarketData.whale = mergeWhaleCache(_lastMarketData.whale, whale);
    }
    const deriv = resolveSettled(dRes, null);
    if (deriv) {
      _lastMarketData.derivatives = { ...(_lastMarketData.derivatives || {}), ...deriv };
    }
    return Boolean(whale || deriv);
  } catch (_) {
    return false;
  }
}

let _isRunning = false;        // full market report đang chạy
let _isSilentRunning = false;  // signal scan (silent) đang chạy
let _scanPaused = false;       // Điều khiển tạm dừng quét từ Dashboard (Phase 5)
let _shadowOnlyMode = process.env.SHADOW_ONLY_MODE === 'true'; // Chế độ Shadow/Live từ Dashboard (Phase 5)

function setScanPaused(v) { _scanPaused = Boolean(v); log.system(`[Controls] Quét tín hiệu: ${_scanPaused ? '⏸ TẠM DỪNG' : '▶ HOẠT ĐỘNG'}`); }
function isScanPaused() { return _scanPaused; }
function setShadowOnlyMode(v) { _shadowOnlyMode = Boolean(v); log.system(`[Controls] Chế độ giao dịch: ${_shadowOnlyMode ? '👁 SHADOW ONLY (Không đặt lệnh thật)' : '⚡ LIVE TRADING'}`); }
function isShadowOnlyMode() { return _shadowOnlyMode; }

function dispatchQuantitativeTrades(quantTrades, taMap, tag) {
  if (!Array.isArray(quantTrades) || quantTrades.length === 0) return;
  if (_shadowOnlyMode) {
    for (const t of quantTrades) {
      registerShadowTrade({
        ...t,
        tpPrice: t.targetPrice,
        total: t.confluenceScore
      }, `SHADOW_ONLY_MODE (${tag})`);
    }
    log.system(`[${tag}] 👁 Chế độ SHADOW ONLY đang bật — đã chuyển ${quantTrades.length} setup sang Shadow Tracker (không đặt lệnh Binance)`);
    return;
  }
  addTrades(quantTrades, taMap || {});
}
const _prev369State = {};      // { [symbol]: key } tránh gửi alert PP369 trùng lặp
let _lastTaSymbols  = null;    // coin list cache từ lần runJob() gần nhất, dùng cho scan 1p
let _universeSymbols = null;   // Universe 400+ coin năng động từ Binance Futures
let _lastMarketData = null;    // market data cache (TA/whale/deriv) cho confluence re-score trong scan 1p
let _lastHeartbeatTime = 0;    // Heartbeat định kỳ 15 phút đồng bộ bot-h4
let _hasLoggedInitialHeartbeat = false;
const _scanWindowStats = {
  pollCycles: 0,
  wsTicks: 0,
  coinsChecked: 0,
  signals369: 0,
  rejectHardFilter: 0,
  rejectScore: 0,
};

async function getUniverseSymbols() {
  if (_universeSymbols && _universeSymbols.length > 0) {
    return _universeSymbols;
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const symFile = path.join(__dirname, '..', 'data', 'pp369_symbols.json');
    if (fs.existsSync(symFile)) {
      const data = JSON.parse(fs.readFileSync(symFile, 'utf8'));
      if (Array.isArray(data.symbols) && data.symbols.length > 0) {
        _universeSymbols = data.symbols;
        return _universeSymbols;
      }
    }
  } catch (_) {}

  try {
    const all = await getAllActiveFuturesSymbols();
    const valid = filterSymbolsByGrid(all, getPrices());
    if (valid.length > 0) {
      _universeSymbols = valid;
      return _universeSymbols;
    }
  } catch (_) {}

  return _lastTaSymbols ?? FIXED_COINS;
}

function setUniverseSymbols(syms) {
  if (Array.isArray(syms) && syms.length > 0) {
    _universeSymbols = [...syms];
  }
}

// ─── Tham số cấu hình (đọc từ .env, có giá trị mặc định hợp lý) ──────────────

// FIXED_COINS: coin luôn được phân tích TA đầy đủ bất kể market cap hay trend
// Thêm/bớt coin bằng cách sửa biến môi trường: FIXED_COINS=BTC,ETH,SOL,BNB
const FIXED_COINS = process.env.FIXED_COINS
  ? process.env.FIXED_COINS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'];

// TIER2_COINS: coin vốn hoá lớn, thanh khoản cao — ngưỡng score bằng FIXED (≥7)
// Thêm/bớt: TIER2_COINS=LTC,AVAX,LINK,ATOM trong .env
const TIER2_COINS = process.env.TIER2_COINS
  ? process.env.TIER2_COINS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : ['LTC', 'AVAX', 'LINK', 'ATOM', 'DOT', 'NEAR'];

// MIN_SCORE_EXTRA: ngưỡng tối thiểu cho LIQUID CAO và GAINERS (cao hơn FIXED/TIER2)
const MIN_SCORE_EXTRA = parseInt(process.env.MIN_SCORE_EXTRA || '8', 10);

// MAX_EXTRA_COINS: số coin liquid nhất ngoài FIXED_COINS được thêm vào phân tích
// Tăng = bao quát hơn nhưng tốn thêm API call và Gemini token
const MAX_EXTRA_COINS  = parseInt(process.env.MAX_EXTRA_COINS  || '10', 10);

// MAX_GAINER_COINS: số coin tăng mạnh nhất được thêm vào để bắt trend mới nổi
const MAX_GAINER_COINS = parseInt(process.env.MAX_GAINER_COINS || '10', 10);

// MAX_TA_COINS: tổng số coin tối đa cho TA + Whale (tránh quá tải API / context AI)
// Coinalyze cho phép tối đa 20 symbol/request (BATCH=20), không nên vượt quá 20
const MAX_TA_COINS     = parseInt(process.env.MAX_TA_COINS     || '20', 10);

// MIN_SCORE_SIGNAL: điểm confluence tối thiểu để signal scan (5p) gọi Gemini AI
// Tăng = ít tốn quota Gemini hơn nhưng bỏ lỡ cơ hội vào lệnh sớm
// Giảm = gọi AI thường xuyên hơn, tốn quota, nhiều nhiễu hơn
const MIN_SCORE_SIGNAL    = parseInt(process.env.MIN_SCORE_SIGNAL    || '7', 10);

// MIN_SCORE_TRADE: điểm confluence tối thiểu để chấp nhận lệnh AI khuyến nghị
// Nên bằng hoặc cao hơn MIN_SCORE_SIGNAL — tránh nhận lệnh chất lượng thấp
const MIN_SCORE_TRADE     = parseInt(process.env.MIN_SCORE_TRADE     || '7', 10);

// MIN_SCORE_REVERSAL: điểm tối thiểu để cho phép đảo chiều lệnh đang active
// Cần cao hơn MIN_SCORE_TRADE vì đảo chiều rủi ro hơn (cắt lỗ + vào lệnh ngược)
const MIN_SCORE_REVERSAL  = parseInt(process.env.MIN_SCORE_REVERSAL  || '9', 10);

// NEWS_ENABLED: bật/tắt thu thập tin tức crypto (mặc định: true)
const NEWS_ENABLED        = process.env.NEWS_ENABLED        !== 'false';
// AI_ANALYSIS_ENABLED: tắt mặc định (chỉ bật khi chủ động đặt AI_ANALYSIS_ENABLED=true trong .env)
// Hệ thống giao dịch chạy 100% Định lượng + Local ML Gatekeeper (0 Token, không gọi Claude/Gemini)
const AI_ANALYSIS_ENABLED = process.env.AI_ANALYSIS_ENABLED === 'true';
// TELEGRAM_NEWS_CHAT_ID: kênh nhận bản tin thị trường + phân tích AI (để trống = dùng TELEGRAM_CHAT_ID)
const NEWS_CHAT_ID        = process.env.TELEGRAM_NEWS_CHAT_ID || null;

// silent=true: chạy phân tích nhưng không gửi bản tin thị trường
// lookbackHours: override số giờ lookback cho whale/derivatives (mặc định theo CRON_SCHEDULE)
async function runJob({ silent = false, lookbackHours = null } = {}) {
  if (silent) {
    // Signal scan bị block nếu có job nào đang chạy (main hoặc scan khác)
    if (_isRunning || _isSilentRunning) {
      log.warn('Job đang chạy, bỏ qua signal scan này');
      return;
    }
    _isSilentRunning = true;
  } else {
    // Main job CHỈ bị block bởi chính nó — KHÔNG bị block bởi signal scan
    if (_isRunning) {
      log.warn('Job đang chạy, bỏ qua lần gọi này');
      return;
    }
    _isRunning = true;
  }
  const jobStart = Date.now();
  if (!silent) {
    log.system('=== BẮT ĐẦU CHẠY JOB ===');
    log.system('Thu thập dữ liệu từ các nguồn...');
  }

  try {
    const [globalResult, coinsResult, fearGreedResult, newsResult, fundingResult] = await Promise.allSettled([
      getGlobalMarket(),
      getTopCoins(20), // lấy top 20 để có đủ coin liquid sau khi lọc fixed list
      getFearGreedIndex(),
      NEWS_ENABLED ? getCryptoNews(10) : Promise.resolve([]),
      getFundingRates(),
    ]);

    // Ghi log trạng thái từng nguồn
    logSourceStatus('CoinGecko (Global)', globalResult);
    logSourceStatus('CoinGecko (Coins)', coinsResult);
    logSourceStatus('Fear & Greed', fearGreedResult);
    logSourceStatus('News (multi-source)', newsResult);
    logSourceStatus('Funding Rates (BN+BB)', fundingResult);

    // Tổng hợp dữ liệu — dùng giá trị mặc định an toàn nếu nguồn lỗi
    const marketData = {
      globalMarket: resolveSettled(globalResult, null),
      topCoins: resolveSettled(coinsResult, { topCoins: [], topGainers: [], topLosers: {} })?.topCoins ?? [],
      topGainers: resolveSettled(coinsResult, { topCoins: [], topGainers: [], topLosers: [] })?.topGainers ?? [],
      topLosers: resolveSettled(coinsResult, { topCoins: [], topGainers: [], topLosers: [] })?.topLosers ?? [],
      fearGreed: resolveSettled(fearGreedResult, { value: 50, classificationVi: 'Trung lập' }),
      news: resolveSettled(newsResult, []),
      funding: resolveSettled(fundingResult, null),
    };

    const dataCount = [
      marketData.globalMarket ? 'Global' : null,
      marketData.topCoins.length > 0 ? `${marketData.topCoins.length} coins` : null,
      marketData.fearGreed ? 'Fear&Greed' : null,
      marketData.news.length > 0 ? `${marketData.news.length} tin` : null,
      marketData.funding ? 'Funding OK' : null
    ].filter(Boolean).join(', ');

    if (!silent) log.system(`Thu thập OK: ${dataCount || 'không có dữ liệu'}`);

    // Kiểm tra dữ liệu tối thiểu để gửi được bản tin
    if (!marketData.topCoins.length && !marketData.globalMarket) {
      throw new Error('Không đủ dữ liệu thị trường để tạo bản tin. Kiểm tra kết nối CoinGecko API.');
    }

    // ─── BƯỚC 1.5: Chuẩn bị symbols + thu thập dữ liệu nâng cao (song song) ────
    const cronHours = lookbackHours ?? parseCronIntervalHours(process.env.CRON_SCHEDULE || '0 */4 * * *');

    // Symbol hợp lệ: chỉ chữ cái + số (loại FIGR_HELOC, tokenized assets, v.v.)
    const isValidSymbol = s => /^[A-Z0-9]+$/.test(s) && !STABLECOINS.has(s);

    // TIER2: coin lớn, liquid — loại trùng với FIXED
    const tier2Active = TIER2_COINS.filter(s => isValidSymbol(s) && !FIXED_COINS.includes(s));

    // Top N liquid tiếp theo — loại trùng FIXED và TIER2
    const topLiquidExtra = marketData.topCoins
      .map(c => c.symbol)
      .filter(s => isValidSymbol(s) && !FIXED_COINS.includes(s) && !TIER2_COINS.includes(s))
      .slice(0, MAX_EXTRA_COINS);

    // Top N gainers — chỉ lấy coin trong top market cap, loại trùng FIXED và TIER2
    const topCoinSymbols = new Set(marketData.topCoins.map(c => c.symbol));
    const gainersFiltered = (marketData.topGainers || [])
      .map(c => c.symbol)
      .filter(s => isValidSymbol(s) && topCoinSymbols.has(s) && !FIXED_COINS.includes(s) && !TIER2_COINS.includes(s))
      .slice(0, MAX_GAINER_COINS);

    // Lấy thêm các coin trong Universe 470+ đang TIỆM CẬN SÁT MỐC (<=0.5%)
    let universeNearby = [];
    try {
      const levelCache = getLevelCache();
      const allUniverse = await getUniverseSymbols();
      const scanNearby = getNearbySymbols(allUniverse, levelCache, 0.005, true);
      universeNearby = scanNearby
        .filter(s => isValidSymbol(s) && !FIXED_COINS.includes(s) && !TIER2_COINS.includes(s))
        .slice(0, 15);
    } catch (_) {}

    // TA + Whale: FIXED → TIER2 → UNIVERSE_NEARBY → LIQUID → GAINERS, dedup
    const maxTaLimit   = Math.max(MAX_TA_COINS, 30);
    const taSymbols    = [...new Set([...FIXED_COINS, ...tier2Active, ...universeNearby, ...topLiquidExtra, ...gainersFiltered])].slice(0, maxTaLimit);
    const whaleSymbols = [...taSymbols];
    _lastTaSymbols = [...taSymbols];  // cache cho scan PP369 1 phút

    // Đồng bộ danh sách Universe 470+ coin ra file để dashboard đọc
    const allMonitoredUniverse = await getUniverseSymbols();

    // Lưu danh sách coin đang theo dõi ra file để dashboard đọc
    try {
      const dataDir = require('path').join(__dirname, '..', 'data');
      require('fs').writeFileSync(
        require('path').join(dataDir, 'pp369_symbols.json'),
        JSON.stringify({
          symbols:  allMonitoredUniverse,
          fixed:    FIXED_COINS,
          tier2:    tier2Active,
          nearby:   universeNearby,
          liquid:   topLiquidExtra,
          gainers:  gainersFiltered,
          updatedAt: new Date().toISOString(),
          source:   'job',
        }),
        'utf8'
      );
    } catch {}


    if (!silent) {
      log.system(`Fixed: [${FIXED_COINS.join(',')}] | Tier2 (≥${MIN_SCORE_TRADE}đ): [${tier2Active.join(',')}]`);
      log.system(`Extra liquid (≥${MIN_SCORE_EXTRA}đ): [${topLiquidExtra.join(',')}] | Gainers (≥${MIN_SCORE_EXTRA}đ): [${gainersFiltered.join(',')}]`);
      log.system(`TA + Whale: ${taSymbols.length} coins → [${taSymbols.join(', ')}]`);
    }

    const priceMap369 = Object.fromEntries(
      taSymbols.map(s => [s, { price: getMarkPrice(s) || getPrices()[s] || null }]).filter(([, v]) => v.price != null)
    );

    // Chế độ silent (quét nền): Chỉ lấy dữ liệu vĩ mô nhẹ & BTC/ETH whale (tránh bắn /aggTrades & CoinGecko cho 30 coin)
    const whaleTargetSymbols = silent ? ['BTC', 'ETH'] : whaleSymbols;
    const derivTargetSymbols = silent ? ['BTC', 'ETH'] : whaleSymbols;

    const [taResult, whaleResult, derivResult, onchainResult, socialResult, signals369Result] = await Promise.allSettled([
      getTAReport(taSymbols),
      getWhaleData(whaleTargetSymbols, cronHours),
      getDerivatives(derivTargetSymbols, cronHours),
      silent ? Promise.resolve(_lastMarketData?.onchain ?? null) : getBTCOnchain(),
      silent ? Promise.resolve(_lastMarketData?.social ?? null) : getRedditSentiment(),
      get369SignalsForCoins(taSymbols, priceMap369),
    ]);

    logSourceStatus('Technical Analysis', taResult);
    marketData.ta = resolveSettled(taResult, {});
    if (!silent) log.system(`TA hoàn thành: ${Object.keys(marketData.ta).join(', ') || 'không có'}`);

    logSourceStatus('Whale Data (Binance+OKX)', whaleResult);
    marketData.whale = resolveSettled(whaleResult, null);
    if (marketData.whale && !silent) {
      const flowKeys = Object.keys(marketData.whale.takerFlow    || {});
      const bnKeys   = Object.keys(marketData.whale.binanceLarge || {});
      log.system(`Whale: Flow [${flowKeys.join(',')||'—'}] | BN [${bnKeys.join(',')||'—'}]`);
    }

    logSourceStatus('Derivatives (Binance OI/L/S)', derivResult);
    marketData.derivatives = resolveSettled(derivResult, null);
    if (marketData.derivatives && !silent) {
      log.system(`Derivatives: ${Object.keys(marketData.derivatives).join(', ') || '—'}`);
    }

    logSourceStatus('BTC On-chain (mempool.space)', onchainResult);
    marketData.onchain = resolveSettled(onchainResult, null);

    logSourceStatus('Reddit Sentiment', socialResult);
    marketData.social = resolveSettled(socialResult, null);
    if (marketData.social && !silent) {
      const s = marketData.social;
      log.system(`Reddit: ${s.sentiment} (${s.bullishPct}% bull / ${s.bearishPct}% bear, ${s.totalPosts} posts)`);
    }

    logSourceStatus('PP369 (mốc phản ứng tháng)', signals369Result);
    marketData.signals369 = resolveSettled(signals369Result, {});
    const sig369Active = Object.values(marketData.signals369).filter(s => s.signal !== 'NONE');
    if (sig369Active.length > 0) {
      log.system(`PP369: ${sig369Active.map(s => `${s.symbol}=${s.signal}(${s.strength})`).join(' | ')}`);
    }

    // Merge vào cache thay vì ghi đè xóa sạch TA của các altcoin ngoài Top 30
    _lastMarketData = {
      ...(_lastMarketData || {}),
      ta:          { ...(_lastMarketData?.ta || {}), ...(marketData.ta || {}) },
      whale:       marketData.whale || _lastMarketData?.whale || null,
      derivatives: marketData.derivatives || _lastMarketData?.derivatives || null,
      funding:     marketData.funding || _lastMarketData?.funding || null,
      fearGreed:   marketData.fearGreed || _lastMarketData?.fearGreed || { value: 50 },
      social:      marketData.social || _lastMarketData?.social || null,
    };

    // ─── BƯỚC 1.7: Chấm điểm confluence (deterministic, trước khi gọi AI) ───
    const taSymbolList = Object.keys(marketData.ta);
    const allScores = scoreAllSetups(
      taSymbolList,
      marketData.ta,
      marketData.whale,
      marketData.derivatives,
      marketData.funding,
      marketData.fearGreed,
      marketData.social,
      marketData.signals369,
    );

    // Lọc cứng: disqualify setup của coin đang có lệnh active
    //   - Cùng chiều  → luôn disqualify (vào lệnh trùng)
    //   - Ngược chiều → disqualify trừ khi ≥9đ (đảo chiều cần BEST_OPPORTUNITY)
    const activeTrades = getActiveTrades();
    if (activeTrades.length > 0) {
      const activeMap = {};
      for (const t of activeTrades) activeMap[t.symbol] = t.direction;
      for (const s of allScores) {
        if (s.disqualified || !activeMap[s.symbol]) continue;
        const activeDir = activeMap[s.symbol];
        if (s.direction === activeDir) {
          s.disqualified = true;
          s.disqualifyReason = `Đang có lệnh ${activeDir} active`;
        } else if (s.total < MIN_SCORE_REVERSAL) {
          s.disqualified = true;
          s.disqualifyReason = `Đảo chiều cần ≥${MIN_SCORE_REVERSAL}đ (hiện ${s.total}đ)`;
        }
      }
    }

    const bestScore  = allScores.filter(s => !s.disqualified)[0]?.total ?? 0;
    const passCount  = allScores.filter(s => !s.disqualified && s.total >= 5).length;
    log.system(`Confluence scores: best=${bestScore}đ | pass(≥5đ)=${passCount}/${allScores.length} setups`);

    // ─── PP369: Chỉ ghi log nội bộ khi có tín hiệu mới (đã tắt bắn alert Telegram thô) ──
    const new369Alerts = detect369Changes(marketData.signals369);
    if (new369Alerts.length > 0) {
      new369Alerts.forEach(sig => logSignal369(sig));
    }

    // ─── BƯỚC 2: THỰC THI GIAO DỊCH ĐỊNH LƯỢNG 100% (PHASE 2 UPGRADE) ───
    if (!_scanPaused) {
      log.system('Đang quét và tính toán lệnh định lượng (Tier 1 >= 7.0đ, Tier 2 >= 8.0đ)...');
      try {
        const quantTrades = await processCandidateSetups(allScores, marketData, 2);
        if (quantTrades.length > 0) {
          log.trade(`[SignalEngine] ${quantTrades.length} lệnh định lượng đủ điều kiện, bắt đầu theo dõi & đặt lệnh sàn`);
          dispatchQuantitativeTrades(quantTrades, marketData.ta ?? {}, 'SignalEngine');
        } else {
          log.system('[SignalEngine] Không có setup định lượng nào vượt qua bộ lọc & Gatekeeper');
        }
      } catch (engineErr) {
        log.error('[SignalEngine] Lỗi thực thi signalEngine:', { error: engineErr.message });
      }
    } else {
      log.system('[SignalEngine] ⏸ Đang tạm dừng quét tín hiệu theo lệnh từ Dashboard.');
    }

    // ─── BƯỚC 2.5: Phân tích AI chỉ chạy khi gửi bản tin sáng (!silent) ───
    let analysisText = null;
    let aiModel = null;

    if (!silent && AI_ANALYSIS_ENABLED) {
      log.ai('Gọi Gemini AI viết nhận định bản tin sáng (narrative)...');
      const recentHistoryText = getRecentHistoryText(5);
      const scoresText = formatScoresForPrompt(allScores);
      const signals369Text = format369ForPrompt(marketData.signals369);
      if (activeTrades.length > 0) {
        log.ai(`Truyền ${activeTrades.length} lệnh active vào AI context`);
      }

      try {
        const aiResult = await analyzeMarket(marketData, { activeTrades, recentHistoryText, scoresText, signals369Text });
        analysisText = aiResult.analysis;
        aiModel = aiResult.model;
        log.ai(`Phân tích hoàn thành`, { model: aiModel, chars: analysisText.length });
      } catch (aiErr) {
        log.error('Lỗi phân tích AI — bỏ qua phân tích bản tin sáng', { error: aiErr.message });
        analysisText = [
          '<b>🎯 Tổng quan thị trường</b>',
          'Hiện tại không thể tạo phân tích AI do lỗi kết nối.',
          '',
          'Vui lòng xem dữ liệu thị trường ở phần trên để đánh giá tình hình.',
          '',
          '<i>⚠️ Đây là phân tích tham khảo, không phải lời khuyên đầu tư</i>'
        ].join('\n');
      }
    }

    // ─── BƯỚC 3: Format và gửi Telegram ─────────────────
    if (!silent) {
      const marketMessage = buildMarketMessage(marketData);
      const msgs = [marketMessage];
      if (analysisText) {
        msgs.push(buildAnalysisMessage(analysisText, aiModel));
      }
      const targetLabel = NEWS_CHAT_ID ? `news channel (${NEWS_CHAT_ID})` : 'channel chính';
      log.telegram(`Gửi bản tin: ${msgs.map(m => m.length + 'c').join(' + ')} → ${targetLabel}`);
      await sendMessages(msgs, 1500, NEWS_CHAT_ID);

      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
      log.system(`=== JOB HOÀN THÀNH (${elapsed}s) ===`);
    }

  } catch (err) {
    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    log.error(`Job thất bại sau ${elapsed}s`, { error: err.message, stack: err.stack });

    if (!silent) {
      try {
        await sendErrorAlert(`${err.message}\n\nThời gian: ${elapsed}s`);
      } catch (alertErr) {
        log.error('Không thể gửi thông báo lỗi', { error: alertErr.message });
      }
    }
  } finally {
    if (silent) _isSilentRunning = false;
    else _isRunning = false;
  }
}

/**
 * Lấy giá trị từ Promise.allSettled result, trả về fallback nếu bị rejected
 */
function resolveSettled(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

/**
 * Ghi log trạng thái của từng nguồn dữ liệu
 */
function logSourceStatus(name, result) {
  if (result.status !== 'fulfilled') {
    log.warn(`[FAIL] ${name}`, { error: result.reason?.message ?? 'Lỗi không xác định' });
  }
}

function isJobRunning() { return _isRunning || _isSilentRunning; }

/**
 * So sánh tín hiệu 369 hiện tại với state đã alert lần trước.
 * Trả về chỉ những tín hiệu mới hoặc đã thay đổi level/lần.
 */
function detect369Changes(signals369Map) {
  const alerts = [];
  for (const [symbol, sig] of Object.entries(signals369Map)) {
    if (sig.signal !== 'LONG' && sig.signal !== 'SHORT') {
      // Không xóa state — giữ để tránh re-alert khi giá đi ra rồi quay lại cùng mốc.
      // State chỉ đổi khi signal mới có key khác (mốc/lần/hướng thay đổi).
      continue;
    }
    // Chỉ phân biệt 3 mức: strong(0), medium(1), weak(2+)
    // touchCount≥2 đều là "yếu" — không re-alert mỗi lần bounce thêm ở cùng mốc
    const touchKey = Math.min(sig.touchCount, 2);
    const key = `${sig.signal}_${sig.targetLevel}_${touchKey}`;
    if (_prev369State[symbol] === key) continue;
    _prev369State[symbol] = key;
    alerts.push(sig);
  }
  return alerts;
}


// Suy ra số giờ giữa các lần chạy từ cron expression
// Hỗ trợ: "0 */N * * *" → N giờ | "0 H * * *" → 24h | mặc định 4h
function parseCronIntervalHours(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return 4;
  const hourField = parts[1];
  const m = hourField.match(/^\*\/(\d+)$/);  // */4 → 4
  if (m) return parseInt(m[1]);
  if (/^\d+$/.test(hourField)) return 24;    // fixed hour → daily
  return 4;
}

// ─── STATE QUẢN LÝ QUÉT & CONCURRENCY POOL (ĐỒNG BỘ TỪ BOT-H4) ─────────────
let _isAlertScanRunning = false;
const _processingSymbols = new Set();
const _symbolSignalCooldown = {};
const MAX_CONCURRENT_SIGNAL_CHECKS = 1;
let _activeSignalChecks = 0;
const _signalCheckQueue = [];

/**
 * Scan PP369 nhẹ & nhanh — đồng bộ 2 tầng từ bot-h4:
 * 1. Cập nhật giá REST + WebSocket đăng ký coin sát mốc (<= 1.0%)
 * 2. Lọc Top 8 coin tiệm cận sát mốc nhất (<= 0.5%)
 * 3. Chấm điểm Confluence & thực thi đặt lệnh Limit định lượng (KHÔNG bị chặn bởi alert deduplication)
 * 4. Alert Telegram độc lập khi có tín hiệu mới (dùng detect369Changes để chống spam)
 */
async function run369AlertScan() {
  if (_isAlertScanRunning || isIpBanned() || _scanPaused) return;
  _isAlertScanRunning = true;
  _scanWindowStats.pollCycles++;
  try {
    const symbols = await getUniverseSymbols();
    // 1. Cập nhật lại giá REST của toàn bộ coin để kiểm tra biến động (1 call nhẹ, weight=1) giống bot-h4
    if (typeof updatePricesRest === 'function' && !isIpBanned()) {
      try { await updatePricesRest(); } catch (_) {}
    }

    // Tự động kiểm tra chuyển giao mốc H1 đầu tháng khi sang tháng mới
    if (typeof checkMonthTransition === 'function' && !isIpBanned()) {
      try {
        await checkMonthTransition(symbols, getPrices());
      } catch (_) {}
    }

    let levelCache = getLevelCache();
    if (Object.keys(levelCache).length === 0 && !isIpBanned()) {
      await initH1RefCache(symbols);
    }
    // Đồng bộ bot-h4: luôn làm mới cặp mốc cận trên/dưới theo giá live (0ms trên RAM, 0 API call) để không bị "mù mốc" khi giá sang bậc lưới mới
    try {
      prePopulateLevelCache(symbols, getPrices());
      levelCache = getLevelCache();
    } catch (_) {}

    // 2. WebSocket đón trước: Lắng nghe các coin trong bán kính 1.0% + coin có vị thế active + shadow + BTC
    const wsNearby = getNearbySymbols(symbols, levelCache, 0.01);
    const activeTradesNow = getActiveTrades();
    const activeSymbols = activeTradesNow.map(t => t.symbol);
    const activeMapNow = Object.fromEntries(activeTradesNow.map(t => [t.symbol, t.direction]));
    const activeShadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
    const shadowSyms = Object.values(activeShadows).map(p => p.symbol);
    const shadowSymSet = new Set(shadowSyms);
    const wsAllSymbols = Array.from(new Set([...wsNearby, ...activeSymbols, ...shadowSyms, 'BTC']));
    if (typeof syncWebSocketSubscriptions === 'function') {
      syncWebSocketSubscriptions(wsAllSymbols).catch(() => {});
    }

    // Cập nhật giá cho Shadow Tracker (Phase 5)
    if (typeof updateShadowPrices === 'function' && typeof getPrices === 'function') {
      try { updateShadowPrices(getPrices()); } catch (_) {}
    }

    // 3. Vòng lặp Scan định kỳ chỉ xử lý các coin đang thực sự TIỆM CẬN SÁT MỐC (<= 0.5%) để tối ưu tốc độ vào lệnh
    const scanNearby = getNearbySymbols(symbols, levelCache, 0.005, true);
    const missingLvlCount = symbols.filter(s => !levelCache[s]?.longEntry || !levelCache[s]?.shortEntry).length;

    // ─── ĐỒNG BỘ LOG & TELEGRAM TỔNG HỢP ĐỊNH KỲ 15 PHÚT ───
    const nowTime = Date.now();
    if (!_hasLoggedInitialHeartbeat) {
      _hasLoggedInitialHeartbeat = true;
      _lastHeartbeatTime = nowTime;
      const missingNote = missingLvlCount > 0 ? ` (chưa có mốc: ${missingLvlCount})` : '';
      log.system(`[AutoTrade] 🟢 Hệ thống hoạt động bình thường | Theo dõi: ${symbols.length} coin | Tiệm cận sát mốc (<=0.5%): ${scanNearby.length} coin${missingNote}`);
    } else if (nowTime - _lastHeartbeatTime >= 15 * 60 * 1000) {
      _lastHeartbeatTime = nowTime;
      const eng = consumeEngineScanStats();
      const st = { ..._scanWindowStats, ...eng };
      _scanWindowStats.pollCycles = 0;
      _scanWindowStats.wsTicks = 0;
      _scanWindowStats.coinsChecked = 0;
      _scanWindowStats.signals369 = 0;
      _scanWindowStats.rejectHardFilter = 0;
      _scanWindowStats.rejectScore = 0;

      const missingNote = missingLvlCount > 0 ? ` (chưa có mốc: ${missingLvlCount})` : '';
      log.system(
        `[AutoTrade] 🟢 Nhịp tim 15p | Theo dõi: ${symbols.length} coin | Sát mốc (<=0.5%): ${scanNearby.length} coin${missingNote} | ` +
        `Quét: ${st.pollCycles} poll + ${st.wsTicks} WS (${st.coinsChecked} lượt coin) | 369: ${st.signals369} | ` +
        `Lọc: Hard=${st.rejectHardFilter}, Điểm=${st.rejectScore}, R:R=${st.rejectMath}, Gate=${st.rejectGatekeeper} | Vào lệnh: ${st.ordersDispatched}`
      );

      let shadowLine = '';
      try {
        const shadowStats = getShadowStats();
        if (shadowStats && (shadowStats.activeCount > 0 || shadowStats.totalSavedSl > 0 || shadowStats.totalMissedTp > 0)) {
          log.system(`[Shadow PnL] 📊 Thống kê AI Veto: Đang theo dõi: ${shadowStats.activeCount} lệnh | Đã cứu SL: ${shadowStats.totalSavedSl} lệnh (+$${shadowStats.savedUsd}) | Bỏ lỡ TP: ${shadowStats.totalMissedTp} lệnh (-$${shadowStats.missedUsd}) | Giá trị AI ròng: +$${shadowStats.netSavedUsd} USD (Độ chính xác Veto: ${shadowStats.vetoAccuracyPct}%)`);
          shadowLine = `\n👁️ Shadow Veto: <b>${shadowStats.activeCount}</b> đang theo dõi · Cứu SL <b>${shadowStats.totalSavedSl}</b> / Bỏ lỡ TP <b>${shadowStats.totalMissedTp}</b> (${shadowStats.vetoAccuracyPct}%)`;
        }
      } catch (_) {}

      if (process.env.ENABLE_HEARTBEAT_TELEGRAM !== 'false') {
        const hbMsg =
          `💓 <b>NHỊP TIM QUÉT 15 PHÚT — BOT-NEW</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📡 Theo dõi: <b>${symbols.length} coin</b> | Sát mốc (≤0.5%): <b>${scanNearby.length} coin</b> | Đang mở: <b>${activeTradesNow.length} lệnh</b>\n` +
          `🔍 Đã quét: <b>${st.pollCycles} lượt</b> (Polling) + <b>${st.wsTicks} tick</b> (WS 0ms) · <b>${st.coinsChecked}</b> lượt coin\n` +
          `📐 Tín hiệu 369: <b>${st.signals369}</b>\n` +
          `🛑 Bị lọc: Hard <b>${st.rejectHardFilter}</b> · Điểm <b>${st.rejectScore}</b> · R:R/SLTP <b>${st.rejectMath}</b> · AI/Gate <b>${st.rejectGatekeeper}</b>\n` +
          `🚀 Đẩy vào lệnh: <b>${st.ordersDispatched}</b>` +
          shadowLine;
        sendMessages([hbMsg]).catch(() => {});
      }
    }

    if (!scanNearby.length || isIpBanned()) return;

    // Dọn bộ nhớ xoay vòng quá hạn (> 5 phút)
    for (const [k, v] of _recentPollingScan.entries()) {
      if (nowTime - v.ts > 5 * 60 * 1000) _recentPollingScan.delete(k);
    }

    // Lọc trước các coin chắc chắn không vào được lệnh & xoay vòng Top 8 cuốn chiếu (tránh kẹt lặp lại 8 coin cũ)
    const eligibleNearby = [];
    for (const sym of scanNearby) {
      if (_processingSymbols.has(sym) || shadowSymSet.has(sym)) continue;
      const p = getMarkPrice(sym) || getPrices()?.[sym] || _lastMarketData?.ta?.[sym]?.price;
      const lv = levelCache[sym];
      if (!p || !lv?.longEntry || !lv?.shortEntry) continue;

      const dLong = Math.abs(p - lv.longEntry) / p;
      const dShort = Math.abs(lv.shortEntry - p) / p;
      const nearestDir = dLong <= dShort ? 'LONG' : 'SHORT';
      const nearestLevel = nearestDir === 'LONG' ? lv.longEntry : lv.shortEntry;
      const distPct = Math.min(dLong, dShort);

      // Đang mở lệnh cùng chiều → bỏ qua trước khi cắt Top 8 (giữ lại nếu là chiều đảo chiều)
      if (activeMapNow[sym] && activeMapNow[sym] === nearestDir) continue;
      // Mốc đang dính Bounce / Timeout Cooldown → bỏ qua trước khi cắt Top 8
      if (isLevelBounceCooldown(sym, nearestLevel)) continue;
      // Xoay vòng Top 8: coin vừa chấm ở cùng mốc trong 2 phút gần nhất tạm nghỉ để 8 coin kế tiếp được chấm
      const prevScan = _recentPollingScan.get(sym);
      if (prevScan && prevScan.level === nearestLevel && (nowTime - prevScan.ts) < POLL_ROTATION_TTL_MS) continue;

      eligibleNearby.push({ sym, distPct, nearestLevel });
    }

    if (!eligibleNearby.length) return;

    eligibleNearby.sort((a, b) => a.distPct - b.distPct);
    const selectedBatch = eligibleNearby.slice(0, 8);
    for (const item of selectedBatch) {
      _recentPollingScan.set(item.sym, { level: item.nearestLevel, ts: nowTime });
    }
    const toScan = selectedBatch.map(item => item.sym);
    _scanWindowStats.coinsChecked += toScan.length;

    // Dùng WebSocket mark price từ Binance (~3s) thay vì nến 1m cuối (~1 phút trễ)
    const priceMap = Object.fromEntries(
      toScan.map(s => [s, { price: getMarkPrice(s) }]).filter(([, v]) => v.price != null)
    );
    const signals369 = await get369SignalsForCoins(toScan, priceMap);

    // ── TÁCH RỜI LUỒNG TÍNH LỆNH ĐỊNH LƯỢNG KHỎI LUỒNG TELEGRAM ALERT (ĐỒNG BỘ BOT-H4) ──
    const validSignals = Object.values(signals369).filter(s => s && (s.signal === 'LONG' || s.signal === 'SHORT'));
    _scanWindowStats.signals369 += validSignals.length;

    // Chạy tuần tự có kiểm soát Rate Limit thay vì Promise.all ồ ạt (áp dụng TTL 10p cho TA cache & chống đụng WS Tick)
    const TA_CACHE_TTL_MS = 10 * 60 * 1000;
    const enriched = [];
    for (const sig of validSignals) {
      if (isIpBanned()) break;
      if (_processingSymbols.has(sig.symbol)) continue;
      let ta = _lastMarketData?.ta?.[sig.symbol];
      const isTaStale = !ta || !ta._fetchedAt || (Date.now() - ta._fetchedAt > TA_CACHE_TTL_MS);
      if (isTaStale) {
        try {
          ta = await getFullTA(sig.symbol);
          if (ta) {
            ta._fetchedAt = Date.now();
            if (!_lastMarketData) _lastMarketData = {};
            if (!_lastMarketData.ta) _lastMarketData.ta = {};
            _lastMarketData.ta[sig.symbol] = ta;
          }
          await new Promise(r => setTimeout(r, 300)); // Giãn cách nhẹ khi nạp TA mới
        } catch (e) {
          log.warn(`[FastScan] Không lấy được TA on-demand cho ${sig.symbol}: ${e.message}`);
        }
      }
      if (!ta) continue;

      const btcTA = _lastMarketData?.ta?.['BTC'] ?? null;
      let score = scoreSetup(
        sig.symbol, sig.signal,
        ta,
        _lastMarketData?.whale ?? {},
        _lastMarketData?.derivatives ?? {},
        _lastMarketData?.funding ?? null,
        _lastMarketData?.fearGreed ?? { value: 50 },
        _lastMarketData?.social ?? {},
        btcTA,
        signals369[sig.symbol] ?? null,
      );
      // Nếu Altcoin tiềm năng (chưa bị Hard Filter loại, điểm sơ bộ >= 4đ) -> nạp On-Demand Whale + Derivatives như bot-h4 rồi chấm lại
      if (!score.disqualified && score.total >= 4 && !isIpBanned()) {
        const fetched = await ensureSymbolOnDemandMacro(sig.symbol);
        if (fetched) {
          score = scoreSetup(
            sig.symbol, sig.signal,
            ta,
            _lastMarketData?.whale ?? {},
            _lastMarketData?.derivatives ?? {},
            _lastMarketData?.funding ?? null,
            _lastMarketData?.fearGreed ?? { value: 50 },
            _lastMarketData?.social ?? {},
            btcTA,
            signals369[sig.symbol] ?? null,
          );
        }
      }
      enriched.push({ ...sig, score });
    }

    // ─── Phase 2: Thực thi định lượng ngay tại chu kỳ quét nhanh (Top 8 sát mốc) ───
    if (!isIpBanned() && enriched.length > 0) {
      try {
        const activeTrades = getActiveTrades();
        const activeMap = Object.fromEntries(activeTrades.map(t => [t.symbol, t.direction]));

        const MIN_SCORE_REVERSAL = parseFloat(process.env.MIN_SCORE_REVERSAL || '9.0');
        const passingScores = enriched
          .filter(s => s.score)
          .map(s => {
            const activeDir = activeMap[s.symbol];
            const isSameDir = activeDir === s.signal;
            const isOppositeDir = Boolean(activeDir && activeDir !== s.signal);
            const failReversalScore = isOppositeDir && (s.score.total < MIN_SCORE_REVERSAL);
            if (s.score.disqualified) {
              _scanWindowStats.rejectHardFilter++;
            } else if (!isSameDir) {
              const reqMin = isOppositeDir ? MIN_SCORE_REVERSAL : (FIXED_COINS.includes(s.symbol) ? 7.0 : 8.0);
              if (s.score.total < reqMin) _scanWindowStats.rejectScore++;
            }
            return {
              symbol: s.symbol,
              direction: s.signal,
              targetLevel: s.targetLevel || s.price,
              total: s.score.total,
              verdict: s.score.verdict,
              confidence: s.score.confidence,
              reasons: s.score.reasons || [],
              disqualified: isSameDir || failReversalScore || s.score.disqualified,
              disqualifyReason: isSameDir
                ? `Đang có lệnh ${activeDir} active`
                : (failReversalScore
                  ? `Đảo chiều ${activeDir}→${s.signal} yêu cầu >= ${MIN_SCORE_REVERSAL}đ (hiện ${s.score.total}đ)`
                  : (s.score.disqualifyReason || ''))
            };
          });

        if (passingScores.length > 0) {
          const quantTrades = await processCandidateSetups(passingScores, { ..._lastMarketData, signals369 }, 2);
          if (quantTrades.length > 0) {
            log.trade(`[FastScan] Khớp ${quantTrades.length} setup định lượng, đẩy vào hệ thống thực thi`);
            dispatchQuantitativeTrades(quantTrades, _lastMarketData?.ta ?? {}, 'FastScan');
          }
        }
      } catch (eScan) {
        log.warn('[FastScan] Lỗi thực thi định lượng nhanh', { error: eScan.message });
      }
    }

    // ─── PP369: Chỉ ghi log nội bộ khi có tín hiệu mới (đã tắt bắn alert Telegram thô) ───
    const newAlerts = detect369Changes(signals369);
    if (newAlerts.length > 0) {
      const alertEnriched = enriched.filter(e => newAlerts.some(a => a.symbol === e.symbol && a.signal === e.signal));
      alertEnriched.forEach(sig => logSignal369(sig));
    }
  } catch (err) {
    log.warn('PP369 fast scan lỗi', { error: err.message });
  } finally {
    _isAlertScanRunning = false;
  }
}

/**
 * Xử lý tuần tự 1 symbol từ hàng đợi tín hiệu (Concurrency = 1, giãn cách 600ms như bot-h4)
 */
async function processSingleSymbolSignal(sym, price) {
  if (isIpBanned()) return;
  if (!sym || !price || _processingSymbols.has(sym)) return;

  _processingSymbols.add(sym);
  _scanWindowStats.wsTicks++;
  _scanWindowStats.coinsChecked++;
  try {
    const activeTrades = getActiveTrades();
    const activeDir = activeTrades.find(t => t.symbol === sym)?.direction;

    const sig = await pp369.get369Signal(sym, price);
    if (!sig || (sig.signal !== 'LONG' && sig.signal !== 'SHORT')) return;
    _scanWindowStats.signals369++;
    if (activeDir && activeDir === sig.signal) return;
    if (isIpBanned()) return;

    const TA_CACHE_TTL_MS = 10 * 60 * 1000;
    let ta = _lastMarketData?.ta?.[sym];
    const isTaStale = !ta || !ta._fetchedAt || (Date.now() - ta._fetchedAt > TA_CACHE_TTL_MS);
    if (isTaStale) {
      try {
        ta = await getFullTA(sym);
        if (ta) {
          ta._fetchedAt = Date.now();
          if (!_lastMarketData) _lastMarketData = {};
          if (!_lastMarketData.ta) _lastMarketData.ta = {};
          _lastMarketData.ta[sym] = ta;
        }
      } catch (_) {}
    }
    if (!ta || isIpBanned()) return;

    const btcTA = _lastMarketData?.ta?.['BTC'] ?? null;
    let score = scoreSetup(
      sym, sig.signal,
      ta,
      _lastMarketData?.whale ?? {},
      _lastMarketData?.derivatives ?? {},
      _lastMarketData?.funding ?? null,
      _lastMarketData?.fearGreed ?? { value: 50 },
      _lastMarketData?.social ?? {},
      btcTA,
      sig
    );
    // Nếu Altcoin tiềm năng (chưa bị Hard Filter loại, điểm sơ bộ >= 4đ) -> nạp On-Demand Whale + Derivatives như bot-h4 rồi chấm lại
    if (!score.disqualified && score.total >= 4 && !isIpBanned()) {
      const fetched = await ensureSymbolOnDemandMacro(sym);
      if (fetched) {
        score = scoreSetup(
          sym, sig.signal,
          ta,
          _lastMarketData?.whale ?? {},
          _lastMarketData?.derivatives ?? {},
          _lastMarketData?.funding ?? null,
          _lastMarketData?.fearGreed ?? { value: 50 },
          _lastMarketData?.social ?? {},
          btcTA,
          sig
        );
      }
    }

    const isReversal = activeDir && activeDir !== sig.signal;
    const minScore = isReversal ? 9.0 : (FIXED_COINS.includes(sym) ? 7.0 : 8.0);
    if (score.disqualified) { _scanWindowStats.rejectHardFilter++; return; }
    if (score.total < minScore) { _scanWindowStats.rejectScore++; return; }

    const candidates = [{
      symbol: sym,
      direction: sig.signal,
      targetLevel: sig.targetLevel || price,
      total: score.total,
      verdict: score.verdict,
      confidence: score.confidence,
      reasons: score.reasons || [],
      disqualified: false
    }];

    const quantTrades = await processCandidateSetups(candidates, { ..._lastMarketData, signals369: { [sym]: sig } }, 1);
    if (quantTrades.length > 0) {
      log.trade(`[WS Tick 0ms] Khớp lệnh định lượng ${sym} ${sig.signal} tại $${sig.targetLevel}`);
      dispatchQuantitativeTrades(quantTrades, _lastMarketData?.ta ?? {}, 'WS Tick 0ms');
    }
  } catch (err) {
    if (!isIpBanned()) {
      log.warn(`[WS Tick 0ms] Lỗi xử lý ${sym}: ${err.message}`);
    }
  } finally {
    _processingSymbols.delete(sym);
  }
}

function processSignalQueue() {
  if (isIpBanned()) {
    _signalCheckQueue.length = 0;
    return;
  }
  if (_activeSignalChecks >= MAX_CONCURRENT_SIGNAL_CHECKS || _signalCheckQueue.length === 0) return;

  const task = _signalCheckQueue.shift();
  if (!task) return;

  _activeSignalChecks++;
  const freshPrice = getMarkPrice(task.sym) || task.price;
  processSingleSymbolSignal(task.sym, freshPrice)
    .catch(() => {})
    .finally(() => {
      _activeSignalChecks--;
      setTimeout(processSignalQueue, 600); // Sleep 600ms giữa các symbol để bảo đảm an toàn API và giãn cách weight Binance
    });
}

function enqueueSymbolSignal(sym, price) {
  if (isIpBanned()) return;
  if (!sym || !price || _processingSymbols.has(sym)) return;
  if (_signalCheckQueue.some(item => item.sym === sym)) return;
  // Giới hạn hàng đợi tối đa 8 mã sát mốc để không tích tụ backlog
  if (_signalCheckQueue.length >= 8) return;

  _signalCheckQueue.push({ sym, price });
  processSignalQueue();
}

/**
 * Luồng 1 (0ms WebSocket): Bắt tick giá real-time từ stream khi coin tiến sát mốc <= 0.3%
 * Đưa vào hàng đợi tuần tự (Concurrency = 1, giãn cách 600ms) đồng bộ 100% với bot-h4 src/trader/autoTrade.js
 */
function initPriceTickListener() {
  if (typeof pp369.onPriceUpdate !== 'function') return;

  pp369.onPriceUpdate((sym, price) => {
    if (isIpBanned() || _scanPaused) return;
    if (!sym || !price || _processingSymbols.has(sym)) return;

    const now = Date.now();
    if ((_symbolSignalCooldown[sym] || 0) + 15000 > now) return; // 15s debounce per symbol

    const levelCache = getLevelCache();
    const levels = levelCache ? levelCache[sym] : null;
    if (!levels?.longEntry || !levels?.shortEntry) return;

    const nearTol = price * 0.003; // 0.3% tiệm cận mốc
    const nearLong = Math.abs(price - levels.longEntry) <= nearTol;
    const nearShort = Math.abs(levels.shortEntry - price) <= nearTol;
    if (!nearLong && !nearShort) return;

    const activeTrades = getActiveTrades();
    const activeDir = activeTrades.find(t => t.symbol === sym)?.direction;
    if (activeDir) {
      const isOppositeNear = (activeDir === 'LONG' && nearShort) || (activeDir === 'SHORT' && nearLong);
      if (!isOppositeNear) return; // Đang giữ cùng chiều hoặc chưa chạm mốc đảo chiều
    }

    _symbolSignalCooldown[sym] = now;
    enqueueSymbolSignal(sym, price);
  });
}

/**
 * Cập nhật siêu nhẹ dữ liệu vĩ mô nền (15 phút/lần) — Đồng bộ kiến trúc On-Demand của bot-h4.
 * Chỉ nạp BTC TA + Funding + Fear&Greed + BTC/ETH Whale/Derivatives (~5-10 weight thay vì 800+ weight của cron 5p cũ).
 * Việc săn kèo & đặt lệnh chạy 100% qua Luồng 1 (WS 0ms) + Luồng 2 (FastScan 30s).
 */
let _isMacroRefreshRunning = false;
async function runMacroRefresh() {
  if (_isMacroRefreshRunning || _isRunning || isIpBanned()) return;
  _isMacroRefreshRunning = true;
  try {
    const [fgRes, fundRes, btcTaRes, whaleRes, derivRes] = await Promise.allSettled([
      getFearGreedIndex(),
      getFundingRates(),
      getFullTA('BTC'),
      getWhaleData(['BTC', 'ETH'], 1),
      getDerivatives(['BTC', 'ETH'], 1),
    ]);

    if (!_lastMarketData) _lastMarketData = {};
    if (!_lastMarketData.ta) _lastMarketData.ta = {};

    const btcTa = resolveSettled(btcTaRes, null);
    if (btcTa) {
      btcTa._fetchedAt = Date.now();
      _lastMarketData.ta['BTC'] = btcTa;
    }
    const fg = resolveSettled(fgRes, null);
    if (fg) _lastMarketData.fearGreed = fg;
    const funding = resolveSettled(fundRes, null);
    if (funding) _lastMarketData.funding = funding;
    // Merge BTC/ETH vào cache thay vì ghi đè xóa sạch dữ liệu whale/derivatives của các altcoin khác
    const whale = resolveSettled(whaleRes, null);
    if (whale) {
      _lastMarketData.whale = mergeWhaleCache(_lastMarketData.whale, whale);
    }
    const deriv = resolveSettled(derivRes, null);
    if (deriv) {
      _lastMarketData.derivatives = { ...(_lastMarketData.derivatives || {}), ...deriv };
    }
    pruneRuntimeMemoryCaches();
  } catch (err) {
    log.warn(`[MacroRefresh] Lỗi cập nhật vĩ mô nền: ${err.message}`);
  } finally {
    _isMacroRefreshRunning = false;
  }
}

/**
 * Dọn rác các RAM cache của bot-new (giữ tối đa 80 coin nóng, luôn bảo toàn BTC/ETH, lệnh đang mở & Shadow)
 * Chặn tình trạng phình bộ nhớ kéo dài trên VPS 768MB.
 */
function pruneRuntimeMemoryCaches() {
  const now = Date.now();
  const protectedSyms = new Set(['BTC', 'ETH']);
  try {
    for (const t of getActiveTrades()) {
      if (t?.symbol) protectedSyms.add(t.symbol);
    }
    const shadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
    for (const sh of Object.values(shadows || {})) {
      if (sh?.symbol) protectedSyms.add(sh.symbol);
    }
  } catch (_) {}

  // 1. Cắt tỉa _lastMarketData.ta (xóa entry quá 15p và giới hạn tối đa 80 coin)
  if (_lastMarketData?.ta && typeof _lastMarketData.ta === 'object') {
    const entries = Object.entries(_lastMarketData.ta);
    for (const [sym, ta] of entries) {
      if (protectedSyms.has(sym)) continue;
      if (!ta?._fetchedAt || (now - ta._fetchedAt > 15 * 60 * 1000)) {
        delete _lastMarketData.ta[sym];
      }
    }
    const remaining = Object.entries(_lastMarketData.ta).filter(([s]) => !protectedSyms.has(s));
    if (remaining.length > 80) {
      remaining.sort((a, b) => (a[1]?._fetchedAt || 0) - (b[1]?._fetchedAt || 0));
      for (const [sym] of remaining.slice(0, remaining.length - 80)) {
        delete _lastMarketData.ta[sym];
      }
    }
  }

  // 2. Cắt trần _lastMarketData.derivatives & whale sub-maps (tối đa 100 coin)
  const trimObj = (obj, maxKeys = 100) => {
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj).filter(k => !protectedSyms.has(k));
    if (keys.length <= maxKeys) return;
    for (const k of keys.slice(0, keys.length - maxKeys)) {
      delete obj[k];
    }
  };
  if (_lastMarketData?.derivatives) trimObj(_lastMarketData.derivatives, 100);
  if (_lastMarketData?.whale) {
    trimObj(_lastMarketData.whale.takerFlow, 100);
    trimObj(_lastMarketData.whale.binanceLarge, 100);
    trimObj(_lastMarketData.whale.crossSignals, 100);
    trimObj(_lastMarketData.whale.liquidations, 100);
  }

  // 3. Dọn các map cooldown / polling tạm đã hết hạn
  for (const [sym, rec] of _recentPollingScan.entries()) {
    if (!rec?.ts || (now - rec.ts > POLL_ROTATION_TTL_MS * 2)) _recentPollingScan.delete(sym);
  }
  for (const [sym, ts] of _onDemandMacroFetchedAt.entries()) {
    if (now - ts > ONDEMAND_MACRO_TTL_MS * 2) _onDemandMacroFetchedAt.delete(sym);
  }
  for (const sym of Object.keys(_symbolSignalCooldown)) {
    if (now - (_symbolSignalCooldown[sym] || 0) > 5 * 60 * 1000) {
      delete _symbolSignalCooldown[sym];
    }
  }
}

const _jobPruneTimer = setInterval(pruneRuntimeMemoryCaches, 10 * 60 * 1000);
if (typeof _jobPruneTimer.unref === 'function') _jobPruneTimer.unref();

// ─── LUỒNG TÁI ĐÁNH GIÁ SHADOW MỖI 30 PHÚT (PHƯƠNG ÁN B - ĐỒNG BỘ BOT-H4) ─────
const SHADOW_REEVAL_MIN_AGE_MS = parseInt(process.env.SHADOW_REEVAL_MIN_AGE_MS || String(15 * 60_000), 10); // Tối thiểu sống sót 15 phút
const SHADOW_REEVAL_MAX_AGE_MS = parseInt(process.env.SHADOW_REEVAL_MAX_AGE_MS || '0', 10); // 0 = không giới hạn tuổi tối đa
const SHADOW_REEVAL_MAX_TP_PROGRESS = parseFloat(process.env.SHADOW_REEVAL_MAX_TP_PROGRESS || '0.30');
const SHADOW_REEVAL_MAX_SL_ADVERSE = parseFloat(process.env.SHADOW_REEVAL_MAX_SL_ADVERSE || '0.40');
const SHADOW_REEVAL_MAX_HIST_TP_MFE = parseFloat(process.env.SHADOW_REEVAL_MAX_HIST_TP_MFE || '0.35');
const SHADOW_REEVAL_MAX_HIST_SL_MAE = parseFloat(process.env.SHADOW_REEVAL_MAX_HIST_SL_MAE || '0.65');
const SHADOW_REEVAL_MAX_PROMOTES_PER_CYCLE = parseInt(process.env.SHADOW_REEVAL_MAX_PROMOTES_PER_CYCLE || '2', 10);
const SHADOW_REEVAL_HARD_VETO_RE = /RR_BLOCKED_BY_MAJOR_SR|GRID_|SL_TOO_WIDE|HARD_FILTER|DIRECTIONAL_CB|SL_COOLDOWN|SHADOW_ONLY_MODE|UNTRADABLE/i;

/**
 * Bộ lọc tiền kiểm thuần toán học (pure function) cho luồng Shadow Re-Evaluation 30 phút.
 * Kiểm tra: ACTIVE/PENDING_LIMIT, chưa BE, tuổi 30p-8h, loại trừ hard/structural veto,
 * chưa chạy quá 30% TP (chống đuổi giá) và chưa lỗ quá 40% SL (chống bắt dao rơi).
 * Trả về mức giá limitEntry bảo toàn Maker-only.
 */
function isShadowEligibleForReeval(sh, markPrice, nowMs = Date.now()) {
  if (!sh || typeof sh !== 'object') return { eligible: false, reason: 'INVALID_SHADOW' };
  const status = String(sh.status || '').toUpperCase();
  if (status !== 'ACTIVE' && status !== 'PENDING_LIMIT') {
    return { eligible: false, reason: `STATUS_${status || 'UNKNOWN'}` };
  }
  if (sh.isBeTriggered) {
    return { eligible: false, reason: 'ALREADY_BREAKEVEN' };
  }

  const sym = String(sh.symbol || '').toUpperCase().replace(/USDT$/i, '');
  const rawDir = String(sh.direction || sh.signal || '').toUpperCase();
  const direction = (rawDir === 'LONG' || rawDir === 'BUY') ? 'LONG' : ((rawDir === 'SHORT' || rawDir === 'SELL') ? 'SHORT' : '');
  const origEntry = parseFloat(sh.entryPrice || 0);
  const tpPrice = parseFloat(sh.tpPrice || sh.tierTpPrice || 0);
  const slPrice = parseFloat(sh.originalSlPrice || sh.slPrice || sh.tierSlPrice || 0);
  const currPrice = parseFloat(markPrice || 0);

  if (!sym || !direction || origEntry <= 0 || tpPrice <= 0 || slPrice <= 0 || currPrice <= 0) {
    return { eligible: false, reason: 'MISSING_PRICE_FIELDS' };
  }

  const openedMs = Number(sh.openedAtMs || sh.entryTimestamp || (sh.openedAt ? Date.parse(sh.openedAt) : 0));
  if (!Number.isFinite(openedMs) || openedMs <= 0) {
    return { eligible: false, reason: 'MISSING_TIMESTAMP' };
  }
  const ageMs = nowMs - openedMs;
  if (ageMs < SHADOW_REEVAL_MIN_AGE_MS) {
    return { eligible: false, reason: 'TOO_YOUNG', ageMinutes: Math.round(ageMs / 60_000) };
  }
  if (SHADOW_REEVAL_MAX_AGE_MS > 0 && ageMs > SHADOW_REEVAL_MAX_AGE_MS) {
    return { eligible: false, reason: 'TOO_OLD', ageMinutes: Math.round(ageMs / 60_000) };
  }

  const vetoCombined = `${sh.vetoCategory || ''} ${sh.vetoReason || ''}`;
  if (SHADOW_REEVAL_HARD_VETO_RE.test(vetoCombined)) {
    return { eligible: false, reason: 'HARD_VETO_EXCLUDED' };
  }

  const isLong = direction === 'LONG';
  const tpDist = isLong ? (tpPrice - origEntry) : (origEntry - tpPrice);
  const slDist = isLong ? (origEntry - slPrice) : (slPrice - origEntry);
  if (tpDist <= 0 || slDist <= 0) {
    return { eligible: false, reason: 'INVALID_TP_SL_GEOMETRY' };
  }

  const progressToTp = isLong ? ((currPrice - origEntry) / tpDist) : ((origEntry - currPrice) / tpDist);
  const adverseToSl = isLong ? ((origEntry - currPrice) / slDist) : ((currPrice - origEntry) / slDist);

  if (progressToTp > SHADOW_REEVAL_MAX_TP_PROGRESS) {
    return { eligible: false, reason: 'CHASE_GUARD_TP_PROGRESS', progressToTpPct: +(progressToTp * 100).toFixed(1) };
  }
  if (adverseToSl > SHADOW_REEVAL_MAX_SL_ADVERSE) {
    return { eligible: false, reason: 'DYING_GUARD_SL_ADVERSE', adverseToSlPct: +(adverseToSl * 100).toFixed(1) };
  }

  // Mức 1 — Kiểm tra biên độ lịch sử (MFE / MAE) đã từng đi qua của Shadow:
  // 1) Từng bật quá 35% TP rồi quay về -> Stale Bounce (mốc đã xài hết lực bật)
  // 2) Từng đâm sâu quá 65% SL rồi hồi lên -> Broken Structure (cấu trúc cản đã bị đục hỏng)
  // 3) Quét râu 40%-65% SL rồi rút chân về <= 40% SL -> Cho đi tiếp để Confluence + AI thẩm định
  const maxFav = parseFloat(sh.maxFavorablePrice || 0);
  let histMaxTpProgress = 0;
  if (maxFav > 0) {
    histMaxTpProgress = isLong ? ((maxFav - origEntry) / tpDist) : ((origEntry - maxFav) / tpDist);
    if (histMaxTpProgress > SHADOW_REEVAL_MAX_HIST_TP_MFE) {
      return { eligible: false, reason: 'STALE_BOUNCE_MFE_GUARD', histMaxTpPct: +(histMaxTpProgress * 100).toFixed(1) };
    }
  }
  const maxAdv = parseFloat(sh.maxAdversePrice || 0);
  let histMaxSlAdverse = 0;
  if (maxAdv > 0) {
    histMaxSlAdverse = isLong ? ((origEntry - maxAdv) / slDist) : ((maxAdv - origEntry) / slDist);
    if (histMaxSlAdverse > SHADOW_REEVAL_MAX_HIST_SL_MAE) {
      return { eligible: false, reason: 'BROKEN_STRUCTURE_MAE_GUARD', histMaxSlPct: +(histMaxSlAdverse * 100).toFixed(1) };
    }
  }

  // Maker-only: LONG luôn <= min(origEntry, mark * 0.9995); SHORT luôn >= max(origEntry, mark * 1.0005)
  const limitEntry = isLong
    ? Math.min(origEntry, currPrice * 0.9995)
    : Math.max(origEntry, currPrice * 1.0005);

  return {
    eligible: true,
    symbol: sym,
    direction,
    origEntry,
    limitEntry,
    ageMinutes: Math.round(ageMs / 60_000),
    progressToTpPct: +(progressToTp * 100).toFixed(1),
    adverseToSlPct: +(adverseToSl * 100).toFixed(1),
    histMaxTpPct: +(Math.max(0, histMaxTpProgress) * 100).toFixed(1),
    histMaxSlPct: +(Math.max(0, histMaxSlAdverse) * 100).toFixed(1),
  };
}

let _isShadowReevalRunning = false;

/**
 * Luồng tái chấm điểm Shadow từ đầu mỗi 30 phút (Phương án B).
 * Chấm lại Confluence + On-Demand Macro + Tier SL/TP + Risk Gatekeeper từ 0.
 * Nếu vượt qua tất cả các tầng → đặt lệnh Maker LIMIT thật trên Binance (tối đa 2 lệnh/chu kỳ).
 */
async function runShadowReevaluation() {
  if (process.env.ENABLE_SHADOW_REEVAL === 'false') return { checked: 0, promoted: 0 };
  if (_isShadowReevalRunning || isIpBanned() || _scanPaused || _shadowOnlyMode) return { checked: 0, promoted: 0 };
  if (!binanceTrader || !binanceTrader.isEnabled()) return { checked: 0, promoted: 0 };

  _isShadowReevalRunning = true;
  let checked = 0;
  let promoted = 0;
  const skipCounts = {};
  const bumpSkip = (reason) => { skipCounts[reason] = (skipCounts[reason] || 0) + 1; };
  try {
    const activeShadows = typeof getActiveShadowPositions === 'function' ? getActiveShadowPositions() : {};
    const entries = Object.entries(activeShadows || {});
    if (entries.length === 0) {
      log.system('[ShadowReEval] ⏱️ Chu kỳ 30p: 0 vị thế Shadow đang theo dõi → Bỏ qua.');
      return { checked: 0, promoted: 0 };
    }

    // Làm mới giá REST nhẹ để có markPrice cho mọi shadow coin
    if (typeof updatePricesRest === 'function' && !isIpBanned()) {
      await updatePricesRest().catch(() => {});
    }

    const nowMs = Date.now();
    // Ưu tiên shadow sống lâu hơn trong cửa sổ 30p-8h
    entries.sort((a, b) => (a[1]?.openedAtMs || a[1]?.entryTimestamp || 0) - (b[1]?.openedAtMs || b[1]?.entryTimestamp || 0));

    const activeTrades = getActiveTrades();
    const activeSymSet = new Set(activeTrades.filter(t => t && t.status === 'active').map(t => t.symbol));

    // Kiểm tra 1 lần danh sách vị thế thật đang mở trên Binance
    const livePositionSyms = new Set();
    try {
      const livePos = await binanceTrader.getAllPositions();
      if (Array.isArray(livePos)) {
        for (const p of livePos) {
          if (parseFloat(p.positionAmt || '0') !== 0) {
            livePositionSyms.add(String(p.symbol || '').replace(/USDT$/i, '').toUpperCase());
          }
        }
      }
    } catch (_) {}

    // Đảm bảo có BTC TA tươi mới cho Confluence Scorer
    if (!_lastMarketData) _lastMarketData = {};
    if (!_lastMarketData.ta) _lastMarketData.ta = {};
    let btcTA = _lastMarketData.ta['BTC'] ?? null;
    if (!btcTA || !btcTA._fetchedAt || (nowMs - btcTA._fetchedAt > 15 * 60_000)) {
      try {
        btcTA = await getFullTA('BTC');
        if (btcTA) {
          btcTA._fetchedAt = Date.now();
          _lastMarketData.ta['BTC'] = btcTA;
        }
      } catch (_) {}
    }

    const pricesMap = typeof getPrices === 'function' ? (getPrices() || {}) : {};
    const levelCache = getLevelCache() || {};

    for (const [shadowId, sh] of entries) {
      if (isIpBanned() || promoted >= SHADOW_REEVAL_MAX_PROMOTES_PER_CYCLE) break;
      if (!sh || !sh.symbol) continue;

      const sym = String(sh.symbol).toUpperCase().replace(/USDT$/i, '');
      const rawDir = String(sh.direction || sh.signal || '').toUpperCase();
      const direction = (rawDir === 'SHORT' || rawDir === 'SELL') ? 'SHORT' : 'LONG';

      if (
        activeSymSet.has(sym) ||
        livePositionSyms.has(sym) ||
        _processingSymbols.has(sym) ||
        isSymbolInCooldown(sym) ||
        isDirectionLocked(direction).isLocked ||
        isLevelBounceCooldown(sym, parseFloat(sh.entryPrice || 0))
      ) {
        bumpSkip('ACTIVE_OR_LOCKED');
        continue;
      }

      const markPrice = (typeof getMarkPrice === 'function' ? getMarkPrice(sym) : null) || pricesMap[sym] || null;
      const elig = isShadowEligibleForReeval(sh, markPrice, nowMs);
      if (!elig.eligible) {
        bumpSkip(elig.reason || 'INELIGIBLE');
        continue;
      }

      checked++;
      try {
        // 1. Nạp TA tươi mới cho coin
        let ta = _lastMarketData.ta[sym];
        const isTaStale = !ta || !ta._fetchedAt || (Date.now() - ta._fetchedAt > 10 * 60_000);
        if (isTaStale) {
          ta = await getFullTA(sym);
          if (ta) {
            ta._fetchedAt = Date.now();
            _lastMarketData.ta[sym] = ta;
          }
        }
        if (!ta) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // 2. Nạp On-Demand Whale + Derivatives nếu chưa có cache tươi
        await ensureSymbolOnDemandMacro(sym);

        const cachedLvl = levelCache[sym] || null;
        const sig369Stub = {
          symbol: sym,
          signal: direction,
          targetLevel: elig.limitEntry,
          currentPrice: markPrice,
          step: cachedLvl?.step || null,
          decimals: cachedLvl?.decimals || null,
        };

        // 3. Chấm lại Confluence Score từ 0
        const score = scoreSetup(
          sym,
          direction,
          ta,
          _lastMarketData.whale ?? {},
          _lastMarketData.derivatives ?? {},
          _lastMarketData.funding ?? null,
          _lastMarketData.fearGreed ?? { value: 50 },
          _lastMarketData.social ?? {},
          btcTA,
          sig369Stub
        );

        const isTier1 = FIXED_COINS.includes(sym);
        const minRequired = isTier1 ? MIN_SCORE_TIER1 : MIN_SCORE_TIER2;
        if (!score || score.disqualified || typeof score.total !== 'number' || score.total < minRequired) {
          log.system(`[ShadowReEval] ⏭️ ${sym} (${direction}, ${elig.ageMinutes}p): Không đạt Confluence (${score?.total?.toFixed?.(1) ?? 0}đ < ${minRequired}đ${score?.disqualifyReason ? ` | ${score.disqualifyReason}` : ''})`);
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // 4. Qua đầy đủ tầng Tier SL/TP + L2 Microstructure + AI Risk Gatekeeper với Maker-only limitEntry
        const candidate = {
          symbol: sym,
          direction,
          targetLevel: elig.limitEntry,
          total: score.total,
          verdict: score.verdict,
          confidence: score.confidence,
          reasons: score.reasons || [],
          gridWidthPct: sh.gridWidthPct || null,
          marketCapRank: sh.marketCapRank || null,
        };

        const marketCtx = {
          ..._lastMarketData,
          signals369: { ...(_lastMarketData.signals369 || {}), [sym]: sig369Stub },
        };

        const trade = await generateQuantitativeTrade(candidate, marketCtx, {
          isReeval: true,
          overrideEntryPrice: elig.limitEntry,
        });
        if (!trade) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // 5. Kiểm tra lần cuối không có lệnh chờ mở trên sàn
        const openOrders = await binanceTrader.getOpenOrders(sym).catch(() => []);
        if (Array.isArray(openOrders) && openOrders.length > 0) {
          activeSymSet.add(sym);
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        // 6. Đặt lệnh Maker LIMIT thật trên Binance và CHỜ xác nhận orderId
        const placed = await binanceTrader.placeNewTrade(trade);
        if (
          !placed ||
          placed.insufficientBalance ||
          placed.symbolNotSupported ||
          placed.agreementRequired ||
          !placed.entryOrderId
        ) {
          log.warn(`[ShadowReEval] Đặt lệnh LIMIT thất bại cho ${sym} (${direction}) — giữ nguyên trong Shadow`, {
            insufficientBalance: Boolean(placed?.insufficientBalance),
            symbolNotSupported: Boolean(placed?.symbolNotSupported),
            agreementRequired: Boolean(placed?.agreementRequired),
          });
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        trade.binanceEntryOrderId = String(placed.entryOrderId);
        trade.binanceQty = placed.qty;
        if (typeof placed.sizeUsdt === 'number' && placed.sizeUsdt > 0) {
          trade.margin = parseFloat(placed.sizeUsdt.toFixed(2));
        }

        // 7. Đăng ký vào TradeMonitor (silentTelegram để không gửi đúp với tin Re-Eval bên dưới) và gỡ Shadow cũ
        registerPromotedTrade(trade, { silentTelegram: true });
        removeShadowPosition(shadowId);
        removeShadowBySymbolDirection(sym, direction);

        promoted++;
        activeSymSet.add(sym);
        livePositionSyms.add(sym);

        log.trade(`[ShadowReEval] ♻️✓ ĐÃ ĐẨY LỆNH MAKER LIMIT #${sym} (${direction}) @ $${trade.entryPrice} (orderId=${trade.binanceEntryOrderId} | Tuổi Shadow: ${elig.ageMinutes}p | Score mới: ${score.total.toFixed(1)}đ | AI WinProb: ${trade.winProbability}% | x${trade.leverage} | Margin $${trade.margin})`);

        await sendMessages([
          `♻️ <b>[Shadow Re-Eval 30m] Đẩy lệnh MAKER LIMIT</b>\n` +
          `• Coin: <b>#${sym}USDT (${direction})</b>\n` +
          `• Entry Limit: <b>$${trade.entryPrice}</b> (Shadow gốc: $${elig.origEntry}, giá HT: $${markPrice})\n` +
          `• SL: <b>$${trade.slPrice}</b> (-${trade.slPct}%) | TP: <b>$${trade.targetPrice}</b> (+${trade.targetPct}%)\n` +
          `• Đòn bẩy: <b>${trade.leverage}x</b> | Ký quỹ: <b>$${trade.margin}</b>\n` +
          `• Chấm lại: Score <b>${score.total.toFixed(1)}đ</b> | AI <b>${trade.winProbability}%</b> | Sống sót <b>${elig.ageMinutes}p</b>`
        ]).catch(() => {});
      } catch (err) {
        log.warn(`[ShadowReEval] Lỗi tái đánh giá ${sym} (${direction}): ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 600));
    }

    const skipParts = Object.entries(skipCounts).map(([k, v]) => `${k}:${v}`).join(', ');
    const skipSummary = skipParts ? ` | Lọc tiền kiểm (${skipParts})` : '';
    log.system(`[ShadowReEval] ⏱️ Hoàn tất chu kỳ 30p: Tổng ${entries.length} Shadow | Đủ tiền kiểm: ${checked}${skipSummary} → Đẩy lệnh thật ${promoted}/${SHADOW_REEVAL_MAX_PROMOTES_PER_CYCLE}.`);
    return { checked, promoted };
  } finally {
    _isShadowReevalRunning = false;
  }
}

module.exports = {
  runJob,
  isJobRunning,
  run369AlertScan,
  runMacroRefresh,
  runShadowReevaluation,
  isShadowEligibleForReeval,
  initPriceTickListener,
  setScanPaused,
  isScanPaused,
  setShadowOnlyMode,
  isShadowOnlyMode,
  FIXED_COINS,
  getUniverseSymbols,
  setUniverseSymbols
};
