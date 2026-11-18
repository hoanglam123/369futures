'use strict';

const axios = require('axios');
const { getNextFundingInfo } = require('../collectors/fundingRates');
const { log } = require('./logger');

// Thứ tự ưu tiên: mới nhất → cũ nhất (fallback tự động nếu model lỗi/quota)
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',  // RPD cao nhất (500/ngày), phản hồi siêu tốc
  'gemini-2.5-flash',       // Fallback
  'gemini-2.5-flash-lite',  // Fallback cuối
];

const configuredModel = process.env.CLAUDE_MODEL
  || process.env.ANTHROPIC_MODEL
  || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

const CLAUDE_MODELS = configuredModel
  ? [configuredModel, 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']
  : [
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-haiku-20240307',
    ];

function getAiConfig() {
  const claudeKey = process.env.CLAUDE_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN;

  const geminiKey = process.env.GEMINI_API_KEY;
  const forcedProvider = process.env.AI_PROVIDER ? process.env.AI_PROVIDER.toLowerCase() : null;

  let provider = forcedProvider;
  if (!provider) {
    if (claudeKey) provider = 'claude';
    else if (geminiKey) provider = 'gemini';
    else provider = 'gemini';
  }

  const rawBaseUrl = process.env.CLAUDE_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || '';

  return {
    provider,
    claudeKey,
    geminiKey,
    claudeBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
  };
}

// ─── Format helpers (plain text cho prompt, không cần HTML) ───────────────────

const fmt = {
  price: (n) => {
    if (!n) return 'N/A';
    if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(6)}`;
  },
  billion: (n) => {
    if (!n) return 'N/A';
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)} nghìn tỷ`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)} tỷ`;
    return `$${(n / 1e6).toFixed(2)} triệu`;
  },
  pct: (n) => (n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : 'N/A'),
  rate: (r) => `${(r * 100).toFixed(4)}%`,
  daily: (r8h) => `${(Math.abs(r8h) * 3 * 100).toFixed(3)}%`,
};

// ─── Format TA data thành text cho prompt ────────────────────────────────────

function buildTASummaryText(taReport) {
  if (!taReport || !Object.keys(taReport).length) return '';

  const fp = (n) => {
    if (n == null) return 'N/A';
    if (n >= 10000) return `$${Math.round(n).toLocaleString('en-US')}`;
    if (n >= 1)     return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    return `$${n.toFixed(6)}`;
  };
  const fn = (n, d = 2) => n != null ? n.toFixed(d) : 'N/A';

  const lines = ['\n[PHÂN TÍCH KỸ THUẬT — Binance Futures Data]'];

  for (const [sym, ta] of Object.entries(taReport)) {
    const above200 = ta.aboveEMA200 == null ? '' : ta.aboveEMA200 ? ' ✅ trên EMA200D' : ' ⚠️ dưới EMA200D';
    const regimeStr = ta.regime ? ` | Regime: ${ta.regime}` : '';
    lines.push(`\n── ${sym} ──`);
    lines.push(`Giá: ${fp(ta.price)} | Xu hướng 4h: ${ta.trend}${above200}${regimeStr}`);
    lines.push(`Thay đổi 4h: ${ta.priceChange4h != null ? (ta.priceChange4h >= 0 ? '+' : '') + fn(ta.priceChange4h) + '%' : 'N/A'}`);

    // RSI
    lines.push(`RSI: 1h=${fn(ta.rsi?.['1h'])} | 4h=${fn(ta.rsi?.['4h'])} (${ta.rsiSignal || 'N/A'}) | 1d=${fn(ta.rsi?.['1d'])}`);

    // StochRSI
    if (ta.stochRSI) {
      lines.push(`StochRSI(4h): K=${fn(ta.stochRSI.k)} → ${ta.stochRSI.signal}`);
    }

    // EMA stack
    const e = ta.ema;
    if (e) {
      lines.push(`EMA(4h): 7=${fp(e.e7)} | 25=${fp(e.e25)} | 99=${fp(e.e99)}${e.e200d ? ` | 200D=${fp(e.e200d)}` : ''}`);
    }

    // MACD
    if (ta.macd) {
      const m = ta.macd;
      const cross = m.crossover ? ` ⚡${m.crossover}` : '';
      lines.push(`MACD(4h): ${fn(m.macd, 4)} | Signal=${fn(m.signal, 4)} | Hist=${fn(m.histogram, 4)} → ${m.trend}${cross}`);
    }

    // Bollinger Bands
    if (ta.bb) {
      const b = ta.bb;
      lines.push(`BB(20,4h): Upper=${fp(b.upper)} | Mid=${fp(b.middle)} | Lower=${fp(b.lower)} | %B=${fn(b.pctB)}% | BW=${fn(b.bandwidth)}%`);
    }

    // ATR
    if (ta.atr) {
      lines.push(`ATR(14,4h): ${fp(ta.atr)} (±${fn(ta.atrPct)}% biến động/nến 4h)`);
    }

    // Weekly pivot (institution reference — mạnh nhất)
    if (ta.weeklyPivot) {
      lines.push(`Tuần trước(1W): High=${fp(ta.weeklyPivot.high)} | Low=${fp(ta.weeklyPivot.low)}`);
    }
    // 4H cluster S/R — mức thực chiến ngắn hạn (ưu tiên cho entry/SL/TP)
    if (ta.resistance4h?.length) {
      const r = ta.resistance4h.map((v, i) => `${fp(v)}(${ta.resistance4hTouches?.[i] ?? 1}x)`).join(' | ');
      lines.push(`Kháng cự(4H): ${r}`);
    }
    if (ta.support4h?.length) {
      const s = ta.support4h.map((v, i) => `${fp(v)}(${ta.support4hTouches?.[i] ?? 1}x)`).join(' | ');
      lines.push(`Hỗ trợ(4H):   ${s}`);
    }
    // 1D cluster S/R: kèm touch count (3x = test 3 lần → càng nhiều càng mạnh)
    if (ta.resistance?.length) {
      const r = ta.resistance.map((v, i) => `${fp(v)}(${ta.resistanceTouches?.[i] ?? 1}x)`).join(' | ');
      lines.push(`Kháng cự(1D): ${r}`);
    }
    if (ta.support?.length) {
      const s = ta.support.map((v, i) => `${fp(v)}(${ta.supportTouches?.[i] ?? 1}x)`).join(' | ');
      lines.push(`Hỗ trợ(1D):   ${s}`);
    }

    // Volume
    if (ta.volume) {
      lines.push(`Volume(4h): ${ta.volume.label} (${fn(ta.volume.ratio)}x trung bình 20 nến)`);
    }

    // Candle patterns
    if (ta.patterns?.length) {
      lines.push(`Mô hình nến: ${ta.patterns.join(', ')}`);
    }

    // Open Interest
    if (ta.oi) {
      lines.push(`OI: $${fn(ta.oi.valueMil, 1)}M (${ta.oi.change24h >= 0 ? '+' : ''}${fn(ta.oi.change24h)}% 24h)`);
    }

    // Long/Short ratio
    if (ta.ls) {
      const ls = ta.ls;
      lines.push(`L/S toàn thị trường: Long ${fn(ls.longPct)}% / Short ${fn(ls.shortPct)}% (ratio ${fn(ls.ratio, 3)})`);
    }
    if (ta.topLS) {
      lines.push(`L/S top trader: Long ${fn(ta.topLS.longPct)}% / Short ${fn(ta.topLS.shortPct)}%`);
    }
  }

  return lines.join('\n');
}

// ─── Tạo đoạn text mô tả dữ liệu thị trường ─────────────────────────────────

function buildMarketSummaryText({ globalMarket, topCoins, topGainers, topLosers, fearGreed, news }) {
  const today = new Date().toLocaleDateString('vi-VN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const lines = [`=== THỊ TRƯỜNG CRYPTO — ${today.toUpperCase()} ===`];

  lines.push('\n[TỔNG QUAN]');
  lines.push(`Vốn hóa: ${fmt.billion(globalMarket?.totalMarketCap)} (${fmt.pct(globalMarket?.marketCapChange24h)})`);
  lines.push(`Volume 24h: ${fmt.billion(globalMarket?.totalVolume24h)}`);
  lines.push(`BTC Dom: ${globalMarket?.btcDominance?.toFixed(2) ?? 'N/A'}% | ETH Dom: ${globalMarket?.ethDominance?.toFixed(2) ?? 'N/A'}%`);
  lines.push(`Fear & Greed: ${fearGreed?.value ?? 'N/A'}/100 — ${fearGreed?.classificationVi ?? 'N/A'}`);

  lines.push('\n[TOP 10 COIN]');
  topCoins?.forEach((c) => {
    lines.push(`${c.rank}. ${c.name} (${c.symbol}): ${fmt.price(c.price)} | 24h: ${fmt.pct(c.change24h)} | Vốn hóa: ${fmt.billion(c.marketCap)}`);
  });

  lines.push('\n[TOP 5 TĂNG 24H]');
  topGainers?.forEach((c) => lines.push(`${c.symbol}: ${fmt.pct(c.change24h)} — ${fmt.price(c.price)}`));

  lines.push('\n[TOP 5 GIẢM 24H]');
  topLosers?.forEach((c) => lines.push(`${c.symbol}: ${fmt.pct(c.change24h)} — ${fmt.price(c.price)}`));

  if (news?.length > 0) {
    lines.push('\n[TIN TỨC]');
    news.slice(0, 8).forEach((n) => lines.push(`- ${n.title} (${n.source})`));
  }

  return lines.join('\n');
}

// ─── Tạo đoạn text whale data cho prompt ─────────────────────────────────────

function buildWhaleSummaryText(whaleData) {
  if (!whaleData) return '';
  const { takerFlow, binanceLarge, crossSignals, liquidations, onchain, hasWhaleAlert, fmtM } = whaleData;

  const hasFlow    = Object.keys(takerFlow    || {}).length > 0;
  const hasBN      = Object.keys(binanceLarge || {}).length > 0;
  const hasCross   = Object.keys(crossSignals || {}).length > 0;
  const hasOnchain = Object.keys(onchain      || {}).length > 0;
  if (!hasFlow && !hasBN && !hasOnchain) return '';

  const fmt = fmtM || ((n) => {
    if (!n) return '$0';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${(n / 1e3).toFixed(0)}K`;
  });

  const lines = ['\n[WHALE / LARGE TRADER ACTIVITY]'];
  lines.push('Ngưỡng: ≥$1M/lệnh — TẤT CẢ tier đều tính điểm signal');
  lines.push('Tier: RETAIL_LARGE=$1M-$5M (+1đ) | WHALE=$5M-$20M (+1đ bonus) | INSTITUTION≥$20M (+2đ bonus)');
  lines.push('Bias (WHALE_BUY/WHALE_SELL) tính từ tổng tất cả lệnh ≥$1M');

  // ── OKX Taker Flow (all traders, aggregated) ──
  if (hasFlow) {
    const lookback = Object.values(takerFlow)[0]?.lookbackHours ?? 4;
    lines.push(`\nOKX Taker Flow — tất cả lệnh futures (${lookback}h):`);
    for (const [sym, f] of Object.entries(takerFlow)) {
      const label = f.bias === 'BUY_PRESSURE'  ? 'MUA MẠNH' :
                    f.bias === 'SELL_PRESSURE' ? 'BÁN MẠNH' : 'cân bằng';
      const delta = (f.buyPct - f.sellPct).toFixed(1);
      lines.push(`  ${sym}: Buy ${f.buyPct.toFixed(1)}% / Sell ${f.sellPct.toFixed(1)}% → ${f.bias} / ${label} (Δ${delta >= 0 ? '+' : ''}${delta}%)`);
    }
  }

  // ── Binance Futures large trades (≥$1M, all tiers) ──
  if (hasBN) {
    const lookback = Object.values(binanceLarge)[0]?.lookbackHours ?? 4;
    lines.push(`\nBinance Futures Large Trades ≥$1M (${lookback}h) — tất cả tier tính điểm:`);
    for (const [sym, d] of Object.entries(binanceLarge)) {
      lines.push(`  ${sym}: Buy ${fmt(d.buyVol)} (${d.buyCount}L) / Sell ${fmt(d.sellVol)} (${d.sellCount}L) → ${d.bias} [buy ${d.buyPct.toFixed(1)}%]`);
      // Tier breakdown
      const rl  = d.tiers?.RETAIL_LARGE;
      const whl = d.tiers?.WHALE;
      const ins = d.tiers?.INSTITUTION;
      if (rl  && (rl.buyVol  + rl.sellVol)  > 0) lines.push(`    RETAIL_LARGE($1M-$5M): Buy ${fmt(rl.buyVol)} / Sell ${fmt(rl.sellVol)} [+1đ nếu đúng chiều]`);
      if (whl && (whl.buyVol + whl.sellVol) > 0) lines.push(`    WHALE($5M-$20M): Buy ${fmt(whl.buyVol)} / Sell ${fmt(whl.sellVol)} [+1đ bonus]`);
      if (ins && (ins.buyVol + ins.sellVol) > 0) lines.push(`    INSTITUTION(≥$20M): Buy ${fmt(ins.buyVol)} / Sell ${fmt(ins.sellVol)} [+2đ bonus] ← CỰC KỲ QUAN TRỌNG`);
      // Notable events (≥$1M, tất cả tier)
      for (const ev of (d.notableEvents || []).slice(0, 3)) {
        const t = new Date(ev.ts).toLocaleTimeString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
        });
        lines.push(`    ⚡ ${ev.side} ${fmt(ev.notional)} [${ev.tier}] lúc ${t}`);
      }
    }
  }

  // ── Cross-source confirmation (tín hiệu tổng hợp) ──
  if (hasCross) {
    lines.push('\nTÍN HIỆU TỔNG HỢP (OKX taker flow + Binance large trades):');
    for (const [sym, cs] of Object.entries(crossSignals)) {
      lines.push(`  ${sym}: ${cs.verdict} (${cs.strength}/${cs.total} nguồn đồng thuận)`);
    }
    lines.push('→ XÁC NHẬN MUA/BÁN (cả 2 nguồn): signal mạnh nhất, ưu tiên vào lệnh');
    lines.push('→ PHÂN KỲ: retail và whale đi ngược chiều — KHÔNG vào lệnh, chờ xác nhận');
  }

  // ── Liquidations (Binance Force Orders — đáng tin nhất, không thể ẩn) ──
  const hasLiq = Object.keys(liquidations || {}).length > 0;
  if (hasLiq) {
    lines.push('\nBinance Futures Liquidations (force orders — whale không thể dùng iceberg):');
    lines.push('LONG_SQUEEZE = nhiều long bị thanh lý → bearish | SHORT_SQUEEZE = short bị thanh lý → bullish');
    for (const [sym, d] of Object.entries(liquidations)) {
      const longPct  = d.totalLiq > 0 ? (d.longLiqVol  / d.totalLiq * 100).toFixed(1) : 0;
      const shortPct = d.totalLiq > 0 ? (d.shortLiqVol / d.totalLiq * 100).toFixed(1) : 0;
      lines.push(`  ${sym}: Long liq ${fmt(d.longLiqVol)} (${longPct}%) / Short liq ${fmt(d.shortLiqVol)} (${shortPct}%) → ${d.dominant}`);
      for (const liq of (d.largeLiqs || []).slice(0, 2)) {
        const t = new Date(liq.ts).toLocaleTimeString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
        });
        lines.push(`    💥 ${liq.type} ${fmt(liq.notional)} lúc ${t}`);
      }
    }
    lines.push('→ SHORT_SQUEEZE + setup LONG = rất bullish | LONG_SQUEEZE + setup SHORT = rất bearish');
  }

  // ── On-chain (Whale Alert, optional) ──
  if (hasOnchain) {
    lines.push('\nOn-chain Txs >$1M (Whale Alert):');
    for (const [sym, d] of Object.entries(onchain)) {
      const net = d.outflow - d.inflow;
      const netLabel = net > 10_000_000 ? '(bullish — rút về cold wallet)' :
                       net < -10_000_000 ? '(bearish — nạp vào sàn)' : '(trung tính)';
      lines.push(`  ${sym}: vào sàn ${fmt(d.inflow)} / ra sàn ${fmt(d.outflow)} → Net ${net >= 0 ? '+' : ''}${fmt(Math.abs(net))} ${netLabel}`);
    }
  } else if (hasWhaleAlert === false) {
    lines.push('\nOn-chain: chưa cấu hình WHALE_ALERT_API_KEY (tùy chọn)');
  }

  return lines.join('\n');
}

