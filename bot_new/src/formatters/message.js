'use strict';

/**
 * Xây dựng các tin nhắn Telegram HTML từ dữ liệu thị trường đã thu thập
 *
 * Telegram hỗ trợ HTML tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
 * Giới hạn: 4096 ký tự / tin nhắn
 */

// ═══════════════════════════════════════════════════
// HẰNG SỐ GIAO DIỆN
// ═══════════════════════════════════════════════════

const DIVIDER = '━━━━━━━━━━━━━━━━';

// Emoji số thứ tự cho top 10
const RANK_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS - Format dữ liệu
// ═══════════════════════════════════════════════════

/**
 * Format số lớn sang đơn vị tiếng Việt (tỷ, nghìn tỷ)
 */
function formatBillion(num) {
  if (num === null || num === undefined) return '<i>N/A</i>';
  if (num >= 1e12) return `<b>$${(num / 1e12).toFixed(2)} nghìn tỷ</b>`;
  if (num >= 1e9) return `<b>$${(num / 1e9).toFixed(2)} tỷ</b>`;
  if (num >= 1e6) return `<b>$${(num / 1e6).toFixed(2)} triệu</b>`;
  return `<b>$${num.toFixed(2)}</b>`;
}

/**
 * Format giá coin với đúng số chữ số thập phân
 */
function formatPrice(num) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 10000) return `$${Math.round(num).toLocaleString('en-US')}`;
  if (num >= 1000) return `$${num.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
  if (num >= 1) return `$${num.toFixed(2)}`;
  if (num >= 0.001) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(8)}`;
}

/**
 * Format % thay đổi với dấu + hoặc -
 */
function formatPercent(num) {
  if (num === null || num === undefined) return 'N/A';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

/**
 * Chọn emoji phù hợp với mức độ thay đổi giá
 */
function changeEmoji(num) {
  if (!num && num !== 0) return '➡️';
  if (num >= 10) return '🚀';
  if (num >= 3) return '📈';
  if (num >= 0) return '🟢';
  if (num >= -3) return '📉';
  if (num >= -10) return '🔴';
  return '💥';
}

/**
 * Lấy emoji và màu sắc cho chỉ số Fear & Greed
 */
function getFearGreedStyle(value) {
  if (value <= 20) return { emoji: '😱', indicator: '🔴' };
  if (value <= 40) return { emoji: '😨', indicator: '🟠' };
  if (value <= 55) return { emoji: '😐', indicator: '🟡' };
  if (value <= 75) return { emoji: '😊', indicator: '🟢' };
  return { emoji: '🤑', indicator: '💚' };
}

/**
 * Tạo thanh tiến trình trực quan (10 blocks = 100%)
 */
function makeProgressBar(value, total = 100) {
  const filled = Math.min(10, Math.round((value / total) * 10));
  const empty = 10 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${value}/${total}`;
}

/**
 * Escape ký tự HTML đặc biệt trong nội dung động
 * Dùng cho: tên coin, tiêu đề tin tức, text từ API ngoài
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format ngày giờ tiếng Việt theo múi giờ VN (quan trọng trên server UTC).
 */
function formatDateTime(date = new Date()) {
  const tz = process.env.TIMEZONE || 'Asia/Ho_Chi_Minh';
  const fmt = new Intl.DateTimeFormat('vi-VN', {
    timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.weekday}, ${p.day}/${p.month}/${p.year} — ${p.hour}:${p.minute}`;
}

// ═══════════════════════════════════════════════════
// XÂY DỰNG TIN NHẮN
// ═══════════════════════════════════════════════════

// ─── HTML tag balancer for market message ────────────────────────────────────
// Telegram rejects messages with mismatched HTML tags. Since news titles/URLs
// from external APIs can occasionally contain raw HTML that slips through,
// this sanitizer fixes any nesting issues before sending.
function balanceTags(html) {
  const ALLOWED = new Set([
    'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
    'code', 'pre', 'a',
  ]);
  const stack = [];
  const out = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (match, slash, tag) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return match;
    if (slash) {
      const idx = stack.lastIndexOf(t);
      if (idx === -1) return '';
      let closing = '';
      while (stack.length > idx + 1) closing += `</${stack.pop()}>`;
      stack.pop();
      return closing + match;
    }
    stack.push(t);
    return match;
  });
  let tail = '';
  while (stack.length) tail += `</${stack.pop()}>`;
  return out + tail;
}

