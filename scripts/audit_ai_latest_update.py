# -*- coding: utf-8 -*-
import sys, re, os, json
from collections import defaultdict
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

UPDATE_TIME = "2026-10-01 11:12:28"

print("="*80)
print(f"🔍 BÁO CÁO TOÀN DIỆN RÀ SOÁT AI TỪ LẦN CẬP NHẬT GẦN NHẤT")
print(f"⏰ Mốc thời gian cập nhật: {UPDATE_TIME} -> Hiện tại (2026-10-05 09:00:00)")
print("="*80)

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    lines = [line.strip() for line in f if len(line) >= 19 and line[:19] >= UPDATE_TIME]

print(f"\n📂 Tổng số dòng log đã nạp kể từ cập nhật: {len(lines):,} dòng")

# 1. AI Decision Analysis
total_eval = 0
ai_veto = 0
ai_approved = 0

veto_categories = defaultdict(int)
veto_reasons_detail = defaultdict(int)
approved_signals = [] # list of (time, sym, side, prob, score, rank, raw_line)

for line in lines:
    t = line[:19]
    if "[AI Veto]" in line:
        total_eval += 1
        ai_veto += 1
        
        # Categorize
        if "CẢN TÀU XU HƯỚNG" in line or "COUNTER_STRONG_TREND_DANGER" in line:
            cat = "COUNTER_STRONG_TREND (Ngược Trend mạnh)"
        elif "BẪY RÚT RÂU" in line or "OPPOSING_WICK_TRAP" in line:
            cat = "OPPOSING_WICK_TRAP (Bẫy rút râu)"
        elif "BÃO NẾN CỰC ĐẠI" in line or "EXTREME_STORM" in line:
            cat = "EXTREME_STORM (Biến động bão nến)"
        elif "R:R không đạt chuẩn" in line or "R:R < 1.0" in line:
            cat = "POOR_RISK_REWARD (R:R < 1.0:1)"
        elif "ĐÁNH GIÁ RỦI RO AI:" in line:
            m = re.search(r"ĐÁNH GIÁ RỦI RO AI:\s*(\w+)", line)
            cat = f"RISK_INTERACTION ({m.group(1)})" if m else "RISK_INTERACTION"
        elif "Xác suất thắng" in line:
            cat = "LOW_WIN_PROBABILITY (Dưới ngưỡng sàn winProb)"
        else:
            cat = "OTHER_VETO"
        veto_categories[cat] += 1
        
    elif "Khuyên NÊN ĐẶT LỆNH" in line:
        total_eval += 1
        ai_approved += 1
        # Extract details
        m = re.search(r"NÊN ĐẶT LỆNH (\w+)\s*\((LONG|SHORT)\)[^-]+- Xác suất thắng ([\d\.]+)%", line)
        score_m = re.search(r"Score:\s*([+\-\d\.]+)đ", line)
        rank_m = re.search(r"Rank\s*#(\d+)", line)
        
        sym = m.group(1) if m else "UNKNOWN"
        side = m.group(2) if m else "UNKNOWN"
        prob = float(m.group(3)) if m else 0.0
        score = float(score_m.group(1)) if score_m else 0.0
        rank = int(rank_m.group(1)) if rank_m else 999
        
        approved_signals.append({
            'time': t,
            'sym': sym,
            'side': side,
            'prob': prob,
            'score': score,
            'rank': rank,
            'raw': line
        })

print(f"\n1️⃣ THỐNG KÊ TỔNG QUAN AI REVIEWER:")
print(f"   • Tổng số tín hiệu hệ thống quét & gửi sang AI: {total_eval:,} tín hiệu")
print(f"   • Số tín hiệu AI VETO (Loại bỏ rủi ro):           {ai_veto:,} ({ai_veto/total_eval*100:.2f}%)")
print(f"   • Số tín hiệu AI PHÊ DUYỆT (Khuyên đặt lệnh):      {ai_approved:,} ({ai_approved/total_eval*100:.2f}%)")