// ─── Tạo đoạn text mô tả funding rate ───────────────────────────────────────

function buildFundingSummaryText(funding) {
  if (!funding) return '';

  const next = getNextFundingInfo();
  const lines = [`\n[FUNDING RATE — Thanh toán tiếp: ${next.label} (7h/15h/23h giờ VN)]`];
  lines.push('Phí round-trip ~0.08-0.10%. Hòa vốn: cần spread/rate > 0.05-0.10%/8h.');

  if (funding.topArbitrage?.length > 0) {
    lines.push('\nSpread cross-exchange (ưu tiên spread > 0.15%/8h):');
    funding.topArbitrage.slice(0, 3).forEach((item) => {
      const net = Math.max(0, item.absSpread * 100 - 0.09).toFixed(3);
      lines.push(`${item.symbol}: BN=${fmt.rate(item.binance)}/8h, BB=${fmt.rate(item.bybit)}/8h, Spread=${item.spread >= 0 ? '+' : ''}${fmt.rate(item.spread)}/8h → ~${fmt.daily(item.spread)}/ngày thô (net ~${net}%/ngày)`);
      lines.push(`  → ${item.direction}`);
    });
  }

  if (funding.topPositive?.length > 0) {
    lines.push('\nFunding DƯƠNG Binance (Short Futures + Long Spot = thu phí, rủi ro thấp):');
    funding.topPositive.slice(0, 3).forEach((item) => {
      lines.push(`${item.symbol}: +${fmt.rate(item.rate)}/8h → ~${fmt.daily(item.rate)}/ngày`);
    });
  }

  if (funding.topNegative?.length > 0) {
    lines.push('\nFunding ÂM (Long Futures + Short Spot = thu phí khi giá giảm):');
    funding.topNegative.slice(0, 2).forEach((item) => {
      lines.push(`${item.symbol}: ${fmt.rate(item.rate)}/8h → ~${fmt.daily(item.rate)}/ngày`);
    });
  }

  return lines.join('\n');
}

