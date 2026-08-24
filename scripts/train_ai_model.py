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
OUTPUT_MODEL_PATH = os.path.join(BASE_DIR, "data", "ai_rule_config.json")

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
    except Exception:
        pass
    return []

def simulate_skipped_signal(rec):
    sym = rec.get("symbol")
    side = rec.get("signal")
    entry_price = rec.get("signalPrice") or rec.get("markPrice")
    timestamp = rec.get("signalTimestamp")
    
    if not sym or not side or not entry_price or not timestamp:
        return None

    step_pct = GRID_STEPS.get(sym, 3.5)
    tp_dist_pct = min(1.5, step_pct * 0.4) / 100.0
    sl_dist_pct = min(2.0, step_pct * 0.5) / 100.0

    if side == "LONG":
        tp_price = entry_price * (1 + tp_dist_pct)
        sl_price = entry_price * (1 - sl_dist_pct)
    else: # SHORT
        tp_price = entry_price * (1 - tp_dist_pct)
        sl_price = entry_price * (1 + sl_dist_pct)

    klines = fetch_klines_binance(sym, timestamp, limit=150)
    if not klines:
        return None

    for k in klines:
        high = float(k[2])
        low = float(k[3])
        if side == "LONG":
            if high >= tp_price and low <= sl_price:
                return "SL"
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

def extract_features(reasons, score, rank, grid_width_pct, timestamp_ms=None):
    reasons_str = " ".join(reasons)
    features = {}

    # 1. Score Group
    if score >= 7.0: features["score_group"] = "SCORE_HIGH_GE7"
    elif score >= 6.0: features["score_group"] = "SCORE_MID_6_TO_7"
    elif score >= 5.0: features["score_group"] = "SCORE_LOW_5_TO_6"
    else: features["score_group"] = "SCORE_WEAK_LT5"

    # 2. MarketCap Rank
    if rank <= 10: features["rank_group"] = "RANK_TOP10"
    elif rank <= 30: features["rank_group"] = "RANK_TOP30"
    elif rank <= 150: features["rank_group"] = "RANK_MIDCAP_150"
    else: features["rank_group"] = "RANK_LOWCAP_OUT150"

    # 3. Trend Alignment
    if "Dow & Trendline" in reasons_str: features["trend"] = "TREND_PERFECT"
    elif "EMA20<EMA50" in reasons_str or "EMA20>EMA50" in reasons_str: features["trend"] = "TREND_EMA"
    elif "Ngược/Mâu thuẫn" in reasons_str: features["trend"] = "TREND_CONFLICT"
    else: features["trend"] = "TREND_NEUTRAL"

    # 4. Volatility Compression
    if "H1 siêu nén" in reasons_str: features["volatility"] = "VOL_ULTRA"
    elif "H1 nén vừa" in reasons_str: features["volatility"] = "VOL_MID"
    else: features["volatility"] = "VOL_WEAK"

    # 5. RSI Condition
    if "Quá bán cực đại" in reasons_str or "Quá mua cực đại" in reasons_str: features["rsi"] = "RSI_EXTREME"
    elif "Cận quá bán" in reasons_str or "Cận quá mua" in reasons_str: features["rsi"] = "RSI_NEAR"
    else: features["rsi"] = "RSI_NEUTRAL"

    # 6. Whales vs Retail Flow
    if "Gold Setup" in reasons_str or "Đồng thuận tuyệt đối" in reasons_str: features["ls_flow"] = "LS_GOLD"
    elif "Đồng thuận một phần" in reasons_str: features["ls_flow"] = "LS_PARTIAL"
    elif "Không đồng thuận" in reasons_str or "phân kỳ" in reasons_str: features["ls_flow"] = "LS_DIVERGENCE"
    else: features["ls_flow"] = "LS_NEUTRAL"

    # 7. Price Action S/R Levels
    if "4 cản cũ" in reasons_str: features["price_action"] = "PA_4_LEVELS"
    elif "3 cản cũ" in reasons_str: features["price_action"] = "PA_3_LEVELS"
    elif "2 cản cũ" in reasons_str: features["price_action"] = "PA_2_LEVELS"
    elif "1 cản cũ" in reasons_str: features["price_action"] = "PA_1_LEVEL"
    else: features["price_action"] = "PA_0_LEVEL"

    # 8. Open Interest (OI) Change
    if "Hạ nhiệt vị thế" in reasons_str or "giảm -" in reasons_str: features["oi_change"] = "OI_COOLING"
    elif "Tăng mạnh" in reasons_str or "bùng nổ" in reasons_str: features["oi_change"] = "OI_SURGE"
    else: features["oi_change"] = "OI_STABLE"

    # 9. Volume Momentum
    if "Volume bùng nổ" in reasons_str: features["volume"] = "VOL_SURGE"
    elif "Volume ổn định" in reasons_str: features["volume"] = "VOL_STABLE"
    else: features["volume"] = "VOL_DRY"

    # 10. Funding Rate
    if "Short Crowded" in reasons_str or "Long Crowded" in reasons_str: features["funding"] = "FUNDING_SQUEEZE"
    elif "Short đu bám" in reasons_str or "Long đu bám" in reasons_str or "Nóng" in reasons_str: features["funding"] = "FUNDING_DANGER"
    else: features["funding"] = "FUNDING_NORMAL"

    # 11. BTC Wave
    if "BTC thuận Dow/EMA" in reasons_str: features["btc_wave"] = "BTC_ALIGNED"
    elif "BTC đi ngang/trung tính" in reasons_str: features["btc_wave"] = "BTC_NEUTRAL"
    else: features["btc_wave"] = "BTC_COUNTER"

    # 12. Grid Width Pct
    gw = float(grid_width_pct) if grid_width_pct is not None else 3.5
    if gw > 5.0: features["grid_width"] = "GRID_WIDE"
    elif gw >= 2.5: features["grid_width"] = "GRID_NORMAL"
    else: features["grid_width"] = "GRID_NARROW"

    # 13. Trading Session & Time-of-Day
    if timestamp_ms:
        try:
            # Chuyển đổi timestamp sang giờ VN (UTC+7)
            t_sec = int(timestamp_ms) / 1000.0
            import datetime
            dt = datetime.datetime.fromtimestamp(t_sec, tz=datetime.timezone(datetime.timedelta(hours=7)))
            vn_hour = dt.hour + dt.minute / 60.0
            vn_day = dt.weekday() # 5: T7, 6: CN
            if vn_day >= 5:
                features["trading_session"] = "SESSION_WEEKEND"
            elif 7.0 <= vn_hour < 14.0:
                features["trading_session"] = "SESSION_ASIA"
            elif 14.0 <= vn_hour < 19.5:
                features["trading_session"] = "SESSION_EUROPE"
            elif 19.5 <= vn_hour < 23.5:
                features["trading_session"] = "SESSION_US_OPEN"
            else:
                features["trading_session"] = "SESSION_US_LATE"
        except Exception:
            features["trading_session"] = "SESSION_ASIA"
    else:
        features["trading_session"] = "SESSION_ASIA"

    return features

