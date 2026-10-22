import json
import os
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "scripts"))

from train_ai_model import extract_features

DATASET_PATH = os.path.join(BASE_DIR, "data", "ai_trade_dataset.jsonl")
SHADOW_PATH = os.path.join(BASE_DIR, "data", "shadow_trades_history.jsonl")
NEW_CONFIG_PATH = os.path.join(BASE_DIR, "data", "ai_rule_config.json")

def load_new_config():
    with open(NEW_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

NEW_CONFIG = load_new_config()
NEW_WEIGHTS = NEW_CONFIG.get("featureWeights", {})
NEW_PRIOR_ODDS = NEW_CONFIG.get("priorOdds", 0.9376)
NEW_THRESHOLD = NEW_CONFIG.get("thresholdApprovalPct", 56.0)

# Cấu hình Model cũ (trước khi sửa priorOdds và BTC flash)
OLD_PRIOR_ODDS = 1.8659  # Prior win 65.11%
OLD_THRESHOLD = 50.0     # Ngưỡng cũ duyệt tràn lan

def calculate_prob(feats, prior_odds, weights, is_old_model=False):
    comb_mult = 1.0
    risk_int = feats.get("risk_interaction")
    skip_cats = set()
    if risk_int == "INTERACTION_TREND_FLOW_CONFLICT":
        skip_cats.add("trend")
        skip_cats.add("ls_flow")
    elif risk_int == "INTERACTION_NO_SR_WEAK_SETUP":
        skip_cats.add("price_action")
    elif risk_int == "INTERACTION_DRY_VOL_COOLING_OI":
        skip_cats.add("volume")
        skip_cats.add("oi_change")

    punc_int = feats.get("puncture_interaction")
    if punc_int and punc_int != "INTERACTION_PUNCTURE_NORMAL":
        skip_cats.add("h1_candle_geometry")
        skip_cats.add("m15_candle_geometry")
        skip_cats.add("candle_shape")

    for cat, val in feats.items():
        if cat in skip_cats:
            continue
        k = f"{cat}:{val}"
        mult = 1.0
        if is_old_model:
            # Model cũ: btc_flash chỉ phạt 0.40, không có các trọng số Bayes mới
            if "BTC_FLASH" in val:
                mult = 0.40
            elif k in weights:
                mult = weights[k].get("multiplier", 1.0)
        else:
            if k in weights:
                mult = weights[k].get("multiplier", 1.0)
            if "BTC_FLASH_DUMP_ACTIVE" in val or "BTC_FLASH_PUMP_ACTIVE" in val:
                mult = 0.08

        comb_mult *= mult

    post_odds = prior_odds * comb_mult
    p = (post_odds / (1.0 + post_odds)) * 100.0
    return max(5.0, min(95.0, p))

def load_real_trades():
    entries = {}
    trades = []
    if not os.path.exists(DATASET_PATH):
        return []

    with open(DATASET_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("<") or line.startswith("="):
                continue
            try:
                rec = json.loads(line)
                if rec.get("isShadow"):
                    continue
                if rec.get("type") == "ENTRY":
                    tid = rec.get("tradeId") or rec.get("orderId")
                    if tid:
                        entries[tid] = rec
                elif rec.get("type") == "EXIT":
                    tid = rec.get("tradeId") or rec.get("orderId")
                    if tid in entries:
                        en = entries[tid]
                        exit_type = rec.get("exitType", "UNKNOWN")
                        is_win = bool(rec.get("isWin")) or exit_type in ["TP", "TREND_RUNNER_TP"]
                        is_be = exit_type in ["BE_EXIT", "BE", "DEFENSIVE_BE_EXIT"]
                        pnl = float(rec.get("pnlUsd") or 0.0)

                        trades.append({
                            "tradeId": tid,
                            "symbol": en.get("symbol"),
                            "signal": en.get("signal"),
                            "entryTime": en.get("timestamp"),
                            "exitTime": rec.get("exitTimestamp") or en.get("timestamp"),
                            "score": en.get("score", 0),
                            "scoreReasons": en.get("scoreReasons", []),
                            "marketCapRank": en.get("marketCapRank", 999),
                            "gridWidthPct": en.get("gridWidthPct", 3.5),
                            "exitType": exit_type,
                            "isWin": is_win,
                            "isBE": is_be,
                            "isSL": not is_win and not is_be,
                            "pnlUsd": pnl,
                            "entryRecord": en
                        })
            except Exception:
                continue
    return trades

def evaluate_period(trades, title, start_ts=None, end_ts=None):
    filtered = []
    for t in trades:
        ts = t["exitTime"] or t["entryTime"]
        if not ts:
            continue
        if start_ts and ts < start_ts:
            continue
        if end_ts and ts > end_ts:
            continue
        filtered.append(t)

    print("=" * 80)
    print(f"📌 {title} (Tổng số lệnh thực tế: {len(filtered)})")
    print("=" * 80)

    # 1. Kết quả thực tế ban đầu (Thực tế đã khớp trên VPS không qua lọc mới)
    actual_wins = sum(1 for t in filtered if t["isWin"])
    actual_losses = sum(1 for t in filtered if t["isSL"])
    actual_bes = sum(1 for t in filtered if t["isBE"])
    actual_pnl = sum(t["pnlUsd"] for t in filtered)
    actual_gw = sum(t["pnlUsd"] for t in filtered if t["pnlUsd"] > 0)
    actual_gl = abs(sum(t["pnlUsd"] for t in filtered if t["pnlUsd"] < 0))
    actual_pf = (actual_gw / actual_gl) if actual_gl > 0 else 99.0
    actual_wr = (actual_wins / (actual_wins + actual_losses) * 100) if (actual_wins + actual_losses) > 0 else 0

    print(f"🔸 THỰC TẾ TRÊN TÀI KHOẢN (KHÔNG QUA LỌC AI MỚI):")
    print(f"   • Lệnh Win: {actual_wins} | SL: {actual_losses} | BE: {actual_bes}")
    print(f"   • Win Rate (không tính BE): {actual_wr:.1f}%")
    print(f"   • Gross Win: +${actual_gw:.2f} | Gross Loss: -${actual_gl:.2f}")
    print(f"   • Net PnL: ${actual_pnl:+.2f} USD | Profit Factor: {actual_pf:.2f}\n")

    # 2. Chạy mô phỏng Model cũ vs Model mới
    for model_name, p_odds, th, is_old in [
        ("MÔ HÌNH CŨ (PriorWin=65.1%, Threshold=50%)", OLD_PRIOR_ODDS, OLD_THRESHOLD, True),
        ("MÔ HÌNH MỚI (PriorWin=48.4%, Threshold=56%, Bayes Flash=0.08)", NEW_PRIOR_ODDS, NEW_THRESHOLD, False)
    ]:
        approved_trades = []
        vetoed_trades = []

        for t in filtered:
            feats = extract_features(
                t["scoreReasons"],
                t["score"],
                t["marketCapRank"],
                t["gridWidthPct"],
                t["entryTime"],
                direct_record=t["entryRecord"]
            )
            prob = calculate_prob(feats, p_odds, NEW_WEIGHTS, is_old_model=is_old)
            if prob >= th:
                approved_trades.append(t)
            else:
                vetoed_trades.append((t, prob))

        n_app = len(approved_trades)
        n_vet = len(vetoed_trades)
        app_wins = sum(1 for t in approved_trades if t["isWin"])
        app_losses = sum(1 for t in approved_trades if t["isSL"])
        app_bes = sum(1 for t in approved_trades if t["isBE"])
        app_pnl = sum(t["pnlUsd"] for t in approved_trades)
        app_gw = sum(t["pnlUsd"] for t in approved_trades if t["pnlUsd"] > 0)
        app_gl = abs(sum(t["pnlUsd"] for t in approved_trades if t["pnlUsd"] < 0))
        app_pf = (app_gw / app_gl) if app_gl > 0 else (99.0 if app_gw > 0 else 0.0)
        app_wr = (app_wins / (app_wins + app_losses) * 100) if (app_wins + app_losses) > 0 else 0

        # Phân tích lệnh Veto
        saved_sl_count = sum(1 for t, p in vetoed_trades if t["isSL"])
        saved_sl_usd = abs(sum(t["pnlUsd"] for t, p in vetoed_trades if t["isSL"]))
        missed_tp_count = sum(1 for t, p in vetoed_trades if t["isWin"])
        missed_tp_usd = sum(t["pnlUsd"] for t, p in vetoed_trades if t["isWin"])
        net_saved_benefit = saved_sl_usd - missed_tp_usd

        print(f"🔹 {model_name}:")
        print(f"   • Lệnh được duyệt (Approved): {n_app}/{len(filtered)} ({n_app/len(filtered)*100:.1f}%) | Lọc bỏ (Vetoed): {n_vet}")
        print(f"   • Thống kê lệnh duyệt: {app_wins} Win | {app_losses} SL | {app_bes} BE")
        print(f"   • Win Rate lệnh duyệt: {app_wr:.1f}%")
        print(f"   • Gross Win: +${app_gw:.2f} | Gross Loss: -${app_gl:.2f}")
        print(f"   • Net PnL Lệnh Duyệt: ${app_pnl:+.2f} USD | Profit Factor: {app_pf:.2f}")
        print(f"   • Giá trị AI Veto mang lại:")
        print(f"       + Đã cứu tránh: {saved_sl_count} lệnh SL (Giữ lại được +${saved_sl_usd:.2f} USD)")
        print(f"       - Bị hụt (Missed): {missed_tp_count} lệnh TP (-${missed_tp_usd:.2f} USD)")
        print(f"       ➔ LỢI ÍCH RÒNG TỪ AI LỌC LỆNH: ${net_saved_benefit:+.2f} USD\n")

def main():
    trades = load_real_trades()
    print(f"Loaded {len(trades)} total real trade records.")
    if not trades:
        return

    # 1. Tuần trước (Từ 12/10/2026 đến 19/10/2026)
    dt_start_last_week = datetime(2026, 10, 12, 0, 0, 0).timestamp() * 1000
    dt_end_last_week = datetime(2026, 10, 20, 0, 0, 0).timestamp() * 1000
    evaluate_period(trades, "GIAI ĐOẠN 1: TUẦN TRƯỚC (12/10/2026 - 19/10/2026 - ĐỢT SỤT GIẢM & VOLATILITY GẦN NHẤT)", dt_start_last_week, dt_end_last_week)

    # 2. Dài hơn: 1 tháng qua (Từ 11/09/2026 đến 19/10/2026)
    dt_start_month = datetime(2026, 9, 11, 0, 0, 0).timestamp() * 1000
    evaluate_period(trades, "GIAI ĐOẠN 2: MỞ RỘNG 1 THÁNG QUA (11/09/2026 - 19/10/2026)", dt_start_month, dt_end_last_week)

    # 3. Toàn bộ lịch sử (Toàn bộ 1,217 lệnh thật)
    evaluate_period(trades, "GIAI ĐOẠN 3: TOÀN BỘ DỮ LIỆU LỊCH SỬ (TỪ THÁNG 7/2026 ĐẾN THÁNG 10/2026)")

if __name__ == "__main__":
    main()
