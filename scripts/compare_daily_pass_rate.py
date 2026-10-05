# -*- coding: utf-8 -*-
import sys, re
from collections import defaultdict
sys.stdout.reconfigure(encoding='utf-8')

daily = defaultdict(lambda: {
    'eval': 0, 'veto': 0, 'app': 0, 
    'rr_veto': 0, 'low_prob': 0, 'counter_trend': 0, 
    'wick': 0, 'risk_inter': 0, 'storm': 0
})

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        if len(line) < 19 or line[:10] < '2026-09-24':
            continue
        day = line[:10]
        if '[AI Veto]' in line:
            daily[day]['eval'] += 1
            daily[day]['veto'] += 1
            if 'R:R không đạt chuẩn' in line or 'R:R < 1.0' in line:
                daily[day]['rr_veto'] += 1
            elif 'Xác suất thắng' in line:
                daily[day]['low_prob'] += 1
            elif 'CẢN TÀU XU HƯỚNG' in line or 'COUNTER_STRONG_TREND' in line:
                daily[day]['counter_trend'] += 1
            elif 'BẪY RÚT RÂU' in line or 'OPPOSING_WICK_TRAP' in line:
                daily[day]['wick'] += 1
            elif 'ĐÁNH GIÁ RỦI RO AI:' in line:
                daily[day]['risk_inter'] += 1
            elif 'BÃO NẾN CỰC ĐẠI' in line or 'EXTREME_STORM' in line:
                daily[day]['storm'] += 1
        elif 'Khuyên NÊN ĐẶT LỆNH' in line:
            daily[day]['eval'] += 1
            daily[day]['app'] += 1

print(f"{'NGÀY':10s} | {'TỔNG QUÉT':9s} | {'VETO':6s} | {'DUYỆT':5s} | {'TỶ LỆ DUYỆT':11s} | {'R:R < 1':7s} | {'LOW PROB':8s} | {'CẢN TÀU':7s} | {'RÚT RÂU':7s} | {'RISK INTER':10s} | {'BÃO NẾN':7s}")
print('-'*110)
for day in sorted(daily.keys()):
    d = daily[day]
    tot = d['eval']
    app = d['app']
    pct = (app / tot * 100) if tot else 0.0
    print(f"{day:10s} | {tot:9d} | {d['veto']:6d} | {app:5d} | {pct:10.2f}% | {d['rr_veto']:7d} | {d['low_prob']:8d} | {d['counter_trend']:7d} | {d['wick']:7d} | {d['risk_inter']:10d} | {d['storm']:7d}")
