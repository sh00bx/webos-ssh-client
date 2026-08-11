// The one shared mutable UI state. Everything that used to be a module-level
// `let` in main.js and is read or written by more than one module lives here.
// This module imports nothing and touches no DOM — keep it that way.
//
// session handle contract (created in session-controller.js):
//   { id, term, sub, dispose(), cleanup(), closed?, resyncViewport(),
//     setTheme(palette), focus(), setAccent(color|null) }
// theme-controller.js and view-router.js duck-type against this — do not
// change a member name without updating both.
//
// IMPORTANT: always read appState.* at call time, never capture the value in
// a long-lived local. The identity guards (`appState.session !== localSession`)
// and the post-await checks in the session controller depend on fresh reads —
// a captured copy freezes at its capture time and inverts those guards.
export const appState = {
  session: null, // active session handle, or null
  activeView: "startup", // "startup" | "connect" | "keys" | "session" | "hidden"
  overlayVisible: true,
  returnTimer: null, // pending return-to-login timeout id
};

export function clearReturnTimer() {
  if (appState.returnTimer) {
    clearTimeout(appState.returnTimer);
    appState.returnTimer = null;
  }
}