// ─── Derivatives (OI trend + Long/Short ratio) ───────────────────────────────

function buildDerivativesSummaryText(derivatives) {
  if (!derivatives || !Object.keys(derivatives).length) return '';

  const fn = (n, d = 1) => n != null ? n.toFixed(d) : 'N/A';
  const lines = ['\n[DERIVATIVES — OI TREND & LONG/SHORT RATIO (Binance Futures)]'];
  lines.push('Nguồn: Binance /futures/data/ (bổ sung OKX OI đã có trong TA)');

  for (const [sym, d] of Object.entries(derivatives)) {
    lines.push(`\n── ${sym} ──`);

    // OI history trend
    if (d.oi) {
      const sign   = d.oi.changePct >= 0 ? '+' : '';
      const interp = d.oi.trend === 'RISING'  ? '(vốn mới vào)' :
                     d.oi.trend === 'FALLING' ? '(đóng vị thế)' : '(ổn định)';
      lines.push(`OI: $${fn(d.oi.current, 0)}M (${sign}${fn(d.oi.changePct)}% ${d.oi.trend}) ${interp}`);
    }

    // Global L/S ratio (retail)
    if (d.retail) {
      const r = d.retail;
      const contrarian = d.lsSignal?.contrarian || '';
      const c = contrarian === 'CONTRARIAN_LONG'  ? ' → CONTRARIAN BULLISH (retail quá short)' :
                contrarian === 'CONTRARIAN_SHORT' ? ' → CONTRARIAN BEARISH (retail quá long)'  : '';
      lines.push(`L/S Retail: Long ${fn(r.longPct)}% / Short ${fn(r.shortPct)}% (ratio ${fn(r.ratio, 3)})${c}`);
    }

    // Top trader L/S (smart money)
    if (d.topTrader) {
      const t = d.topTrader;
      const div = d.lsSignal?.divergence ? ' ← PHÂN KỲ vs retail!' : '';
      lines.push(`L/S Top Trader: Long ${fn(t.longPct)}% / Short ${fn(t.shortPct)}%${div}`);
    }
  }

  lines.push('\nCách đọc OI:');
  lines.push('  Giá ↑ + OI ↑ = bullish confirmation | Giá ↑ + OI ↓ = short squeeze (không bền)');
  lines.push('  Giá ↓ + OI ↑ = bearish confirmation | Giá ↓ + OI ↓ = long bị thanh lý');
  lines.push('Contrarian L/S: retail short quá nhiều thường là tín hiệu đáy ngắn hạn (và ngược lại)');

  return lines.join('\n');
}

