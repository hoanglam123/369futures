# -*- coding: utf-8 -*-
import sys, re, os
from collections import defaultdict
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

START_TIME = "2026-09-24 09:10:00"

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    lines = [line.strip() for line in f if len(line) >= 19 and line[:19] >= START_TIME]

print(f"Loaded {len(lines):,} log lines from {START_TIME}")

# Daily stats tracker
days = defaultdict(lambda: {
    'total_eval': 0,
    'vetoed': 0,
    'approved': 0,
    'filled': 0,
    'wins': 0,
    'losses': 0,
    'long_wins': 0,
    'long_losses': 0,
    'short_wins': 0,
    'short_losses': 0,
    'pnl_usd': 0.0,
    'trades': []
})

# Let's extract all approved signals and trace them precisely
approved_map = {} # (symbol, date) -> trade info
current_approved = None

# We can associate trades with approval
for line in lines:
    t = line[:19]
    day = t[:10]
    
    if "[AI Veto]" in line:
        days[day]['total_eval'] += 1
        days[day]['vetoed'] += 1
        
    elif "Khuyên NÊN ĐẶT LỆNH" in line:
        days[day]['total_eval'] += 1
        days[day]['approved'] += 1
        m = re.search(r"NÊN ĐẶT LỆNH (\w+)\s*\((LONG|SHORT)\)[^-]+- Xác suất thắng ([\d\.]+)%", line)
        if m:
            sym, side, prob = m.group(1), m.group(2), float(m.group(3))
            trade_obj = {
                'id': f"{sym}_{t}",
                'sym': sym,
                'side': side,
                'prob': prob,
                'time': t,
                'day': day,
                'filled': False,
                'status': 'UNFILLED',
                'pnl': 0.0,
                'roi': 0.0
            }
            approved_map[trade_obj['id']] = trade_obj

# Now let's trace fill and exits
# We match each symbol sequentially
active_sym_trades = defaultdict(list)
for t_id, tr in sorted(approved_map.items(), key=lambda x: x[1]['time']):
    active_sym_trades[tr['sym']].append(tr)

# Trace line by line
for sym, tr_list in active_sym_trades.items():
    for tr in tr_list:
        start_t = tr['time']
        # Find subsequent lines for this symbol
        partial_tp = False
        trailing = False
        sl_hit = False
        virtual_tp = False
        pnl = 0.0
        roi = 0.0
        filled = False
        
        for line in lines:
            t = line[:19]
            if t < start_t:
                continue
            # If line is about another approval of the same symbol after this one, stop
            if t > start_t and f"NÊN ĐẶT LỆNH {sym}" in line:
                break
                
            if f"Trailing SL (chạm mốc" in line and f": {sym} đạt ROI" in line:
                filled = True
                trailing = True
                m = re.search(r"đạt ROI ([\d\.\-]+)%", line)
                if m: roi = max(roi, float(m.group(1)))
                
            if f"[Partial TP] {sym} chạm mốc" in line:
                filled = True
                partial_tp = True
                m = re.search(r"lãi ước tính \+\$([\d\.\-]+) USDT", line)
                if m: pnl += float(m.group(1))
                
            if f"[Virtual TP" in line and f"Kích hoạt cho {sym}:" in line:
                filled = True
                virtual_tp = True
                m = re.search(r"ROI ~?([\d\.\-]+)%", line)
                if m: roi = float(m.group(1))
                
            if f"Đưa {sym} vào Cooldown 8 giờ do" in line:
                filled = True
                sl_hit = True
                m = re.search(r"PnL:\s*\$([\d\.\-]+).*ROI:\s*([\d\.\-]+)%", line)
                if m:
                    pnl = float(m.group(1))
                    roi = float(m.group(2))
                    
        tr['filled'] = filled
        tr['trailing'] = trailing
        tr['partial_tp'] = partial_tp
        tr['virtual_tp'] = virtual_tp
        tr['sl_hit'] = sl_hit
        tr['pnl'] = pnl
        tr['roi'] = roi
        
        if filled:
            if sl_hit:
                tr['status'] = 'LOSS'
            elif virtual_tp or trailing or partial_tp:
                tr['status'] = 'WIN'
            else:
                tr['status'] = 'RUNNING/UNKNOWN'
        else:
            tr['status'] = 'CANCELLED'

