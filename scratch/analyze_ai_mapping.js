const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_SECRET;

async function getAllIncomeHistory(startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/income';
  let allIncome = [];
  let currentStart = startTime;

  while (true) {
    const timestamp = Date.now();
    const params = {
      startTime: currentStart,
      endTime: endTime,
      limit: 1000,
      timestamp,
      recvWindow: 30000
    };
    const qs = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = res.data;
    if (!data || data.length === 0) break;
    allIncome = allIncome.concat(data);
    if (data.length < 1000) break;
    currentStart = data[data.length - 1].time + 1;
    if (currentStart >= endTime) break;
  }
  return allIncome;
}

async function getUserTrades(symbol, startTime, endTime) {
  const endpoint = 'https://fapi.binance.com/fapi/v1/userTrades';
  const timestamp = Date.now();
  const params = {
    symbol,
    startTime,
    endTime,
    limit: 1000,
    timestamp,
    recvWindow: 30000
  };
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await axios.get(`${endpoint}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

function loadAIEvaluations() {
  const filePath = path.join(process.cwd(), 'data', 'ai_evaluations.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const evals = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('=') || trimmed.startsWith('>')) continue;
    try {
      evals.push(JSON.parse(trimmed));
    } catch (e) {}
  }
  return evals;
}

async function main() {
  const currentYear = new Date().getFullYear();
  const startTime = new Date(`${currentYear}-08-14T00:00:00+07:00`).getTime();
  const endTime = Date.now();

  const incomes = await getAllIncomeHistory(startTime, endTime);
  incomes.sort((a, b) => a.time - b.time);

  const aiEvals = loadAIEvaluations();
  console.log(`Loaded ${aiEvals.length} AI evaluations.`);

  // Unique symbols
  const symbols = [...new Set(incomes.filter(i => i.incomeType === 'REALIZED_PNL').map(i => i.symbol))];
  const userTradesMap = {};
  for (const sym of symbols) {
    try {
      // get trades from 48h before to catch opening fills
      const trades = await getUserTrades(sym, startTime - 48*3600*1000, endTime);
      userTradesMap[sym] = trades;
    } catch (e) {}
  }

  // Cluster closed positions
  const pnlList = incomes.filter(i => i.incomeType === 'REALIZED_PNL');
  const positions = [];
  let currentPos = null;

  for (const item of pnlList) {
    const amt = parseFloat(item.income);
    if (!currentPos || currentPos.symbol !== item.symbol || (item.time - currentPos.lastTime > 60000)) {
      if (currentPos) positions.push(currentPos);
      currentPos = {
        symbol: item.symbol,
        startTime: item.time,
        lastTime: item.time,
        totalPnl: amt,
        tradeIds: [item.tradeId],
        fills: 1
      };
    } else {
      currentPos.lastTime = item.time;
      currentPos.totalPnl += amt;
      currentPos.tradeIds.push(item.tradeId);
      currentPos.fills++;
    }
  }
  if (currentPos) positions.push(currentPos);

  console.log(`Total closed positions: ${positions.length}`);

  // For each position, find side, entry time, and matching AI eval
  for (const pos of positions) {
    const symTrades = userTradesMap[pos.symbol] || [];
    const closeFill = symTrades.find(t => String(t.id) === String(pos.tradeIds[0]));
    if (closeFill) {
      pos.side = closeFill.side === 'BUY' ? 'SHORT' : 'LONG';
      pos.closePrice = parseFloat(closeFill.price);
      pos.closeTime = closeFill.time;
      
      // Find entry trade: search backwards from closeTime for opposite side fills
      const openSide = pos.side === 'LONG' ? 'BUY' : 'SELL';
      const openTrades = symTrades.filter(t => t.time < pos.closeTime && t.side === openSide);
      if (openTrades.length > 0) {
        const lastOpen = openTrades[openTrades.length - 1];
        pos.entryTime = lastOpen.time;
        pos.entryPrice = parseFloat(lastOpen.price);
      } else {
        pos.entryTime = pos.startTime - 3600000; // fallback
      }
    } else {
      pos.side = 'UNKNOWN';
      pos.entryTime = pos.startTime - 3600000;
    }

    // Match with AI eval: clean symbol (remove USDT)
    const cleanSym = pos.symbol.replace('USDT', '').replace('1000', '');
    const cleanSymFull = pos.symbol.replace('USDT', '');

    // Look for AI evals for this symbol within [entryTime - 4h, entryTime + 10m] or matching signal
    const candidateEvals = aiEvals.filter(e => {
      const eSym = e.symbol;
      const isSymMatch = eSym === cleanSym || eSym === cleanSymFull || pos.symbol.startsWith(eSym);
      if (!isSymMatch) return false;
      // eval time must be before or near entry
      const timeDiff = pos.entryTime - e.timestamp;
      return (timeDiff >= -600000 && timeDiff <= 4 * 3600 * 1000);
    });

    if (candidateEvals.length > 0) {
      // Pick the closest eval before entry
      candidateEvals.sort((a, b) => Math.abs(pos.entryTime - a.timestamp) - Math.abs(pos.entryTime - b.timestamp));
      pos.aiEval = candidateEvals[0];
    } else {
      // Wider search: any eval for this symbol between [entryTime - 24h, closeTime]
      const fallbackEvals = aiEvals.filter(e => {
        const eSym = e.symbol;
        const isSymMatch = eSym === cleanSym || eSym === cleanSymFull || pos.symbol.startsWith(eSym);
        return isSymMatch && e.timestamp <= pos.closeTime && e.timestamp >= pos.entryTime - 24 * 3600 * 1000;
      });
      if (fallbackEvals.length > 0) {
        fallbackEvals.sort((a, b) => Math.abs(pos.entryTime - a.timestamp) - Math.abs(pos.entryTime - b.timestamp));
        pos.aiEval = fallbackEvals[0];
      } else {
        pos.aiEval = null;
      }
    }
  }

  // Now analyze the impact of AI
  let actualWins = 0, actualLosses = 0, actualPnl = 0;
  let aiApprovedWins = 0, aiApprovedLosses = 0, aiApprovedPnl = 0;
  let aiRejectedWins = 0, aiRejectedLosses = 0, aiRejectedPnl = 0;
  let noEvalTrades = 0;

  const tableRows = [];

  for (const p of positions) {
    const isWin = p.totalPnl > 0;
    const isLoss = p.totalPnl < 0;
    actualPnl += p.totalPnl;
    if (isWin) actualWins++;
    if (isLoss) actualLosses++;

    const closeTimeStr = new Date(p.startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const entryTimeStr = p.entryTime ? new Date(p.entryTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'N/A';

    let aiApproved = null;
    let aiProb = null;
    let aiReason = 'Không có log AI';

    if (p.aiEval) {
      aiApproved = p.aiEval.isApprovedByAI;
      aiProb = p.aiEval.winProbability;
      aiReason = p.aiEval.aiReason || (aiApproved ? 'Đạt chuẩn AI' : 'Bị AI từ chối');

      if (aiApproved) {
        aiApprovedPnl += p.totalPnl;
        if (isWin) aiApprovedWins++;
        if (isLoss) aiApprovedLosses++;
      } else {
        aiRejectedPnl += p.totalPnl;
        if (isWin) aiRejectedWins++;
        if (isLoss) aiRejectedLosses++;
      }
    } else {
      noEvalTrades++;
    }

    tableRows.push({
      symbol: p.symbol,
      side: p.side,
      entryTime: entryTimeStr,
      closeTime: closeTimeStr,
      pnl: p.totalPnl,
      isWin,
      aiApproved,
      aiProb,
      aiReason: p.aiEval ? (p.aiEval.isApprovedByAI ? `✅ DUYỆT (WinProb: ${p.aiEval.winProbability}%)` : `❌ CHẶN/TỪ CHỐI (${p.aiEval.winProbability}% < 65%)`) : '⚠️ Không có log'
    });
  }

  console.log("\n=======================================================");
  console.log("📊 KẾT QUẢ SO SÁNH THỰC TẾ VS NẾU THEO LỜI KHUYÊN CỦA AI");
  console.log("=======================================================");
  console.log(`1. THỰC TẾ TẤT CẢ LỆNH ĐÃ VÀO:`);
  console.log(`   - Tổng lệnh: ${positions.length}`);
  console.log(`   - Thắng: ${actualWins} | Thua: ${actualLosses} | Winrate: ${((actualWins/positions.length)*100).toFixed(1)}%`);
  console.log(`   - Tổng Realized PnL: ${actualPnl.toFixed(4)} USDT`);
  
  console.log(`\n2. NẾU CHỈ ĐÁNH CÁC LỆNH AI PHÊ DUYỆT (isApprovedByAI = true):`);
  const totalApproved = aiApprovedWins + aiApprovedLosses;
  console.log(`   - Số lệnh AI Duyệt: ${totalApproved}`);
  console.log(`   - Thắng: ${aiApprovedWins} | Thua: ${aiApprovedLosses} | Winrate: ${totalApproved > 0 ? ((aiApprovedWins/totalApproved)*100).toFixed(1) : 0}%`);
  console.log(`   - Tổng Realized PnL: ${aiApprovedPnl.toFixed(4)} USDT`);

  console.log(`\n3. CÁC LỆNH AI TỪ CHỐI / CẢNH BÁO (isApprovedByAI = false):`);
  const totalRejected = aiRejectedWins + aiRejectedLosses;
  console.log(`   - Số lệnh AI Chặn/Cảnh báo: ${totalRejected}`);
  console.log(`   - Thắng: ${aiRejectedWins} | Thua: ${aiRejectedLosses} (Số lệnh thua được AI cảnh báo chặn: ${aiRejectedLosses})`);
  console.log(`   - Tổng PnL của nhóm bị AI từ chối: ${aiRejectedPnl.toFixed(4)} USDT`);

  console.log(`\n4. SỐ LỆNH KHÔNG CÓ LOG AI: ${noEvalTrades}`);

  fs.writeFileSync('scratch/ai_mapping_results.json', JSON.stringify({
    summary: {
      actual: { count: positions.length, wins: actualWins, losses: actualLosses, pnl: actualPnl, winrate: ((actualWins/positions.length)*100).toFixed(1) },
      aiApproved: { count: totalApproved, wins: aiApprovedWins, losses: aiApprovedLosses, pnl: aiApprovedPnl, winrate: totalApproved > 0 ? ((aiApprovedWins/totalApproved)*100).toFixed(1) : 0 },
      aiRejected: { count: totalRejected, wins: aiRejectedWins, losses: aiRejectedLosses, pnl: aiRejectedPnl }
    },
    tableRows
  }, null, 2));

  console.log("\nWrote scratch/ai_mapping_results.json successfully.");
}

main();
