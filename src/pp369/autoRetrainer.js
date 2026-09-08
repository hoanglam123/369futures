'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const aiReviewer = require('./aiReviewer');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'retrain_state.json');
const DATASET_FILE = path.join(DATA_DIR, 'ai_trade_dataset.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'ai_rule_config.json');

let _logger = {
  info: (...a) => console.log('[AutoRetrainer]', ...a),
  warn: (...a) => console.warn('[AutoRetrainer]', ...a),
  error: (...a) => console.error('[AutoRetrainer]', ...a),
  system: (...a) => console.log('[AutoRetrainer]', ...a),
};

function setLogger(logger) {
  _logger = logger;
}

let _timer = null;
let _isRetraining = false;

/**
 * Load state from retrain_state.json
 */
function loadRetrainState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8') || '{}');
    }
  } catch (e) {
    _logger.warn(`Lỗi đọc ${STATE_FILE}: ${e.message}`);
  }
  return {
    lastRetrainTimestamp: 0,
    lastDatasetSampleCount: 0,
    lastModelVersion: '1.3.0',
    retrainCount: 0
  };
}

/**
 * Save state to retrain_state.json
 */
function saveRetrainState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    _logger.error(`Lỗi lưu ${STATE_FILE}: ${e.message}`);
  }
}

/**
 * Count the number of EXIT records in ai_trade_dataset.jsonl
 */
function countDatasetSamples() {
  try {
    if (!fs.existsSync(DATASET_FILE)) return 0;
    const lines = fs.readFileSync(DATASET_FILE, 'utf8').trim().split('\n');
    let exitCount = 0;
    for (const l of lines) {
      if (!l) continue;
      if (l.includes('"type":"EXIT"')) exitCount++;
    }
    return exitCount;
  } catch (e) {
    _logger.warn(`Lỗi đếm dataset samples: ${e.message}`);
    return 0;
  }
}

/**
 * Detect available Python binary across Windows and Linux VPS
 */
