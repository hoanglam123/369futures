import json
import os
import sys

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dataset_path = os.path.join(BASE_DIR, 'data', 'ai_trade_dataset.jsonl')
shadow_path = os.path.join(BASE_DIR, 'data', 'shadow_trades_history.jsonl')
config_path = os.path.join(BASE_DIR, 'data', 'ai_rule_config.json')

with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

weights = config.get('featureWeights', {})
prior_odds = config.get('priorOdds', 1.6712)
threshold_top = config.get('optimalThresholds', {}).get('top150', 50.0)
threshold_low = config.get('optimalThresholds', {}).get('lowcap', 65.0)

sys.path.append(os.path.join(BASE_DIR, 'scripts'))
from train_ai_model import extract_features

records = []
# 1. Load real trades
if os.path.exists(dataset_path):
    entries = {}
    with open(dataset_path, 'r', encoding='utf-8') as f:
        for l in f:
            l = l.strip()
            if not l or l.startswith('<') or l.startswith('='): continue
            try:
                rec = json.loads(l)
                if rec.get('type') == 'ENTRY':
                    entries[rec.get('tradeId')] = rec
                elif rec.get('type') == 'EXIT':
                    tid = rec.get('tradeId')
                    if tid in entries:
                        en = entries[tid]
                        is_win = rec.get('isWin', False)
                        exit_type = rec.get('exitType')
                        pnl = float(rec.get('pnlUsd', 0) or rec.get('pnlPercent', 0))
                        records.append({
                            'source': 'REAL',
                            'entry': en,
                            'is_win': is_win,
                            'is_be': exit_type == 'BE_EXIT',
                            'exit_type': exit_type,
                            'pnl': pnl
                        })
            except Exception: pass

# 2. Load shadow trades
if os.path.exists(shadow_path):
    with open(shadow_path, 'r', encoding='utf-8') as f:
        for l in f:
            l = l.strip()
            if not l: continue
            try:
                rec = json.loads(l)
                outcome = rec.get('outcome')
                if outcome in ['MISSED_TP', 'SAVED_SL', 'SAVED_BE', 'TP', 'SL', 'BE']:
                    holding_mins = rec.get('holdingDurationMinutes') or 0
                    if outcome in ['MISSED_TP', 'TP'] and holding_mins <= 240:
                        is_win = True
                        is_be = False
                    elif outcome in ['SAVED_BE', 'BE']:
                        is_win = False
                        is_be = True
                    else:
                        is_win = False
                        is_be = False
                    pnl = float(rec.get('pnlUsd', 0))
                    records.append({
                        'source': 'SHADOW',
                        'entry': rec,
                        'is_win': is_win,
                        'is_be': is_be,
                        'exit_type': outcome,
                        'pnl': pnl
                    })
            except Exception: pass

print(f'Tổng số mẫu dữ liệu lịch sử nạp được: {len(records)} (Real + Shadow <= 4h)')

old_approved = []
new_approved = []
veto_reasons_count = {'CALENDAR_RED_DANGER': 0, 'SPREAD_WIDE_DANGER': 0, 'ORDERBOOK_WALL_BLOCK': 0, 'LOW_WIN_PROB': 0}
vetoed_losses_saved = 0
vetoed_wins_missed = 0

