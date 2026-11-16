'use strict';

const { log } = require('../services/logger');

/**
 * Thu thập tin tức crypto từ nhiều nguồn miễn phí song song:
 *   - CryptoCompare News API  (JSON, không cần key)
 *   - CoinDesk RSS
 *   - CoinTelegraph RSS
 *   - Decrypt RSS
 *
 * Kết quả được merge, loại trùng theo tiêu đề, sắp xếp mới nhất trước.
 */

const axios = require('axios');

// ─── RSS Parser ───────────────────────────────────────────────────────────────

function parseRSSXML(xml, sourceName) {
  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const block of blocks) {
    // Title — hỗ trợ CDATA và HTML entities cơ bản
    const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

    // URL — thử nhiều cách: <link>url</link>, <link href=""/>, <guid isPermaLink>
    let url = null;
    const lText = block.match(/<link[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/link>/);
    const lHref = block.match(/<link[^>]+href="(https?:\/\/[^"]+)"/);
    const lGuidPerm = block.match(/<guid[^>]*isPermaLink="true"[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/guid>/);
    const lGuid = block.match(/<guid[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/guid>/);
    if (lText) url = lText[1].trim();
    else if (lHref) url = lHref[1].trim();
    else if (lGuidPerm) url = lGuidPerm[1].trim();
    else if (lGuid) url = lGuid[1].trim();

    if (!url) continue;

    // Ngày đăng
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const publishedAt = dateMatch ? new Date(dateMatch[1].trim()) : new Date();

    if (title && url) {
      items.push({ title, url, source: sourceName, publishedAt, currencies: '' });
    }
  }

  return items;
}

async function fetchRSS(url, sourceName, limit = 8) {
  const { data } = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'crypto-news-bot/1.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' }
  });
  return parseRSSXML(data, sourceName).slice(0, limit);
}

// ─── CryptoCompare ────────────────────────────────────────────────────────────

async function fetchCryptoCompare(limit = 8) {
  const apiKey = process.env.CRYPTOCOMPARE_API_KEY;
  const headers = { 'User-Agent': 'crypto-news-bot/1.0' };
  if (apiKey) headers['authorization'] = `Apikey ${apiKey}`;

  const { data } = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
    params: { lang: 'EN', sortOrder: 'popular' },
    timeout: 12000,
    headers,
  });

  if (!data.Data?.length) return [];

  return data.Data.slice(0, limit).map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source_info?.name || item.source || 'CryptoCompare',
    publishedAt: item.published_on ? new Date(item.published_on * 1000) : new Date(),
    currencies: (item.categories || '').split('|').filter(Boolean).slice(0, 3).join(', ')
  }));
}

// ─── Nguồn RSS ────────────────────────────────────────────────────────────────

const RSS_SOURCES = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed', name: 'Decrypt' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Lấy tin tức crypto từ tất cả các nguồn, merge và dedup
 * @param {number} limit - Số tin tức trả về sau khi dedup (mặc định 10)
 * @returns {Array<{ title, url, source, publishedAt, currencies }>}
 */
async function getCryptoNews(limit = 10) {
  const tasks = [
    fetchCryptoCompare(8).catch((e) => { log.warn(`CryptoCompare news: ${e.message}`); return []; }),
    ...RSS_SOURCES.map((src) =>
      fetchRSS(src.url, src.name, 6).catch((e) => { log.warn(`${src.name} RSS: ${e.message}`); return []; })
    )
  ];

  const results = await Promise.all(tasks);
  const all = results.flat();

  if (!all.length) return [];

  // Loại trùng theo 50 ký tự đầu của tiêu đề (chuẩn hóa)
  const seen = new Set();
  const deduped = all.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sắp xếp mới nhất trước, trả về top limit
  return deduped
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

module.exports = { getCryptoNews };
