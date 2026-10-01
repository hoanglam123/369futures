# -*- coding: utf-8 -*-
import sys, os, json, re

sys.stdout.reconfigure(encoding='utf-8')

with open('data/ai_rule_config.json', encoding='utf-8') as f:
    d = json.load(f)
fw = d.get('featureWeights', {})

# Extract GUARDRAIL_BOUNDS from train_ai_model.py
bounds = {}
with open('scripts/train_ai_model.py', encoding='utf-8') as f:
    text = f.read()
    m = re.search(r'GUARDRAIL_BOUNDS\s*=\s*\{([\s\S]*?)\n\s*\}', text)
    if m:
        for line in m.group(1).split('\n'):
            line = line.strip()
            if line.startswith('"'):
                k = line.split('"')[1]
                bounds[k] = line


print(f"Total features defined in GUARDRAIL_BOUNDS: {len(bounds)}")
print(f"Total features in current featureWeights: {len(fw)}")

missing = []
for k, v in fw.items():
    if k not in bounds:
        missing.append((k, v.get('multiplier', 1.0), v.get('winProb', 0.0), v.get('winCount', 0), v.get('lossCount', 0)))

print(f"Tổng số tiêu chí HOÀN TOÀN NẰM NGOÀI GUARDRAIL_BOUNDS: {len(missing)}")
print("-" * 90)
print(f"{'Feature Name':42s} | {'Multiplier':10s} | {'Win Prob':8s} | {'Win Count':10s} | {'Loss Count'}")
print("-" * 90)
for k, mult, wp, wc, lc in sorted(missing, key=lambda x: -x[1]):
    print(f"{k:42s} | {mult:10.4f} | {wp*100:7.1f}% | {wc:10.1f} | {lc:10.1f}")


# Also check features extracted in aiReviewer.js that may not even be in fw or bounds
