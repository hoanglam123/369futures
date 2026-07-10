const fs = require('fs');
const path = require('path');
const axios = require('axios');

const FILE_PATH = path.join(process.cwd(), 'data', 'step_sizes.json');
const YEAR_START_MS = 1767225600000; // 01/01/2026 00:00:00 UTC

async function cleanup() {
  if (!fs.existsSync(FILE_PATH)) {
    console.log('No step_sizes.json found.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
  const h4Cache = data.h4Cache || {};
  const symbols = Object.keys(h4Cache);

  console.log(`Checking ${symbols.length} cached H4 symbols...`);
  let updated = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const entry = h4Cache[sym];

    if (entry.failed) continue;

    try {
      const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=4h&startTime=${YEAR_START_MS}&limit=1`, { timeout: 5000 });
      const candles = res.data;

      if (!candles?.length || candles[0][0] !== YEAR_START_MS) {
        const actualTime = candles?.length ? new Date(candles[0][0]).toISOString() : 'N/A';
        console.log(`[Clean] Excluding ${sym}: first H4 candle is ${actualTime} (expected 2026-01-01)`);
        h4Cache[sym] = {
          yearStart: YEAR_START_MS,
          failed: true,
          reason: `Không có nến H4 ngày 01/01/2026 (Nến đầu: ${actualTime})`,
          updatedAt: Date.now()
        };
        updated++;
      }
    } catch (err) {
      console.warn(`[Warn] Error checking ${sym}: ${err.message}`);
    }

    // 100ms delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  if (updated > 0) {
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[Success] Cleaned up and updated ${updated} symbols in step_sizes.json.`);
  } else {
    console.log('All symbols are valid. No updates needed.');
  }
}

cleanup();
