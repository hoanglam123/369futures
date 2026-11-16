'use strict';

/**
 * Logger mặc định cho pp369 — dùng console, có thể override bằng setLogger().
 * Khi dùng trong project lớn: gọi setLogger(projectLogger) để log vào file.
 */

let _logger = {
  system: (msg, d) => console.log('[PP369]',       msg, d != null ? d : ''),
  warn:   (msg, d) => console.warn('[PP369 WARN]', msg, d != null ? d : ''),
  error:  (msg, d) => console.error('[PP369 ERR]', msg, d != null ? d : ''),
};

const log = new Proxy({}, {
  get: (_, k) => (msg, d) => (_logger[k] ?? _logger.warn)(msg, d),
});

function setLogger(logger) {
  _logger = logger;
}

module.exports = { log, setLogger };
