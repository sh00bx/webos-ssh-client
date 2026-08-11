// The six debug/* Luna methods.
const fs = require("fs");
const {
  STORAGE_DIR,
  DEBUG_LOG_FILE,
  DEBUG_LOG_OLD_FILE,
  DEBUG_LOG_LIMIT,
  DEBUG_LOG_READ_LIMIT,
  SERVICE_STARTED_AT,
  DEBUG_ENABLED_BY_ENV,
} = require("../config");
const { clampInt } = require("../util");
const { ensureLogStorage } = require("../storage");
const {
  isDebugEnabled,
  setDebugEnabled,
  debugLog,
  readDebugLog,
} = require("../debug-log");
const { sessions, sessionSummary } = require("../sessions");
const { keepAliveStatus } = require("../keepalive");

function registerDebugMethods(register) {
  register("debug/info", (message) => {
    message.respond({
      returnValue: true,
      enabled: isDebugEnabled(),
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
      storageDir: STORAGE_DIR,
      logPath: DEBUG_LOG_FILE,
      oldLogPath: DEBUG_LOG_OLD_FILE,
      pid: process.pid,
      startedAt: SERVICE_STARTED_AT,
      uptimeMs: Date.now() - SERVICE_STARTED_AT,
      keepAlive: keepAliveStatus(),
      sessions: Array.from(sessions.values()).map(sessionSummary),
    });
  });

  register("debug/logs", (message) => {
    const params = message.payload || {};
    const maxBytes = clampInt(
      params.maxBytes,
      DEBUG_LOG_READ_LIMIT,
      4096,
      DEBUG_LOG_LIMIT,
    );
    let size = 0;
    try {
      size = fs.existsSync(DEBUG_LOG_FILE) ? fs.statSync(DEBUG_LOG_FILE).size : 0;
    } catch (e) {
      size = 0;
    }
    debugLog("debug_logs_request", { maxBytes, size });
    message.respond({
      returnValue: true,
      enabled: isDebugEnabled(),
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
      path: DEBUG_LOG_FILE,
      oldPath: DEBUG_LOG_OLD_FILE,
      size,
      maxBytes,
      pid: process.pid,
      startedAt: SERVICE_STARTED_AT,
      uptimeMs: Date.now() - SERVICE_STARTED_AT,
      keepAlive: keepAliveStatus(),
      sessions: Array.from(sessions.values()).map(sessionSummary),
      log: readDebugLog(maxBytes),
    });
  });

  register("debug/clear", (message) => {
    try {
      ensureLogStorage();
      fs.writeFileSync(DEBUG_LOG_FILE, "", { mode: 0o600 });
      debugLog("debug_log_cleared", {});
      message.respond({
        returnValue: true,
        path: DEBUG_LOG_FILE,
      });
    } catch (e) {
      message.respond({
        returnValue: false,
        errorCode: "DEBUG_CLEAR_FAILED",
        errorText: e.message || String(e),
      });
    }
  });

  register("debug/enable", (message) => {
    setDebugEnabled(true);
    debugLog("debug_enabled", {
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
    });
    message.respond({
      returnValue: true,
      enabled: isDebugEnabled(),
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
      path: DEBUG_LOG_FILE,
    });
  });

  register("debug/disable", (message) => {
    debugLog("debug_disabled", {
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
    });
    setDebugEnabled(DEBUG_ENABLED_BY_ENV);
    message.respond({
      returnValue: true,
      enabled: isDebugEnabled(),
      enabledByEnv: DEBUG_ENABLED_BY_ENV,
      path: DEBUG_LOG_FILE,
    });
  });

  register("debug/event", (message) => {
    const params = message.payload || {};
    debugLog("ui_event", {
      event: params.event || "unknown",
      details: params.details || {},
      appUptimeMs: params.appUptimeMs || null,
      hidden: params.hidden,
      overlayVisible: params.overlayVisible,
    });
    message.respond({ returnValue: true });
  });
}

module.exports = { registerDebugMethods };
