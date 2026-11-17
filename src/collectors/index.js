'use strict';

const coinalyzeData = require('./coinalyzeData');
const whaleData = require('./whaleData');
const derivatives = require('./derivatives');
const fearGreed = require('./fearGreed');
const ramCache = require('./ramCache');

module.exports = {
  // Coinalyze
  getCoinalyzeOI: coinalyzeData.getCoinalyzeOI,
  getCoinalyzeLSRatio: coinalyzeData.getCoinalyzeLSRatio,
  getCoinalyzeLiquidations: coinalyzeData.getCoinalyzeLiquidations,
  isCoinalyzeEnabled: coinalyzeData.isEnabled,

  // Whale
  getWhaleData: whaleData.getWhaleData,
  getBinanceTakerFlow: whaleData.getBinanceTakerFlow,
  getBinanceLargeTrades: whaleData.getBinanceLargeTrades,
  getBinanceLiquidations: whaleData.getBinanceLiquidations,
  getCrossSignal: whaleData.getCrossSignal,

  // Derivatives
  getDerivatives: derivatives.getDerivatives,
  getOIHistory: derivatives.getOIHistory,
  getGlobalLongShort: derivatives.getGlobalLongShort,
  getTopTraderLongShort: derivatives.getTopTraderLongShort,
  interpretLS: derivatives.interpretLS,

  // Sentiment
  getFearGreedIndex: fearGreed.getFearGreedIndex,

  // RAM Cache & On-Demand Engine
  getOnDemandMarketData: ramCache.getOnDemandMarketData,
  getWhaleDataCached: ramCache.getWhaleDataCached,
  getDerivativesCached: ramCache.getDerivativesCached,
  getFearGreedCached: ramCache.getFearGreedCached,
  getRamCacheStats: ramCache.getRamCacheStats,
  clearRamCache: ramCache.clearRamCache,
  WHALE_TTL_MS: ramCache.WHALE_TTL_MS,
  DERIVATIVES_TTL_MS: ramCache.DERIVATIVES_TTL_MS,
  FEAR_GREED_TTL_MS: ramCache.FEAR_GREED_TTL_MS,
};
