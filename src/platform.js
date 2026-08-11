// webOS platform glue: activating/closing our own overlay window and handing
// URLs to the system browser. The applicationManager URI is firmware-dependent,
// so every operation probes the known variants in turn.
import { lunaCall } from "./luna.js";
import { appState } from "./app-state.js";
import { debugEvent } from "./debug.js";

const APP_MANAGER_URIS = [
  "luna://com.webos.service.applicationManager",
  "luna://com.webos.service.applicationmanager",
  "luna://com.webos.applicationManager",
];
const APP_ID = "com.pwntastic.sshclient";
// System web browser bundled on webOS; launching it with `params.target`
// opens the given URL. Used to make terminal hyperlinks clickable.
const BROWSER_APP_ID = "com.webos.app.browser";

export function activateApp() {
  const system =
    (typeof webOSSystem !== "undefined" && webOSSystem) ||
    (typeof PalmSystem !== "undefined" && PalmSystem) ||
    null;
  if (system && typeof system.activate === "function") {
    try {
      system.activate();
    } catch (e) {
      /* ignored: desktop/browser fallback */
    }
  }
}

// Close the overlay window via the applicationManager. `onCloseFailed` is
// invoked when the window is detectably still visible afterwards — the view
// layer uses it to paint the "overlay close failed" recovery screen.
export function closeAppWindow({ onCloseFailed } = {}) {
  const attempts = [];
  APP_MANAGER_URIS.forEach((uri) => {
    attempts.push({ uri, method: "closeByAppId" });
    attempts.push({ uri, method: "close" });
  });

  function restoreIfStillOpen() {
    setTimeout(() => {
      if (!document.hidden && !appState.overlayVisible) {
        debugEvent("ui_hide_failed_window_still_visible", {});
        if (onCloseFailed) onCloseFailed();
      }
    }, 700);
  }

  function tryNext() {
    const attempt = attempts.shift();
    if (!attempt) {
      restoreIfStillOpen();
      return;
    }
    debugEvent("ui_close_fallback_attempt", attempt);
    lunaCall(
      attempt.uri,
      attempt.method,
      { id: APP_ID },
      (resp) => {
        debugEvent("ui_close_fallback_response", {
          uri: attempt.uri,
          method: attempt.method,
          returnValue: resp && resp.returnValue,
          errorCode: resp && resp.errorCode,
          errorText: resp && resp.errorText,
        });
        if (resp && resp.returnValue === false) {
          tryNext();
          return;
        }
        restoreIfStillOpen();
      },
      tryNext,
    );
  }

  tryNext();
}

// Launching the browser hands it the foreground, which yanks the user out of a
// session they were in the middle of. webOS has no "launch without focusing"
// flag, so the browser is started and this app immediately re-raises itself:
// it is an overlay window, so it can sit above the browser while that keeps
// loading behind it. The delay lets the launch be accepted first — re-raising
// too early and the compositor just hands the foreground straight back.
//
// Tunable: if the browser ends up on top anyway, raise this; if the browser
// flashes into view before we return, lower it.
const FOREGROUND_RECLAIM_MS = 700;

function reclaimForeground() {
  setTimeout(() => {
    debugEvent("ui_open_link_reclaim_foreground", {});
    activateApp();
  }, FOREGROUND_RECLAIM_MS);
}

// Open a URL clicked in the terminal in the webOS system browser. Only
// http(s) is allowed so a crafted escape sequence can't launch arbitrary app
// schemes. On a desktop dev build (no Luna bridge) every attempt fails fast
// and we fall back to window.open().
export function openUrlInBrowser(url) {
  const target = typeof url === "string" ? url.trim() : "";
  if (!/^https?:\/\//i.test(target)) return;
  debugEvent("ui_open_link", { url: target });
  const uris = APP_MANAGER_URIS.slice();

  function tryNext() {
    const uri = uris.shift();
    if (!uri) {
      debugEvent("ui_open_link_fallback", { url: target });
      try {
        window.open(target, "_blank");
      } catch (e) {
        /* no window.open in this environment — nothing more we can do */
      }
      return;
    }
    lunaCall(
      uri,
      "launch",
      { id: BROWSER_APP_ID, params: { target } },
      (resp) => {
        if (resp && resp.returnValue === false) {
          tryNext();
          return;
        }
        debugEvent("ui_open_link_ok", { uri });
        reclaimForeground();
      },
      tryNext,
    );
  }

  tryNext();
}
