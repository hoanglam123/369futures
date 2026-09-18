import json
import os
import sys
import time
import math
import requests
import datetime
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

# Danh sách mốc sự kiện vĩ mô biến động cực đại của Mỹ (CPI, FOMC, NFP) 2025-2026 (UTC)
RECURRING_HIGH_IMPACT_EVENTS_2025_2026 = [
    # 2026
    '2026-01-09 13:30', '2026-01-14 13:30', '2026-01-28 19:00',
    '2026-02-06 13:30', '2026-02-11 13:30', '2026-03-06 13:30',
    '2026-03-11 12:30', '2026-03-18 18:00', '2026-04-03 12:30',
    '2026-04-10 12:30', '2026-05-01 12:30', '2026-05-06 18:00',
    '2026-05-13 12:30', '2026-06-05 12:30', '2026-06-10 12:30',
    '2026-06-17 18:00', '2026-07-02 12:30', '2026-07-15 12:30',
    '2026-07-29 18:00', '2026-08-07 12:30', '2026-08-12 12:30',
    '2026-09-04 12:30', '2026-09-11 12:30', '2026-09-16 18:00',
    '2026-10-02 12:30', '2026-10-14 12:30', '2026-11-05 19:00',
    '2026-11-06 13:30', '2026-11-12 13:30', '2026-12-04 13:30',
    '2026-12-09 13:30', '2026-12-16 19:00',
    # 2025
    '2025-01-15 13:30', '2025-01-29 19:00', '2025-02-12 13:30',
    '2025-03-12 12:30', '2025-03-19 18:00', '2025-04-10 12:30',
    '2025-05-07 18:00', '2025-05-14 12:30', '2025-06-11 12:30',
    '2025-06-18 18:00', '2025-07-16 12:30', '2025-07-30 18:00',
    '2025-08-13 12:30', '2025-09-10 12:30', '2025-09-17 18:00',
    '2025-10-15 12:30', '2025-10-29 18:00', '2025-11-12 13:30',
    '2025-12-10 13:30', '2025-12-17 19:00'
]

EVENT_TIMESTAMPS_MS = []
for d_str in RECURRING_HIGH_IMPACT_EVENTS_2025_2026:
    try:
        dt = datetime.datetime.strptime(d_str, "%Y-%m-%d %H:%M")
        dt = dt.replace(tzinfo=datetime.timezone.utc)
        EVENT_TIMESTAMPS_MS.append(int(dt.timestamp() * 1000))
    except Exception:
        pass

