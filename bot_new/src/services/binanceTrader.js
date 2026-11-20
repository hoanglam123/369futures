'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { log } = require('./logger');

const BASE_URL       = 'https://fapi.binance.com';
const API_KEY        = process.env.BINANCE_API_KEY    || '';
const API_SECRET     = process.env.BINANCE_API_SECRET || '';
const TRADE_ENABLED  = process.env.TRADE_ENABLED === 'true';
const TRADE_SIZE_PCT    = parseFloat(process.env.TRADE_SIZE_PCT  || '5');
const TRADE_MAX_USDT    = parseFloat(process.env.TRADE_MAX_USDT  || '200');
const TRADE_MIN_USDT    = parseFloat(process.env.TRADE_MIN_USDT  || '5');
const MIN_NOTIONAL_USDT = parseFloat(process.env.MIN_NOTIONAL_USDT || '5');   // Lệnh tối thiểu $5
const BALANCE_THRESHOLD = parseFloat(process.env.BALANCE_THRESHOLD || '0');  // Ngưỡng balance: mặc định 0 để luôn tính % (lãi kép)
const FLAT_TRADE_USDT   = parseFloat(process.env.FLAT_TRADE_USDT || '20');   // Fallback flat khi không dùng %

// Cache thông tin precision của từng symbol (tránh gọi exchangeInfo lặp lại)
const symbolInfoCache = new Map();

function isEnabled() {
  return TRADE_ENABLED && !!API_KEY && !!API_SECRET;
}

function sign(qs) {
  return crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
}

let timeOffset = 0;

async function syncTimeOffset() {
  try {
    const t0 = Date.now();
    const res = await axios.get(`${BASE_URL}/fapi/v1/time`, { timeout: 5000 });
    const t1 = Date.now();
    const serverTime = res.data.serverTime;
    timeOffset = Math.round(serverTime - (t0 + t1) / 2);
  } catch {}
}

syncTimeOffset().catch(() => {});
setInterval(() => syncTimeOffset().catch(() => {}), 3 * 60 * 1000);

// Gọi Binance Futures API (signed request)
async function api(method, path, params = {}, attempt = 0) {
  const timestamp = Date.now() + timeOffset;
  const allParams = { ...params, timestamp, recvWindow: 30000 };
  const qs  = new URLSearchParams(allParams).toString();
  const url = `${BASE_URL}${path}?${qs}&signature=${sign(qs)}`;
  try {
    const { data } = await axios({ method, url, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 10000 });
    return data;
  } catch (err) {
    const code = err.response?.data?.code;
    const msg = err.response?.data?.msg || err.message;
    if ((code === -1021 || (typeof msg === 'string' && msg.includes('recvWindow'))) && attempt < 2) {
      await syncTimeOffset();
      return await api(method, path, params, attempt + 1);
    }
    throw new Error(`Binance API [${method} ${path}]: ${msg}`);
  }
}

