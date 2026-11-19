const fs = require('fs');

function roundToTick(val, tickSize, isUp) {
  const factor = 1 / tickSize;
  return isUp ? Math.ceil(val * factor) / factor : Math.floor(val * factor) / factor;
}

function calculateAllProposals(sym, side, entryPrice, tickSize, rank, swHigh, swLow, atr14H1, step369) {
  const isLong = (side === 'LONG');
  const minSlPct = (sym === 'BTC' || sym === 'ETH' || rank <= 50) ? 1.3 : 1.8;
  
  console.log('========================================================================');
  console.log('BÁO CÁO TÍNH TOÁN: ' + sym + ' (' + side + ') @ Entry $' + entryPrice);
  console.log('Rank: #' + rank + ' | Min SL: ' + minSlPct + '% | TickSize: ' + tickSize);
  console.log('ATR(14, H1): ' + atr14H1.toFixed(6) + ' (' + (atr14H1/entryPrice*100).toFixed(2) + '%) | Step 369: ' + step369 + ' (' + (step369/entryPrice*100).toFixed(2) + '%)');
  console.log('Sóng H1: Swing High = $' + swHigh + ' | Swing Low = $' + swLow);
  console.log('------------------------------------------------------------------------');

  // --- 0. LOGIC HIỆN TẠI (Hard 3.5% Cap) ---
  const oldSlDist = entryPrice * 0.035;
  const oldSlPrice = isLong ? (entryPrice - oldSlDist) : (entryPrice + oldSlDist);
  const oldSlRounded = isLong ? roundToTick(oldSlPrice, tickSize, false) : roundToTick(oldSlPrice, tickSize, true);
  const oldSlActualDist = Math.abs(entryPrice - oldSlRounded);
  const oldSlActualPct = (oldSlActualDist / entryPrice) * 100;
  const oldTpDist = oldSlActualDist * 1.50;
  const oldTpPrice = isLong ? (entryPrice + oldTpDist) : (entryPrice - oldTpDist);
  const oldTpRounded = isLong ? roundToTick(oldTpPrice, tickSize, true) : roundToTick(oldTpPrice, tickSize, false);
  const oldTpActualPct = (Math.abs(entryPrice - oldTpRounded) / entryPrice) * 100;

  console.log('[HIỆN TẠI - HARD CAP 3.5%]');
  console.log('  SL: $' + oldSlRounded + ' (-' + oldSlActualPct.toFixed(2) + '%) | TP (1.5R): $' + oldTpRounded + ' (+' + oldTpActualPct.toFixed(2) + '%)');

  // --- ĐỀ XUẤT 1: FIBONACCI RETRACEMENT SÓNG H1 (0.786 / 1.000 + Buffer 0.2%) ---
  let p1RawSl;
  let p1Reason = '';
  const waveRange = swHigh - swLow;
  if (isLong) {
    const fib786 = swHigh - 0.786 * waveRange;
    if (entryPrice > fib786) {
      p1RawSl = fib786 - entryPrice * 0.002;
      p1Reason = 'Nép sau Fib 0.786 ($' + fib786.toFixed(6) + ') - đệm 0.2%';
    } else {
      p1RawSl = swLow - entryPrice * 0.002;
      p1Reason = 'Entry sát đáy sóng -> Nép sau Đáy sóng Fib 1.0 ($' + swLow.toFixed(6) + ') - đệm 0.2%';
    }
  } else {
    const fib786 = swLow + 0.786 * waveRange;
    if (entryPrice < fib786) {
      p1RawSl = fib786 + entryPrice * 0.002;
      p1Reason = 'Nép sau Fib 0.786 ($' + fib786.toFixed(6) + ') + đệm 0.2%';
    } else {
      p1RawSl = swHigh + entryPrice * 0.002;
      p1Reason = 'Entry sát đỉnh sóng -> Nép sau Đỉnh sóng Fib 1.0 ($' + swHigh.toFixed(6) + ') + đệm 0.2%';
    }
  }
  // Check min safety floor
  let p1Dist = Math.abs(entryPrice - p1RawSl);
  let p1FloorApplied = false;
  if (p1Dist < entryPrice * (minSlPct / 100)) {
    p1Dist = entryPrice * (minSlPct / 100);
    p1RawSl = isLong ? (entryPrice - p1Dist) : (entryPrice + p1Dist);
    p1FloorApplied = true;
  }
  const p1SlRounded = isLong ? roundToTick(p1RawSl, tickSize, false) : roundToTick(p1RawSl, tickSize, true);
  const p1SlActualDist = Math.abs(entryPrice - p1SlRounded);
  const p1SlPct = (p1SlActualDist / entryPrice) * 100;
  const p1TpDist = p1SlActualDist * 1.50;
  const p1TpPrice = isLong ? (entryPrice + p1TpDist) : (entryPrice - p1TpDist);
  const p1TpRounded = isLong ? roundToTick(p1TpPrice, tickSize, true) : roundToTick(p1TpPrice, tickSize, false);
  const p1TpPct = (Math.abs(entryPrice - p1TpRounded) / entryPrice) * 100;

  console.log('\n[ĐỀ XUẤT 1 - FIBONACCI RETRACEMENT SÓNG H1 (0.786 / 1.000)]');
  console.log('  Cơ sở: ' + p1Reason + (p1FloorApplied ? ' (Áp sàn an toàn min ' + minSlPct + '%)' : ''));
  console.log('  SL: $' + p1SlRounded + ' (-' + p1SlPct.toFixed(2) + '%) | TP (1.5R): $' + p1TpRounded + ' (+' + p1TpPct.toFixed(2) + '%) | R:R: 1.50');

  // --- ĐỀ XUẤT 2: FIBONACCI HARMONIC BƯỚC GIÁ 369 STEP ---
  [0.382, 0.618].forEach(fibRatio => {
    let p2Dist = fibRatio * step369;
    let floorApplied = false;
    if (p2Dist < entryPrice * (minSlPct / 100)) {
      p2Dist = entryPrice * (minSlPct / 100);
      floorApplied = true;
    }
    const p2RawSl = isLong ? (entryPrice - p2Dist) : (entryPrice + p2Dist);
    const p2SlRounded = isLong ? roundToTick(p2RawSl, tickSize, false) : roundToTick(p2RawSl, tickSize, true);
    const p2SlActualDist = Math.abs(entryPrice - p2SlRounded);
    const p2SlPct = (p2SlActualDist / entryPrice) * 100;
    const p2TpDist = p2SlActualDist * 1.50;
    const p2TpPrice = isLong ? (entryPrice + p2TpDist) : (entryPrice - p2TpDist);
    const p2TpRounded = isLong ? roundToTick(p2TpPrice, tickSize, true) : roundToTick(p2TpPrice, tickSize, false);
    const p2TpPct = (Math.abs(entryPrice - p2TpRounded) / entryPrice) * 100;

    console.log('\n[ĐỀ XUẤT 2 - FIBONACCI HARMONIC STEP (' + fibRatio + 'x STEP)]');
    console.log('  Khoảng cách SL: ' + fibRatio + ' * ' + step369 + ' = $' + (fibRatio*step369).toFixed(6) + (floorApplied ? ' (Áp sàn min ' + minSlPct + '%)' : ''));
    console.log('  SL: $' + p2SlRounded + ' (-' + p2SlPct.toFixed(2) + '%) | TP (1.5R): $' + p2TpRounded + ' (+' + p2TpPct.toFixed(2) + '%) | R:R: 1.50');
  });

  // --- ĐỀ XUẤT 3: FIBONACCI GOLDEN ATR (1.618x ATR) ---
  let p3Dist = 1.618 * atr14H1;
  let floorP3 = false;
  if (p3Dist < entryPrice * (minSlPct / 100)) {
    p3Dist = entryPrice * (minSlPct / 100);
    floorP3 = true;
  }
  const p3RawSl = isLong ? (entryPrice - p3Dist) : (entryPrice + p3Dist);
  const p3SlRounded = isLong ? roundToTick(p3RawSl, tickSize, false) : roundToTick(p3RawSl, tickSize, true);
  const p3SlActualDist = Math.abs(entryPrice - p3SlRounded);
  const p3SlPct = (p3SlActualDist / entryPrice) * 100;
  const p3TpDist = p3SlActualDist * 1.50;
  const p3TpPrice = isLong ? (entryPrice + p3TpDist) : (entryPrice - p3TpDist);
  const p3TpRounded = isLong ? roundToTick(p3TpPrice, tickSize, true) : roundToTick(p3TpPrice, tickSize, false);
  const p3TpPct = (Math.abs(entryPrice - p3TpRounded) / entryPrice) * 100;

  console.log('\n[ĐỀ XUẤT 3 - FIBONACCI GOLDEN ATR (1.618x ATR)]');
  console.log('  Khoảng cách SL: 1.618 * ' + atr14H1.toFixed(6) + ' = $' + p3Dist.toFixed(6) + ' (' + (p3Dist/entryPrice*100).toFixed(2) + '%)' + (floorP3 ? ' (Áp sàn min ' + minSlPct + '%)' : ''));
  console.log('  SL: $' + p3SlRounded + ' (-' + p3SlPct.toFixed(2) + '%) | TP (1.5R): $' + p3TpRounded + ' (+' + p3TpPct.toFixed(2) + '%) | R:R: 1.50');
}

// Chạy cho ICNT (SHORT @ 0.3403)
calculateAllProposals('ICNT', 'SHORT', 0.3403, 0.0001, 299, 0.3523, 0.3133, 0.013158, 0.03);

// Chạy cho SOLV (LONG @ 0.0041) với tickSize thực tế 0.000001 (6 số lẻ)
calculateAllProposals('SOLV', 'LONG', 0.0041, 0.000001, 521, 0.004358, 0.004080, 0.000069, 0.0003);