def is_economic_blackout(timestamp_ms, window_minutes=30):
    if not timestamp_ms:
        return False
    try:
        t_ms = int(timestamp_ms)
    except Exception:
        return False
    window_ms = window_minutes * 60 * 1000
    for ev_ms in EVENT_TIMESTAMPS_MS:
        if abs(ev_ms - t_ms) <= window_ms:
            return True
    return False

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

    # 1. MarketCap Rank
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
    elif sm and isinstance(sm.get("adx"), (int, float)):
        features["adx_strength"] = "ADX_STRONG_TREND" if sm["adx"] >= 25.0 else "ADX_WEAK_TREND"
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

    # 4c. H1 Stagnant Liquidity Trap (Số học hoặc có cấu trúc)
    if sm and sm.get("h1Stagnant"):
        features["h1_stagnant"] = sm["h1Stagnant"]
    elif "Nén bế tắc H1" in reasons_str:
        features["h1_stagnant"] = "H1_STAGNANT_TRAP"
    else:
        features["h1_stagnant"] = "H1_NOT_STAGNANT"

    # 5. RSI Condition (Số học thuần túy từ giá trị RSI)
    if sm and sm.get("rsiCondition"):
        features["rsi"] = sm["rsiCondition"]
    elif sm and isinstance(sm.get("rsi"), (int, float)):
        rsi_val = float(sm["rsi"])
        if rsi_val >= 75 or rsi_val <= 25: features["rsi"] = "RSI_EXTREME"
        elif rsi_val >= 65 or rsi_val <= 35: features["rsi"] = "RSI_NEAR"
        else: features["rsi"] = "RSI_NEUTRAL"
    elif "Quá bán cực đại" in reasons_str or "Quá mua cực đại" in reasons_str: features["rsi"] = "RSI_EXTREME"
    elif "Cận quá bán" in reasons_str or "Cận quá mua" in reasons_str: features["rsi"] = "RSI_NEAR"
    else: features["rsi"] = "RSI_NEUTRAL"

    # 6. Whales vs Retail Flow (Số học từ tỷ lệ cá voi & retail)
    if sm and sm.get("lsFlow"):
        features["ls_flow"] = sm["lsFlow"]
    elif sm and isinstance(sm.get("whaleLongRatio"), (int, float)) and isinstance(sm.get("retailLongRatio"), (int, float)):
        w = float(sm["whaleLongRatio"])
        r = float(sm["retailLongRatio"])
        whale_aligned = (w >= 60.0) or (w <= 40.0)
        retail_aligned = (r <= 45.0) or (r >= 55.0)
        if whale_aligned and retail_aligned: features["ls_flow"] = "LS_GOLD"
        elif whale_aligned: features["ls_flow"] = "LS_PARTIAL"
        elif not whale_aligned and not retail_aligned: features["ls_flow"] = "LS_DIVERGENCE"
        else: features["ls_flow"] = "LS_NEUTRAL"
    elif "Gold Setup" in reasons_str or "Đồng thuận tuyệt đối" in reasons_str: features["ls_flow"] = "LS_GOLD"
    elif "Đồng thuận một phần" in reasons_str: features["ls_flow"] = "LS_PARTIAL"
    elif "Không đồng thuận" in reasons_str or "phân kỳ" in reasons_str: features["ls_flow"] = "LS_DIVERGENCE"
    else: features["ls_flow"] = "LS_NEUTRAL"

    # 7. Price Action S/R Levels (Số học từ tổng cản H4 + D1)
    if sm and sm.get("priceAction"):
        features["price_action"] = sm["priceAction"]
    elif sm and (isinstance(sm.get("h4SrCount"), (int, float)) or isinstance(sm.get("d1SrCount"), (int, float))):
        total_sr = int(sm.get("h4SrCount") or 0) + int(sm.get("d1SrCount") or 0)
        if total_sr >= 4: features["price_action"] = "PA_4_LEVELS"
        elif total_sr == 3: features["price_action"] = "PA_3_LEVELS"
        elif total_sr == 2: features["price_action"] = "PA_2_LEVELS"
        elif total_sr == 1: features["price_action"] = "PA_1_LEVEL"
        else: features["price_action"] = "PA_0_LEVEL"
    elif "4 cản cũ" in reasons_str: features["price_action"] = "PA_4_LEVELS"
    elif "3 cản cũ" in reasons_str: features["price_action"] = "PA_3_LEVELS"
    elif "2 cản cũ" in reasons_str: features["price_action"] = "PA_2_LEVELS"
    elif "1 cản cũ" in reasons_str: features["price_action"] = "PA_1_LEVEL"
    else: features["price_action"] = "PA_0_LEVEL"

    # 7b. Price Action S/R Quality (Phân cấp cản D1 bảo trợ vs H4 ngắn hạn vs Không cản)
    if sm and sm.get("srQuality"):
        features["sr_quality"] = sm["srQuality"]
    elif sm and (isinstance(sm.get("h4SrCount"), (int, float)) or isinstance(sm.get("d1SrCount"), (int, float))):
        if int(sm.get("d1SrCount") or 0) >= 1: features["sr_quality"] = "SR_DAILY_D1_INCLUDED"
        elif int(sm.get("h4SrCount") or 0) >= 1: features["sr_quality"] = "SR_H4_ONLY"
        else: features["sr_quality"] = "SR_NONE"
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

    # 8. Open Interest (OI) Change (Số học từ % thay đổi OI)
    if sm and sm.get("oiState"):
        features["oi_change"] = sm["oiState"]
    elif sm and isinstance(sm.get("oiChangePct"), (int, float)):
        oi_pct = float(sm["oiChangePct"])
        if oi_pct <= -1.0: features["oi_change"] = "OI_COOLING"
        elif oi_pct >= 2.0: features["oi_change"] = "OI_SURGE"
        else: features["oi_change"] = "OI_STABLE"
    elif "Hạ nhiệt vị thế" in reasons_str or "giảm -" in reasons_str: features["oi_change"] = "OI_COOLING"
    elif "Tăng mạnh" in reasons_str or "bùng nổ" in reasons_str: features["oi_change"] = "OI_SURGE"
    else: features["oi_change"] = "OI_STABLE"

    # 9. Volume Momentum (Số học từ volumeRatio)
    if sm and sm.get("volumeState"):
        features["volume"] = sm["volumeState"]
    elif sm and isinstance(sm.get("volumeRatio"), (int, float)):
        v_rat = float(sm["volumeRatio"])
        if v_rat >= 2.0: features["volume"] = "VOL_SURGE"
        elif v_rat >= 0.8: features["volume"] = "VOL_STABLE"
        else: features["volume"] = "VOL_DRY"
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

    # 10. Funding Rate (Số học từ tỷ lệ fundingRate)
    if sm and sm.get("fundingState"):
        features["funding"] = sm["fundingState"]
    elif sm and isinstance(sm.get("fundingRate"), (int, float)):
        fr = float(sm["fundingRate"])
        if abs(fr) >= 0.05: features["funding"] = "FUNDING_DANGER"
        elif abs(fr) >= 0.02: features["funding"] = "FUNDING_SQUEEZE"
        else: features["funding"] = "FUNDING_NORMAL"
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

    # 12b. Pre-Entry Bounce (Độ nảy trước khi khớp lệnh số học)
    bounce_val = None
    if direct_record and isinstance(direct_record.get("maxRecentBouncePct"), (int, float)):
        bounce_val = float(direct_record["maxRecentBouncePct"])

    if bounce_val is not None:
        if bounce_val >= 1.25:
            features["pre_entry_bounce"] = "BOUNCE_STALE_HIGH"
        elif bounce_val >= 0.40:
            features["pre_entry_bounce"] = "BOUNCE_MODERATE"
        else:
            features["pre_entry_bounce"] = "BOUNCE_FRESH"
    elif "Giá đã nảy xa mốc" in reasons_str:
        features["pre_entry_bounce"] = "BOUNCE_STALE_HIGH"
    elif "Giá chớm nảy" in reasons_str:
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

    # 21. Economic Calendar Blackout Window (CPI, FOMC, NFP)
    if direct_record and direct_record.get("isEconomicBlackout") is not None:
        features["economic_calendar"] = "CALENDAR_RED_DANGER" if direct_record["isEconomicBlackout"] else "CALENDAR_SAFE"
    elif is_economic_blackout(timestamp_ms, window_minutes=30):
        features["economic_calendar"] = "CALENDAR_RED_DANGER"
    else:
        features["economic_calendar"] = "CALENDAR_SAFE"

    # 22. Bid-Ask Spread & Slippage Guard (Quan trọng cho Scalping đòn bẩy lớn)
    spread_val = None
    if direct_record:
        micro = direct_record.get("microstructure")
        if isinstance(micro, dict) and micro.get("spread"):
            spread_val = micro["spread"]
        elif direct_record.get("spreadCategory"):
            spread_val = direct_record["spreadCategory"]

    if spread_val:
        features["spread_slippage"] = spread_val
    else:
        # Tái lập trên dữ liệu lịch sử theo phân tầng Rank động (Adaptive Spread):
        is_extreme_vol = (
            features.get("h1_volatility") == "H1_EXTREME_STORM_PUMP_DUMP" or
            features.get("m15_volatility") == "M15_EXTREME_STORM"
        )
        is_high_vol = (
            features.get("h1_volatility") in ["H1_EXTREME_STORM_PUMP_DUMP", "H1_VOLATILE_DANGER"] or
            features.get("m15_volatility") in ["M15_EXTREME_STORM", "M15_VOLATILE_DANGER"]
        )
        if rank <= 50:
            if is_high_vol:
                features["spread_slippage"] = "SPREAD_WIDE_DANGER"
            elif gw > 3.8:
                features["spread_slippage"] = "SPREAD_MEDIUM_CAUTION"
            else:
                features["spread_slippage"] = "SPREAD_TIGHT_SAFE"
        elif rank <= 150:
            if is_high_vol:
                features["spread_slippage"] = "SPREAD_WIDE_DANGER"
            elif gw > 4.2:
                features["spread_slippage"] = "SPREAD_MEDIUM_CAUTION"
            else:
                features["spread_slippage"] = "SPREAD_TIGHT_SAFE"
        else: # Lowcap (> 150)
            if is_extreme_vol or (is_high_vol and gw > 5.0):
                features["spread_slippage"] = "SPREAD_WIDE_DANGER"
            elif is_high_vol or gw > 4.0:
                features["spread_slippage"] = "SPREAD_MEDIUM_CAUTION"
            else:
                features["spread_slippage"] = "SPREAD_TIGHT_SAFE"

    # 23. Cumulative Volume Delta (CVD) M1/M5 Momentum
    cvd_val = None
    if direct_record:
        micro = direct_record.get("microstructure")
        if isinstance(micro, dict) and micro.get("cvd"):
            cvd_val = micro["cvd"]
        elif direct_record.get("cvdCategory"):
            cvd_val = direct_record["cvdCategory"]

    if cvd_val:
        features["cvd_momentum"] = cvd_val
    else:
        # Tái lập trên dữ liệu lịch sử dựa trên dòng tiền khớp chủ động:
        is_flow_gold = features.get("ls_flow") == "LS_GOLD"
        is_vol_surge = features.get("volume") == "VOL_SURGE" or features.get("m15_volatility") == "M15_VOLUME_SURGE"
        is_flow_div = features.get("ls_flow") == "LS_DIVERGENCE"
        is_counter_train = features.get("candle_momentum") in ["MOMENTUM_COUNTER_PUMP_TRAIN", "MOMENTUM_COUNTER_DUMP_TRAIN"]

        if is_flow_gold and is_vol_surge:
            features["cvd_momentum"] = "CVD_SURGE_ALIGNED"
        elif is_flow_div or is_counter_train:
            features["cvd_momentum"] = "CVD_DIVERGENCE_OPPOSING"
        else:
            features["cvd_momentum"] = "CVD_NEUTRAL"

    # 24. Orderbook Wall Distance (Tường cản thanh khoản sổ lệnh L2)
    wall_val = None
    if direct_record:
        micro = direct_record.get("microstructure")
        if isinstance(micro, dict) and micro.get("wall"):
            wall_val = micro["wall"]
        elif direct_record.get("wallCategory"):
            wall_val = direct_record["wallCategory"]

    if wall_val:
        features["orderbook_wall"] = wall_val
    else:
        # Tái lập trên dữ liệu lịch sử theo cụm cản S/R và Score:
        pa = features.get("price_action")
        sr = features.get("sr_quality")
        if pa in ["PA_3_LEVELS", "PA_4_LEVELS"] and features.get("cvd_momentum") == "CVD_DIVERGENCE_OPPOSING":
            features["orderbook_wall"] = "WALL_OPPOSING_BLOCK"
        elif sr == "SR_DAILY_D1_INCLUDED" or pa in ["PA_3_LEVELS", "PA_4_LEVELS"]:
            features["orderbook_wall"] = "WALL_SUPPORT_SHIELD"
        else:
            features["orderbook_wall"] = "WALL_CLEAR_PATH"

    # 25. 4 Chỉ báo Kỹ thuật Nâng cao (EMA Distance H1, Wick Rejection M15, BB Squeeze H1, CVD Delta M15)
    features["ema_distance"] = sm.get("emaDistanceZone", "PRICE_NEAR_EMA") if sm else "PRICE_NEAR_EMA"
    features["wick_rejection"] = sm.get("m15WickRejection", "WICK_NORMAL") if sm else "WICK_NORMAL"
    features["bb_squeeze"] = sm.get("h1BbState", "BB_NORMAL") if sm else "BB_NORMAL"
    features["cvd_flow"] = sm.get("m15CvdFlow", "CVD_NEUTRAL") if sm else "CVD_NEUTRAL"

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
        "adx_strength:ADX_NORMAL": (0.85, 1.00),
        "price_action:PA_0_LEVEL": (0.50, 0.85),
        "sr_quality:SR_NONE": (0.50, 0.90),
        "btc_wave:BTC_COUNTER": (0.65, 0.85),
        "risk_interaction:INTERACTION_NO_SR_WEAK_SETUP": (0.30, 0.85),
        "risk_interaction:INTERACTION_HIGH_VOLATILITY_WEAK_SETUP": (0.10, 0.50),
        "candle_momentum:MOMENTUM_COUNTER_PUMP_TRAIN": (0.05, 0.30),
        "candle_momentum:MOMENTUM_COUNTER_DUMP_TRAIN": (0.05, 0.30),
        "puncture_interaction:INTERACTION_H1_M15_PUNCTURED": (0.05, 0.35),
        "puncture_interaction:INTERACTION_H1_PUNCTURED_DEEP": (0.05, 0.40),
        "economic_calendar:CALENDAR_RED_DANGER": (0.05, 0.25),
        "economic_calendar:CALENDAR_SAFE": (0.90, 1.05),
        "spread_slippage:SPREAD_WIDE_DANGER": (0.10, 0.35),
        "spread_slippage:SPREAD_MEDIUM_CAUTION": (0.70, 0.95),
        "spread_slippage:SPREAD_TIGHT_SAFE": (1.00, 1.20),
        "cvd_momentum:CVD_SURGE_ALIGNED": (1.05, 1.40),
        "cvd_momentum:CVD_DIVERGENCE_OPPOSING": (0.45, 0.75),
        "cvd_momentum:CVD_NEUTRAL": (0.90, 1.00),
        "orderbook_wall:WALL_CLEAR_PATH": (1.00, 1.25),
        "orderbook_wall:WALL_SUPPORT_SHIELD": (1.00, 1.20),
        "orderbook_wall:WALL_OPPOSING_BLOCK": (0.15, 0.45),
        "ema_distance:PRICE_OVEREXTENDED": (0.20, 0.70),
        "ema_distance:PRICE_EXTENDED": (0.60, 0.90),
        "ema_distance:PRICE_NEAR_EMA": (1.00, 1.30),
        "ema_distance:PRICE_COUNTER_EMA": (0.30, 0.80),
        "wick_rejection:BULLISH_PINBAR_REJECTION": (1.00, 1.40),
        "wick_rejection:BEARISH_PINBAR_REJECTION": (1.00, 1.40),
        "wick_rejection:OPPOSING_WICK_TRAP": (0.20, 0.75),
        "wick_rejection:WICK_NORMAL": (0.85, 1.00),
        "bb_squeeze:BB_ULTRA_SQUEEZE": (1.00, 1.35),
        "bb_squeeze:BB_MODERATE_SQUEEZE": (1.00, 1.20),
        "bb_squeeze:BB_EXPANSION": (0.75, 1.05),
        "bb_squeeze:BB_NORMAL": (0.85, 1.00),
        "cvd_flow:CVD_BULLISH_FLOW": (1.00, 1.35),
        "cvd_flow:CVD_BEARISH_FLOW": (1.00, 1.35),
        "cvd_flow:CVD_ABSORPTION_BULLISH": (1.00, 1.40),
        "cvd_flow:CVD_ABSORPTION_BEARISH": (1.00, 1.40),
        "cvd_flow:CVD_EXHAUSTION_BEARISH": (0.20, 0.75),
        "cvd_flow:CVD_EXHAUSTION_BULLISH": (0.20, 0.75),
        "cvd_flow:CVD_NEUTRAL": (0.85, 1.00),
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

    # Đọc cấu hình cũ trước khi ghi đè để phát hiện thay đổi tham số
    old_config = {}
    if os.path.exists(OUTPUT_MODEL_PATH):
        try:
            with open(OUTPUT_MODEL_PATH, 'r', encoding='utf-8') as f:
                old_config = json.load(f)
        except Exception:
            pass

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

    # 📢 Bắn thông báo Telegram nếu có thay đổi về TP, BE, SL, WinRate
    check_and_notify_parameter_changes(old_config, model_output)

