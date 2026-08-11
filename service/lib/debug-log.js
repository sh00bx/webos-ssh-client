const fs = require("fs");
const {
  DEBUG_LOG_FILE,
  DEBUG_LOG_OLD_FILE,
  DEBUG_LOG_LIMIT,
  SERVICE_STARTED_AT,
  DEBUG_ENABLED_BY_ENV,
  SECRET_KEY_RE,
} = require("./config");
const { ensureLogStorage } = require("./storage");

// The enabled flag stays module-private behind isDebugEnabled/setDebugEnabled.
// Exporting the boolean itself would be a trap: `const { debugEnabled } =
// require(...)` snapshots the value at require time, so debug/enable would
// flip a variable nobody reads and logging would stay permanently dead with
// no error anywhere.
let debugEnabled = DEBUG_ENABLED_BY_ENV;

function isDebugEnabled() {
  return debugEnabled;
}

function setDebugEnabled(value) {
  debugEnabled = Boolean(value);
}

function sanitizeDebugValue(value, key, depth) {
  if (SECRET_KEY_RE.test(String(key || ""))) return "[redacted]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      level: value.level,
    };
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 800 ? value.slice(0, 800) + "...[truncated]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth > 5) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeDebugValue(item, key, depth + 1));
  }

  const out = {};
  Object.keys(value)
    .slice(0, 80)
    .forEach((childKey) => {
      out[childKey] = sanitizeDebugValue(value[childKey], childKey, depth + 1);
    });
  return out;
}

function sanitizeDebugDetails(details) {
  return sanitizeDebugValue(details || {}, "", 0);
}

function trimDebugLogIfNeeded(extraBytes) {
  try {
    if (!fs.existsSync(DEBUG_LOG_FILE)) return;
    const stat = fs.statSync(DEBUG_LOG_FILE);
    if (stat.size + extraBytes <= DEBUG_LOG_LIMIT) return;
    const existing = fs.readFileSync(DEBUG_LOG_FILE);
    const start = Math.max(0, existing.length - DEBUG_LOG_LIMIT);
    fs.writeFileSync(DEBUG_LOG_OLD_FILE, existing.subarray(start), { mode: 0o600 });
    fs.writeFileSync(DEBUG_LOG_FILE, "", { mode: 0o600 });
  } catch (e) {
    console.error("[sshclient-debug] rotate failed", e.message || String(e));
  }
}

function debugLog(event, details) {
  if (!debugEnabled) return;
  const body = {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptimeMs: Date.now() - SERVICE_STARTED_AT,
    event,
    details: sanitizeDebugDetails(details),
  };
  let line;
  try {
    line = JSON.stringify(body) + "\n";
  } catch (e) {
    line = JSON.stringify({
      ts: body.ts,
      pid: body.pid,
      uptimeMs: body.uptimeMs,
      event: "debug_serialize_failed",
      details: { originalEvent: String(event), error: e.message || String(e) },
    }) + "\n";
  }

  console.log("[sshclient-debug]", line.trim());
  try {
    ensureLogStorage();
    trimDebugLogIfNeeded(Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(DEBUG_LOG_FILE, line, { mode: 0o600 });
  } catch (e) {
    console.error("[sshclient-debug] write failed", e.message || String(e));
  }
}

function readDebugLog(maxBytes) {
  try {
    if (!fs.existsSync(DEBUG_LOG_FILE)) return "";
    const raw = fs.readFileSync(DEBUG_LOG_FILE);
    if (raw.length <= maxBytes) return raw.toString("utf8");
    return raw.subarray(raw.length - maxBytes).toString("utf8");
  } catch (e) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      event: "debug_log_read_failed",
      details: { error: e.message || String(e) },
    }) + "\n";
  }
}

module.exports = {
  isDebugEnabled,
  setDebugEnabled,
  debugLog,
  readDebugLog,
  sanitizeDebugDetails,
};
