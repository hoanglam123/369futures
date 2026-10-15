import json
import os
import sys
import shutil

sys.stdout.reconfigure(encoding='utf-8')

def deduplicate_file(file_path, window_ms=20*60*1000):
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        return
    
    backup_path = file_path + ".bak"
    shutil.copyfile(file_path, backup_path)
    print(f"Backup created at: {backup_path}")
    
    unique_records = []
    seen = {} # key: (sym, sig) -> last_timestamp
    duplicates_removed = 0
    total_lines = 0

    with open(backup_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            total_lines += 1
            try:
                rec = json.loads(line)
                sym = rec.get("symbol")
                sig = rec.get("signal") or rec.get("side")
                ts = rec.get("timestamp") or rec.get("entryTimestamp") or rec.get("exitTimestamp") or 0
                
                # Check for shadow duplication
                is_shadow = rec.get("isShadow", False) or "shadowId" in rec or "SHADOW" in str(rec.get("tradeId", ""))
                
                if is_shadow and sym and sig:
                    key = (sym, sig)
                    last_ts = seen.get(key, 0)
                    if abs(ts - last_ts) < window_ms:
                        duplicates_removed += 1
                        continue # Skip duplicate
                    seen[key] = ts
                
                unique_records.append(line)
            except Exception:
                unique_records.append(line)

    with open(file_path, "w", encoding="utf-8") as f:
        for u in unique_records:
            f.write(u + "\n")
            
    print(f"File: {os.path.basename(file_path)}")
    print(f"  Total records: {total_lines}")
    print(f"  Duplicates removed: {duplicates_removed}")
    print(f"  Remaining clean records: {len(unique_records)}")

if __name__ == "__main__":
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
    dataset_file = os.path.join(base_dir, "ai_trade_dataset.jsonl")
    history_file = os.path.join(base_dir, "shadow_trades_history.jsonl")
    
    print("=== DEDUPLICATING SHADOW HISTORY ===")
    deduplicate_file(history_file)
    
    print("\n=== DEDUPLICATING AI TRADE DATASET ===")
    deduplicate_file(dataset_file)
