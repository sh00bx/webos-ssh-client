// View routing: which of the four surfaces (connect form, keys page, terminal
// session, hidden) is mounted in #app, plus overlay show/hide against the
// webOS compositor. The router owns no session logic — it disposes handles
// via appState and delegates session opening to the injected callbacks, which
// is what breaks the router ↔ session-controller cycle: showConnectForm needs
// startSession and showOverlay needs attachNewestOrShowForm, and main.js owns
// both instances and wires them.
import { mountConnectForm } from "./connect-form.js";
import { mountKeysPage } from "./keys-page.js";
import { appState, clearReturnTimer } from "./app-state.js";
import { serviceCall, compactError } from "./service-client.js";
import {
  debugEvent,
  isDebugEnabled,
  showDebugPanel,
  closeDebugPanel,
} from "./debug.js";
import { currentThemeLabel, cycleTheme, updateBackdropWatch } from "./theme-controller.js";
import { activateApp, closeAppWindow } from "./platform.js";

export function createViewRouter({
  root,
  onStartSession,
  onStartLocalShell,
  onAttachNewest,
  onAttachSession,
}) {
  // Set when a connect failed because the server's host key no longer matches
  // the pinned one. Consumed once by the next connect form, which offers to
  // clear the pin.
  let pendingHostKeyIssue = null;

  function setPendingHostKeyIssue(issue) {
    pendingHostKeyIssue = issue;
  }

  async function forgetPinnedHostKey(issue) {
    debugEvent("ui_forget_host_key", { host: issue.host, port: issue.port });
    await serviceCall("knownhosts/remove", { host: issue.host, port: issue.port });
  }

  function disposeVisibleSession(reason = "dispose") {
    if (appState.session) {
      debugEvent("ui_dispose_visible_session", {
        reason,
        sessionId: appState.session.id || null,
      });
    }
    if (appState.session && appState.session.dispose) appState.session.dispose();
    appState.session = null;
    updateBackdropWatch();
  }

  function showOverlayUnavailable() {
    appState.overlayVisible = true;
    document.body.classList.remove("overlay-hidden");
    document.body.classList.remove("in-session");
    root.innerHTML = `
      <section class="overlay-message" aria-live="polite">
        <h1>overlay close failed</h1>
        <p>webOS did not close the overlay window. Use Home/Back, then relaunch SSH Client to reattach.</p>
        <button type="button" id="restore-overlay-btn" data-tip="Bring the SSH window back">Show SSH</button>
      </section>
    `;
    const restore = root.querySelector("#restore-overlay-btn");
    if (restore) restore.addEventListener("click", showOverlay);
  }

  function hideOverlay(reason = "unknown") {
    if (!appState.overlayVisible) return;
    const currentSessionId = appState.session && appState.session.id ? appState.session.id : null;
    debugEvent("ui_hide_overlay", {
      reason,
      sessionId: currentSessionId,
      documentHidden: document.hidden,
    });
    appState.overlayVisible = false;
    clearReturnTimer();
    closeDebugPanel();
    disposeVisibleSession("hide overlay");
    root.innerHTML = "";
    appState.activeView = "hidden";
    document.body.classList.remove("in-session");
    document.body.classList.add("overlay-hidden");

    try {
      window.close();
      debugEvent("ui_window_close_called", { reason });
    } catch (e) {
      debugEvent("ui_window_close_failed", { error: compactError(e) });
      /* fall through to Luna fallback */
    }
    setTimeout(() => closeAppWindow({ onCloseFailed: showOverlayUnavailable }), 200);
  }

  function showOverlay() {
    debugEvent("ui_show_overlay", {});
    appState.overlayVisible = true;
    document.body.classList.remove("overlay-hidden");
    activateApp();
    onAttachNewest();
    resyncActiveTerminal("show overlay");
  }

  // On resume from the background the WebView may have measured the terminal
  // at zero size, leaving xterm's char metrics invalid and silently dropping
  // mouse reports (e.g. clicks on tmux window tabs do nothing). Force the
  // active terminal to re-measure so mouse mode works again without a manual
  // resize.
  function resyncActiveTerminal(reason) {
    if (!appState.session || typeof appState.session.resyncViewport !== "function") return;
    debugEvent("ui_resync_terminal", { reason });
    appState.session.resyncViewport();
    // Re-claim keyboard focus deterministically on resume. We blur the focus
    // target when the app is backgrounded (visibilitychange→hidden in main.js)
    // so it does not retain a keyboard grab over whatever app the user
    // switched to; that means resume must put focus back, otherwise typing
    // would be dead until a manual click. Focusing the non-editable input sink
    // never raises the OSK.
    if (typeof appState.session.focus === "function") appState.session.focus();
  }

  function showConnectForm() {
    clearReturnTimer();
    closeDebugPanel();
    disposeVisibleSession("show connect form");
    appState.activeView = "connect";
    document.body.classList.remove("in-session");
    debugEvent("ui_show_connect_form", {});
    const hostKeyIssue = pendingHostKeyIssue;
    pendingHostKeyIssue = null;
    mountConnectForm(root, {
      onSubmit: onStartSession,
      onManageKeys: showKeysPage,
      onDebug: showDebugPanel,
      onHide: () => hideOverlay("connect form button"),
      onAttachSession,
      onStartLocalShell,
      debugEnabled: isDebugEnabled(),
      themeLabel: currentThemeLabel(),
      onCycleTheme: () => {
        cycleTheme();
        return currentThemeLabel();
      },
      hostKeyIssue,
      onForgetHostKey: forgetPinnedHostKey,
    });
  }

  function showKeysPage() {
    clearReturnTimer();
    closeDebugPanel();
    disposeVisibleSession("show keys page");
    appState.activeView = "keys";
    document.body.classList.remove("in-session");
    debugEvent("ui_show_keys_page", {});
    mountKeysPage(root, showConnectForm);
  }

  return {
    showOverlay,
    hideOverlay,
    showConnectForm,
    showKeysPage,
    disposeVisibleSession,
    resyncActiveTerminal,
    showOverlayUnavailable,
    setPendingHostKeyIssue,
  };
}
