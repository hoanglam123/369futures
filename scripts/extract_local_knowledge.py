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
            pages_text = [page.extract_text() for page in reader.pages if page.extract_text()]
            text = "\n".join(pages_text)
        except ImportError:
            try:
                import pdfplumber
                with pdfplumber.open(file_path) as pdf:
                    pages_text = [p.extract_text() for p in pdf.pages if p.extract_text()]
                    text = "\n".join(pages_text)
            except Exception as e:
                print(f"⚠️ Thiếu thư viện pypdf / pdfplumber để đọc file PDF {file_path}. Hãy cài: pip install pypdf")
        except Exception as e:
            print(f"⚠️ Lỗi đọc file PDF {file_path}: {e}")
            
    elif ext == '.docx':
        try:
            import docx
            doc = docx.Document(file_path)
            text = "\n".join([p.text for p in doc.paragraphs if p.text])
        except ImportError:
            print(f"⚠️ Thiếu thư viện python-docx để đọc file Word {file_path}. Hãy cài: pip install python-docx")
        except Exception as e:
            print(f"⚠️ Lỗi đọc file docx {file_path}: {e}")
            
    return text

def parse_knowledge_rules():
    print("=" * 80)
    print("🔍 BÓC TÁCH KIẾN THỨC VÀ QUY TẮC TRADING CỤC BỘ (LOCAL KNOWLEDGE EXTRACTOR)")
    print("=" * 80)
    
    if not os.path.exists(KNOWLEDGE_DIR):
        os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
        print(f"📁 Đã tạo thư mục kiến thức: {KNOWLEDGE_DIR}")
        
    files = [f for f in os.listdir(KNOWLEDGE_DIR) if os.path.isfile(os.path.join(KNOWLEDGE_DIR, f))]
    if not files:
        print("⚠️ Thư mục data/knowledge/ trống. Không có tài liệu kiến thức bổ sung.")
        with open(OUTPUT_RULES_PATH, 'w', encoding='utf-8') as f:
            json.dump({"rule_modifiers": {}, "rules_count": 0}, f, indent=2, ensure_ascii=False)
        return {"rule_modifiers": {}, "rules_count": 0}

    rule_modifiers = {}
    total_rules = 0

    for file in files:
        file_path = os.path.join(KNOWLEDGE_DIR, file)
        content = read_file_content(file_path)
        if not content:
            continue
            
        print(f"📄 Đã đọc thành công tài liệu: {file} ({len(content)} ký tự)")

        # Phân tích các từ khóa & quy tắc trọng yếu trong tài liệu
        content_lower = content.lower()

        # 1. Volatility Compression
        if "siêu nén" in content_lower or "volatility compression" in content_lower:
            rule_modifiers["volatility:VOL_ULTRA"] = 1.15
            total_rules += 1
        if "nén vừa" in content_lower:
            rule_modifiers["volatility:VOL_MID"] = 1.05
            total_rules += 1

        # 2. Whales vs Retail Flow (Gold Setup)
        if "gold setup" in content_lower or "đồng thuận tuyệt đối" in content_lower:
            rule_modifiers["ls_flow:LS_GOLD"] = 1.20
            total_rules += 1
        if "phân kỳ" in content_lower or "bẫy" in content_lower:
            rule_modifiers["ls_flow:LS_DIVERGENCE"] = 0.80
            total_rules += 1

        # 3. Funding Squeeze
        if "short crowded" in content_lower or "squeeze" in content_lower:
            rule_modifiers["funding:FUNDING_SQUEEZE"] = 1.15
            total_rules += 1
        if "funding rate âm" in content_lower or "phí tài trợ âm" in content_lower:
            rule_modifiers["funding:FUNDING_SQUEEZE"] = 1.12
            total_rules += 1

        # 4. Price Action S/R
        if "cản h4" in content_lower or "cản d1" in content_lower or "hỗ trợ" in content_lower:
            rule_modifiers["price_action:PA_4_LEVELS"] = 1.10
            rule_modifiers["price_action:PA_3_LEVELS"] = 1.08
            total_rules += 1

        # 5. Dow Theory & Trend Alignment
        if "lý thuyết dow" in content_lower or "xu hướng" in content_lower or "dow & trendline" in content_lower:
            rule_modifiers["trend:TREND_PERFECT"] = 1.15
            rule_modifiers["trend:TREND_EMA"] = 1.08
            total_rules += 1

        # 6. Elliott Wave, Fibonacci & BTC Wave
        if "sóng elliott" in content_lower or "fibonacci" in content_lower or "sóng" in content_lower or "btc" in content_lower:
            rule_modifiers["btc_wave:BTC_ALIGNED"] = 1.15
            rule_modifiers["trend:TREND_PERFECT"] = 1.18
            total_rules += 1

        # 7. Trader Psychology & Risk Management
        if "tâm lý" in content_lower or "quản trị rủi ro" in content_lower or "kỷ luật" in content_lower:
            rule_modifiers["score_group:SCORE_HIGH_GE7"] = 1.12
            rule_modifiers["funding:FUNDING_NORMAL"] = 1.05
            total_rules += 1

        # 8. Volume & Supply/Demand Breakout
        if "volume bùng nổ" in content_lower or "dòng tiền dội vào" in content_lower or "khối lượng" in content_lower or "breakout" in content_lower:
            rule_modifiers["volume:VOL_SURGE"] = 1.12
            total_rules += 1

        # 9. IPDA Liquidity & Structure (BSL, SSL, CHoCH, FVG, OTE, 20D/40D/60D)
        if "ipda" in content_lower or "bsl" in content_lower or "ssl" in content_lower or "choch" in content_lower or "fvg" in content_lower or "ote" in content_lower:
            rule_modifiers["price_action:PA_4_LEVELS"] = 1.25
            rule_modifiers["ls_flow:LS_GOLD"] = 1.22
            rule_modifiers["trend:TREND_PERFECT"] = 1.25
            rule_modifiers["volatility:VOL_ULTRA"] = 1.18
            total_rules += 1

    knowledge_result = {
        "rule_modifiers": rule_modifiers,
        "rules_count": total_rules,
        "extracted_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    with open(OUTPUT_RULES_PATH, 'w', encoding='utf-8') as f:
        json.dump(knowledge_result, f, indent=2, ensure_ascii=False)

    print(f"✅ Hoàn tất bóc tách {total_rules} quy tắc từ tài liệu. Đã lưu vào: {OUTPUT_RULES_PATH}")
    return knowledge_result

if __name__ == "__main__":
    parse_knowledge_rules()
