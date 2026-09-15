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
MINED_PATH = os.path.join(BASE_DIR, "data", "ai_mined_dataset.jsonl")
SHADOW_PATH = os.path.join(BASE_DIR, "data", "shadow_trades_history.jsonl")
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

def extract_features(reasons, score, rank, grid_width_pct, timestamp_ms=None, direct_record=None):
    reasons_str = " ".join(reasons)
    features = {}

    # 1. Score Group
    if score >= 7.0: features["score_group"] = "SCORE_HIGH_GE7"
    elif score >= 6.0: features["score_group"] = "SCORE_MID_6_TO_7"
    elif score >= 5.0: features["score_group"] = "SCORE_LOW_5_TO_6"
    elif score >= 4.0: features["score_group"] = "SCORE_WEAK_4_TO_5"
    else: features["score_group"] = "SCORE_DANGER_LT4"

    # 2. MarketCap Rank
    if rank <= 10: features["rank_group"] = "RANK_TOP10"
    elif rank <= 30: features["rank_group"] = "RANK_TOP30"
    elif rank <= 150: features["rank_group"] = "RANK_MIDCAP_150"
    else: features["rank_group"] = "RANK_LOWCAP_OUT150"

    # Extract structured signalMetrics if available in direct_record
    sm = direct_record.get("signalMetrics") if (direct_record and isinstance(direct_record, dict)) else None

    # 3. Trend Alignment
    if sm and sm.get("trend"):
        features["trend"] = sm["trend"]
    elif "Dow & Trendline" in reasons_str: features["trend"] = "TREND_PERFECT"
    elif "H1 Sideway nhưng M15 có cấu trúc" in reasons_str: features["trend"] = "TREND_M15_ALIGNED"
    elif "EMA20<EMA50" in reasons_str or "EMA20>EMA50" in reasons_str: features["trend"] = "TREND_EMA"
    elif "Ngược/Mâu thuẫn" in reasons_str: features["trend"] = "TREND_CONFLICT"
    else: features["trend"] = "TREND_NEUTRAL"

    # 3b. ADX Momentum Strength
    if sm and sm.get("adxStrength"):
        features["adx_strength"] = sm["adxStrength"]
    else:
        import re
        adx_match = re.search(r"ADX=(\d+\.?\d*)", reasons_str)
        if adx_match:
            adx_val = float(adx_match.group(1))
            features["adx_strength"] = "ADX_STRONG_TREND" if adx_val >= 25.0 else "ADX_WEAK_TREND"
        else:
            features["adx_strength"] = "ADX_NORMAL"

    # Extract numerical marketMetrics if available in direct_record
    mm = direct_record.get("marketMetrics") if (direct_record and isinstance(direct_record, dict)) else None

    # 4 & 4b. H1 & M15 Volatility Compression (Tách biệt 100% Số Học Thuần Túy)
    if mm:
        # Nhánh 1: Dữ liệu số học chuẩn xác (Độc lập 100%, không dính dáng text)
        curr_h1_range = mm.get("h1RangePct")
        last_h1_range = mm.get("lastClosedH1RangePct")
        max_3h1_range = mm.get("max3H1RangePct")
        max_h1_range = max([r for r in [curr_h1_range, last_h1_range, max_3h1_range] if r is not None] or [0.0])

        if max_h1_range >= 8.0:
            features["h1_volatility"] = "H1_EXTREME_STORM_PUMP_DUMP"
        elif max_h1_range >= 4.0:
            features["h1_volatility"] = "H1_VOLATILE_DANGER"
        elif max_h1_range <= 1.5:
            features["h1_volatility"] = "H1_ULTRA_COMPRESSED"
        elif max_h1_range <= 2.5:
            features["h1_volatility"] = "H1_MID_COMPRESSED"
        else:
            features["h1_volatility"] = "H1_VOL_NORMAL"

        m15_vol = mm.get("m15VolRatio") or 1.0
        curr_m15_range = mm.get("m15RangePct")
        last_m15_range = mm.get("lastClosedM15RangePct")
        max_m15_range = max([r for r in [curr_m15_range, last_m15_range] if r is not None] or [0.0])

        if max_m15_range >= 6.0:
            features["m15_volatility"] = "M15_EXTREME_STORM"
        elif m15_vol >= 3.0 or max_m15_range >= 3.0:
            features["m15_volatility"] = "M15_VOLATILE_DANGER"
        elif m15_vol >= 2.0:
            features["m15_volatility"] = "M15_VOLUME_SURGE"
        elif max_m15_range <= 0.8:
            features["m15_volatility"] = "M15_ULTRA_COMPRESSED"
        elif max_m15_range <= 1.5:
            features["m15_volatility"] = "M15_MID_COMPRESSED"
        else:
            features["m15_volatility"] = "M15_VOL_NORMAL"
    else:
        # Nhánh 2: Dự phòng (Fallback) cho các bản ghi lịch sử cũ chưa có marketMetrics
        if "H1 bão giá" in reasons_str or "biến động cực đại" in reasons_str:
            features["h1_volatility"] = "H1_EXTREME_STORM_PUMP_DUMP"
        elif "H1 biến động mạnh" in reasons_str or "đều biến động mạnh" in reasons_str:
            features["h1_volatility"] = "H1_VOLATILE_DANGER"
        elif "H1 siêu nén" in reasons_str:
            features["h1_volatility"] = "H1_ULTRA_COMPRESSED"
        elif "H1 nén vừa" in reasons_str:
            features["h1_volatility"] = "H1_MID_COMPRESSED"
        else:
            features["h1_volatility"] = "H1_VOL_NORMAL"

        if "M15 bão giá" in reasons_str:
            features["m15_volatility"] = "M15_EXTREME_STORM"
        elif "M15 đột biến Volume" in reasons_str or "đột biến Volume" in reasons_str:
            features["m15_volatility"] = "M15_VOLUME_SURGE"
        elif "M15 biến động mạnh" in reasons_str or "đều biến động mạnh" in reasons_str:
            features["m15_volatility"] = "M15_VOLATILE_DANGER"
        elif "M15 siêu nén" in reasons_str:
            features["m15_volatility"] = "M15_ULTRA_COMPRESSED"
        elif "M15 nén vừa" in reasons_str:
            features["m15_volatility"] = "M15_MID_COMPRESSED"
        else:
            features["m15_volatility"] = "M15_VOL_NORMAL"

    # 4c. H1 Stagnant Liquidity Trap
    if "Nén bế tắc H1" in reasons_str: features["h1_stagnant"] = "H1_STAGNANT_TRAP"
    else: features["h1_stagnant"] = "H1_NOT_STAGNANT"

    # 5. RSI Condition
    if sm and sm.get("rsiCondition"):
        features["rsi"] = sm["rsiCondition"]
    elif "Quá bán cực đại" in reasons_str or "Quá mua cực đại" in reasons_str: features["rsi"] = "RSI_EXTREME"
    elif "Cận quá bán" in reasons_str or "Cận quá mua" in reasons_str: features["rsi"] = "RSI_NEAR"
    else: features["rsi"] = "RSI_NEUTRAL"

    # 6. Whales vs Retail Flow
    if sm and sm.get("lsFlow"):
        features["ls_flow"] = sm["lsFlow"]
    elif "Gold Setup" in reasons_str or "Đồng thuận tuyệt đối" in reasons_str: features["ls_flow"] = "LS_GOLD"
    elif "Đồng thuận một phần" in reasons_str: features["ls_flow"] = "LS_PARTIAL"
    elif "Không đồng thuận" in reasons_str or "phân kỳ" in reasons_str: features["ls_flow"] = "LS_DIVERGENCE"
    else: features["ls_flow"] = "LS_NEUTRAL"

    # 7. Price Action S/R Levels
    if sm and sm.get("priceAction"):
        features["price_action"] = sm["priceAction"]
    elif "4 cản cũ" in reasons_str: features["price_action"] = "PA_4_LEVELS"
    elif "3 cản cũ" in reasons_str: features["price_action"] = "PA_3_LEVELS"
    elif "2 cản cũ" in reasons_str: features["price_action"] = "PA_2_LEVELS"
    elif "1 cản cũ" in reasons_str: features["price_action"] = "PA_1_LEVEL"
    else: features["price_action"] = "PA_0_LEVEL"

    # 7b. Price Action S/R Quality (Phân cấp cản D1 bảo trợ vs H4 ngắn hạn vs Không cản)
    if sm and sm.get("srQuality"):
        features["sr_quality"] = sm["srQuality"]
    else:
        d1_part = reasons_str.split("D1:")[1] if "D1:" in reasons_str else ""
        has_d1 = bool(d1_part and "không cản" not in d1_part and "thiếu nến" not in d1_part)
        h4_part = reasons_str.split("H4:")[1].split("|")[0] if "H4:" in reasons_str else ""
        has_h4 = bool(h4_part and "chỉ có 0 cản" not in h4_part and "0 cản cũ" not in h4_part and "thiếu nến" not in h4_part)

        if has_d1:
            features["sr_quality"] = "SR_DAILY_D1_INCLUDED"
        elif has_h4:
            features["sr_quality"] = "SR_H4_ONLY"
        else:
            features["sr_quality"] = "SR_NONE"

    # 8. Open Interest (OI) Change
    if sm and sm.get("oiState"):
        features["oi_change"] = sm["oiState"]
    elif "Hạ nhiệt vị thế" in reasons_str or "giảm -" in reasons_str: features["oi_change"] = "OI_COOLING"
    elif "Tăng mạnh" in reasons_str or "bùng nổ" in reasons_str: features["oi_change"] = "OI_SURGE"
    else: features["oi_change"] = "OI_STABLE"

    # 9. Volume Momentum
    if sm and sm.get("volumeState"):
        features["volume"] = sm["volumeState"]
    elif "Volume bùng nổ" in reasons_str: features["volume"] = "VOL_SURGE"
    elif "Volume ổn định" in reasons_str: features["volume"] = "VOL_STABLE"
    else: features["volume"] = "VOL_DRY"

    # 9b. H1 3-Candle Volume Burst (Bão Volume H1)
    if sm and sm.get("h1VolumeBurst"):
        features["h1_volume_burst"] = sm["h1VolumeBurst"]
    elif "Đột biến Volume 3 H1" in reasons_str:
        features["h1_volume_burst"] = "H1_VOL_BURST_DANGER"
    else:
        features["h1_volume_burst"] = "H1_VOL_BURST_NORMAL"

    # 10. Funding Rate
    if sm and sm.get("fundingState"):
        features["funding"] = sm["fundingState"]
    elif "Short Crowded" in reasons_str or "Long Crowded" in reasons_str: features["funding"] = "FUNDING_SQUEEZE"
    elif "Short đu bám" in reasons_str or "Long đu bám" in reasons_str or "Nóng" in reasons_str: features["funding"] = "FUNDING_DANGER"
    else: features["funding"] = "FUNDING_NORMAL"

    # 11. BTC Wave
    if sm and sm.get("btcWave"):
        features["btc_wave"] = sm["btcWave"]
    elif "BTC thuận Dow/EMA" in reasons_str: features["btc_wave"] = "BTC_ALIGNED"
    elif "BTC đi ngang/trung tính" in reasons_str: features["btc_wave"] = "BTC_NEUTRAL"
    else: features["btc_wave"] = "BTC_COUNTER"

    # 11b. BTC M15 Extreme Volatility Storm (> 1.0%)
    if sm and sm.get("btcStorm"):
        features["btc_storm"] = sm["btcStorm"]
    elif "BTC bão giá" in reasons_str:
        features["btc_storm"] = "BTC_STORM_VOLATILE"
    else:
        features["btc_storm"] = "BTC_STORM_NORMAL"

    # 12. Grid Width Pct
    gw = float(grid_width_pct) if grid_width_pct is not None else 3.5
    if gw > 5.0: features["grid_width"] = "GRID_WIDE"
    elif gw >= 2.5: features["grid_width"] = "GRID_NORMAL"
    else: features["grid_width"] = "GRID_NARROW"

    # 12b. Pre-Entry Bounce (Độ nảy trước khi khớp lệnh)
    bounce_val = None
    if direct_record and isinstance(direct_record.get("maxRecentBouncePct"), (int, float)):
        bounce_val = float(direct_record["maxRecentBouncePct"])

    if "Giá đã nảy xa mốc" in reasons_str or (bounce_val is not None and bounce_val >= 1.0):
        features["pre_entry_bounce"] = "BOUNCE_STALE_HIGH"
    elif "Giá chớm nảy" in reasons_str or (bounce_val is not None and bounce_val >= 0.40):
        features["pre_entry_bounce"] = "BOUNCE_MODERATE"
    else:
        features["pre_entry_bounce"] = "BOUNCE_FRESH"

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
            features["trading_session"] = "SESSION_UNKNOWN"
    else:
        features["trading_session"] = "SESSION_UNKNOWN"

    # 14. Phân loại vốn hóa Lowcap vs Majors đã được đảm nhiệm toàn diện bởi:
    # - Đặc trưng rank_group (RANK_LOWCAP_OUT150 vs RANK_TOP10/30/MIDCAP)
    # - Ngưỡng phê duyệt WinProbability (68% cho Lowcap vs 60% cho Majors)
    # Không tạo thêm các feature lowcap_* nhân bản trùng lặp để tuân thủ nguyên lý Naive Bayes.

    # 15. M15 Dynamic Candle Momentum vs Signal Direction (Chống chặn đầu xe lửa Pump/Dump)
    sig_dir = str(direct_record.get("signal") or "").upper() if direct_record else ""
    if mm:
        is_green = mm.get("m15IsGreen")
        m15_range = mm.get("m15RangePct") or 0.0
        m15_body = mm.get("m15BodyPct") or 0.0
        m15_vol = mm.get("m15VolRatio") or 1.0

        if sig_dir in ["SHORT", "SELL"] and is_green is True and (m15_body >= 3.0 or m15_range >= 5.0 or (m15_range >= 3.5 and m15_vol >= 3.0)):
            features["candle_momentum"] = "MOMENTUM_COUNTER_PUMP_TRAIN"
        elif sig_dir in ["LONG", "BUY"] and is_green is False and (m15_body >= 3.0 or m15_range >= 5.0 or (m15_range >= 3.5 and m15_vol >= 3.0)):
            features["candle_momentum"] = "MOMENTUM_COUNTER_DUMP_TRAIN"
        else:
            features["candle_momentum"] = "MOMENTUM_NORMAL"
    else:
        features["candle_momentum"] = "MOMENTUM_NORMAL"

    # 16. Multi-Factor Risk Interactions (AI tự học tương tác rủi ro)
    is_trend_conflict = features.get("trend") == "TREND_CONFLICT"
    is_ls_div = features.get("ls_flow") == "LS_DIVERGENCE"
    is_no_sr = features.get("price_action") == "PA_0_LEVEL"
    is_dry_vol = features.get("volume") == "VOL_DRY"
    is_cooling_oi = features.get("oi_change") == "OI_COOLING"
    is_vol_danger = (
        features.get("h1_volatility") == "H1_VOLATILE_DANGER" or
        features.get("m15_volatility") in ["M15_VOLATILE_DANGER", "M15_VOLUME_SURGE"]
    )
    is_counter_train = features.get("candle_momentum") in ["MOMENTUM_COUNTER_PUMP_TRAIN", "MOMENTUM_COUNTER_DUMP_TRAIN"]

    if is_vol_danger and (is_trend_conflict or is_ls_div or is_counter_train):
        features["risk_interaction"] = "INTERACTION_HIGH_VOLATILITY_WEAK_SETUP"
    elif is_trend_conflict and is_ls_div:
        features["risk_interaction"] = "INTERACTION_TREND_FLOW_CONFLICT"
    elif is_no_sr and (is_trend_conflict or is_ls_div or features.get("trend") == "TREND_NEUTRAL"):
        features["risk_interaction"] = "INTERACTION_NO_SR_WEAK_SETUP"
    elif is_dry_vol and is_cooling_oi:
        features["risk_interaction"] = "INTERACTION_DRY_VOL_COOLING_OI"
    else:
        features["risk_interaction"] = "INTERACTION_BALANCED"

    # 17. BTC Flash & Turnover Guard (chuyển giao cho AI học)
    if "Turnover" in reasons_str or "ABNORMAL_TURNOVER" in reasons_str:
        features["turnover_guard"] = "TURNOVER_RISK_BLOCKED"
    else:
        features["turnover_guard"] = "TURNOVER_NORMAL"

    if "BTC_FLASH_PUMP" in reasons_str:
        features["btc_flash"] = "BTC_FLASH_PUMP_ACTIVE"
    elif "BTC_FLASH_DUMP" in reasons_str:
        features["btc_flash"] = "BTC_FLASH_DUMP_ACTIVE"
    else:
        features["btc_flash"] = "BTC_FLASH_NORMAL"

    # 18. H1 Candle Geometry vs Entry
    h1_direct = str(direct_record.get("h1CandleGeometry") or (sm.get("h1CandleGeometry") if sm else "") or "") if direct_record else ""
    if "PUNCTURED_DEEP" in h1_direct or "H1 đóng nến lụt sâu" in reasons_str:
        features["h1_candle_geometry"] = "H1_PUNCTURED_DEEP"
    elif "PUNCTURED_LIGHT" in h1_direct or "H1 đóng nến chớm lụt" in reasons_str:
        features["h1_candle_geometry"] = "H1_PUNCTURED_LIGHT"
    elif "REJECT_PINBAR" in h1_direct or "H1 rút chân" in reasons_str or "H1 rút râu" in reasons_str:
        features["h1_candle_geometry"] = "H1_REJECT_PINBAR"
    else:
        features["h1_candle_geometry"] = "H1_HOLD_OR_HOVER"

    # 19. M15 Candle Geometry vs Entry
    m15_direct = str(direct_record.get("m15CandleGeometry") or (sm.get("m15CandleGeometry") if sm else "") or "") if direct_record else ""
    if "PUNCTURED_DEEP" in m15_direct or "M15 đóng nến lụt sâu" in reasons_str:
        features["m15_candle_geometry"] = "M15_PUNCTURED_DEEP"
    elif "PUNCTURED_LIGHT" in m15_direct or "M15 đóng nến chớm lụt" in reasons_str:
        features["m15_candle_geometry"] = "M15_PUNCTURED_LIGHT"
    elif "REJECT_PINBAR" in m15_direct or "M15 rút chân" in reasons_str or "M15 rút râu" in reasons_str:
        features["m15_candle_geometry"] = "M15_REJECT_PINBAR"
    else:
        features["m15_candle_geometry"] = "M15_HOLD_OR_HOVER"

    # 20. Interaction: Cả H1 và M15 đều đóng nến lụt sâu qua Entry
    if (features["h1_candle_geometry"] == "H1_PUNCTURED_DEEP" and
        features["m15_candle_geometry"] in ["M15_PUNCTURED_DEEP", "M15_PUNCTURED_LIGHT"]):
        features["puncture_interaction"] = "INTERACTION_H1_M15_PUNCTURED"
    elif features["h1_candle_geometry"] == "H1_PUNCTURED_DEEP":
        features["puncture_interaction"] = "INTERACTION_H1_PUNCTURED_DEEP"
    elif features["m15_candle_geometry"] == "M15_PUNCTURED_DEEP":
        features["puncture_interaction"] = "INTERACTION_M15_PUNCTURED_DEEP"
    else:
        features["puncture_interaction"] = "INTERACTION_PUNCTURE_NORMAL"

    return features

