// Composition root. Constructs the view router and the session controller,
// cross-wires them, and owns the app-global listeners (keyboard shortcuts,
// webOSRelaunch, visibilitychange, pagehide) plus the attach-or-show-form
// startup flow.
//
// The two CSS imports must stay the first two statements, in this order:
// esbuild concatenates CSS in import order into dist/main.css, and app rules
// must come before xterm's defaults. No other module may import CSS.
import "./styles.css";
import "xterm/css/xterm.css";

import { isCtrlAltKey, isRemoteBackKey } from "./keymap.mjs";
import { appState } from "./app-state.js";
import { listSessions, compactError } from "./service-client.js";
import {
  APP_STARTED_AT,
  initDebug,
  debugEvent,
  isDebugPanelOpen,
  showDebugPanel,
  closeDebugPanel,
} from "./debug.js";
import { updateBackdropWatch } from "./theme-controller.js";
import { bootstrapRootHelpers } from "./root-helpers.js";
import { initTooltips } from "./tooltip.js";
import { createViewRouter } from "./view-router.js";
import {
  createSessionController,
  AUTH_FAIL_RETURN_MS,
} from "./session-controller.js";

const root = document.getElementById("app");
initDebug({ root });
// Document-level and view-agnostic on purpose: every view is torn down and
// rebuilt (connect form → terminal → files → keys), and a tooltip layer that
// had to be re-armed per view would silently go missing on whichever path
// forgot to call it.
initTooltips();
// Router and controller reference each other through main.js-owned wiring:
// the router's connect form starts sessions, the controller's teardown paths
// return to the router's views. The thunks below resolve `controller` lazily,
// which is what makes the construction order work.
let controller = null;
const router = createViewRouter({
  root,
  onStartSession: (connectArgs) => controller.startSession(connectArgs),
  onStartLocalShell: () => controller.startLocalSession(),
  onAttachNewest: () => attachNewestOrShowForm(),
  onAttachSession: (sessionId) => controller.attachSession(sessionId),
});
controller = createSessionController({
  root,
  showConnectForm: router.showConnectForm,
  disposeVisibleSession: router.disposeVisibleSession,
  hideOverlay: router.hideOverlay,
  onHostKeyIssue: router.setPendingHostKeyIssue,
});

function newestSession(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  return sessions
    .slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
}

// Grace period before falling back to the connect form, so a fast
// sessions/list can attach straight to a live session without flashing the
// login screen first.
const ATTACH_FALLBACK_DELAY_MS = 120;

async function attachNewestOrShowForm() {
  // NOTE: deliberately does NOT clear the return-to-login timer. Every path
  // that actually mounts a view (showConnectForm, showKeysPage,
  // openTerminalSession) clears it itself, and scheduleReturnToLogin's identity
  // guard makes a stale timer harmless. Clearing it here used to strand the
  // user: relaunching during the 3s goodbye window cancelled the timer, then
  // both branches below declined to mount anything because a closed session was
  // still registered — leaving a dead terminal on screen forever.
  const started = Date.now();
  let fallbackShown = false;
  let completed = false;
  debugEvent("ui_attach_newest_start", {});

  const fallbackTimer = setTimeout(() => {
    if (completed || appState.session || appState.activeView === "keys" || appState.activeView === "session") return;
    fallbackShown = true;
    debugEvent("ui_attach_newest_fallback_form", {
      delayMs: ATTACH_FALLBACK_DELAY_MS,
    });
    router.showConnectForm();
  }, ATTACH_FALLBACK_DELAY_MS);

  try {
    const sessions = await listSessions();
    completed = true;
    clearTimeout(fallbackTimer);
    debugEvent("ui_sessions_list_ok", {
      durationMs: Date.now() - started,
      count: sessions.length,
      sessions,
    });
    const existing = newestSession(sessions);
    if (existing && existing.id) {
      if (!appState.session && (appState.activeView === "startup" || appState.activeView === "hidden" || appState.activeView === "connect")) {
        controller.attachSession(existing.id);
      } else {
        debugEvent("ui_attach_newest_skipped", {
          sessionId: existing.id,
          activeView: appState.activeView,
          hasSession: Boolean(appState.session),
        });
      }
      return;
    }
  } catch (e) {
    completed = true;
    clearTimeout(fallbackTimer);
    debugEvent("ui_sessions_list_failed", {
      durationMs: Date.now() - started,
      error: compactError(e),
    });
    /* service may be unavailable in desktop layout runs */
  }
  debugEvent("ui_attach_newest_no_session", {});
  // `activeView !== "connect"` matters because the return-to-login timer can
  // now fire during the await above and mount the form itself. Re-mounting
  // would wipe it — including the host-key recovery banner, which is consumed
  // on first render.
  if (
    !fallbackShown &&
    !appState.session &&
    appState.activeView !== "keys" &&
    appState.activeView !== "session" &&
    appState.activeView !== "connect"
  ) {
    router.showConnectForm();
    return;
  }
  // A session that already ended is still registered during the 3s goodbye
  // window (cleanupSession keeps it so the message stays readable). Nothing was
  // mounted above, so make sure the return to the login form is still armed —
  // otherwise the user is left staring at a terminal that takes no input.
  if (appState.session && appState.session.closed && !appState.returnTimer) {
    debugEvent("ui_attach_newest_rearm_return", { sessionId: appState.session.id || null });
    controller.scheduleReturnToLogin(appState.session, AUTH_FAIL_RETURN_MS);
  }
}

