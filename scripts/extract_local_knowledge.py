import os
import sys
import json
import re
import time

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KNOWLEDGE_DIR = os.path.join(BASE_DIR, "data", "knowledge")
OUTPUT_RULES_PATH = os.path.join(BASE_DIR, "data", "knowledge_rules.json")

_easyocr_reader = None

def read_file_content(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    text = ""
    
    if ext in ['.md', '.txt', '.json']:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                text = f.read()
        except Exception as e:
            print(f"⚠️ Lỗi đọc file text {file_path}: {e}")
            
    elif ext == '.pdf':
        try:
            import pypdf
            reader = pypdf.PdfReader(file_path)
            pages_text = []
            for i, page in enumerate(reader.pages):
                try:
                    t = page.extract_text()
                    if t:
                        pages_text.append(t)
                except Exception:
                    pass
            text = "\n".join(pages_text)
        except Exception as e:
            print(f"⚠️ Lỗi đọc file PDF {file_path}: {e}")
            
    elif ext in ['.jpg', '.jpeg', '.png']:
        try:
            import easyocr
            global _easyocr_reader
            if _easyocr_reader is None:
                _easyocr_reader = easyocr.Reader(['vi', 'en'], gpu=False)
            results = _easyocr_reader.readtext(file_path, detail=0)
            text = "\n".join(results)
        except Exception as e:
            print(f"⚠️ Lỗi OCR đọc file ảnh {file_path}: {e}")
            
    return text

def parse_knowledge_rules():
    print("=" * 85)
    print("🔍 BÓC TÁCH KIẾN THỨC VÀ QUY TẮC TRADING CHUYÊN SÂU TỪ TÀI LIỆU & ẢNH (KNOWLEDGE EXTRACTOR)")
    print("=" * 85)
    
    if not os.path.exists(KNOWLEDGE_DIR):
        os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
        print(f"📁 Đã tạo thư mục kiến thức: {KNOWLEDGE_DIR}")
        
    files = [f for f in os.listdir(KNOWLEDGE_DIR) if os.path.isfile(os.path.join(KNOWLEDGE_DIR, f))]
    
    if not files:
        if os.path.exists(OUTPUT_RULES_PATH):
            try:
                with open(OUTPUT_RULES_PATH, 'r', encoding='utf-8') as f:
                    existing = json.load(f)
                    if existing.get("rule_modifiers") and len(existing.get("rule_modifiers")) > 0:
                        print(f"💎 [Server Mode] Thư mục PDF trống -> BẢO TỒN VĨNH VIỄN {existing.get('rules_count', len(existing['rule_modifiers']))} quy tắc đã học trong knowledge_rules.json.")
                        return existing
            except Exception as e:
                print(f"⚠️ Lỗi đọc file kiến thức cũ: {e}")
        
        print("⚠️ Thư mục data/knowledge/ trống. Không có tài liệu kiến thức bổ sung.")
        return {"rule_modifiers": {}, "rules_count": 0}

    rule_modifiers = {}
    total_rules = 0
    detailed_topics = []

    print(f"📚 Phát hiện {len(files)} tài liệu/hình ảnh trong data/knowledge/.\nBắt đầu đọc và trích xuất kiến thức...")

    for idx, file in enumerate(files, 1):
        file_path = os.path.join(KNOWLEDGE_DIR, file)
        content = read_file_content(file_path)
        if not content:
            continue
            
        print(f"[{idx}/{len(files)}] 📄 Đã đọc: {file} ({len(content):,} ký tự)")

        content_lower = content.lower()

        # 1. Volatility Compression & Bollinger Squeeze
        if "siêu nén" in content_lower or "volatility compression" in content_lower or "thắt nút" in content_lower or "bollinger bands" in content_lower:
            rule_modifiers["volatility:VOL_ULTRA"] = 1.20
            rule_modifiers["volatility:VOL_MID"] = 1.08
            total_rules += 2

        # 2. Whales vs Retail Flow (Gold Setup & Bơi cùng cá mập)
        if "gold setup" in content_lower or "đồng thuận tuyệt đối" in content_lower or "cá mập" in content_lower or "smart money" in content_lower or "order flow" in content_lower:
            rule_modifiers["ls_flow:LS_GOLD"] = 1.25
            rule_modifiers["ls_flow:LS_PARTIAL"] = 1.08
            total_rules += 2
        if "phân kỳ" in content_lower or "bẫy" in content_lower or "fakey" in content_lower or "false breakout" in content_lower:
            rule_modifiers["ls_flow:LS_DIVERGENCE"] = 0.75
            total_rules += 1

        # 3. Funding Squeeze & Bẫy Đám Đông
        if "short crowded" in content_lower or "long crowded" in content_lower or "squeeze" in content_lower or "funding rate âm" in content_lower:
            rule_modifiers["funding:FUNDING_SQUEEZE"] = 1.18
            rule_modifiers["funding:FUNDING_NORMAL"] = 1.05
            total_rules += 2

        # 4. Price Action & Supply / Demand (Vùng Cung Cầu, Cản Cũ)
        if "cung cầu" in content_lower or "supply demand" in content_lower or "cản h4" in content_lower or "cản d1" in content_lower or "hỗ trợ" in content_lower or "kháng cự" in content_lower:
            rule_modifiers["price_action:PA_4_LEVELS"] = 1.15
            rule_modifiers["price_action:PA_3_LEVELS"] = 1.10
            rule_modifiers["price_action:PA_2_LEVELS"] = 1.05
            total_rules += 3

        # 5. Dow Theory, Trend Alignment & Minervini Trend Template
        if "lý thuyết dow" in content_lower or "trend line" in content_lower or "đường xu hướng" in content_lower or "minervini" in content_lower or "xu hướng" in content_lower:
            rule_modifiers["trend:TREND_PERFECT"] = 1.22
            rule_modifiers["trend:TREND_EMA"] = 1.10
            total_rules += 2

        # 6. Elliott Wave, Fibonacci & BTC Wave Alignment
        if "sóng elliott" in content_lower or "fibonacci" in content_lower or "sóng 3" in content_lower or "sóng 5" in content_lower or "btc" in content_lower:
            rule_modifiers["btc_wave:BTC_ALIGNED"] = 1.20
            rule_modifiers["trend:TREND_PERFECT"] = 1.25
            total_rules += 2

        # 7. Trader Psychology & Làm Chủ Xác Suất
        if "tâm lý" in content_lower or "kỷ luật" in content_lower or "xác suất" in content_lower or "quản trị rủi ro" in content_lower:
            rule_modifiers["score_group:SCORE_HIGH_GE7"] = 1.15
            rule_modifiers["score_group:SCORE_MID_6_TO_7"] = 1.08
            total_rules += 2

        # 8. Volume Momentum & Sakata Candlesticks (Nến Nhật Đảo Chiều)
        if "volume bùng nổ" in content_lower or "nến nhật" in content_lower or "sakata" in content_lower or "pinbar" in content_lower or "inside bar" in content_lower:
            rule_modifiers["volume:VOL_SURGE"] = 1.15
            rule_modifiers["volume:VOL_STABLE"] = 1.05
            total_rules += 2

        # 9. IPDA Liquidity & Structure (BSL, SSL, CHoCH, FVG, OTE)
        if "ipda" in content_lower or "bsl" in content_lower or "ssl" in content_lower or "choch" in content_lower or "fvg" in content_lower:
            rule_modifiers["price_action:PA_4_LEVELS"] = 1.28
            rule_modifiers["ls_flow:LS_GOLD"] = 1.25
            total_rules += 2

    # Ghi nhận kết quả
    knowledge_result = {
        "rule_modifiers": rule_modifiers,
        "rules_count": total_rules,
        "extracted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source_files_count": len(files)
    }

    with open(OUTPUT_RULES_PATH, 'w', encoding='utf-8') as f:
        json.dump(knowledge_result, f, indent=2, ensure_ascii=False)
        
    print("\n" + "=" * 85)
    print(f"🎉 HOÀN TẤT BÓC TÁCH VÀ NẠP NÃO BỘ AI TỪ {len(files)} TÀI LIỆU & HÌNH ẢNH!")
    print(f"💎 Tổng số quy tắc trading và hệ số xác suất đã học: {total_rules}")
    print(f"📁 Đã lưu trữ vĩnh viễn vào: {OUTPUT_RULES_PATH}")
    print("=" * 85 + "\n")
    return knowledge_result

if __name__ == "__main__":
    parse_knowledge_rules()
