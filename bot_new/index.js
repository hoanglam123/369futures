'use strict';

/**
 * Crypto News Bot - Entry Point
 *
 * Chạy job thu thập dữ liệu crypto và gửi lên Telegram mỗi ngày lúc 7:00 SA
 * Múi giờ: Asia/Ho_Chi_Minh (UTC+7)
 *
 * Cách sử dụng:
 *   node index.js            → Chạy daemon với cron scheduler
 *   node index.js --run-now  → Chạy ngay lập tức một lần (để test)
 *   node index.js --report   → Kiểm tra TP/SL + gửi báo cáo lịch sử lệnh lên Telegram
 *   node index.js --backtest → Phân tích klines Binance cho lệnh active (bot offline cả ngày)
 */

require('dotenv').config({ override: true });

const cron = require('node-cron');
const { runJob, run369AlertScan, runMacroRefresh, runShadowReevaluation, initPriceTickListener } = require('./src/job');
const { start369Stream } = require('./src/pp369/stream');
const { checkBTCAlert } = require('./src/services/priceAlert');
const { checkActiveTrades, getActiveTrades, sendActiveTradesSummary, runBacktest, initBinanceStream, syncManualPositions, consumeSignalScanFlag, onWsPush } = require('./src/services/tradeMonitor');
const { startStream, stopStream } = require('./src/services/binanceStream');
const { startPolling, setRunJob } = require('./src/services/telegramCommands');
const { buildDetailedReport } = require('./src/services/tradeStats');
const { checkFundingPayments, buildFundingStatsMessage } = require('./src/services/fundingTracker');
const { sendMessages } = require('./src/services/telegram');
const { log } = require('./src/services/logger');
const { createServer: createDashboard, broadcastWs } = require('./src/dashboard/server');

// ─── Kiểm tra biến môi trường bắt buộc trước khi khởi động ──────────────────
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

// Phase 2: Tắt mặc định External LLM (Claude/Gemini) — chỉ bật nếu chủ động đặt AI_ANALYSIS_ENABLED=true và có API key.
// Hệ thống giao dịch chạy 100% định lượng + AI Bản Thân Cục Bộ (0 Token - 0ms).
const hasAiKey = !!(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.GEMINI_API_KEY);
if (process.env.AI_ANALYSIS_ENABLED !== 'true' || !hasAiKey) {
  process.env.AI_ANALYSIS_ENABLED = 'false';
}

if (missing.length > 0) {
  console.error('❌ Thiếu biến môi trường bắt buộc:', missing.join(', '));
  console.error('   Hãy sao chép .env.example thành .env và điền đầy đủ thông tin');
  process.exit(1);
}

// ─── Cấu hình lịch chạy ───────────────────────────────────────────────────────
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 */4 * * *'; // Mặc định: 4 tiếng/lần (0h, 4h, 8h, 12h, 16h, 20h)
const TIMEZONE = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';

