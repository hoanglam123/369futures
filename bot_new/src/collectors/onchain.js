'use strict';

/**
 * Thu thập dữ liệu on-chain BTC từ:
 *
 * 1. mempool.space (miễn phí, không cần key, rất ổn định)
 *    - Mempool size: số TX đang chờ xác nhận → đo mức độ hoạt động mạng
 *    - Fee estimates: sat/vB → phân biệt QUIET / ACTIVE / CONGESTED
 *
 * 2. blockchain.com (miễn phí, không cần key)
 *    - TX count 24h, hash rate → sức khỏe mạng BTC
 *
 * Ý nghĩa signal:
 *   Mempool đông + fees cao → on-chain activity tăng mạnh, thường đi kèm pump
 *   Mempool trống + fees thấp → thị trường ngủ đông, wait-and-see
 *   Hash rate tăng → miner tự tin giá cao dài hạn (bullish cơ bản)
 */

const axios = require('axios');

const MEMPOOL_BASE = 'https://mempool.space/api';
const HEADERS      = { 'User-Agent': 'crypto-news-bot/1.0' };
const TIMEOUT      = 10000;

async function getMempoolStats() {
  try {
    const { data } = await axios.get(`${MEMPOOL_BASE}/mempool`, { headers: HEADERS, timeout: TIMEOUT });
    const count = data.count ?? 0;
    const vsize = data.vsize ?? 0;
    const congestion =
      count > 50000 ? 'EXTREME' :
      count > 20000 ? 'HIGH' :
      count >  5000 ? 'MEDIUM' : 'LOW';
    return { count, vsize, congestion };
  } catch { return null; }
}

async function getFeeEstimates() {
  try {
    const { data } = await axios.get(`${MEMPOOL_BASE}/v1/fees/recommended`, { headers: HEADERS, timeout: TIMEOUT });
    const fast   = data.fastestFee;
    const medium = data.halfHourFee;
    const slow   = data.hourFee;
    if (!fast && fast !== 0) return null;
    const signal =
      fast > 100 ? 'CONGESTED' :
      fast >  30 ? 'ACTIVE' :
      fast >   8 ? 'NORMAL' : 'QUIET';
    return { fast, medium, slow, signal };
  } catch { return null; }
}

async function getBTCStats() {
  try {
    const { data } = await axios.get('https://api.blockchain.info/stats', { headers: HEADERS, timeout: TIMEOUT });
    // hash_rate từ blockchain.com là GH/s → chuyển sang EH/s
    const hashrateEH = data.hash_rate ? (data.hash_rate / 1e9).toFixed(1) : null;
    return {
      txCount24h: data.n_tx,
      hashrateEH,
      avgFeeUsd: data.average_fee_usd != null ? parseFloat(data.average_fee_usd).toFixed(2) : null,
    };
  } catch { return null; }
}

async function getBTCOnchain() {
  const [mempoolRes, feesRes, statsRes] = await Promise.allSettled([
    getMempoolStats(),
    getFeeEstimates(),
    getBTCStats(),
  ]);

  const mempool = mempoolRes.status === 'fulfilled' ? mempoolRes.value : null;
  const fees    = feesRes.status   === 'fulfilled' ? feesRes.value   : null;
  const stats   = statsRes.status  === 'fulfilled' ? statsRes.value  : null;

  if (!mempool && !fees && !stats) return null;
  return { mempool, fees, stats };
}

module.exports = { getBTCOnchain };