// ─── BTC On-chain (mempool.space) ────────────────────────────────────────────

function buildOnchainSummaryText(onchain) {
  if (!onchain) return '';

  const lines = ['\n[BTC ON-CHAIN — mempool.space + blockchain.com]'];

  if (onchain.mempool) {
    const m = onchain.mempool;
    const label = m.congestion === 'EXTREME' ? 'TẮC NGHẼN NẶNG' :
                  m.congestion === 'HIGH'    ? 'Đông đúc' :
                  m.congestion === 'MEDIUM'  ? 'Bình thường' : 'Yên tĩnh';
    lines.push(`Mempool: ${(m.count / 1000).toFixed(1)}K TX chờ (${m.congestion} — ${label})`);
  }

  if (onchain.fees) {
    const f = onchain.fees;
    const label = f.signal === 'CONGESTED' ? 'tắc nghẽn' :
                  f.signal === 'ACTIVE'    ? 'hoạt động cao' :
                  f.signal === 'NORMAL'    ? 'bình thường' : 'yên tĩnh';
    lines.push(`Fee BTC: Nhanh=${f.fast} | 30min=${f.medium} | 1h=${f.slow} sat/vB (${label})`);
  }

  if (onchain.stats) {
    const s = onchain.stats;
    if (s.txCount24h) lines.push(`Giao dịch 24h: ${(s.txCount24h / 1000).toFixed(1)}K TX`);
    if (s.hashrateEH) lines.push(`Hash rate: ${s.hashrateEH} EH/s`);
  }

  lines.push('Mempool đông + fee cao = on-chain activity tăng → thường đi kèm giá tăng mạnh');

  return lines.join('\n');
}

// ─── Social Sentiment (Reddit) ───────────────────────────────────────────────

