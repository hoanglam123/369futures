# -*- coding: utf-8 -*-
import sys, re, os, json
sys.stdout.reconfigure(encoding='utf-8')

START_TIME = "2026-09-24 09:10:00"

print("================================================================================")
print(f"📊 PHÂN TÍCH NHẬT KÝ HOẠT ĐỘNG BOT TỪ SAU CẬP NHẬT (TỪ {START_TIME})")
print("================================================================================\n")

total_signals = 0
ai_approved = 0
ai_vetoed = 0

veto_reasons = {}
real_orders_placed = []
real_orders_filled = []
real_exits = []
directional_events = []
standdown_events = []

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        # Check time filter
        if len(line) < 19:
            continue
        line_time = line[:19]
        if line_time < START_TIME:
            continue

        # AI Veto
        if "[AI Veto]" in line:
            total_signals += 1
            ai_vetoed += 1
            # categorize veto
            if "CẢN TÀU XU HƯỚNG" in line or "COUNTER_STRONG_TREND_DANGER" in line:
                cat = "COUNTER_STRONG_TREND_DANGER"
            elif "BẪY RÚT RÂU" in line or "OPPOSING_WICK_TRAP" in line:
                cat = "OPPOSING_WICK_TRAP"
            elif "BÃO NẾN CỰC ĐẠI" in line or "EXTREME_STORM" in line:
                cat = "EXTREME_STORM"
            elif "R:R không đạt chuẩn" in line or "R:R < 1.0" in line:
                cat = "RISK_REWARD_LT_1"
            elif "ĐÁNH GIÁ RỦI RO AI:" in line:
                match = re.search(r"ĐÁNH GIÁ RỦI RO AI:\s*(\w+)", line)
                cat = match.group(1) if match else "RISK_INTERACTION"
            elif "Xác suất thắng" in line:
                cat = "LOW_WIN_PROBABILITY"
            else:
                cat = "OTHER_VETO"
            veto_reasons[cat] = veto_reasons.get(cat, 0) + 1

        # AI Approved
        elif "Khuyên NÊN ĐẶT LỆNH" in line:
            total_signals += 1
            ai_approved += 1
            real_orders_placed.append((line_time, line.strip()))

        # Real order limit placement
        elif "Đặt lệnh LIMIT thành công" in line or "status=NEW" in line:
            pass

        # Real fill
        elif "Khớp lệnh LIMIT" in line or "đã khớp vị thế thực tế" in line or "khớp lệnh Limit" in line:
            real_orders_filled.append((line_time, line.strip()))

        # Real exit (TP, SL, Trailing SL, etc.)
        elif any(k in line for k in ["DÍNH STOP LOSS", "CẮN SL", "CHỐT LỜI", "CẮN TP", "Dời SL bảo toàn", "ĐÓNG VỊ THẾ", "Trailing SL"]):
            if "Shadow" not in line and "[Shadow PnL]" not in line and "[ShadowTracker]" not in line:
                real_exits.append((line_time, line.strip()))

        # Directional Circuit Breaker
        elif "[DirectionalCB]" in line:
            directional_events.append((line_time, line.strip()))

        # Performance Guard / Stand-down
        elif "[PerformanceGuard]" in line or "Stand-Down" in line:
            if "KÍCH HOẠT CHẾ ĐỘ STAND-DOWN" in line or "TỰ ĐỘNG KHÔI PHỤC GIAO DỊCH" in line:
                standdown_events.append((line_time, line.strip()))

print(f"1. Tổng số tín hiệu AI Reviewer đánh giá: {total_signals:,} tín hiệu")
print(f"   • Số tín hiệu bị VETO loại bỏ:        {ai_vetoed:,} ({((ai_vetoed/total_signals)*100 if total_signals else 0):.2f}%)")
print(f"   • Số tín hiệu được PHÊ DUYỆT:         {ai_approved:,} ({((ai_approved/total_signals)*100 if total_signals else 0):.2f}%)")

print("\n2. Phân loại lý do VETO của AI:")
for r, c in sorted(veto_reasons.items(), key=lambda x: -x[1]):
    pct = (c / ai_vetoed) * 100 if ai_vetoed else 0
    print(f"   • {r:32s}: {c:5d} lần ({pct:5.1f}%)")

print(f"\n3. Danh sách các lệnh được AI PHÊ DUYỆT đặt Limit ({len(real_orders_placed)} lệnh):")
for t, line in real_orders_placed:
    # Extract coin and probability
    m = re.search(r"NÊN ĐẶT LỆNH (\w+)\s*\((LONG|SHORT)\)[^-]+- Xác suất thắng ([\d\.]+)%", line)
    if m:
        coin, side, prob = m.group(1), m.group(2), m.group(3)
        print(f"   [{t}] {coin:12s} ({side:5s}) - WinProb: {prob}%")
    else:
        print(f"   [{t}] {line[:120]}")

print(f"\n4. Các sự kiện đóng vị thế thật (Real Exits): ({len(real_exits)} sự kiện)")
for t, line in real_exits:
    print(f"   [{t}] {line[:140]}")

print(f"\n5. Sự kiện Directional Circuit Breaker & Performance Guard ({len(directional_events)} Directional, {len(standdown_events)} Stand-Down):")
if standdown_events:
    for t, line in standdown_events:
        print(f"   [PerformanceGuard {t}] {line[:130]}")
else:
    print("   ✓ Không có sự kiện kích hoạt Stand-Down (Tài khoản hoạt động an toàn, ổn định).")

lock_events = [e for e in directional_events if "KÍCH HOẠT KHÓA" in e[1] or "GIA HẠN" in e[1] or "MỞ KHÓA" in e[1]]
if lock_events:
    print("\n   Sự kiện ngắt mạch / gia hạn / mở khóa:")
    for t, line in lock_events:
        print(f"   [{t}] {line[:130]}")
else:
    print("   ✓ Không có sự kiện kích hoạt khóa Directional Circuit Breaker mới.")
