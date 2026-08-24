'use strict';

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATASET_FILE = path.join(process.cwd(), 'data', 'ai_trade_dataset.jsonl');
const AI_EVALS_FILE = path.join(process.cwd(), 'data', 'ai_evaluations.jsonl');

async function syncTrades() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;

  if (!apiKey || !secret) {
    console.error('Không tìm thấy Binance API Key');
    return;
  }

  console.log('=== ĐỒNG BỘ CÁC LỆNH THỰC TẾ TỪ BINANCE VÀO TẬP DỮ LIỆU AI DATASET ===');

  const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
  const serverTime = timeRes.data.serverTime;
  const timeOffset = Math.round(serverTime - Date.now());

  // Lấy dữ liệu 7 ngày qua
  const startMs = serverTime - 7 * 24 * 3600 * 1000;
  const endMs = serverTime;

  async function binanceReq(endpoint, paramsObj = {}) {
    const timestamp = Date.now() + timeOffset;
    const params = new URLSearchParams({ ...paramsObj, timestamp, recvWindow: 60000 }).toString();
    const sig = crypto.createHmac('sha256', secret).update(params).digest('hex');
    const res = await axios.get(`https://fapi.binance.com${endpoint}?${params}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    return res.data;
  }

  // Lấy toàn bộ Realized PnL
  let allIncomes = [];
  let cur = startMs;
  while (cur < endMs) {
    const inc = await binanceReq('/fapi/v1/income', { incomeType: 'REALIZED_PNL', startTime: cur, endTime: endMs, limit: 1000 });
    if (!inc || inc.length === 0) break;
    allIncomes.push(...inc);
    const last = inc[inc.length - 1].time;
    if (inc.length < 1000 || last <= cur) break;
    cur = last + 1;
  }

  console.log(`Đã lấy ${allIncomes.length} bản ghi Realized PnL từ Binance.`);

  // Đọc AI evaluations đã lưu
  let aiEvals = [];
  if (fs.existsSync(AI_EVALS_FILE)) {
    aiEvals = fs.readFileSync(AI_EVALS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
      .filter(Boolean);
  }

  // Gom theo vị thế đóng (2 phút)
  const posMap = {};
  allIncomes.forEach(item => {
    const sym = item.symbol;
    const t = item.time;
    const groupKey = `${sym}_${Math.floor(t / 120000)}`;
    if (!posMap[groupKey]) {
      posMap[groupKey] = {
        symbol: sym.replace('USDT', ''),
        exitTime: t,
        pnl: 0,
        tradeIds: []
      };
    }
    posMap[groupKey].pnl += parseFloat(item.income);
    posMap[groupKey].tradeIds.push(item.tradeId);
  });

  const positions = Object.values(posMap).sort((a, b) => a.exitTime - b.exitTime);
  console.log(`Gom được ${positions.length} vị thế đóng.`);

  // Đọc dataset hiện tại
  let existingLines = [];
  if (fs.existsSync(DATASET_FILE)) {
    existingLines = fs.readFileSync(DATASET_FILE, 'utf8').split('\n').filter(Boolean);
  }

  const existingTradeIds = new Set();
  existingLines.forEach(l => {
    try {
      const rec = JSON.parse(l);
      if (rec.tradeId) existingTradeIds.add(rec.tradeId);
    } catch(_) {}
  });

  let appendedCount = 0;

  for (const pos of positions) {
    const tradeKey = `binance_${pos.symbol}_${Math.floor(pos.exitTime / 120000)}`;
    if (existingTradeIds.has(tradeKey)) continue;

    // Tìm evaluation gần nhất trước khi thoát
    const matchedEval = aiEvals
      .filter(e => (e.symbol === pos.symbol || e.symbol === `${pos.symbol}USDT`) && e.timestamp <= pos.exitTime)
      .sort((a, b) => (pos.exitTime - a.timestamp))[0];

    const isWin = pos.pnl > 0;
    const exitType = pos.pnl > 0.5 ? 'TP' : (pos.pnl < -1.0 ? 'SL' : 'BE_EXIT');

    const entryRecord = {
      type: 'ENTRY',
      tradeId: tradeKey,
      symbol: pos.symbol,
      signal: matchedEval?.signal || 'UNKNOWN',
      entryPrice: matchedEval?.targetLevel || 0,
      timestamp: matchedEval?.timestamp || (pos.exitTime - 30 * 60000),
      score: matchedEval?.score || 5.5,
      scoreReasons: matchedEval?.scoreReasons || [],
      marketCapRank: matchedEval?.marketCapRank || 999,
      gridWidthPct: matchedEval?.gridWidthPct || 3.5,
      leverage: 30,
      margin: 10
    };

    const exitRecord = {
      type: 'EXIT',
      tradeId: tradeKey,
      symbol: pos.symbol,
      exitPrice: 0,
      exitTimestamp: pos.exitTime,
      exitType: exitType,
      pnlPercent: pos.pnl * 5,
      pnlUsd: parseFloat(pos.pnl.toFixed(4)),
      holdingDurationMinutes: 30,
      isWin: isWin
    };

    fs.appendFileSync(DATASET_FILE, JSON.stringify(entryRecord) + '\n', 'utf8');
    fs.appendFileSync(DATASET_FILE, JSON.stringify(exitRecord) + '\n', 'utf8');
    existingTradeIds.add(tradeKey);
    appendedCount += 2;
  }

  console.log(`✓ Đã nạp thành công ${appendedCount / 2} vị thế mới vào ai_trade_dataset.jsonl`);

  // Chạy lại train_ai_model.py
  console.log('\n🔄 Đang chạy train_ai_model.py để cập nhật mô hình AI...');
  try {
    const pyOut = execSync('python scripts/train_ai_model.py', { encoding: 'utf8' });
    console.log(pyOut);
  } catch (err) {
    try {
      const py3Out = execSync('python3 scripts/train_ai_model.py', { encoding: 'utf8' });
      console.log(py3Out);
    } catch (e2) {
      console.error('Lỗi chạy train:', e2.message);
    }
  }
}

syncTrades().catch(console.error);