function buildSocialSummaryText(social) {
  if (!social) return '';

  const lines = ['\n[SOCIAL SENTIMENT — Reddit r/CryptoCurrency + r/Bitcoin]'];
  lines.push(`Phân tích ${social.totalPosts} hot posts: Bullish ${social.bullishPct}% | Bearish ${social.bearishPct}% | Neutral ${100 - social.bullishPct - social.bearishPct}%`);
  lines.push(`Tâm lý chung: ${social.sentiment}`);

  if (social.hotMentions?.length) {
    lines.push(`Coin được nhắc nhiều nhất: ${social.hotMentions.join(', ')}`);
  }

  if (social.topPosts?.length) {
    lines.push('\nTop posts (theo điểm):');
    social.topPosts.slice(0, 3).forEach(p => {
      const ratio = p.upvoteRatio ? ` [${Math.round(p.upvoteRatio * 100)}% upvote]` : '';
      lines.push(`  • ${p.title.slice(0, 80)}${ratio}`);
    });
  }

  lines.push('Lưu ý: Reddit phản ánh tâm lý retail — thường ngược chiều smart money tại đỉnh/đáy');

  return lines.join('\n');
}

// ─── Helper: active trades context cho AI prompt ─────────────────────────────

function buildActiveTradesText(activeTrades) {
  if (!activeTrades?.length) return '';
  const fmtP = (n) => {
    if (n == null)  return 'N/A';
    if (n >= 10000) return `$${Math.round(n).toLocaleString('en-US')}`;
    if (n >= 1)     return `$${n.toFixed(2)}`;
    return `$${n.toFixed(6)}`;
  };
  const lines = ['\n[LỆNH ĐANG THEO DÕI — ĐỌC TRƯỚC KHI KHUYẾN NGHỊ]'];
  for (const t of activeTrades) {
    const ageH    = ((Date.now() - new Date(t.recommendedAt)) / 3600000).toFixed(1);
    const status  = t.entryFilled ? 'ĐÃ VÀO' : 'CHỜ ENTRY';
    const levStr  = t.leverage ? ` ⚡x${t.leverage}` : '';
    lines.push(`• ${t.symbol} ${t.direction} [${status}]${levStr} — Entry ${fmtP(t.entryPrice)} | TP ${fmtP(t.targetPrice)} | SL ${fmtP(t.slPrice)} | Đã ${ageH}h`);
  }
  lines.push('QUY TẮC:');
  lines.push('→ Lệnh còn đúng hướng: viết "GIỮ LỆNH [COIN] [DIRECTION]" thay vì lặp entry mới');
  lines.push('→ Cần điều chỉnh TP/SL: chỉ đề xuất nếu thay đổi > 1.5% so với mức cũ');
  lines.push('→ Đảo chiều: chỉ khi confluence ngược chiều ≥ 9 điểm VÀ lý do rõ ràng');
  return lines.join('\n');
}

// ─── System Prompt cố định (Guardrails & Trading Philosophy) ─────────────────

const SYSTEM_PROMPT = `Bạn là quant trader kỳ cựu với hơn 10 năm kinh nghiệm phái sinh crypto (Binance Futures).
Nhiệm vụ: Đánh giá dữ liệu định lượng đã được hệ thống code tính sẵn và đưa ra quyết định giao dịch có kỷ luật cao nhất.

NGUYÊN TẮC CỐT LÕI (BẤT BIẾN):
1. CHẤT LƯỢNG HƠN SỐ LƯỢNG: 0 lệnh tốt hơn 1 lệnh thua. Chỉ vào lệnh khi xác suất thắng cao và tỷ lệ Lợi nhuận/Rủi ro (R:R) vượt trội.
2. KHÔNG TỰ TÍNH LẠI ĐIỂM: Số điểm Confluence trong <confluence_scores> đã được thuật toán code tính toán chính xác 100%. Tuân thủ nghiêm ngặt verdict:
   - DISQUALIFIED, NO_SETUP (<5đ), CAUTIOUS (5-6đ): TUYỆT ĐỐI KHÔNG khuyến nghị mở lệnh mới.
   - CONFIDENT (7-8đ): Xem xét vào lệnh nếu R:R ≥ 1:1.5 và SL ≥ 1.5x ATR.
   - BEST_OPPORTUNITY (≥9đ): Ưu tiên cao nhất, R:R ≥ 1:2 và SL ≥ 1.5x - 2x ATR.
3. QUY TẮC ATR VÀ STOP LOSS (BẢO VỆ VỐN):
   - SL phải đặt sau các mốc Hỗ trợ/Kháng cự (S/R) và BẮT BUỘC khoảng cách |Entry - SL| ≥ 1.5x ATR. Không bao giờ đặt SL quá gần entry trong phạm vi nhiễu động ATR vì sẽ bị stop-hunt quét râu.
   - Nếu đặt SL đúng chuẩn ≥ 1.5x ATR mà khiến R:R < 1:1.5 đối với TP hợp lý → LOẠI BỎ coin đó ngay lập tức, không gượng ép vào lệnh.
4. TÍNH CHÍNH XÁC CỦA LỆNH:
   - Lệnh LONG: Bắt buộc Stop Loss < Entry Price < Target Price.
   - Lệnh SHORT: Bắt buộc Stop Loss > Entry Price > Target Price.
   - Đòn bẩy (Leverage): Lấy đúng giá trị MaxLev từ bảng điểm, tuyệt đối không tự nâng leverage.

⚠️ FORMAT BẮT BUỘC (HTML Telegram):
- Chỉ dùng: <b>, <i>, <code>
- KHÔNG dùng: <p>, <br>, <div>, <ul>, <li>, <h1>-<h6>, markdown (**, ##, --)
- Xuống dòng = newline thực, mỗi dòng ≤ 42 ký tự`;

// ─── Gọi Gemini API ──────────────────────────────────────────────────────────