print(f"\n2️⃣ PHÂN BỐ LÝ DO AI VETO:")
for cat, cnt in sorted(veto_categories.items(), key=lambda x: -x[1]):
    print(f"   • {cat:45s}: {cnt:5d} ({cnt/ai_veto*100:5.1f}%)")

# Daily Breakdown
daily_stats = defaultdict(lambda: {'eval': 0, 'veto': 0, 'app': 0})
for line in lines:
    t = line[:19]
    day = t[:10]
    if "[AI Veto]" in line:
        daily_stats[day]['eval'] += 1
        daily_stats[day]['veto'] += 1
    elif "Khuyên NÊN ĐẶT LỆNH" in line:
        daily_stats[day]['eval'] += 1
        daily_stats[day]['app'] += 1

print(f"\n3️⃣ DIỄN BIẾN PHÊ DUYỆT THEO NGÀY:")
print(f"   {'Ngày':10s} | {'Tổng quét':9s} | {'VETO':6s} | {'Tỷ lệ Veto':10s} | {'Duyệt lệnh':10s}")
print(f"   " + "-"*56)
for day in sorted(daily_stats.keys()):
    ds = daily_stats[day]
    vpct = ds['veto']/ds['eval']*100 if ds['eval'] else 0
    print(f"   {day:10s} | {ds['eval']:9d} | {ds['veto']:6d} | {vpct:9.1f}% | {ds['app']:10d}")

# Tracing Real Executed Orders
# Track Limit Orders, Fills, Exits
placed_orders = [] # (time, sym, side, price)
filled_orders = [] # (time, sym, side, price)
cancelled_orders = [] # (time, sym)
exits = [] # (time, sym, exit_type, pnl, roi, reason)

for line in lines:
    t = line[:19]
    if "Đặt lệnh LIMIT thành công cho" in line:
        m = re.search(r"cho (\w+)\s*\((BUY|SELL)\)\s*giá \$([\d\.]+)", line)
        if m:
            placed_orders.append((t, m.group(1), 'LONG' if m.group(2)=='BUY' else 'SHORT', float(m.group(3))))
            
    elif "Lệnh LIMIT đã khớp thành công" in line:
        m = re.search(r"Coin:\s*(\w+)\s*\((LONG|SHORT)\)", line)
        p_m = re.search(r"Giá khớp:\s*\$([\d\.]+)", line)
        if m:
            sym = m.group(1)
            side = m.group(2)
            px = float(p_m.group(1)) if p_m else 0.0
            filled_orders.append((t, sym, side, px))
            
    elif "Hủy lệnh LIMIT" in line or "Hết thời gian chờ" in line:
        m = re.search(r"LIMIT[^\w]*(\w+)", line)
        if m:
            cancelled_orders.append((t, m.group(1)))

print(f"\n4️⃣ THỰC THI LỆNH THỰC TẾ TRÊN SÀN (REAL TRADES):")
print(f"   • Lệnh Limit được tạo: {len(placed_orders)}")
print(f"   • Lệnh Limit đã khớp:   {len(filled_orders)}")

# Detailed tracking of each filled order
print(f"\n   Chi tiết các lệnh đã khớp:")
for f_time, sym, side, px in filled_orders:
    print(f"   • [{f_time}] {sym:10s} {side:5s} @ ${px}")

# Trace outcomes of each filled position
trades_performance = []