// ─── Funding Rate helpers ─────────────────────────────────────────────────────

function getNextFundingLabel() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const payHours = [0, 8, 16];
  const nextH = payHours.find(h => utcH < h);
  const nextUTC = nextH !== undefined
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextH))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0));
  const ms = nextUTC - now;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const vnHour = nextUTC.toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
  });
  return `${vnHour} (${h > 0 ? h + 'h' : ''}${m}m nữa)`;
}

/**
 * Section funding rate — hướng dẫn chiến lược delta-neutral thu phí.
 * Chỉ hiển thị top 1 dương cao nhất + top 1 âm lớn nhất.
 * Ngưỡng hòa vốn: ~0.033%/8h (phí round-trip 0.10% / 3 kỳ/ngày)
 * Nên vào khi: rate > 0.10%/8h để có lãi rõ ràng sau phí.
 */
function buildFundingSection(funding) {
  if (!funding) return '';

  const topPos = (funding.topPositive ?? []).filter(x => x.rate > 0);
  const topNeg = (funding.topNegative ?? []).filter(x => x.rate < 0);
  if (!topPos.length && !topNeg.length) return '';

  const nextLabel = getNextFundingLabel();
  const PROFITABLE = 0.001;  // 0.10%/8h — rõ ràng có lãi sau phí
  const BREAKEVEN  = 0.00033; // 0.033%/8h — mức hòa vốn tối thiểu

  let msg = `\n${DIVIDER}\n`;
  msg += `💸 <b>FUNDING RATE — THU PHÍ KHÔNG CẦN ĐOÁN GIÁ</b>\n`;
  msg += `${DIVIDER}\n`;
  msg += `🕐 Kỳ tiếp: <b>${nextLabel}</b>  <i>(3 kỳ/ngày: 7h · 15h · 23h VN)</i>\n\n`;

  // ── TOP 1 DƯƠNG ────────────────────────────────────────────────────────────
  if (topPos.length > 0) {
    const best     = topPos[0];
    const ratePct  = best.rate * 100;
    const daily    = best.rate * 3 * 100;
    const monthly  = daily * 30;
    const isProfitable = best.rate >= PROFITABLE;
    const isBreakeven  = best.rate >= BREAKEVEN;
    const badge = isProfitable ? '✅' : isBreakeven ? '〰️' : '⚠️';

    msg += `📈 <b>FUNDING DƯƠNG — ${best.symbol}</b>\n`;
    msg += `${badge} <code>+${ratePct.toFixed(4)}%/8h</code>`;
    msg += ` → <b>+${daily.toFixed(3)}%/ngày</b>`;
    if (isProfitable) msg += ` | ~<b>+${monthly.toFixed(1)}%/tháng</b>`;
    msg += '\n';

    if (isProfitable) {
      msg += `🎯 <b>Tỉ lệ thắng ~90%+</b> — không phụ thuộc hướng giá\n`;
      msg += `\n<b>Cách thực hiện (Binance):</b>\n`;
      msg += `① Mua <b>${best.symbol}</b> giao ngay  <i>(Spot)</i>\n`;
      msg += `② Short <b>${best.symbol}USDT Perpetual</b> cùng số lượng\n`;
      msg += `③ Giữ đến <b>${nextLabel.split(' ')[0]}</b> → nhận phí tự động\n`;
      msg += `④ Tiếp tục sang kỳ sau hoặc đóng khi rate < 0.05%/8h\n`;
      msg += `\n<i>Rủi ro: Rate đổi chiều bất ngờ trước kỳ thanh toán (hiếm trong 8h)</i>\n`;
    } else if (isBreakeven) {
      msg += `<i>Rate gần hòa vốn — chờ kỳ khác có rate cao hơn 0.10%/8h</i>\n`;
    } else {
      msg += `<i>Rate quá thấp, không đủ bù phí giao dịch — bỏ qua</i>\n`;
    }
  }

  // ── TOP 1 ÂM ───────────────────────────────────────────────────────────────
  if (topNeg.length > 0) {
    const worst    = topNeg[0];
    const ratePct  = Math.abs(worst.rate) * 100;
    const daily    = ratePct * 3;
    const isProfitable = Math.abs(worst.rate) >= PROFITABLE;

    msg += `\n📉 <b>FUNDING ÂM — ${worst.symbol}</b>\n`;
    const badge = isProfitable ? '✅' : '⚠️';
    msg += `${badge} <code>${(worst.rate * 100).toFixed(4)}%/8h</code>`;
    msg += ` → <b>+${daily.toFixed(3)}%/ngày</b> <i>(nếu vào đúng chiều)</i>\n`;

    if (isProfitable) {
      msg += `\n<b>Cách thực hiện:</b>\n`;
      msg += `① Long <b>${worst.symbol}USDT Perpetual</b>  <i>(Binance Futures)</i>\n`;
      msg += `② Short <b>${worst.symbol}</b> giao ngay cùng số lượng\n`;
      msg += `③ Cần tài khoản margin để short spot — phức tạp hơn funding dương\n`;
      msg += `<i>⚠️ Chỉ nên làm nếu đã quen chiến lược delta-neutral</i>\n`;
    } else {
      msg += `<i>Rate chưa đủ lãi — tham khảo thôi, không khuyến nghị vào</i>\n`;
    }
  }

  msg += `\n<i>💡 Ngưỡng nên vào: rate > 0.10%/8h · Phí round-trip ~0.10-0.15%</i>\n`;
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── Whale / dòng tiền lớn section ──────────────────────────────────────────

function fmtVol(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} tỷ`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} triệu`;
  return `$${(n / 1e3).toFixed(0)} nghìn`;
}