async function analyzeMarket(marketData, { activeTrades = [], recentHistoryText = '', scoresText = '', signals369Text = '' } = {}) {
  const marketSummary      = buildMarketSummaryText(marketData);
  const fundingSummary     = buildFundingSummaryText(marketData.funding);
  const taSummary          = buildTASummaryText(marketData.ta);
  const whaleSummary       = buildWhaleSummaryText(marketData.whale);
  const derivativesSummary = buildDerivativesSummaryText(marketData.derivatives);
  const onchainSummary     = buildOnchainSummaryText(marketData.onchain);
  const socialSummary      = buildSocialSummaryText(marketData.social);
  const activeTradesText   = buildActiveTradesText(activeTrades);
  const hasNews        = marketData.news?.length > 0;
  const hasFunding     = !!marketData.funding;
  const hasTA          = !!taSummary;
  const hasWhale       = !!whaleSummary;
  const hasDerivatives = !!derivativesSummary;
  const hasOnchain     = !!onchainSummary;
  const hasSocial      = !!socialSummary;
  const hasActive      = activeTrades.length > 0;

  const utcHour = new Date().getUTCHours();
  const next = getNextFundingInfo();

  const prompt = `<market_overview>
${marketSummary}
${fundingSummary}
${hasDerivatives ? derivativesSummary : ''}
${hasOnchain ? onchainSummary : ''}
${hasSocial ? socialSummary : ''}
${recentHistoryText}
Giờ UTC hiện tại: ${utcHour}:xx (lưu ý: 0-7h UTC = thanh khoản thấp)
</market_overview>

${hasTA ? `<technical_analysis>\n${taSummary}\n</technical_analysis>` : ''}
${hasWhale ? `<whale_flow>\n${whaleSummary}\n</whale_flow>` : ''}
${hasActive ? `<active_positions>\n${activeTradesText}\n</active_positions>` : ''}

<confluence_scores>
${scoresText || '(không có dữ liệu TA để tính điểm)'}
${signals369Text ? `\n${signals369Text}` : ''}
</confluence_scores>

<decision_instructions>
QUY TẮC PHÂN TÍCH:
1. Mở thẻ <thinking> để nháp và tính toán trước khi viết output:
   - Rà soát các coin đạt chuẩn điểm (Tier 1 ≥ 7đ, Tier 2 / Altcoin ≥ 8đ).
   - Đo khoảng cách ATR (1.5x ATR) và xác định vị trí S/R thực tế.
   - Tính toán R:R thực tế = |Target - Entry| / |Entry - SL|. Nếu R:R < 1.5 → loại bỏ, không ép lệnh.
   - Kiểm tra logic giá: LONG (SL < Entry < TP), SHORT (SL > Entry > TP).
2. Sau thẻ </thinking>, viết nội dung theo đúng cấu trúc Telegram HTML bên dưới.
3. Ở CUỐI CÙNG, BẮT BUỘC xuất thêm khối JSON (bọc trong \`\`\`json) để bot tự động trích xuất và thực thi lệnh.

CẤU TRÚC TELEGRAM HTML BẮT BUỘC:

<b>📊 Tổng quan thị trường</b>
• Xu hướng: [1 câu ngắn]
• Tâm lý: Fear&Greed <b>[value]</b> — [tên VN]
• BTC Dom: <b>[x.x]%</b> | ETH Dom: <b>[x.x]%</b>
• Vol 24h: [tăng/ổn định/giảm]
• Nổi bật: [coin dẫn dắt]
${hasNews ? '• Tin: [1 headline quan trọng nhất]' : ''}
${hasTA ? '• BTC: [TĂNG/GIẢM/SIDEWAY] — [lý do ngắn từ TA]' : ''}

<b>🎯 Lệnh giao dịch</b> <i>(R:R ≥ 1:2, max 5% vốn)</i>

Đòn bẩy: dùng MaxLev từ bảng điểm — đã tính từ ATR thực tế, KHÔNG được vượt quá.

${hasActive ? `[Với mỗi lệnh đang theo dõi, TRƯỚC TIÊN viết:]
✅ <b>GIỮ LỆNH [COIN] [DIRECTION]</b> — [1 câu lý do]
[hoặc đề xuất điều chỉnh TP/SL nếu thay đổi > 1.5%]

` : ''}[Với setup MỚI (nếu đủ điều kiện):]
🎯 <b>Setup [N]:</b> <i>Confluence: Xđ | Tin cậy: X%</i>
<code>[COIN] | [LONG/SHORT] | Vào: $[X] | Target: $[Y] (+[Z]%) | SL: $[W] (-[V]%) | Đòn bẩy: [N]x</code>
▸ TA: RSI 4h=[X] | MACD [trend] | EMA [stack] | BB %B=[X]%
▸ Volume [label]${hasTA ? ' | ATR ±[X]%/nến 4h' : ''}${hasWhale ? '\n▸ Whale: OKX [flow] | BN large [side] | Liq: [LONG/SHORT_SQUEEZE hoặc không có] → [XÁC NHẬN/PHÂN KỲ/KHÔNG CÓ DỮ LIỆU]' : ''}
▸ SL tại [S/R] $[level]${hasTA ? ' ≈ [n]x ATR (phải ≥ 1.5x ATR)' : ''}
▸ R:R thực tế: TP% / SL% = [X] (phải ≥ 1.5 — nếu không đủ thì BỎ coin này)
▸ Điều kiện lọc: EMA200D=[above/below] | Funding=[X%/8h] | BB BW=[X%]
▸ <b>Lý do:</b> [tại sao coin này, tại sao thời điểm này]

[Nếu KHÔNG đủ điều kiện cho coin nào:]
⛔ <b>Không đủ tín hiệu để vào lệnh mới.</b>
⏳ Chờ: [điều kiện cụ thể cần đáp ứng]

${hasFunding ? `<b>💸 Funding Arbitrage</b>
<i>Thanh toán tiếp: ${next.label}</i>

[Chỉ khuyến nghị nếu rate > 0.10%/8h — đủ bù phí và sinh lãi rõ ràng]
[Chọn 1 cơ hội tốt nhất, không viết nhiều:]

• <b>[COIN]</b> — rate <code>[+/-X.XXXX%]/8h</code>
  Chiều: [Short Futures + Long Spot / Long Futures + Short Spot]
  Thu: ~<code>[X.XXX%]</code>/kỳ sau phí ~0.10%

[BẮT BUỘC nếu khuyến nghị — thêm dòng machine-readable để bot theo dõi:]
<code>[COIN] | FUNDING | [SHORT_FUTURES/LONG_FUTURES] | Rate: [+/-X.XXXX%]/8h</code>

[Nếu không đủ điều kiện — viết:]
⛔ <b>Không đủ rate để khuyến nghị funding kỳ này</b>
(rate cao nhất: [X.XXXX%]/8h — thấp hơn ngưỡng 0.10%)` : ''}

<i>⚠️ Tham khảo, không phải lời khuyên đầu tư. Mỗi lệnh ≤5% vốn. Luôn đặt SL.</i>

ĐỊNH DẠNG KHỐI JSON MACHINE-READABLE (ĐẶT Ở CUỐI CÙNG):
\`\`\`json
{
  "trades": [
    {
      "symbol": "BTC",
      "direction": "LONG",
      "entryPrice": 91500.0,
      "targetPrice": 94500.0,
      "slPrice": 89800.0,
      "leverage": 15,
      "confluenceScore": 8,
      "confidence": 75,
      "reason": "Breakout cản 4H kèm Whale taker buy volume lớn"
    }
  ]
}
\`\`\`
(Nếu không có lệnh nào đạt chuẩn vào lệnh, để "trades": [])
</decision_instructions>`;

  const aiConfig = getAiConfig();
  if (aiConfig.provider === 'claude') {
    try {
      return await callClaude(prompt, 4096, aiConfig, SYSTEM_PROMPT);
    } catch (err) {
      if (aiConfig.geminiKey) {
        log.warn(`Claude thất bại [${err.message}] — Tự động fallback sang Google Gemini...`);
        return await callGemini(prompt, 4096, aiConfig.geminiKey, SYSTEM_PROMPT);
      }
      throw err;
    }
  } else {
    try {
      return await callGemini(prompt, 4096, aiConfig.geminiKey, SYSTEM_PROMPT);
    } catch (err) {
      if (aiConfig.claudeKey) {
        log.warn(`Gemini thất bại [${err.message}] — Tự động fallback sang Anthropic Claude...`);
        return await callClaude(prompt, 4096, aiConfig, SYSTEM_PROMPT);
      }
      throw err;
    }
  }
}