def train_and_export_model():
    print("=" * 80)
    print("🤖 HỌC VÀ TẠO MÔ HÌNH DỰ ĐOÁN XÁC SUẤT AI (TRAIN AI REVIEWER MODEL)")
    print("=" * 80)

    dataset = []

    # 1. Load real trades
    if os.path.exists(DATASET_PATH):
        entries = {}
        with open(DATASET_PATH, 'r', encoding='utf-8') as f:
            for l in f:
                l_str = l.strip()
                if not l_str or l_str.startswith('<') or l_str.startswith('='): continue
                try:
                    rec = json.loads(l_str)
                except Exception:
                    continue

                if rec.get("type") == "ENTRY":
                    entries[rec.get("tradeId")] = rec
                elif rec.get("type") == "EXIT":
                    tid = rec.get("tradeId")
                    if rec.get("exitType") in ["TP", "SL", "TRAILING_SL", "HARD_MAX_LOSS", "BE_EXIT"] and tid in entries:
                        entry = entries[tid]
                        dataset.append({
                            "is_win": rec.get("isWin", False),
                            "features": extract_features(
                                entry.get("scoreReasons", []),
                                entry.get("score", 0),
                                entry.get("marketCapRank", 999),
                                entry.get("gridWidthPct", 3.5),
                                entry.get("timestamp")
                            )
                        })

    # 2. Load & simulate skipped signals (fast mode)
    if os.path.exists(SKIPPED_PATH):
        with open(SKIPPED_PATH, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        seen = set()
        unique_skipped = []
        for l in reversed(lines):
            if not l.strip(): continue
            try:
                rec = json.loads(l)
                key = f"{rec.get('symbol')}_{rec.get('signal')}_{rec.get('signalTimestamp', 0) // 300000}"
                if key not in seen:
                    seen.add(key)
                    unique_skipped.append(rec)
            except Exception:
                pass

        # Fast simulation or local tracked resolution
        for rec in unique_skipped[:30]:
            outcome = rec.get("hypotheticalOutcome") or ( "TP" if rec.get("hypotheticalTP") else ("SL" if rec.get("hypotheticalSL") else None) )
            if not outcome and os.environ.get("FETCH_REMOTE") == "1":
                outcome = simulate_skipped_signal(rec)
            if outcome in ["TP", "SL"]:
                dataset.append({
                    "is_win": (outcome == "TP"),
                    "features": extract_features(
                        rec.get("scoreReasons", []),
                        rec.get("score", 0),
                        rec.get("marketCapRank", 999),
                        rec.get("gridWidthPct", 3.5),
                        rec.get("signalTimestamp")
                    )
                })

    total_samples = len(dataset)
    win_samples = sum(1 for d in dataset if d["is_win"])
    loss_samples = total_samples - win_samples
    prior_win = win_samples / total_samples if total_samples > 0 else 0.645

    print(f"\n📊 Dữ liệu huấn luyện: {total_samples} mẫu ({win_samples} Thắng, {loss_samples} Thua)")
    print(f"   • Tỷ lệ thắng cơ sở (Prior Win Probability): {prior_win * 100:.1f}%\n")

    # Count feature occurrences
    feature_counts = defaultdict(lambda: {"win": 0, "loss": 0})
    for d in dataset:
        is_win = d["is_win"]
        for feat_category, feat_val in d["features"].items():
            key = f"{feat_category}:{feat_val}"
            if is_win:
                feature_counts[key]["win"] += 1
            else:
                feature_counts[key]["loss"] += 1

    # Apply m-estimate smoothing (m = 12.0, p = prior_win) to prevent overfitting on small sample sizes
    M_SMOOTHING = 12.0
    feature_weights = {}

    for key, counts in feature_counts.items():
        w_win = counts["win"]
        w_loss = counts["loss"]
        n_feat = w_win + w_loss

        smoothed_win_prob = (w_win + M_SMOOTHING * prior_win) / (n_feat + M_SMOOTHING)
        weight_mult = smoothed_win_prob / prior_win

        feature_weights[key] = {
            "winCount": w_win,
            "lossCount": w_loss,
            "winProb": round(smoothed_win_prob, 4),
            "multiplier": round(weight_mult, 4)
        }

    # Import & nạp quy tắc bóc tách từ tài liệu kiến thức cục bộ
    KNOWLEDGE_RULES_PATH = os.path.join(BASE_DIR, "data", "knowledge_rules.json")
    if os.path.exists(KNOWLEDGE_RULES_PATH):
        try:
            with open(KNOWLEDGE_RULES_PATH, 'r', encoding='utf-8') as f:
                k_data = json.load(f)
                rule_mods = k_data.get("rule_modifiers", {})
                for k_key, k_mult in rule_mods.items():
                    if k_key in feature_weights:
                        feature_weights[k_key]["multiplier"] = round(feature_weights[k_key]["multiplier"] * k_mult, 4)
                        feature_weights[k_key]["knowledgeBoost"] = k_mult
                    else:
                        feature_weights[k_key] = {
                            "winCount": 0,
                            "lossCount": 0,
                            "winProb": round(prior_win * k_mult, 4),
                            "multiplier": round(k_mult, 4),
                            "knowledgeBoost": k_mult
                        }
                print(f"📖 Đã tích hợp thành công {len(rule_mods)} quy tắc kiến thức sách PDF vào mô hình!")
        except Exception as e:
            print(f"⚠️ Lỗi nạp knowledge_rules.json: {e}")

    model_output = {
        "version": "1.2.0",
        "trainedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "totalSamples": total_samples,
        "priorWinProb": round(prior_win, 4),
        "thresholdApprovalPct": 58.0,
        "minExpectedEvRoi": 0.5,
        "featureWeights": feature_weights
    }

    with open(OUTPUT_MODEL_PATH, 'w', encoding='utf-8') as f:
        json.dump(model_output, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Đã xuất mô hình AI Reviewer Offline thành công tại: {OUTPUT_MODEL_PATH}")

if __name__ == "__main__":
    train_and_export_model()
