const fs = require('fs');
const readline = require('readline');

async function testHighQualityStrategy() {
  const rl = readline.createInterface({ input: fs.createReadStream('data/ai_evaluations.jsonl') });
  
  let totalSignals = 0;
  let approvedCount = 0;
  let approvedEvSum = 0;

  for await (const l of rl) {
    if (!l.trim()) continue;
    const item = JSON.parse(l);
    totalSignals++;
    
    const prob = item.aiEvaluation?.winProbability || item.winProbability || 0;
    const isApproved = item.aiEvaluation?.isApproved || prob >= 65.0;
    const reasons = item.aiEvaluation?.reason || '';
    
    if (isApproved) {
      approvedCount++;
    }
  }

  console.log('=== PHÂN TÍCH CHẤT LƯỢNG TÍN HIỆU TOÀN BỘ HỆ THỐNG ===\n');
  console.log(`• Tổng số tín hiệu sinh ra từ Scanner 369: ${totalSignals}`);
  console.log(`• Số tín hiệu đạt chuẩn AI Approved (Xác suất >= 65%): ${approvedCount} (${((approvedCount/totalSignals)*100).toFixed(1)}%)`);
  console.log(`• Số tín hiệu "chất lượng kém/nhiễu" (< 65%): ${totalSignals - approvedCount} (${(((totalSignals - approvedCount)/totalSignals)*100).toFixed(1)}%)`);
}

testHighQualityStrategy();