// ─── Gọi Claude API (Hỗ trợ Anthropic Native & OpenAI-compatible proxy) ───────
async function callClaude(prompt, maxTokens, aiConfig, systemPrompt = '') {
  const { claudeKey, claudeBaseUrl } = aiConfig;
  if (!claudeKey) throw new Error('Thiếu CLAUDE_API_KEY (hoặc ANTHROPIC_API_KEY) trong file .env');

  const models = CLAUDE_MODELS;
  let lastError = null;

  // Chuẩn hóa baseUrl: loại bỏ /v1 ở cuối nếu có để tiện ghép path
  const rootBaseUrl = claudeBaseUrl ? claudeBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') : '';
  const isOpenAiFormat = process.env.CLAUDE_API_FORMAT === 'openai' ||
    (claudeBaseUrl && claudeBaseUrl.includes('/chat/completions'));

  for (const model of models) {
    try {
      if (isOpenAiFormat) {
        // Format OpenAI-compatible (OneAPI, NewAPI, v.v.)
        const endpoint = claudeBaseUrl && claudeBaseUrl.endsWith('/chat/completions')
          ? claudeBaseUrl
          : `${rootBaseUrl}/v1/chat/completions`;
        const messages = [];
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const res = await axios.post(
          endpoint,
          {
            model,
            max_tokens: maxTokens,
            temperature: 0.2,
            messages,
          },
          {
            headers: {
              'Authorization': `Bearer ${claudeKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 60000,
          }
        );
        const text = res.data?.choices?.[0]?.message?.content?.trim();
        if (text && text.length >= (maxTokens > 1000 ? 200 : 20)) {
          log.ai(`Dùng Claude (${model}) qua proxy: ${endpoint}`);
          return { analysis: text, model: `Claude (${model})` };
        }
      } else {
        // Format Anthropic Native (/v1/messages)
        const endpoint = rootBaseUrl
          ? `${rootBaseUrl}/v1/messages`
          : 'https://api.anthropic.com/v1/messages';

        const payload = {
          model,
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        };
        if (systemPrompt) {
          payload.system = systemPrompt;
        }

        const res = await axios.post(
          endpoint,
          payload,
          {
            headers: {
              'x-api-key': claudeKey,
              'Authorization': `Bearer ${claudeKey}`,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 60000,
          }
        );
        const textBlock = Array.isArray(res.data?.content)
          ? res.data.content.find(c => c.type === 'text')
          : null;
        const text = textBlock ? textBlock.text?.trim() : res.data?.content?.[0]?.text?.trim();
        if (text && text.length >= (maxTokens > 1000 ? 200 : 20)) {
          log.ai(`Dùng Claude: ${model}`);
          return { analysis: text, model: `Claude (${model})` };
        }
      }
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      const status = err.response?.status ?? 'N/A';
      lastError = new Error(`Claude [${model}] lỗi [${status}]: ${detail}`);
      log.warn(`Claude [${model}] thất bại [${status}], thử model tiếp theo — ${detail}`);

      // Nếu dùng custom base URL và native Messages API bị lỗi, tự động fallback sang OpenAI-compatible
      if (rootBaseUrl && !isOpenAiFormat) {
        log.warn(`Claude endpoint /v1/messages bị lỗi [${status}], thử fallback sang /v1/chat/completions (OpenAI format)...`);
        try {
          const fallbackEndpoint = `${rootBaseUrl}/v1/chat/completions`;
          const messages = [];
          if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
          }
          messages.push({ role: 'user', content: prompt });

          const res = await axios.post(
            fallbackEndpoint,
            {
              model,
              max_tokens: maxTokens,
              temperature: 0.2,
              messages,
            },
            {
              headers: {
                'Authorization': `Bearer ${claudeKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 60000,
            }
          );
          const text = res.data?.choices?.[0]?.message?.content?.trim();
          if (text && text.length >= (maxTokens > 1000 ? 200 : 20)) {
            log.ai(`Dùng Claude (${model}) qua fallback OpenAI format: ${fallbackEndpoint}`);
            return { analysis: text, model: `Claude (${model})` };
          }
        } catch (e2) {
          log.warn(`Fallback OpenAI format cũng thất bại: ${e2.message}`);
        }
      }
    }
  }

  throw lastError ?? new Error('Tất cả Claude model đều thất bại');
}

// ─── Gọi Gemini API ──────────────────────────────────────────────────────────
async function callGemini(prompt, maxTokens, apiKey, systemPrompt = '') {
  if (!apiKey) throw new Error('Thiếu GEMINI_API_KEY trong file .env');
  let lastError;
  for (const model of GEMINI_MODELS) {
    let response;
    try {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      };
      if (systemPrompt) {
        payload.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
      response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        payload,
        { timeout: 60000 }
      );
    } catch (err) {
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.2,
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        { timeout: 60000 }
      );
    } catch (err) {
      const detail = err.response?.data?.error?.message ?? err.message;
      const status = err.response?.status ?? 'N/A';
      lastError = new Error(`Gemini [${model}] lỗi [${status}]: ${detail}`);
      log.warn(`Gemini [${model}] thất bại [${status}], thử model tiếp theo — ${detail}`);
      continue;
    }

    const analysis = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!analysis || analysis.length < (maxTokens > 1000 ? 200 : 20)) {
      const chars = analysis?.length ?? 0;
      lastError = new Error(`Gemini [${model}] trả về response ngắn (${chars} ký tự)`);
      log.warn(`Gemini [${model}] response quá ngắn (${chars} ký tự), thử model tiếp theo`);
      continue;
    }

    log.ai(`Dùng model: ${model}`);
    return { analysis, model };
  }

  throw lastError ?? new Error('Tất cả Gemini model đều thất bại');
}