// Lấy quantityPrecision & pricePrecision cho symbol (cached).
// Trả về null nếu symbol không tồn tại trên Binance Futures (đã bị hủy niêm yết, v.v.)
// BUG FIX: chỉ cache symbol baseAsset+USDT (vd BTCUSDT) để tránh overwrite bởi
// các contract khác cùng baseAsset (BTCUSD1, BTCUSDT_260626) có precision khác nhau.
async function getSymbolInfo(symbol) {
  if (symbolInfoCache.has(symbol)) return symbolInfoCache.get(symbol);
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`, { timeout: 10000 });
  for (const s of data.symbols) {
    if (s.symbol !== `${s.baseAsset}USDT`) continue;
    const lotSize        = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    const priceFilter    = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    symbolInfoCache.set(s.baseAsset, {
      quantityPrecision: s.quantityPrecision,
      pricePrecision:    s.pricePrecision,
      stepSize:          lotSize ? parseFloat(lotSize.stepSize) : null,
      minQty:            lotSize ? parseFloat(lotSize.minQty) : null,
      minNotional:       notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional || 0) : null,
      tickSize:          priceFilter ? parseFloat(priceFilter.tickSize) : null,
    });
  }
  return symbolInfoCache.get(symbol) || null;
}

// Cache balance 1 phút — Binance API chỉ được gọi 1 lần/phút
let _balanceCache = { value: 0, fetchedAt: 0 };
const BALANCE_CACHE_MS = 60_000;

async function getUsdtBalance() {
  const now = Date.now();
  if (_balanceCache.fetchedAt > 0 && now - _balanceCache.fetchedAt < BALANCE_CACHE_MS) {
    return _balanceCache.value;
  }
  const balances = await api('GET', '/fapi/v2/balance');
  const usdt = (Array.isArray(balances) ? balances : []).find(b => b.asset === 'USDT');
  const avail = parseFloat(usdt?.availableBalance || '0');
  const isFirst = _balanceCache.fetchedAt === 0;
  _balanceCache = { value: avail, fetchedAt: now };
  if (isFirst && API_KEY) {
    log.system(`[BinanceTrader] 💼 Binance Account bot-new: Key=***${API_KEY.slice(-4)} | Available Balance: $${avail.toFixed(2)} USDT`);
  }
  return _balanceCache.value;
}

// Xóa cache ngay sau khi đặt lệnh để lần calcQty kế tiếp lấy balance mới
function _invalidateBalanceCache() {
  _balanceCache.fetchedAt = 0;
}

// Tính số lượng coin cần mua/bán
// - Hỗ trợ targetMargin từ trade.margin (Tier setup) hoặc TRADE_SIZE_PCT % balance
// - Capped trong [TRADE_MIN_USDT, TRADE_MAX_USDT] hoặc targetMargin
// - Đảm bảo thỏa mãn cả minNotional VÀ minQty/stepSize (tránh lỗi floor về 0 trên BTC/ETH giá cao)
async function calcQty(symbol, entryPrice, leverage, info, targetMargin = null, overrideBalance = null) {
  const balance = (overrideBalance !== null && overrideBalance !== undefined)
    ? overrideBalance
    : await getUsdtBalance();

  let sizeUsdt;
  if (typeof targetMargin === 'number' && targetMargin > 0) {
    sizeUsdt = Math.min(targetMargin, balance);
  } else if (balance > BALANCE_THRESHOLD && TRADE_SIZE_PCT > 0) {
    const rawSize = (balance * TRADE_SIZE_PCT) / 100;
    sizeUsdt = Math.min(Math.max(rawSize, TRADE_MIN_USDT), TRADE_MAX_USDT, balance);
  } else {
    sizeUsdt = Math.min(FLAT_TRADE_USDT, balance);
  }

  const step = info?.stepSize || Math.pow(10, -(info?.quantityPrecision || 3));
  const minQty = Math.max(info?.minQty || 0, step);
  const minNotionalFilter = info?.minNotional || MIN_NOTIONAL_USDT;
  // Binance Futures yêu cầu cả 2 điều kiện: notional >= minNotional VÀ qty >= minQty
  // Với coin giá cao như BTC (~62k-100k), 1 lot tối thiểu (0.001 BTC) đòi hỏi notional ~$62-100!
  const minRequiredNotional = Math.max(minNotionalFilter, minQty * entryPrice);

  let notional = sizeUsdt * leverage;
  if (notional < minRequiredNotional) {
    // Tự động nâng margin lên mức tối thiểu đủ đặt 1 lot nếu balance cho phép
    const neededMargin = Math.ceil((minRequiredNotional / leverage) * 100) / 100;
    if (neededMargin <= balance) {
      sizeUsdt = neededMargin;
      notional = sizeUsdt * leverage;
    } else {
      log.warn(`calcQty: số dư $${balance.toFixed(2)} USDT không đủ margin tối thiểu $${neededMargin.toFixed(2)} USDT (cần notional $${minRequiredNotional.toFixed(2)} cho ${symbol})`);
      return { qty: 0, sizeUsdt, balance };
    }
  }

  const rawQty = notional / entryPrice;
  const floored = Math.floor(rawQty / step) * step;
  const decimals = step.toString().includes('.') ? step.toString().split('.')[1].length : 0;
  let qty = parseFloat(floored.toFixed(decimals));

  // Nếu sau khi floor bị nhỏ hơn minQty nhưng balance đủ ký quỹ cho 1 minQty
  if (qty < minQty) {
    const minQtyNotional = minQty * entryPrice;
    const minQtyMargin = Math.ceil((minQtyNotional / leverage) * 100) / 100;
    if (minQtyMargin <= balance) {
      qty = parseFloat(minQty.toFixed(decimals));
      sizeUsdt = Math.max(sizeUsdt, minQtyMargin);
    }
  }

  // Bảo đảm notional sau khi làm tròn không bị hụt dưới minNotionalFilter sàn (tránh lỗi Binance notional < 20)
  if (qty > 0 && (qty * entryPrice) < minNotionalFilter) {
    qty = parseFloat((qty + step).toFixed(decimals));
    sizeUsdt = Math.ceil(((qty * entryPrice) / leverage) * 100) / 100;
  }

  return { qty, sizeUsdt, balance };
}

/**
 * Đặt lệnh entry mới trên Binance Futures:
 * 1. Set đòn bẩy
 * 2. Tính qty theo TRADE_SIZE_PCT % balance
 * 3. Đặt LIMIT entry order
 * SL + TP2 sẽ được đặt tự động qua WebSocket khi entry fill (xem tradeMonitor.initBinanceStream)
 * Kết quả được ghi trực tiếp vào trade object (binanceEntryOrderId, binanceQty)
 */
async function placeNewTrade(trade) {
  if (!isEnabled()) return null;
  const { symbol, direction, entryPrice, slPrice, leverage = 10 } = trade;

  log.trade(`BINANCE: bắt đầu đặt lệnh ${symbol} ${direction} entry=${entryPrice} sl=${slPrice} x${leverage}`);
  try {
    const info = await getSymbolInfo(symbol);
    if (!info) {
      log.warn(`BINANCE: ${symbol}USDT không được hỗ trợ trên Binance Futures (đã hủy niêm yết?)`);
      return { symbolNotSupported: true };
    }

    // 1. Đặt đòn bẩy
    await api('POST', '/fapi/v1/leverage', { symbol: `${symbol}USDT`, leverage });

    // 2. Tính qty (hỗ trợ targetMargin từ trade.margin hoặc tự bump cho coin giá cao như BTC)
    const { qty, sizeUsdt, balance } = await calcQty(symbol, entryPrice, leverage, info, trade.margin);
    if (qty <= 0) {
      const minStep = info?.minQty || info?.stepSize || 0.001;
      const minLotCost = ((minStep * entryPrice) / leverage).toFixed(2);
      log.warn(`BINANCE: balance không đủ cho ${symbol} — balance=${balance.toFixed(2)} USDT, cần tối thiểu margin ~$${minLotCost} USDT (x${leverage})`);
      return { insufficientBalance: true, balance, sizeUsdt };
    }

    // Validate SL direction trước khi đặt bất kỳ order nào.
    // Nếu sai chiều → Binance sẽ reject SL sau khi entry đã vào → vị thế không có protection.
    const isLong = direction === 'LONG';
    if (!slPrice || !entryPrice) {
      log.warn(`BINANCE: slPrice hoặc entryPrice null cho ${symbol} — hủy`);
      return null;
    }
    const slFmt  = parseFloat(slPrice.toFixed(info.pricePrecision));
    const entFmt = parseFloat(entryPrice.toFixed(info.pricePrecision));
    if (isLong && slFmt >= entFmt) {
      log.error(`BINANCE: SL ${slFmt} >= entry ${entFmt} cho LONG — hủy, không đặt lệnh`);
      return null;
    }
    if (!isLong && slFmt <= entFmt) {
      log.error(`BINANCE: SL ${slFmt} <= entry ${entFmt} cho SHORT — hủy, không đặt lệnh`);
      return null;
    }

    // 3. Đặt LIMIT entry order (SL sẽ được đặt sau khi fill qua WebSocket)
    const entrySide  = isLong ? 'BUY' : 'SELL';
    const entryOrder = await api('POST', '/fapi/v1/order', {
      symbol:      `${symbol}USDT`,
      side:        entrySide,
      type:        'LIMIT',
      timeInForce: 'GTC',
      quantity:    qty,
      price:       parseFloat(entryPrice.toFixed(info.pricePrecision)),
    });
    trade.binanceEntryOrderId = entryOrder.orderId != null ? String(entryOrder.orderId) : null;
    trade.binanceQty          = qty;
    log.trade(`BINANCE: entry LIMIT OK ${symbol} ${direction}`, { orderId: entryOrder.orderId, qty, price: entryPrice });

    _invalidateBalanceCache(); // balance đã thay đổi sau khi đặt lệnh
    return { entryOrderId: trade.binanceEntryOrderId, qty, sizeUsdt, balance };
  } catch (err) {
    if (/TradFi|agreement/i.test(err.message)) {
      log.warn(`BINANCE: ${symbol} yêu cầu ký TradFi-Perps agreement — không retry cho đến khi ký`);
      return { agreementRequired: true };
    }
    log.error(`BINANCE: lỗi đặt lệnh ${symbol} ${direction}`, { error: err.message });
    return null;
  }
}

/**
 * Đặt lệnh Stop Market (SL) hoặc Take Profit Market (TP) với closePosition=true
 * thông qua Binance Futures /fapi/v1/algoOrder (chuẩn Portfolio Margin & Standard accounts).
 */
async function placeStopOrder(symbol, side, type, stopPrice) {
  if (!isEnabled()) return null;
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  const info = await getSymbolInfo(cleanSym);
  const pricePrecision = info?.pricePrecision ?? 4;
  const tickSize = info?.tickSize || (info?.pricePrecision ? Math.pow(10, -info.pricePrecision) : 0.01);

  let finalStopPriceStr;
  if (tickSize && tickSize > 0) {
    const roundedPrice = Math.round(stopPrice / tickSize) * tickSize;
    const dec = Math.max(0, Math.round(-Math.log10(tickSize)));
    finalStopPriceStr = roundedPrice.toFixed(dec);
  } else {
    finalStopPriceStr = stopPrice.toFixed(pricePrecision);
  }

  const res = await api('POST', '/fapi/v1/algoOrder', {
    algoType: 'CONDITIONAL',
    symbol: `${cleanSym}USDT`,
    side,
    type,
    triggerPrice: finalStopPriceStr,
    closePosition: 'true',
    positionSide: 'BOTH',
  });
  return res;
}

/**
 * Hủy lệnh Algo theo algoId.
 */
async function cancelAlgoOrder(symbol, algoId) {
  if (!isEnabled() || !algoId) return null;
  const cleanSym = (symbol || '').toUpperCase().replace(/USDT$/, '');
  return await api('DELETE', '/fapi/v1/algoOrder', { symbol: `${cleanSym}USDT`, algoId });
}

/**
 * Lấy danh sách lệnh Algo đang mở của 1 symbol (hoặc tất cả).
 */
async function getOpenAlgoOrders(symbol) {
  if (!isEnabled()) return [];
  const params = {};
  if (symbol) {
    const cleanSym = symbol.toUpperCase().replace(/USDT$/, '');
    params.symbol = `${cleanSym}USDT`;
  }
  return await api('GET', '/fapi/v1/openAlgoOrders', params);
}

/**
 * Đặt Hard STOP_MARKET SL trực tiếp lên Binance ngay sau khi Entry khớp.
 * Sử dụng /fapi/v1/algoOrder để bảo vệ vị thế 100% on-exchange.
 */
async function placeSLAfterFill(trade) {
  if (!isEnabled() || !trade) return null;
  const { symbol, direction, slPrice } = trade;
  if (!slPrice) {
    log.warn(`BINANCE: slPrice null cho ${symbol} — skip SL`);
    return null;
  }
  const slSide = direction === 'LONG' ? 'SELL' : 'BUY';
  try {
    const slRes = await placeStopOrder(symbol, slSide, 'STOP_MARKET', slPrice);
    const slOrderId = (slRes?.algoId != null ? String(slRes.algoId) : (slRes?.orderId != null ? String(slRes.orderId) : null));
    trade.binanceSlOrderId = slOrderId;
    log.trade(`BINANCE: Hard STOP_MARKET SL OK ${symbol}`, { algoId: slOrderId, slPrice });
    return slOrderId;
  } catch (err) {
    log.error(`BINANCE: lỗi đặt Hard STOP_MARKET SL ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Dời SL về entry price / hòa vốn (+1% phí) trực tiếp trên sàn Binance.
 * Atomic operation: Hủy algo SL cũ -> Đặt algo SL mới tại newSlPrice.
 */
async function moveSLToBreakeven(trade, newSlPrice) {
  if (!isEnabled() || !trade) return null;
  const { symbol, direction } = trade;
  const targetSlPrice = newSlPrice || trade.entryPrice;
  const slSide = direction === 'LONG' ? 'SELL' : 'BUY';

  // 1. Hủy SL cũ trên sàn nếu có
  if (trade.binanceSlOrderId) {
    try {
      await cancelAlgoOrder(symbol, trade.binanceSlOrderId);
      log.trade(`BINANCE: đã hủy SL cũ #${trade.binanceSlOrderId} của ${symbol}`);
    } catch (err) {
      log.warn(`BINANCE: hủy SL cũ #${trade.binanceSlOrderId} thất bại hoặc đã khớp: ${err.message}`);
    }
  }

  // 2. Đặt SL mới tại mốc Breakeven
  try {
    const slRes = await placeStopOrder(symbol, slSide, 'STOP_MARKET', targetSlPrice);
    const newSlId = (slRes?.algoId != null ? String(slRes.algoId) : (slRes?.orderId != null ? String(slRes.orderId) : null));
    trade.binanceSlOrderId = newSlId;
    trade.slPrice = targetSlPrice;
    trade.slMovedToBreakeven = true;
    log.trade(`BINANCE: dời SL Breakeven OK ${symbol}`, { newAlgoId: newSlId, newSL: targetSlPrice });
    return newSlId;
  } catch (err) {
    log.error(`BINANCE: lỗi đặt SL Breakeven ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Dịch chuyển TP trực tiếp trên sàn Binance:
 * Hủy TP Limit cũ -> Đặt TP Limit mới tại newTargetPrice (reduceOnly: true).
 */
async function replaceTPOrder(trade, newTargetPrice) {
  if (!isEnabled() || !trade) return null;
  const { symbol, direction } = trade;
  const tpSide = direction === 'LONG' ? 'SELL' : 'BUY';

  // 1. Hủy TP Limit cũ trên sàn nếu có
  if (trade.binanceTpOrderId) {
    try {
      await cancelOrderById(symbol, trade.binanceTpOrderId);
      log.trade(`BINANCE: đã hủy TP cũ #${trade.binanceTpOrderId} của ${symbol}`);
    } catch (err) {
      log.warn(`BINANCE: hủy TP cũ #${trade.binanceTpOrderId} thất bại: ${err.message}`);
    }
  }

  // 2. Đặt TP Limit mới
  try {
    const info = await getSymbolInfo(symbol);
    const pricePrecision = info?.pricePrecision ?? 4;
    const tpPrice = parseFloat(newTargetPrice.toFixed(pricePrecision));
    const qty = trade.binanceQty;
    const tpOrder = await api('POST', '/fapi/v1/order', {
      symbol: `${symbol}USDT`,
      side: tpSide,
      type: 'LIMIT',
      price: tpPrice,
      quantity: qty,
      timeInForce: 'GTC',
      reduceOnly: 'true',
    });
    trade.binanceTpOrderId = tpOrder.orderId != null ? String(tpOrder.orderId) : null;
    trade.targetPrice = newTargetPrice;
    log.trade(`BINANCE: Dịch TP Limit mới OK ${symbol}`, { orderId: tpOrder.orderId, newTP: tpPrice });
    return tpOrder.orderId;
  } catch (err) {
    log.error(`BINANCE: lỗi đặt TP Limit mới ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Đặt TP tại targetPrice sau khi entry fill.
 * Dùng LIMIT order (không phải TAKE_PROFIT_MARKET) vì tài khoản Portfolio Margin
 * không hỗ trợ conditional orders trên /fapi/v1/order.
 */
async function placeTPAfterEntry(trade) {
  // Cho phép đặt TP khi có binanceQty (vị thế thủ công/sync) ngay cả khi không có binanceEntryOrderId
  if (!isEnabled() || (!trade.binanceEntryOrderId && !trade.binanceQty)) return null;
  const { symbol, direction, targetPrice } = trade;
  try {
    const info = await getSymbolInfo(symbol);
    if (!info) {
      log.warn(`BINANCE: ${symbol}USDT không được hỗ trợ — skip TP`);
      return null;
    }
    const qty = trade.binanceQty;
    if (!qty) {
      log.warn(`BINANCE: không có qty cho ${symbol} — skip TP`);
      return null;
    }
    if (!targetPrice) {
      log.warn(`BINANCE: targetPrice null cho ${symbol} — skip TP`);
      return null;
    }
    const tpSide  = direction === 'LONG' ? 'SELL' : 'BUY';
    const tpPrice = parseFloat(targetPrice.toFixed(info.pricePrecision));
    const tpOrder = await api('POST', '/fapi/v1/order', {
      symbol:      `${symbol}USDT`,
      side:        tpSide,
      type:        'LIMIT',
      price:       tpPrice,
      quantity:    qty,
      timeInForce: 'GTC',
      reduceOnly:  'true',
    });
    trade.binanceTpOrderId = tpOrder.orderId != null ? String(tpOrder.orderId) : null;
    log.trade(`BINANCE: TP LIMIT OK ${symbol}`, { orderId: tpOrder.orderId, price: targetPrice });
    return tpOrder.orderId;
  } catch (err) {
    log.error(`BINANCE: lỗi đặt TP ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Đóng vị thế bằng MARKET order (reduceOnly).
 * Dùng cho client-side SL: khi giá chạm slPrice, gọi hàm này để đóng ngay.
 */
async function placeMarketClose(trade) {
  if (!isEnabled()) return null;
  const { symbol, direction } = trade;
  const qty = trade.binanceQty;
  if (!qty) {
    log.warn(`BINANCE: không có qty cho ${symbol} — không thể MARKET close`);
    return null;
  }
  const side = direction === 'LONG' ? 'SELL' : 'BUY';
  try {
    const order = await api('POST', '/fapi/v1/order', {
      symbol:     `${symbol}USDT`,
      side:       side,
      type:       'MARKET',
      quantity:   qty,
      reduceOnly: 'true',
    });
    log.trade(`BINANCE: MARKET close OK ${symbol}`, { orderId: order.orderId, qty });
    return order.orderId;
  } catch (err) {
    // Algo SL có thể đã đóng vị thế trước — reduceOnly fail là bình thường
    if (err.message.includes('-2022') || err.message.includes('ReduceOnly') || err.message.includes('no position')) {
      log.trade(`BINANCE: vị thế ${symbol} đã đóng rồi (algo SL đã thực thi)`);
    } else {
      log.error(`BINANCE: lỗi MARKET close ${symbol}`, { error: err.message });
    }
    return null;
  }
}

/**
 * Vào lệnh MARKET ngay lập tức (không chờ LIMIT fill).
 * Flow: Leverage → MARKET entry → LIMIT TP + Algo SL (cả hai server-side)
 */
async function placeMarketTrade(trade, currentPrice) {
  if (!isEnabled()) return null;
  const { symbol, direction, slPrice, leverage = 10 } = trade;

  log.trade(`BINANCE MARKET: bắt đầu vào ${symbol} ${direction} ~${currentPrice} sl=${slPrice} x${leverage}`);
  try {
    const info = await getSymbolInfo(symbol);
    if (!info) {
      log.warn(`BINANCE MARKET: ${symbol}USDT không được hỗ trợ trên Binance Futures (đã hủy niêm yết?)`);
      return { symbolNotSupported: true };
    }

    // 1. Leverage
    await api('POST', '/fapi/v1/leverage', { symbol: `${symbol}USDT`, leverage });

    // 2. Tính qty theo giá thị trường hiện tại (hỗ trợ targetMargin từ trade.margin)
    const { qty, sizeUsdt, balance } = await calcQty(symbol, currentPrice, leverage, info, trade?.margin);
    if (qty <= 0) {
      const minStep = info?.minQty || info?.stepSize || 0.001;
      const minLotCost = ((minStep * currentPrice) / leverage).toFixed(2);
      log.warn(`BINANCE MARKET: balance không đủ cho ${symbol} — balance=${balance.toFixed(2)} USDT, cần tối thiểu margin ~$${minLotCost} USDT (x${leverage})`);
      return { insufficientBalance: true, balance, sizeUsdt };
    }

    // 3. Validate SL hợp lệ so với giá thị trường
    const isLong   = direction === 'LONG';
    if (!slPrice) {
      log.warn(`BINANCE MARKET: slPrice null cho ${symbol} — hủy`);
      return null;
    }
    const slFmt    = parseFloat(slPrice.toFixed(info.pricePrecision));
    const priceFmt = parseFloat(currentPrice.toFixed(info.pricePrecision));
    if (isLong && slFmt >= priceFmt) {
      log.error(`BINANCE MARKET: SL ${slFmt} >= giá ${priceFmt} cho LONG — hủy`);
      return null;
    }
    if (!isLong && slFmt <= priceFmt) {
      log.error(`BINANCE MARKET: SL ${slFmt} <= giá ${priceFmt} cho SHORT — hủy`);
      return null;
    }

    // 4. MARKET entry (fill ngay lập tức)
    const entrySide  = isLong ? 'BUY' : 'SELL';
    const entryOrder = await api('POST', '/fapi/v1/order', {
      symbol:   `${symbol}USDT`,
      side:     entrySide,
      type:     'MARKET',
      quantity: qty,
    });
    trade.binanceEntryOrderId = entryOrder.orderId != null ? String(entryOrder.orderId) : null;
    trade.binanceQty          = qty;
    trade.entryFilled         = true;

    const fillPrice = parseFloat(entryOrder.avgPrice) > 0
      ? parseFloat(entryOrder.avgPrice)
      : currentPrice;
    log.trade(`BINANCE MARKET: entry OK ${symbol} ${direction}`, { orderId: entryOrder.orderId, qty, fillPrice });

    // 5. LIMIT TP tại targetPrice (server-side, fills khi giá chạm)
    if (!trade.targetPrice) {
      log.warn(`BINANCE MARKET: targetPrice null cho ${symbol} — bỏ qua TP LIMIT`);
      _invalidateBalanceCache();
      return { entryOrderId: entryOrder.orderId, tpOrderId: null, qty, sizeUsdt, balance };
    }
    const tpSide   = isLong ? 'SELL' : 'BUY';
    const tpPrice  = parseFloat(trade.targetPrice.toFixed(info.pricePrecision));
    const tpOrder  = await api('POST', '/fapi/v1/order', {
      symbol:      `${symbol}USDT`,
      side:        tpSide,
      type:        'LIMIT',
      price:       tpPrice,
      quantity:    qty,
      timeInForce: 'GTC',
      reduceOnly:  'true',
    });
    trade.binanceTpOrderId = tpOrder.orderId != null ? String(tpOrder.orderId) : null;
    log.trade(`BINANCE MARKET: TP LIMIT OK ${symbol}`, { orderId: tpOrder.orderId, price: trade.targetPrice, fillPrice });

    // 6. Hard STOP_MARKET SL treo trực tiếp lên sàn Binance (/fapi/v1/algoOrder)
    const slSide = isLong ? 'SELL' : 'BUY';
    const slRes = await placeStopOrder(symbol, slSide, 'STOP_MARKET', slPrice).catch(e => {
      log.error(`BINANCE MARKET: lỗi đặt Hard STOP_MARKET SL ${symbol}`, { error: e.message });
      return null;
    });
    if (slRes) {
      trade.binanceSlOrderId = (slRes.algoId != null ? String(slRes.algoId) : (slRes.orderId != null ? String(slRes.orderId) : null));
      log.trade(`BINANCE MARKET: Hard STOP_MARKET SL OK ${symbol}`, { algoId: trade.binanceSlOrderId, slPrice });
    }

    _invalidateBalanceCache();
    return { entryOrderId: entryOrder.orderId, tpOrderId: tpOrder.orderId, slOrderId: trade.binanceSlOrderId, qty, sizeUsdt, balance };
  } catch (err) {
    if (/TradFi|agreement/i.test(err.message)) {
      log.warn(`BINANCE MARKET: ${symbol} yêu cầu ký TradFi-Perps agreement — không retry cho đến khi ký`);
      return { agreementRequired: true };
    }
    log.error(`BINANCE MARKET: lỗi ${symbol} ${direction}`, { error: err.message });
    return null;
  }
}

// Huỷ entry order khi lệnh pending hết hạn (ENTRY_EXPIRY_HOURS)
async function cancelEntryOrder(trade) {
  if (!isEnabled() || !trade.binanceEntryOrderId) return;
  const { symbol } = trade;
  try {
    await api('DELETE', '/fapi/v1/order', { symbol: `${symbol}USDT`, orderId: trade.binanceEntryOrderId });
    log.trade(`BINANCE: huỷ entry order OK ${symbol}`, { orderId: trade.binanceEntryOrderId });
  } catch (err) {
    // Lệnh có thể đã fill hoặc bị huỷ rồi — chỉ cảnh báo, không throw
    log.warn(`BINANCE: không thể huỷ entry ${symbol} #${trade.binanceEntryOrderId}`, { error: err.message });
  }
}

// Huỷ algo order (SL server-side) theo algoId/strategyId
async function cancelAlgoOrderById(symbolOrId, maybeAlgoId) {
  if (!isEnabled()) return;
  let symbol = null;
  let algoId = null;
  if (maybeAlgoId) {
    symbol = symbolOrId;
    algoId = maybeAlgoId;
  } else {
    algoId = symbolOrId;
  }
  if (!algoId) return;

  try {
    if (symbol) {
      await cancelAlgoOrder(symbol, algoId);
    } else {
      await api('DELETE', '/fapi/v1/algoOrder', { algoId });
    }
    log.trade(`BINANCE: huỷ algo order OK`, { symbol, algoId });
  } catch (err) {
    log.warn(`BINANCE: không thể huỷ algo order #${algoId}`, { error: err.message });
  }
}

/**
 * Lấy toàn bộ vị thế đang mở (positionAmt ≠ 0) trên tài khoản Futures.
 * Throw khi Binance API thất bại — KHÔNG trả về [] để tránh caller hiểu nhầm là "không có vị thế".
 */
async function getAllPositions() {
  if (!isEnabled()) return [];
  try {
    const res = await api('GET', '/fapi/v2/positionRisk', {});
    return (Array.isArray(res) ? res : []).filter(p => parseFloat(p.positionAmt) !== 0);
  } catch (err) {
    log.error('BINANCE: getAllPositions thất bại — throw để caller huỷ bỏ thay vì đóng nhầm lệnh', { error: err.message });
    throw err;
  }
}

/**
 * Lấy tất cả open orders của 1 symbol.
 * Dùng để tìm TP/SL do user đặt thủ công.
 */
async function getOpenOrders(symbol) {
  if (!isEnabled()) return [];
  try {
    return await api('GET', '/fapi/v1/openOrders', { symbol: `${symbol}USDT` });
  } catch (err) {
    log.warn(`BINANCE: không lấy được open orders ${symbol}`, { error: err.message });
    throw err;
  }
}

/**
 * Kiểm tra position size thực tế trên Binance Futures.
 * Trả về số lượng (dương=LONG, âm=SHORT, 0=không có), null nếu API lỗi.
 */
async function getPositionAmt(symbol) {
  if (!isEnabled()) return null;
  try {
    const res = await api('GET', '/fapi/v2/positionRisk', { symbol: `${symbol}USDT` });
    const pos = Array.isArray(res) ? res[0] : res;
    return pos ? parseFloat(pos.positionAmt) : 0;
  } catch (err) {
    log.warn(`BINANCE: không lấy được positionAmt ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Lấy thông tin đầy đủ của position: positionAmt + entryPrice thực tế từ Binance.
 * Dùng cho WS fill fallback khi order ID bị precision loss — cùng 1 API call với getPositionAmt.
 * Trả về { positionAmt, entryPrice } hoặc null nếu API lỗi / không có position.
 */
async function getPositionInfo(symbol) {
  if (!isEnabled()) return null;
  try {
    const res = await api('GET', '/fapi/v2/positionRisk', { symbol: `${symbol}USDT` });
    const pos = Array.isArray(res) ? res[0] : res;
    if (!pos) return null;
    return {
      positionAmt: parseFloat(pos.positionAmt),
      entryPrice:  parseFloat(pos.entryPrice),
    };
  } catch (err) {
    log.warn(`BINANCE: không lấy được positionInfo ${symbol}`, { error: err.message });
    return null;
  }
}

/**
 * Lấy trạng thái một order cụ thể theo orderId.
 * Dùng cho WS fill fallback: phát hiện khi Binance drop ORDER_TRADE_UPDATE event.
 * Trả về order object (có field .status: 'NEW'|'FILLED'|'CANCELED'|...), null nếu API lỗi.
 */
async function getOrderStatus(symbol, orderId) {
  if (!isEnabled()) return null;
  try {
    return await api('GET', '/fapi/v1/order', { symbol: `${symbol}USDT`, orderId });
  } catch (err) {
    log.warn(`BINANCE: không lấy được trạng thái order ${symbol} #${orderId}`, { error: err.message });
    return null;
  }
}

// Huỷ bất kỳ order nào theo orderId (dùng để cancel TP sau khi SL hit hoặc ngược lại)
async function cancelOrderById(symbol, orderId) {
  if (!isEnabled() || !orderId) return;
  try {
    await api('DELETE', '/fapi/v1/order', { symbol: `${symbol}USDT`, orderId });
    log.trade(`BINANCE: huỷ order OK ${symbol}`, { orderId });
  } catch (err) {
    log.warn(`BINANCE: không thể huỷ order ${symbol} #${orderId}`, { error: err.message });
  }
}

/**
 * Tìm closing trade gần nhất cho symbol+direction trên Binance.
 * Dùng khi syncManualPositions / Recovery phát hiện position biến mất để lấy giá đóng thực tế.
 *
 * Validation (5 điều kiện):
 * 1. side = opposite với direction (LONG → SELL, SHORT → BUY)
 * 2. realizedPnl != 0 (closing trade, không phải opening)
 * 3. time >= sinceMs (sau entry fill / recommendedAt)
 * 4. totalQty của orderId gần nhất ≈ binanceQty (±10%) nếu được cung cấp
 * 5. Chọn orderId có timestamp mới nhất trong window
 *
 * @param {string}      symbol      - base symbol, e.g. 'UNI'
 * @param {string}      direction   - 'LONG' | 'SHORT'
 * @param {number}      sinceMs     - unix ms — chỉ lấy fills sau thời điểm này
 * @param {number|null} binanceQty  - expected qty (từ trade.binanceQty), null = bỏ qua validation qty
 * @returns {{ avgPrice: number, orderId: number, time: number, totalQty: number } | null}
 */
async function getRecentClosingTrades(symbol, direction, sinceMs, binanceQty = null) {
  if (!isEnabled()) return null;
  const closingSide = direction === 'LONG' ? 'SELL' : 'BUY';
  let fills;
  try {
    fills = await api('GET', '/fapi/v1/userTrades', {
      symbol: `${symbol}USDT`,
      startTime: sinceMs,
      limit: 50,
    });
  } catch (err) {
    log.warn(`getRecentClosingTrades: ${symbol} API thất bại`, { error: err.message });
    return null;
  }
  if (!Array.isArray(fills) || !fills.length) return null;

  // Condition 1+2: correct side + realizedPnl != 0
  const closingFills = fills.filter(f =>
    f.side === closingSide &&
    parseFloat(f.realizedPnl) !== 0
  );
  if (!closingFills.length) return null;

  // Group fills by orderId
  const orderMap = new Map();
  for (const f of closingFills) {
    if (!orderMap.has(f.orderId)) {
      orderMap.set(f.orderId, { orderId: f.orderId, fills: [], totalQty: 0, maxTime: 0 });
    }
    const o = orderMap.get(f.orderId);
    o.fills.push(f);
    o.totalQty += parseFloat(f.qty);
    o.maxTime = Math.max(o.maxTime, f.time);
  }

  // Condition 5: most recent orderId
  let best = null;
  for (const [, o] of orderMap) {
    if (!best || o.maxTime > best.maxTime) best = o;
  }
  if (!best) return null;

  // Condition 4: qty tolerance ±10%
  if (binanceQty != null && binanceQty > 0) {
    const ratio = best.totalQty / binanceQty;
    if (ratio < 0.9 || ratio > 1.1) {
      log.warn(`getRecentClosingTrades: ${symbol} qty mismatch — expected=${binanceQty} got=${best.totalQty.toFixed(4)} ratio=${ratio.toFixed(2)} — bỏ qua`);
      return null;
    }
  }

  // Weighted average close price
  let totalValue = 0;
  for (const f of best.fills) totalValue += parseFloat(f.price) * parseFloat(f.qty);
  const avgPrice = parseFloat((totalValue / best.totalQty).toFixed(8));

  log.trade(`getRecentClosingTrades: ${symbol} ${direction} → orderId=${best.orderId} avgPrice=${avgPrice} qty=${best.totalQty} fills=${best.fills.length}`);
  return { avgPrice, orderId: best.orderId, time: best.maxTime, totalQty: best.totalQty };
}

module.exports = {
  isEnabled,
  getUsdtBalance,
  calcQty,
  getSymbolInfo,
  placeNewTrade,
  placeMarketTrade,
  placeSLAfterFill,
  placeTPAfterEntry,
  placeMarketClose,
  moveSLToBreakeven,
  replaceTPOrder,
  placeStopOrder,
  cancelAlgoOrder,
  getOpenAlgoOrders,
  cancelEntryOrder,
  cancelOrderById,
  cancelAlgoOrderById,
  getOrderStatus,
  getPositionAmt,
  getPositionInfo,
  getAllPositions,
  getOpenOrders,
  getRecentClosingTrades
};
