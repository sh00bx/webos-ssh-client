import { resolveKeyboardLayout as resolveKeyboardLayoutMode } from "./keyboard-layout.mjs";

export function controlDataFromKeyEvent(event, options = {}) {
  const hasCtrl = hasControlModifier(event, options);
  if (
    !event ||
    !hasCtrl ||
    event.metaKey ||
    isAltGraphEvent(event, options) ||
    (event.altKey && !isAltGraphEvent(event, options))
  ) {
    return null;
  }

  const key = normalizeKey(event.key);
  const legacyKey = legacyPrintableKeyFromEvent(event, options);
  if (!key && !legacyKey) return null;

  const keyText = legacyKey || key;
  if (keyText.length === 1) return controlDataFromCharacter(keyText);

  if (keyText === "Escape") return String.fromCharCode(27);
  if (keyText === "Backspace") return String.fromCharCode(127);
  return null;
}

export function hasControlModifier(event, options = {}) {
  if (!event || isAltGraphEvent(event, options)) return false;
  return Boolean(
    options.forceCtrl ||
      event.ctrlKey ||
      (typeof event.getModifierState === "function" &&
        event.getModifierState("Control")),
  );
}

export function isAltGraphEvent(event, options = {}) {
  if (!event || event.metaKey) return false;
  if (event.key === "AltGraph" || event.code === "AltRight") return true;
  if (
    typeof event.getModifierState === "function" &&
    event.getModifierState("AltGraph")
  ) {
    return true;
  }
  const key = normalizeKey(event.key);
  // Firmwares that report neither AltRight nor the AltGraph modifier still
  // compose the third-level character into event.key, so an Alt chord carrying
  // punctuation is usually AltGr (this is how "@" survives on a DE layout).
  // But a *plain* left-Alt chord looks identical at this level, so check the
  // layout: if the delivered character is simply this key's own base or
  // shifted character, it is Alt+<char> (e.g. Alt+. = readline yank-last-arg)
  // and must not be treated as AltGr — doing so used to type a stray "."
  // instead of sending the Meta sequence.
  if (event.altKey && key.length === 1 && !/^[a-z0-9]$/i.test(key)) {
    // Ctrl+Alt is the Windows-style AltGr shape, and a plain left-Alt chord
    // never sets ctrlKey — so trust it without further checks. This matters
    // for keys with NO third level: XKB clamps them to level 1, so a genuine
    // AltGr press delivers the key's own base character ("ö", ".", "-"), and
    // running the discriminator below would misread it as Alt+<char> and
    // swallow the keystroke.
    if (event.ctrlKey) return true;
    if (!isOwnUnmodifiedCharacter(event, key, options)) return true;
  }
  if (event.altKey && altGraphCharacterFromEvent(event, resolveKeyboardLayout(options))) {
    return true;
  }
  if (!event.ctrlKey || !event.altKey) return false;
  return Boolean(altGraphCharacterFromEvent(event, resolveKeyboardLayout(options)));
}

// True when `key` is exactly what this physical key produces unmodified (or
// with Shift) under the active layout — i.e. no third-level composition
// happened.
function isOwnUnmodifiedCharacter(event, key, options) {
  const layoutName = fallbackLayout(resolveKeyboardLayout(options));
  const printable = legacyPrintableFromCode(hardwareCode(event), layoutName);
  if (!printable) return false;
  return printable[0] === key || printable[1] === key;
}

export function isControlKeyEvent(event) {
  if (!event) return false;
  const key = normalizeKey(event.key || event.keyIdentifier);
  return (
    key === "Control" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight" ||
    event.keyCode === 17 ||
    event.which === 17
  );
}