/**
 * Phân tích nhanh 1 setup PP369 khi confluence đủ điểm.
 * Prompt ngắn — chỉ về coin đó, không phân tích toàn thị trường.
 * Trả về string HTML Telegram (2-4 câu).
 */
async function analyze369Setup(sig, marketData) {
  const ta = marketData?.ta?.[sig.symbol];
  const sc = sig.score;

  const fp = (n) => {
    if (n == null) return 'N/A';
    if (n >= 10000) return `$${Math.round(n).toLocaleString('en-US')}`;
    if (n >= 1)     return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
    return `$${n.toFixed(6)}`;
  };
  const fn = (n, d = 2) => n != null ? n.toFixed(d) : 'N/A';

  const taLines = ta ? [
    `Giá: ${fp(ta.price)} | Trend 4h: ${ta.trend ?? 'N/A'} | Regime: ${ta.regime ?? 'N/A'}`,
    `RSI: 1h=${fn(ta.rsi?.['1h'])} | 4h=${fn(ta.rsi?.['4h'])} | 1d=${fn(ta.rsi?.['1d'])}`,
    `MACD 4h: ${ta.macd?.trend ?? 'N/A'} | ATR: ${fp(ta.atr)}`,
    ta.support?.length  ? `Hỗ trợ gần nhất: ${fp(ta.support[ta.support.length - 1])}` : '',
    ta.resistance?.length ? `Kháng cự gần nhất: ${fp(ta.resistance[0])}` : '',
  ].filter(Boolean).join('\n') : '(Không có dữ liệu TA)';

  const scoreLines = sc ? [
    `Confluence: ${sc.total}đ [${sc.verdict}]`,
    `TA=${sc.breakdown.ta} | Whale=${sc.breakdown.whale} | Deriv=${sc.breakdown.derivatives} | PP369=${sc.breakdown.pp369 ?? 0}`,
    sc.reasons?.length ? `Lý do: ${sc.reasons.join(' | ')}` : '',
  ].filter(Boolean).join('\n') : '';

  const prompt = `Bạn là quant trader. Xác nhận nhanh setup PP369 sau (2-4 câu):

${sig.symbol} → ${sig.signal} lần ${sig.touchCount + 1} tại ${fp(sig.targetLevel)}
Điều kiện: từ mốc ${fp(sig.condLevel)} (${sig.signal === 'LONG' ? 'Open level phía trên' : 'Close level phía dưới'})
Tháng: ${sig.month} | Open H1 đầu tháng: ${fp(sig.openPrice)} | Close H1: ${fp(sig.closePrice)} | Step: ${fp(sig.step)}

${scoreLines}

TA ${sig.symbol}:
${taLines}

Trả lời ngắn: setup có hợp lệ không? Rủi ro chính? Gợi ý TP/SL (nếu đủ dữ liệu).
Dùng HTML Telegram: chỉ <b>, <i>, <code>. Không dùng markdown, không xuống dòng thừa.`;

  const aiConfig = getAiConfig();
  if (aiConfig.provider === 'claude') {
    try {
      const res = await callClaude(prompt, 512, aiConfig);
      return res.analysis;
    } catch (err) {
      if (aiConfig.geminiKey) {
        log.warn(`Claude thất bại [${err.message}] — Tự động fallback sang Google Gemini...`);
        const res = await callGemini(prompt, 512, aiConfig.geminiKey);
        return res.analysis;
      }
      throw err;
    }
  } else {
    try {
      const res = await callGemini(prompt, 512, aiConfig.geminiKey);
      return res.analysis;
    } catch (err) {
      if (aiConfig.claudeKey) {
        log.warn(`Gemini thất bại [${err.message}] — Tự động fallback sang Anthropic Claude...`);
        const res = await callClaude(prompt, 512, aiConfig);
        return res.analysis;
      }
      throw err;
    }
  }
}

module.exports = { analyzeMarket, analyze369Setup };