// Element that held DOM focus when the app was backgrounded. Resume must give
// focus back: every view binds its key handling to its own subtree (the connect
// form to its panel, the terminal to its frame), so coming back with focus on
// <body> leaves the whole UI keyboard-dead until the user clicks something.
// resyncActiveTerminal() covers the terminal case; this covers the others.
let blurredOnHide = null;

function restoreFocusAfterResume() {
  const target = blurredOnHide;
  blurredOnHide = null;
  if (appState.session) return; // resyncActiveTerminal() already refocused the terminal
  if (!target || !target.isConnected || typeof target.focus !== "function") return;
  try {
    target.focus();
    debugEvent("ui_restore_focus", { view: appState.activeView });
  } catch (e) {
    /* element may have been re-rendered — nothing better to do */
  }
}

document.addEventListener("keydown", (e) => {
  if (isDebugPanelOpen() && (e.key === "Escape" || isRemoteBackKey(e))) {
    debugEvent("ui_shortcut_debug_close", {
      key: e.key || null,
      keyCode: e.keyCode || null,
    });
    e.preventDefault();
    closeDebugPanel();
    return;
  }

  if (appState.overlayVisible && isCtrlAltKey(e, "d")) {
    debugEvent("ui_shortcut_debug_open", {
      key: e.key || null,
      keyCode: e.keyCode || null,
    });
    e.preventDefault();
    showDebugPanel();
    return;
  }

  // Disconnect: Ctrl+Alt+Q (plus Ctrl+Alt+X as an alias — with the DE layout
  // any Alt+Q is classified as AltGraph because DE has "@" on Q's third
  // level, so isCtrlAltKey(e, "q") can never match there; X has no third
  // level on DE and always works).
  if (appState.session && (isCtrlAltKey(e, "q") || isCtrlAltKey(e, "x"))) {
    debugEvent("ui_shortcut_disconnect", {
      key: e.key || null,
      keyCode: e.keyCode || null,
      sessionId: appState.session.id || null,
    });
    e.preventDefault();
    controller.disconnectCurrent();
    return;
  }

  // Detach to the login/session picker WITHOUT disconnecting: Ctrl+Alt+S.
  // The view is disposed but the service keeps the SSH session alive; it
  // shows up under "Live sessions" on the connect form for re-attach. (S has
  // no third level on the DE layout, so the chord is never AltGraph-eaten.)
  if (appState.session && isCtrlAltKey(e, "s")) {
    debugEvent("ui_shortcut_detach", {
      key: e.key || null,
      sessionId: appState.session.id || null,
    });
    e.preventDefault();
    router.showConnectForm();
    return;
  }

  // Open a shell on the TV itself: Ctrl+Alt+L. Reachable from any view, since
  // the point of a local shell is usually that something else is broken — the
  // network, the remote host, or the session you were in. (L has no third
  // level on the DE layout, so the chord is never eaten as AltGraph; see the
  // Ctrl+Alt+X/S aliases above for why that matters.)
  if (appState.overlayVisible && isCtrlAltKey(e, "l")) {
    debugEvent("ui_shortcut_local_shell", { key: e.key || null });
    e.preventDefault();
    controller.startLocalSession();
    return;
  }

  // On the keys page the remote Back key navigates back to the connect form
  // instead of hiding the whole app.
  if (appState.overlayVisible && isRemoteBackKey(e) && appState.activeView === "keys") {
    debugEvent("ui_shortcut_keys_back", { key: e.key || null });
    e.preventDefault();
    router.showConnectForm();
    return;
  }

  // Hide overlay without disconnecting: Ctrl+Alt+H or the webOS Back key.
  if (
    appState.overlayVisible &&
    (isCtrlAltKey(e, "h") || isRemoteBackKey(e))
  ) {
    debugEvent("ui_shortcut_hide", {
      key: e.key || null,
      keyCode: e.keyCode || null,
      code: e.code || null,
    });
    e.preventDefault();
    router.hideOverlay(isRemoteBackKey(e) ? "remote back" : "ctrl-alt-h");
  }
});

