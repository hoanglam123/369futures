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
const { runJob, run369AlertScan } = require('./src/job');
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

const isAiAnalysisEnabled = process.env.AI_ANALYSIS_ENABLED !== 'false';
const hasAiKey = !!(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.GEMINI_API_KEY);
if (isAiAnalysisEnabled && !hasAiKey) {
  missing.push('CLAUDE_API_KEY (hoặc GEMINI_API_KEY)');
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
  console.log('🚀 Crypto News Bot đang khởi động...');
  console.log(`📅 Lịch gửi tin: ${CRON_SCHEDULE} (${TIMEZONE})`);
  console.log('   → Mặc định: 4 tiếng/lần (0h, 4h, 8h, 12h, 16h, 20h)\n');

  // Validate cron expression trước khi đăng ký
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`❌ CRON_SCHEDULE không hợp lệ: "${CRON_SCHEDULE}"`);
    process.exit(1);
  }

  // Đăng ký cron job bản tin 4h
  cron.schedule(CRON_SCHEDULE, async () => {
    log.system('Cron trigger — bắt đầu chạy job');
    await runJob();
  }, {
    timezone: TIMEZONE,
    scheduled: true
  });

  // Mỗi N phút: signal scan — phân tích AI để tìm lệnh mới, không gửi bản tin thị trường
  const SIGNAL_SCAN_CRON = process.env.SIGNAL_SCAN_CRON || '2-59/5 * * * *';
  if (!cron.validate(SIGNAL_SCAN_CRON)) {
    console.error(`❌ SIGNAL_SCAN_CRON không hợp lệ: "${SIGNAL_SCAN_CRON}"`);
    process.exit(1);
  }
  cron.schedule(SIGNAL_SCAN_CRON, async () => {
    log.system('Signal scan 5p: chạy phân tích nhanh...');
    await runJob({ silent: true, lookbackHours: 1 });
  }, { timezone: TIMEZONE, scheduled: true });

  // Mỗi 1 phút: theo dõi lệnh active + BTC alert + funding + PP369 scan
  // Nếu có _pendingSignalScan (vị thế thiếu TP/SL) → trigger AI signal scan ngay
  cron.schedule('*/1 * * * *', async () => {
    const needsScan = consumeSignalScanFlag();
    await Promise.allSettled([
      checkActiveTrades(),
      checkBTCAlert(),
      checkFundingPayments(),
      run369AlertScan(),
      needsScan ? runJob({ silent: true }) : Promise.resolve(),
    ]);
  }, { timezone: TIMEZONE, scheduled: true });

  // Mỗi 5 phút: đồng bộ vị thế thủ công từ Binance
  // Bổ sung cho WS fill event — đảm bảo không bỏ sót vị thế nếu WS miss hoặc bot vừa restart
  // Có thể tắt bằng SYNC_POSITIONS_CRON=false trong .env
  const SYNC_POSITIONS_CRON = process.env.SYNC_POSITIONS_CRON;
  const syncCron = SYNC_POSITIONS_CRON !== 'false' ? (SYNC_POSITIONS_CRON || '*/5 * * * *') : null;
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
  log.system(`[PP369] [AutoTrade] Chu kỳ quét định lượng: ${SIGNAL_SCAN_CRON} | Auto-sync vị thế: ${syncCron || 'tắt'}`);

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
