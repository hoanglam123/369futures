'use strict';

const { get369Signal, score369Method, updatePricesRest, getMarkPrice, getLevelCache, evaluateSignalWithAI, isGridWidthValid, getMarketCapRank } = require('../src/pp369');
const fs = require('fs');
const path = require('path');

async function scanMarketNow() {
  console.log('🔄 Đang cập nhật giá thị trường Binance mới nhất...');
  await updatePricesRest();

  const stepDataPath = path.join(__dirname, '../data/step_sizes.json');
  if (!fs.existsSync(stepDataPath)) {
    console.error('Không tìm thấy file step_sizes.json');
    return;
  }

  const stepData = JSON.parse(fs.readFileSync(stepDataPath, 'utf8'));
  const h4Cache = stepData.h4Cache || {};

  const validSymbols = Object.entries(h4Cache)
    .filter(([sym, e]) => {
      if (e.failed) return false;
      const cp = getMarkPrice(sym);
      return isGridWidthValid(e, cp, sym);
    })
    .map(([sym]) => sym);

  const levelCache = getLevelCache();
  const nearbyList = [];
  const BATCH_SIZE = 30;

  for (let i = 0; i < validSymbols.length; i += BATCH_SIZE) {
    const batch = validSymbols.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (sym) => {
      const cp = getMarkPrice(sym);
      const levels = levelCache[sym];
      if (!cp || !levels?.longEntry || !levels?.shortEntry) return;

      const distLong = Math.abs(cp - levels.longEntry) / levels.longEntry * 100;
      const distShort = Math.abs(levels.shortEntry - cp) / levels.shortEntry * 100;

      if (distLong <= 2.0 || distShort <= 2.0) {
        const nearType = distLong <= distShort ? 'LONG' : 'SHORT';
        const targetLevel = nearType === 'LONG' ? levels.longEntry : levels.shortEntry;
        const distPct = nearType === 'LONG' ? distLong : distShort;

        let score = null;
        let aiEval = null;
        let signalActive = 'TIỆM CẬN';

        try {
          const sig = await get369Signal(sym, cp);
          if (sig && sig.signal !== 'NONE') {
            signalActive = sig.signal;
            const scoreRes = await score369Method(sig, sig.signal);
            score = scoreRes.score;
            sig.score = scoreRes.score;
            sig.scoreReasons = scoreRes.reasons;
            sig.marketCapRank = getMarketCapRank(sym);
            aiEval = evaluateSignalWithAI(sig);
          }
        } catch (_) {}

        nearbyList.push({
          symbol: sym,
          nearType: nearType,
          signalActive: signalActive,
          targetLevel: targetLevel,
          markPrice: cp,
          distPct: distPct,
          score: score,
          isApprovedAI: aiEval ? aiEval.isApproved : null,
          winRate: aiEval ? (aiEval.winRate * 100).toFixed(1) + '%' : 'N/A',
          marketCapRank: getMarketCapRank(sym)
        });
      }
    }));
  }

  nearbyList.sort((a, b) => a.distPct - b.distPct);

  console.log('\n====================================================================================================================');
  console.log(`📌 KẾT QUẢ QUÉT REALTIME: TOÀN BỘ ${nearbyList.length} MÃ ĐANG NẰM TRONG BÁN KÍNH 2.0% SO VỚI MỐC LIMIT 369`);
  console.log('====================================================================================================================\n');

  if (nearbyList.length === 0) {
    console.log('Hiện tại không có mã nào đang ở trong bán kính 2.0% tiệm cận mốc.');
    return;
  }

  nearbyList.forEach((item, idx) => {
    const rankStr = item.marketCapRank <= 150 ? `#${item.marketCapRank}` : 'LowCap';
    const scoreText = item.score !== null ? `+${item.score.toFixed(1)}đ` : 'Chờ bứt phá';
    let aiText = 'N/A';
    if (item.isApprovedAI !== null) {
      aiText = item.isApprovedAI ? `🟢 Nên vào (${item.winRate})` : `🟡 Bỏ (${item.winRate})`;
    }

    console.log(
      `${String(idx + 1).padStart(2, ' ')}. ${item.symbol.padEnd(10)} ` +
      `| Hướng: ${item.nearType.padEnd(5)} ` +
      `| Trạng thái: ${item.signalActive.padEnd(7)} ` +
      `| Mốc Entry: $${String(item.targetLevel).padEnd(10)} ` +
      `| Giá Hiện Tại: $${String(item.markPrice).padEnd(10)} ` +
      `| Cách Mốc: ${item.distPct.toFixed(2).padStart(5, ' ')}% ` +
      `| Score: ${scoreText.padEnd(11, ' ')} ` +
      `| Rank: ${rankStr.padEnd(6, ' ')} ` +
      `| AI: ${aiText}`
    );
  });
}

scanMarketNow();
