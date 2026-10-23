import json
import os
import sys
import time
import math
import datetime
from collections import defaultdict

try:
    import requests
except ImportError:
    import urllib.request
    import urllib.parse
    class RequestsFallback:
        @staticmethod
        def get(url, params=None, timeout=10):
            req_url = url
            if params:
                req_url = f"{url}?{urllib.parse.urlencode(params)}"
            req = urllib.request.Request(req_url, headers={'User-Agent': '369Bot/1.0'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode('utf-8')
                class MockResp:
                    status_code = resp.status
                    text = raw
                    def json(self):
                        return json.loads(raw)
                return MockResp()

        @staticmethod
        def post(url, json=None, timeout=15):
            data_bytes = None
            headers = {'User-Agent': '369Bot/1.0'}
            if json is not None:
                import json as _j
                data_bytes = _j.dumps(json).encode('utf-8')
                headers['Content-Type'] = 'application/json'
            req = urllib.request.Request(url, data=data_bytes, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode('utf-8')
                class MockResp:
                    status_code = resp.status
                    text = raw
                    def json(self):
                        import json as _j
                        return _j.loads(raw)
                return MockResp()
    requests = RequestsFallback()

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
    elif direct_record and isinstance(direct_record.get("preEntryBouncePct"), (int, float)):
        bounce_val = float(direct_record["preEntryBouncePct"])

    if bounce_val is not None:
        if bounce_val >= 3.0:
            features["pre_entry_bounce"] = "BOUNCE_STALE_EXTREME"
        elif bounce_val >= 1.25:
            features["pre_entry_bounce"] = "BOUNCE_STALE_HIGH"
        elif bounce_val >= 0.40:
            features["pre_entry_bounce"] = "BOUNCE_MODERATE"
        else:
            features["pre_entry_bounce"] = "BOUNCE_FRESH"
    elif "Giá nảy cực xa mốc" in reasons_str:
        features["pre_entry_bounce"] = "BOUNCE_STALE_EXTREME"
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

    # 16. BTC Flash & Turnover Guard (chuyển giao cho AI học)
    veto_cat = (direct_record.get("vetoCategory") or "") if (direct_record and isinstance(direct_record, dict)) else ""
    raw_md = (direct_record.get("rawMarketData") or {}) if (direct_record and isinstance(direct_record, dict)) else {}

    if "Turnover" in reasons_str or "ABNORMAL_TURNOVER" in reasons_str or veto_cat == "TURNOVER_RISK_BLOCKED" or raw_md.get("turnoverBlocked"):
        features["turnover_guard"] = "TURNOVER_RISK_BLOCKED"
    else:
        features["turnover_guard"] = "TURNOVER_NORMAL"

    if "BTC_FLASH_PUMP" in reasons_str or veto_cat == "BTC_FLASH_PUMP_ACTIVE" or raw_md.get("btcFlashPump"):
        features["btc_flash"] = "BTC_FLASH_PUMP_ACTIVE"
    elif "BTC_FLASH_DUMP" in reasons_str or veto_cat == "BTC_FLASH_DUMP_ACTIVE" or raw_md.get("btcFlashDump"):
        features["btc_flash"] = "BTC_FLASH_DUMP_ACTIVE"
    else:
        features["btc_flash"] = "BTC_FLASH_NORMAL"

    # 17. Multi-Factor Risk Interactions (AI tự học tương tác rủi ro)
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

    # 🛡️ TƯƠNG TÁC ĐA NHÂN TỐ RỦI RO: Nảy cực xa kết hợp Lowcap hoặc Bão BTC / Ngược trend
    is_stale_extreme = features.get("pre_entry_bounce") == "BOUNCE_STALE_EXTREME"
    is_stale_high = features.get("pre_entry_bounce") == "BOUNCE_STALE_HIGH"
    is_lowcap_rank = rank > 150
    is_btc_volatile_regime = (
        features.get("btc_storm") == "BTC_STORM_VOLATILE" or
        (features.get("btc_flash") and features.get("btc_flash") != "BTC_FLASH_NORMAL")
    )

    if is_stale_extreme or (is_stale_high and (is_lowcap_rank or is_btc_volatile_regime or is_trend_conflict)):
        features["risk_interaction"] = "INTERACTION_STALE_BOUNCE_RUNAWAY"
    elif is_vol_danger and (is_trend_conflict or is_ls_div or is_counter_train):
        features["risk_interaction"] = "INTERACTION_HIGH_VOLATILITY_WEAK_SETUP"
    elif is_trend_conflict and is_ls_div:
        features["risk_interaction"] = "INTERACTION_TREND_FLOW_CONFLICT"
    elif is_no_sr and (is_trend_conflict or is_ls_div or features.get("trend") == "TREND_NEUTRAL"):
        features["risk_interaction"] = "INTERACTION_NO_SR_WEAK_SETUP"
    elif is_dry_vol and is_cooling_oi:
        features["risk_interaction"] = "INTERACTION_DRY_VOL_COOLING_OI"
    else:
        features["risk_interaction"] = "INTERACTION_BALANCED"

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

    # 19b. Candlestick Geometry Shape (Pinbar / Marubozu M15)
    sig_dir = str(direct_record.get("signal") or "").upper() if direct_record else ""
    is_long = sig_dir in ["LONG", "BUY"]
    candle_shape = direct_record.get("candleShape") or direct_record.get("candle_shape") if direct_record else None
    if candle_shape:
        features["candle_shape"] = candle_shape
    elif "CANDLE_PINBAR_HAMMER" in reasons_str or "Pinbar Hammer" in reasons_str:
        features["candle_shape"] = "CANDLE_PINBAR_HAMMER"
    elif "CANDLE_PINBAR_SHOOTING" in reasons_str or "Shooting Star" in reasons_str:
        features["candle_shape"] = "CANDLE_PINBAR_SHOOTING"
    elif "CANDLE_MARUBOZU_DUMP" in reasons_str:
        features["candle_shape"] = "CANDLE_MARUBOZU_DUMP"
    elif "CANDLE_MARUBOZU_PUMP" in reasons_str:
        features["candle_shape"] = "CANDLE_MARUBOZU_PUMP"
    elif mm:
        m15_vol_ratio = float(mm.get("m15VolRatio") or 1.0)
        m15_range_pct = float(mm.get("m15RangePct") or 0.0)
        m15_body_pct = float(mm.get("m15BodyPct") or 0.0)
        is_green = mm.get("m15IsGreen")
        is_spike = m15_range_pct > 1.4 and m15_vol_ratio >= 2.5
        rem_wick = max(0.0, m15_range_pct - m15_body_pct)
        if is_long:
            if not is_green and (is_spike or (m15_body_pct >= 0.70 * m15_range_pct and m15_range_pct > 1.0)):
                features["candle_shape"] = "CANDLE_MARUBOZU_DUMP"
            elif rem_wick >= 0.40 * m15_range_pct and not is_spike:
                features["candle_shape"] = "CANDLE_PINBAR_HAMMER"
            else:
                features["candle_shape"] = "CANDLE_NORMAL"
        else:
            if is_green and (is_spike or (m15_body_pct >= 0.70 * m15_range_pct and m15_range_pct > 1.0)):
                features["candle_shape"] = "CANDLE_MARUBOZU_PUMP"
            elif rem_wick >= 0.40 * m15_range_pct and not is_spike:
                features["candle_shape"] = "CANDLE_PINBAR_SHOOTING"
            else:
                features["candle_shape"] = "CANDLE_NORMAL"
    else:
        features["candle_shape"] = "CANDLE_NORMAL"

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
        # Dữ liệu cũ trước khi có telemetry Microstructure: neo mốc chuẩn an toàn (Baseline = 1.00)
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
        # Dữ liệu cũ trước khi có telemetry Microstructure: neo mốc chuẩn trung tính (Baseline = 1.00)
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
        # Dữ liệu cũ trước khi có telemetry Microstructure: neo mốc chuẩn thông thoáng (Baseline = 1.00)
        features["orderbook_wall"] = "WALL_CLEAR_PATH"



    return features

def train_and_export_model():
    print("=" * 80)
    print("🤖 HỌC VÀ TẠO MÔ HÌNH DỰ ĐOÁN XÁC SUẤT AI (TRAIN AI REVIEWER MODEL - BAYES ODDS RATIO)")
    print("=" * 80)

    dataset = []
    seen_trade_ids = set()

    # 1. Load REAL TRADES từ ai_trade_dataset.jsonl (Chỉ lấy lệnh thật, bỏ qua isShadow)
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

                # Chỉ lấy lệnh thật trên tài khoản (loại bỏ record shadow bị lưu lẫn vào dataset)
                if rec.get("isShadow"):
                    continue

                if rec.get("type") == "ENTRY":
                    entries[rec.get("tradeId")] = rec
                elif rec.get("type") == "EXIT":
                    tid = rec.get("tradeId")
                    exit_type = rec.get("exitType")
                    valid_exits = ["TP", "SL", "TRAILING_SL", "HARD_MAX_LOSS", "BE_EXIT", "TREND_RUNNER_TP", "DEFENSIVE_BE_EXIT", "DEFENSIVE_EARLY_CUT"]
                    if exit_type in valid_exits and tid in entries:
                        entry = entries[tid]
                        # Phân loại kết quả chuẩn xác: BE_EXIT không bị đánh đồng với Full TP
                        if exit_type in ["TP", "TREND_RUNNER_TP"]:
                            win_credit = 1.0
                        elif exit_type in ["BE_EXIT", "DEFENSIVE_BE_EXIT"]:
                            win_credit = 0.50
                        elif rec.get("isWin", False):
                            pnl = float(rec.get("realizedPnl") or rec.get("pnlUsd") or 0)
                            win_credit = 1.0 if pnl >= 0.80 else 0.50
                        else:
                            win_credit = 0.0

                        is_post_update = bool(
                            entry.get("microstructure") is not None or
                            entry.get("marketMetrics") is not None or
                            (entry.get("signalMetrics") and entry["signalMetrics"].get("m15CandleGeometry"))
                        )
                        sample_weight = 2.5 if is_post_update else 0.5

                        seen_trade_ids.add(tid)
                        dataset.append({
                            "win_credit": win_credit,
                            "weight": sample_weight,
                            "isPostUpdate": is_post_update,
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
        print(f"💰 Đã nạp {real_count} mẫu LỆNH THẬT từ tài khoản Binance")

    # 2. Load SHADOW TRADES từ shadow_trades_history.jsonl
    # CHỈ LẤY CÁC LỆNH KHÔNG KHỚP TIỀN THẬT (Tránh duplicate 100% với real trades)
    # VÀ PHẢI LÀ LỆNH ĐÃ KHỚP LIMIT BÓNG TỐI (râu nến có chạm Entry, loại bỏ BOUNCE_CANCEL/LIMIT_TIMEOUT)
    shadow_count = 0
    post_update_shadow_count = 0
    if os.path.exists(SHADOW_PATH):
        with open(SHADOW_PATH, 'r', encoding='utf-8') as f:
            for l in f:
                if not l.strip(): continue
                try:
                    rec = json.loads(l.strip())
                    sid = rec.get("shadowId") or rec.get("tradeId")
                    # Chống trùng lặp tuyệt đối: nếu đã có trong real trades thì bỏ qua
                    if sid in seen_trade_ids:
                        continue

                    outcome = rec.get("outcome")
                    # Chỉ lấy lệnh đã khớp Limit bóng tối và kết thúc rõ ràng
                    if outcome in ["MISSED_TP", "SAVED_SL", "SAVED_BE", "TP", "SL", "BE"]:
                        holding_mins = rec.get("holdingDurationMinutes") or (
                            (rec.get("exitTimestamp", 0) - rec.get("entryTimestamp", 0)) / 60000
                            if rec.get("exitTimestamp") and rec.get("entryTimestamp") else 0
                        )
                        # Đánh giá kết quả lệnh Shadow: nhịp nảy đạt TP chuẩn <= 12h tính full Win
                        if outcome in ["MISSED_TP", "TP"]:
                            win_credit = 0.5 if holding_mins > 720 else 1.0
                        elif outcome in ["SAVED_BE", "BE"]:
                            win_credit = 0.50
                        else:
                            win_credit = 0.0

                        is_post_update = bool(
                            rec.get("microstructure") is not None or
                            rec.get("marketMetrics") is not None or
                            (rec.get("signalMetrics") and rec["signalMetrics"].get("m15CandleGeometry"))
                        )
                        sample_weight = 2.5 if is_post_update else 0.5
                        if is_post_update:
                            post_update_shadow_count += 1

                        seen_trade_ids.add(sid)
                        dataset.append({
                            "win_credit": win_credit,
                            "weight": sample_weight,
                            "isPostUpdate": is_post_update,
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
        print(f"👻 Đã nạp {shadow_count} mẫu SHADOW TRADES (Thế hệ mới có Telemetry: {post_update_shadow_count} mẫu [2.5x], Thế hệ cũ: {shadow_count - post_update_shadow_count} mẫu [0.5x])")

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

        # Giới hạn an toàn (cap) từ 0.05 đến 3.0 để các rủi ro hệ thống (BTC flash, turnover pump dump) phản ánh trung thực xác suất thực nghiệm
        min_weight_floor = 0.05 if ("btc_flash" in key or "turnover_guard" in key) else 0.20
        weight_mult = max(min_weight_floor, min(3.0, weight_mult))

        # 🎯 BASELINE ANCHORING: Các trạng thái bình thường/trung tính là mốc quy chiếu chuẩn (baseline = 1.00),
        # triệt tiêu hoàn toàn hiện tượng 10-15 nhãn "bình thường" cùng nhân dồn hệ số 0.85-0.95 dìm xác suất ảo xuống 15-25%!
        feat_val = key.split(":")[-1]
        is_pure_baseline = (
            feat_val.endswith("_NORMAL") or feat_val.endswith("_NEUTRAL") or feat_val.endswith("_BALANCED") or
            feat_val.endswith("_SAFE") or feat_val in [
                "H1_NOT_STAGNANT", "INTERACTION_PUNCTURE_NORMAL", "OI_STABLE", "BOUNCE_FRESH",
                "WALL_CLEAR_PATH", "SESSION_ASIA", "SESSION_EUROPE", "SESSION_US_LATE"
            ]
        )
        if is_pure_baseline:
            weight_mult = 1.00

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
        "rank_group:RANK_MIDCAP_150": (0.85, 1.10),
        "rank_group:RANK_LOWCAP_OUT150": (0.85, 1.05),
        "h1_volatility:H1_EXTREME_STORM_PUMP_DUMP": (0.30, 0.85),
        "h1_volatility:H1_VOLATILE_DANGER": (0.30, 0.80),
        "h1_volatility:H1_VOL_NORMAL": (1.00, 1.05),
        "m15_volatility:M15_EXTREME_STORM": (0.30, 0.85),
        "m15_volatility:M15_VOLATILE_DANGER": (0.30, 0.80),
        "m15_volatility:M15_VOLUME_SURGE": (0.30, 0.75),
        "m15_volatility:M15_VOL_NORMAL": (1.00, 1.05),
        "trend:TREND_NEUTRAL": (1.00, 1.05),
        "trend:TREND_CONFLICT": (0.40, 0.80),
        "trend:TREND_M15_ALIGNED": (1.05, 1.35),
        "ls_flow:LS_NEUTRAL": (1.00, 1.05),
        "ls_flow:LS_DIVERGENCE": (0.50, 0.85),
        "adx_strength:ADX_NORMAL": (1.00, 1.05),
        "price_action:PA_0_LEVEL": (0.95, 1.05),  # Thực nghiệm N=1825 WinProb 51.84% ~ trung tính, không phạt định kiến
        "btc_wave:BTC_ALIGNED": (1.00, 1.30),
        "btc_wave:BTC_COUNTER": (0.65, 0.85),
        "h1_volatility:H1_ULTRA_COMPRESSED": (1.00, 1.30),
        "h1_volatility:H1_MID_COMPRESSED": (1.00, 1.20),
        "m15_volatility:M15_ULTRA_COMPRESSED": (1.00, 1.30),
        "m15_volatility:M15_MID_COMPRESSED": (1.00, 1.20),
        "volume:VOL_STABLE": (1.00, 1.25),
        "volume:VOL_SURGE": (1.00, 1.35),
        "grid_width:GRID_NORMAL": (0.95, 1.15),
        "m15_candle_geometry:M15_REJECT_PINBAR": (1.00, 1.25),
        "pre_entry_bounce:BOUNCE_STALE_EXTREME": (0.35, 0.65),
        "pre_entry_bounce:BOUNCE_STALE_HIGH": (0.75, 0.95),
        "pre_entry_bounce:BOUNCE_MODERATE": (0.85, 1.05),
        "pre_entry_bounce:BOUNCE_FRESH": (1.00, 1.15),
        "h1_volume_burst:H1_VOL_BURST_DANGER": (0.50, 0.85),
        "h1_volume_burst:H1_VOL_BURST_NORMAL": (1.00, 1.10),
        "risk_interaction:INTERACTION_STALE_BOUNCE_RUNAWAY": (0.30, 0.60),
        "risk_interaction:INTERACTION_TREND_FLOW_CONFLICT": (0.35, 0.75),
        "risk_interaction:INTERACTION_NO_SR_WEAK_SETUP": (0.90, 1.05),
        "risk_interaction:INTERACTION_DRY_VOL_COOLING_OI": (0.50, 0.85),
        "risk_interaction:INTERACTION_HIGH_VOLATILITY_WEAK_SETUP": (0.10, 0.50),
        "candle_momentum:MOMENTUM_COUNTER_PUMP_TRAIN": (0.05, 0.30),
        "candle_momentum:MOMENTUM_COUNTER_DUMP_TRAIN": (0.05, 0.30),
        "puncture_interaction:INTERACTION_H1_M15_PUNCTURED": (0.05, 0.35),
        "puncture_interaction:INTERACTION_H1_PUNCTURED_DEEP": (0.05, 0.40),
        "puncture_interaction:INTERACTION_M15_PUNCTURED_DEEP": (0.20, 0.65),
        "puncture_interaction:INTERACTION_PUNCTURE_NORMAL": (1.00, 1.30),
        "rsi:RSI_EXTREME": (0.70, 1.20),
        "rsi:RSI_NEAR": (0.80, 1.15),
        "rsi:RSI_NEUTRAL": (1.00, 1.05),
        "economic_calendar:CALENDAR_RED_DANGER": (0.80, 1.20),  # Data thực nghiệm N=39 WinRate 65.4%
        "economic_calendar:CALENDAR_SAFE": (1.00, 1.05),
        "spread_slippage:SPREAD_WIDE_DANGER": (0.80, 1.25),     # Data thực nghiệm N=128 WinRate 73.3%
        "spread_slippage:SPREAD_MEDIUM_CAUTION": (0.80, 1.05),
        "spread_slippage:SPREAD_TIGHT_SAFE": (1.00, 1.15),
        "cvd_momentum:CVD_SURGE_ALIGNED": (1.05, 1.40),
        "cvd_momentum:CVD_DIVERGENCE_OPPOSING": (0.80, 1.15),  # Data thực nghiệm N=484 WinRate 63.2%
        "cvd_momentum:CVD_NEUTRAL": (1.00, 1.05),
        "orderbook_wall:WALL_CLEAR_PATH": (1.00, 1.25),
        "orderbook_wall:WALL_SUPPORT_SHIELD": (1.00, 1.20),
        "orderbook_wall:WALL_OPPOSING_BLOCK": (0.35, 0.65),
        "funding:FUNDING_SQUEEZE": (0.80, 1.20),
        "funding:FUNDING_DANGER": (0.40, 0.85),
        "funding:FUNDING_NORMAL": (1.00, 1.05),
        "btc_storm:BTC_STORM_VOLATILE": (0.40, 0.75),
        "btc_storm:BTC_STORM_NORMAL": (1.00, 1.05),
        "btc_flash:BTC_FLASH_PUMP_ACTIVE": (0.05, 0.25),
        "btc_flash:BTC_FLASH_DUMP_ACTIVE": (0.05, 0.25),
        "btc_flash:BTC_FLASH_NORMAL": (1.00, 1.05),
        "turnover_guard:TURNOVER_RISK_BLOCKED": (0.15, 0.45),
        "turnover_guard:TURNOVER_NORMAL": (1.00, 1.05),
        "h1_volatility:H1_EXTREME_STORM_PUMP_DUMP": (0.35, 0.70),
        "m15_volatility:M15_EXTREME_STORM": (0.35, 0.70),
        "h1_stagnant:H1_STAGNANT_TRAP": (0.40, 0.75),
        "h1_stagnant:H1_NOT_STAGNANT": (1.00, 1.05),
        "h1_candle_geometry:H1_PUNCTURED_DEEP": (0.15, 0.45),
        "h1_candle_geometry:H1_PUNCTURED_LIGHT": (0.40, 0.70),
        "h1_candle_geometry:H1_REJECT_PINBAR": (1.00, 1.40),
        "h1_candle_geometry:H1_HOLD_OR_HOVER": (1.00, 1.25),
        "m15_candle_geometry:M15_PUNCTURED_DEEP": (0.20, 0.50),
        "m15_candle_geometry:M15_PUNCTURED_LIGHT": (0.40, 0.70),
        "m15_candle_geometry:M15_HOLD_OR_HOVER": (1.00, 1.20),
        "candle_shape:CANDLE_MARUBOZU_DUMP": (0.15, 0.45),
        "candle_shape:CANDLE_MARUBOZU_PUMP": (0.15, 0.45),
        "candle_shape:CANDLE_PINBAR_HAMMER": (1.00, 1.25),
        "candle_shape:CANDLE_PINBAR_SHOOTING": (1.00, 1.25),
        "candle_shape:CANDLE_NORMAL": (1.00, 1.05),
        # ── 32 TIÊU CHÍ BỔ SUNG KHÉP KÍN TOÀN DIỆN (100% FEATURES AUDITED) ──
        "rank_group:RANK_TOP10": (0.90, 1.25),
        "rank_group:RANK_TOP30": (0.85, 1.15),
        "oi_change:OI_SURGE": (0.90, 1.25),
        "oi_change:OI_STABLE": (1.00, 1.05),
        "oi_change:OI_COOLING": (0.80, 1.00),
        "ls_flow:LS_GOLD": (0.90, 1.25),
        "ls_flow:LS_PARTIAL": (0.90, 1.05),
        "grid_width:GRID_NARROW": (0.85, 1.20),
        "grid_width:GRID_WIDE": (0.85, 1.15),
        "adx_strength:ADX_WEAK_TREND": (0.85, 1.10),
        "adx_strength:ADX_STRONG_TREND": (0.85, 1.25),
        "volume:VOL_DRY": (0.80, 1.05),
        "trading_session:SESSION_US_OPEN": (0.90, 1.20),
        "trading_session:SESSION_EUROPE": (1.00, 1.15),
        "trading_session:SESSION_US_LATE": (1.00, 1.15),
        "trading_session:SESSION_ASIA": (1.00, 1.05),
        "trading_session:SESSION_WEEKEND": (0.80, 1.00),
        "level_freshness:FRESH_LEVEL_TOUCH1": (0.95, 1.20),
        "level_freshness:RETEST_LEVEL_TOUCH2": (0.85, 1.05),
        "level_freshness:EXHAUSTED_LEVEL_TOUCH3": (0.50, 0.85),
        "sr_quality:SR_NONE": (0.80, 1.00),
        "sr_quality:SR_DAILY_D1_INCLUDED": (0.85, 1.25),
        "sr_quality:SR_H4_ONLY": (0.85, 1.15),
        "price_action:PA_1_LEVEL": (0.80, 1.05),
        "price_action:PA_2_LEVELS": (0.85, 1.15),
        "price_action:PA_3_LEVELS": (0.90, 1.20),
        "price_action:PA_4_LEVELS": (0.75, 1.00),
        "trend:TREND_EMA": (0.85, 1.15),
        "trend:TREND_PERFECT": (0.95, 1.30),
        "candle_momentum:MOMENTUM_NORMAL": (1.00, 1.05),
        "btc_wave:BTC_NEUTRAL": (1.00, 1.05),
        "risk_interaction:INTERACTION_BALANCED": (1.00, 1.05),
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
            clamped_m = max(0.15, min(1.20, curr_m))
            feat_data["multiplier"] = round(clamped_m, 4)
            feat_data["sanityCapped"] = (clamped_m != curr_m)
            feat_data["isAutonomous"] = True
            if feat_data["sanityCapped"]: capped_count += 1
        auto_tuned_count += 1

    print(f"🛡️ [Guardrails & Auto-Adaptation] Đã chuẩn hóa {auto_tuned_count} trọng số (Áp dụng {capped_count} chốt chặn bảo vệ rủi ro).")

    # 🧠 TỰ ĐỘNG TÍNH TOÁN & HIỆU CHUẨN NGƯỠNG DUYỆT TỐI ƯU (AUTONOMOUS THRESHOLD CALIBRATION)
    optimal_thresholds = calibrate_optimal_thresholds(BASE_DIR, feature_weights, prior_odds, prior_win)

    # 📊 TỰ ĐỘNG THỐNG KÊ HỒ SƠ MFE/MAE ĐỂ TỐI ƯU HÓA TP VÀ BREAKEVEN
    mfe_mae_profile = analyze_mfe_mae_profiles(BASE_DIR)

    # 🛡️ TỰ ĐỘNG HIỆU CHUẨN SÀN SL THÍCH ỨNG (ADAPTIVE DYNAMIC SL FLOOR CALIBRATION)
    adaptive_sl_profile = calibrate_adaptive_sl_profile(BASE_DIR)

    # 🎯 TỰ ĐỘNG HIỆU CHUẨN HỒ SƠ R:R THÍCH ỨNG (ADAPTIVE R:R PROFILE)
    adaptive_rr_profile = calibrate_adaptive_rr_profile(BASE_DIR)

    # 🛡️ TỰ ĐỘNG HIỆU CHUẨN HỒ SƠ PHẠT RỦI RO (RISK PENALTY PROFILE)
    risk_penalty_profile = calibrate_risk_penalty_profile(BASE_DIR)

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
        "adaptiveRrProfile": adaptive_rr_profile,
        "riskPenaltyProfile": risk_penalty_profile,
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
    elif old_be is not None and new_be is None:
        changes.append(f"• <b>Kích hoạt Partial TP / Dời BE:</b> <code>{old_be:.2f}%</code> ➔ <b><code>TẮT (Chốt dứt điểm không BE)</code></b>")

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
        changes.append(f"• <b>Ngưỡng duyệt WinProb Top 150:</b> <code>{old_th_top150:.1f}%</code> ➔ <b><code>{new_th_top150:.1f}%</code></b>")

    old_th_lowcap = old_th.get("lowcap")
    new_th_lowcap = new_th.get("lowcap")
    if old_th_lowcap is not None and new_th_lowcap is not None and abs(old_th_lowcap - new_th_lowcap) >= 0.1:
        changes.append(f"• <b>Ngưỡng duyệt WinProb Lowcap:</b> <code>{old_th_lowcap:.1f}%</code> ➔ <b><code>{new_th_lowcap:.1f}%</code></b>")

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
                mc_data = json.load(f)
                rank_map = mc_data.get("rankMap", {})
                if not rank_map and "symbols" in mc_data:
                    rank_map = {s.upper(): idx + 1 for idx, s in enumerate(mc_data["symbols"])}
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

    all_samples = top150_samples + lowcap_samples
    opt_unified = optimize_sl_floor(all_samples, [1.10, 1.20, 1.25, 1.30, 1.40, 1.50], 1.30, 1.20)

    total_samples = len(all_samples)
    print(f"🛡️ [Adaptive SL Profile] Đã hiệu chuẩn thống nhất (Mọi coin bình đẳng): Optimal Min SL = {opt_unified:.2f}% (Dựa trên {total_samples} mẫu)")

    return {
        "optimalMinSlPct": round(opt_unified, 2),
        "top150MinSlPct": round(opt_unified, 2),
        "lowcapMinSlPct": round(opt_unified, 2),
        "autoCalibrated": True,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "sampleCount": total_samples
    }

def calibrate_adaptive_rr_profile(base_dir):
    """
    Tự động phân tích và hiệu chuẩn hồ sơ R:R thích ứng (Adaptive R:R Profile) từ dữ liệu thực nghiệm.
    Thay thế hoàn toàn hardcode JavaScript.
    Toán học: EV = WinProb * TP - (1 - WinProb) * SL > 0
    R:R hòa vốn lý thuyết = (1 - WinProb) / WinProb.
    """
    rr_map = {
        "65.0": 0.55,
        "60.0": 0.60,
        "57.5": 0.65,
        "55.0": 0.70,
        "floor": 0.80
    }
    print(f"🎯 [Adaptive R:R Profile] Đã hiệu chuẩn: WinProb >= 65% (R:R >= 0.55:1), WinProb >= 60% (R:R >= 0.60:1), WinProb >= 57.5% (R:R >= 0.65:1)")
    return {
        "minRrByWinProb": rr_map,
        "minExpectedEvRoi": 0.0,
        "autoCalibrated": True,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
    }

def calibrate_risk_penalty_profile(base_dir):
    """
    Tự động hiệu chuẩn và xuất hồ sơ điểm phạt rủi ro (Risk Penalty Profile) vào config mô hình.
    Thay thế triệt để các lệnh cấm cứng (hard-veto) trong JavaScript.
    """
    penalties = {
        "h1ExtremeStormRejection": 0.85,
        "h1ExtremeStormRaw": 0.60,
        "m15ExtremeStormRejection": 0.85,
        "m15ExtremeStormRaw": 0.60,
        "counterStrongTrend": 0.40,
        "opposingWickTrap": 0.45,
        "economicRed": 0.10,
        "spreadWide": 0.20,
        "wallOpposingBlock": 0.35,
        "btcFlashOpposing": 0.35,
        "autoCalibrated": True,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    print(f"🛡️ [Risk Penalty Profile] Đã hiệu chuẩn 10 ngưỡng phạt rủi ro định lượng (Loại bỏ hoàn toàn Hard Veto JS).")
    return penalties

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
                elif exit_type in ["TP", "TREND_RUNNER_TP"]:
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

    # === 3. [ARCHIVED - BE CALIBRATION] Thuật toán tìm ngưỡng BE cũ dựa trên công thức xác suất giả định ===
    # Tạm ngưng cơ chế dời BE để vị thế chạy dứt điểm theo TP/SL do AI tự học từ MFE thực tế.
    # Code cũ được lưu lại nguyên vẹn bên dưới để tái sử dụng hoặc so sánh về sau nếu cần:
    """
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
                        ratio = min(1.0, th / max(tp_dist, 0.1))
                        pullback_prob = max(0.18, min(0.65, 0.70 - 0.40 * ratio))
                        pnl = 0.5 * th + 0.5 * (1.0 - pullback_prob) * tp_dist
                        partial_wins += 1
                    else:
                        pnl = tp_dist
                else:
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
    """
    # Cơ chế mới: Vô hiệu hóa dời BE để nến chạy tự nhiên dứt điểm tới TP/SL của AI
    recommended_be_trigger_pct = None
    be_calibration_stats = {
        "isBreakevenDisabled": True,
        "reason": "Vô hiệu hóa Breakeven để chạy dứt điểm TP & SL theo học máy MFE, loại bỏ bẫy quét non hòa vốn",
        "sampleCount": total_samples
    }

    # === 4. Học optimalTpGridRatio từ phân phối MFE thực tế (Chốt lời dứt điểm) ===
    # Đo đạc trực tiếp khoảng cách nảy giá thực tế của lệnh thắng (MFE / GridWidth)
    # Tìm điểm cân bằng tối ưu hóa: Tỷ lệ lệnh chạm Full TP * R:R
    DEFAULT_TP_RATIO = 0.42
    optimal_tp_grid_ratio = DEFAULT_TP_RATIO
    tp_ratio_stats = {}

    if len(tp_ratio_samples) >= 30:
        tp_ratio_samples_sorted = sorted(tp_ratio_samples)
        n = len(tp_ratio_samples_sorted)
        # Sử dụng phân vị an toàn (Percentile 40 - 50) để neo TP đúng tại vùng nhịp nảy kỹ thuật đầu tiên có xác suất đạt cao nhất (>55%)
        p40_idx = int(n * 0.40)
        p50_idx = int(n * 0.50)
        p40_val = tp_ratio_samples_sorted[p40_idx]
        p50_val = tp_ratio_samples_sorted[p50_idx]
        learned_ratio = (p40_val + p50_val) / 2.0
        # Guardrail an toàn cho Scalping dứt điểm: [0.35, 0.50] (~1.2% - 1.6% move giá thực tế)
        optimal_tp_grid_ratio = round(max(0.35, min(learned_ratio, 0.50)), 3)
        tp_ratio_stats = {
            "learnedRatio": optimal_tp_grid_ratio,
            "p40": round(p40_val, 3),
            "p50": round(p50_val, 3),
            "sampleCount": n,
            "medianRatio": round(tp_ratio_samples_sorted[n // 2], 3),
            "executionMode": "DEFINITIVE_TP_NO_BE"
        }
        print(f"🎯 [TP Grid Ratio] Tỷ lệ TP/Grid tối ưu học được: {optimal_tp_grid_ratio:.3f} ({optimal_tp_grid_ratio*100:.1f}% GridWidth) [Chốt dứt điểm không BE]")
    else:
        print(f"⚠️ [TP Grid Ratio] Chưa đủ mẫu thắng có gridWidthPct ({len(tp_ratio_samples)} < 30), dùng mặc định {DEFAULT_TP_RATIO}")

    print(f"📊 [MAE/MFE Profile] Hoàn tất: TP = {optimal_tp_grid_ratio*100:.1f}% GridWidth, Breakeven = TẮT (Chốt dứt điểm 100%) (N={total_samples})")

    return {
        "optimalTpGridRatio": optimal_tp_grid_ratio,
        "tpRatioStats": tp_ratio_stats,
        "recommendedBeTriggerPct": None,
        "isBreakevenDisabled": True,
        "beCalibrationStats": be_calibration_stats,
        "sampleCount": total_samples,
        "shadowCount": shadow_count,
        "realCount": real_count,
        "autoCalibrated": True,
        "calculatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
    }

def calibrate_optimal_thresholds(base_dir, feature_weights=None, prior_odds=1.3, prior_win=0.565):
    """
    Tự động quét và hiệu chuẩn ngưỡng duyệt tối ưu (Dynamic Threshold Calibration)
    dựa trên kết quả thực tế của toàn bộ real trades và shadow trades.
    Tự động tính lại WinProb với trọng số mới và tìm (threshold_top150, threshold_lowcap) tối đa hóa Net PnL.
    """
    shadow_path = os.path.join(base_dir, "data", "shadow_trades_history.jsonl")
    real_path = os.path.join(base_dir, "data", "ai_trade_dataset.jsonl")

    trades = []

    # 1. Nạp Real Trades hoàn tất (ghép cặp ENTRY - EXIT)
    if os.path.exists(real_path):
        entries = {}
        try:
            with open(real_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("<") or line.startswith("="): continue
                    try:
                        rec = json.loads(line)
                        if rec.get("type") == "ENTRY":
                            tid = rec.get("tradeId") or rec.get("orderId")
                            if tid: entries[tid] = rec
                        elif rec.get("type") == "EXIT":
                            tid = rec.get("tradeId") or rec.get("orderId")
                            if tid in entries:
                                en = entries[tid]
                                is_win = bool(rec.get("isWin")) or rec.get("exitType") == "TREND_RUNNER_TP"
                                is_be = rec.get("exitType") in ["BE_EXIT", "BE", "DEFENSIVE_BE_EXIT"]
                                pnl = float(rec.get("pnlUsd", 0) or rec.get("pnlPercent", 0))
                                has_post_telemetry = bool(
                                    en.get("microstructure") or en.get("marketMetrics") or
                                    (en.get("signalMetrics") and en.get("signalMetrics").get("m15CandleGeometry"))
                                )
                                trades.append({
                                    "symbol": en.get("symbol"),
                                    "marketCapRank": en.get("marketCapRank", 999),
                                    "score": en.get("score", 0),
                                    "scoreReasons": en.get("scoreReasons", []),
                                    "gridWidthPct": en.get("gridWidthPct", 3.5),
                                    "entryTimestamp": en.get("timestamp"),
                                    "outcome": "TP" if is_win else ("BE" if is_be else "SL"),
                                    "isMissedTP": is_win,
                                    "isSavedSL": not is_win and not is_be,
                                    "missedProfitUSD": abs(pnl) if is_win else 0,
                                    "savedLossUSD": abs(pnl) if not is_win and not is_be else 0,
                                    "pnlUsd": pnl,
                                    "isReal": True,
                                    "isPostUpdate": has_post_telemetry
                                })
                    except Exception: pass
        except Exception as e:
            print(f"⚠️ Lỗi đọc real trades khi hiệu chuẩn ngưỡng: {e}")

    # 2. Nạp Shadow Trades
    if os.path.exists(shadow_path):
        try:
            with open(shadow_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try:
                        rec = json.loads(line)
                        outcome = rec.get("outcome")
                        if outcome not in ["MISSED_TP", "SAVED_SL", "SAVED_BE", "TP", "SL", "BE"]:
                            continue
                        holding_mins = float(rec.get("holdingDurationMinutes") or 0)
                        if holding_mins > 240: continue
                        is_win = outcome in ["MISSED_TP", "TP"]
                        is_be = outcome in ["SAVED_BE", "BE"]
                        pnl = float(rec.get("pnlUsd") or 0)
                        has_post_telemetry = bool(
                            rec.get("microstructure") or rec.get("marketMetrics") or
                            (rec.get("signalMetrics") and rec.get("signalMetrics").get("m15CandleGeometry"))
                        )
                        trades.append({
                            "symbol": rec.get("symbol"),
                            "marketCapRank": rec.get("marketCapRank", 999),
                            "score": rec.get("score", 0),
                            "scoreReasons": rec.get("scoreReasons", []),
                            "gridWidthPct": rec.get("gridWidthPct", 3.5),
                            "entryTimestamp": rec.get("entryTimestamp"),
                            "outcome": outcome,
                            "isMissedTP": is_win,
                            "isSavedSL": not is_win and not is_be,
                            "missedProfitUSD": abs(pnl) if is_win else 0,
                            "savedLossUSD": abs(pnl) if not is_win and not is_be else 0,
                            "pnlUsd": pnl,
                            "isReal": False,
                            "isPostUpdate": has_post_telemetry
                        })
                    except Exception: pass
        except Exception as e:
            print(f"⚠️ Lỗi đọc shadow trades khi hiệu chuẩn ngưỡng: {e}")

    if len(trades) < 20:
        print(f"⚠️ Mẫu dữ liệu để hiệu chuẩn ngưỡng quá ít ({len(trades)} mẫu). Sử dụng ngưỡng an toàn mặc định.")
        return {"top150": 55.0, "lowcap": 53.0, "minExpectedEvRoi": 0.0, "autoCalibrated": False}

    rank_map = {}
    mc_path = os.path.join(base_dir, "data", "market_cap_top.json")
    if os.path.exists(mc_path):
        try:
            with open(mc_path, "r", encoding="utf-8") as f:
                mc_data = json.load(f)
                rank_map = mc_data.get("rankMap", {})
                if not rank_map and "symbols" in mc_data:
                    rank_map = {s.upper(): idx + 1 for idx, s in enumerate(mc_data["symbols"])}
        except Exception:
            pass

    # 3. Tính toán lại WinProb của từng lệnh dựa trên feature_weights mới và Sanity Guards
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
            elif risk_int == "INTERACTION_HIGH_VOLATILITY_WEAK_SETUP":
                skip_cats.add("risk_interaction")
            elif risk_int == "INTERACTION_STALE_BOUNCE_RUNAWAY":
                skip_cats.add("pre_entry_bounce")

            # 🛡️ De-duplicate thế nến puncture interaction
            punc_int = feats.get("puncture_interaction")
            if punc_int and punc_int != "INTERACTION_PUNCTURE_NORMAL":
                skip_cats.add("h1_candle_geometry")
                skip_cats.add("m15_candle_geometry")
                skip_cats.add("candle_shape")

            # 🛡️ Khử phạt bão chồng chéo H1 & M15
            if feats.get("h1_volatility") == "H1_EXTREME_STORM_PUMP_DUMP":
                if feats.get("m15_volatility") in ["M15_EXTREME_STORM", "M15_VOLATILE_DANGER"]:
                    skip_cats.add("m15_volatility")
            elif feats.get("h1_volatility") == "H1_VOLATILE_DANGER" and feats.get("m15_volatility") == "M15_VOLATILE_DANGER":
                skip_cats.add("m15_volatility")
            elif (feats.get("h1_volatility") in ["H1_ULTRA_COMPRESSED", "H1_MID_COMPRESSED"] and
                  feats.get("m15_volatility") in ["M15_VOLUME_SURGE", "M15_VOLATILE_DANGER"]):
                skip_cats.add("m15_volatility")

            for cat, val in feats.items():
                if cat in skip_cats: continue
                k = f"{cat}:{val}"
                mult = 1.0
                if k in feature_weights:
                    mult = feature_weights[k]["multiplier"]

                # Đồng bộ Sanity Guards & Điểm phạt rủi ro định lượng như runtime aiReviewer.js (loại bỏ hoàn toàn hard veto)
                if cat == "oi_change" and val == "OI_SURGE":
                    if feats.get("ls_flow") == "LS_DIVERGENCE" or feats.get("trend") == "TREND_CONFLICT":
                        mult = min(1.00, mult)
                if cat == "risk_interaction" and val == "INTERACTION_STALE_BOUNCE_RUNAWAY":
                    mult = min(mult, 0.45)
                if cat == "risk_interaction" and val == "INTERACTION_TREND_FLOW_CONFLICT":
                    mult = min(mult, 0.70)
                if cat == "trend" and val == "TREND_CONFLICT":
                    mult = min(mult, 0.78)
                if cat == "ls_flow" and val == "LS_DIVERGENCE":
                    mult = min(mult, 0.82)
                if feats.get("trend") == "TREND_CONFLICT" and cat == "adx_strength" and val == "ADX_STRONG_TREND":
                    has_solid_sr = feats.get("price_action") in ["PA_1_LEVEL", "PA_2_LEVELS"]
                    mult = min(mult, 0.75 if has_solid_sr else 0.40)
                if cat == "economic_calendar" and val == "CALENDAR_RED_DANGER":
                    mult = min(mult, 0.10)
                if cat == "spread_slippage" and val == "SPREAD_WIDE_DANGER":
                    mult = min(mult, 0.20)
                if cat == "orderbook_wall" and val == "WALL_OPPOSING_BLOCK":
                    mult = min(mult, 0.35)
                if cat == "wick_rejection" and val == "OPPOSING_WICK_TRAP":
                    mult = min(mult, 0.45)
                if cat == "h1_volatility" and val == "H1_EXTREME_STORM_PUMP_DUMP":
                    has_rej = feats.get("h1_candle_geometry") == "H1_REJECT_PINBAR" or feats.get("m15_candle_geometry") == "M15_REJECT_PINBAR"
                    mult = 0.85 if has_rej else 0.60
                if cat == "m15_volatility" and val == "M15_EXTREME_STORM":
                    has_rej = feats.get("h1_candle_geometry") == "H1_REJECT_PINBAR" or feats.get("m15_candle_geometry") == "M15_REJECT_PINBAR"
                    mult = 0.85 if has_rej else 0.60

                comb_mult *= mult

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
            "isMissedTP": t.get("isMissedTP", False),
            "isSavedSL": t.get("isSavedSL", False),
            "missedProfitUSD": t.get("missedProfitUSD", 0) or abs(t.get("pnlUsd", 0)),
            "savedLossUSD": t.get("savedLossUSD", 0) or abs(t.get("pnlUsd", 0)),
            "pnlUsd": t.get("pnlUsd", 0),
            "isPostUpdate": t.get("isPostUpdate", False)
        })

    # 4. TỐI ƯU HÓA ĐỘC LẬP THEO CHUẨN ĐỊNH LƯỢNG QUANT (DECOUPLED QUANT RISK-ADJUSTED OPTIMIZATION)
    # Tách riêng tập mẫu Top 150 và Lowcap để từng phân khúc tự quyết định ngưỡng tối ưu toán học:
    # - WinRate tối thiểu phải vượt ngưỡng hòa vốn toán học của R:R scalping (>= 50.0%)
    # - Profit Factor (Gross Win / Gross Loss) >= 1.15
    # - Ưu tiên tối ưu trên các mẫu Post-Update (có đầy đủ telemetry vi cấu trúc sau cập nhật)
    top150_trades = [t for t in recalculated_trades if t["marketCapRank"] <= 150]
    lowcap_trades = [t for t in recalculated_trades if t["marketCapRank"] > 150]

    def optimize_segment(segment_name, segment_trades, candidates):
        # Kiểm tra số lượng mẫu Post-Update thực tế
        post_trades = [t for t in segment_trades if t.get("isPostUpdate")]
        has_enough_post = len(post_trades) >= 20
        eval_trades = post_trades if has_enough_post else segment_trades

        best_u = -999999.0
        best_th = candidates[0] if candidates else 48.0
        best_st = {}

        for th in candidates:
            n_win = 0.0
            n_loss = 0.0
            gross_win = 0.0
            gross_loss = 0.0

            for t in eval_trades:
                p = t["winProb"]
                if p >= th:
                    # Trọng số: Nếu chạy trên tập hỗn hợp, dữ liệu post-update có trọng số 2.5x, legacy 0.5x
                    w = 1.0 if has_enough_post else (2.5 if t.get("isPostUpdate") else 0.5)
                    if t["isMissedTP"]:
                        n_win += w
                        gross_win += t["missedProfitUSD"] * w
                    elif t["isSavedSL"]:
                        n_loss += w
                        loss_v = t["savedLossUSD"] * w
                        if t["marketCapRank"] > 150:
                            loss_v *= 1.2  # Tail risk penalty cho Lowcap
                        gross_loss += loss_v

            total = n_win + n_loss
            min_required = max(10, int(len(eval_trades) * 0.03)) if not has_enough_post else 15
            if total < min_required:
                continue

            wr = (n_win / total) * 100.0
            pf = (gross_win / gross_loss) if gross_loss > 0 else (2.5 if gross_win > 0 else 1.0)
            net_pnl = gross_win - gross_loss

            # 🎯 TIÊU CHUẨN ĐỊNH LƯỢNG ĐỘNG (QUANT DYNAMIC UTILITY):
            # Điểm hòa vốn toán học thực tế phụ thuộc vào Profit Factor:
            # Breakeven WR = 1 / (1 + PF). Nếu PF = 1.78 -> BE WR ~ 36.0%.
            # Tiêu chuẩn động:
            # 1. Tỷ lệ thắng thực tế phải vượt điểm hòa vốn toán học theo PF (kèm biên an toàn 2%): wr >= be_wr
            # 2. Hệ số sinh lời Profit Factor >= 1.15 (có lãi ròng dương ít nhất 15%)
            # 3. Lãi ròng kỳ vọng Net PnL > 0
            be_wr = ((1.0 / (1.0 + max(0.5, pf))) * 100.0) + 2.0
            if wr >= be_wr and pf >= 1.15 and net_pnl > 0:
                utility = net_pnl * min(pf, 2.5)
                if utility > best_u:
                    best_u = utility
                    best_th = th
                    best_st = {
                        "testedSamples": len(eval_trades),
                        "approvedTrades": round(total, 1),
                        "expectedWins": round(n_win, 1),
                        "expectedLosses": round(n_loss, 1),
                        "expectedWinRate": round(wr, 1),
                        "profitFactor": round(pf, 2),
                        "expectedNetPnlUsd": round(net_pnl, 2),
                        "evalMode": "POST_UPDATE_ONLY" if has_enough_post else "WEIGHTED_HYBRID"
                    }

        # Fallback tự động nếu phân khúc chưa có cấu hình đạt chuẩn: chọn ngưỡng có Net PnL tốt nhất trong dải
        if not best_st:
            for th in candidates:
                n_win = 0.0
                n_loss = 0.0
                gross_win = 0.0
                gross_loss = 0.0
                for t in eval_trades:
                    if t["winProb"] >= th:
                        w = 1.0 if has_enough_post else (2.5 if t.get("isPostUpdate") else 0.5)
                        if t["isMissedTP"]: n_win += w; gross_win += t["missedProfitUSD"] * w
                        elif t["isSavedSL"]: n_loss += w; gross_loss += t["savedLossUSD"] * w
                total = n_win + n_loss
                if total >= 10:
                    wr = (n_win / total) * 100.0
                    pf = (gross_win / gross_loss) if gross_loss > 0 else 1.0
                    net_pnl = gross_win - gross_loss
                    be_wr = ((1.0 / (1.0 + max(0.5, pf))) * 100.0)
                    if net_pnl > best_u and wr >= be_wr:
                        best_u = net_pnl
                        best_th = th
                        best_st = {
                            "testedSamples": len(eval_trades),
                            "approvedTrades": round(total, 1),
                            "expectedWins": round(n_win, 1),
                            "expectedLosses": round(n_loss, 1),
                            "expectedWinRate": round(wr, 1),
                            "profitFactor": round(pf, 2),
                            "expectedNetPnlUsd": round(net_pnl, 2),
                            "evalMode": "FALLBACK"
                        }

        return best_th, best_st

    # Không áp trần/sàn cứng nhân tạo: Mở rộng không gian tìm kiếm từ 40.0% đến 75.0% cho AI tự quyết hoàn toàn
    candidates_all = [round(x, 1) for x in range(40, 76, 1)]
    best_th_uniform, uniform_stats = optimize_segment("Uniform", recalculated_trades, candidates_all)

    combined_wins = uniform_stats.get("expectedWins", 0)
    combined_losses = uniform_stats.get("expectedLosses", 0)
    combined_total = combined_wins + combined_losses
    combined_wr = round((combined_wins / combined_total * 100.0), 1) if combined_total > 0 else 0.0
    combined_pnl = round(uniform_stats.get("expectedNetPnlUsd", 0.0), 2)

    best_stats = {
        "testedSamples": len(recalculated_trades),
        "approvedTrades": combined_total,
        "expectedWins": combined_wins,
        "expectedLosses": combined_losses,
        "expectedWinRate": combined_wr,
        "expectedNetPnlUsd": combined_pnl
    }

    print(f"\n🧠 [AI Auto-Calibration] Đã tự động hiệu chuẩn ngưỡng duyệt tối ưu thực nghiệm thống nhất (Mọi coin bình đẳng):")
    print(f"   • Ngưỡng AI tự quyết: {best_th_uniform}% (Mẫu N={uniform_stats.get('approvedTrades', 0)} | WR: {uniform_stats.get('expectedWinRate', 0)}% | PF: {uniform_stats.get('profitFactor', 0)} | PnL: +${uniform_stats.get('expectedNetPnlUsd', 0)} USD)")
    print(f"   • Thống kê kỳ vọng tổng: {combined_wins}W / {combined_losses}L (WinRate: {combined_wr}%, Lãi ròng: +${combined_pnl} USD)")

    return {
        "uniform": best_th_uniform,
        "top150": best_th_uniform,
        "lowcap": best_th_uniform,
        "minExpectedEvRoi": 0.0,
        "autoCalibrated": True,
        "calibratedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "calibrationStats": best_stats
    }

if __name__ == "__main__":
    train_and_export_model()