for f_time, sym, side, px in filled_orders:
    # search subsequent lines for this coin
    tr_res = {
        'fill_time': f_time,
        'sym': sym,
        'side': side,
        'entry_price': px,
        'exit_time': None,
        'exit_type': 'STILL_OPEN',
        'roi': 0.0,
        'pnl': 0.0,
        'max_roi': 0.0,
        'notes': []
    }
    
    for line in lines:
        t = line[:19]
        if t < f_time:
            continue
            
        # Trailing SL update
        if f"Trailing SL (chạm mốc" in line and f": {sym} đạt ROI" in line:
            m = re.search(r"đạt ROI ([\d\.\-]+)%", line)
            if m:
                cur_roi = float(m.group(1))
                tr_res['max_roi'] = max(tr_res['max_roi'], cur_roi)
                tr_res['notes'].append(f"[{t}] Trailing update: ROI {cur_roi}%")
                
        # Partial TP
        if f"[Partial TP] {sym} chạm mốc" in line:
            m = re.search(r"lãi ước tính \+\$([\d\.\-]+) USDT", line)
            p = float(m.group(1)) if m else 0.0
            tr_res['pnl'] += p
            tr_res['notes'].append(f"[{t}] Partial TP: +${p} USDT")
            
        # Virtual TP
        if f"[Virtual TP" in line and f"Kích hoạt cho {sym}:" in line:
            m = re.search(r"ROI ~?([\d\.\-]+)%", line)
            roi_v = float(m.group(1)) if m else 0.0
            tr_res['notes'].append(f"[{t}] Virtual TP triggered: ROI {roi_v}%")
            
        # Close by Trailing SL / TP in telegram alert
        if any(k in line for k in ["Take Profit</b>", "Trailing SL (Khóa lãi)</b>", "Trailing SL (Hòa vốn)</b>"]) and sym in line:
            tr_res['exit_time'] = t
            tr_res['exit_type'] = 'WIN_CLOSE'
            m_roi = re.search(r"ROI:?\s*([+\-\d\.]+)%", line)
            m_pnl = re.search(r"PnL:?\s*\+?\$?([+\-\d\.]+)", line)
            if m_roi: tr_res['roi'] = float(m_roi.group(1))
            if m_pnl: tr_res['pnl'] += float(m_pnl.group(1))
            tr_res['notes'].append(f"[{t}] Close Win: ROI {tr_res['roi']}%, PnL +${tr_res['pnl']}")
            break

        # Stop loss
        if f"Đưa {sym} vào Cooldown 8 giờ do" in line and ("khớp SL" in line or "Virtual SL" in line or "Lỗ âm" in line):
            tr_res['exit_time'] = t
            tr_res['exit_type'] = 'SL_LOSS'
            m_pnl = re.search(r"PnL:\s*\$([\d\.\-]+)", line)
            m_roi = re.search(r"ROI:\s*([\d\.\-]+)%", line)
            if m_pnl: tr_res['pnl'] = float(m_pnl.group(1))
            if m_roi: tr_res['roi'] = float(m_roi.group(1))
            tr_res['notes'].append(f"[{t}] SL Hit: ROI {tr_res['roi']}%, PnL ${tr_res['pnl']}")
            break
            
    trades_performance.append(tr_res)

print(f"\n5️⃣ KẾT QUẢ TỪNG LỆNH ĐÃ VÀO VỊ THẾ:")
real_win = 0
real_loss = 0
real_open = 0
total_real_pnl = 0.0

for tr in trades_performance:
    status_str = "🟢 WIN" if tr['exit_type'] == 'WIN_CLOSE' else ("🔴 LOSS" if tr['exit_type'] == 'SL_LOSS' else "🟡 ĐANG CHẠY")
    if tr['exit_type'] == 'WIN_CLOSE':
        real_win += 1
    elif tr['exit_type'] == 'SL_LOSS':
        real_loss += 1
    else:
        real_open += 1
    total_real_pnl += tr['pnl']
    
    print(f"   • {tr['sym']:8s} ({tr['side']:5s}) | Khớp: {tr['fill_time']} @ ${tr['entry_price']} | Trạng thái: {status_str:10s} | ROI: {tr['roi']:+6.2f}% | PnL: ${tr['pnl']:+6.2f}")
    for n in tr['notes']:
        print(f"       ↳ {n}")

