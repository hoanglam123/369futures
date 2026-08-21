const { simulateAdvancedCombo, liveTrades } = require('./comprehensive_backtest.js');

async function testAll() {
  console.log('=== SO SÁNH CÁC MỨC QUẢN TRỊ RỦI RO VÀ NGƯỠNG AI ===\n');
  for (const prob of [55, 60, 65, 70]) {
    for (const lowCapLoss of [3.0, 2.5, 2.0]) {
      let total = 0, count = 0, wins = 0, losses = 0;
      for (const t of liveTrades) {
        const res = await simulateAdvancedCombo(t, {
          minAiProb: prob,
          targetLossByCap: { TOP10: 5.0, MIDCAP: 3.5, LOWCAP: lowCapLoss },
          earlyTpRatio: 0.45,
          finalTpRatio: 1.5
        });
        if (res.isTrade) {
          count++;
          total += res.pnl;
          if (res.pnl > 0) wins++; else losses++;
        }
      }
      console.log(`AI Veto >= ${prob}% | MaxLoss Lowcap = ${lowCapLoss} USDT: Số lệnh = ${count} (${wins} Thắng / ${losses} Thua) => PnL: ${total >= 0 ? '+' : ''}${total.toFixed(2)} USDT`);
    }
    console.log('-'.repeat(80));
  }
}

testAll();
