'use strict';

/**
 * Thu thập và phân tích tâm lý thị trường từ Reddit (không cần API key):
 *   - r/CryptoCurrency (hot posts — community crypto rộng nhất)
 *   - r/Bitcoin        (hot posts — BTC-specific sentiment)
 *
 * Phân tích từ khóa đơn giản trong tiêu đề bài viết để đếm bullish/bearish.
 * Reddit là proxy tốt cho tâm lý retail trader — thường ngược pha với smart money.
 *
 * Lưu ý: Reddit rate-limit IP không có API key → timeout 12s, silent fail nếu blocked.
 * User-Agent cần mô phỏng browser hợp lệ để tránh 429.
 */

const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; crypto-news-bot/1.0)',
  'Accept': 'application/json',
};
const TIMEOUT = 12000;

const BULLISH_KW = [
  'bull', 'bullish', 'moon', 'pump', 'surge', 'rally', 'ath', 'all-time high',
  'breakout', 'buy the dip', 'accumulate', 'adoption', 'etf', 'institutional',
  'rise', 'rising', 'gain', 'green', 'recovery', 'rebound', 'uptrend',
];

const BEARISH_KW = [
  'bear', 'bearish', 'crash', 'dump', 'collapse', 'sell', 'short',
  'drop', 'fall', 'falling', 'loss', 'panic', 'fear', 'correction',
  'liquidated', 'scam', 'rug', 'hack', 'ban', 'regulation blocks',
  'lawsuit', 'bankrupt', 'insolvent', 'warning',
];

const COIN_ALIASES = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP',
  cardano: 'ADA', dogecoin: 'DOGE', avalanche: 'AVAX', chainlink: 'LINK',
  bnb: 'BNB', polkadot: 'DOT', polygon: 'MATIC', sui: 'SUI', ton: 'TON',
};

function scoreTitle(title) {
  const lower = title.toLowerCase();
  const bull = BULLISH_KW.filter(k => lower.includes(k)).length;
  const bear = BEARISH_KW.filter(k => lower.includes(k)).length;
  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

function extractMentions(titles) {
  const counts = {};
  for (const title of titles) {
    const lower = title.toLowerCase();
    // Tìm ticker viết hoa (BTC, ETH, SOL...)
    for (const m of title.matchAll(/\b([A-Z]{2,6})\b/g)) {
      if (m[1].length >= 2 && m[1].length <= 5) {
        counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
    }
    // Tìm tên đầy đủ (bitcoin, ethereum...)
    for (const [alias, symbol] of Object.entries(COIN_ALIASES)) {
      if (lower.includes(alias)) {
        counts[symbol] = (counts[symbol] || 0) + 1;
      }
    }
  }
  // Loại bỏ từ chung không phải coin
  const EXCLUDE = new Set(['THE', 'FOR', 'AND', 'ALL', 'ARE', 'NEW', 'TOP', 'HOW', 'WHY', 'DID', 'NOT', 'GET', 'HAS', 'USE', 'ITS', 'CAN', 'NOW', 'OUT', 'DAY', 'WAY', 'PUT', 'FUD']);
  return Object.entries(counts)
    .filter(([k]) => !EXCLUDE.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);
}

async function fetchSubreddit(subreddit, limit = 15) {
  try {
    const { data } = await axios.get(`https://www.reddit.com/r/${subreddit}/hot.json`, {
      params: { limit },
      headers: HEADERS,
      timeout: TIMEOUT,
    });
    return (data.data?.children || [])
      .filter(p => !p.data.stickied) // bỏ bài được ghim (thông báo mod)
      .map(p => ({
        title:       p.data.title,
        score:       p.data.score,
        upvoteRatio: p.data.upvote_ratio,
        comments:    p.data.num_comments,
        subreddit,
      }));
  } catch { return []; }
}

async function getRedditSentiment() {
  const [cryptoPosts, btcPosts] = await Promise.all([
    fetchSubreddit('CryptoCurrency', 20),
    fetchSubreddit('Bitcoin', 10),
  ]);

  const allPosts = [...cryptoPosts, ...btcPosts];
  if (!allPosts.length) return null;

  let bullish = 0, bearish = 0, neutral = 0;
  for (const post of allPosts) {
    const s = scoreTitle(post.title);
    if (s === 'bullish') bullish++;
    else if (s === 'bearish') bearish++;
    else neutral++;
  }

  const total = allPosts.length;
  const bullishPct = Math.round(bullish / total * 100);
  const bearishPct = Math.round(bearish / total * 100);

  const sentiment = bullishPct > 45 ? 'BULLISH' : bearishPct > 45 ? 'BEARISH' : 'NEUTRAL';

  const topPosts = allPosts
    .sort((a, b) => b.score * b.upvoteRatio - a.score * a.upvoteRatio)
    .slice(0, 3);

  const hotMentions = extractMentions(allPosts.map(p => p.title));

  return {
    totalPosts: total,
    bullish, bearish, neutral,
    bullishPct, bearishPct,
    sentiment,
    topPosts,
    hotMentions,
  };
}

module.exports = { getRedditSentiment };
