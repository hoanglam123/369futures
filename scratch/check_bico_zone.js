const fs = require('fs');
const axios = require('axios');
const path = require('path');

const ssPath = path.join(__dirname, '..', 'data', 'step_sizes.json');
const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
const h4 = ss.h4Cache?.['BICO'];

async function checkBico() {
  const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BICOUSDT');
  const curPrice = parseFloat(ticker.data.price);

  function buildLevelGrid(upperPrice, lowerPrice, step, decimals, levelsRange = 35) {
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

  const grid = buildLevelGrid(h4.upperPrice, h4.lowerPrice, h4.step, h4.decimals, 35);
  const longEntry = grid.filter(l => l.type === 'tren' && l.value <= curPrice).pop();
  const shortEntry = grid.find(l => l.type === 'duoi' && l.value > (longEntry ? longEntry.value : curPrice));

  console.log('=== THÔNG SỐ GỐC H4 CỦA BICO ===');
  console.log('Open H4:', h4.openPrice);
  console.log('Close H4:', h4.closePrice);
  console.log('Upper Price (Gốc dãy TRÊN - LONG):', h4.upperPrice);
  console.log('Lower Price (Gốc dãy DƯỚI - SHORT):', h4.lowerPrice);
  console.log('Độ dày nến gốc x:', (Math.abs(h4.openPrice - h4.closePrice)).toFixed(5), '(' + ((Math.abs(h4.openPrice - h4.closePrice)/h4.openPrice)*100).toFixed(2) + '%)');
  console.log('Step (bước giá):', h4.step);
  console.log('Decimals:', h4.decimals);
  console.log('Giá hiện tại:', curPrice);

  console.log('\n=== CÁC MỐC GẦN GIÁ HIỆN TẠI (0.023 - 0.033) ===');
  const nearby = grid.filter(l => l.value >= curPrice * 0.88 && l.value <= curPrice * 1.12);
  nearby.forEach(l => {
    console.log('Tier ' + (l.tier >= 0 ? '+' : '') + l.tier + ': Mốc [' + (l.type === 'tren' ? 'TRÊN (LONG entry)' : 'DƯỚI (SHORT entry)') + '] = ' + l.value.toFixed(h4.decimals));
  });

  console.log('\n=== ZONE KẸP GIÁ HIỆN TẠI CỦA BICO ===');
  console.log(`- Mốc HỖ TRỢ DƯỚI (LONG entry - dãy 'tren'):  ${longEntry.value.toFixed(h4.decimals)} (Tier ${longEntry.tier >= 0 ? '+' : ''}${longEntry.tier})`);
  console.log(`- Mốc KHÁNG CỰ TRÊN (SHORT entry - dãy 'duoi'): ${shortEntry.value.toFixed(h4.decimals)} (Tier ${shortEntry.tier >= 0 ? '+' : ''}${shortEntry.tier})`);
  const diff = shortEntry.value - longEntry.value;
  const pct = (diff / longEntry.value) * 100;
  console.log(`- Độ rộng Range/Zone kẹp giá: ${longEntry.value.toFixed(h4.decimals)} -> ${shortEntry.value.toFixed(h4.decimals)} (Chênh lệch: ${diff.toFixed(h4.decimals)} hay ~${pct.toFixed(2)}%)`);
}

checkBico().catch(console.error);
