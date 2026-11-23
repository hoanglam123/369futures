'use strict';

/**
 * Thu thập funding rate từ Binance Futures USDT Perpetual.
 * Tính toán:
 *   - Top funding dương cao nhất (short futures để thu phí)
 *   - Top funding âm (long futures để thu phí khi giá giảm)
 *
 * Funding thanh toán mỗi 8h: 0:00, 8:00, 16:00 UTC (7h, 15h, 23h giờ VN)
 */

const axios = require('axios');

const BINANCE = 'https://fapi.binance.com';
const OKX     = 'https://www.okx.com';
const HEADERS = { 'User-Agent': 'crypto-news-bot/1.0' };
const TIMEOUT = 10000;

// Chỉ theo dõi các coin có thanh khoản cao để tránh noise
const WATCHLIST = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOGE', 'DOT',
  'LINK', 'UNI', 'ATOM', 'LTC', 'APT', 'ARB', 'OP', 'SUI', 'TON',
  'NEAR', 'INJ', 'TIA', 'WIF', 'PEPE', 'SHIB', 'JUP', 'MATIC', 'FTM',
  'BCH', 'ETC', 'HBAR', 'IMX', 'SAND', 'MANA', 'AXS', 'CRV', 'AAVE',
]);

// ─── Fetch helpers ────────────────────────────────────────────────────────────

// 1. Binance primary — bulk request, 1 lần lấy tất cả perpetuals
async function fetchBinanceFunding() {
  const { data } = await axios.get(`${BINANCE}/fapi/v1/premiumIndex`, {
    timeout: TIMEOUT,
    headers: HEADERS,
  });

  const rates = {};
  const nextFundingTimes = {};
  for (const item of (data ?? [])) {
    if (!item.symbol.endsWith('USDT')) continue;
    const sym = item.symbol.slice(0, -4);
    // Nạp toàn bộ 400+ perpetuals từ cùng 1 bulk request (0 thêm weight) để Funding Hard Filter phủ 100% altcoin
    const rate = parseFloat(item.lastFundingRate);
    if (!isNaN(rate)) {
      rates[sym] = rate;
      if (item.nextFundingTime) nextFundingTimes[sym] = parseInt(item.nextFundingTime);
    }
  }
  return { rates, nextFundingTimes };
}

// 2. OKX fallback — gọi per-coin song song
async function fetchOKXFunding() {
  const coins = [...WATCHLIST];
  const results = await Promise.allSettled(
    coins.map(coin =>
      axios.get(`${OKX}/api/v5/public/funding-rate`, {
        params: { instId: `${coin}-USDT-SWAP` },
        timeout: TIMEOUT,
        headers: HEADERS,
      })
    )
  );

  const rates = {};
  const nextFundingTimes = {};
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const item = result.value.data?.data?.[0];
    if (!item) return;
    const rate = parseFloat(item.fundingRate);
    if (!isNaN(rate)) {
      rates[coins[i]] = rate;
      if (item.fundingTime) nextFundingTimes[coins[i]] = parseInt(item.fundingTime);
    }
  });
  return { rates, nextFundingTimes };
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtRate(r) {
  return `${(r * 100).toFixed(4)}%`;
}

function dailyReturn(rate8h) {
  return `${(Math.abs(rate8h) * 3 * 100).toFixed(3)}%`;
}

// ─── Next funding payment time ───────────────────────────────────────────────

function getNextFundingInfo() {
  const now = new Date();
  const utcH = now.getUTCHours();
  // Payments at 0, 8, 16 UTC = 7, 15, 23 Vietnam
  const payHours = [0, 8, 16];
  const nextH = payHours.find(h => utcH < h);
  const nextUTC = nextH !== undefined
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextH, 0, 0))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));

  const ms = nextUTC - now;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const vnHour = nextUTC.toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
  });
  return {
    vnHour,
    countdown: h > 0 ? `${h}h${m}m nữa` : `${m}m nữa`,
    label: `${vnHour} (${h > 0 ? h + 'h' : ''}${m}m nữa)`,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getFundingRates() {
  let rates = {}, nextFundingTimes = {};

  // 1. Binance primary
  try {
    ({ rates, nextFundingTimes } = await fetchBinanceFunding());
  } catch { /* fall through */ }

  // 2. OKX fallback nếu Binance không trả về dữ liệu
  if (!Object.keys(rates).length) {
    try {
      ({ rates, nextFundingTimes } = await fetchOKXFunding());
    } catch { /* ignore */ }
  }

  if (!Object.keys(rates).length) {
    throw new Error('Không lấy được dữ liệu funding (Binance + OKX đều thất bại)');
  }

  // Top funding dương — short futures để nhận phí (hedge bằng spot)
  const topPositive = Object.entries(rates)
    .filter(([, r]) => r > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([symbol, rate]) => ({ symbol, rate }));

  // Top funding âm — long futures để nhận phí khi giá giảm (hedge bằng short spot)
  const topNegative = Object.entries(rates)
    .filter(([, r]) => r < 0)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3)
    .map(([symbol, rate]) => ({ symbol, rate }));

  return {
    binance: rates,
    bybit: {},             // không còn fetch Bybit
    nextFundingTimes,      // { coin: nextFundingTimeMs }
    topArbitrage: [],      // không còn so sánh cross-exchange
    topPositive,
    topNegative,
    fmtRate,
    dailyReturn,
  };
}

module.exports = { getFundingRates, getNextFundingInfo };