export function inputEventDecision(event, state = {}) {
  // Decide what an `input` / `beforeinput` event should do. Pulled out of
  // terminal.js so it stays unit-testable and because some firmwares route USB
  // keyboard text through the IME path instead of plain keydown. Returns:
  //   null               — not an event we react to; let it propagate
  //   { send: null }     — consume the event without re-sending
  //   { send: "<data>" } — consume and emit this string toward the terminal
  if (!event) return null;
  if (event.type !== "beforeinput" && event.type !== "input") return null;
  if (typeof event.data !== "string" || event.data.length === 0) return null;

  const now = Number.isFinite(state.now) ? Number(state.now) : Date.now();
  const suppressUntil = Number.isFinite(state.suppressUntil)
    ? Number(state.suppressUntil)
    : 0;
  const ctrlTracked = Boolean(state.ctrlTracked);

  if (now < suppressUntil) {
    // A preceding keydown already produced the terminal data; the input
    // event is the IME echo of the same keystroke. Swallow it.
    return { send: null };
  }

  if (ctrlTracked) {
    if (event.data.length === 1) {
      const data = controlDataFromCharacter(event.data);
      return { send: data };
    }
    return { send: null };
  }

  return { send: event.data };
}

export function controlDataFromCharacter(ch) {
  if (!ch || ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }

  switch (ch) {
    case "@":
    case " ":
      return String.fromCharCode(0);
    case "[":
      return String.fromCharCode(27);
    case "\\":
      return String.fromCharCode(28);
    case "]":
      return String.fromCharCode(29);
    case "^":
      return String.fromCharCode(30);
    case "_":
      return String.fromCharCode(31);
    case "?":
      return String.fromCharCode(127);
    default:
      return null;
  }
}

// Cursor-style keys: CSI/SS3 sequences ending in a letter.
const CURSOR_KEY_FINALS = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
// Editing keys: CSI <number> ~ sequences.
const TILDE_KEY_NUMBERS = {
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

// xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). 1 means "no
// modifiers", in which case the parameter is omitted entirely.
//
// Two deliberate deviations from a naive reading:
//   * Shift ALONE does not count. Terminals do encode Shift+Up as CSI 1;2A,
//     but readline and less have no binding for it, so emitting it turns
//     working chords (Shift+PgUp paging, Shift+Up history) into dead keys.
//     Shift is only encoded when it accompanies Ctrl or Alt, where the
//     unmodified form would be wrong anyway.
//   * `ctrl` is passed in rather than read from event.ctrlKey, because this
//     firmware delivers Ctrl as its own keydown and leaves ctrlKey false on
//     the following key — the app tracks it separately and every other path
//     here honours that latch.
function modifierParam(event, { ignoreAlt = false, ctrl = false } = {}) {
  const alt = Boolean(event.altKey) && !ignoreAlt;
  let param = 1;
  if (alt) param += 2;
  if (ctrl) param += 4;
  if (event.shiftKey && (alt || ctrl)) param += 1;
  return param;
}

// Sequence for a named navigation/editing key, or null if `key` is not one.
// Handles the modifier encoding every terminal emulator sends (Ctrl+Left =
// CSI 1;5D, so bash/readline word motion works) and DECCKM, where an
// application that enabled application-cursor-keys mode expects the SS3 form
// (ESC O A) rather than CSI — ncurses apps such as fzf look their arrows up
// strictly through terminfo and ignore the CSI form.
function namedKeyData(key, event, { appCursor = false, altGraph = false, ctrl = false } = {}) {
  const param = modifierParam(event, { ignoreAlt: altGraph, ctrl });
  const final = CURSOR_KEY_FINALS[key];
  if (final) {
    if (param !== 1) return `\x1b[1;${param}${final}`;
    return (appCursor ? "\x1bO" : "\x1b[") + final;
  }
  const number = TILDE_KEY_NUMBERS[key];
  if (number) {
    return param !== 1 ? `\x1b[${number};${param}~` : `\x1b[${number}~`;
  }
  return null;
}

// The character this key produces with the Alt modifier ignored — the payload
// of a Meta (ESC-prefixed) sequence.
function baseCharacterFromEvent(event, options) {
  const key = normalizeKey(event.key);
  if (key.length === 1) return key;
  const layoutName = fallbackLayout(resolveKeyboardLayout(options));
  const code = hardwareCode(event);
  if (code >= 65 && code <= 90) {
    return legacyLetterFromCode(code, letterShiftFromEvent(event), layoutName);
  }
  const printable = legacyPrintableFromCode(code, layoutName);
  return (printable && printable[event.shiftKey ? 1 : 0]) || "";
}

export function terminalDataFromKeyEvent(event, options = {}) {
  if (!event || event.type === "keyup" || event.metaKey) return null;

  const altGraph = isAltGraphEvent(event, options);

  // Named navigation/editing keys resolve first so that modified forms
  // (Ctrl+Left, Alt+Delete, Shift+Home) are encoded rather than swallowed by
  // the Ctrl/Alt bail-outs below.
  const namedKey = normalizeKey(event.key) || legacyNamedKeyFromEvent(event);
  const namedData = namedKeyData(namedKey, event, {
    appCursor: Boolean(options.appCursor),
    altGraph,
    ctrl: hasControlModifier(event, options),
  });
  if (namedData) return namedData;

  if (event.altKey && !altGraph) {
    // Ctrl+Alt is reserved for the app's own shortcuts (disconnect, hide,
    // debug) — never send it to the shell.
    if (event.ctrlKey) return null;
    // Meta chords: ESC + the character, which is what readline's Meta
    // bindings (Alt+b/Alt+f/Alt+d/Alt+.) and every other terminal expect.
    const base = baseCharacterFromEvent(event, options);
    return base ? "\x1b" + base : null;
  }

  const controlData = altGraph ? null : controlDataFromKeyEvent(event, options);
  if (controlData) return controlData;
  if (!altGraph && hasControlModifier(event, options)) return null;

  const key = namedKey;
  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return String.fromCharCode(127);
    case "Tab":
      // Shift+Tab is back-tab (CSI Z) — completion menus and curses apps
      // distinguish it from a plain Tab.
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return String.fromCharCode(27);
    default:
      break;
  }

  const printable = printableDataFromKeyEvent(event, {
    ...options,
    forceAltGraph: altGraph,
  });
  if (printable) return printable;
  if (key.length === 1) return key;
  return "";
}

