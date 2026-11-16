'use strict';

const axios = require('axios');

/**
 * Lấy giá BTC hiện tại — Binance Futures primary, OKX fallback.
 * @returns {number} Giá USD
 */
async function getBTCPrice() {
  // 1. Binance primary
  try {
    const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
      params: { symbol: 'BTCUSDT' },
      timeout: 8000,
    });
    const price = parseFloat(data?.markPrice);
    if (price) return price;
  } catch { /* fall through to OKX */ }

  // 2. OKX fallback
  const { data } = await axios.get('https://www.okx.com/api/v5/public/mark-price', {
    params: { instId: 'BTC-USDT-SWAP', instType: 'SWAP' },
    timeout: 8000,
    headers: { 'User-Agent': 'crypto-news-bot/1.0' },
  });
  const price = parseFloat(data?.data?.[0]?.markPx);
  if (!price) throw new Error('Không lấy được BTC mark price (Binance + OKX đều thất bại)');
  return price;
}

module.exports = { getBTCPrice };
