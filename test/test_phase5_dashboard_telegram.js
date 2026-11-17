'use strict';

/**
 * Test Suite Toàn Diện Giai Đoạn 5: Web Dashboard (Port 3000) & Bộ Lệnh Telegram 2 Chiều
 * 
 * 1. Web Dashboard Server: Khởi tạo HTTP & WebSocket Server, phục vụ index.html
 * 2. REST API /api/health: Trả về trạng thái uptime, RAM, WebSocket, Safety Brake
 * 3. REST API /api/trades & /api/stats: Bóc tách PnL thời gian thực & Winrate
 * 4. REST API /api/chart & /api/cooldown: Chuỗi dữ liệu biểu đồ PnL & Coin Cooldown
 * 5. Điều khiển từ xa POST /api/forcesync: Override Safety Brake qua API
 * 6. Bộ Lệnh Telegram 2 Chiều: /status, /trades, /scan369, /forcesync, /report, /cooldown, /help
 */

require('dotenv').config();
const assert = require('assert');
const http = require('http');

const {
  startDashboard,
  stopDashboard,
  broadcastWs,
  apiHealth,
  apiTrades,
  apiStats,
  apiChart,
  apiCooldown,
} = require('../src/dashboard');

const {
  executeCommand,
  COMMANDS,
} = require('../src/services/telegramCommands');

const TEST_PORT = 3199; // Dùng port riêng để tránh xung đột

console.log('================================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 5 (DASHBOARD & TELEGRAM)');
console.log('================================================================\n');

let passCount = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
  }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpPost(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${TEST_PORT}${path}`, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // ── TEST 1: KHỞI TẠO WEB DASHBOARD SERVER & PHỤC VỤ STATIC INDEX.HTML ──
  await runAsyncTest('WebDashboard: Khởi tạo HTTP & WebSocket server, phục vụ index.html', async () => {
    const server = startDashboard(TEST_PORT);
    assert.ok(server, 'Server dashboard phải khởi tạo thành công');

    const res = await httpGet('/');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('<!DOCTYPE html>'), 'Phải trả về HTML hợp lệ');
    assert.ok(res.body.includes('PP369') || res.body.includes('Dashboard'), 'Phải có tiêu đề Dashboard');
  });

  // ── TEST 2: REST API /api/health CUNG CẤP SỐ LIỆU SỨC KHỎE HỆ THỐNG ──
  await runAsyncTest('WebDashboard: API /api/health trả về Uptime, RAM, WebSocket, Safety Brake', async () => {
    const res = await httpGet('/api/health');
    assert.strictEqual(res.statusCode, 200);
    const health = JSON.parse(res.body);

    assert.strictEqual(health.status, 'ONLINE');
    assert.ok(typeof health.uptimeSec === 'number');
    assert.ok(health.memory && typeof health.memory.rssMb === 'number');
    assert.ok(health.websocket && typeof health.websocket.userDataStreamConnected === 'boolean');
    assert.ok(health.safetyBrake && typeof health.safetyBrake.isActive === 'boolean');
    assert.ok(typeof health.cooldownCount === 'number');
  });

  // ── TEST 3: REST API /api/trades & /api/stats (VỊ THẾ & TỶ LỆ THẮNG) ──
  await runAsyncTest('WebDashboard: API /api/trades & /api/stats bóc tách PnL và Winrate', async () => {
    const resTrades = await httpGet('/api/trades');
    assert.strictEqual(resTrades.statusCode, 200);
    const trades = JSON.parse(resTrades.body);
    assert.ok(Array.isArray(trades), '/api/trades phải trả về danh sách mảng');

    const resStats = await httpGet('/api/stats');
    assert.strictEqual(resStats.statusCode, 200);
    const stats = JSON.parse(resStats.body);
    assert.ok(typeof stats.winRate === 'number');
    assert.ok(typeof stats.totalTrades === 'number');
    assert.ok(typeof stats.totalPnlPct === 'number');
    assert.ok(typeof stats.profitFactor === 'number');
  });

  // ── TEST 4: REST API /api/chart & /api/cooldown (BIỂU ĐỒ & COOLDOWN) ──
  await runAsyncTest('WebDashboard: API /api/chart & /api/cooldown tính toán chuỗi tích lũy', async () => {
    const resChart = await httpGet('/api/chart');
    assert.strictEqual(resChart.statusCode, 200);
    const chart = JSON.parse(resChart.body);
    assert.ok(Array.isArray(chart), '/api/chart phải trả về mảng dữ liệu biểu đồ');

    const resCd = await httpGet('/api/cooldown');
    assert.strictEqual(resCd.statusCode, 200);
    const cds = JSON.parse(resCd.body);
    assert.ok(Array.isArray(cds), '/api/cooldown phải trả về danh sách coin');
  });

  // ── TEST 5: ĐIỀU KHIỂN TỪ XA POST /api/forcesync (OVERRIDE SAFETY BRAKE) ──
  await runAsyncTest('WebDashboard: Lệnh POST /api/forcesync mở khóa Safety Brake từ xa', async () => {
    const res = await httpPost('/api/forcesync');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.action, 'forcesync');
    assert.ok(data.message.includes('override'));

    // Kiểm tra broadcast WebSocket không bị lỗi
    broadcastWs('TEST_EVENT', { ping: 'pong' });
  });

  // Dọn dẹp dashboard server sau khi test xong
  stopDashboard();

  // ── TEST 6: BỘ LỆNH TELEGRAM 2 CHIỀU ĐIỀU KHIỂN TỪ XA ──
  await runAsyncTest('TelegramCommands: Tiếp nhận và xử lý đầy đủ các lệnh tương tác 2 chiều', async () => {
    // 1. Kiểm tra bảng lệnh đăng ký
    const expectedCommands = ['/status', '/trades', '/positions', '/scan369', '/radar', '/forcesync', '/report', '/cooldown', '/help'];
    for (const cmd of expectedCommands) {
      assert.ok(COMMANDS[cmd], `Lệnh ${cmd} phải có handler tương ứng`);
    }

    // 2. Chạy thử các handler (phòng vệ không crash)
    const statusOk = await executeCommand('/status');
    assert.strictEqual(statusOk, true);

    const tradesOk = await executeCommand('/trades');
    assert.strictEqual(tradesOk, true);

    const scanOk = await executeCommand('/scan369');
    assert.strictEqual(scanOk, true);

    const forceSyncOk = await executeCommand('/forcesync');
    assert.strictEqual(forceSyncOk, true);

    const reportOk = await executeCommand('/report');
    assert.strictEqual(reportOk, true);

    const cdOk = await executeCommand('/cooldown');
    assert.strictEqual(cdOk, true);

    const helpOk = await executeCommand('/help');
    assert.strictEqual(helpOk, true);

    // Lệnh không tồn tại
    const unknownOk = await executeCommand('/invalidcommand');
    assert.strictEqual(unknownOk, false, 'Lệnh lạ phải trả về false');
  });

  console.log('\n================================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ GIAI ĐOẠN 5: ${passCount}/${totalTests} TESTS ĐẠT CHUẨN (${(passCount / totalTests * 100).toFixed(1)}%)`);
  console.log('================================================================');

  if (passCount === totalTests) {
    console.log('🎉 TẤT CẢ CÁC TÍNH NĂNG GIAI ĐOẠN 5 HOẠT ĐỘNG HOÀN HẢO 100%!\n');
    process.exit(0);
  } else {
    console.error(`⚠️ CÓ ${totalTests - passCount} BÀI TEST THẤT BẠI!\n`);
    process.exit(1);
  }
})();
