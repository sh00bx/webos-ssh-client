// Debug logging + the on-screen debug panel. The enabled flag and the panel
// element are module-private on purpose: exporting the booleans as bindings
// would freeze them at import time for CommonJS-style consumers and invite
// stale reads — callers go through isDebugEnabled() / isDebugPanelOpen().
import { appState } from "./app-state.js";
import { serviceCall, serviceSend, compactError } from "./service-client.js";
import { loadDebugEnabled, setDebugEnabledFlag } from "./prefs.js";

const DEBUG_LOG_MAX_BYTES = 512 * 1024;

export const APP_STARTED_AT = Date.now();

let root = null;
let debugPanel = null;
let debugPanelOpening = false;
let debugEnabled = loadDebugEnabled();
let serviceDebugSynced = false;
let serviceDebugSyncing = false;

// Store the mount root once; the panel appends into it.
export function initDebug(options) {
  root = (options && options.root) || null;
}

export function isDebugEnabled() {
  return debugEnabled;
}

export function isDebugPanelOpen() {
  return Boolean(debugPanel);
}

export function debugEvent(event, details = {}) {
  if (!debugEnabled) return;
  syncServiceDebugLogging();
  try {
    console.log("[sshclient-ui]", event, details);
  } catch (e) {
    /* console may be unavailable on old WebViews */
  }
  serviceSend("debug/event", {
    event,
    details,
    appUptimeMs: Date.now() - APP_STARTED_AT,
    hidden: document.hidden,
    overlayVisible: appState.overlayVisible,
  });
}

function syncServiceDebugLogging() {
  if (!debugEnabled || serviceDebugSynced || serviceDebugSyncing) return;
  serviceDebugSyncing = true;
  serviceSend(
    "debug/enable",
    {},
    () => {
      serviceDebugSynced = true;
      serviceDebugSyncing = false;
    },
    () => {
      serviceDebugSyncing = false;
    },
  );
}

export async function enableDebugLogging() {
  if (!debugEnabled) {
    debugEnabled = true;
    setDebugEnabledFlag();
  }
  if (serviceDebugSynced) {
    debugEvent("ui_debug_enabled", {});
    return;
  }
  try {
    await serviceCall("debug/enable");
    serviceDebugSynced = true;
  } catch (e) {
    /* service may be unavailable in desktop layout runs */
  }
  debugEvent("ui_debug_enabled", {});
}

export function closeDebugPanel() {
  if (!debugPanel) return;
  debugPanel.remove();
  debugPanel = null;
  debugEvent("ui_debug_panel_close", {});
}

async function refreshDebugPanel(panel) {
  if (!panel) return;
  const meta = panel.querySelector(".debug-meta");
  const logText = panel.querySelector(".debug-log-text");
  if (meta) meta.textContent = "loading debug log...";
  try {
    const resp = await serviceCall("debug/logs", { maxBytes: DEBUG_LOG_MAX_BYTES });
    if (logText) {
      logText.value = resp.log || "";
      logText.scrollTop = logText.scrollHeight;
    }
    if (meta) {
      const count = Array.isArray(resp.sessions) ? resp.sessions.length : 0;
      meta.textContent =
        `path: ${resp.path || "unknown"} | size: ${resp.size || 0} bytes | sessions: ${count}`;
    }
  } catch (e) {
    if (meta) meta.textContent = `debug log unavailable: ${JSON.stringify(compactError(e))}`;
  }
}

async function clearDebugLog(panel) {
  try {
    await serviceCall("debug/clear");
  } catch (e) {
    debugEvent("ui_debug_clear_failed", { error: compactError(e) });
  }
  refreshDebugPanel(panel);
}

function copyDebugLog(panel) {
  const logText = panel && panel.querySelector(".debug-log-text");
  if (!logText) return;
  const value = logText.value || "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).catch(() => {
      logText.focus();
      logText.select();
    });
    return;
  }
  logText.focus();
  logText.select();
}

export async function showDebugPanel() {
  if (debugPanel) {
    refreshDebugPanel(debugPanel);
    return;
  }
  // Claim the singleton BEFORE awaiting. enableDebugLogging() suspends on a
  // Luna round-trip the first time, and two overlapping opens (double-tap, key
  // auto-repeat on Ctrl+Alt+D) both used to get past the check and append a
  // panel — leaving an orphan covering the terminal whose Close button closes
  // the other one.
  if (debugPanelOpening) return;
  debugPanelOpening = true;
  // The Luna bridge settles this promise only from its callbacks and has no
  // timeout, so a service that died mid-request would otherwise leave the flag
  // latched and the panel unreachable for the rest of the app's life. Give up
  // waiting and open the panel anyway — the service-side log simply stays
  // empty, which is a far better failure than a dead shortcut.
  const releaseLatch = setTimeout(() => {
    debugPanelOpening = false;
  }, 3000);
  try {
    await enableDebugLogging();
  } finally {
    clearTimeout(releaseLatch);
    debugPanelOpening = false;
  }
  if (debugPanel) {
    refreshDebugPanel(debugPanel);
    return;
  }
  debugEvent("ui_debug_panel_open", {});
  const panel = document.createElement("section");
  panel.className = "debug-panel";
  panel.setAttribute("aria-label", "Debug log");

  const header = document.createElement("div");
  header.className = "debug-header";
  const title = document.createElement("h1");
  title.textContent = "debug log";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.dataset.tip = "Close the log (Esc or Back)";
  closeBtn.addEventListener("click", closeDebugPanel);
  header.append(title, closeBtn);

  const meta = document.createElement("p");
  meta.className = "debug-meta";
  meta.textContent = "loading debug log...";

  const textarea = document.createElement("textarea");
  textarea.className = "debug-log-text";
  textarea.readOnly = true;
  textarea.spellcheck = false;

  const actions = document.createElement("div");
  actions.className = "debug-actions";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = "Refresh";
  refreshBtn.addEventListener("click", () => refreshDebugPanel(panel));
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => copyDebugLog(panel));
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => clearDebugLog(panel));
  actions.append(refreshBtn, copyBtn, clearBtn);

  panel.append(header, meta, textarea, actions);
  if (root) root.appendChild(panel);
  debugPanel = panel;
  refreshDebugPanel(panel);
}
