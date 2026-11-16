'use strict';

/**
 * Thu thập dữ liệu thị trường crypto
 * Primary: Binance Futures (trading trên Binance → giá Binance là chuẩn)
 * Fallback: CoinGecko khi Binance lỗi
 * Docs: https://www.coingecko.com/api/documentation
 */

const axios = require('axios');

const COINGECKO_BASE    = 'https://api.coingecko.com/api/v3';
const BINANCE_TICKER    = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const BINANCE_EXCH_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

// Volume tối thiểu (USDT 24h) để loại micro-cap pump khỏi danh sách gainers
const MIN_GAINER_VOLUME = parseInt(process.env.MIN_GAINER_VOLUME || '50000000', 10);

const STABLECOINS = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USDP','FRAX','USDD','GUSD','PYUSD','USDS','USDE','USDX','SUSD']);

// Cache danh sách symbol đang TRADING trên Binance Futures (TTL 6h)
let _futuresSymbols   = null;
let _futuresSymbolsTs = 0;
const FUTURES_TTL     = 6 * 60 * 60 * 1000;

async function getBinanceFuturesSymbols() {
  if (_futuresSymbols && Date.now() - _futuresSymbolsTs < FUTURES_TTL) return _futuresSymbols;
  try {
    const { data } = await axios.get(BINANCE_EXCH_INFO, { timeout: 10000 });
    _futuresSymbols = new Set(
      data.symbols
        .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
        .map(s => s.symbol.replace('USDT', ''))
    );
    _futuresSymbolsTs = Date.now();
  } catch (_) {
    // giữ cache cũ hoặc trả về Set rỗng — fail-open ở caller
  }
  return _futuresSymbols ?? new Set();
}

// Cấu hình axios chung cho CoinGecko
const coingeckoClient = axios.create({
  baseURL: COINGECKO_BASE,
  timeout: 15000,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'crypto-news-bot/1.0'
  }
});

/**
 * Lấy dữ liệu thị trường toàn cầu: tổng vốn hóa, khối lượng, BTC dominance...
 * Endpoint: GET /global
 */
async function getGlobalMarket() {
  const { data } = await coingeckoClient.get('/global');
  const d = data.data;

  return {
    totalMarketCap: d.total_market_cap?.usd ?? null,
    totalVolume24h: d.total_volume?.usd ?? null,
    btcDominance: d.market_cap_percentage?.btc ?? null,
    ethDominance: d.market_cap_percentage?.eth ?? null,
    marketCapChange24h: d.market_cap_change_percentage_24h_usd ?? null,
    activeCryptos: d.active_cryptocurrencies ?? null,
    markets: d.markets ?? null
  };
}

/**
 * PRIMARY: Lấy danh sách coin từ Binance Futures 24hr ticker.
 * - topCoins: rank theo quoteVolume (USDT) — proxy tốt cho liquidity trên Binance
 * - topGainers: rank theo % tăng, filter volume >= MIN_GAINER_VOLUME để loại micro-cap pump
 * - topLosers: rank theo % giảm
 */
async function getTopCoinsBinance(topN = 10) {
  const { data } = await axios.get(BINANCE_TICKER, { timeout: 10000 });

  const coins = data
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol:    t.symbol.replace('USDT', ''),
      price:     parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume24h: parseFloat(t.quoteVolume),
      high24h:   parseFloat(t.highPrice),
      low24h:    parseFloat(t.lowPrice),
    }))
    .filter(c => !STABLECOINS.has(c.symbol) && c.price > 0 && c.volume24h > 0);

  const normalize = (coin, rank) => ({
    rank,
    id:        coin.symbol.toLowerCase(),
    name:      coin.symbol,
    symbol:    coin.symbol,
    price:     coin.price,
    change24h: coin.change24h,
    marketCap: null,
    volume24h: coin.volume24h,
    high24h:   coin.high24h,
    low24h:    coin.low24h,
  });

  // topCoins: sort by volume
  const byVolume = [...coins].sort((a, b) => b.volume24h - a.volume24h);
  const topCoins = byVolume.slice(0, topN).map((c, i) => normalize(c, i + 1));

  // topGainers: filter volume >= MIN_GAINER_VOLUME rồi sort by % tăng
  const gainersPool = coins.filter(c => c.volume24h >= MIN_GAINER_VOLUME);
  const byGain      = [...gainersPool].sort((a, b) => b.change24h - a.change24h);
  const topGainers  = byGain.slice(0, 10).map((c, i) => normalize(c, i + 1));

  // topLosers: từ cùng pool, sort by % giảm
  const topLosers = byGain.slice(-5).reverse().map((c, i) => normalize(c, i + 1));

  return { topCoins, topGainers, topLosers };
}

/**
 * FALLBACK: Lấy danh sách coin từ CoinGecko khi Binance lỗi.
 * Có thêm market cap nhưng data không real-time bằng Binance.
 */
async function getTopCoinsCoinGecko(topN = 10) {
  const [{ data }, futuresSymbols] = await Promise.all([
    coingeckoClient.get('/coins/markets', {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: 100,
        page: 1,
        sparkline: false,
        price_change_percentage: '24h',
      },
    }),
    getBinanceFuturesSymbols(),
  ]);

  const normalize = (coin) => ({
    rank:      coin.market_cap_rank,
    id:        coin.id,
    name:      coin.name,
    symbol:    coin.symbol.toUpperCase(),
    price:     coin.current_price,
    change24h: coin.price_change_percentage_24h,
    marketCap: coin.market_cap,
    volume24h: coin.total_volume,
    high24h:   coin.high_24h,
    low24h:    coin.low_24h,
  });

  const filtered = futuresSymbols.size > 0
    ? data.filter(c => {
        const sym = c.symbol.toUpperCase();
        return futuresSymbols.has(sym) && !STABLECOINS.has(sym) && sym.length >= 2;
      })
    : data.filter(c => !STABLECOINS.has(c.symbol.toUpperCase()));

  const topCoins       = filtered.slice(0, topN).map(normalize);
  const coinsWithChg   = filtered.filter(c => c.price_change_percentage_24h != null && !isNaN(c.price_change_percentage_24h));
  const sorted         = [...coinsWithChg].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);
  const topGainers     = sorted.slice(0, 10).map(normalize);
  const topLosers      = sorted.slice(-5).reverse().map(normalize);

  return { topCoins, topGainers, topLosers };
}

/**
 * Lấy danh sách coin: Binance Futures primary, CoinGecko fallback.
 * @param {number} topN - Số coin top cần lấy (mặc định 10)
 */
async function getTopCoins(topN = 10) {
  try {
    return await getTopCoinsBinance(topN);
  } catch (err) {
    console.warn(`[marketData] Binance lỗi (${err.message}), dùng CoinGecko fallback`);
    return getTopCoinsCoinGecko(topN);
  }
}

module.exports = { getGlobalMarket, getTopCoins };