function _getPythonBinary() {
  const candidates = [
    process.env.PYTHON_BIN,
    process.env.PYTHON_PATH,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python'
  ].filter(Boolean);

  for (const cmd of candidates) {
    try {
      const check = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
      if (check.status === 0) return cmd;
    } catch (e) {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Execute python scripts/train_ai_model.py safely
 */
function _executePythonTraining() {
  return new Promise((resolve) => {
    const pythonScript = path.join(process.cwd(), 'scripts', 'train_ai_model.py');
    if (!fs.existsSync(pythonScript)) {
      return resolve({ success: false, error: `Script không tồn tại: ${pythonScript}` });
    }

    const pyBin = _getPythonBinary();
    _logger.system(`[AutoRetrain] 🚀 Đang khởi chạy huấn luyện AI model (${pyBin}: scripts/train_ai_model.py)...`);

    const pyProcess = spawn(pyBin, [pythonScript], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    pyProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pyProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pyProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code ${code}`, stdout });
      }
    });

    pyProcess.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Run a full retraining cycle
 *
 * @param {boolean} [force=false] - Force training even if threshold not reached
 */
async function runRetrainCycle(force = false) {
  if (_isRetraining) {
    _logger.warn(`[AutoRetrain] Tiến trình huấn luyện trước đó đang chạy, bỏ qua yêu cầu này.`);
    return { status: 'ALREADY_RUNNING' };
  }

  const state = loadRetrainState();
  const currentSamples = countDatasetSamples();
  const newSamples = currentSamples - (state.lastDatasetSampleCount || 0);

  // Conditions:
  // 1. Force is true
  // 2. newSamples >= 20
  // 3. Time elapsed >= 24h AND newSamples >= 5
  const hoursSinceLast = (Date.now() - (state.lastRetrainTimestamp || 0)) / (3600 * 1000);
  const shouldTrain = force || newSamples >= 20 || (hoursSinceLast >= 24 && newSamples >= 5);

  if (!shouldTrain) {
    return {
      status: 'SKIPPED_NOT_ENOUGH_DATA',
      currentSamples,
      newSamples,
      hoursSinceLast: Math.round(hoursSinceLast * 10) / 10
    };
  }

  _isRetraining = true;
  const startTime = Date.now();

  try {
    const res = await _executePythonTraining();

    if (!res.success) {
      _logger.error(`[AutoRetrain] ❌ Huấn luyện thất bại: ${res.error}`);
      return { status: 'FAILED', error: res.error };
    }

    // Verify resulting config file
    if (!fs.existsSync(CONFIG_FILE)) {
      _logger.error(`[AutoRetrain] ❌ Không tìm thấy file config sau huấn luyện: ${CONFIG_FILE}`);
      return { status: 'FAILED_CONFIG_MISSING' };
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
    const featureCount = Object.keys(config.featureWeights || {}).length;
    const priorWinProb = config.priorWinProb || config.priorWinRate;

    if (featureCount < 15 || !priorWinProb || priorWinProb < 0.40 || priorWinProb > 0.70) {
      _logger.error(`[AutoRetrain] ❌ Model mới không đạt tiêu chuẩn an toàn (features: ${featureCount}, prior: ${priorWinProb}). Hủy cập nhật!`);
      return { status: 'FAILED_SANITY_CHECK', featureCount, priorWinProb };
    }

    // Trigger Hot-Reload in aiReviewer
    const reloadResult = aiReviewer.checkModelHotReload();

    // Update state
    state.lastRetrainTimestamp = Date.now();
    state.lastDatasetSampleCount = currentSamples;
    state.lastModelVersion = config.version || '1.3.x';
    state.retrainCount = (state.retrainCount || 0) + 1;
    saveRetrainState(state);

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    _logger.system(`[AutoRetrain] 🎉 HUẤN LUYỆN THÀNH CÔNG! Não bộ AI đã được nâng cấp lên v${state.lastModelVersion} (Mẫu: ${config.totalSamples || currentSamples}, Features: ${featureCount}, Thời gian: ${durationSec}s). Hot-reload hoàn tất!`);

    return {
      status: 'SUCCESS',
      version: state.lastModelVersion,
      sampleCount: config.sampleCount || currentSamples,
      featureCount,
      durationSec,
      reloadResult
    };

  } catch (e) {
    _logger.error(`[AutoRetrain] Lỗi trong chu kỳ huấn luyện: ${e.message}`);
    return { status: 'EXCEPTION', error: e.message };
  } finally {
    _isRetraining = false;
  }
}

/**
 * Start background periodic retraining scheduler
 *
 * @param {object} [options]
 * @param {number} [options.checkIntervalMs=3600000] - Default check every 1 hour
 * @param {number} [options.minNewSamples=20]
 */
function startPeriodicRetrain(options = {}) {
  if (_timer) clearInterval(_timer);

  const intervalMs = options.checkIntervalMs || 60 * 60 * 1000; // 1 hour
  _logger.info(`[AutoRetrain] Đã khởi động bộ lập lịch tự học AI (Kiểm tra mỗi ${(intervalMs / 60000).toFixed(0)} phút, ngưỡng mẫu mới: ${options.minNewSamples || 20})`);

  _timer = setInterval(async () => {
    try {
      const now = new Date();
      // Prefer running at 03:00 AM VN time (UTC+7) or when enough samples
      const vnHour = (now.getUTCHours() + 7) % 24;
      const state = loadRetrainState();
      const currentSamples = countDatasetSamples();
      const newSamples = currentSamples - (state.lastDatasetSampleCount || 0);

      const minSamples = options.minNewSamples || 20;
      if (newSamples >= minSamples || (vnHour === 3 && newSamples >= 5)) {
        await runRetrainCycle(false);
      }
    } catch (err) {
      _logger.warn(`[AutoRetrain] Lỗi kiểm tra chu kỳ tự học: ${err.message}`);
    }
  }, intervalMs);

  if (_timer.unref) _timer.unref();
}

/**
 * Stop background periodic retraining
 */
function stopPeriodicRetrain() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    _logger.info(`[AutoRetrain] Đã dừng bộ lập lịch tự học AI.`);
  }
}

/**
 * Get current retrain status
 */
function getRetrainStatus() {
  const state = loadRetrainState();
  const currentSamples = countDatasetSamples();
  const newSamples = currentSamples - (state.lastDatasetSampleCount || 0);
  return {
    isRetraining: _isRetraining,
    lastRetrainTime: state.lastRetrainTimestamp ? new Date(state.lastRetrainTimestamp).toISOString() : null,
    lastModelVersion: state.lastModelVersion,
    totalSamplesInDataset: currentSamples,
    newSamplesSinceLastRetrain: newSamples,
    retrainCount: state.retrainCount || 0
  };
}

module.exports = {
  setLogger,
  runRetrainCycle,
  startPeriodicRetrain,
  stopPeriodicRetrain,
  getRetrainStatus,
  countDatasetSamples
};
