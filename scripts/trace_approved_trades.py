# -*- coding: utf-8 -*-
import sys, re, os
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

START_TIME = "2026-09-24 09:10:00"

# Parse the entire log chronologically
events_by_symbol = {}
all_lines = []

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        if len(line) < 19:
            continue
        line_time = line[:19]
        if line_time < START_TIME:
            continue
        all_lines.append((line_time, line))

print(f"Total lines after {START_TIME}: {len(all_lines):,}")

# Let's find all AI approvals
approved_trades = []
for t, line in all_lines:
    if "Khuyên NÊN ĐẶT LỆNH" in line:
        m = re.search(r"NÊN ĐẶT LỆNH (\w+)\s*\((LONG|SHORT)\)[^-]+- Xác suất thắng ([\d\.]+)%", line)
        if m:
            approved_trades.append({
                'time': t,
                'symbol': m.group(1),
                'side': m.group(2),
                'prob': float(m.group(3)),
                'raw': line.strip()
            })

print(f"Total Approved Trades: {len(approved_trades)}")

# For each approved trade, search subsequent lines for what happened
results = []
for i, trade in enumerate(approved_trades):
    sym = trade['symbol']
    t_start = trade['time']
    side = trade['side']
    
    # Track status
    placed = False
    place_price = None
    filled = False
    fill_time = None
    cancelled = False
    cancel_reason = None
    exited = False
    exit_type = None
    exit_time = None
    exit_pnl = None
    exit_roi = None
    trailing_triggered = False
    partial_tp = False
    
    # We look for lines for this symbol from t_start until either the next approval of same symbol or up to 24h
    found_lines = []
    for t, line in all_lines:
        if t < t_start:
            continue
        # If this is another approval of the SAME symbol later, stop
        if t > t_start and "Khuyên NÊN ĐẶT LỆNH " + sym in line:
            break
            
        # Check order placed
        if f"Đặt lệnh LIMIT thành công cho {sym}" in line:
            placed = True
            m = re.search(r"giá \$([\d\.]+)", line)
            if m: place_price = float(m.group(1))
            found_lines.append((t, "PLACED", line.strip()))
            
        # Check limit cancelled
        elif f"Hủy lệnh LIMIT {sym}" in line or f"HỦY LỆNH LIMIT {sym}" in line or f"Hết thời gian chờ khớp LIMIT {sym}" in line:
            cancelled = True
            found_lines.append((t, "CANCELLED", line.strip()))
            
        # Check fill
        elif f"Coin: {sym} ({side})" in line and "Lệnh LIMIT đã khớp thành công" in line:
            filled = True
            fill_time = t
            found_lines.append((t, "FILLED", line.strip()))
        elif f"[AutoTrade] Đã khớp lệnh LIMIT {sym}" in line or f"vị thế {sym} đã khớp" in line:
            filled = True
            fill_time = t
            found_lines.append((t, "FILLED", line.strip()))
            
        # Check partial TP
        elif f"[Partial TP] {sym} chạm mốc" in line:
            partial_tp = True
            found_lines.append((t, "PARTIAL_TP", line.strip()))
            
        # Check trailing SL
        elif f"Trailing SL (chạm mốc" in line and f": {sym} đạt ROI" in line:
            trailing_triggered = True
            found_lines.append((t, "TRAILING_SL", line.strip()))
            
        # Check Virtual TP
        elif f"[Virtual TP" in line and f"Kích hoạt cho {sym}:" in line:
            exited = True
            exit_type = "VIRTUAL_TP"
            exit_time = t
            m = re.search(r"ROI ~?([\d\.\-]+)%", line)
            if m: exit_roi = float(m.group(1))
            found_lines.append((t, "VIRTUAL_TP", line.strip()))
            
        # Check SL hit
        elif f"Đưa {sym} vào Cooldown 8 giờ do" in line:
            exited = True
            exit_time = t
            m = re.search(r"PnL:\s*\$([\d\.\-]+).*ROI:\s*([\d\.\-]+)%", line)
            if m:
                exit_pnl = float(m.group(1))
                exit_roi = float(m.group(2))
            exit_type = "SL_LOSS"
            found_lines.append((t, "SL_LOSS", line.strip()))
            
        # Check Virtual SL
        elif f"[Virtual Stop Loss] Kích hoạt cho {sym}:" in line:
            exited = True
            exit_time = t
            exit_type = "VIRTUAL_SL"
            found_lines.append((t, "VIRTUAL_SL", line.strip()))
            
        # Check Hard Max Loss
        elif f"[Hard Max Loss Guard] Kích hoạt cho {sym}:" in line:
            exited = True
            exit_time = t
            exit_type = "HARD_LOSS"
            found_lines.append((t, "HARD_LOSS", line.strip()))

    trade['placed'] = placed
    trade['filled'] = filled
    trade['cancelled'] = cancelled
    trade['fill_time'] = fill_time
    trade['trailing'] = trailing_triggered
    trade['partial_tp'] = partial_tp
    trade['exited'] = exited
    trade['exit_type'] = exit_type
    trade['exit_time'] = exit_time
    trade['exit_pnl'] = exit_pnl
    trade['exit_roi'] = exit_roi
    trade['found_lines'] = found_lines
    results.append(trade)

print("\n================================================================================")
print(f"CHI TIẾT 48 TÍN HIỆU ĐƯỢC AI PHÊ DUYỆT:")
print("================================================================================")
for idx, r in enumerate(results, 1):
    status = "UNKNOWN"
    if not r['filled']:
        status = "KHÔNG KHỚP (HỦY/TIMEOUT)" if r['cancelled'] else "KHÔNG KHỚP"
    else:
        if r['exit_type'] == 'SL_LOSS' or r['exit_type'] == 'VIRTUAL_SL' or r['exit_type'] == 'HARD_LOSS':
            status = f"THUA (SL): PnL={r['exit_pnl']} ROI={r['exit_roi']}%"
        elif r['exit_type'] == 'VIRTUAL_TP':
            status = f"THẮNG (TP): ROI={r['exit_roi']}%"
        elif r['trailing']:
            status = f"THẮNG/HÒA (Trailing SL/BE triggered)"
        else:
            status = "ĐANG CHẠY / ĐÓNG TRÊN SÀN"
            
    print(f"{idx:2d}. [{r['time']}] {r['symbol']:8s} {r['side']:5s} (AI Prob: {r['prob']}%) -> {status}")
    if r['trailing']:
        print(f"    ↳ Đã chạm Trailing BE/Khóa lãi! PartialTP: {r['partial_tp']}")
    if r['exit_type']:
        print(f"    ↳ Exit Type: {r['exit_type']} lúc {r['exit_time']}")