function buildWhaleSection(whale) {
  if (!whale) return '';

  const { takerFlow, binanceLarge, crossSignals } = whale;
  const hasFlow = Object.keys(takerFlow  || {}).length > 0;
  const hasBN   = Object.keys(binanceLarge || {}).length > 0;
  const hasCross = Object.keys(crossSignals || {}).length > 0;
  if (!hasFlow && !hasBN) return '';

  // Bias → nhãn tiếng Việt ngắn gọn
  const biasVi = {
    BUY_PRESSURE: 'ÁP LỰC MUA',
    SELL_PRESSURE: 'ÁP LỰC BÁN',
    NEUTRAL: 'Cân bằng',
    WHALE_BUY: 'CÁ VOI MUA',
    WHALE_SELL: 'CÁ VOI BÁN',
    WHALE_NEUTRAL: 'Trung tính',
  };
  const biasEmoji = {
    BUY_PRESSURE: '🟢', SELL_PRESSURE: '🔴', NEUTRAL: '⚪',
    WHALE_BUY: '🐋🟢', WHALE_SELL: '🐋🔴', WHALE_NEUTRAL: '🐋⚪',
  };
  const crossEmoji = {
    'XÁC NHẬN MUA':     '✅✅',
    'XÁC NHẬN BÁN':     '🛑🛑',
    'NGHIÊNG VỀ MUA':   '✅',
    'NGHIÊNG VỀ BÁN':   '🛑',
    'PHÂN KỲ/TRUNG TÍNH': '〰️',
  };

  let msg = `\n${DIVIDER}\n`;
  msg += `🐋 <b>DÒNG TIỀN CÁ VOI</b>\n`;
  msg += `${DIVIDER}\n`;
  msg += `<i>🔹 Large ≥$1M · 🐋 Whale ≥$5M · ⚡ Institution ≥$20M — tất cả tính signal</i>\n\n`;

  // OKX Taker Flow — áp lực mua/bán tổng thể
  if (hasFlow) {
    const lookback = Object.values(takerFlow)[0]?.lookbackHours ?? 4;
    msg += `📊 <b>Áp lực mua/bán tổng thể (Binance/OKX)</b> <i>(${lookback}h qua)</i>\n`;
    for (const [sym, f] of Object.entries(takerFlow)) {
      const bi = biasEmoji[f.bias] || '⚪';
      const label = biasVi[f.bias] || f.bias;
      const delta = f.buyPct - f.sellPct;
      const sign = delta >= 0 ? '+' : '';
      msg += `• <b>${sym}</b>: Mua <b>${f.buyPct.toFixed(1)}%</b> / Bán ${f.sellPct.toFixed(1)}%`;
      msg += ` ${bi} <b>${label}</b> (Δ${sign}${delta.toFixed(1)}%)\n`;
    }
    msg += '\n';
  }

  // Binance Futures lệnh lớn ≥$1M (tất cả tier tính điểm)
  if (hasBN) {
    const lookback = Object.values(binanceLarge)[0]?.lookbackHours ?? 4;
    msg += `💹 <b>Lệnh lớn Binance Futures ≥$1M</b> <i>(tất cả tier tính signal, ${lookback}h qua)</i>\n`;
    for (const [sym, d] of Object.entries(binanceLarge)) {
      const bi = biasEmoji[d.bias] || '⚪';
      const label = biasVi[d.bias] || d.bias;
      msg += `• <b>${sym}</b>: Mua <b>${fmtVol(d.buyVol)}</b> (${d.buyCount}L)`;
      msg += ` / Bán ${fmtVol(d.sellVol)} (${d.sellCount}L)`;
      msg += ` ${bi} <b>${label}</b>\n`;

      // Hiển thị tất cả tier có dữ liệu
      const ins = d.tiers?.INSTITUTION;
      const whl = d.tiers?.WHALE;
      const rl  = d.tiers?.RETAIL_LARGE;
      if (ins && (ins.buyVol + ins.sellVol) > 0) {
        msg += `  ⚡ Institution ≥$20M: M ${fmtVol(ins.buyVol)} / B ${fmtVol(ins.sellVol)}\n`;
      }
      if (whl && (whl.buyVol + whl.sellVol) > 0) {
        msg += `  🐋 Whale $5M-$20M: M ${fmtVol(whl.buyVol)} / B ${fmtVol(whl.sellVol)}\n`;
      }
      if (rl && (rl.buyVol + rl.sellVol) > 0) {
        msg += `  🔹 Large $1M-$5M: M ${fmtVol(rl.buyVol)} / B ${fmtVol(rl.sellVol)}\n`;
      }

      // Notable events: ưu tiên INSTITUTION/WHALE, fallback RETAIL_LARGE
      const notable = (d.notableEvents || []).slice(0, 3);
      const highTier = notable.filter(e => e.tier !== 'RETAIL_LARGE');
      const display  = highTier.length ? highTier.slice(0, 2) : notable.slice(0, 2);
      for (const ev of display) {
        const t = new Date(ev.ts).toLocaleTimeString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
        });
        const sideVi = ev.side === 'BUY' ? 'Mua' : 'Bán';
        const tierIcon = ev.tier === 'INSTITUTION' ? '⚡' : ev.tier === 'WHALE' ? '🐋' : '🔹';
        msg += `  ${tierIcon} <i>${sideVi} ${fmtVol(ev.notional)} [${ev.tier}] lúc ${t}</i>\n`;
      }
    }
    msg += '\n';
  }

  // Tín hiệu tổng hợp — ẩn khi tất cả đều TRUNG TÍNH (không có lệnh lớn)
  if (hasCross) {
    const NEUTRAL_VERDICTS = new Set(['TRUNG TÍNH', 'PHÂN KỲ/TRUNG TÍNH']);
    const allNeutral = Object.values(crossSignals).every(cs => NEUTRAL_VERDICTS.has(cs.verdict));
    if (!allNeutral) {
      msg += `🎯 <b>Kết luận tổng hợp</b>\n`;
      for (const [sym, cs] of Object.entries(crossSignals)) {
        if (NEUTRAL_VERDICTS.has(cs.verdict)) continue;
        const em = crossEmoji[cs.verdict] || '❓';
        msg += `• <b>${sym}</b>: ${em} <b>${cs.verdict}</b>`;
        msg += ` <i>(${cs.strength}/${cs.total} nguồn đồng thuận)</i>\n`;
      }
      msg += `<i>✅✅ = tín hiệu mạnh nhất | 〰️ = phân kỳ, chờ xác nhận</i>\n`;
    }
  }

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── Derivatives section (OI trend + Long/Short ratio) ───────────────────────

