const fs = require('fs');
const axios = require('axios');
const path = require('path');

const ssPath = path.join(__dirname, '..', 'data', 'step_sizes.json');
let ss = {};
if (fs.existsSync(ssPath)) {
  ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
}

async function checkBless() {
  const symbol = 'BLESS';
  let h4 = ss.h4Cache?.[symbol];

  if (!h4) {
    // If not in file cache, fetch 4h kline from 2026-01-01
    const YEAR_START_MS = Date.UTC(2026, 0, 1);
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: 'BLESSUSDT', interval: '4h', startTime: YEAR_START_MS, limit: 2 }
    });
    const first = res.data[0];
    const openPrice = parseFloat(first[1]);
    const closePrice = parseFloat(first[4]);

    function getBaseUnit(price) {
      if (price >= 10000) return 1000;
      if (price >= 1000) return 100;
      if (price >= 100) return 10;
      if (price >= 10) return 1;
      if (price >= 1) return 0.1;
      if (price >= 0.2) return 0.01;
      if (price >= 0.02) return 0.001;
      if (price >= 0.002) return 0.0001;
      return 0.00001;
    }
    const unit = getBaseUnit(openPrice);
    const step = Math.round(3 * unit * 1e8) / 1e8;
    const decimals = openPrice >= 100 ? 2 : (openPrice >= 10 ? 3 : (openPrice >= 1 ? 4 : (openPrice >= 0.2 ? 4 : (openPrice >= 0.02 ? 5 : 6))));

    h4 = {
      openPrice,
      closePrice,
      step,
      decimals,
      upperPrice: Math.max(openPrice, closePrice),
      lowerPrice: Math.min(openPrice, closePrice),
    };
  }

  const tickerRes = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BLESSUSDT');
  const curPrice = parseFloat(tickerRes.data.price);

  function buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange = 30) {
    const grid = [];
    for (let i = -levelsRange; i <= levelsRange; i++) {
      const offset = i * step;
      grid.push({
        value: parseFloat((upperPrice + offset).toFixed(decimals)),
        type: 'tren',
        tier: i,
      });
      grid.push({
        value: parseFloat((lowerPrice + offset).toFixed(decimals)),
        type: 'duoi',
        tier: i,
      });
    }
    grid.sort((a, b) => a.value - b.value || (a.type === 'tren' ? -1 : 1));
    return grid.filter((v, i, arr) =>
      i === 0 || !(v.value === arr[i - 1].value && v.type === arr[i - 1].type)
    );
  }

  const grid = buildLevelGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 40);

  const longEntry = grid.filter(l => l.type === 'tren' && l.value <= curPrice).pop();
  const shortEntry = grid.find(l => l.type === 'duoi' && l.value > (longEntry ? longEntry.value : curPrice));

  console.log('=== THÔNG SỐ GỐC H4 CỦA BLESS ===');
  console.log(`Open H4:  ${h4.openPrice}`);
  console.log(`Close H4: ${h4.closePrice}`);
  console.log(`Upper (max Open/Close): ${h4.upperPrice}`);
  console.log(`Lower (min Open/Close): ${h4.lowerPrice}`);
  console.log(`Step (bước giá): ${h4.step}`);
  console.log(`Decimals: ${h4.decimals}`);
  console.log(`Giá hiện tại: ${curPrice}\n`);

  console.log('=== CÁC MỐC QUANH GIÁ HIỆN TẠI ===');
  const nearby = grid.filter(l => l.value >= curPrice * 0.88 && l.value <= curPrice * 1.12);
  nearby.forEach(l => {
    console.log(`Tier ${l.tier >= 0 ? '+' : ''}${l.tier}: Mốc [${l.type === 'tren' ? 'TRÊN (LONG entry)' : 'DƯỚI (SHORT entry)'}] = ${l.value.toFixed(h4.decimals)}`);
  });

  console.log('\n=== ZONE / CẶP MỐC KẸP GIÁ HIỆN TẠI CỦA BLESS ===');
  console.log(`- Mốc HỖ TRỢ DƯỚI (LONG entry - dãy 'tren'):  ${longEntry.value.toFixed(h4.decimals)} (Tier ${longEntry.tier >= 0 ? '+' : ''}${longEntry.tier})`);
  console.log(`- Mốc KHÁNG CỰ TRÊN (SHORT entry - dãy 'duoi'): ${shortEntry.value.toFixed(h4.decimals)} (Tier ${shortEntry.tier >= 0 ? '+' : ''}${shortEntry.tier})`);
  const diff = shortEntry.value - longEntry.value;
  const pct = (diff / longEntry.value) * 100;
  console.log(`- Độ rộng Range/Zone kẹp giá: ${longEntry.value.toFixed(h4.decimals)} -> ${shortEntry.value.toFixed(h4.decimals)} (Chênh lệch: ${diff.toFixed(h4.decimals)} hay ~${pct.toFixed(2)}%)`);
}

checkBless().catch(console.error);
