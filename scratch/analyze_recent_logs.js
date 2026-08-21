'use strict';

const fs = require('fs');

async function analyzeRecentLogs() {
  const logFile = 'logs/pm2-out.log';
  if (!fs.existsSync(logFile)) {
    console.log('No pm2-out.log found.');
    return;
  }

  // Read last 2000 lines
  const lines = fs.readFileSync(logFile, 'utf8').split('\n');
  const recentLines = lines.slice(-2000);

  const aiLogs = [];
  recentLines.forEach(line => {
    if (line.includes('[AI Reviewer]') || line.includes('[AI Khuyến Nghị]') || line.includes('WinRate:') || line.includes('WinProb:')) {
      aiLogs.push(line);
    }
  });

  console.log('='.repeat(80));
  console.log(`📊 PHÂN TÍCH NHẬT KÝ ĐÁNH GIÁ CỦA AI TRONG VÀI TIẾNG GẦN ĐÂY (Tìm thấy ${aiLogs.length} dòng):`);
  console.log('='.repeat(80));

  // In 20 dòng gần nhất
  aiLogs.slice(-30).forEach(l => console.log(l));
}

analyzeRecentLogs();