// ─── Chạy ngay nếu có flag --run-now (dùng để test) ─────────────────────────
if (process.argv.includes('--run-now')) {
  log.system('Chế độ --run-now: chạy job + kiểm tra lệnh đang theo dõi');
  runJob()
    .then(async () => {
      const active = getActiveTrades();
      if (active.length > 0) {
        log.system(`Kiểm tra ${active.length} lệnh đang theo dõi sau job...`);
        await checkActiveTrades().catch(e => log.warn('Không thể kiểm tra giá', { error: e.message }));
      }
      log.system('--run-now hoàn thành.');
      process.exit(0);
    })
    .catch((err) => {
      log.error('--run-now thất bại', { error: err.message });
      process.exit(1);
    });

// ─── Gửi báo cáo lịch sử lệnh lên Telegram ──────────────────────────────────
// ─── Backtest: dùng klines Binance để tìm TP/SL khi bot offline ─────────────
} else if (process.argv.includes('--backtest')) {
  log.system('Chế độ --backtest: phân tích klines Binance cho lệnh active');
  (async () => {
    const { checked, closed } = await runBacktest();
    const report = buildDetailedReport();
    await sendMessages([report]);
    if (checked === 0) {
      log.system('Không có lệnh active — backtest không có gì để làm');
    } else {
      log.system(`Backtest xong: ${closed}/${checked} lệnh tìm thấy kết quả, báo cáo đã gửi Telegram`);
    }
    process.exit(0);
  })().catch(err => {
    log.error('--backtest thất bại', { error: err.message });
    process.exit(1);
  });

} else if (process.argv.includes('--report')) {
  log.system('Chế độ --report: kiểm tra TP/SL + gửi báo cáo lên Telegram');
  (async () => {
    const active = getActiveTrades();
    if (active.length > 0) {
      log.system(`Kiểm tra ${active.length} lệnh đang theo dõi...`);
      await checkActiveTrades().catch(e => log.warn('Không thể kiểm tra giá', { error: e.message }));
    }
    const report = buildDetailedReport();
    await sendMessages([report]);
    if (active.length > 0) {
      await sendActiveTradesSummary().catch(() => {});
    }
    await sendMessages([buildFundingStatsMessage()]).catch(() => {});
    log.system('Báo cáo đã gửi lên Telegram.');
    process.exit(0);
  })().catch(err => {
    log.error('--report thất bại', { error: err.message });
    process.exit(1);
  });

} else {
  (async () => {
  // ─── Chế độ daemon: lên lịch chạy tự động ──────────────────────────────────
  const ENABLE_MARKET_REPORT_CRON = process.env.ENABLE_MARKET_REPORT_CRON === 'true';
  console.log('🚀 Crypto Futures Quant Bot (bot-new) đang khởi động...');

  if (ENABLE_MARKET_REPORT_CRON) {
    console.log(`📅 Lịch gửi bản tin thị trường: ${CRON_SCHEDULE} (${TIMEZONE})`);
    if (!cron.validate(CRON_SCHEDULE)) {
      console.error(`❌ CRON_SCHEDULE không hợp lệ: "${CRON_SCHEDULE}"`);
      process.exit(1);
    }
    cron.schedule(CRON_SCHEDULE, async () => {
      log.system('Cron trigger — bắt đầu chạy job');
      await runJob();
    }, {
      timezone: TIMEZONE,
      scheduled: true
    });
  } else {
    log.system('ℹ️ Đã tắt cron bản tin thị trường 4h mặc định (chạy thuần định lượng WS 0ms + FastScan 30s + Macro 15p giống bot-h4).');
  }

  // ─── LUỒNG VĨ MÔ NỀN SIÊU NHẸ (Mỗi 15 phút — Đồng bộ kiến trúc On-Demand của bot-h4) ───
  // Thay thế cron 5p nặng (từng gọi 30 coin song song ~800 weight/lần).
  // Săn kèo & vào lệnh giờ chạy hoàn toàn qua Luồng 1 (WS 0ms) + Luồng 2 (FastScan 30s).
  const MACRO_REFRESH_CRON = process.env.MACRO_REFRESH_CRON || '*/15 * * * *';
  const SIGNAL_SCAN_CRON = MACRO_REFRESH_CRON;
  if (!cron.validate(MACRO_REFRESH_CRON)) {
    console.error(`❌ MACRO_REFRESH_CRON không hợp lệ: "${MACRO_REFRESH_CRON}"`);
    process.exit(1);
  }
  cron.schedule(MACRO_REFRESH_CRON, async () => {
    await runMacroRefresh();
  }, { timezone: TIMEZONE, scheduled: true });

  // Nạp dữ liệu vĩ mô nền (BTC TA, Funding, Fear&Greed) ngay sau khi khởi động 5s
  setTimeout(() => {
    runMacroRefresh().catch(() => {});
  }, 5000);

  // ─── LUỒNG 1: BẮT TICK GIÁ WEBSOCKET REAL-TIME 0ms (ĐỒNG BỘ BOT-H4) ───────────
  if (typeof initPriceTickListener === 'function') {
    initPriceTickListener();
  }

  // ─── LUỒNG 2: QUÉT POLLING DỰ PHÒNG 30 GIÂY CHO TOP 8 COIN SÁT MỐC (<=0.5%) ───
  const FAST_SCAN_INTERVAL_MS = parseInt(process.env.FAST_SCAN_INTERVAL_MS || '30000', 10);
  setInterval(() => {
    run369AlertScan().catch(err => log.warn(`[FastScan] Lỗi: ${err.message}`));
  }, FAST_SCAN_INTERVAL_MS);

  // Kích hoạt quét ngay lần đầu sau 3 giây khởi động
  setTimeout(() => {
    run369AlertScan().catch(() => {});
  }, 3000);

  // Mỗi 1 phút: theo dõi lệnh active + BTC alert + funding
  // Nếu có _pendingSignalScan (vị thế thiếu TP/SL) → gọi syncManualPositions (Auto-Heal nhẹ, không gọi runJob nặng)
  cron.schedule('*/1 * * * *', async () => {
    const needsScan = consumeSignalScanFlag();
    await Promise.allSettled([
      checkActiveTrades(),
      checkBTCAlert(),
      checkFundingPayments(),
      needsScan ? syncManualPositions('needs_scan') : Promise.resolve(),
    ]);
  }, { timezone: TIMEZONE, scheduled: true });

  // Mỗi 5 phút: đồng bộ vị thế thủ công từ Binance
  // Bổ sung cho WS fill event — đảm bảo không bỏ sót vị thế nếu WS miss hoặc bot vừa restart
  // Có thể tắt bằng SYNC_POSITIONS_CRON=false trong .env
  const SYNC_POSITIONS_CRON = process.env.SYNC_POSITIONS_CRON;
  // Lệch sang giây thứ 20 (20 */5 * * * *) để không đụng đúng giây :00 với cron */1 * * * * (needs_scan)
  const syncCron = SYNC_POSITIONS_CRON !== 'false' ? (SYNC_POSITIONS_CRON || '20 */5 * * * *') : null;
  if (syncCron) {
    if (!cron.validate(syncCron)) {
      console.error(`❌ SYNC_POSITIONS_CRON không hợp lệ: "${syncCron}"`);
    } else {
      cron.schedule(syncCron, async () => {
        try {
          await syncManualPositions('cron');
        } catch (e) {
          log.error('Auto-sync: thất bại', { trigger: 'cron', error: e.message });
        }
      }, { timezone: TIMEZONE, scheduled: true });
    }
  }

  // Mỗi 30 phút: Tái chấm điểm từ đầu các vị thế Shadow sống sót (Phương án B - đồng bộ bot-h4)
  // Lệch sang giây thứ 10 (10 */30 * * * *) để không đụng cron :00 và :20
  let activeShadowReevalCron = null;
  if (process.env.ENABLE_SHADOW_REEVAL !== 'false') {
    const shadowReevalCron = process.env.SHADOW_REEVAL_CRON || '10 */30 * * * *';
    if (!cron.validate(shadowReevalCron)) {
      console.error(`❌ SHADOW_REEVAL_CRON không hợp lệ: "${shadowReevalCron}"`);
    } else {
      activeShadowReevalCron = shadowReevalCron;
      cron.schedule(shadowReevalCron, async () => {
        try {
          await runShadowReevaluation();
        } catch (e) {
          log.warn(`[ShadowReEval] Lỗi chu kỳ 30p: ${e.message}`);
        }
      }, { timezone: TIMEZONE, scheduled: true });
    }
  }

  // Khởi động Binance WebSocket stream (nhận event fill real-time)
  initBinanceStream();
  startStream().catch(() => {});
  // Đồng bộ vị thế thủ công đang mở (sau 3s để REST API ổn định)
  setTimeout(() => syncManualPositions('startup').catch(() => {}), 3000);

  // ─── Khởi tạo Dynamic Futures Universe 400+ coin (Giai đoạn 2) ─────────────
  const { getAllActiveFuturesSymbols, filterSymbolsByGrid } = require('./src/services/dynamicUniverse');
  const { initH1RefCache, prePopulateLevelCache } = require('./src/services/h1RefCache');
  const { updatePricesRest, getPrices, getNearbySymbols, getLevelCache } = require('./src/pp369');
  const { FIXED_COINS, setUniverseSymbols } = require('./src/job');

  let activeCoinList = FIXED_COINS;
  try {
    const allSymbols = await getAllActiveFuturesSymbols();
    await updatePricesRest().catch(() => {});
    const prices = getPrices();
    const validSymbols = filterSymbolsByGrid(allSymbols, prices);
    if (validSymbols.length > 0) {
      activeCoinList = validSymbols;
      setUniverseSymbols(validSymbols);
      await initH1RefCache(validSymbols);
      const prePopCount = prePopulateLevelCache(validSymbols, prices);
      log.system(`[AutoTrade] ✓ Khởi tạo Dynamic Universe: ${validSymbols.length} coin (Pre-populated ${prePopCount} mốc 369)`);
    }
  } catch (err) {
    log.warn(`[AutoTrade] Khởi tạo Universe thất bại: ${err.message} — fallback về ${FIXED_COINS.length} coin.`);
  }

  // Khởi động WebSocket stream và đăng ký (subscribe) chỉ các mã đang gần mốc (1.0%) + BTC giống bot-h4
  const initialLevelCache = getLevelCache();
  const initialNearby = getNearbySymbols(activeCoinList, initialLevelCache, 0.01);
  start369Stream(initialNearby);

  // Ghi danh sách symbols vào pp369_symbols.json
  try {
    const fs   = require('fs');
    const path = require('path');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const symFile = path.join(dataDir, 'pp369_symbols.json');
    fs.writeFileSync(symFile, JSON.stringify({
      symbols: activeCoinList,
      fixed: FIXED_COINS,
      updatedAt: new Date().toISOString(),
      source: 'dynamic_universe',
    }), 'utf8');
  } catch {}

  // Kết nối runJob vào Telegram command /runnow
  setRunJob(runJob);
  startPolling();

  createDashboard();
  onWsPush(broadcastWs);
  log.system('[PP369] [AutoTrade] ✓ Khởi động hệ thống giao dịch tự động định lượng 369 Futures');
  log.system(`[PP369] [AutoTrade] Chu kỳ quét định lượng: ${SIGNAL_SCAN_CRON} | Auto-sync vị thế: ${syncCron || 'tắt'} | Shadow Re-Eval: ${activeShadowReevalCron || 'tắt'}`);
  if (activeShadowReevalCron) {
    const minAgeMin = Math.round(parseInt(process.env.SHADOW_REEVAL_MIN_AGE_MS || String(15 * 60_000), 10) / 60_000);
    const maxAgeMs = parseInt(process.env.SHADOW_REEVAL_MAX_AGE_MS || '0', 10);
    const ageLabel = maxAgeMs > 0 ? `${minAgeMin}p-${Math.round(maxAgeMs / 3600_000)}h` : `>=${minAgeMin}p (không giới hạn trần)`;
    const maxProm = parseInt(process.env.SHADOW_REEVAL_MAX_PROMOTES_PER_CYCLE || '2', 10);
    log.system(`[ShadowReEval] Đã bật lịch đồng bộ đồng hồ mỗi 30p (${activeShadowReevalCron} — :00:10 & :30:10) | Tuổi: ${ageLabel}, Max ${maxProm} lệnh/chu kỳ.`);
  }

  // Gửi Telegram summary nếu có lệnh đang theo dõi sau khi restart
  const restored = getActiveTrades();
  if (restored.length > 0) {
    log.system(`Khôi phục ${restored.length} lệnh — gửi summary lên Telegram`);
    sendActiveTradesSummary().catch(e => log.warn('Không thể gửi trade summary', { error: e.message }));
  }
  })().catch(err => {
    log.error('Lỗi khởi động daemon bot-new', { error: err.message, stack: err.stack });
  });

  // Giữ tiến trình Node.js chạy liên tục
  process.on('SIGINT', () => {
    stopStream();
    log.system('Bot đã dừng (SIGINT)');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stopStream();
    log.system('Bot đã dừng (SIGTERM)');
    process.exit(0);
  });

  // Bắt lỗi không được xử lý để tránh crash daemon
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled Promise Rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    log.error('Uncaught Exception', { error: err.message });
  });
}
