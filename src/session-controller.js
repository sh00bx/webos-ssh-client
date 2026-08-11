// The protocol half of a terminal session: orchestrates chrome + xterm +
// the service subscription, owns the session handle stored in appState, and
// tears everything down in the right order. The DOM/window chrome lives in
// terminal-window.js; the two halves meet at the bindTerminal() seam.
import { initTerminal, preloadTerminalFont } from "./terminal.js";
import { createTerminalWindow } from "./terminal-window.js";
import { mountFileExplorer } from "./file-explorer.js";
import {
  serviceSend,
  subscribeSession,
  listSessions,
  compactError,
} from "./service-client.js";
import { appState, clearReturnTimer } from "./app-state.js";
import {
  debugEvent,
  isDebugEnabled,
  showDebugPanel,
  closeDebugPanel,
} from "./debug.js";
import { currentTheme, deferSolves, updateBackdropWatch } from "./theme-controller.js";
import { openUrlInBrowser } from "./platform.js";
import { hexToRgbTriplet } from "./color.mjs";
import { canBrowseFiles } from "./session-label.mjs";

export const AUTH_FAIL_RETURN_MS = 3000;
// How long a keystroke pushes the next Chameleon map solve out (see
// deferSolves in theme-controller.js). Long enough that a typing burst keeps
// the expensive raster parked entirely; short enough that the effect resumes
// the moment the user pauses. 350 ms was dimensioned for the CSS path, where
// one map update cost a ~100 ms GPU raster; on the WebGL renderer a solve is
// a few ms of JS and a small texture upload, so the hold only needs to keep a
// solve from sharing the exact frame with the keystroke's echo when the
// shared compositor is contended — and the effect stays live while typing.
const TYPE_HOLD_MS = 350;
const TYPE_HOLD_WEBGL_MS = 120;
// When a reconnect is on offer the auto-return window is longer: picking a
// button with the Magic Remote inside 3 seconds is a race the user loses.
export const RECONNECT_RETURN_MS = 15000;