for r in records:
    en = r['entry']
    reasons = en.get('scoreReasons', [])
    score = float(en.get('score', 0))
    rank = int(en.get('marketCapRank', 999))
    gw = float(en.get('gridWidthPct', 3.5))
    ts = en.get('timestamp') or en.get('entryTimestamp')
    
    feats = extract_features(reasons, score, rank, gw, ts, direct_record=en)
    
    # 1. OLD MODEL: Bỏ qua 4 chỉ số mới
    old_mult = 1.0
    for cat, val in feats.items():
        if cat in ['economic_calendar', 'spread_slippage', 'cvd_momentum', 'orderbook_wall']:
            continue
        k = f'{cat}:{val}'
        if k in weights:
            old_mult *= weights[k]['multiplier']
    
    old_odds = prior_odds * old_mult
    old_prob = (old_odds / (1.0 + old_odds)) * 100.0
    th = threshold_top if rank <= 150 else threshold_low
    if old_prob >= th:
        old_approved.append(r)
        
    # 2. NEW MODEL: Có đầy đủ 23 chỉ số + Các chốt chặn VETO
    new_mult = 1.0
    for cat, val in feats.items():
        k = f'{cat}:{val}'
        if k in weights:
            new_mult *= weights[k]['multiplier']
            
    new_odds = prior_odds * new_mult
    new_prob = (new_odds / (1.0 + new_odds)) * 100.0
    
    # Check Vetoes
    is_eco_red = feats.get('economic_calendar') == 'CALENDAR_RED_DANGER'
    is_spread_danger = feats.get('spread_slippage') == 'SPREAD_WIDE_DANGER'
    is_wall_block = feats.get('orderbook_wall') == 'WALL_OPPOSING_BLOCK' and score < 4.5
    
    is_vetoed = False
    if is_eco_red:
        veto_reasons_count['CALENDAR_RED_DANGER'] += 1
        is_vetoed = True
    elif is_spread_danger:
        veto_reasons_count['SPREAD_WIDE_DANGER'] += 1
        is_vetoed = True
    elif is_wall_block:
        veto_reasons_count['ORDERBOOK_WALL_BLOCK'] += 1
        is_vetoed = True
    elif new_prob < th:
        veto_reasons_count['LOW_WIN_PROB'] += 1
        is_vetoed = True
        
    if is_vetoed:
        if not r['is_win'] and not r['is_be']:
            vetoed_losses_saved += 1
        elif r['is_win']:
            vetoed_wins_missed += 1
    else:
        new_approved.append(r)

old_wins = sum(1 for r in old_approved if r['is_win'])
old_be = sum(1 for r in old_approved if r['is_be'])
old_losses = len(old_approved) - old_wins - old_be
old_winrate = (old_wins / (len(old_approved) - old_be) * 100) if (len(old_approved) - old_be) > 0 else 0

new_wins = sum(1 for r in new_approved if r['is_win'])
new_be = sum(1 for r in new_approved if r['is_be'])
new_losses = len(new_approved) - new_wins - new_be
new_winrate = (new_wins / (len(new_approved) - new_be) * 100) if (len(new_approved) - new_be) > 0 else 0

print('\n' + '=' * 70)
print('📊 KẾT QUẢ BACKTEST ĐỐI CHIẾU TRÊN TOÀN BỘ DATA LỊCH SỬ BINANCE')
print('=' * 70)
print(f'1. MÔ HÌNH CŨ (CHƯA CÓ 4 CHỈ SỐ SCALPING):')
print(f'   • Tổng lệnh được duyệt: {len(old_approved)}')
print(f'   • Thắng (TP): {old_wins} | Hòa (BE): {old_be} | Thua (SL): {old_losses}')
print(f'   • Tỷ lệ thắng (WinRate loại trừ BE): {old_winrate:.2f}%\n')

print(f'2. MÔ HÌNH MỚI (ĐÃ TÍCH HỢP 4 CHỈ SỐ SCALPING + BỘ LỌC VETO):')
print(f'   • Tổng lệnh được duyệt: {len(new_approved)}')
print(f'   • Thắng (TP): {new_wins} | Hòa (BE): {new_be} | Thua (SL): {new_losses}')
print(f'   • Tỷ lệ thắng MỚI (WinRate loại trừ BE): {new_winrate:.2f}%')
print(f'   • Tăng trưởng WinRate: +{new_winrate - old_winrate:.2f}%')
print(f'   • Số lệnh SL thua lỗ ĐÃ NÉ THÀNH CÔNG (Cứu vốn): {vetoed_losses_saved} lệnh!')
print(f'   • Chi tiết lệnh xấu bị Veto loại bỏ:')
print(f"     - Tránh bão tin CPI / FOMC (Blackout): {veto_reasons_count['CALENDAR_RED_DANGER']} lệnh")
print(f"     - Tránh dãn Spread & Trượt giá lớn:   {veto_reasons_count['SPREAD_WIDE_DANGER']} lệnh")
print(f"     - Tránh đâm đầu vào Tường cản Sổ lệnh: {veto_reasons_count['ORDERBOOK_WALL_BLOCK']} lệnh")
print(f"     - WinProb rớt dưới ngưỡng an toàn:      {veto_reasons_count['LOW_WIN_PROB']} lệnh")
print('=' * 70)
