# -*- coding: utf-8 -*-
import sys, re, os, json
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

START_TIME = "2026-09-24 09:10:00"

print("================================================================================")
print(f"🔬 PHÂN TÍCH CHI TIẾT TỪNG LỆNH & HIỆU SUẤT BOT TỪ {START_TIME}")
print("================================================================================\n")

# Phase 1: Scan for all AI evaluations and decisions
ai_evals = []
orders_placed = []
orders_filled = []
sl_hits = []
tp_hits = []
trailing_sl_hits = []
partial_tp_hits = []
all_events = []

# Symbol event tracker
symbol_events = {}

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        if len(line) < 19:
            continue
        line_time = line[:19]
        if line_time < START_TIME:
            continue
            
        # 1. AI Approval
        if "Khuyên NÊN ĐẶT LỆNH" in line:
            m = re.search(r"NÊN ĐẶT LỆNH (\w+)\s*\((LONG|SHORT)\)[^-]+- Xác suất thắng ([\d\.]+)%", line)
            if m:
                coin, side, prob = m.group(1), m.group(2), float(m.group(3))
                all_events.append((line_time, coin, "AI_APPROVED", side, prob, line.strip()))
                symbol_events.setdefault(coin, []).append((line_time, "AI_APPROVED", side, prob, line.strip()))

        # 2. Limit Placed
        elif "Đặt lệnh LIMIT thành công" in line:
            m = re.search(r"cho (\w+)\s*\((BUY|SELL)\)\s*giá \$([\d\.]+)", line)
            if m:
                coin, side, price = m.group(1), m.group(2), float(m.group(3))
                all_events.append((line_time, coin, "LIMIT_PLACED", side, price, line.strip()))
                symbol_events.setdefault(coin, []).append((line_time, "LIMIT_PLACED", side, price, line.strip()))

        # 3. Limit Filled
        elif "Lệnh LIMIT đã khớp thành công" in line:
            m = re.search(r"Coin:\s*(\w+)\s*\((LONG|SHORT)\)", line)
            if m:
                coin, side = m.group(1), m.group(2)
                all_events.append((line_time, coin, "FILLED", side, 0, line.strip()))
                symbol_events.setdefault(coin, []).append((line_time, "FILLED", side, 0, line.strip()))

        # 4. Limit Expired / Cancelled
        elif "Hủy lệnh LIMIT" in line or "Hết thời gian chờ" in line or "HỦY LỆNH LIMIT" in line:
            m = re.search(r"LIMIT[^\w]*(\w+)", line)
            coin = m.group(1) if m else "UNKNOWN"
            all_events.append((line_time, coin, "CANCELLED", "", 0, line.strip()))
            symbol_events.setdefault(coin, []).append((line_time, "CANCELLED", "", 0, line.strip()))

        # 5. Trailing SL / BE
        elif "Trailing SL (chạm mốc" in line:
            m = re.search(r"Trailing SL \(chạm mốc \d+đ\):\s*(\w+)\s*đạt ROI ([\d\.\-]+)%", line)
            if m:
                coin, roi = m.group(1), float(m.group(2))
                all_events.append((line_time, coin, "TRAILING_TRIGGERED", "", roi, line.strip()))
                symbol_events.setdefault(coin, []).append((line_time, "TRAILING_TRIGGERED", "", roi, line.strip()))

        # 6. Partial TP
        elif "[Partial TP]" in line and "Chốt 50% vị thế" in line:
            m = re.search(r"\[Partial TP\] (\w+) chạm mốc", line)
            coin = m.group(1) if m else "UNKNOWN"
            all_events.append((line_time, coin, "PARTIAL_TP", "", 0, line.strip()))
            symbol_events.setdefault(coin, []).append((line_time, "PARTIAL_TP", "", 0, line.strip()))

        # 7. Virtual TP
        elif "[Virtual TP" in line and "Kích hoạt" in line:
            m = re.search(r"Kích hoạt cho (\w+):", line)
            coin = m.group(1) if m else "UNKNOWN"
            all_events.append((line_time, coin, "VIRTUAL_TP", "", 0, line.strip()))
            symbol_events.setdefault(coin, []).append((line_time, "VIRTUAL_TP", "", 0, line.strip()))

        # 8. SL Cooldown (SL hit)
        elif "vào Cooldown 8 giờ do khớp SL" in line or "do Virtual SL" in line:
            m = re.search(r"Đưa (\w+) vào Cooldown 8 giờ do (?:khớp SL sàn / Lỗ âm|Virtual SL).*PnL:\s*\$([\d\.\-]+).*ROI:\s*([\d\.\-]+)%", line)
            if m:
                coin, pnl, roi = m.group(1), float(m.group(2)), float(m.group(3))
                all_events.append((line_time, coin, "SL_HIT", "", roi, f"PnL: ${pnl}, ROI: {roi}%"))
                symbol_events.setdefault(coin, []).append((line_time, "SL_HIT", "", roi, f"PnL: ${pnl}, ROI: {roi}%"))
            else:
                m2 = re.search(r"Đưa (\w+) vào Cooldown", line)
                coin = m2.group(1) if m2 else "UNKNOWN"
                all_events.append((line_time, coin, "SL_HIT", "", 0, line.strip()))
                symbol_events.setdefault(coin, []).append((line_time, "SL_HIT", "", 0, line.strip()))

        # 9. Telegram Take Profit or Trailing SL Close
        elif "Take Profit</b>" in line or "Trailing SL (Khóa lãi)</b>" in line or "Trailing SL (Hòa vốn)</b>" in line:
            all_events.append((line_time, "TG_CLOSE", "WIN_CLOSE", "", 0, line.strip()))

print(f"Tổng số events ghi nhận: {len(all_events)}")