export function printableDataFromKeyEvent(event, options = {}) {
  if (!event || event.type === "keyup" || event.metaKey) return "";

  const altGraph = options.forceAltGraph || isAltGraphEvent(event, options);
  if ((event.ctrlKey || event.altKey) && !altGraph) return "";

  const layoutName = resolveKeyboardLayout(options);
  const key = normalizeKey(event.key);
  if (!usesHardwareLayout(layoutName) && key.length === 1) return key;

  const legacyKey = legacyPrintableKeyFromEvent(event, {
    ...options,
    forceAltGraph: altGraph,
  });
  if (legacyKey) return legacyKey;

  if (key.length === 1) return key;
  return "";
}

// Caps Lock state carried by a key event, or null when this event cannot tell
// us (a non-letter key on a firmware without getModifierState). Callers keep
// their previous state on null rather than guessing.
//
// getModifierState("CapsLock") is the authoritative source and is what
// letterShiftFromEvent() already relies on. The character heuristic below only
// covers firmwares that omit it: a cased letter arriving uppercase without
// Shift (or lowercase *with* Shift) means the lock is engaged. It reads
// event.key, which webOS 25 populates on both keydown and keypress.
export function capsLockStateFromEvent(event) {
  if (!event) return null;
  if (typeof event.getModifierState === "function") {
    try {
      return Boolean(event.getModifierState("CapsLock"));
    } catch (e) {
      /* fall through to the character heuristic */
    }
  }
  const key = normalizeKey(event.key);
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  const lower = key.toLowerCase();
  if (upper === lower) return null; // digit/punctuation — carries no signal
  return key === upper ? !event.shiftKey : Boolean(event.shiftKey);
}

function normalizeKey(key) {
  if (typeof key !== "string") return "";
  if (key === "Unidentified" || key === "Undefined") return "";
  if (key === "Spacebar") return " ";
  if (key === "Esc") return "Escape";
  if (/^U\+[0-9a-f]{4}$/i.test(key)) {
    return String.fromCharCode(parseInt(key.slice(2), 16));
  }
  return key;
}

