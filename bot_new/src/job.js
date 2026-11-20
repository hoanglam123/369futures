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
const { analyzeMarket, analyze369Setup } = require('./services/aiAnalysis');
const { sendMessages, sendErrorAlert } = require('./services/telegram');
const { buildMarketMessage, buildAnalysisMessage } = require('./formatters/message');
const { parseTrades, addTrades, getActiveTrades } = require('./services/tradeMonitor');
const { processCandidateSetups } = require('./services/signalEngine');
const { getAllActiveFuturesSymbols, filterSymbolsByGrid } = require('./services/dynamicUniverse');
const { parseFundingTrades, addFundingTrades } = require('./services/fundingTracker');
const { getTAReport, STABLECOINS } = require('./collectors/technicalAnalysis');
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
} = pp369;

let _isRunning = false;        // full market report đang chạy
let _isSilentRunning = false;  // signal scan (silent) đang chạy
const _prev369State = {};      // { [symbol]: key } tránh gửi alert PP369 trùng lặp
let _lastTaSymbols  = null;    // coin list cache từ lần runJob() gần nhất, dùng cho scan 1p
let _lastMarketData = null;    // market data cache (TA/whale/deriv) cho confluence re-score trong scan 1p

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
// AI_ANALYSIS_ENABLED: bật/tắt phân tích thị trường bằng AI (mặc định: true)
const AI_ANALYSIS_ENABLED = process.env.AI_ANALYSIS_ENABLED !== 'false';
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
  log.system(silent ? '=== BẮT ĐẦU SIGNAL SCAN ===' : '=== BẮT ĐẦU CHẠY JOB ===');

  try {
    // ─── BƯỚC 1: Thu thập dữ liệu song song ─────────────
    log.system('Thu thập dữ liệu từ các nguồn...');

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

    log.system(`Thu thập OK: ${dataCount || 'không có dữ liệu'}`);

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

    // TA + Whale: FIXED → TIER2 → LIQUID → GAINERS, dedup, tối đa MAX_TA_COINS
    const taSymbols    = [...new Set([...FIXED_COINS, ...tier2Active, ...topLiquidExtra, ...gainersFiltered])].slice(0, MAX_TA_COINS);
    const whaleSymbols = [...taSymbols];
    _lastTaSymbols = [...taSymbols];  // cache cho scan PP369 1 phút
    start369Stream(taSymbols);        // cập nhật WebSocket stream nếu coin list thay đổi

    // Lưu danh sách coin đang theo dõi ra file để dashboard đọc
    try {
      const dataDir = require('path').join(__dirname, '..', 'data');
      require('fs').writeFileSync(
        require('path').join(dataDir, 'pp369_symbols.json'),
        JSON.stringify({
          symbols:  taSymbols,
          fixed:    FIXED_COINS,
          tier2:    tier2Active,
          liquid:   topLiquidExtra,
          gainers:  gainersFiltered,
          updatedAt: new Date().toISOString(),
          source:   'job',
        }),
        'utf8'
      );
    } catch {}


    log.system(`Fixed: [${FIXED_COINS.join(',')}] | Tier2 (≥${MIN_SCORE_TRADE}đ): [${tier2Active.join(',')}]`);
    log.system(`Extra liquid (≥${MIN_SCORE_EXTRA}đ): [${topLiquidExtra.join(',')}] | Gainers (≥${MIN_SCORE_EXTRA}đ): [${gainersFiltered.join(',')}]`);
    log.system(`TA + Whale: ${taSymbols.length} coins → [${taSymbols.join(', ')}]`);

    const [taResult, whaleResult, derivResult, onchainResult, socialResult, signals369Result] = await Promise.allSettled([
      getTAReport(taSymbols),
      getWhaleData(whaleSymbols, cronHours),
      getDerivatives(whaleSymbols, cronHours),
      getBTCOnchain(),
      getRedditSentiment(),
      get369SignalsForCoins(taSymbols),
    ]);

    logSourceStatus('Technical Analysis', taResult);
    marketData.ta = resolveSettled(taResult, {});
    log.system(`TA hoàn thành: ${Object.keys(marketData.ta).join(', ') || 'không có'}`);

    logSourceStatus('Whale Data (Binance+OKX)', whaleResult);
    marketData.whale = resolveSettled(whaleResult, null);
    if (marketData.whale) {
      const flowKeys = Object.keys(marketData.whale.takerFlow    || {});
      const bnKeys   = Object.keys(marketData.whale.binanceLarge || {});
      log.system(`Whale: Flow [${flowKeys.join(',')||'—'}] | BN [${bnKeys.join(',')||'—'}]`);
    }

    logSourceStatus('Derivatives (Binance OI/L/S)', derivResult);
    marketData.derivatives = resolveSettled(derivResult, null);
    if (marketData.derivatives) {
      log.system(`Derivatives: ${Object.keys(marketData.derivatives).join(', ') || '—'}`);
    }

    logSourceStatus('BTC On-chain (mempool.space)', onchainResult);
    marketData.onchain = resolveSettled(onchainResult, null);

    logSourceStatus('Reddit Sentiment', socialResult);
    marketData.social = resolveSettled(socialResult, null);
    if (marketData.social) {
      const s = marketData.social;
      log.system(`Reddit: ${s.sentiment} (${s.bullishPct}% bull / ${s.bearishPct}% bear, ${s.totalPosts} posts)`);
    }

    logSourceStatus('PP369 (mốc phản ứng tháng)', signals369Result);
    marketData.signals369 = resolveSettled(signals369Result, {});
    const sig369Active = Object.values(marketData.signals369).filter(s => s.signal !== 'NONE');
    if (sig369Active.length > 0) {
      log.system(`PP369: ${sig369Active.map(s => `${s.symbol}=${s.signal}(${s.strength})`).join(' | ')}`);
    } else {
      log.system('PP369: Không có tín hiệu 369 hiện tại');
    }

    // Cache cho PP369 scan 1 phút (confluence re-score + AI comment)
    _lastMarketData = {
      ta:          marketData.ta,
      whale:       marketData.whale,
      derivatives: marketData.derivatives,
      funding:     marketData.funding,
      fearGreed:   marketData.fearGreed,
      social:      marketData.social,
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
    allScores.slice(0, 4).forEach(s => {
      if (s.disqualified) log.system(`  ${s.symbol} ${s.direction}: LOẠI (${s.disqualifyReason})`);
      else log.system(`  ${s.symbol} ${s.direction}: ${s.total}đ [${s.verdict}]`);
    });

    // ─── PP369: Alert độc lập khi có tín hiệu mới (cả silent lẫn normal mode) ──
    const new369Alerts = detect369Changes(marketData.signals369);
    if (new369Alerts.length > 0) {
      new369Alerts.forEach(sig => logSignal369(sig));
      log.system(`PP369: ${new369Alerts.length} tín hiệu mới → gửi alert Telegram`);
      try {
        await sendMessages([format369Alert(new369Alerts)], 1500, NEWS_CHAT_ID);
        log.telegram('PP369 alert đã gửi');
      } catch (alertErr) {
        log.error('Không thể gửi PP369 alert', { error: alertErr.message });
      }
    }

    // ─── BƯỚC 2: THỰC THI GIAO DỊCH ĐỊNH LƯỢNG 100% (PHASE 2 UPGRADE) ───
    log.system('Đang quét và tính toán lệnh định lượng (Tier 1 >= 7.0đ, Tier 2 >= 8.0đ)...');
    try {
      const quantTrades = await processCandidateSetups(allScores, marketData, 2);
      if (quantTrades.length > 0) {
        log.trade(`[SignalEngine] ${quantTrades.length} lệnh định lượng đủ điều kiện, bắt đầu theo dõi & đặt lệnh sàn`);
        addTrades(quantTrades, marketData.ta ?? {});
      } else {
        log.system('[SignalEngine] Không có setup định lượng nào vượt qua bộ lọc & Gatekeeper');
      }
    } catch (engineErr) {
      log.error('[SignalEngine] Lỗi thực thi signalEngine:', { error: engineErr.message });
    }

    // ─── BƯỚC 2.5: Phân tích AI chỉ chạy khi gửi bản tin sáng (!silent) ───
    let analysisText = null;
    let aiModel = null;

    if (!silent && AI_ANALYSIS_ENABLED) {
      log.ai('Gọi Gemini AI viết nhận định bản tin sáng (narrative)...');
      const recentHistoryText = getRecentHistoryText(5);
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
    } else if (silent) {
      log.system('Silent mode: hoàn thành chu kỳ quét định lượng (0 Token, 0ms AI call)');
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
    } else {
      log.system('Silent mode: bỏ qua gửi bản tin thị trường');
    }

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
    log.system(`=== ${silent ? 'SIGNAL SCAN' : 'JOB'} HOÀN THÀNH (${elapsed}s) ===`);

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
  if (result.status === 'fulfilled') {
    log.system(`[OK] ${name}`);
  } else {
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

/**
 * Scan PP369 nhẹ — chỉ fetch tín hiệu 369, không fetch CoinGecko.
 * Bước 1: chấm điểm confluence từ _lastMarketData (không gọi API thêm).
 * Bước 2: gọi Gemini AI comment nếu score >= MIN_SCORE_SIGNAL.
 * Gọi mỗi 1 phút để alert kịp thời hơn so với signal scan 5p.
 */
async function run369AlertScan() {
  const symbols = _lastTaSymbols ?? FIXED_COINS;
  try {
    // Proximity filter: chỉ scan coin đang trong vùng ≤PROXIMITY_PCT% của mốc
    // Coin xa mốc → bỏ qua, tiết kiệm API call. Fail-open nếu chưa có WebSocket data.
    const toScan  = getNearbySymbols(symbols, getLevelCache(), PROXIMITY_PCT);
    // Dùng WebSocket mark price từ Binance (~3s) thay vì nến 1m cuối (~1 phút trễ)
    const priceMap = Object.fromEntries(
      toScan.map(s => [s, { price: getMarkPrice(s) }]).filter(([, v]) => v.price != null)
    );
    const signals369 = await get369SignalsForCoins(toScan, priceMap);
    const newAlerts  = detect369Changes(signals369);
    if (newAlerts.length === 0) return;

    // Bước 1: Confluence score từ cached market data (không gọi API thêm)
    const enriched = newAlerts.map(sig => {
      if (!_lastMarketData?.ta?.[sig.symbol]) return sig;
      const btcTA = _lastMarketData.ta['BTC'] ?? null;
      const score = scoreSetup(
        sig.symbol, sig.signal,
        _lastMarketData.ta[sig.symbol],
        _lastMarketData.whale,
        _lastMarketData.derivatives,
        _lastMarketData.funding,
        _lastMarketData.fearGreed,
        _lastMarketData.social,
        btcTA,
        signals369[sig.symbol] ?? null,
      );
      return { ...sig, score };
    });

    // ─── Phase 2: Thực thi định lượng ngay tại chu kỳ 1 phút nếu có setup đủ điểm ───
    try {
      const passingScores = enriched
        .filter(s => s.score && !s.score.disqualified)
        .map(s => ({
          symbol: s.symbol,
          direction: s.signal,
          targetLevel: s.targetLevel || s.price,
          total: s.score.total,
          verdict: s.score.verdict,
          confidence: s.score.confidence,
          reasons: s.score.reasons || [],
          disqualified: false
        }));

      if (passingScores.length > 0) {
        const quantTrades1m = await processCandidateSetups(passingScores, _lastMarketData, 1);
        if (quantTrades1m.length > 0) {
          log.trade(`[PP369 1m Scan] Khớp ${quantTrades1m.length} setup định lượng, đẩy vào addTrades & đặt lệnh sàn`);
          addTrades(quantTrades1m, _lastMarketData.ta ?? {});
        }
      }
    } catch (e1m) {
      log.warn('[PP369 1m Scan] Lỗi thực thi định lượng 1m', { error: e1m.message });
    }

    // Bước 2: AI comment cho setup đủ điểm (chạy tuần tự để tránh spam Gemini)
    if (AI_ANALYSIS_ENABLED && _lastMarketData) {
      for (const sig of enriched) {
        if ((sig.score?.total ?? 0) >= MIN_SCORE_SIGNAL) {
          try {
            sig.aiComment = await analyze369Setup(sig, _lastMarketData);
            log.ai(`PP369 AI comment (${sig.symbol} ${sig.signal}): OK`);
          } catch (e) {
            log.warn(`PP369 AI comment lỗi (${sig.symbol})`, { error: e.message });
          }
        }
      }
    }

    enriched.forEach(sig => logSignal369(sig));
    log.system(`PP369 (1m): ${enriched.length} tín hiệu mới → gửi alert`);
    await sendMessages([format369Alert(enriched)], 1500, NEWS_CHAT_ID);
  } catch (err) {
    log.warn('PP369 1m scan lỗi', { error: err.message });
  }
}

module.exports = { runJob, isJobRunning, run369AlertScan, FIXED_COINS };
