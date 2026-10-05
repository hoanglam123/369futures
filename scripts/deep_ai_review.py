# -*- coding: utf-8 -*-
import sys, re, os
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

UPDATE_TIME = "2026-10-01 11:12:28"

print("="*80)
print(f"📊 PHÂN TÍCH CHUYÊN SÂU AI REVIEWER & CÁC CƠ CHẾ BẢO VỆ MỚI (TỪ {UPDATE_TIME})")
print("="*80)

# Counters
feature_penalty_counts = defaultdict(int)
guardrail_triggers = defaultdict(int)
win_probs = []
win_probs_approved = []
rank_approved = defaultdict(int)
rank_vetoed = defaultdict(int)

critical_risk_suppression_count = 0

with open('logs/pm2-out.log', 'r', encoding='utf-8', errors='ignore') as f:
    for line in f:
        if len(line) < 19 or line[:19] < UPDATE_TIME:
            continue
            
        if "[AI Veto]" in line:
            # Check winProb
            m_prob = re.search(r"Xác suất thắng\s*([\d\.]+)%", line)
            if m_prob:
                win_probs.append(float(m_prob.group(1)))
                
            # Check Rank
            m_rank = re.search(r"Rank\s*#(\d+)", line)
            if m_rank:
                r = int(m_rank.group(1))
                if r <= 30: rank_vetoed['Top30'] += 1
                elif r <= 150: rank_vetoed['Midcap150'] += 1
                else: rank_vetoed['Lowcap'] += 1
                
            # Extract features in parenthesis
            # format: (- FEAT (x0.85), + FEAT (x1.20), ...)
            feats_block = re.search(r"\(([\+\-∅][^)]+)\)", line)
            if feats_block:
                items = feats_block.group(1).split(',')
                for it in items:
                    it = it.strip()
                    m_f = re.search(r"([\+\-∅])\s*(\w+)", it)
                    if m_f:
                        sign, feat_name = m_f.group(1), m_f.group(2)
                        if sign == '-':
                            feature_penalty_counts[feat_name] += 1
                            
        elif "Khuyên NÊN ĐẶT LỆNH" in line:
            m_prob = re.search(r"Xác suất thắng\s*([\d\.]+)%", line)
            if m_prob:
                win_probs_approved.append(float(m_prob.group(1)))
            m_rank = re.search(r"Rank\s*#(\d+)", line)
            if m_rank:
                r = int(m_rank.group(1))
                if r <= 30: rank_approved['Top30'] += 1
                elif r <= 150: rank_approved['Midcap150'] += 1
                else: rank_approved['Lowcap'] += 1

print("\n1. Phân bố xác suất thắng (WinProb) của các tín hiệu bị AI Veto:")
if win_probs:
    p_below_30 = len([p for p in win_probs if p < 30])
    p_30_40 = len([p for p in win_probs if 30 <= p < 40])
    p_40_50 = len([p for p in win_probs if 40 <= p < 50])
    p_50_55 = len([p for p in win_probs if 50 <= p < 55])
    p_above_55 = len([p for p in win_probs if p >= 55])
    print(f"   • < 30%       : {p_below_30:5d} ({p_below_30/len(win_probs)*100:5.1f}%) -> Rủi ro cực cao, AI dập tắt triệt để")
    print(f"   • 30% - 39.9% : {p_30_40:5d} ({p_30_40/len(win_probs)*100:5.1f}%)")
    print(f"   • 40% - 49.9% : {p_40_50:5d} ({p_40_50/len(win_probs)*100:5.1f}%)")
    print(f"   • 50% - 54.9% : {p_50_55:5d} ({p_50_55/len(win_probs)*100:5.1f}%) -> Chạm gần ngưỡng nhưng không đủ an toàn")
    print(f"   • >= 55%      : {p_above_55:5d} ({p_above_55/len(win_probs)*100:5.1f}%) -> Đạt xác suất nhưng bị VETO cứng (R:R < 1, Bẫy rút râu, Ngược trend)")

print("\n2. Top 15 Tính năng / Rủi ro bị trừ điểm (Penalty) nhiều nhất:")
for feat, cnt in sorted(feature_penalty_counts.items(), key=lambda x: -x[1])[:15]:
    print(f"   • {feat:35s}: {cnt:5d} lần")

print("\n3. Phân bố theo Vốn hóa (Market Cap Rank):")
print(f"   • Tín hiệu VETO    : Top 30: {rank_vetoed['Top30']}, Midcap (31-150): {rank_vetoed['Midcap150']}, Lowcap (>150): {rank_vetoed['Lowcap']}")
print(f"   • Tín hiệu ĐƯỢC DUYỆT: Top 30: {rank_approved['Top30']}, Midcap (31-150): {rank_approved['Midcap150']}, Lowcap (>150): {rank_approved['Lowcap']}")

print("\n4. Chi tiết các tín hiệu được duyệt:")
for p in win_probs_approved:
    print(f"   • WinProb: {p}%")

print("\n" + "="*80)