function buildDerivativesSection(derivatives) {
  if (!derivatives || !Object.keys(derivatives).length) return '';

  // Chỉ hiển thị BTC và ETH để tránh spam
  const SHOW = ['BTC', 'ETH'];
  const entries = Object.entries(derivatives).filter(([s]) => SHOW.includes(s));
  if (!entries.length) return '';

  const fn = (n, d = 1) => n != null ? n.toFixed(d) : 'N/A';

  let msg = `\n${DIVIDER}\n`;
  msg += `📐 <b>DERIVATIVES — OI &amp; LONG/SHORT</b>\n`;
  msg += `${DIVIDER}\n`;
  msg += `<i>OI trend + định vị retail vs smart money (Binance)</i>\n\n`;

  for (const [sym, d] of entries) {
    msg += `<b>${sym}</b>  `;

    if (d.oi) {
      const sign  = d.oi.changePct >= 0 ? '+' : '';
      const tEmoji = d.oi.trend === 'RISING' ? '📈' : d.oi.trend === 'FALLING' ? '📉' : '➡️';
      msg += `OI $${fn(d.oi.current, 0)}M ${tEmoji}<b>${sign}${fn(d.oi.changePct)}%</b>`;
    }

    if (d.retail) {
      const r = d.retail;
      const signal = d.lsSignal?.contrarian;
      const badge  = signal === 'CONTRARIAN_LONG'  ? ' 🟢<i>contrarian long</i>' :
                     signal === 'CONTRARIAN_SHORT' ? ' 🔴<i>contrarian short</i>' : '';
      msg += `  |  L/S Retail: <b>${fn(r.longPct)}%</b>/${fn(r.shortPct)}%${badge}`;
    }

    if (d.topTrader && d.lsSignal?.divergence) {
      const t = d.topTrader;
      msg += `\n  ⚡ <i>Top trader: ${fn(t.longPct)}% long ← phân kỳ vs retail</i>`;
    }

    msg += '\n';
  }

  return msg;
}

