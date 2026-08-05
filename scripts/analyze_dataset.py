import json
import os
import sys
import time
import requests
from collections import defaultdict

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET_PATH = os.path.join(BASE_DIR, "data", "ai_trade_dataset.jsonl")
SKIPPED_PATH = os.path.join(BASE_DIR, "data", "skipped_signals.jsonl")
STEP_SIZES_PATH = os.path.join(BASE_DIR, "data", "step_sizes.json")

def load_grid_steps():
    if os.path.exists(STEP_SIZES_PATH):
        try:
            with open(STEP_SIZES_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data.get("steps", {})
        except Exception:
            pass
    return {}

GRID_STEPS = load_grid_steps()

def fetch_klines_binance(symbol, start_time_ms, limit=300):
    sym = symbol.upper()
    if not sym.endswith("USDT"):
        sym += "USDT"
    url = "https://fapi.binance.com/fapi/v1/klines"
    params = {
        "symbol": sym,
        "interval": "5m",
        "startTime": start_time_ms,
        "limit": limit
    }
    try:
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        pass
    return []

def simulate_skipped_signal(rec):
    sym = rec.get("symbol")
    side = rec.get("signal")
    entry_price = rec.get("signalPrice") or rec.get("markPrice")
    timestamp = rec.get("signalTimestamp")
    
    if not sym or not side or not entry_price or not timestamp:
        return None

    step_pct = GRID_STEPS.get(sym, 3.5) # Default 3.5% if not found
    
    # PP369 TP & SL distance estimation
    # TP: 5% ROI at 10x = 0.5% price movement or grid step movement
    # SL: ~1.2% - 1.5% price movement (~12-15% ROI)
    tp_dist_pct = min(1.5, step_pct * 0.4) / 100.0
    sl_dist_pct = min(2.0, step_pct * 0.5) / 100.0

    if side == "LONG":
        tp_price = entry_price * (1 + tp_dist_pct)
        sl_price = entry_price * (1 - sl_dist_pct)
    else: # SHORT
        tp_price = entry_price * (1 - tp_dist_pct)
        sl_price = entry_price * (1 + sl_dist_pct)

    klines = fetch_klines_binance(sym, timestamp, limit=150) # 12.5 hours of 5m candles
    if not klines:
        return None

    for k in klines:
        # kline structure: [open_time, open, high, low, close, volume, ...]
        high = float(k[2])
        low = float(k[3])

        if side == "LONG":
            if high >= tp_price and low <= sl_price:
                return "SL" # Conservative: SL touched in same candle
            if high >= tp_price:
                return "TP"
            if low <= sl_price:
                return "SL"
        else: # SHORT
            if low <= tp_price and high >= sl_price:
                return "SL"
            if low <= tp_price:
                return "TP"
            if high >= sl_price:
                return "SL"

    return "TIMEOUT"

def clean_reason_text(r_text):
    # Standardize reason string by extracting main tag and key metric
    # Example: "[Price Action S/R] H4: 2 cản cũ (+0.4đ) | D1: 1 cản cũ (+0.6đ)" -> "PA S/R: H4 2 cản"
    return r_text.split(" (+")[0].split(" (ADX")[0].strip()

def analyze_all():
    print("=" * 80)
    print("🔍 HỆ THỐNG PHÂN TÍCH TÍN HIỆU PHƯƠNG PHÁP 369 (AI DATASET & SKIPPED SIGNALS)")
    print("=" * 80)

    # 1. Analyze Real Trades Dataset
    real_trades = []
    if os.path.exists(DATASET_PATH):
        entries = {}
        with open(DATASET_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip(): continue
                rec = json.loads(line)
                if rec.get("type") == "ENTRY":
                    entries[rec.get("tradeId")] = rec
                elif rec.get("type") == "EXIT":
                    tid = rec.get("tradeId")
                    if rec.get("exitType") in ["TP", "SL", "TRAILING_SL"] and tid in entries:
                        real_trades.append({
                            "type": "REAL",
                            "symbol": rec.get("symbol"),
                            "is_win": rec.get("isWin", False),
                            "outcome": "TP" if rec.get("isWin") else "SL",
                            "reasons": entries[tid].get("scoreReasons", []),
                            "score": entries[tid].get("score", 0),
                            "rank": entries[tid].get("marketCapRank", 999)
                        })

    print(f"\n📌 1. BÁO CÁO LỆNH THỰC TẾ TRÊN SÀN (N = {len(real_trades)}):")
    if real_trades:
        wins = sum(1 for t in real_trades if t["is_win"])
        print(f"   • Lệnh Thắng (TP/Trailing SL): {wins}")
        print(f"   • Lệnh Thua (SL): {len(real_trades) - wins}")
        print(f"   • Tỷ Lệ Thắng (Winrate): {(wins / len(real_trades)) * 100:.1f}%\n")

    # 2. Analyze Skipped Signals (Sample simulation)
    skipped_sample = []
    if os.path.exists(SKIPPED_PATH):
        print("⏳ Đang tải và phân tích dữ liệu lệnh bị bỏ qua (Skipped Signals)...")
        with open(SKIPPED_PATH, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        # Deduplicate skipped signals by symbol + signal within 5 min window
        unique_skipped = []
        seen = set()
        for l in reversed(lines):
            if not l.strip(): continue
            rec = json.loads(l)
            key = f"{rec.get('symbol')}_{rec.get('signal')}_{rec.get('signalTimestamp') // 300000}"
            if key not in seen:
                seen.add(key)
                unique_skipped.append(rec)

        print(f"   • Tìm thấy {len(lines)} bản ghi thô $\\rightarrow$ Lọc còn {len(unique_skipped)} tín hiệu độc lập.")
        print("   • Đang giả lập nến Binance 5M cho 40 tín hiệu bị bỏ qua gần nhất...")

        for rec in unique_skipped[:40]:
            outcome = simulate_skipped_signal(rec)
            if outcome in ["TP", "SL"]:
                skipped_sample.append({
                    "type": "SKIPPED_SIMULATED",
                    "symbol": rec.get("symbol"),
                    "is_win": (outcome == "TP"),
                    "outcome": outcome,
                    "reasons": rec.get("scoreReasons", []),
                    "score": rec.get("score", 0),
                    "rank": rec.get("marketCapRank", 999)
                })
            time.sleep(0.05) # Rate limit friendly

        print(f"   ✓ Đã hoàn tất kiểm chứng giả lập cho {len(skipped_sample)} tín hiệu bị bỏ qua!\n")

    # Merge dataset for deep scoreReason analysis
    all_combined = real_trades + skipped_sample
    print(f"📊 TỔNG MẪU PHÂN TÍCH KẾT HỢP (THỰC TẾ + GIẢ LẬP): N = {len(all_combined)}")

    reason_outcomes = defaultdict(lambda: {"TP": 0, "SL": 0, "total": 0})

    for item in all_combined:
        outcome = item["outcome"]
        for r in item["reasons"]:
            clean_r = clean_reason_text(r)
            reason_outcomes[clean_r]["total"] += 1
            if outcome == "TP":
                reason_outcomes[clean_r]["TP"] += 1
            elif outcome == "SL":
                reason_outcomes[clean_r]["SL"] += 1

    # Print Top High Reliability Criteria (Chỉ báo xuất hiện nhiều ở lệnh TP)
    print("\n" + "=" * 80)
    print("🌟 TOP CÁC TIÊU CHÍ UY TÍN NHẤT (XUẤT HIỆN NHIỀU NƠI LỆNH ĐẠT TP):")
    print("=" * 80)
    sorted_tp = sorted(
        [item for item in reason_outcomes.items() if item[1]["total"] >= 2],
        key=lambda x: (x[1]["TP"] / x[1]["total"], x[1]["TP"]),
        reverse=True
    )
    for r_text, stats in sorted_tp[:10]:
        wr = (stats["TP"] / stats["total"]) * 100
        print(f"  🟢 [Winrate: {wr:5.1f}% | {stats['TP']}/{stats['total']} TP] {r_text}")

    # Print Top High Danger Criteria (Chỉ báo xuất hiện nhiều ở lệnh dính SL)
    print("\n" + "=" * 80)
    print("⚠️ TOP CÁC TIÊU CHÍ CẢNH BÁO NGUY HIỂM (XUẤT HIỆN NHIỀU NƠI LỆNH DÍNH SL):")
    print("=" * 80)
    sorted_sl = sorted(
        [item for item in reason_outcomes.items() if item[1]["total"] >= 2],
        key=lambda x: (x[1]["SL"] / x[1]["total"], stats["SL"]),
        reverse=True
    )
    for r_text, stats in sorted_sl[:10]:
        sl_rate = (stats["SL"] / stats["total"]) * 100
        wr = 100 - sl_rate
        print(f"  🔴 [SL Rate: {sl_rate:5.1f}% | Winrate: {wr:5.1f}% | {stats['SL']}/{stats['total']} SL] {r_text}")

if __name__ == "__main__":
    analyze_all()