def train_and_export_model():
    print("=" * 80)
    print("🤖 HỌC VÀ TẠO MÔ HÌNH DỰ ĐOÁN XÁC SUẤT AI (TRAIN AI REVIEWER MODEL - BAYES ODDS RATIO)")
    print("=" * 80)

    dataset = []

    # 1. Load real trades từ ai_trade_dataset.jsonl (Trọng số 2.0 vì là lệnh thực tế nạp rút tiền)
    real_count = 0
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
                    exit_type = rec.get("exitType")
                    if exit_type in ["TP", "SL", "TRAILING_SL", "HARD_MAX_LOSS", "BE_EXIT"] and tid in entries:
                        entry = entries[tid]
                        is_win = rec.get("isWin", False)
                        if is_win:
                            win_credit = 1.0
                        elif exit_type == "BE_EXIT":
                            win_credit = 0.50
                        else:
                            win_credit = 0.0

                        dataset.append({
                            "win_credit": win_credit,
                            "weight": 4.0,
                            "features": extract_features(
                                entry.get("scoreReasons", []),
                                entry.get("score", 0),
                                entry.get("marketCapRank", 999),
                                entry.get("gridWidthPct", 3.5),
                                entry.get("timestamp"),
                                direct_record=entry
                            )
                        })
                        real_count += 1
        print(f"💰 Đã nạp {real_count} mẫu từ tài khoản thực tế (ai_trade_dataset.jsonl, Trọng số 4.0x)")

    # 2. Load shadow trades từ shadow_trades_history.jsonl (Trọng số 0.5, theo dõi nhịp nảy nhanh <= 4h)
    shadow_count = 0
    if os.path.exists(SHADOW_PATH):
        with open(SHADOW_PATH, 'r', encoding='utf-8') as f:
            for l in f:
                if not l.strip(): continue
                try:
                    rec = json.loads(l.strip())
                    outcome = rec.get("outcome")
                    if outcome in ["MISSED_TP", "SAVED_SL", "SAVED_BE", "TP", "SL", "BE"]:
                        holding_mins = rec.get("holdingDurationMinutes") or (
                            (rec.get("exitTimestamp", 0) - rec.get("entryTimestamp", 0)) / 60000
                            if rec.get("exitTimestamp") and rec.get("entryTimestamp") else 0
                        )
                        # 🛡️ LOẠI BỎ ẢO TƯỞNG SHADOW TRADES:
                        # Bản chất lưới 369 là nhịp nảy ngắn hạn (1-4h). Nếu shadow trade ngâm 10-48h mới chạm TP
                        # thì đó là do thị trường trôi dạt tự do, KHÔNG PHẢI edge của chiến lược -> Không tính là Win!
                        if outcome in ["MISSED_TP", "TP"]:
                            win_credit = 0.0 if holding_mins > 240 else 1.0
                        elif outcome in ["SAVED_BE", "BE"]:
                            win_credit = 0.50
                        else:
                            win_credit = 0.0

                        dataset.append({
                            "win_credit": win_credit,
                            "weight": 0.5,
                            "features": extract_features(
                                rec.get("scoreReasons", []),
                                rec.get("score", 0),
                                rec.get("marketCapRank", 999),
                                rec.get("gridWidthPct", 3.5),
                                rec.get("entryTimestamp"),
                                direct_record=rec
                            )
                        })
                        shadow_count += 1
                except Exception:
                    continue
        print(f"👻 Đã nạp {shadow_count} mẫu từ shadow trading sàn Binance (shadow_trades_history.jsonl, Trọng số 0.5x, Lọc trần <= 4h)")

    # 3. Load mined dataset từ ai_mined_dataset.jsonl (Chỉ dùng làm dữ liệu mồi nếu chưa đủ 200 mẫu lệnh thật)
    real_sample_count = len(dataset)
    if real_sample_count < 200 and os.path.exists(MINED_PATH):
        mined_count = 0
        mined_tp = 0
        mined_be = 0
        mined_sl = 0
        with open(MINED_PATH, 'r', encoding='utf-8') as f:
            for l in f:
                l_str = l.strip()
                if not l_str: continue
                try:
                    rec = json.loads(l_str)
                    outcome = rec.get("outcome")
                    if outcome in ["TP", "BREAKEVEN", "SL"]:
                        if outcome == "TP":
                            win_credit = 1.0
                            mined_tp += 1
                        elif outcome == "BREAKEVEN":
                            win_credit = 0.50
                            mined_be += 1
                        else:
                            win_credit = 0.0
                            mined_sl += 1

                        dataset.append({
                            "win_credit": win_credit,
                            "weight": 0.20,
                            "features": extract_features(
                                rec.get("scoreReasons", []),
                                rec.get("score", 0),
                                rec.get("marketCapRank", 999),
                                rec.get("gridWidthPct", 3.5),
                                rec.get("timestamp"),
                                direct_record=rec
                            )
                        })
                        mined_count += 1
                except Exception:
                    continue
        print(f"⛏️  Đã nạp {mined_count} mẫu bổ trợ từ tệp khai phá (ai_mined_dataset.jsonl): {mined_tp} TP, {mined_be} BE, {mined_sl} SL")
    else:
        print(f"🎯 Dữ liệu thực tế sàn Binance đã đạt {real_sample_count} mẫu (>= 200). Ưu tiên 100% dữ liệu thị trường thực tế (Real + Shadow Trades).")

    total_samples = len(dataset)
    total_weight = sum(d["weight"] for d in dataset)
    total_win_credit = sum(d["win_credit"] * d["weight"] for d in dataset)
    total_loss_credit = sum((1.0 - d["win_credit"]) * d["weight"] for d in dataset)
    prior_win = total_win_credit / total_weight if total_weight > 0 else 0.525
    prior_odds = prior_win / (1.0 - prior_win)

    print(f"\n📊 Dữ liệu huấn luyện toàn diện: {total_samples} mẫu (Tổng điểm Win có trọng số: {total_win_credit:.1f}, Loss: {total_loss_credit:.1f})")
    print(f"   • Tỷ lệ thắng cơ sở thực tế (Prior Win Probability): {prior_win * 100:.2f}%")
    print(f"   • Tỷ lệ cược cơ sở (Prior Odds): {prior_odds:.4f}\n")

    # Count feature occurrences with weighted win/loss credits
    feature_counts = defaultdict(lambda: {"win": 0.0, "loss": 0.0})
    for d in dataset:
        w_cred = d["win_credit"] * d["weight"]
        l_cred = (1.0 - d["win_credit"]) * d["weight"]
        for feat_category, feat_val in d["features"].items():
            key = f"{feat_category}:{feat_val}"
            feature_counts[key]["win"] += w_cred
            feature_counts[key]["loss"] += l_cred


    # Apply m-estimate smoothing (m = 15.0, p = prior_win) và tính Bayesian Odds Ratio
    M_SMOOTHING = 15.0
    feature_weights = {}

    for key, counts in feature_counts.items():
        w_win = counts["win"]
        w_loss = counts["loss"]
        n_feat = w_win + w_loss

        smoothed_win_prob = (w_win + M_SMOOTHING * prior_win) / (n_feat + M_SMOOTHING)
        smoothed_win_prob = max(0.01, min(0.99, smoothed_win_prob))
        feat_odds = smoothed_win_prob / (1.0 - smoothed_win_prob)
        weight_mult = feat_odds / prior_odds

        # Giới hạn an toàn (cap) từ 0.20 đến 3.0 để tránh phân kỳ cực đoan
        weight_mult = max(0.20, min(3.0, weight_mult))

        # 🎯 BASELINE ANCHORING: Các trạng thái bình thường/trung tính là mốc quy chiếu (baseline = 1.0),
        # triệt tiêu hoàn toàn hiện tượng 10-15 nhãn "bình thường" cùng nhân dồn đẩy xác suất ảo lên 85%-95%!
        feat_val = key.split(":")[-1]
        if feat_val.endswith("_NORMAL") or feat_val.endswith("_NEUTRAL") or feat_val.endswith("_BALANCED") or feat_val in ["SR_NONE", "PA_0_LEVEL"]:
            weight_mult = min(1.00, weight_mult)

        feature_weights[key] = {
            "winCount": round(w_win, 1),
            "lossCount": round(w_loss, 1),
            "winProb": round(smoothed_win_prob, 4),
            "multiplier": round(weight_mult, 4)
        }

    # Import & nạp quy tắc tiên nghiệm từ knowledge_rules.json với Bayesian Blend (N_PRIOR_WEIGHT = 50.0)
    N_PRIOR_WEIGHT = 50.0  # Trọng số tương đương 50 mẫu kinh nghiệm chuyên gia
    KNOWLEDGE_RULES_PATH = os.path.join(BASE_DIR, "data", "knowledge_rules.json")
    applied_count = 0
    if os.path.exists(KNOWLEDGE_RULES_PATH):
        try:
            with open(KNOWLEDGE_RULES_PATH, 'r', encoding='utf-8') as f:
                k_data = json.load(f)
                rule_mods = k_data.get("rule_modifiers", {})
                for k_key, k_mult in rule_mods.items():
                    if k_key in feature_weights:
                        n = feature_weights[k_key]["winCount"] + feature_weights[k_key]["lossCount"]
                        emp_mult = feature_weights[k_key]["multiplier"]
                        # Bayesian Smooth Blending: (N * empirical + N_0 * knowledge) / (N + N_0)
                        blended = round((n * emp_mult + N_PRIOR_WEIGHT * k_mult) / (n + N_PRIOR_WEIGHT), 4)
                        feature_weights[k_key]["multiplier"] = blended
                        feature_weights[k_key]["knowledgeBoost"] = k_mult
                        feature_weights[k_key]["blendRatio"] = round(n / (n + N_PRIOR_WEIGHT), 2)
                        applied_count += 1
                    else:
                        feature_weights[k_key] = {
                            "winCount": 0,
                            "lossCount": 0,
                            "winProb": round(prior_win, 4),
                            "multiplier": round(k_mult, 4),
                            "knowledgeBoost": k_mult,
                            "blendRatio": 0.0
                        }
                        applied_count += 1
                print(f"📖 Đã tích hợp {applied_count}/{len(rule_mods)} quy tắc tiên nghiệm (Bayesian Soft Blend N_0=50)")
        except Exception as e:
            print(f"⚠️ Lỗi nạp knowledge_rules.json: {e}")

    # 🛡️ DOMAIN-SPECIFIC BAYESIAN GUARDRAILS (Chống nhiễu dữ liệu làm sai lệch bản chất rủi ro)
    # 1. Các trạng thái rủi ro/nguy hiểm KHÔNG BAO GIỜ được phép thành nhân tố thưởng (> 1.0)
    # 2. Các trạng thái trung tính/thiếu cản không được phép nhân phóng đại quá mức (> 1.2)
    GUARDRAIL_BOUNDS = {
        "h1_volatility:H1_EXTREME_STORM_PUMP_DUMP": (0.05, 0.20),
        "h1_volatility:H1_VOLATILE_DANGER": (0.30, 0.70),
        "h1_volatility:H1_VOL_NORMAL": (0.85, 1.00),
        "m15_volatility:M15_EXTREME_STORM": (0.05, 0.20),
        "m15_volatility:M15_VOLATILE_DANGER": (0.30, 0.70),
        "m15_volatility:M15_VOLUME_SURGE": (0.30, 0.75),
        "m15_volatility:M15_VOL_NORMAL": (0.85, 1.00),
        "trend:TREND_NEUTRAL": (0.85, 1.00),
        "ls_flow:LS_NEUTRAL": (0.85, 1.00),
        "score_group:SCORE_DANGER_LT4": (0.10, 0.40),
        "score_group:SCORE_WEAK_4_TO_5": (0.40, 0.80),
        "adx_strength:ADX_NORMAL": (0.85, 1.00),
        "price_action:PA_0_LEVEL": (0.50, 0.85),
        "sr_quality:SR_NONE": (0.50, 0.90),
        "risk_interaction:INTERACTION_NO_SR_WEAK_SETUP": (0.30, 0.85),
        "risk_interaction:INTERACTION_HIGH_VOLATILITY_WEAK_SETUP": (0.10, 0.50),
        "candle_momentum:MOMENTUM_COUNTER_PUMP_TRAIN": (0.05, 0.30),
        "candle_momentum:MOMENTUM_COUNTER_DUMP_TRAIN": (0.05, 0.30),
        "puncture_interaction:INTERACTION_H1_M15_PUNCTURED": (0.05, 0.35),
        "puncture_interaction:INTERACTION_H1_PUNCTURED_DEEP": (0.05, 0.40),
    }

    auto_tuned_count = 0
    capped_count = 0
    for feat_k, feat_data in feature_weights.items():
        curr_m = feat_data["multiplier"]
        if feat_k in GUARDRAIL_BOUNDS:
            min_b, max_b = GUARDRAIL_BOUNDS[feat_k]
            clamped_m = max(min_b, min(max_b, curr_m))
            feat_data["multiplier"] = round(clamped_m, 4)
            feat_data["sanityCapped"] = (clamped_m != curr_m)
            feat_data["isAutonomous"] = True
            if feat_data["sanityCapped"]: capped_count += 1
        else:
            clamped_m = max(0.15, min(2.50, curr_m))
            feat_data["multiplier"] = round(clamped_m, 4)
            feat_data["sanityCapped"] = False
            feat_data["isAutonomous"] = True
        auto_tuned_count += 1

    print(f"🛡️ [Guardrails & Auto-Adaptation] Đã chuẩn hóa {auto_tuned_count} trọng số (Áp dụng {capped_count} chốt chặn bảo vệ rủi ro).")

    # 🧠 TỰ ĐỘNG TÍNH TOÁN & HIỆU CHUẨN NGƯỠNG DUYỆT TỐI ƯU (AUTONOMOUS THRESHOLD CALIBRATION)
    optimal_thresholds = calibrate_optimal_thresholds(BASE_DIR, feature_weights, prior_odds, prior_win)

    # 📊 TỰ ĐỘNG THỐNG KÊ HỒ SƠ MFE/MAE ĐỂ TỐI ƯU HÓA TP VÀ BREAKEVEN
    mfe_mae_profile = analyze_mfe_mae_profiles(BASE_DIR)

    # 🛡️ TỰ ĐỘNG HIỆU CHUẨN SÀN SL THÍCH ỨNG (ADAPTIVE DYNAMIC SL FLOOR CALIBRATION)
    adaptive_sl_profile = calibrate_adaptive_sl_profile(BASE_DIR)

    model_output = {
        "version": "1.4.0-auto",
        "trainedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "totalSamples": total_samples,
        "priorWinProb": round(prior_win, 4),
        "priorOdds": round(prior_odds, 4),
        "optimalThresholds": optimal_thresholds,
        "thresholdApprovalPct": optimal_thresholds.get("lowcap", 47.0),
        "minExpectedEvRoi": optimal_thresholds.get("minExpectedEvRoi", 0.0),
        "mfeMaeProfile": mfe_mae_profile,
        "adaptiveSlProfile": adaptive_sl_profile,
        "featureWeights": feature_weights
    }

    with open(OUTPUT_MODEL_PATH, 'w', encoding='utf-8') as f:
        json.dump(model_output, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Đã xuất mô hình AI Reviewer v1.4.0-auto thành công tại: {OUTPUT_MODEL_PATH}")

def calibrate_adaptive_sl_profile(base_dir):
    """
    Tự động phân tích và hiệu chuẩn sàn SL tối ưu (Adaptive Dynamic SL Floor)
    cho Top 150 và Lowcap dựa trên dữ liệu lệnh thực tế và shadow trades.
    """
    rank_map = {}
    mc_path = os.path.join(base_dir, "data", "market_cap_top.json")
    if os.path.exists(mc_path):
        try:
            with open(mc_path, "r", encoding="utf-8") as f:
                rank_map = json.load(f).get("rankMap", {})
        except Exception:
            pass

    dataset_path = os.path.join(base_dir, "data", "ai_trade_dataset.jsonl")
    top150_samples = []
    lowcap_samples = []

    if os.path.exists(dataset_path):
        try:
            records = []
            with open(dataset_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        records.append(json.loads(line.strip()))

            exits = {r.get("tradeId"): r for r in records if r.get("type") == "EXIT"}
            entries = {r.get("tradeId"): r for r in records if r.get("type") == "ENTRY"}

            for tid, ex in exits.items():
                en = entries.get(tid)
                if not en: continue
                ep = float(en.get("entryPrice", 0))
                xp = float(ex.get("exitPrice", 0))
                if ep <= 0 or xp <= 0: continue
                sym = en.get("symbol", "").replace("USDT", "")
                rk = rank_map.get(sym, 999)
                is_win = ex.get("isWin", False)
                grid_w = float(en.get("gridWidthPct") or 3.5)
                move_pct = abs(xp - ep) / ep * 100

                sample = {"is_win": is_win, "move_pct": move_pct, "grid_w": grid_w}
                if rk <= 150:
                    top150_samples.append(sample)
                else:
                    lowcap_samples.append(sample)
        except Exception as e:
            print(f"⚠️ Lỗi nạp dataset cho Adaptive SL: {e}")

    # Tối ưu hóa mốc SL theo kỳ vọng lợi nhuận và biên độ an toàn chống nhiễu M15
    def optimize_sl_floor(samples, candidates, default_floor, min_noise_guard):
        if not samples or len(samples) < 30:
            return default_floor
        best_ev = -999999
        best_floor = default_floor
        for floor in candidates:
            ev = 0.0
            for s in samples:
                tp_dist = min(max(s["grid_w"] * 0.45, 1.2), 3.0)
                eff_floor = max(floor, min_noise_guard)
                if s["is_win"]:
                    ev += (tp_dist / eff_floor) * 1.5
                else:
                    ev -= 1.5
            if floor < min_noise_guard:
                ev -= len(samples) * 0.05
            if ev > best_ev:
                best_ev = ev
                best_floor = floor
        return best_floor

    opt_top150 = optimize_sl_floor(top150_samples, [0.9, 1.0, 1.1, 1.2, 1.3], 1.0, 0.9)
    opt_lowcap = optimize_sl_floor(lowcap_samples, [1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1], 1.8, 1.6)

    total_samples = len(top150_samples) + len(lowcap_samples)
    print(f"🛡️ [Adaptive SL Profile] Đã hiệu chuẩn: Top150 Min SL = {opt_top150:.2f}%, Lowcap Min SL = {opt_lowcap:.2f}% (Dựa trên {total_samples} mẫu)")

    return {
        "top150MinSlPct": round(opt_top150, 2),
        "lowcapMinSlPct": round(opt_lowcap, 2),
        "autoCalibrated": True,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "sampleCount": total_samples
    }

def analyze_mfe_mae_profiles(base_dir):
    """
    Tự động học ngưỡng dời BE (Breakeven Trigger) tối ưu từ dữ liệu giao dịch lịch sử.
    
    Logic: Với mỗi lệnh thắng, tính khoảng cách từ Entry đến điểm nảy tốt nhất (MFE %).
    Tìm ngưỡng beTriggerPct tối ưu hóa: tỷ lệ lệnh có MFE >= ngưỡng VÀ đến được TP.
    Ngưỡng tốt nhất = nảy đủ mạnh để dời BE mà không bị kích sớm quá (false trigger).
    
    Nguồn dữ liệu:
      - shadow_trades_history.jsonl: entryPrice, tierSlPrice, tierTpPrice, exitPrice, isTradeWin
      - ai_trade_dataset.jsonl: ENTRY có maxRecentBouncePct (MFE trước entry), EXIT có pnlPercent
    """
    shadow_path = os.path.join(base_dir, "data", "shadow_trades_history.jsonl")
    dataset_path = os.path.join(base_dir, "data", "ai_trade_dataset.jsonl")

    # === 1. Thu thập mẫu từ shadow trades ===
    # Shadow trade có đủ: entryPrice, tierSlPrice, tierTpPrice, exitPrice, isTradeWin
    # MFE = khoảng cách từ entry đến exitPrice nếu thắng (hoặc đến tierTpPrice nếu hit TP)
    samples = []
    shadow_count = 0

    if os.path.exists(shadow_path):
        try:
            with open(shadow_path, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    shadow_count += 1
                    t = json.loads(line.strip())
                    ep = float(t.get("entryPrice") or 0)
                    sl = float(t.get("tierSlPrice") or 0)
                    tp = float(t.get("tierTpPrice") or 0)
                    xp = float(t.get("exitPrice") or 0)
                    is_win = bool(t.get("isTradeWin", False))
                    outcome = t.get("outcome", "")

                    if ep <= 0 or sl <= 0 or tp <= 0 or xp <= 0:
                        continue

                    sl_dist_pct = abs(ep - sl) / ep * 100
                    tp_dist_pct = abs(ep - tp) / ep * 100
                    if sl_dist_pct <= 0:
                        continue

                    # MFE: khoảng cách tốt nhất giá đã chạy so với entry (% so với entry)
                    # Với lệnh thắng (TP hit): MFE ≈ tp_dist_pct
                    # Với lệnh thua (SL hit): MFE ≈ khoảng exit - entry (giá thường chạy 1 chút trước khi quay)
                    # Với SAVED_SL: giá nảy đến gần TP rồi mới quay, MFE ≈ exit - entry (ở hướng tốt)
                    if is_win or outcome == "MISSED_TP":
                        # Lệnh thắng: MFE đạt được ≈ tp_dist_pct
                        mfe_pct = tp_dist_pct
                        did_reach_tp = True
                    else:
                        # Lệnh thua: MFE tối thiểu = 0 (không chạy thuận chiều đủ)
                        mfe_pct = 0.0
                        did_reach_tp = False

                    samples.append({
                        "mfe_pct": mfe_pct,
                        "sl_dist_pct": sl_dist_pct,
                        "tp_dist_pct": tp_dist_pct,
                        "did_reach_tp": did_reach_tp,
                        "is_win": is_win
                    })
        except Exception as e:
            print(f"⚠️ [BE Calibration] Lỗi đọc shadow trades: {e}")

    # === 2. Thu thập mẫu bổ sung từ ai_trade_dataset (lệnh thực) ===
    real_count = 0
    if os.path.exists(dataset_path):
        try:
            records = []
            with open(dataset_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        records.append(json.loads(line.strip()))

            exits = {r.get("tradeId"): r for r in records if r.get("type") == "EXIT"}
            entries = {r.get("tradeId"): r for r in records if r.get("type") == "ENTRY"}

            for tid, ex in exits.items():
                en = entries.get(tid)
                if not en:
                    continue
                ep = float(en.get("entryPrice") or 0)
                is_win = bool(ex.get("isWin", False))
                exit_type = ex.get("exitType", "")
                pnl_pct = float(ex.get("pnlPercent") or 0)
                grid_w = float(en.get("gridWidthPct") or 3.5)
                if ep <= 0:
                    continue

                # Ước tính SL và TP từ gridWidth (tương tự calculateTierSLTP)
                sl_dist_pct = min(max(grid_w * 0.5, 1.0), 2.5)
                tp_dist_pct = min(max(grid_w * 0.45, 1.2), 3.0)

                # MFE ước tính từ kết quả: pnlPercent của lệnh / leverage (≈ move%)
                leverage = float(en.get("leverage") or 10)
                move_pct = abs(pnl_pct) / max(leverage, 1) if leverage > 0 else 0

                if is_win:
                    mfe_pct = max(move_pct, tp_dist_pct * 0.8)
                    did_reach_tp = True
                elif exit_type == "TP":
                    mfe_pct = tp_dist_pct
                    did_reach_tp = True
                else:
                    mfe_pct = move_pct * 0.3  # Thua: MFE nhỏ, không chạy xa
                    did_reach_tp = False

                if sl_dist_pct > 0:
                    samples.append({
                        "mfe_pct": mfe_pct,
                        "sl_dist_pct": sl_dist_pct,
                        "tp_dist_pct": tp_dist_pct,
                        "did_reach_tp": did_reach_tp,
                        "is_win": is_win
                    })
                    real_count += 1
        except Exception as e:
            print(f"⚠️ [BE Calibration] Lỗi đọc ai_trade_dataset: {e}")

    total_samples = len(samples)

    # === 3. Tối ưu hóa ngưỡng beTriggerPct ===
    # Ứng viên: 0.3% → 1.5% (bước 0.05%)
    # Tiêu chí tối ưu: tối đa hóa (precision * recall)
    #   precision = P(lệnh đến TP | MFE >= threshold) = tránh dời BE sớm với lệnh sẽ thua
    #   recall    = P(MFE >= threshold | lệnh thắng) = đảm bảo dời BE được đủ nhiều lệnh thắng
    DEFAULT_BE = 0.60
    recommended_be_trigger_pct = DEFAULT_BE
    be_calibration_stats = {}

    if total_samples >= 50:
        candidates = [round(x * 0.05, 2) for x in range(6, 32)]  # 0.30% → 1.55%
        best_f1 = -1.0
        best_threshold = DEFAULT_BE

        win_samples = [s for s in samples if s["did_reach_tp"]]
        all_count = total_samples

        for th in candidates:
            # Lệnh thắng có MFE >= th → True Positive (BE dời đúng)
            tp_count = sum(1 for s in samples if s["mfe_pct"] >= th and s["did_reach_tp"])
            # Lệnh thua có MFE >= th → False Positive (BE dời sai, lãng phí)
            fp_count = sum(1 for s in samples if s["mfe_pct"] >= th and not s["did_reach_tp"])
            # Lệnh thắng có MFE < th → False Negative (thắng nhưng không dời BE được)
            fn_count = sum(1 for s in samples if s["mfe_pct"] < th and s["did_reach_tp"])

            precision = tp_count / (tp_count + fp_count) if (tp_count + fp_count) > 0 else 0
            recall = tp_count / (tp_count + fn_count) if (tp_count + fn_count) > 0 else 0

            # F1 score: cân bằng giữa precision và recall
            # Ưu tiên precision hơn (tránh dời BE quá sớm) → dùng F-beta với beta=0.7
            beta = 0.7
            if precision + recall > 0:
                f_beta = (1 + beta**2) * (precision * recall) / ((beta**2 * precision) + recall)
            else:
                f_beta = 0.0

            if f_beta > best_f1:
                best_f1 = f_beta
                best_threshold = th
                be_calibration_stats = {
                    "threshold": th,
                    "precision": round(precision, 3),
                    "recall": round(recall, 3),
                    "fBeta": round(f_beta, 3),
                    "truePositives": tp_count,
                    "falsePositives": fp_count,
                    "falseNegatives": fn_count
                }

        # Áp dụng guardrail: không để ngưỡng quá thấp (false trigger) hoặc quá cao (bỏ lỡ)
        recommended_be_trigger_pct = max(0.35, min(best_threshold, 1.2))
        print(f"🎯 [BE Trigger Calibration] Ngưỡng tối ưu học được: +{recommended_be_trigger_pct:.2f}%")
        print(f"   • Precision: {be_calibration_stats.get('precision', 0):.1%} | Recall: {be_calibration_stats.get('recall', 0):.1%} | F-beta: {be_calibration_stats.get('fBeta', 0):.3f}")
        print(f"   • TP/FP/FN: {be_calibration_stats.get('truePositives', 0)} / {be_calibration_stats.get('falsePositives', 0)} / {be_calibration_stats.get('falseNegatives', 0)}")
    else:
        print(f"⚠️ [BE Trigger Calibration] Chưa đủ dữ liệu ({total_samples} mẫu < 50), dùng mặc định {DEFAULT_BE}%")

    print(f"📊 [MAE/MFE Profile] Hiệu chuẩn hoàn tất: Optimal TP = 45% GridWidth, Early BE Trigger = +{recommended_be_trigger_pct:.2f}% (Dựa trên {total_samples} mẫu: {shadow_count} shadow + {real_count} real)")

    return {
        "optimalTpGridRatio": 0.45,
        "recommendedBeTriggerPct": recommended_be_trigger_pct,
        "beCalibrationStats": be_calibration_stats,
        "sampleCount": total_samples,
        "shadowCount": shadow_count,
        "realCount": real_count,
        "autoCalibrated": total_samples >= 50,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
    }

def calibrate_optimal_thresholds(base_dir, feature_weights=None, prior_odds=1.3, prior_win=0.565):
    """
    Tự động quét và hiệu chuẩn ngưỡng duyệt tối ưu (Dynamic Threshold Calibration)
    dựa trên kết quả thực tế của shadow trades và real trades.
    Tự động tính lại WinProb với trọng số mới và tìm (threshold_top150, threshold_lowcap) tối đa hóa Net PnL.
    """
    shadow_path = os.path.join(base_dir, "data", "shadow_trades_history.jsonl")
    if not os.path.exists(shadow_path):
        return {
            "top150": 45.0,
            "lowcap": 47.0,
            "minExpectedEvRoi": 0.0,
            "autoCalibrated": False,
            "reason": "Chưa có file shadow_trades_history"
        }

    trades = []
    try:
        with open(shadow_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    trades.append(json.loads(line))
    except Exception as e:
        print(f"⚠️ Lỗi đọc shadow trades khi hiệu chuẩn ngưỡng: {e}")
        return {"top150": 45.0, "lowcap": 47.0, "minExpectedEvRoi": 0.0, "autoCalibrated": False}

    if len(trades) < 15:
        return {
            "top150": 45.0,
            "lowcap": 47.0,
            "minExpectedEvRoi": 0.0,
            "autoCalibrated": False,
            "sampleCount": len(trades)
        }

    # Tính toán lại WinProb của từng lệnh shadow dựa trên feature_weights mới
    recalculated_trades = []
    for t in trades:
        raw_p = t.get("winProbability")
        p = float(raw_p) if raw_p is not None else 50.0
        if feature_weights and t.get("scoreReasons"):
            feats = extract_features(
                t.get("scoreReasons", []),
                t.get("score", 0),
                t.get("marketCapRank", 999),
                t.get("gridWidthPct", 3.5),
                t.get("entryTimestamp"),
                direct_record=t
            )
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

            for cat, val in feats.items():
                if cat in skip_cats: continue
                k = f"{cat}:{val}"
                if k in feature_weights:
                    comb_mult *= feature_weights[k]["multiplier"]

            post_odds = prior_odds * comb_mult
            p = (post_odds / (1.0 + post_odds)) * 100.0
            p = max(5.0, min(95.0, p))

        p_final = float(p) if p is not None else 50.0
        recalculated_trades.append({
            "marketCapRank": t.get("marketCapRank", 999),
            "winProb": p_final,
            "outcome": t.get("outcome"),
            "isMissedTP": t.get("outcome") == "MISSED_TP" or t.get("isMissedTP", False),
            "isSavedSL": t.get("outcome") == "SAVED_SL" or t.get("isSavedSL", False),
            "missedProfitUSD": t.get("missedProfitUSD", 0) or abs(t.get("pnlUsd", 0)),
            "savedLossUSD": t.get("savedLossUSD", 0) or abs(t.get("pnlUsd", 0))
        })

    # Grid search across candidate thresholds thực tế chuẩn xác theo Payoff Ratio R:R 1.5:1
    best_utility = -999999.0
    best_th_top = 50.0
    best_th_low = 58.0
    best_stats = {}

    candidate_top = [48.0, 50.0, 52.0, 55.0, 58.0]
    candidate_low = [54.0, 56.0, 58.0, 60.0, 62.0, 65.0]

    for th_top in candidate_top:
        for th_low in candidate_low:
            if th_low < th_top:
                continue

            n_win = 0
            n_loss = 0
            pnl = 0.0

            for t in recalculated_trades:
                rank = t["marketCapRank"]
                th = th_top if rank <= 150 else th_low
                p = t["winProb"]

                if p >= th:
                    if t["isMissedTP"]:
                        n_win += 1
                        pnl += t["missedProfitUSD"]
                    elif t["isSavedSL"]:
                        n_loss += 1
                        pnl -= t["savedLossUSD"]

            total = n_win + n_loss
            wr = (n_win / total * 100.0) if total > 0 else 0.0

            # Tiêu chuẩn an toàn: Tỷ lệ thắng >= 60.0% và Lợi nhuận kỳ vọng dương
            if total >= 10 and wr >= 60.0 and pnl > 0:
                utility = pnl * (wr / 100.0)
                if utility > best_utility:
                    best_utility = utility
                    best_th_top = th_top
                    best_th_low = th_low
                    best_stats = {
                        "testedSamples": len(recalculated_trades),
                        "approvedTrades": total,
                        "expectedWins": n_win,
                        "expectedLosses": n_loss,
                        "expectedWinRate": round(wr, 1),
                        "expectedNetPnlUsd": round(pnl, 2)
                    }

    print(f"\n🧠 [AI Auto-Calibration] Đã tự động hiệu chuẩn ngưỡng duyệt tối ưu:")
    print(f"   • Top 150 Threshold: {best_th_top}%")
    print(f"   • Lowcap Threshold:  {best_th_low}%")
    if best_stats:
        print(f"   • Thống kê kỳ vọng:  {best_stats.get('expectedWins', 0)}W / {best_stats.get('expectedLosses', 0)}L (WinRate: {best_stats.get('expectedWinRate', 0)}%, Lãi ròng: +${best_stats.get('expectedNetPnlUsd', 0)} USD)")
    else:
        print("   • Dữ liệu chưa đủ để tối ưu hóa utility, áp dụng ngưỡng an toàn mặc định (Top150: 50%, Lowcap: 60%)")

    return {
        "top150": best_th_top,
        "lowcap": best_th_low,
        "minExpectedEvRoi": 0.0,
        "autoCalibrated": True,
        "calibratedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "calibrationStats": best_stats
    }

if __name__ == "__main__":
    train_and_export_model()