def get_telegram_creds():
    token = os.environ.get('TELEGRAM_BOT_TOKEN')
    chat_id = os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat_id:
        env_path = os.path.join(BASE_DIR, ".env")
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if "=" in line and not line.strip().startswith("#"):
                            k, v = line.strip().split("=", 1)
                            k = k.strip()
                            v = v.split("#")[0].strip()
                            if k == "TELEGRAM_BOT_TOKEN" and not token:
                                token = v
                            elif k == "TELEGRAM_CHAT_ID" and not chat_id:
                                chat_id = v
            except Exception:
                pass
    token = token or '8974388983:AAGTEgJNmAegGPmWUgvd3Lpvtbefv-yn6pg'
    chat_id = chat_id or '1663202780'
    return token, chat_id

def send_telegram_alert(message_html):
    bot_token, chat_id = get_telegram_creds()
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message_html,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    try:
        resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code == 200:
            print("📢 [Telegram] Đã gửi thông báo thay đổi tham số AI thành công!")
        else:
            print(f"⚠️ [Telegram] Lỗi gửi thông báo: HTTP {resp.status_code} - {resp.text}")
    except Exception as e:
        print(f"⚠️ [Telegram] Lỗi kết nối Telegram: {e}")

def check_and_notify_parameter_changes(old_config, new_config):
    if not old_config:
        return

    changes = []
    old_mfe = old_config.get("mfeMaeProfile", {})
    new_mfe = new_config.get("mfeMaeProfile", {})

    # 1. Kích hoạt BE / Partial TP
    old_be = old_mfe.get("recommendedBeTriggerPct")
    new_be = new_mfe.get("recommendedBeTriggerPct")
    if old_be is not None and new_be is not None and abs(old_be - new_be) >= 0.01:
        changes.append(f"• <b>Kích hoạt Partial TP / Dời BE:</b> <code>{old_be:.2f}%</code> ➔ <b><code>+{new_be:.2f}%</code></b>")

    # 2. Tỷ lệ TP / Grid
    old_tp = old_mfe.get("optimalTpGridRatio")
    new_tp = new_mfe.get("optimalTpGridRatio")
    if old_tp is not None and new_tp is not None and abs(old_tp - new_tp) >= 0.01:
        changes.append(f"• <b>Tỷ lệ TP / Grid:</b> <code>{old_tp:.3f}</code> ➔ <b><code>{new_tp:.3f} ({(new_tp*100):.1f}% Grid)</code></b>")

    # 3. Sàn SL thích ứng
    old_sl = old_config.get("adaptiveSlProfile", {})
    new_sl = new_config.get("adaptiveSlProfile", {})

    old_sl_top150 = old_sl.get("top150MinSlPct")
    new_sl_top150 = new_sl.get("top150MinSlPct")
    if old_sl_top150 is not None and new_sl_top150 is not None and abs(old_sl_top150 - new_sl_top150) >= 0.01:
        changes.append(f"• <b>Sàn SL Top 150:</b> <code>{old_sl_top150:.2f}%</code> ➔ <b><code>{new_sl_top150:.2f}%</code></b>")

    old_sl_lowcap = old_sl.get("lowcapMinSlPct")
    new_sl_lowcap = new_sl.get("lowcapMinSlPct")
    if old_sl_lowcap is not None and new_sl_lowcap is not None and abs(old_sl_lowcap - new_sl_lowcap) >= 0.01:
        changes.append(f"• <b>Sàn SL Lowcap:</b> <code>{old_sl_lowcap:.2f}%</code> ➔ <b><code>{new_sl_lowcap:.2f}%</code></b>")

    # 4. Ngưỡng duyệt WinProb
    old_th = old_config.get("optimalThresholds", {})
    new_th = new_config.get("optimalThresholds", {})

    old_th_top150 = old_th.get("top150")
    new_th_top150 = new_th.get("top150")
    if old_th_top150 is not None and new_th_top150 is not None and abs(old_th_top150 - new_th_top150) >= 0.1:
        changes.append(f"• <b>Ngưỡng WinRate Top 150:</b> <code>{old_th_top150:.1f}%</code> ➔ <b><code>{new_th_top150:.1f}%</code></b>")

    old_th_lowcap = old_th.get("lowcap")
    new_th_lowcap = new_th.get("lowcap")
    if old_th_lowcap is not None and new_th_lowcap is not None and abs(old_th_lowcap - new_th_lowcap) >= 0.1:
        changes.append(f"• <b>Ngưỡng WinRate Lowcap:</b> <code>{old_th_lowcap:.1f}%</code> ➔ <b><code>{new_th_lowcap:.1f}%</code></b>")

    # 5. Prior WinRate cơ sở
    old_prior = old_config.get("priorWinProb")
    new_prior = new_config.get("priorWinProb")
    if old_prior is not None and new_prior is not None and abs(old_prior - new_prior) >= 0.005:
        changes.append(f"• <b>Tỷ lệ thắng Prior cơ sở:</b> <code>{(old_prior*100):.1f}%</code> ➔ <b><code>{(new_prior*100):.1f}%</code></b>")

    if changes:
        now_str = new_config.get("trainedAt") or time.strftime("%Y-%m-%d %H:%M:%S")
        total_samples = new_config.get("totalSamples", 0)
        msg = (
            f"🤖 <b>[AI Training] Tự Động Cập Nhật Tham Số Mới</b>\n"
            f"• Thời gian: <b>{now_str}</b>\n"
            f"• Dữ liệu học: <b>{total_samples:,} mẫu</b> (Real + Shadow)\n\n"
            f"<b>📊 Các tham số tự động thay đổi:</b>\n" +
            "\n".join(changes) +
            f"\n\n<i>✓ Cấu hình đã tự động cập nhật vào ai_rule_config.json.</i>"
        )
        send_telegram_alert(msg)
    else:
        print("ℹ️ [AI Training] Các tham số TP, BE, SL, WinRate không thay đổi so với phiên trước. Không cần gửi Telegram.")

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

    # Tối ưu hóa mốc SL theo kỳ vọng lợi nhuận và biên độ an toàn chống nhiễu M15/H1
    def optimize_sl_floor(samples, candidates, default_floor, min_noise_guard):
        if not samples or len(samples) < 30:
            return default_floor
        best_utility = -999999
        best_floor = default_floor
        for floor in candidates:
            utility = 0.0
            for s in samples:
                tp_dist = min(max(s["grid_w"] * 0.45, 1.2), 3.0)
                # Đo lường độ thò râu ngược (adverse excursion) thông thường:
                # Retest lành mạnh thường thò râu khoảng 25% - 32% grid_w (tối thiểu min_noise_guard * 0.85)
                expected_wick = max(min_noise_guard * 0.85, s["grid_w"] * 0.28)
                if s["is_win"]:
                    if floor < expected_wick:
                        # SL quá sát bị quét râu thành thua oan
                        utility -= 1.5
                    else:
                        # Sống sót qua nhịp rung lắc, ăn trọn TP
                        utility += (tp_dist / floor) * 1.5
                else:
                    utility -= 1.5

            if floor < min_noise_guard:
                utility -= len(samples) * 0.35 * ((min_noise_guard - floor) / min_noise_guard)

            if utility > best_utility:
                best_utility = utility
                best_floor = floor
        return best_floor

    opt_top150 = optimize_sl_floor(top150_samples, [1.10, 1.20, 1.25, 1.30, 1.40, 1.50], 1.30, 1.20)
    opt_lowcap = optimize_sl_floor(lowcap_samples, [1.80, 2.00, 2.20, 2.40, 2.60], 2.00, 1.80)

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
    # Mẫu riêng để học optimalTpGridRatio: chỉ lấy lệnh thắng có gridWidthPct rõ ràng
    tp_ratio_samples = []   # list of (mfe_pct / grid_width_pct) for winning trades

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
                    # gridWidthPct được ghi trong shadow trade khi tạo
                    grid_w = float(t.get("gridWidthPct") or t.get("gridWidth") or 0)

                    if ep <= 0 or sl <= 0 or tp <= 0 or xp <= 0:
                        continue

                    sl_dist_pct = abs(ep - sl) / ep * 100
                    tp_dist_pct = abs(ep - tp) / ep * 100
                    if sl_dist_pct <= 0:
                        continue

                    if is_win or outcome == "MISSED_TP":
                        mfe_pct = tp_dist_pct
                        did_reach_tp = True
                        # Học TP ratio: tỷ lệ MFE / GridWidth thực tế lệnh thắng
                        if grid_w > 0:
                            tp_ratio_samples.append(mfe_pct / grid_w)
                    else:
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
                    # Học TP ratio từ real trades: TP dist thực tế / grid width
                    if is_win and grid_w > 0:
                        tp_ratio_samples.append(tp_dist_pct / grid_w)
                    real_count += 1
        except Exception as e:
            print(f"⚠️ [BE Calibration] Lỗi đọc ai_trade_dataset: {e}")

    total_samples = len(samples)

    # === 3. Tối ưu hóa ngưỡng beTriggerPct kết hợp mô hình Partial TP 50% & Pullback ===
    # Thay vì giả định phi thực tế, thuật toán mô phỏng đường đi của nến:
    # 1. Khi giá chạm ngưỡng th: Kích hoạt Partial TP chốt 50% vị thế tại +th%
    # 2. 50% vị thế còn lại được kéo SL về Hòa Vốn (0đ).
    # 3. Rủi ro Pullback (tỷ lệ quét về Entry):
    #    - Ngưỡng th quá thấp (< 0.90%): dễ bị nhiễu động nến M15 rũ non (tỷ lệ quét BE cao).
    #    - Ngưỡng th hợp lý (1.10% - 1.50%): vị thế đã bứt phá thoát nền, xác suất vươn tới Full TP cao.
    # 4. Đối với lệnh thua (Loss): nếu nến có nhịp giật ban đầu chạm th, bot chốt được 50% lãi và cứu vị thế khỏi full SL!
    # Mục tiêu tối ưu: Tối đa hóa Net Expected Return PnL trên toàn bộ tập dữ liệu.
    DEFAULT_BE = 1.15
    recommended_be_trigger_pct = DEFAULT_BE
    be_calibration_stats = {}

    if total_samples >= 50:
        candidates = [round(x * 0.05, 2) for x in range(16, 36)]  # 0.80% → 1.75%
        best_net_pnl = -1e9
        best_threshold = DEFAULT_BE
        best_partial_wins = 0
        best_saved_sls = 0

        for th in candidates:
            total_net_pnl = 0.0
            partial_wins = 0
            saved_sls = 0

            for s in samples:
                tp_dist = s.get("tp_dist_pct", 1.8)
                sl_dist = s.get("sl_dist_pct", 1.5)
                did_tp = s.get("did_reach_tp", False)

                if did_tp:
                    if tp_dist >= th:
                        # 50% chốt lời tại th; 50% còn lại gồng về TP
                        # Pullback probability: tỷ lệ hồi về Entry trước khi chạm full TP
                        ratio = min(1.0, th / max(tp_dist, 0.1))
                        pullback_prob = max(0.18, min(0.65, 0.70 - 0.40 * ratio))
                        pnl = 0.5 * th + 0.5 * (1.0 - pullback_prob) * tp_dist
                        partial_wins += 1
                    else:
                        pnl = tp_dist
                else:
                    # Lệnh thua: kiểm tra xác suất nến có nhịp nảy chạm th trước khi chết
                    # Nhịp nảy giảm theo hàm mũ khi th tăng cao
                    bounce_prob = max(0.04, min(0.35, 0.42 * math.exp(-1.8 * (th / max(sl_dist, 0.1)))))
                    if bounce_prob > 0.15:
                        saved_sls += 1
                    pnl = bounce_prob * (0.5 * th) - (1.0 - bounce_prob) * sl_dist

                total_net_pnl += pnl

            if total_net_pnl > best_net_pnl:
                best_net_pnl = total_net_pnl
                best_threshold = th
                best_partial_wins = partial_wins
                best_saved_sls = saved_sls

        # Áp dụng guardrail: không để ngưỡng quá thấp (< 0.85% gây rũ non) hoặc quá cao (> 1.60% mất tính bảo vệ)
        recommended_be_trigger_pct = max(0.85, min(best_threshold, 1.60))
        be_calibration_stats = {
            "threshold": recommended_be_trigger_pct,
            "bestThreshold": best_threshold,
            "expectedNetPnlPct": round(best_net_pnl / max(total_samples, 1), 3),
            "totalSimulatedPnl": round(best_net_pnl, 1),
            "partialWinsProtected": best_partial_wins,
            "savedSlCount": best_saved_sls,
            "sampleCount": total_samples
        }
        print(f"🎯 [BE & Partial TP Calibration] Ngưỡng tối ưu học được: +{recommended_be_trigger_pct:.2f}%")
        print(f"   • Expected Net PnL/lệnh: {be_calibration_stats['expectedNetPnlPct']:+.3f}% | Tổng PnL: {be_calibration_stats['totalSimulatedPnl']:+.1f}%")
        print(f"   • Số lệnh chốt Partial TP: {best_partial_wins} | Số lệnh SL được cứu hòa/lãi: {best_saved_sls}")
    else:
        print(f"⚠️ [BE Trigger Calibration] Chưa đủ dữ liệu ({total_samples} mẫu < 50), dùng mặc định {DEFAULT_BE}%")

    # === 4. Học optimalTpGridRatio từ phân phối MFE thực tế ===
    # Không gò ép trần cứng ở 0.45 làm bóp nghẹt R:R
    # Thay vào đó, tự động chọn tỷ lệ cân bằng giữa Win Rate và Reward-to-Risk tối thiểu 1.4:1
    DEFAULT_TP_RATIO = 0.55
    optimal_tp_grid_ratio = DEFAULT_TP_RATIO
    tp_ratio_stats = {}

    if len(tp_ratio_samples) >= 30:
        tp_ratio_samples_sorted = sorted(tp_ratio_samples)
        n = len(tp_ratio_samples_sorted)
        # Lấy percentile 65 (thay vì 55) để cho phép TP mở rộng biên độ chạy theo sóng
        p65_idx = int(n * 0.35)
        p50_idx = int(n * 0.50)
        p65_val = tp_ratio_samples_sorted[p65_idx]
        p50_val = tp_ratio_samples_sorted[p50_idx]
        learned_ratio = max(0.50, (p65_val + p50_val) / 2.0)
        # Guardrail: [0.45, 0.75] — đảm bảo TP đủ xa để tạo R:R vượt trội
        optimal_tp_grid_ratio = round(max(0.45, min(learned_ratio, 0.75)), 3)
        tp_ratio_stats = {
            "learnedRatio": optimal_tp_grid_ratio,
            "p50": round(p50_val, 3),
            "p65": round(p65_val, 3),
            "sampleCount": n,
            "medianRatio": round(tp_ratio_samples_sorted[n // 2], 3)
        }
        print(f"🎯 [TP Grid Ratio] Tỷ lệ TP/Grid tối ưu học được: {optimal_tp_grid_ratio:.3f} ({optimal_tp_grid_ratio*100:.1f}% GridWidth)")
    else:
        print(f"⚠️ [TP Grid Ratio] Chưa đủ mẫu thắng có gridWidthPct ({len(tp_ratio_samples)} < 30), dùng mặc định {DEFAULT_TP_RATIO}")

    print(f"📊 [MAE/MFE Profile] Hoàn tất: TP = {optimal_tp_grid_ratio*100:.1f}% GridWidth, BE/Partial Trigger = +{recommended_be_trigger_pct:.2f}% (N={total_samples}: {shadow_count} shadow + {real_count} real)")

    return {
        "optimalTpGridRatio": optimal_tp_grid_ratio,
        "tpRatioStats": tp_ratio_stats,
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

    rank_map = {}
    mc_path = os.path.join(base_dir, "data", "market_cap_top.json")
    if os.path.exists(mc_path):
        try:
            with open(mc_path, "r", encoding="utf-8") as f:
                rank_map = json.load(f).get("rankMap", {})
        except Exception:
            pass

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

        raw_rk = t.get("marketCapRank")
        sym = t.get("symbol", "").replace("USDT", "")
        if raw_rk is None or raw_rk == 999:
            effective_rank = rank_map.get(sym, 999)
        else:
            try:
                effective_rank = int(raw_rk)
            except Exception:
                effective_rank = rank_map.get(sym, 999)

        p_final = float(p) if p is not None else 50.0
        recalculated_trades.append({
            "marketCapRank": effective_rank,
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
    best_th_low = 65.0
    best_stats = {}

    candidate_top = [48.0, 50.0, 52.0, 54.0, 55.0]
    candidate_low = [60.0, 62.0, 65.0, 68.0, 70.0]

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
                        loss_val = t["savedLossUSD"]
                        if rank > 150:
                            loss_val *= 1.8  # Tail Risk Penalty cho Lowcap
                        pnl -= loss_val

            total = n_win + n_loss
            wr = (n_win / total * 100.0) if total > 0 else 0.0

            # Tiêu chuẩn an toàn: Tỷ lệ thắng >= 60.0% và Lợi nhuận kỳ vọng dương
            if total >= 10 and wr >= 60.0 and pnl > 0:
                utility = pnl * (wr / 100.0)
                # Phạt utility nếu để ngưỡng Lowcap quá lỏng lẻo (< 62%)
                if th_low < 62.0:
                    utility *= 0.75
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
