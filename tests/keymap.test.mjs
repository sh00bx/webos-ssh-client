import assert from "node:assert";
import {
  keyboardLayoutLabel,
  nextKeyboardLayout,
  resolveKeyboardLayout,
} from "../src/keyboard-layout.mjs";
import {
  capsLockStateFromEvent,
  controlDataFromCharacter,
  controlDataFromKeyEvent,
  inputEventDecision,
  isAltGraphEvent,
  isControlKeyEvent,
  isCtrlAltKey,
  isRemoteBackKey,
  printableDataFromKeyEvent,
  terminalDataFromKeyEvent,
} from "../src/keymap.mjs";

function keyEvent(key, extra = {}) {
  return {
    key,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    ...extra,
  };
}

assert.strictEqual(controlDataFromKeyEvent(keyEvent("c")).charCodeAt(0), 3);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("C")).charCodeAt(0), 3);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("z")).charCodeAt(0), 26);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("[")).charCodeAt(0), 27);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("\\")).charCodeAt(0), 28);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("]")).charCodeAt(0), 29);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("?")).charCodeAt(0), 127);
assert.strictEqual(
  controlDataFromKeyEvent(
    keyEvent("c", {
      ctrlKey: false,
      getModifierState(name) {
        return name === "Control";
      },
    }),
  ).charCodeAt(0),
  3,
);
assert.strictEqual(
  controlDataFromKeyEvent(keyEvent("c", { ctrlKey: false }), { forceCtrl: true }).charCodeAt(0),
  3,
);
assert.strictEqual(
  controlDataFromKeyEvent(keyEvent("Unidentified", { keyCode: 67 })).charCodeAt(0),
  3,
);
assert.strictEqual(
  controlDataFromKeyEvent(keyEvent("Unidentified", { keyIdentifier: "U+0043" })).charCodeAt(0),
  3,
);
assert.strictEqual(
  controlDataFromKeyEvent(keyEvent(undefined, { charCode: 99 })).charCodeAt(0),
  3,
);
assert.strictEqual(controlDataFromCharacter("c").charCodeAt(0), 3);
assert.strictEqual(isControlKeyEvent({ key: "Control" }), true);
assert.strictEqual(isControlKeyEvent({ keyCode: 17 }), true);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("c", { altKey: true })), null);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("c", { ctrlKey: false })), null);

assert.strictEqual(terminalDataFromKeyEvent(keyEvent("c", { ctrlKey: false })), "c");
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("C", { ctrlKey: false, shiftKey: true })), "C");
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("Enter", { ctrlKey: false })), "\r");
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("Backspace", { ctrlKey: false })).charCodeAt(0), 127);
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("ArrowUp", { ctrlKey: false })), "\x1b[A");
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("Unidentified", { ctrlKey: false, keyCode: 67 })), "c");
assert.strictEqual(
  terminalDataFromKeyEvent(keyEvent("Unidentified", { ctrlKey: false, keyCode: 67, shiftKey: true })),
  "C",
);
assert.strictEqual(
  terminalDataFromKeyEvent(keyEvent("Unidentified", { ctrlKey: false, keyCode: 13 })),
  "\r",
);
assert.strictEqual(terminalDataFromKeyEvent(keyEvent("q", { altKey: true })), null);

assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 89 }),
    { keyboardLayout: "us" },
  ),
  "y",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 89 }),
    { keyboardLayout: "de" },
  ),
  "z",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("y", { ctrlKey: false, code: "KeyY", keyCode: 89 }),
    { keyboardLayout: "de" },
  ),
  "z",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Y", { ctrlKey: false, code: "KeyY", keyCode: 89 }),
    { keyboardLayout: "de" },
  ),
  "Z",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 90 }),
    { keyboardLayout: "us" },
  ),
  "z",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 90 }),
    { keyboardLayout: "de" },
  ),
  "y",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("z", { ctrlKey: false, code: "KeyZ", keyCode: 90 }),
    { keyboardLayout: "de" },
  ),
  "y",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 89 }),
    { keyboardLayout: "us" },
  ),
  "y",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 50, shiftKey: true }),
    { keyboardLayout: "us" },
  ),
  "@",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 50, shiftKey: true }),
    { keyboardLayout: "de" },
  ),
  "\"",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("@", { ctrlKey: false, code: "Digit2", keyCode: 50, shiftKey: true }),
    { keyboardLayout: "de" },
  ),
  "\"",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, keyCode: 51, shiftKey: true }),
    { keyboardLayout: "de" },
  ),
  "§",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("[", { ctrlKey: false, code: "BracketLeft", keyCode: 219 }),
    { keyboardLayout: "de" },
  ),
  "ü",
);
assert.strictEqual(
  controlDataFromKeyEvent(
    keyEvent("y", { code: "KeyY", keyCode: 89 }),
    { keyboardLayout: "de" },
  ).charCodeAt(0),
  26,
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("@", {
      ctrlKey: true,
      altKey: true,
      getModifierState(name) {
        return name === "AltGraph";
      },
    }),
  ),
  "@",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("q", { ctrlKey: true, altKey: true, keyCode: 81 }),
    { keyboardLayout: "de" },
  ),
  "@",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("q", { ctrlKey: false, altKey: true, code: "KeyQ" }),
    { keyboardLayout: "de" },
  ),
  "@",
);
assert.strictEqual(
  printableDataFromKeyEvent(
    keyEvent("q", { ctrlKey: false, altKey: true, keyCode: 81 }),
    { keyboardLayout: "de" },
  ),
  "@",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, altKey: true, keyCode: 55 }),
    { keyboardLayout: "de" },
  ),
  "{",
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    keyEvent("Unidentified", { ctrlKey: false, altKey: true, keyCode: 226 }),
    { keyboardLayout: "de" },
  ),
  "|",
);
assert.strictEqual(
  isAltGraphEvent(
    keyEvent("q", { ctrlKey: false, altKey: true, keyCode: 81 }),
    { keyboardLayout: "de" },
  ),
  true,
);
assert.strictEqual(controlDataFromKeyEvent(keyEvent("@", { altKey: true })), null);
assert.strictEqual(resolveKeyboardLayout("auto", { languages: ["de-DE"] }), "de");
assert.strictEqual(resolveKeyboardLayout("auto", { languages: ["en-US"] }), "system");
assert.strictEqual(nextKeyboardLayout("auto"), "system");

// ---- inputEventDecision — IME fallback path ---------------------------------
assert.strictEqual(inputEventDecision(null), null);
assert.strictEqual(inputEventDecision({ type: "keydown", data: "a" }), null);
assert.strictEqual(inputEventDecision({ type: "beforeinput", data: "" }), null);
assert.strictEqual(inputEventDecision({ type: "beforeinput" }), null);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "beforeinput", data: "a" },
    { now: 1000, suppressUntil: 0, ctrlTracked: false },
  ),
  { send: "a" },
);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "input", data: "ä" },
    { now: 1000, suppressUntil: 0, ctrlTracked: false },
  ),
  { send: "ä" },
);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "beforeinput", data: "a" },
    { now: 1000, suppressUntil: 1500, ctrlTracked: false },
  ),
  { send: null },
);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "beforeinput", data: "c" },
    { now: 1000, suppressUntil: 0, ctrlTracked: true },
  ),
  { send: String.fromCharCode(3) },
);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "beforeinput", data: "abc" },
    { now: 1000, suppressUntil: 0, ctrlTracked: true },
  ),
  { send: null },
);
assert.deepStrictEqual(
  inputEventDecision(
    { type: "beforeinput", data: "hello" },
    { now: 1000, suppressUntil: 0, ctrlTracked: false },
  ),
  { send: "hello" },
);
assert.strictEqual(keyboardLayoutLabel("system"), "OS");

// Tab / Shift+Tab (back-tab, CSI Z)
assert.strictEqual(
  terminalDataFromKeyEvent({ key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }),
  "\t",
);
assert.strictEqual(
  terminalDataFromKeyEvent({ key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: true }),
  "\x1b[Z",
);

// Caps Lock detection. getModifierState is authoritative when present…
const capsModifier = (on) => ({
  key: "a",
  shiftKey: false,
  getModifierState: (name) => (name === "CapsLock" ? on : false),
});
assert.strictEqual(capsLockStateFromEvent(capsModifier(true)), true);
assert.strictEqual(capsLockStateFromEvent(capsModifier(false)), false);
// …and wins over what the character itself would suggest.
assert.strictEqual(
  capsLockStateFromEvent({
    key: "A",
    shiftKey: false,
    getModifierState: () => false,
  }),
  false,
);