# Aggregate into days
for tr in approved_map.values():
    d = days[tr['day']]
    d['trades'].append(tr)
    if tr['filled']:
        d['filled'] += 1
        d['pnl_usd'] += tr['pnl']
        if tr['status'] == 'WIN':
            d['wins'] += 1
            if tr['side'] == 'LONG': d['long_wins'] += 1
            else: d['short_wins'] += 1
        elif tr['status'] == 'LOSS':
            d['losses'] += 1
            if tr['side'] == 'LONG': d['long_losses'] += 1
            else: d['short_losses'] += 1

print("\n" + "="*80)
print(f"{'NGÀY':10s} | {'EVAL':5s} | {'VETO %':7s} | {'KÈO DUYỆT':9s} | {'KHỚP':5s} | {'WIN':4s} | {'LOSS':4s} | {'WIN RATE':8s} | {'PNL (USDT)'}")
print("="*80)

total_eval = 0
total_veto = 0
total_app = 0
total_fill = 0
total_w = 0
total_l = 0
total_pnl = 0.0

for day in sorted(days.keys()):
    d = days[day]
    eval_c = d['total_eval']
    veto_c = d['vetoed']
    veto_pct = (veto_c / eval_c * 100) if eval_c else 0
    app_c = d['approved']
    fill_c = d['filled']
    w_c = d['wins']
    l_c = d['losses']
    wr = (w_c / (w_c + l_c) * 100) if (w_c + l_c) else 0.0
    pnl = d['pnl_usd']
    
    total_eval += eval_c
    total_veto += veto_c
    total_app += app_c
    total_fill += fill_c
    total_w += w_c
    total_l += l_c
    total_pnl += pnl
    
    print(f"{day:10s} | {eval_c:5d} | {veto_pct:6.1f}% | {app_c:9d} | {fill_c:5d} | {w_c:4d} | {l_c:4d} | {wr:7.1f}% | ${pnl:+7.2f}")

print("="*80)
tot_wr = (total_w / (total_w + total_l) * 100) if (total_w + total_l) else 0.0
tot_veto_pct = (total_veto / total_eval * 100) if total_eval else 0.0
print(f"{'TỔNG CỘNG':10s} | {total_eval:5d} | {tot_veto_pct:6.1f}% | {total_app:9d} | {total_fill:5d} | {total_w:4d} | {total_l:4d} | {tot_wr:7.1f}% | ${total_pnl:+7.2f}")
print("="*80)

# Long vs Short
all_filled = [tr for tr in approved_map.values() if tr['filled']]
longs = [tr for tr in all_filled if tr['side'] == 'LONG']
shorts = [tr for tr in all_filled if tr['side'] == 'SHORT']

long_w = len([tr for tr in longs if tr['status'] == 'WIN'])
long_l = len([tr for tr in longs if tr['status'] == 'LOSS'])
short_w = len([tr for tr in shorts if tr['status'] == 'WIN'])
short_l = len([tr for tr in shorts if tr['status'] == 'LOSS'])

print(f"\nPhân bố theo chiều giao dịch:")
print(f"  • LONG : {len(longs)} lệnh khớp -> {long_w} Win / {long_l} Loss -> Win Rate: {(long_w/(long_w+long_l)*100 if longs else 0):.1f}%")
print(f"  • SHORT: {len(shorts)} lệnh khớp -> {short_w} Win / {short_l} Loss -> Win Rate: {(short_w/(short_w+short_l)*100 if shorts else 0):.1f}%")