closed_trades = real_win + real_loss
wr = (real_win / closed_trades * 100) if closed_trades else 0.0
print(f"\n   📊 TỔNG KẾT GIAO DỊCH THẬT:")
print(f"   • Đã đóng: {closed_trades} lệnh ({real_win} Thắng / {real_loss} Thua)")
print(f"   • Win Rate thực tế: {wr:.1f}%")
print(f"   • Tổng PnL thực tế: ${total_real_pnl:+.2f} USDT")
print(f"   • Vị thế đang chạy: {real_open}")

# 6. Shadow Tracker Performance (What happened to the vetoed / candidate signals?)
shadow_events = []
shadow_filled = 0
shadow_win = 0
shadow_loss = 0
shadow_pnl = 0.0

for line in lines:
    if "[ShadowTracker]" in line or "[Shadow PnL]" in line:
        if "[Limit Filled]" in line:
            shadow_filled += 1
        elif "CHỐT LỜI THÀNH CÔNG" in line or "Trailing SL kích hoạt" in line or "Virtual TP" in line:
            shadow_win += 1
            m = re.search(r"ROI:\s*([+\-\d\.]+)%", line)
            m_p = re.search(r"PnL ước tính:\s*\+?\$?([+\-\d\.]+)", line)
            if m_p: shadow_pnl += float(m_p.group(1))
        elif "DÍNH STOP LOSS" in line or "CẮN SL" in line:
            shadow_loss += 1
            m_p = re.search(r"PnL ước tính:\s*\$?([+\-\d\.]+)", line)
            if m_p: shadow_pnl += float(m_p.group(1))

print(f"\n6️⃣ HIỆU SUẤT SHADOW TRACKER (LỆNH BÓNG TỐI / BỊ VETO HOẶC THEO DÕI):")
print(f"   • Số lệnh bóng tối khớp limit: {shadow_filled}")
print(f"   • Số lệnh chốt lời / hòa vốn:  {shadow_win}")
print(f"   • Số lệnh dính SL:            {shadow_loss}")
shadow_closed = shadow_win + shadow_loss
if shadow_closed:
    print(f"   • Shadow Win Rate:             {shadow_win/shadow_closed*100:.1f}% ({shadow_win}/{shadow_closed})")
    print(f"   • Shadow PnL ước tính:        ${shadow_pnl:+.2f} USDT")

# 7. Safety Circuit Breakers & Stand-down
cb_directional = []
cb_standdown = []
for line in lines:
    t = line[:19]
    if "[DirectionalCB]" in line:
        if any(k in line for k in ["KÍCH HOẠT KHÓA", "GIA HẠN", "MỞ KHÓA"]):
            cb_directional.append((t, line.strip()))
    if "[PerformanceGuard]" in line or "Stand-Down" in line:
        if "KÍCH HOẠT" in line or "KHÔI PHỤC" in line:
            cb_standdown.append((t, line.strip()))

print(f"\n7️⃣ KIỂM SOÁT BẢO VỆ TÀI KHOẢN (SAFETY GUARDS):")
if cb_directional:
    print(f"   • Sự kiện Directional Circuit Breaker ({len(cb_directional)}):")
    for t, l in cb_directional:
        print(f"     [{t}] {l}")
else:
    print("   ✓ Không có lần nào Directional Circuit Breaker kích hoạt khóa.")

if cb_standdown:
    print(f"   • Sự kiện Stand-Down Performance Guard ({len(cb_standdown)}):")
    for t, l in cb_standdown:
        print(f"     [{t}] {l}")
else:
    print("   ✓ Tài khoản hoạt động ổn định, không có sự kiện Stand-Down drawdown!")

# 8. All Approved Signals Details (List all approved signals and whether limit was placed / filled / cancelled)
print(f"\n8️⃣ DANH SÁCH CHI TIẾT TẤT CẢ TÍN HIỆU ĐƯỢC AI DUYỆT ({len(approved_signals)} tín hiệu):")
for s in approved_signals:
    print(f"   • [{s['time']}] {s['sym']:8s} ({s['side']:5s}) | WinProb: {s['prob']:5.1f}% | Score: {s['score']:+4.1f}đ | Rank #{s['rank']}")

print("\n" + "="*80)