function legacyPrintableKeyFromEvent(event, options = {}) {
  const layoutName = resolveKeyboardLayout(options);
  if (options.forceAltGraph) {
    const altGraphKey = altGraphCharacterFromEvent(event, layoutName);
    if (altGraphKey) return altGraphKey;
  }

  if (usesHardwareLayout(layoutName)) {
    const hardwareKey = hardwarePrintableKeyFromEvent(event, layoutName);
    if (hardwareKey) return hardwareKey;
  }

  const identifier = normalizeKey(event.keyIdentifier);
  if (identifier && identifier.length === 1) {
    if (identifier >= "A" && identifier <= "Z" && !event.shiftKey) {
      return identifier.toLowerCase();
    }
    return identifier;
  }
  if (isPrintableCharCode(event.charCode)) {
    return String.fromCharCode(event.charCode);
  }
  const code = legacyVirtualCode(event);
  if (!code) return "";
  if (code >= 65 && code <= 90) {
    return legacyLetterFromCode(code, letterShiftFromEvent(event), fallbackLayout(layoutName));
  }
  const printable = legacyPrintableFromCode(code, fallbackLayout(layoutName));
  if (printable) return printable[event.shiftKey ? 1 : 0] || "";
  return "";
}

function legacyNamedKeyFromEvent(event) {
  const code = legacyCode(event);
  switch (code) {
    case 8:
      return "Backspace";
    case 9:
      return "Tab";
    case 13:
      return "Enter";
    case 27:
      return "Escape";
    case 33:
      return "PageUp";
    case 34:
      return "PageDown";
    case 35:
      return "End";
    case 36:
      return "Home";
    case 37:
      return "ArrowLeft";
    case 38:
      return "ArrowUp";
    case 39:
      return "ArrowRight";
    case 40:
      return "ArrowDown";
    case 46:
      return "Delete";
    default:
      return "";
  }
}

function legacyCode(event) {
  const raw = event && (event.keyCode || event.which || event.charCode);
  const code = Number(raw);
  return Number.isFinite(code) ? code : 0;
}

function legacyVirtualCode(event) {
  const raw = event && (event.keyCode || event.which);
  const code = Number(raw);
  return Number.isFinite(code) ? code : 0;
}

function isPrintableCharCode(code) {
  return Number.isFinite(code) && code >= 32 && code !== 127;
}

// `options.env` exists so callers (tests in particular) can pin the layout
// resolution instead of inheriting it from the host's locale, which otherwise
// decides which branch runs.
function resolveKeyboardLayout(options = {}) {
  return resolveKeyboardLayoutMode(
    options.keyboardLayout || DEFAULT_KEYBOARD_LAYOUT,
    options.env,
  );
}

function usesHardwareLayout(layoutName) {
  return layoutName !== "system";
}

function fallbackLayout(layoutName) {
  return usesHardwareLayout(layoutName) ? layoutName : "us";
}

function legacyLetterFromCode(code, upperCase, layoutName) {
  const layout = KEYBOARD_LAYOUTS[layoutName] || KEYBOARD_LAYOUTS.us;
  const mapped = layout.letters && layout.letters[code];
  if (mapped) return mapped[upperCase ? 1 : 0];
  const ch = String.fromCharCode(code);
  return upperCase ? ch : ch.toLowerCase();
}

function legacyPrintableFromCode(code, layoutName) {
  const layout = KEYBOARD_LAYOUTS[layoutName] || KEYBOARD_LAYOUTS.us;
  return (layout.printable && layout.printable[code]) || KEYBOARD_LAYOUTS.us.printable[code];
}

function hardwarePrintableKeyFromEvent(event, layoutName) {
  const code = hardwareCode(event);
  if (!code) return "";
  if (code >= 65 && code <= 90) {
    return legacyLetterFromCode(code, letterShiftFromEvent(event), layoutName);
  }
  const printable = legacyPrintableFromCode(code, layoutName);
  return (printable && printable[event.shiftKey ? 1 : 0]) || "";
}