// ─── On-chain section (BTC mempool + fees) ───────────────────────────────────

function buildOnchainSection(onchain) {
  if (!onchain) return '';
  const { mempool, fees, stats } = onchain;
  if (!mempool && !fees) return '';

  let msg = `\n${DIVIDER}\n`;
  msg += `⛓ <b>BTC ON-CHAIN</b> <i>(mempool.space)</i>\n`;
  msg += `${DIVIDER}\n\n`;

  if (mempool) {
    const emoji = mempool.congestion === 'EXTREME' ? '🔴' :
                  mempool.congestion === 'HIGH'    ? '🟠' :
                  mempool.congestion === 'MEDIUM'  ? '🟡' : '🟢';
    msg += `${emoji} Mempool: <b>${(mempool.count / 1000).toFixed(1)}K TX</b> chờ xác nhận`;
    if (mempool.congestion === 'EXTREME') msg += ` — <b>TẮC NGHẼN NẶNG</b>`;
    else if (mempool.congestion === 'HIGH') msg += ` — Đông đúc`;
    msg += '\n';
  }

  if (fees) {
    const emoji = fees.signal === 'CONGESTED' ? '🔴' :
                  fees.signal === 'ACTIVE'    ? '🟠' :
                  fees.signal === 'NORMAL'    ? '🟡' : '🟢';
    msg += `${emoji} Fee: <code>${fees.fast}</code> | <code>${fees.medium}</code> | <code>${fees.slow}</code> sat/vB <i>(nhanh/30m/1h)</i>\n`;
  }

  if (stats?.txCount24h) {
    msg += `📊 TX 24h: <b>${(stats.txCount24h / 1000).toFixed(1)}K</b>`;
    if (stats.hashrateEH) msg += `  |  Hashrate: <b>${stats.hashrateEH} EH/s</b>`;
    msg += '\n';
  }

  return msg;
}

// ─── Social sentiment section (Reddit) ───────────────────────────────────────

