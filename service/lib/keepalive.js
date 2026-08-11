// The activityManager keepalive that stops webOS from idling the service out
// while SSH sessions are alive. Depends on the session count only through the
// counter injected via initKeepAlive() — that keeps the dependency one-way
// (sessions.js → keepalive.js) instead of a require cycle.
const { service } = require("./bus");
const {
  KEEPALIVE_ACTIVITY_NAME,
  ACTIVE_IDLE_TIMEOUT_SECONDS,
  IDLE_IDLE_TIMEOUT_SECONDS,
} = require("./config");
const { debugLog } = require("./debug-log");

let keepAliveActivity = null;
let keepAlivePending = false;
let countActiveSessions = () => 0;

function initKeepAlive(options) {
  if (options && typeof options.countActiveSessions === "function") {
    countActiveSessions = options.countActiveSessions;
  }
}

function setServiceIdleTimeout(seconds, reason) {
  if (!service.activityManager) return;
  try {
    service.activityManager.idleTimeout = seconds;
    debugLog("idle_timeout_set", { seconds, reason });
  } catch (e) {
    debugLog("idle_timeout_set_failed", { seconds, reason, error: e });
  }
}

function createKeepAlive(reason) {
  if (keepAliveActivity || keepAlivePending || !countActiveSessions()) return;
  if (
    !service.activityManager ||
    typeof service.activityManager.create !== "function"
  ) {
    debugLog("keepalive_unavailable", { reason });
    setServiceIdleTimeout(ACTIVE_IDLE_TIMEOUT_SECONDS, "keepalive unavailable");
    return;
  }

  keepAlivePending = true;
  setServiceIdleTimeout(ACTIVE_IDLE_TIMEOUT_SECONDS, reason);
  debugLog("keepalive_create_request", {
    reason,
    activeSessions: countActiveSessions(),
    name: KEEPALIVE_ACTIVITY_NAME,
  });

  try {
    service.activityManager.create(KEEPALIVE_ACTIVITY_NAME, (activity) => {
      keepAlivePending = false;
      keepAliveActivity = activity || null;
      debugLog("keepalive_created", {
        reason,
        activeSessions: countActiveSessions(),
        hasActivity: Boolean(keepAliveActivity),
      });
      if (!countActiveSessions()) completeKeepAlive("no sessions after keepalive create");
    });
  } catch (e) {
    keepAlivePending = false;
    debugLog("keepalive_create_failed", { reason, error: e });
  }
}

function completeKeepAlive(reason) {
  if (!keepAliveActivity) {
    if (!countActiveSessions()) setServiceIdleTimeout(IDLE_IDLE_TIMEOUT_SECONDS, reason);
    return;
  }
  if (
    !service.activityManager ||
    typeof service.activityManager.complete !== "function"
  ) {
    debugLog("keepalive_complete_unavailable", { reason });
    keepAliveActivity = null;
    if (!countActiveSessions()) setServiceIdleTimeout(IDLE_IDLE_TIMEOUT_SECONDS, reason);
    return;
  }

  const activity = keepAliveActivity;
  keepAliveActivity = null;
  debugLog("keepalive_complete_request", { reason, activeSessions: countActiveSessions() });
  try {
    service.activityManager.complete(activity, () => {
      debugLog("keepalive_completed", { reason, activeSessions: countActiveSessions() });
      if (!countActiveSessions()) setServiceIdleTimeout(IDLE_IDLE_TIMEOUT_SECONDS, reason);
    });
  } catch (e) {
    debugLog("keepalive_complete_failed", { reason, error: e });
    if (!countActiveSessions()) setServiceIdleTimeout(IDLE_IDLE_TIMEOUT_SECONDS, reason);
  }
}

function updateKeepAlive(reason) {
  if (countActiveSessions()) {
    createKeepAlive(reason);
  } else {
    completeKeepAlive(reason);
  }
}

// Status snapshot for the debug/info and debug/logs payloads.
function keepAliveStatus() {
  return {
    active: Boolean(keepAliveActivity),
    pending: keepAlivePending,
    activityName: KEEPALIVE_ACTIVITY_NAME,
    idleTimeout:
      service.activityManager && service.activityManager.idleTimeout,
  };
}

module.exports = { initKeepAlive, updateKeepAlive, keepAliveStatus };