// Fallback heuristic for firmwares without getModifierState: a cased letter
// whose case disagrees with Shift means the lock is engaged.
assert.strictEqual(capsLockStateFromEvent({ key: "A", shiftKey: false }), true);
assert.strictEqual(capsLockStateFromEvent({ key: "a", shiftKey: true }), true);
assert.strictEqual(capsLockStateFromEvent({ key: "a", shiftKey: false }), false);
assert.strictEqual(capsLockStateFromEvent({ key: "A", shiftKey: true }), false);
// Caseless and non-character keys carry no signal — callers keep their state.
assert.strictEqual(capsLockStateFromEvent({ key: "7", shiftKey: false }), null);
assert.strictEqual(capsLockStateFromEvent({ key: "-", shiftKey: false }), null);
assert.strictEqual(capsLockStateFromEvent({ key: "Enter", shiftKey: false }), null);
assert.strictEqual(capsLockStateFromEvent(null), null);
// A throwing getModifierState must not escape; fall through to the heuristic.
assert.strictEqual(
  capsLockStateFromEvent({
    key: "A",
    shiftKey: false,
    getModifierState() {
      throw new Error("unsupported");
    },
  }),
  true,
);

// ---------------------------------------------------------------------------
// Named navigation/editing keys: modifier encoding + DECCKM.
// These assertions pin the layout explicitly so they exercise the same branch
// regardless of the host's locale (resolveKeyboardLayout("auto") returns "de"
// on a de_DE box and "system" elsewhere).
const SYS = { keyboardLayout: "system" };
function navEvent(key, extra = {}) {
  return {
    key,
    type: "keydown",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...extra,
  };
}

// Unmodified arrows keep the CSI form...
assert.strictEqual(terminalDataFromKeyEvent(navEvent("ArrowUp"), SYS), "\x1b[A");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("ArrowLeft"), SYS), "\x1b[D");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("Home"), SYS), "\x1b[H");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("End"), SYS), "\x1b[F");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("Delete"), SYS), "\x1b[3~");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("PageUp"), SYS), "\x1b[5~");
assert.strictEqual(terminalDataFromKeyEvent(navEvent("PageDown"), SYS), "\x1b[6~");

// ...but switch to SS3 when the remote app enabled application-cursor-keys
// mode (DECCKM). fzf/ncurses look these up through terminfo and ignore CSI.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowUp"), { ...SYS, appCursor: true }),
  "\x1bOA",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("End"), { ...SYS, appCursor: true }),
  "\x1bOF",
);
// Tilde-form keys have no SS3 variant.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("PageUp"), { ...SYS, appCursor: true }),
  "\x1b[5~",
);

// Modifier encoding: 1 + shift(1) + alt(2) + ctrl(4). A modified key never
// uses the SS3 form.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowLeft", { ctrlKey: true }), SYS),
  "\x1b[1;5D",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowRight", { ctrlKey: true }), { ...SYS, appCursor: true }),
  "\x1b[1;5C",
);
// Shift ALONE must leave a nav key untouched: readline and less have no
// binding for the modified form, so encoding it would break Shift+PgUp paging
// and Shift+Up history recall, both of which worked before.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowUp", { shiftKey: true }), SYS),
  "\x1b[A",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("PageUp", { shiftKey: true }), SYS),
  "\x1b[5~",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("Delete", { shiftKey: true }), SYS),
  "\x1b[3~",
);
// ...but combined with Ctrl or Alt it is encoded, because the unmodified form
// would be wrong there anyway.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowUp", { shiftKey: true, ctrlKey: true }), SYS),
  "\x1b[1;6A",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("Delete", { ctrlKey: true }), SYS),
  "\x1b[3;5~",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("Home", { ctrlKey: true, shiftKey: true }), SYS),
  "\x1b[1;6H",
);

// The Ctrl bit must come from the app's Ctrl latch, not from event.ctrlKey:
// this firmware delivers Ctrl as a separate keydown and leaves ctrlKey false
// on the key that follows it.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("ArrowLeft"), { ...SYS, forceCtrl: true }),
  "\x1b[1;5D",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("Delete"), { ...SYS, forceCtrl: true }),
  "\x1b[3;5~",
);