function altGraphCharacterFromEvent(event, layoutName) {
  const printable = legacyPrintableFromCode(hardwareCode(event), layoutName);
  return (printable && printable[2]) || "";
}

function hardwareCode(event) {
  const code = codeToLegacyCode(event && event.code);
  return code || legacyVirtualCode(event);
}

function codeToLegacyCode(code) {
  if (typeof code !== "string") return 0;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  return CODE_TO_LEGACY_CODE[code] || 0;
}

function letterShiftFromEvent(event) {
  const shifted = Boolean(event && event.shiftKey);
  if (event && typeof event.getModifierState === "function") {
    return shifted !== Boolean(event.getModifierState("CapsLock"));
  }
  const key = normalizeKey(event && event.key);
  return shifted || (key.length === 1 && key >= "A" && key <= "Z");
}

const DEFAULT_KEYBOARD_LAYOUT = "auto";

const CODE_TO_LEGACY_CODE = {
  Space: 32,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
};

const US_PRINTABLE_KEYCODES = {
  32: [" ", " "],
  48: ["0", ")"],
  49: ["1", "!"],
  50: ["2", "@"],
  51: ["3", "#"],
  52: ["4", "$"],
  53: ["5", "%"],
  54: ["6", "^"],
  55: ["7", "&"],
  56: ["8", "*"],
  57: ["9", "("],
  186: [";", ":"],
  187: ["=", "+"],
  188: [",", "<"],
  189: ["-", "_"],
  190: [".", ">"],
  191: ["/", "?"],
  192: ["`", "~"],
  219: ["[", "{"],
  220: ["\\", "|"],
  221: ["]", "}"],
  222: ["'", "\""],
};

const KEYBOARD_LAYOUTS = {
  us: {
    letters: {},
    printable: US_PRINTABLE_KEYCODES,
  },
  de: {
    letters: {
      89: ["z", "Z"],
      90: ["y", "Y"],
    },
    printable: {
      32: [" ", " "],
      48: ["0", "=", "}"],
      49: ["1", "!"],
      50: ["2", "\"", "²"],
      51: ["3", "§", "³"],
      52: ["4", "$"],
      53: ["5", "%"],
      54: ["6", "&"],
      55: ["7", "/", "{"],
      56: ["8", "(", "["],
      57: ["9", ")", "]"],
      69: ["e", "E", "€"],
      77: ["m", "M", "µ"],
      81: ["q", "Q", "@"],
      186: ["ö", "Ö"],
      187: ["´", "`"],
      188: [",", ";"],
      189: ["ß", "?", "\\"],
      190: [".", ":"],
      191: ["-", "_"],
      192: ["^", "°"],
      219: ["ü", "Ü"],
      220: ["#", "'"],
      221: ["+", "*", "~"],
      222: ["ä", "Ä"],
      226: ["<", ">", "|"],
    },
  },
};

// The webOS remote's Back button. Firmwares disagree on how they report it —
// keyCode 461 is the LG-specific code, the named variants come from different
// WebView generations — so all of them are accepted.
export function isRemoteBackKey(event) {
  if (!event) return false;
  const key = event.key || event.keyIdentifier || "";
  const code = event.keyCode || event.which;
  return (
    code === 461 ||
    key === "Back" ||
    key === "BrowserBack" ||
    key === "GoBack" ||
    event.code === "BrowserBack"
  );
}

// App shortcuts are Ctrl+Alt+<letter>. The AltGraph exclusion matters on a DE
// layout, where AltGr is reported as Ctrl+Alt: without it, typing a
// third-level character such as "@" (AltGr+Q) would trigger the shortcut bound
// to "q" instead of reaching the shell. That is also why disconnect is bound to
// both Q and X — on DE, Q can never match, since it always classifies as
// AltGraph.
export function isCtrlAltKey(event, key) {
  if (!event) return false;
  return (
    Boolean(event.ctrlKey) &&
    Boolean(event.altKey) &&
    !isAltGraphEvent(event) &&
    String(event.key || "").toLowerCase() === key
  );
}
