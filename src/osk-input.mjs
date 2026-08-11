// On-screen-keyboard input: the pure half.
//
// WHY THIS EXISTS. The app's normal input path deliberately keeps DOM focus on
// a NON-editable element (`.input-sink` in terminal.js), because a focused
// editable element is the single trigger for the webOS system OSK and none of
// `inputmode="none"`, `virtualkeyboardpolicy="manual"` or Chromium's
// VirtualKeyboard API suppress it — all three were tested live and are no-ops.
// That is the right default with a USB keyboard, and it is a dead end without
// one: with only a Magic Remote there is then no way to type at all.
//
// So the OSK mode does the exact opposite on purpose: it focuses a REAL
// textarea, lets webOS raise its keyboard, and never looks at keypress for
// text. Instead it DIFFS the textarea's value — which is the technique
// gprot42/webos-terminal uses, and the reason it works where key interception
// does not: what the system OSK produces is IME output (composed characters,
// dead keys, predictive text), and IME output arrives as a value change, not
// as a key event with a usable `key`.
//
// The DOM side of this lives in terminal.js; everything here is pure so the
// diff can be tested without a webOS device (tests/osk-input.test.mjs).

// The Magic Remote's OSK sends its confirm key as this keyCode and does NOT
// put a newline into the field — so a value diff alone would swallow "Enter"
// entirely, which reads as "the on-screen keyboard does not work". Measured
// value, documented by gprot42/webos-terminal and matching webOS's
// VK_RETURN-family remapping.
export const REMOTE_OSK_ENTER_KEYCODE = 16777221;

export function isOskEnterEvent(event) {
  if (!event) return false;
  if (event.key === "Enter") return true;
  const code = event.keyCode || event.which || 0;
  return code === 13 || code === REMOTE_OSK_ENTER_KEYCODE;
}

// Split into code points, not UTF-16 units: a diff that cuts between a
// surrogate pair would send half a character to the shell, and one press of
// the OSK's backspace on an emoji has to become ONE delete, not two.
function codePoints(text) {
  return Array.from(typeof text === "string" ? text : "");
}

// What to send to the shell so that it ends up in the state the textarea is
// in. Deletions become DEL (0x7f) — which is what the terminal's Backspace
// sends everywhere else in this app (see keymap.mjs) — and insertions become
// the inserted text itself.
//
// The comparison is prefix-only, deliberately. The proxy field has a caret the
// shell knows nothing about, so an edit in the MIDDLE of the buffer is
// reproduced as "delete back to the edit, retype the rest": more keystrokes
// than the user made, but the same end state, and the alternative would be
// modelling the remote line editor's caret, which is not knowable. In the
// common case (type at the end, backspace at the end) it is exactly one
// character in and one out.
export function proxyInputDelta(previous, next) {
  const before = codePoints(previous);
  const after = codePoints(next);
  let shared = 0;
  while (
    shared < before.length &&
    shared < after.length &&
    before[shared] === after[shared]
  ) {
    shared++;
  }
  const removed = before.length - shared;
  const added = after.slice(shared).join("");
  if (!removed && !added) return "";
  return "\x7f".repeat(removed) + added;
}

// Is the webOS system keyboard on screen? Property first (the value this app
// has always used), with the Enact-style event below as the push notification
// that it changed. Returns null when the platform exposes neither, so callers
// can tell "no" apart from "cannot know" — the fit guard treats the unknown
// case as "not visible", since suppressing every resize on a desktop dev build
// would be worse than an occasional badly timed fit on a TV.
export function systemKeyboardVisible(win) {
  const scope = win || (typeof window !== "undefined" ? window : null);
  if (!scope) return null;
  const system =
    (typeof scope.webOSSystem !== "undefined" && scope.webOSSystem) ||
    (typeof scope.PalmSystem !== "undefined" && scope.PalmSystem) ||
    null;
  if (!system) return null;
  const value = system.isKeyboardVisible;
  if (typeof value === "boolean") return value;
  if (typeof value === "function") {
    try {
      return Boolean(value.call(system));
    } catch (e) {
      return null;
    }
  }
  return null;
}

// webOS fires this on `document` when the system keyboard opens or closes;
// @enact/webos/keyboard's isShowing() is a read of the same state. Having the
// EVENT rather than only the property is what makes the "never fit while the
// keyboard is up" rule enforceable without polling.
export const KEYBOARD_STATE_EVENT = "keyboardStateChange";

// The event's payload is not consistent across firmware versions — some carry
// `detail.visibility`, some `detail.state`, some nothing at all. Fall back to
// the property, which is always readable.
export function keyboardVisibleFromEvent(event, win) {
  const detail = event && event.detail;
  if (detail && typeof detail.visibility === "boolean") return detail.visibility;
  if (detail && typeof detail.state === "string") {
    return detail.state === "visible" || detail.state === "show";
  }
  const probed = systemKeyboardVisible(win);
  return probed === null ? false : probed;
}