function buildSocialSection(social) {
  if (!social) return '';

  const emoji = social.sentiment === 'BULLISH' ? '🟢' :
                social.sentiment === 'BEARISH' ? '🔴' : '🟡';
  const label = social.sentiment === 'BULLISH' ? 'Lạc quan' :
                social.sentiment === 'BEARISH' ? 'Bi quan'  : 'Trung tính';

  let msg = `\n${DIVIDER}\n`;
  msg += `💬 <b>SOCIAL SENTIMENT</b> <i>(Reddit, ${social.totalPosts} posts)</i>\n`;
  msg += `${DIVIDER}\n\n`;
  msg += `${emoji} <b>${label}</b>  🟢 ${social.bullishPct}% bull · 🔴 ${social.bearishPct}% bear\n`;

  if (social.hotMentions?.length) {
    msg += `🔥 Được nhắc nhiều: <b>${social.hotMentions.slice(0, 4).join(', ')}</b>\n`;
  }

  if (social.topPosts?.length) {
    const top = social.topPosts[0];
    const title = top.title.length > 70 ? top.title.slice(0, 67) + '...' : top.title;
    msg += `📌 <i>${escapeHtml(title)}</i>\n`;
  }

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tin nhắn 1: Dữ liệu thị trường
 * Bao gồm: tổng quan, Fear & Greed, top 10 coins, gainers, losers, dòng tiền cá voi, funding, tin tức
 */
function buildMarketMessage(data) {
  const { globalMarket, topCoins, topGainers, topLosers, fearGreed, news, whale,
          derivatives, onchain, social } = data;
  const now = formatDateTime();
  const fg = getFearGreedStyle(fearGreed?.value ?? 50);

  let msg = '';

  // ── Header ──────────────────────────────────────
  msg += `🌐 <b>BẢN TIN THỊ TRƯỜNG CRYPTO</b>\n`;
  msg += `📅 <i>${now}</i>\n`;

  // ── Tổng quan thị trường ────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `📊 <b>TỔNG QUAN THỊ TRƯỜNG TOÀN CẦU</b>\n`;
  msg += `${DIVIDER}\n\n`;

  if (globalMarket) {
    const mktEmoji = (globalMarket.marketCapChange24h ?? 0) >= 0 ? '📈' : '📉';
    msg += `💰 Tổng vốn hóa: ${formatBillion(globalMarket.totalMarketCap)} `;
    msg += `${mktEmoji} <b>${formatPercent(globalMarket.marketCapChange24h)}</b>\n`;
    msg += `📊 Khối lượng giao dịch 24h: ${formatBillion(globalMarket.totalVolume24h)}\n`;
    msg += `👑 Thị phần BTC: <b>${globalMarket.btcDominance?.toFixed(1) ?? 'N/A'}%</b>\n`;
    msg += `🔷 Thị phần ETH: <b>${globalMarket.ethDominance?.toFixed(1) ?? 'N/A'}%</b>\n`;
    msg += `🎯 Số coin đang hoạt động: <b>${globalMarket.activeCryptos?.toLocaleString() ?? 'N/A'}</b>\n`;
  } else {
    msg += '<i>Không lấy được dữ liệu thị trường toàn cầu</i>\n';
  }

  // ── Fear & Greed ────────────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `${fg.emoji} <b>TÂM LÝ THỊ TRƯỜNG — SỢ HÃI &amp; THAM LAM</b>\n`;
  msg += `${DIVIDER}\n\n`;

  if (fearGreed) {
    msg += `${fg.indicator} <b>${fearGreed.value}/100 — ${fearGreed.classificationVi}</b>\n`;
    msg += `<code>${makeProgressBar(fearGreed.value)}</code>\n`;
    msg += `<i>0=Sợ hãi cực độ → 100=Tham lam cực độ</i>\n`;
  } else {
    msg += '<i>Không có dữ liệu</i>\n';
  }

  // ── Top 10 Coins ────────────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `🏆 <b>TOP 10 COIN THEO VỐN HÓA</b>\n`;
  msg += `${DIVIDER}\n\n`;

  if (topCoins?.length > 0) {
    topCoins.forEach((coin, i) => {
      const rank = RANK_EMOJIS[i] ?? `${i + 1}.`;
      const arrow = changeEmoji(coin.change24h);
      msg += `${rank} <b>${escapeHtml(coin.symbol)}</b>  ${formatPrice(coin.price)}  ${arrow} <b>${formatPercent(coin.change24h)}</b>\n`;
    });
  } else {
    msg += '<i>Không có dữ liệu</i>\n';
  }

  // ── Top Gainers ─────────────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `📈 <b>TOP 5 TĂNG MẠNH NHẤT (24H)</b>\n`;
  msg += `${DIVIDER}\n\n`;

  if (topGainers?.length > 0) {
    topGainers.forEach((coin) => {
      msg += `🚀 <b>${escapeHtml(coin.symbol)}</b>  <b>${formatPercent(coin.change24h)}</b>  <i>${formatPrice(coin.price)}</i>\n`;
    });
  } else {
    msg += '<i>Không có dữ liệu</i>\n';
  }

  // ── Top Losers ──────────────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `📉 <b>TOP 5 GIẢM MẠNH NHẤT (24H)</b>\n`;
  msg += `${DIVIDER}\n\n`;

  if (topLosers?.length > 0) {
    topLosers.forEach((coin) => {
      msg += `💥 <b>${escapeHtml(coin.symbol)}</b>  <b>${formatPercent(coin.change24h)}</b>  <i>${formatPrice(coin.price)}</i>\n`;
    });
  } else {
    msg += '<i>Không có dữ liệu</i>\n';
  }

  // ── Derivatives (OI trend + L/S ratio) ─────────
  msg += buildDerivativesSection(derivatives);

  // ── BTC On-chain ────────────────────────────────
  msg += buildOnchainSection(onchain);

  // ── Social Sentiment ────────────────────────────
  msg += buildSocialSection(social);

  // ── Dòng tiền cá voi ────────────────────────────
  msg += buildWhaleSection(whale);

  // ── Footer ──────────────────────────────────────
  msg += `\n${DIVIDER}\n`;
  msg += `⏰ <i>Cập nhật: ${now}</i>`;

  return balanceTags(msg);
}

/**
 * Convert AI-generated text (HTML or Markdown) to Telegram-compatible HTML.
 *
 * Telegram only supports: <b>, <strong>, <i>, <em>, <u>, <ins>, <s>, <strike>,
 * <del>, <code>, <pre>, <a href="">, <blockquote>, <tg-emoji>, <tg-spoiler>
 * Named entities: only &amp; &lt; &gt; &quot; and numeric &#N; are supported.
 *
 * Pipeline:
 *   A. Extract code blocks → placeholders (escape < > & inside content)
 *   B. Convert Markdown → HTML (headers, bold, italic, lists)
 *   C. Normalize HTML structure (strip/convert unsupported tags)
 *   D. Convert unsupported named entities → UTF-8 chars
 *   E. Escape bare & remaining
 *   F. Restore code block placeholders
 *   G. Stack-based tag balancer (orphan closing → remove, unclosed → auto-close)
 */
function sanitizeAiHtml(text) {
  if (!text) return '';

  let s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Phase A: Extract code blocks into placeholders ───────────────────────────
  // Protects code content from markdown processing and escapes dangerous chars.
  // Uses null-byte markers that cannot appear in normal AI output.
  const codeBlocks = [];
  const MARKER = '\x00K';

  function storeBlock(content, isBlock) {
    const idx = codeBlocks.length;
    codeBlocks.push({ content, isBlock });
    return `${MARKER}${idx}\x00`;
  }

  function escapeInCode(raw) {
    return raw
      .replace(/&(?!(amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);)/gi, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Fenced markdown code blocks: ```lang\ncode\n```
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    storeBlock(escapeInCode(code.trim()), true)
  );

  // HTML <pre> blocks (extract before <code> to handle <pre><code>...</code></pre>)
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) =>
    storeBlock(escapeInCode(inner.replace(/<\/?code[^>]*>/gi, '').trim()), true)
  );

  // Inline backtick: `code`
  s = s.replace(/`([^`\n]+)`/g, (_, code) =>
    storeBlock(escapeInCode(code), false)
  );

  // HTML <code> inline (paired only — orphan tags handled in Phase C)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) =>
    storeBlock(escapeInCode(inner), false)
  );

  // ── Phase B: Markdown → HTML ─────────────────────────────────────────────────
  s = s
    // Headers: # Title → <b>Title</b>
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    // Bold: **text** or __text__
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
    // Italic: *text* — require non-word chars at boundaries to avoid false positives
    .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<i>$1</i>')
    // Italic: _text_ — only at non-word boundaries (avoids snake_case)
    .replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, '<i>$1</i>')
    // Unordered list items: - item, * item, + item
    .replace(/^[ \t]*[-*+]\s+(.+)$/gm, '• $1');

  // ── Phase C: HTML structural cleanup ─────────────────────────────────────────
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '<b>$1</b>\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '• $1\n')
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/?(?:div|span|section|article|header|footer|main|aside|nav|table|thead|tbody|tr|td|th|caption|figure|figcaption)[^>]*>/gi, '');

  // Strip all remaining disallowed tags (code/pre already extracted to placeholders)
  s = s.replace(/<(?!\/?(?:b|strong|i|em|u|ins|s|strike|del|a|blockquote|tg-emoji|tg-spoiler)\b)[^>]+>/gi, '');

  // Strip unsupported attributes from allowed inline tags
  s = s.replace(/<(b|strong|i|em|u|ins|s|strike|del|blockquote)\s[^>]*>/gi, '<$1>');

  // Normalize <a>: keep only href; remove <a> with no href
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>/gi, '<a href="$1">');
  s = s.replace(/<a(?!\s*href=)[^>]*>/gi, '');

  // ── Phase D: Named entity → UTF-8 (Telegram rejects all named entities except
  //   &amp; &lt; &gt; &quot; — everything else must be a real Unicode character) ──
  const HTML_ENTITIES = {
    '&nbsp;': ' ',    '&mdash;': '—',   '&ndash;': '–',   '&hellip;': '…',
    '&laquo;': '«',  '&raquo;': '»',
    '&rsquo;': '’', '&lsquo;': '‘',
    '&rdquo;': '”', '&ldquo;': '“',
    '&times;': '×',  '&divide;': '÷',  '&plusmn;': '±',
    '&bull;': '•',   '&middot;': '·',
    '&copy;': '©',   '&reg;': '®',     '&trade;': '™',
    '&euro;': '€',   '&pound;': '£',   '&yen;': '¥',     '&cent;': '¢',
    '&deg;': '°',
    '&rarr;': '→',   '&larr;': '←',   '&uarr;': '↑',   '&darr;': '↓',
    '&infin;': '∞',  '&alpha;': 'α',   '&beta;': 'β',
    '&gamma;': 'γ',  '&delta;': 'δ',   '&mu;': 'μ',
    '&sigma;': 'σ',  '&pi;': 'π',
  };
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    s = s.split(entity).join(char);
  }

  // ── Phase E: Escape bare & ────────────────────────────────────────────────────
  s = s.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/gi, '&amp;');

  // ── Phase F: Whitespace cleanup ───────────────────────────────────────────────
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  // ── Phase G: Restore code block placeholders ──────────────────────────────────
  s = s.replace(new RegExp(`${MARKER}(\\d+)\x00`, 'g'), (_, idx) => {
    const { content, isBlock } = codeBlocks[parseInt(idx, 10)];
    return isBlock ? `<pre><code>${content}</code></pre>` : `<code>${content}</code>`;
  });

  // ── Phase H: Stack-based HTML tag balancer ────────────────────────────────────
  // Orphaned closing tag (no matching open) → remove
  // Unclosed opening tag at end → auto-close in reverse order
  const ALLOWED = new Set([
    'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
    'code', 'pre', 'a', 'blockquote', 'tg-emoji', 'tg-spoiler',
  ]);
  const stack = [];
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g, (match, slash, tag) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (slash) {
      const idx = stack.lastIndexOf(t);
      if (idx === -1) return '';
      let closing = '';
      while (stack.length > idx + 1) closing += `</${stack.pop()}>`;
      stack.pop();
      return closing + match;
    }
    stack.push(t);
    return match;
  });
  while (stack.length > 0) s += `</${stack.pop()}>`;

  return s;
}

/**
 * Tin nhắn 2: Phân tích AI từ Gemini
 * Nội dung AI đã được format HTML, chỉ thêm header/footer
 */
function buildAnalysisMessage(analysisText, modelName) {
  const now = formatDateTime();
  const safeText = sanitizeAiHtml(analysisText);
  const isClaude = /claude/i.test(modelName || '');
  const isGemini = /gemini/i.test(modelName || '');
  const aiTitle = isClaude ? 'CLAUDE AI' : isGemini ? 'AI GEMINI' : 'AI ANALYSIS';
  const modelLabel = modelName ? modelName : (isClaude ? 'Anthropic Claude' : 'Google Gemini');

  let msg = `🤖 <b>PHÂN TÍCH THỊ TRƯỜNG — ${aiTitle}</b>\n`;
  msg += `${DIVIDER}\n\n`;
  msg += safeText;
  msg += `\n\n${DIVIDER}\n`;
  msg += `🕐 <i>Phân tích lúc ${now}</i>\n`;
  msg += `💡 <i>Powered by ${modelLabel}</i>`;

  return msg;
}

module.exports = {
  buildMarketMessage,
  buildAnalysisMessage,
  buildFundingSection,
  formatBillion,
  formatPrice,
  formatPercent,
  escapeHtml,
  formatDateTime
};