// Alt chords become Meta (ESC-prefixed) sequences instead of being dropped.
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("b", { altKey: true, code: "KeyB" }), SYS),
  "\x1bb",
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("f", { altKey: true, code: "KeyF" }), SYS),
  "\x1bf",
);
// Alt+punctuation must NOT be misread as AltGr and typed as the bare
// character — that turned readline's yank-last-arg into a stray ".".
assert.strictEqual(
  isAltGraphEvent(navEvent(".", { altKey: true, code: "Period" }), SYS),
  false,
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent(".", { altKey: true, code: "Period" }), SYS),
  "\x1b.",
);
// A genuine AltGr composition on the DE layout still resolves as AltGr: the
// delivered "@" is not KeyQ's own base or shifted character.
const DE = { keyboardLayout: "de" };
assert.strictEqual(
  isAltGraphEvent(navEvent("@", { altKey: true, code: "KeyQ" }), DE),
  true,
);
assert.strictEqual(
  terminalDataFromKeyEvent(navEvent("@", { altKey: true, code: "KeyQ" }), DE),
  "@",
);
// AltGr held over a DE key that has NO third level: XKB clamps to level 1, so
// the base character arrives and must still be typed. Misreading it as a plain
// Alt chord used to swallow it.
assert.strictEqual(
  isAltGraphEvent(navEvent("ö", { altKey: true, ctrlKey: true, code: "Semicolon" }), DE),
  true,
);
assert.strictEqual(
  terminalDataFromKeyEvent(
    navEvent("ö", { altKey: true, ctrlKey: true, code: "Semicolon" }),
    DE,
  ),
  "ö",
);
assert.strictEqual(
  printableDataFromKeyEvent(
    navEvent(".", { altKey: true, ctrlKey: true, code: "Period" }),
    DE,
  ),
  ".",
);

// Ctrl+Alt stays reserved for the app's own shortcuts.
assert.strictEqual(
  terminalDataFromKeyEvent(
    navEvent("x", { altKey: true, ctrlKey: true, code: "KeyX" }),
    SYS,
  ),
  null,
);

// Layout resolution is injectable, so nothing here depends on the host locale.
assert.strictEqual(resolveKeyboardLayout("auto", { languages: ["en-US"] }), "system");
assert.strictEqual(resolveKeyboardLayout("auto", { languages: ["de-DE"] }), "de");

// ---------------------------------------------------------------------------
// Remote/app-shortcut key predicates (moved here from main.js so the DE-layout
// AltGraph reasoning behind the Ctrl+Alt+Q / Ctrl+Alt+X pair is covered).
assert.strictEqual(isRemoteBackKey({ keyCode: 461 }), true);
assert.strictEqual(isRemoteBackKey({ key: "Back" }), true);
assert.strictEqual(isRemoteBackKey({ key: "BrowserBack" }), true);
assert.strictEqual(isRemoteBackKey({ key: "GoBack" }), true);
assert.strictEqual(isRemoteBackKey({ code: "BrowserBack" }), true);
assert.strictEqual(isRemoteBackKey({ which: 461 }), true);
assert.strictEqual(isRemoteBackKey({ key: "b", keyCode: 66 }), false);
assert.strictEqual(isRemoteBackKey(null), false);

const ctrlAlt = (key, extra = {}) => ({
  key,
  ctrlKey: true,
  altKey: true,
  metaKey: false,
  shiftKey: false,
  ...extra,
});
assert.strictEqual(isCtrlAltKey(ctrlAlt("x", { code: "KeyX" }), "x"), true);
assert.strictEqual(isCtrlAltKey(ctrlAlt("X", { code: "KeyX" }), "x"), true, "case-insensitive");
assert.strictEqual(isCtrlAltKey(ctrlAlt("h", { code: "KeyH" }), "d"), false);
assert.strictEqual(isCtrlAltKey({ key: "x", ctrlKey: true, altKey: false }, "x"), false);
assert.strictEqual(isCtrlAltKey({ key: "x", ctrlKey: false, altKey: true }, "x"), false);
assert.strictEqual(isCtrlAltKey(null, "x"), false);
// AltGr is Ctrl+Alt on a DE layout, so a third-level character must never be
// mistaken for a shortcut — this is exactly why disconnect also answers to X.
assert.strictEqual(
  isCtrlAltKey(ctrlAlt("q", { getModifierState: (n) => n === "AltGraph" }), "q"),
  false,
);
assert.strictEqual(isCtrlAltKey(ctrlAlt("q", { code: "AltRight" }), "q"), false);