document.addEventListener("webOSRelaunch", () => {
  debugEvent("ui_webos_relaunch", {
    documentHidden: document.hidden,
    overlayVisible: appState.overlayVisible,
  });
  if (appState.overlayVisible && !document.hidden) {
    router.hideOverlay("webOS relaunch toggle");
  } else {
    router.showOverlay();
  }
}, true);

document.addEventListener("visibilitychange", () => {
  debugEvent("ui_visibility_change", { hidden: document.hidden });
  if (document.hidden) {
    appState.overlayVisible = false;
    // Backgrounded: drop our DOM keyboard focus so this overlay does not hold a
    // keyboard grab over the app the user switched to (e.g. Kodi receiving no
    // remote/keyboard input until SSH Client is restarted). Resume re-focuses
    // it below. Harmless if the grab is compositor-level.
    try {
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === "function") {
        blurredOnHide = active;
        active.blur();
      }
    } catch (e) {
      /* ignore */
    }
  } else {
    // Returned to the foreground without a webOSRelaunch (system overlay
    // dismissed, input switch, screensaver). Restore overlayVisible — the
    // hidden branch above cleared it, and without this the Hide button,
    // Back key and Ctrl+Alt shortcuts stay dead (hideOverlay early-returns)
    // and the relaunch toggle runs inverted. Skip when the overlay was
    // hidden on purpose (activeView "hidden") so the failed-close detection
    // in closeAppWindow keeps working.
    if (appState.activeView !== "hidden") appState.overlayVisible = true;
    // The WebView may have re-laid out from a zero-size background state,
    // invalidating xterm's char metrics. Re-measure so mouse mode (tmux tab
    // clicks) keeps working without a manual resize.
    router.resyncActiveTerminal("visibility visible");
    restoreFocusAfterResume();
  }
  // Backgrounded → pause the backdrop feed (backdropd stops capturing while
  // no client is connected); foregrounded → resume it.
  updateBackdropWatch();
}, true);

window.addEventListener("pagehide", () => {
  debugEvent("ui_pagehide", {});
  closeDebugPanel();
  router.disposeVisibleSession("pagehide");
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    debugEvent("ui_dom_content_loaded", {
      durationMs: Date.now() - APP_STARTED_AT,
      readyState: document.readyState,
    });
  }, { once: true });
} else {
  debugEvent("ui_dom_already_ready", {
    durationMs: Date.now() - APP_STARTED_AT,
    readyState: document.readyState,
  });
}

window.addEventListener("load", () => {
  debugEvent("ui_window_load", {
    durationMs: Date.now() - APP_STARTED_AT,
  });
}, { once: true });

debugEvent("ui_start", {
  userAgent: navigator.userAgent,
  location: window.location && window.location.href,
});
// Startup, in this order and for this reason: the first view is mounted from
// whatever the service says about live sessions, and only THEN are the bundled
// root helpers installed/refreshed. ptyd takes the owner of the app's storage
// directory as the identity allowed to open its socket, and that directory is
// created by the service on its first call — so the service has to have run
// once before ptyd starts. Nothing waits on the bootstrap: it is fire and
// forget, and a TV without Homebrew Channel simply has no root path at all.
attachNewestOrShowForm().finally(() => {
  bootstrapRootHelpers();
});
