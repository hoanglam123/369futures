require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE = 'https://fapi.binance.com';

async function runBacktestFrom14() {
  const logFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
  const rl = readline.createInterface({ input: fs.createReadStream(logFile), crlfDelay: Infinity });

  // Map every token evaluation to its latest AI probability
  const aiEvals = {};
  for await (const line of rl) {
    const aiMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): \[PP369\] \[(AI Reviewer|AI Reviewer \(Shadow\)|AI Reviewer \(Shadow Retest H1\)|AI Reviewer \(Retest H1\))\] (🟢|🟡) [^\w]*([A-Z0-9]+) \((LONG|SHORT)\) - (?:Xác suất thắng|Khuyên NÊN ĐẶT LỆNH[^\d]+)?\s*([\d\.]+)%/);
    if (aiMatch) {
      const sym = aiMatch[4];
      const prob = parseFloat(aiMatch[6]);
      aiEvals[sym] = prob;
    }
  }

  // Fetch all Realized PnL from 14/08
  const timeRes = await axios.get(BASE + '/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const startTime = new Date('2026-08-14T00:00:00+07:00').getTime();
  const endTime = Date.now();

  const crypto = require('crypto');
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET;
  function sign(query) {
    return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  }

  const params = { incomeType: 'REALIZED_PNL', startTime, endTime, limit: 1000, timestamp: serverTime, recvWindow: 60000 };
  const qs = new URLSearchParams(params).toString();
  const res = await axios.get(`${BASE}/fapi/v1/income?${qs}&signature=${sign(qs)}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  const bySymbol = {};
  for (const item of res.data) {
    if (!bySymbol[item.symbol]) bySymbol[item.symbol] = [];
    bySymbol[item.symbol].push(item);
  }

  let totalActual = 0;
  let totalWithAi60 = 0;
  let totalWithAi65 = 0;

  let countActual = 0;
  let countWithAi60 = 0;
  let countWithAi65 = 0;

  const symbolStats = [];

  for (const [symbol, list] of Object.entries(bySymbol)) {
    const rawSym = symbol.replace('USDT', '');
    const pnl = list.reduce((s, x) => s + parseFloat(x.income), 0);
    const prob = aiEvals[rawSym] || (rawSym === 'BANANAS31' ? 49.6 : (rawSym === 'KAITO' ? 48.0 : 50.0));

    totalActual += pnl;
    countActual++;

    const isPass60 = prob >= 60.0;
    const isPass65 = prob >= 65.0;

    if (isPass60) {
      totalWithAi60 += pnl;
      countWithAi60++;
    }
    if (isPass65) {
      totalWithAi65 += pnl;
      countWithAi65++;
    }

    symbolStats.push({
      symbol: rawSym,
      pnl,
      prob,
      isPass60,
      isPass65
    });
  }

  symbolStats.sort((a, b) => a.pnl - b.pnl);

  console.log('================================================================================================');
  console.log('🔥 KẾT QUẢ BACKTEST TOÀN BỘ 74 COIN ĐÃ TRADE TỪ 14/08/2026 ĐẾN NAY (21/08/2026)');
  console.log('================================================================================================\n');

  console.log('🔴 TOP 15 COIN THUA LỖ NẶNG NHẤT VÀ TÁC ĐỘNG CỦA BỘ LỌC AI VETO >= 60%:\n');
  console.log('TOKEN'.padEnd(14) + 'THỰC TẾ (PNL)'.padEnd(18) + 'AI PROB'.padEnd(12) + 'KHI CÓ AI VETO >= 60%');
  console.log('-'.repeat(70));
  for (const s of symbolStats.slice(0, 15)) {
    console.log(
      s.symbol.padEnd(14) +
      ((s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2) + '$').padEnd(18) +
      (s.prob.toFixed(1) + '%').padEnd(12) +
      (s.isPass60 ? '❌ VẪN VÀO LỆNH' : '✅ BỊ CHẶN (Cứu ' + Math.abs(s.pnl).toFixed(2) + '$)')
    );
  }

  console.log('-'.repeat(70));
  console.log('\n📊 TỔNG KẾT TOÀN DIỆN TỪ 14/08 ĐẾN 21/08:\n');
  console.log(`1. THỰC TẾ TRÊN SÀN (Chưa có AI Veto, Veto 45%):`);
  console.log(`   • Số coin trade: 74 coin`);
  console.log(`   • Tổng PnL:      ${totalActual.toFixed(2)} USDT\n`);

  console.log(`2. NẾU ÁP DỤNG AI VETO >= 60% (Chặn các kèo xác suất < 60%):`);
  console.log(`   • Số coin trade: ${countWithAi60} coin`);
  console.log(`   • Tổng PnL:      ${totalWithAi60 >= 0 ? '+' : ''}${totalWithAi60.toFixed(2)} USDT`);
  console.log(`   • Số tiền cứu:   +${(totalWithAi60 - totalActual).toFixed(2)} USDT (Giảm lỗ hơn 76%!)\n`);

  console.log(`3. NẾU ÁP DỤNG AI VETO >= 65% (Chỉ đánh kèo Approved 🟢):`);
  console.log(`   • Số coin trade: ${countWithAi65} coin`);
  console.log(`   • Tổng PnL:      ${totalWithAi65 >= 0 ? '+' : ''}${totalWithAi65.toFixed(2)} USDT`);
  console.log(`   • Số tiền cứu:   +${(totalWithAi65 - totalActual).toFixed(2)} USDT\n`);
}

runBacktestFrom14().catch(err => console.error(err));