export function createSessionController({
  root,
  showConnectForm,
  disposeVisibleSession,
  hideOverlay,
  onHostKeyIssue,
}) {
  // Bumped on every open; a stale open detects it changed across the font
  // preload await and cancels instead of mounting a second terminal.
  let terminalOpenToken = 0;

  // Which sessions currently show a files tab, and which view a pending attach
  // should land on. Both live OUTSIDE openTerminalSession because they have to
  // survive it: switching tabs tears the current view down and mounts a new
  // one, and the answer to "does this host have a files tab open" must not be
  // one of the things that gets torn down with it.
  const openFiles = new Set();
  let pendingViewMode = "ssh";
  // Last summary the service gave for each live session id. The only thing the
  // UI needs out of it is `kind` (ssh vs local), and the alternative — passing
  // the kind through every hook that currently takes a bare id — would touch
  // every tab callback for one field. Refreshed by refreshTabs below.
  const sessionsById = new Map();

  // Tab keys are `${sessionId}:${mode}`. A session id is a service-generated
  // token with no colon in it, so splitting on the LAST colon would be
  // equivalent — but splitting on the first would break the day that changes,
  // so take the mode off the end and leave the rest alone.
  function splitTabKey(key) {
    const s = String(key || "");
    const cut = s.lastIndexOf(":");
    if (cut < 0) return [s, "ssh"];
    const mode = s.slice(cut + 1);
    return [s.slice(0, cut), mode === "scp" ? "scp" : "ssh"];
  }

  // "+" and Ctrl+Shift+T open the CONNECT FORM, not a clone of the current
  // session. This used to re-dial the last connect args Terminator-style, which
  // is the right default on a desktop where a new tab is another local shell —
  // here every tab is a remote host, and cloning made the button unable to do
  // the one thing a second tab is usually for. The form is not a detour: it
  // restores the last profile with the host preselected, so re-dialling the
  // same host is one confirm away, and it lists the live sessions for attach.
  //
  // The running session is NOT killed by this: showConnectForm only disposes
  // the VIEW (disposeVisibleSession), the service keeps the pty alive and its
  // tab comes back through the form's session list.
  function openNewTab() {
    debugEvent("ui_new_tab", {});
    showConnectForm();
  }

  // Dispose the given session's view and mount the login form — unless a
  // NEWER session took over in the meantime (identity guard).
  function returnToLoginNow(localSession) {
    if (appState.session && appState.session !== localSession) return;
    if (localSession && localSession.dispose) localSession.dispose();
    appState.session = null;
    updateBackdropWatch();
    showConnectForm();
  }

  function scheduleReturnToLogin(localSession, delay) {
    clearReturnTimer();
    appState.returnTimer = setTimeout(() => {
      appState.returnTimer = null;
      returnToLoginNow(localSession);
    }, delay);
  }

  // Tear down the input/resize wiring of a session whose connection ended, but
  // keep it registered as the active session. The terminal must stay alive so
  // the goodbye message renders during the return-to-login delay, and keeping
  // the reference means every navigation path (Hide, Connect, keys page) still
  // runs dispose() via disposeVisibleSession — previously the session was
  // nulled here, which turned those paths into no-ops and leaked the xterm
  // instance plus its document-level capture listeners whenever the user
  // navigated away before the 3s timer fired.
  function cleanupSession(localSession) {
    if (appState.session !== localSession) return;
    if (localSession.cleanup) localSession.cleanup();
    localSession.closed = true;
    updateBackdropWatch();
  }

  function disconnectCurrent() {
    if (!appState.session) return;
    clearReturnTimer();
    debugEvent("ui_disconnect_current", { sessionId: appState.session.id || null });
    if (appState.session.id) {
      serviceSend("disconnect", { sessionId: appState.session.id });
    }
    if (appState.session.dispose) appState.session.dispose();
    appState.session = null;
    updateBackdropWatch();
    // Delayed re-read on purpose: a new session may have been opened inside
    // these 200ms, and painting the connect form over it would be a bug.
    setTimeout(() => {
      if (appState.session === null) showConnectForm();
    }, 200);
  }

  // A shell on the TV itself rather than on a remote host. Same session
  // machinery end to end — the difference lives entirely in the service, which
  // gets the pty from the ptyd helper instead of from ssh2 (see
  // service/lib/local-session.js). There are no connect args to collect, so
  // this is a button and not a form.
  function startLocalSession() {
    debugEvent("ui_start_local_session", {});
    pendingViewMode = "ssh";
    openTerminalSession({ mode: "local" });
  }

  function startSession(connectArgs) {
    // `openMode` is a UI intent, not a connect parameter — strip it before the
    // args go anywhere near the service payload, which is spread wholesale into
    // the Luna call.
    const { openMode, ...serviceArgs } = connectArgs || {};
    pendingViewMode = openMode === "scp" ? "scp" : "ssh";
    debugEvent("ui_start_session", {
      host: serviceArgs.host,
      port: serviceArgs.port,
      user: serviceArgs.user,
      authType: serviceArgs.auth && serviceArgs.auth.type,
      openMode: pendingViewMode,
    });
    openTerminalSession({ mode: "connect", connectArgs: serviceArgs });
  }

  function attachSession(sessionId) {
    debugEvent("ui_attach_session", { sessionId });
    openTerminalSession({ mode: "attach", sessionId });
  }

  // The session handle stored in appState — the contract every other module
  // duck-types against (see app-state.js).
  function buildSessionHandle(terminal, wrapper) {
    // Last flat ink written to the wrapper, so an unchanged colour does not
    // re-invalidate the rows' worth of spans that inherit it.
    let lastFlatInk = null;
    // Last veil colour written to the screen box, for the same reason: the
    // veil only moves past its own deadband upstream, so most frames hand the
    // identical string back and the write can be skipped outright.
    let lastVeilColor = null;
    return {
      id: null,
      term: terminal.term,
      sub: null,
      dispose: null,
      resyncViewport: terminal.resyncViewport,
      setTheme: terminal.setTheme,
      adoptThemeInk: terminal.adoptThemeInk,
      focus: terminal.focus,
      // Chameleon adaptive theme: the text colour is solved against the
      // background the glyphs actually sit on, which is the panel tint at
      // whatever the opacity slider is set to — so the effect needs to read the
      // live alpha, and this is the module that owns the wrapper it lives on.
      // Falls back to the CSS default rather than guessing if the property is
      // not set yet (first sample can beat the first applyOpacity).
      //
      // The inline style is tried first: applyOpacity writes --term-alpha as
      // an inline property on this wrapper, and reading it back from
      // wrapper.style costs nothing — while getComputedStyle at the feed's
      // cadence forces a style recalc per call for the same answer. The
      // computed read only happens in the window before the first
      // applyOpacity.
      panelAlpha: () => {
        const inline = Number.parseFloat(
          wrapper.style.getPropertyValue("--term-alpha"),
        );
        if (Number.isFinite(inline)) return inline;
        const raw = getComputedStyle(wrapper).getPropertyValue("--term-alpha");
        const alpha = Number.parseFloat(raw);
        return Number.isFinite(alpha) ? alpha : 0.86;
      },
      // Chameleon per-glyph ink: where the shell sits on the screen. The
      // backdrop grid always covers the whole screen, so the effect needs two
      // boxes out of the DOM — the glyph rows, to line the ink map up with the
      // text it colours, and the panel, because the sample has our own tint
      // composited into it only where the panel actually is.
      backdropGeometry: () => {
        const rows = typeof terminal.rowsElement === "function" ? terminal.rowsElement() : null;
        if (!rows || typeof rows.getBoundingClientRect !== "function") return null;
        const rowsRect = rows.getBoundingClientRect();
        const panelRect = wrapper.getBoundingClientRect();
        const viewportW = window.innerWidth || 0;
        const viewportH = window.innerHeight || 0;
        // A backgrounded WebView lays the page out at zero size; a map built
        // from that would be positioned against a viewport that does not exist.
        if (!viewportW || !viewportH || !rowsRect.width || !rowsRect.height) return null;
        return { rows: rowsRect, panel: panelRect, viewportW, viewportH };
      },
      // Chameleon per-glyph ink: hands the finished map to CSS. The image
      // arrives already cropped to the glyph rows, so there is no geometry to
      // apply here — the stylesheet stretches it across that box and the
      // colour a glyph picks up is the one computed for the screen it covers.
      //
      // The image goes on as a plain inline style on the rows box, NOT as a
      // custom property. A custom property is inherited, so changing one on the
      // wrapper invalidates the style of everything beneath it — which here is
      // every <span> of every row, thousands of them, at the feed's cadence.
      // An inline declaration on one element invalidates that element. The flat
      // ink stays a property because the spans genuinely have to read it, and
      // is only written when it changes.
      //
      // Two shapes arrive here, and which one is built upstream depends on
      // inkMode() below. `texture` goes to the glyph renderer, which samples it
      // per fragment; `url` is the CSS path above. The rest — the flat ink for
      // filled cells, the attribute that arms the veil's transition — is common
      // to both, so it stays out of the branch.
      setInkMap: (map) => {
        const rows = typeof terminal.rowsElement === "function" ? terminal.rowsElement() : null;
        const hasInk = Boolean(map && (map.url || map.texture));
        if (!hasInk) {
          delete wrapper.dataset.chameleonInk;
          if (typeof terminal.setInkTexture === "function") terminal.setInkTexture(null);
          if (rows) rows.style.removeProperty("background-image");
          wrapper.style.removeProperty("--chameleon-flat-ink");
          lastFlatInk = null;
          return;
        }
        if (map.texture) {
          terminal.setInkTexture(map.texture);
        } else {
          if (!rows) return;
          rows.style.backgroundImage = `url("${map.url}")`;
        }
        if (map.flatInk && map.flatInk !== lastFlatInk) {
          lastFlatInk = map.flatInk;
          wrapper.style.setProperty("--chameleon-flat-ink", map.flatInk);
        }
        // The value, not just the presence, is what the stylesheet keys on: the
        // clip-to-text rules only make sense while an image is actually being
        // written to the rows box, and applying them to a renderer that has no
        // rows (or to a DOM renderer that has just been rebuilt after a lost GL
        // context) would paint transparent glyphs over nothing.
        const inkKind = map.texture ? "webgl" : "image";
        if (wrapper.dataset.chameleonInk !== inkKind) wrapper.dataset.chameleonInk = inkKind;
      },
      // Which renderer is carrying the glyphs, and therefore which shape of ink
      // it wants. Asked per solve rather than cached: WebGL2 can be lost at any
      // moment, and the answer has to be the truth at the moment the map is
      // built, not at the moment the session was opened.
      inkMode: () =>
        typeof terminal.inkMode === "function" ? terminal.inkMode() : "image",
      setGlyphRenderer: (mode) =>
        typeof terminal.setGlyphRenderer === "function"
          ? terminal.setGlyphRenderer(mode)
          : "dom",
      // The veil is decoupled from the map: a solid fill on the screen box is
      // the one part of the effect this GPU paints for free, so it follows
      // the feed at full cadence while the glyph map takes its budgeted time.
      // "important" is load-bearing: the terminal's transparency rests on
      // `.term-frame .xterm-screen { background-color: transparent
      // !important }` (styles.css), which silently swallows a plain inline
      // colour — the veil shipped once without this and read as "no veil at
      // all" over a bright picture. An inline important declaration is the
      // one thing that outranks a stylesheet important one.
      setVeil: (color) => {
        const screen =
          typeof terminal.screenElement === "function" ? terminal.screenElement() : null;
        if (!screen) return;
        const veil = color || null;
        if (veil === lastVeilColor) return;
        if (veil) {
          screen.style.setProperty("background-color", veil, "important");
        } else {
          screen.style.removeProperty("background-color");
        }
        lastVeilColor = veil;
      },
      // Chameleon adaptive theme: lets the backdrop feed tint the window
      // chrome (slider thumb, button hovers) along with the shell text.
      setAccent: (color) => {
        if (color) {
          wrapper.style.setProperty("--accent", color);
          // Keep the triplet in step so translucent accent fills (resize-handle
          // hover, focus washes) follow the adaptive colour instead of staying
          // on the theme's static one.
          const rgb = hexToRgbTriplet(color);
          if (rgb) wrapper.style.setProperty("--accent-rgb", rgb);
        } else {
          wrapper.style.removeProperty("--accent");
          wrapper.style.removeProperty("--accent-rgb");
        }
      },
    };
  }

  // The common end-of-connection path: tear down the wiring (terminal stays
  // alive for the goodbye text), then either offer a reconnect or fall back
  // to the login form. Reconnect is only offered when this client initiated
  // the connection (mode "connect" — we hold the full connectArgs) and the
  // failure is not one a retry cannot fix (wrong password, changed host key).
  function makeSessionEnder({ localSession, chrome, mode, connectArgs }) {
    const term = localSession.term;
    return function endSession({ reconnect = false, hint = null } = {}) {
      cleanupSession(localSession);
      // A connect that dies before "ready" never reaches the onSessionsChanged
      // branch that consumes pendingViewMode — left as "scp", it would send the
      // next attach of some unrelated session to the files view. Same identity
      // guard as cleanupSession: a STALE end (a superseded session's late close
      // callback firing after the user tab-clicked into another session) must
      // not clobber the mode that tab click just set for the CURRENT session.
      if (appState.session === localSession || !appState.session) {
        pendingViewMode = "ssh";
      }
      // A local shell is as re-openable as a connect is — more so, since there
      // is nothing to re-authenticate — so it gets the same reconnect bar.
      const offerReconnect = Boolean(
        reconnect && (mode === "local" || (mode === "connect" && connectArgs)),
      );
      if (!offerReconnect) {
        // A second, non-retryable end (e.g. the subscription's error callback
        // firing after a close) downgrades an earlier reconnect offer: the bar
        // must go, or its countdown lies about the now-3s return window.
        chrome.removeEndOptions();
        term.writeln(`\x1b[33m${hint || "Returning to login in 3s..."}\x1b[0m`);
        scheduleReturnToLogin(localSession, AUTH_FAIL_RETURN_MS);
        return;
      }
      term.writeln(
        `\x1b[33mReconnect (OK/Enter), or back to login in ${RECONNECT_RETURN_MS / 1000}s...\x1b[0m`,
      );
      scheduleReturnToLogin(localSession, RECONNECT_RETURN_MS);
      // Resume-from-background must land focus on the bar, not the dead
      // terminal: the router's resync path calls session.focus() on resume,
      // and the terminal's input wiring is already torn down at this point.
      localSession.focus = () => chrome.focusEndOptions();
      chrome.showEndOptions({
        autoLoginMs: RECONNECT_RETURN_MS,
        onReconnect: () => {
          clearReturnTimer();
          if (mode === "local") {
            debugEvent("ui_reconnect", { local: true });
            startLocalSession();
            return;
          }
          debugEvent("ui_reconnect", {
            host: connectArgs.host,
            port: connectArgs.port,
            user: connectArgs.user,
          });
          startSession(connectArgs);
        },
        onLogin: () => {
          clearReturnTimer();
          returnToLoginNow(localSession);
        },
      });
    };
  }

  // Everything that moves bytes between xterm and the service for one session:
  // write/resize sends, the NO_SESSION watchdog, and input enablement.
  function createIoBridge(localSession, terminal, frame, endSession) {
    const { term } = terminal;
    let dataHandler = null;
    let resizeTimer = null;
    let inputEnabled = false;

    // Writes and resizes are fire-and-forget by design (one Luna round-trip per
    // keystroke must not build a promise chain), but the reply still has to be
    // inspected for NO_SESSION: that is the only signal the client gets when the
    // service was restarted underneath it — the subscription never delivers a
    // close event, because the process that would have sent it is gone. Without
    // this the terminal keeps blinking and swallows every keystroke forever.
    function sendToSession(method, parameters) {
      serviceSend(method, parameters, handleSessionReply);
    }

    function handleSessionReply(resp) {
      if (!resp || resp.returnValue !== false) return;
      if (resp.errorCode !== "NO_SESSION") return; // NOT_READY is transient
      if (appState.session !== localSession || localSession.closed) return;
      debugEvent("ui_session_lost", {
        sessionId: localSession.id || null,
        errorCode: resp.errorCode,
      });
      term.writeln("\r\n\x1b[31m[session lost — the background service restarted]\x1b[0m");
      endSession({ reconnect: true });
    }

    // True only when the frame has a real layout. A backgrounded WebView is
    // laid out at 0x0, and FitAddon then clamps the grid to its 2x1 floor —
    // pushing that to the pty makes the remote reflow every pane to two columns
    // and mangles the scrollback permanently. The resume path re-fits via the
    // ResizeObserver, so skipping a measurement here loses nothing.
    function frameHasLayout() {
      return frame.clientWidth > 0 && frame.clientHeight > 0;
    }

    function measuredSize() {
      return frameHasLayout() ? terminal.fitToContainer() : null;
    }

    function sendResize(size) {
      if (!localSession.id || !size || !size.cols || !size.rows) return;
      sendToSession("resize", {
        sessionId: localSession.id,
        cols: size.cols,
        rows: size.rows,
      });
    }

    function sendMeasuredSize() {
      sendResize(measuredSize());
    }

    function queueResize(size) {
      if (!localSession.id) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        sendResize(size);
      }, 120);
    }

    // The hold is renderer-dependent (see TYPE_HOLD_WEBGL_MS) and asked per
    // keystroke, because WebGL can be lost at any moment.
    function typeHold() {
      return typeof localSession.inkMode === "function" &&
        localSession.inkMode() === "webgl"
        ? TYPE_HOLD_WEBGL_MS
        : TYPE_HOLD_MS;
    }

    function enableInput(sessionIdForInput) {
      if (!sessionIdForInput) return;
      localSession.id = sessionIdForInput;
      if (inputEnabled) return;
      inputEnabled = true;
      terminal.setControlDataHandler((data) => {
        deferSolves(typeHold());
        sendToSession("write", { sessionId: sessionIdForInput, data });
      });
      dataHandler = term.onData((data) => {
        // Typing outranks the Chameleon map: on the CSS path its raster is the
        // most expensive frame this app can produce (see theme-controller),
        // and sharing a frame with the keystroke's echo is what made typing
        // feel sluggish.
        deferSolves(typeHold());
        sendToSession("write", { sessionId: sessionIdForInput, data });
      });
      sendMeasuredSize();
    }

    // Chrome-originated input (key bar). Returns whether the session was ready
    // to take it, so the chrome can decide about the focus restore.
    function sendData(data) {
      if (!localSession.id || !inputEnabled) return false;
      sendToSession("write", { sessionId: localSession.id, data });
      return true;
    }

    function dispose() {
      if (resizeTimer) clearTimeout(resizeTimer);
      terminal.setControlDataHandler(null);
      terminal.setResizeHandler(null);
      if (dataHandler && typeof dataHandler.dispose === "function") {
        dataHandler.dispose();
      }
    }

    return { measuredSize, sendResize, sendMeasuredSize, queueResize, enableInput, sendData, dispose };
  }

  // The subscription callback for connect/attach — one branch per service
  // event, plus the trailing error branch.
  function createServiceEventHandler({ localSession, isAttach, mode, connectArgs, io, endSession, onSessionsChanged }) {
    const term = localSession.term;
    let replayed = false;

    return (response) => {
      if (response.event !== "data") {
        debugEvent("ui_service_event", {
          mode,
          event: response.event || null,
          sessionId: response.sessionId || localSession.id || null,
          stage: response.stage || null,
          errorCode: response.errorCode || null,
          errorText: response.errorText || null,
          returnValue: response.returnValue,
          bytes: typeof response.data === "string" ? response.data.length : null,
        });
      }
      if (response.sessionId && !localSession.id) {
        localSession.id = response.sessionId;
      }
      switch (response.event) {
        case "attached":
          localSession.id = response.session && response.session.id;
          // The attach path has no open mode to infer the kind from — this is
          // the only place it is knowable before the first sessions/list comes
          // back, and setViewMode consults it (see localIsLocal).
          if (response.session && response.session.kind) {
            localSession.kind = response.session.kind;
          }
          return;
        case "ready":
          io.enableInput(response.sessionId || localSession.id);
          if (isAttach) {
            if (!replayed) term.writeln("\x1b[32m[attached]\x1b[0m");
          } else {
            term.writeln("\x1b[32m[connected]\x1b[0m");
          }
          // The session id is final here — the tab strip can mark it active
          // (and a fresh connect's tab appears in the list at all).
          onSessionsChanged();
          return;
        case "status": {
          const stage = response.stage || "working";
          if (!isAttach || stage !== "ready") {
            term.writeln(`\x1b[36m[${stage}]\x1b[0m`);
          }
          return;
        }
        case "replay":
          if (typeof response.data === "string") {
            replayed = true;
            term.write(response.data);
          }
          return;
        case "data":
          if (typeof response.data === "string") term.write(response.data);
          return;
        case "close":
          term.writeln(
            `\x1b[31m[connection closed${response.reason ? ": " + response.reason : ""}]\x1b[0m`,
          );
          endSession({ reconnect: true });
          // Drop the dead session's tab; the remaining tabs stay clickable
          // from the end-options state, which is a faster path to another
          // live session than the reconnect bar.
          onSessionsChanged();
          return;
        default:
          break;
      }
      if (response.errorText || response.errorCode) {
        const isAuth =
          response.authFailed === true ||
          response.errorCode === "AUTH_FAIL" ||
          /all configured authentication methods failed/i.test(
            response.errorText || "",
          );
        // A pinned host key that no longer matches is a hard stop by design,
        // but the user needs a way out when the change was legitimate (server
        // reinstalled). Hand the details to the connect form, which offers to
        // forget the pin — otherwise the only recovery is a root shell, i.e.
        // another SSH client, which is what this app is for.
        if (response.errorCode === "HOST_KEY_MISMATCH" && !isAttach && connectArgs) {
          onHostKeyIssue({
            host: connectArgs.host,
            port: connectArgs.port,
            detail: response.errorText || "",
          });
        }
        term.writeln(
          `\x1b[31m[error] ${response.errorText || response.errorCode}\x1b[0m`,
        );
        // No reconnect for failures a retry cannot fix: wrong credentials, or
        // a host-key mismatch (the recovery for that lives on the login form).
        endSession({
          reconnect: !isAuth && response.errorCode !== "HOST_KEY_MISMATCH",
          hint: isAuth ? "Authentication failed. Returning to login in 3s..." : null,
        });
      }
    };
  }

  async function openTerminalSession({ mode, connectArgs, sessionId }) {
    const isAttach = mode === "attach";
    const isLocal = mode === "local";
    const serviceMethod = isAttach
      ? "attach"
      : isLocal
        ? "local/connect"
        : "connect";
    const openedAt = Date.now();
    const token = ++terminalOpenToken;

    // Opening a session supersedes any pending return-to-login from a previous
    // one. attachNewestOrShowForm deliberately no longer clears the timer, so
    // this is the mounting path that has to.
    clearReturnTimer();
    closeDebugPanel();
    disposeVisibleSession("open terminal session");
    root.innerHTML = "";
    appState.activeView = "session";
    document.body.classList.add("in-session");

    const chrome = createTerminalWindow({
      root,
      debugEnabled: isDebugEnabled(),
      onHide: () => hideOverlay("terminal button"),
      onDisconnect: disconnectCurrent,
      onDebug: showDebugPanel,
    });
    const { wrapper, frame } = chrome;

    const fontStartedAt = Date.now();
    const fontResult = await preloadTerminalFont({ timeoutMs: 1200 });
    debugEvent("ui_terminal_font_ready", {
      mode,
      durationMs: Date.now() - fontStartedAt,
      result: fontResult,
    });
    // Cancel only when something else has taken over the view: a newer open
    // (token bumped) or a different view mounted (activeView moved off
    // "session" — which is what Hide/Back/Disconnect do). Deliberately NOT
    // gated on `overlayVisible`: that flag is also cleared by a plain
    // background transition, and bailing out there left the session
    // half-built — chrome on screen reading "Loading terminal...", no
    // subscription, and no path back because every re-entry is blocked while
    // activeView is still "session". Both values are read fresh from appState
    // AFTER the await — never captured before it.
    if (token !== terminalOpenToken || appState.activeView !== "session") {
      debugEvent("ui_terminal_open_cancelled", {
        mode,
        tokenChanged: token !== terminalOpenToken,
        overlayVisible: appState.overlayVisible,
        activeView: appState.activeView,
      });
      chrome.destroy();
      return;
    }
    frame.textContent = "";

    const terminal = initTerminal(frame, {
      fontSize: chrome.persistedFontSize,
      theme: currentTheme().shell,
      onOpenLink: openUrlInBrowser,
      onDebugEvent: debugEvent,
    });
    const localSession = buildSessionHandle(terminal, wrapper);
    appState.session = localSession;
    debugEvent("ui_terminal_mounted", {
      mode,
      durationMs: Date.now() - openedAt,
    });
    updateBackdropWatch();

    if (isAttach) {
      localSession.id = sessionId || null;
    } else if (isLocal) {
      localSession.kind = "local";
      localSession.term.writeln(
        "\x1b[33mOpening a shell on this TV...\x1b[0m",
      );
    } else {
      localSession.term.writeln(
        `\x1b[33mConnecting to ${connectArgs.user}@${connectArgs.host}:${connectArgs.port}...\x1b[0m`,
      );
    }

    const endSession = makeSessionEnder({ localSession, chrome, mode, connectArgs });
    const io = createIoBridge(localSession, terminal, frame, endSession);
    terminal.setResizeHandler(io.queueResize);

    // Which of this session's two views is on screen, and the explorer instance
    // if one has been built. The explorer is created LAZILY and then kept: most
    // sessions never open one, and a user who is moving files will switch back
    // and forth repeatedly, so paying the two listings once is right on both
    // counts.
    let viewMode = "ssh";
    let explorer = null;

    // Is THIS session local? Not the same question as "was this view opened in
    // local mode": the same session can be re-entered through the ATTACH path
    // (from the connect form's session list, from another tab, or from
    // attachNewestOrShowForm on relaunch), and there `mode` is "attach" for a
    // local shell just as it is for an SSH one. Deriving it from the open mode
    // alone let a stale pendingViewMode="scp" push an attached local shell into
    // the file explorer, where every listing fails with NO_SFTP and the phantom
    // files tab is redrawn on every refresh.
    function localIsLocal() {
      return isLocal || localSession.kind === "local";
    }

    function setViewMode(next) {
      // A local session has no SFTP channel to browse over, so "scp" is not a
      // reachable state for one — collapse it to the shell rather than mounting
      // an explorer that would report NO_SFTP on its first listing.
      const want = next === "scp" && !localIsLocal() ? "scp" : "ssh";
      // Guard on identity, not just on equality: a stale timer or a click that
      // lands after the view was replaced must not re-show a dead pane.
      if (appState.session !== localSession) return;
      if (want === "scp" && !explorer) {
        explorer = mountFileExplorer(chrome.filesHost, {
          sessionId: localSession.id,
          hostLabel: localSession.host || (connectArgs && connectArgs.host) || "host",
          onSwitchToTerminal: () => setViewMode("ssh"),
        });
      }
      viewMode = want;
      chrome.showFiles(want === "scp");
      if (want === "scp") {
        if (explorer) explorer.focus();
      } else {
        // Coming back to the terminal: the frame was `hidden`, so xterm's
        // measurements are stale in exactly the way that silently drops mouse
        // reports (0.5.1). Re-measure before handing focus back.
        terminal.resyncViewport();
        io.sendMeasuredSize();
        terminal.focus();
      }
      refreshTabs();
    }

    // Tab strip data. The service owns the session list, so re-query it on
    // lifecycle changes plus a slow poll — a session that dies while DETACHED
    // never signals this client, and its tab has to disappear eventually.
    //
    // A tab is a (session, mode) pair. The service knows nothing about modes:
    // an explorer is a second CHANNEL on a session it already has, so which
    // sessions currently show a files tab is purely client state (openFiles
    // below). Deriving the strip from the service list on every refresh means a
    // session that dies takes BOTH of its tabs with it without any extra
    // bookkeeping — the files tab cannot outlive the connection it rides on.
    let tabsTimer = null;
    function tabsFor(sessions) {
      const tabs = [];
      for (const s of sessions) {
        // `kind` rides along so the strip can label a local shell as "local"
        // instead of the placeholder root@localhost:0 the service fills in, and
        // so it can leave off the files swap it cannot honour (session-label.mjs).
        const identity = { host: s.host, user: s.user, port: s.port, kind: s.kind };
        tabs.push({ key: `${s.id}:ssh`, sessionId: s.id, mode: "ssh", ...identity });
        if (openFiles.has(s.id)) {
          tabs.push({ key: `${s.id}:scp`, sessionId: s.id, mode: "scp", ...identity });
        }
      }
      return tabs;
    }
    async function refreshTabs() {
      let sessions;
      try {
        sessions = await listSessions();
      } catch (e) {
        return; // desktop layout runs have no service
      }
      // Identity guard: a newer view owns the chrome now.
      if (appState.session !== localSession) return;
      sessions.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      // Drop explorer state for sessions the service no longer has, or the set
      // would grow for the life of the app and re-open a files tab if an id
      // were ever reused.
      const live = new Set(sessions.map((s) => s.id));
      for (const id of Array.from(openFiles)) if (!live.has(id)) openFiles.delete(id);
      sessionsById.clear();
      for (const s of sessions) sessionsById.set(s.id, s);
      // The service is the only place that knows the host of an ATTACHED
      // session — there are no connectArgs on that path — and the explorer
      // wants it for its pane heading. Without this the right-hand pane is
      // labelled "host", which is exactly as useful as leaving it blank.
      const mine = sessions.find((s) => s.id === localSession.id);
      if (mine && mine.host) localSession.host = mine.host;
      // Same reason as the host, and the backstop for the kind: an attach whose
      // "attached" event predates this field still learns it here.
      if (mine && mine.kind) localSession.kind = mine.kind;
      chrome.setTabs(tabsFor(sessions), `${localSession.id}:${viewMode}`);
    }

    chrome.bindTerminal(terminal, {
      onSizeChanged: io.sendMeasuredSize,
      onSendData: io.sendData,
      sessionId: () => localSession.id || null,
      onSelectTab: (key) => {
        if (!key) return;
        const [id, mode] = splitTabKey(key);
        debugEvent("ui_tab_select", { from: `${localSession.id}:${viewMode}`, to: key });
        // Same session, other view: no reconnect, no re-attach, just swap which
        // of the two mounted panes is showing. This is the whole point of
        // hanging the explorer off the session's existing transport.
        if (id === localSession.id) {
          setViewMode(mode);
          return;
        }
        // A different session. Remember which view the user asked for so the
        // attach lands on the files tab when that is the tab they clicked.
        pendingViewMode = mode;
        attachSession(id);
      },
      onNewTab: openNewTab,
      onOpenFiles: (id) => {
        if (!id) return;
        // Belt and braces: the strip does not draw a files control for a local
        // session, but a stale tab from before it closed could still call this,
        // and the service would only answer NO_SFTP.
        if (!canBrowseFiles(sessionsById.get(id))) {
          debugEvent("ui_files_refused_local", { sessionId: id });
          return;
        }
        openFiles.add(id);
        debugEvent("ui_files_open", { sessionId: id });
        if (id === localSession.id) setViewMode("scp");
        else {
          pendingViewMode = "scp";
          attachSession(id);
        }
        refreshTabs();
      },
      onOpenTerminal: (id) => {
        if (!id) return;
        if (id === localSession.id) setViewMode("ssh");
        else {
          pendingViewMode = "ssh";
          attachSession(id);
        }
      },
      // Chrome close semantics: × on a background tab just disconnects that
      // session; × on the active tab disconnects it and switches to the
      // right-hand neighbor (left-hand when it was the last), or falls back
      // to the connect form when it was the only tab. No confirm — same as
      // Chrome, and the remote host's tmux survives a dropped SSH session.
      onCloseTab: async (key) => {
        if (!key) return;
        const [id, mode] = splitTabKey(key);
        debugEvent("ui_tab_close", { key, active: id === localSession.id });
        // Closing a FILES tab closes the view, never the connection. The shell
        // tab beside it is the same login, and dropping it because the user was
        // done looking at a directory would be a genuinely destructive
        // surprise — that is what the shell tab's own × is for.
        if (mode === "scp") {
          openFiles.delete(id);
          if (id === localSession.id && viewMode === "scp") setViewMode("ssh");
          refreshTabs();
          return;
        }
        if (id !== localSession.id) {
          serviceSend("disconnect", { sessionId: id });
          openFiles.delete(id);
          setTimeout(refreshTabs, 300);
          return;
        }
        openFiles.delete(id);
        let neighborId = null;
        try {
          const sessions = (await listSessions()).sort(
            (a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0),
          );
          const idx = sessions.findIndex((s) => s.id === id);
          const neighbor = sessions[idx + 1] || sessions[idx - 1] || null;
          if (neighbor && neighbor.id !== id) neighborId = neighbor.id;
        } catch (e) {
          /* service unavailable — plain disconnect below still works */
        }
        if (appState.session !== localSession) return; // superseded meanwhile
        disconnectCurrent();
        if (neighborId) attachSession(neighborId);
      },
    });
    terminal.setNewTabRequestHandler(openNewTab);
    refreshTabs();
    tabsTimer = setInterval(refreshTabs, 15000);

    // Fall back to a conventional 80x24 rather than measuring a collapsed
    // frame: the app may have been backgrounded during the font preload, and
    // the pty would then be created two columns wide.
    const initialSize = io.measuredSize() || { cols: 80, rows: 24 };
    const servicePayload = isAttach
      ? { sessionId }
      : {
          // No connect args on the local path: `...undefined` is a no-op spread,
          // so the size below is the whole payload there.
          ...(connectArgs || {}),
          cols: initialSize.cols,
          rows: initialSize.rows,
        };
    let cleaned = false;

    localSession.cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (tabsTimer) {
        clearInterval(tabsTimer);
        tabsTimer = null;
      }
      // Before chrome.destroy(), which takes the wrapper (and the explorer's
      // host element with it) out of the document — dispose has to run while
      // its own listeners are still reachable.
      if (explorer) {
        explorer.dispose();
        explorer = null;
      }
      chrome.destroy();
      io.dispose();
      localSession.id = null;
    };

    const sub = subscribeSession(
      serviceMethod,
      servicePayload,
      createServiceEventHandler({
        localSession,
        isAttach,
        mode,
        connectArgs,
        io,
        endSession,
        // "ready" is the first moment the session id is final, which is exactly
        // what the explorer needs to name a session to the service. So the
        // pending view is applied HERE rather than at mount: a connect started
        // from the login page's scp option has no id yet when its window is
        // built, and an explorer created a moment too early would ask the
        // service about `undefined`.
        onSessionsChanged: () => {
          refreshTabs();
          if (pendingViewMode === "scp" && localSession.id) {
            pendingViewMode = "ssh";
            // Guard the CONSUMPTION, not just the display: openFiles is
            // controller-level state that outlives this view, so an id added
            // here would keep re-creating a dead files tab on every later
            // refresh and every later attach of the same session.
            if (!localIsLocal()) {
              openFiles.add(localSession.id);
              setViewMode("scp");
            }
          }
        },
      }),
      (err) => {
        debugEvent("ui_service_subscribe_error", {
          mode,
          sessionId: localSession.id || null,
          error: compactError(err),
        });
        localSession.term.writeln(`\x1b[31m[bridge error] ${JSON.stringify(err)}\x1b[0m`);
        // No reconnect offer here: a broken Luna bridge won't be fixed by
        // opening another subscription over it.
        endSession({});
      },
    );
    localSession.sub = sub;
    localSession.dispose = () => {
      debugEvent("ui_terminal_dispose", {
        mode,
        sessionId: localSession.id || null,
      });
      localSession.cleanup();
      if (sub && typeof sub.cancel === "function") sub.cancel();
      terminal.dispose();
    };
  }

  return {
    openTerminalSession,
    startSession,
    startLocalSession,
    attachSession,
    disconnectCurrent,
    scheduleReturnToLogin,
  };
}
