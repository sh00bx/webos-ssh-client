import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { SearchAddon } from "xterm-addon-search";
import {
  controlDataFromCharacter,
  inputEventDecision,
  isControlKeyEvent,
  terminalDataFromKeyEvent,
} from "./keymap.mjs";
import { clipboardTextFromOsc52 } from "./osc52.mjs";
import {
  KEYBOARD_STATE_EVENT,
  isOskEnterEvent,
  keyboardVisibleFromEvent,
  proxyInputDelta,
  systemKeyboardVisible,
} from "./osk-input.mjs";
import {
  buildCellBackgroundCss,
  cellBackgroundStyle,
  isCellBackgroundStyle,
  INLINE_CELL_BG_ATTR,
} from "./cell-bg.mjs";
import { createWebglInk } from "./webgl-ink.mjs";
const CONTROL_STATE_TTL_MS = 4000;
const TEXT_SUPPRESS_MS = 750;
// How often the OSK proxy field is diffed while the system keyboard is up.
// The IME does fire `input` on this firmware — that is the whole reason the
// proxy works — but predictive-text commits have been observed to land without
// one, so the poll is the floor rather than the mechanism. 100 ms is below the
// threshold where typing feels laggy and far above anything that costs a TV.
const OSK_POLL_MS = 100;
// Reset the proxy field once it has grown past this. Left unbounded it would
// accumulate a whole session's typing, and every diff would walk it. Reset
// only happens when nothing is mid-composition, and it costs at most one
// missed backspace at the boundary (the field looks empty to the next diff,
// so a delete below the reset point is sent by the explicit key path instead).
const OSK_RESET_AFTER_CHARS = 512;
const DEFAULT_FONT_SIZE = 18;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;
const TERMINAL_FONT_NAME = "Pwntastic Terminal Mono";
const TERMINAL_FONT_FAMILY =
  `"${TERMINAL_FONT_NAME}", "JetBrains Mono", "Liberation Mono", "DejaVu Sans Mono", monospace`;
const TERMINAL_FONT_LOAD_SPEC = `18px "${TERMINAL_FONT_NAME}"`;
const TERMINAL_FALLBACK_FONT_LOAD_SPEC = '18px "JetBrains Mono"';
const TERMINAL_FONT_PATH = "assets/fonts/JetBrainsMono-Regular.woff2";
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 900;

let terminalFontPromise = null;
let terminalFontLoaded = false;

function fontUrl() {
  return new URL(
    TERMINAL_FONT_PATH,
    document.baseURI || window.location.href,
  ).href;
}

function fontFaceSource(url) {
  return `url("${String(url).replace(/["\\]/g, "\\$&")}") format("woff2")`;
}

function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      loaded: false,
      timedOut: true,
      family: TERMINAL_FONT_NAME,
    }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function loadTerminalFontImpl() {
  const fonts = document.fonts || null;
  if (
    typeof FontFace === "function" &&
    fonts &&
    typeof fonts.add === "function"
  ) {
    const face = new FontFace(TERMINAL_FONT_NAME, fontFaceSource(fontUrl()), {
      display: "block",
      style: "normal",
      weight: "400",
    });
    await face.load();
    fonts.add(face);
    if (typeof fonts.load === "function") {
      await fonts.load(TERMINAL_FONT_LOAD_SPEC);
    }
    terminalFontLoaded = true;
    return {
      loaded: true,
      family: TERMINAL_FONT_NAME,
      method: "FontFace",
      url: fontUrl(),
    };
  }

  if (fonts && typeof fonts.load === "function") {
    await fonts.load(TERMINAL_FALLBACK_FONT_LOAD_SPEC);
    if (fonts.ready) await fonts.ready;
    terminalFontLoaded = true;
    return {
      loaded: true,
      family: "JetBrains Mono",
      method: "document.fonts.load",
    };
  }

  return {
    loaded: false,
    family: TERMINAL_FONT_NAME,
    method: "unavailable",
  };
}

export function preloadTerminalFont(options = {}) {
  if (terminalFontLoaded) {
    return Promise.resolve({
      loaded: true,
      cached: true,
      family: TERMINAL_FONT_NAME,
    });
  }
  if (!terminalFontPromise) {
    terminalFontPromise = loadTerminalFontImpl().catch((error) => ({
      loaded: false,
      family: TERMINAL_FONT_NAME,
      error: error && (error.message || String(error)),
    }));
  }
  return withTimeout(
    terminalFontPromise,
    options.timeoutMs || TERMINAL_FONT_LOAD_TIMEOUT_MS,
  );
}

// The single authoritative clamp for the terminal font size — prefs.js imports
// it so the persisted value and the applied value can never drift apart.
export function clampFontSize(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(num)));
}

export const TERMINAL_FONT_SIZE_LIMITS = {
  min: MIN_FONT_SIZE,
  max: MAX_FONT_SIZE,
  default: DEFAULT_FONT_SIZE,
};

// Keep the indexed-cell-background rules (see cell-bg.mjs) in sync with the
// live palette. One document-level stylesheet, not one per terminal: the theme
// is global, so every open tab paints from the same palette and a per-instance
// copy would only add duplicate rules for the renderer to match against.
const CELL_BG_STYLE_ID = "term-cell-bg-css";

function applyCellBackgroundCss(palette) {
  try {
    let style = document.getElementById(CELL_BG_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = CELL_BG_STYLE_ID;
      document.head.appendChild(style);
    }
    const css = buildCellBackgroundCss(palette);
    if (style.textContent !== css) style.textContent = css;
  } catch (e) {
    /* no document access: cells keep xterm's opaque backgrounds */
  }
}

// 🔑 xterm draws NO cursor at all until `coreService.isCursorInitialized` flips
// true — `_updateModel` gates the whole cursor branch on it, so `model.cursor`
// stays null, the cursor vertex count stays 0, and the cell is left pixel
// identical to the empty background (measured on the device: the cursor cell
// and the panel next to it were both exactly rgb(6,7,8) across six frames).
//
// xterm sets the flag from exactly three places, and in this app the first two
// are dead by construction:
//   1. `_handleTextAreaFocus` — the helper textarea is disabled and any focus
//      landing on it is bounced to `.input-sink`, so it never fires (verified
//      live: CoreBrowserService._isFocused false, textarea.disabled true).
//   2. the `_keyDown` / `_keyPress` paths — our keyEventHandler returns false
//      for every key it handles, which short-circuits xterm before its
//      `_showCursor()` call.
//   3. DECSET/DECRST 1049/47/1047, i.e. a switch of the alternate screen
//      buffer.
// That leaves (3) as the only live setter, which is why the cursor is normally
// there — tmux, vim and friends enter the alt screen on startup — and why it is
// missing whenever a fresh Terminal attaches to a session that is ALREADY in
// the alt buffer: the remote just repaints, it does not switch buffers again,
// so nothing ever initialises the cursor and it stays gone for the life of that
// Terminal. Setting the flag here is what the textarea focus we deliberately
// refuse would have done. It is only ever set, never cleared, so once is enough.
function markCursorInitialized(term) {
  try {
    const core = term._core;
    const coreService = core && (core.coreService || core._coreService);
    if (coreService) coreService.isCursorInitialized = true;
  } catch (e) {
    /* xterm internals moved: the cursor falls back to the alt-buffer trigger */
  }
}

// 🔑 Tell xterm the terminal is focused. It otherwise decides that from ONE
// thing — is its own helper textarea `document.activeElement` — and this app
// permanently denies it that: the textarea is disabled and any focus reaching
// it is bounced to `.input-sink` (the OSK fix). So `isFocused` was false for
// the whole life of the session even while the user was typing into it, and
// three things silently followed from that:
//   * the cursor was always drawn in `cursorInactiveStyle`, so a DECSCUSR from
//     the remote (vim switching to a bar in insert mode) had no effect at all;
//   * CursorBlinkStateManager only arms its interval when isFocused is true, so
//     the cursor could never blink no matter what the remote asked for — it sat
//     permanently in the blink-ON phase as a solid block (verified live: the
//     manager exists but reports isPaused true forever);
//   * selections rendered in the inactive colour.
// `document.hasFocus()` rather than a hard `true` so a backgrounded app still
// degrades honestly — and it degrades into `cursorInactiveStyle: "block"`
// above, i.e. a visible steady cursor, not a missing one.
function reportTerminalFocused(term) {
  try {
    const service = term._core && term._core._coreBrowserService;
    if (!service) return;
    Object.defineProperty(service, "isFocused", {
      configurable: true,
      get() {
        try {
          return document.hasFocus();
        } catch (e) {
          return true;
        }
      },
    });
  } catch (e) {
    /* xterm internals moved: cursor keeps the inactive style, as before */
  }
}

// NOTE on on-screen-keyboard suppression: neither `inputmode="none"` nor
// Chromium's VirtualKeyboard API (`navigator.virtualKeyboard.overlaysContent`
// + `virtualkeyboardpolicy="manual"`) has any effect on the webOS *system* OSK
// — all three were tested live on Rockhopper 10.3.0-25 and are no-ops. The
// only thing that actually works is keeping the focus target non-editable; see
// the comment on `inputSink` below. Earlier builds carried that machinery; it
// was removed because it did nothing and its presence implied the OSK was
// under control by some other means than it actually is.

export function initTerminal(container, options = {}) {
  // Both handlers are installed after construction via the setters below —
  // the session controller only has something to send to once the service has
  // answered with a session id.
  let controlDataHandler = null;
  let resizeHandler = null;
  // Optional debug sink (session-controller passes debugEvent). terminal.js
  // must not import debug.js directly: debug.js → prefs.js → terminal.js
  // would close an import cycle.
  const debugLog = typeof options.onDebugEvent === "function" ? options.onDebugEvent : null;
  let controlKeyDown = false;
  let controlKeySeenAt = 0;
  let suppressTextInputUntil = 0;
  let disposed = false;
  // Chameleon's per-glyph ink runs on a WebGL renderer (webgl-ink.mjs). It is
  // created lazily and only while an adaptive theme is live: every other theme
  // keeps the DOM renderer it has always had, which keeps the blast radius of
  // a renderer swap inside the one feature that needs it.
  let webglInk = null;
  const handledEvents = new WeakSet();
  const refreshTimers = [];
  const initialFontSize = clampFontSize(
    Number.isFinite(options.fontSize) ? options.fontSize : DEFAULT_FONT_SIZE,
  );

  const initialTheme = options.theme || {
    background: "rgba(8, 9, 11, 0.72)",
    foreground: "#e9ecef",
    cursor: "#73ff9a",
    selectionBackground: "#1c3a26",
  };
  // The palette as the CALLER means it — before webgl-ink pins the foreground
  // (see setTheme below). onDomRestored re-applies this, not options.theme.
  let lastPalette = initialTheme;

  const term = new Terminal({
    // NOTE: do NOT set `disableStdin: true`. xterm.js's Viewport relies on
    // stdin being enabled to forward mouse-wheel events as escape sequences
    // (CSI M …) when the remote app turns on mouse tracking, e.g. tmux
    // copy mode. With stdin disabled, wheel events are dropped and copy
    // mode looks frozen on the TV. Our custom keyEventHandler already
    // returns false on handled keys, so xterm won't double-emit typed
    // characters.
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: initialFontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    // Only reached when the app really is in the background now that
    // reportTerminalFocused() tells xterm the truth (see below) — but "block"
    // rather than xterm's "outline" default, so that state degrades into a
    // visible steady cursor instead of the thinnest one we draw. It is also the
    // cursor the rest of this code base already assumes (see cursorBgWord in
    // webgl-ink.mjs, and .xterm-cursor-block in cell-bg.mjs).
    cursorInactiveStyle: "block",
    scrollback: 5000,
    allowTransparency: true,
    theme: initialTheme,
  });
  applyCellBackgroundCss(initialTheme);
  const fit = new FitAddon();
  term.loadAddon(fit);
  container.tabIndex = 0;
  container.setAttribute("role", "application");
  term.open(container);
  patchCellBackgroundAlpha();
  markCursorInitialized(term);
  reportTerminalFocused(term);

  // Make http(s) URLs printed in the shell clickable. WebLinksAddon detects
  // the URL and handles the (wrapped-line, wide-char) range math; we override
  // its default click handler, which calls window.open() — a no-op inside the
  // webOS WebView overlay. Instead we hand the URL back to the caller so it
  // can open the system browser via Luna. Guarded so a missing addon or a
  // firmware without the click path can never break terminal init.
  const openLinkHandler =
    typeof options.onOpenLink === "function" ? options.onOpenLink : null;
  if (openLinkHandler) {
    try {
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          try {
            openLinkHandler(uri, event);
          } catch (e) {
            /* handler errors must not bubble into xterm's link dispatch */
          }
        }),
      );
    } catch (e) {
      /* addon unavailable — terminal still works, links just aren't clickable */
    }
  }
  // Scrollback search. The addon only does the matching; the search bar UI
  // lives in the window chrome and calls findNext/findPrevious below.
  let searchAddon = null;
  try {
    searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
  } catch (e) {
    searchAddon = null; // terminal still works, search just isn't available
  }

  // OSC 52: let remote programs (tmux set-clipboard, vim/nvim "+ register)
  // write the local clipboard through the terminal stream. Queries ("?") are
  // ignored inside clipboardTextFromOsc52 — answering one would silently send
  // the TV clipboard to the remote. Returning true consumes the sequence
  // either way so xterm does not log it as unhandled.
  try {
    term.parser.registerOscHandler(52, (payload) => {
      const text = clipboardTextFromOsc52(payload);
      if (
        text &&
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      return true;
    });
  } catch (e) {
    /* parser API missing on an older xterm — feature simply absent */
  }

  const helperTextarea = container.querySelector(".xterm-helper-textarea");
  if (helperTextarea) {
    helperTextarea.setAttribute("autocomplete", "off");
    helperTextarea.setAttribute("autocorrect", "off");
    helperTextarea.setAttribute("spellcheck", "false");
    helperTextarea.setAttribute("readonly", "readonly");
    helperTextarea.setAttribute("disabled", "disabled");
    helperTextarea.setAttribute("tabindex", "-1");
    helperTextarea.setAttribute("aria-hidden", "true");
    helperTextarea.addEventListener("focus", () => {
      helperTextarea.blur();
      focusContainer();
    });
  }

  // Focus target for the terminal. On webOS 25 (Rockhopper 10.3.0-25,
  // Chromium 120) plain USB printable keys arrive as ordinary `keypress`
  // events with a usable `event.key` / `event.keyCode` and flow straight to
  // xterm through keyEventHandler — there is NO beforeinput/IME path for them
  // (confirmed by live CDP capture on the device, 2026-05-25). This element
  // only needs to be focusable so those events have a home inside the
  // terminal frame.
  //
  // It MUST NOT be contenteditable. A focused contenteditable element is the
  // sole trigger for the webOS system on-screen keyboard: a real USB keypress
  // activates the IME and pops the OSK while the editable element holds focus,
  // and none of `inputmode="none"`, `virtualkeyboardpolicy="manual"`, or the
  // Chromium VirtualKeyboard API suppress it (all tested live, all no-ops
  // against the webOS *system* OSK). A plain non-editable div with
  // `tabindex="-1"` is still focusable via `.focus()` and never raises the
  // OSK, which is the fix. The beforeinput/input handlers below remain as an
  // inert fallback for firmwares that do route USB keys through the IME path.
  const inputSink = document.createElement("div");
  inputSink.className = "input-sink";
  inputSink.setAttribute("aria-hidden", "true");
  inputSink.setAttribute("role", "presentation");
  inputSink.setAttribute("tabindex", "-1");
  container.insertBefore(inputSink, container.firstChild || null);

  // The OTHER focus target: a real, editable textarea, used only while the
  // user has asked for the on-screen keyboard. Everything above is built to
  // keep the system OSK away; this is the deliberate opposite, because with a
  // Magic Remote and no USB keyboard the non-editable sink means no typing at
  // all. See osk-input.mjs for why the text is read by DIFFING this field
  // rather than from key events.
  //
  // It stays in the DOM at all times but is only focused while OSK mode is on,
  // so a stray Tab or a click can never land in it and raise the keyboard by
  // accident: `tabindex="-1"` plus `pointer-events: none` in the stylesheet.
  const oskProxy = document.createElement("textarea");
  oskProxy.className = "osk-proxy";
  oskProxy.setAttribute("tabindex", "-1");
  oskProxy.setAttribute("autocomplete", "off");
  oskProxy.setAttribute("autocorrect", "off");
  oskProxy.setAttribute("autocapitalize", "off");
  oskProxy.setAttribute("spellcheck", "false");
  oskProxy.setAttribute("aria-label", "On-screen keyboard input");
  container.insertBefore(oskProxy, container.firstChild || null);

  let oskActive = false;
  let oskComposing = false;
  let oskPollTimer = null;
  let oskLastValue = "";
  // Reported by the platform, not by us: OSK mode being ON is a request, the
  // keyboard actually being ON SCREEN is what the fit guard has to obey. They
  // differ for a few hundred ms on every open and close.
  let systemKeyboardUp = false;
  let onOskStateChange = null;

  function getSize() {
    return {
      cols: term.cols,
      rows: term.rows,
    };
  }

  // 🔑 Never re-fit while the system on-screen keyboard is up. webOS shrinks
  // the WebView to make room for it, so a fit taken during that window
  // measures the leftover strip and pushes THAT to the pty — the remote
  // reflows to a few rows, and closing the keyboard leaves the scrollback
  // mangled. (It also desynchronises the keyboard itself: gprot42's terminal
  // hit the same thing, where a fit mid-keyboard made its Enter stop working.)
  // The size the grid should have is the one it had before the keyboard
  // appeared, which is exactly what skipping the fit preserves; the close
  // handler re-fits once the layout is back.
  //
  // Callers get the CURRENT size rather than a stale cached one, so a resize
  // send built from this reports the truth — it just does not change anything.
  function fitToContainer() {
    if (disposed) return getSize();
    if (systemKeyboardUp) return getSize();
    fit.fit();
    return getSize();
  }

  // Force xterm to re-measure its cell metrics. Re-assigning the same
  // fontFamily string does NOT do this: xterm 5.3's OptionsService only fires
  // onOptionChange when the value actually differs, and CharSizeService
  // measures solely in response to that event. It also has no idea that a web
  // font finished loading (xterm never touches document.fonts), so after a
  // deferred font load the metrics still describe the fallback face and every
  // fit() computes the wrong column count from them.
  function remeasureCharSize() {
    const charSizeService = term._core && term._core._charSizeService;
    if (charSizeService && typeof charSizeService.measure === "function") {
      charSizeService.measure();
    }
  }

  // Re-derive the renderer's dimensions (cell + canvas CSS sizes) in place.
  // This closes the hole that survived the fit-retry + ResizeObserver fixes:
  // MouseService clamps every mouse report against
  // renderService.dimensions.css.canvas, but those dimensions are only
  // recomputed when renderer.handleResize actually runs. resyncViewport heals
  // via fit() → term.resize(), and term.resize() with UNCHANGED cols/rows is a
  // no-op — so a resume where the grid is already back at its final size never
  // refreshes dimensions that went stale during the background phase, and tmux
  // mouse clicks stay pinned to the wrong cell until a manual drag-resize
  // forces a real cols change. Going through RenderService.handleResize would
  // not help either: while its IntersectionObserver still reports the page
  // hidden it defers the renderer call into a paused task whose flush is not
  // guaranteed to run on webOS resume. So call the renderer directly — the
  // same effect as the known manual recovery (drag-resize), minus the buffer
  // reflow and pty traffic. Idempotent when dimensions are already correct.
  function refreshRendererDimensions() {
    const renderer = domRenderer();
    if (renderer && typeof renderer.handleResize === "function") {
      renderer.handleResize(term.cols, term.rows);
    }
    // Cheap and idempotent, and this runs on every resize/resume — so a
    // renderer that somehow got rebuilt after init still ends up patched.
    patchCellBackgroundAlpha();
  }

  // The element holding the glyph rows. The Chameleon ink map is a background
  // on exactly this box, so its position on screen is what the map has to be
  // lined up against — the wrapper would be wrong by the toolbar and padding.
  //
  // Under the WebGL renderer there are no row elements at all; the glyphs are
  // drawn on a canvas that occupies the same box, so it answers the same
  // question and the crop maths upstream is unchanged.
  function rowsElement() {
    const canvas = webglInk && webglInk.canvasElement();
    if (canvas) return canvas;
    const renderer = domRenderer();
    return (renderer && renderer._rowContainer) || null;
  }

  // The box the glyph rows sit in. The Chameleon veil is a background on this
  // element: it has to be behind the text but in front of the panel tint, and
  // it must cover exactly the grid — which is what this element is. It is also
  // the canvas's parent under WebGL, so the veil keeps working untouched.
  function screenElement() {
    const renderer = domRenderer();
    return (
      (renderer && renderer._screenElement) ||
      container.querySelector(".xterm-screen") ||
      null
    );
  }

  function domRenderer() {
    const renderService = term._core && term._core._renderService;
    return (
      (renderService && renderService._renderer && renderService._renderer.value) ||
      null
    );
  }

  // 24-bit cell backgrounds are the one path the stylesheet in cell-bg.mjs
  // cannot reach: the DOM row factory writes them as an inline
  // `background-color:#rrggbb`, and a CSS rule can only override that by
  // replacing the colour outright — losing the hue it is supposed to keep. So
  // re-alpha the declaration where it is produced. _addStyle is shadowed on the
  // instance rather than the prototype, which keeps the patch scoped to this
  // terminal and undone with it.
  function patchCellBackgroundAlpha() {
    try {
      const renderer = domRenderer();
      const rowFactory = renderer && renderer._rowFactory;
      if (!rowFactory || rowFactory.__cellBgAlphaPatched) return;
      const addStyle = rowFactory._addStyle;
      if (typeof addStyle !== "function") return;
      rowFactory._addStyle = function (element, style) {
        if (isCellBackgroundStyle(style) && element && element.setAttribute) {
          element.setAttribute(INLINE_CELL_BG_ATTR, "");
        }
        return addStyle.call(this, element, cellBackgroundStyle(style));
      };
      rowFactory.__cellBgAlphaPatched = true;
    } catch (e) {
      /* renderer internals moved: 24-bit backgrounds stay opaque */
    }
  }

  // The filled-cell alpha the opacity slider writes on the wrapper. The DOM
  // path resolves it in CSS, so nothing ever had to read it; the WebGL renderer
  // hardcodes cell backgrounds to opaque, so its rectangles have to be scaled
  // by hand and the value has to be fetched. Read once when the renderer is
  // switched on — after that terminal-window pushes it on every slider move,
  // because a slider that changes no text would otherwise never be noticed.
  // Every route back to the DOM renderer ends here — the deliberate theme
  // switch, a WebGL activation that failed halfway, and a GL context that never
  // came back — because all three leave a BRAND NEW DomRenderer in place, and
  // an unrepaired one is a real fault, not a cosmetic one: without the row
  // factory patch, 24-bit cell backgrounds go opaque, and without the
  // stylesheet the indexed ones do too.
  function onDomRestored() {
    try {
      // While the WebGL renderer was live, xterm's theme carried a PINNED
      // foreground (webgl-ink pins the atlas key; the real foreground rode
      // along as the flat ink). The DOM renderer reads the theme directly, so
      // the last real palette has to be put back or the shell keeps the
      // foreground from whenever the pin was frozen.
      term.options.theme = lastPalette;
    } catch (e) {
      /* terminal mid-teardown */
    }
    applyCellBackgroundCss(lastPalette);
    refreshRendererDimensions();
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch (e) {
      /* terminal mid-teardown */
    }
  }

  function readCellAlpha() {
    try {
      const raw = getComputedStyle(container).getPropertyValue("--term-cell-alpha");
      const alpha = Number.parseFloat(raw);
      return Number.isFinite(alpha) ? alpha : 1;
    } catch (e) {
      return 1;
    }
  }

  function rendererDimsSnapshot() {
    try {
      const renderService = term._core && term._core._renderService;
      const css =
        renderService && renderService.dimensions && renderService.dimensions.css;
      if (!css) return null;
      return {
        cellW: css.cell.width,
        cellH: css.cell.height,
        canvasW: css.canvas.width,
        canvasH: css.canvas.height,
        renderPaused: Boolean(renderService._isPaused),
      };
    } catch (e) {
      return null;
    }
  }

  function refreshTerminal() {
    if (disposed) return;
    // A collapsed container (backgrounded WebView laid out at 0x0) would make
    // FitAddon clamp the grid to its 2x1 floor and push that size to the pty.
    if (!(container.clientWidth > 0 && container.clientHeight > 0)) return;
    try {
      remeasureCharSize();
      fitToContainer();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch (e) {
      /* terminal may be disposed during a relaunch transition */
    }
  }

  // Re-fit the terminal to its container after the app returns from the
  // background. On webOS 25 a backgrounded WebView lays the page out at zero
  // size. xterm's CharSizeService keeps its last valid cell metrics (its probe
  // never overwrites a good measurement with 0), so `hasValidSize` stays true —
  // that is NOT what breaks. What breaks is the FIT: with a 0-size parent,
  // FitAddon.proposeDimensions() clamps the grid to its floor of 2 cols × 1 row,
  // and xterm shrinks `renderService.dimensions.css.canvas` to ~2 cells wide.
  // On resume, MouseService.getMouseReportCoords() clamps every click to
  // `canvas.width-1`, pinning it to col 0–1 / row 0 — so clicking a tmux window
  // tab (mouse mode) reports the wrong cell and tmux ignores it. A manual
  // resize/fullscreen toggle happens to re-fit while the container is full,
  // which is why that recovers it.
  //
  // The fix is to re-fit, but the WebView can report the page visible before it
  // has finished re-expanding the container. If we fit during that window we
  // just re-clamp to 2×1 again. So retry until the container actually has a real
  // size AND the fit lifts the grid off the collapse floor (or we give up).
  //
  // Fit alone is NOT sufficient, though: when the grid is already back at its
  // final cols/rows, fit()'s term.resize() is a no-op and the renderer
  // dimensions stay whatever the background phase left behind (and the
  // ResizeObserver below can't help either — a backgrounded WebView delivers
  // no RO callbacks, so a resume back to the cached size is swallowed by its
  // dedup). refreshRendererDimensions() re-derives them unconditionally.
  const COLLAPSE_COL_FLOOR = 2;
  // webOS can take several seconds to re-expand the layout after a heavy app
  // switch; 20×50ms gave up too early.
  const RESYNC_MAX_ATTEMPTS = 60;
  function resyncViewport(attempt = 0) {
    if (disposed) return;
    try {
      remeasureCharSize();
      const collapsed = !(container.clientWidth > 0 && container.clientHeight > 0);
      if (!collapsed) {
        fitToContainer();
        refreshRendererDimensions();
        term.refresh(0, Math.max(0, term.rows - 1));
      }
      // Still collapsed, or fit hasn't lifted us off the 2-col floor yet → the
      // container hasn't fully re-expanded; try again shortly.
      const recovered = !collapsed && term.cols > COLLAPSE_COL_FLOOR;
      if (debugLog && (recovered || attempt >= RESYNC_MAX_ATTEMPTS)) {
        debugLog("term_resync_settled", {
          attempt,
          recovered,
          cols: term.cols,
          rows: term.rows,
          containerW: container.clientWidth,
          containerH: container.clientHeight,
          dims: rendererDimsSnapshot(),
        });
      }
      if (!recovered && attempt < RESYNC_MAX_ATTEMPTS) {
        const timer = setTimeout(() => {
          const index = refreshTimers.indexOf(timer);
          if (index >= 0) refreshTimers.splice(index, 1);
          resyncViewport(attempt + 1);
        }, 50);
        refreshTimers.push(timer);
      }
    } catch (e) {
      /* terminal may be mid-teardown during a relaunch transition */
    }
  }

  function scheduleFontRefresh(delay) {
    const timer = setTimeout(() => {
      const index = refreshTimers.indexOf(timer);
      if (index >= 0) refreshTimers.splice(index, 1);
      refreshTerminal();
    }, delay);
    refreshTimers.push(timer);
  }

  function loadTerminalFont() {
    return preloadTerminalFont({ timeoutMs: 0 });
  }

  let resizeTimer = null;
  const resizeListener = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      fitToContainer();
    }, 80);
  };

  const terminalResize = term.onResize((size) => {
    if (resizeHandler) resizeHandler(size);
  });

  function resetControlTracking() {
    controlKeyDown = false;
    controlKeySeenAt = 0;
  }

  function hasTrackedControlKey() {
    if (!controlKeyDown) return false;
    if (Date.now() - controlKeySeenAt > CONTROL_STATE_TTL_MS) {
      resetControlTracking();
      return false;
    }
    return true;
  }

  function updateControlTracking(event) {
    if (!isControlKeyEvent(event)) return;
    if (event.type === "keyup") {
      resetControlTracking();
      return;
    }
    controlKeyDown = true;
    controlKeySeenAt = Date.now();
  }

  // DECCKM: the remote app asked for application-cursor-keys mode, so arrows
  // must be sent as SS3 (ESC O A) rather than CSI (ESC [ A).
  function applicationCursorKeys() {
    try {
      return Boolean(term.modes && term.modes.applicationCursorKeysMode);
    } catch (e) {
      return false; // `modes` accessor missing on older xterm builds
    }
  }

  function markHandled(event) {
    handledEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function focusElement(element) {
    if (!element || typeof element.focus !== "function") return false;
    try {
      element.focus({ preventScroll: true });
    } catch (e) {
      // Some old WebKits reject the options bag; retry without it.
      try {
        element.focus();
      } catch (e2) {
        return false;
      }
    }
    return true;
  }

  // The one place that decides WHICH of the two focus targets is live. Every
  // caller (tab switch, resume, chrome button) goes through it, so turning the
  // OSK on does not have to hunt down the other focus paths — and a resume
  // while the keyboard is up does not silently drop back to the sink and close
  // it.
  function focusContainer() {
    const target = oskActive ? oskProxy : inputSink;
    if (!focusElement(target) && typeof container.focus === "function") {
      container.focus({ preventScroll: true });
    }
    if (term.element) term.element.classList.add("focus");
  }

  function sendTerminalData(data, { suppressFollowup = true } = {}) {
    if (controlDataHandler) controlDataHandler(data);
    if (suppressFollowup) {
      suppressTextInputUntil = Date.now() + TEXT_SUPPRESS_MS;
    }
  }

  // --- On-screen keyboard mode -----------------------------------------
  // Read whatever the IME has put into the proxy field and turn the change
  // into terminal bytes. Called from `input`, from `compositionend`, and from
  // the poll — all three are idempotent because the diff is against the last
  // value we consumed, not against an event payload.
  function syncOskInput() {
    if (disposed || !oskActive || oskComposing) return;
    const value = oskProxy.value;
    if (value === oskLastValue) return;
    const data = proxyInputDelta(oskLastValue, value);
    oskLastValue = value;
    if (data) sendTerminalData(data, { suppressFollowup: false });
    if (value.length > OSK_RESET_AFTER_CHARS) resetOskField();
  }

  function resetOskField() {
    oskProxy.value = "";
    oskLastValue = "";
  }

  function startOskPolling() {
    if (oskPollTimer) return;
    oskPollTimer = setInterval(syncOskInput, OSK_POLL_MS);
  }

  function stopOskPolling() {
    if (!oskPollTimer) return;
    clearInterval(oskPollTimer);
    oskPollTimer = null;
  }

  function openOsk() {
    if (disposed || oskActive) return true;
    oskActive = true;
    resetOskField();
    container.classList.add("osk-on");
    focusContainer();
    startOskPolling();
    if (debugLog) debugLog("term_osk_open", {});
    if (onOskStateChange) onOskStateChange(true);
    return true;
  }

  function closeOsk() {
    if (!oskActive) return false;
    // Flush before tearing down, or the last word typed before the user closed
    // the keyboard is silently dropped.
    //
    // Clearing oskComposing FIRST is load-bearing, and it is the whole reason
    // this is not a one-liner: syncOskInput() returns immediately while a
    // composition is open, which is exactly the state the user is in when they
    // dismiss the keyboard mid-word (dead key, predictive text). The
    // compositionend that the blur below then fires cannot rescue it either —
    // by that point oskActive is false and its own handler bails, and the field
    // has already been reset. So the word would be lost precisely on the path
    // this flush exists for. Sending the visible field content is right: it is
    // what the user can see they typed.
    oskComposing = false;
    syncOskInput();
    oskActive = false;
    stopOskPolling();
    resetOskField();
    container.classList.remove("osk-on");
    // Blurring is what actually lowers the webOS keyboard — keyboardHide() and
    // setManualKeyboardEnabled() are both no-ops while the field holds focus
    // (tested live). So move focus back to the non-editable sink, which is
    // also where the USB-keyboard path expects it.
    try {
      oskProxy.blur();
    } catch (e) {
      /* element may already be detached */
    }
    focusContainer();
    if (debugLog) debugLog("term_osk_close", {});
    if (onOskStateChange) onOskStateChange(false);
    return false;
  }

  // The system keyboard can also be dismissed by the user (remote Back, or the
  // keyboard's own close button) without anything of ours running. Follow it,
  // or the app would sit in OSK mode with no keyboard on screen and a focused
  // editable element that re-raises it on the next keystroke.
  function handleKeyboardStateChange(event) {
    const visible = keyboardVisibleFromEvent(event, window);
    if (visible === systemKeyboardUp) return;
    systemKeyboardUp = visible;
    if (debugLog) debugLog("term_osk_system_state", { visible });
    if (!visible) {
      if (oskActive) closeOsk();
      // The WebView is back to full height; the fit that was suppressed while
      // the keyboard covered it has to happen now. Deferred one frame because
      // the layout settles after the event, not before it.
      setTimeout(() => {
        if (disposed) return;
        refreshTerminal();
        refreshRendererDimensions();
      }, 60);
    }
  }

  function controlDataFromTextEvent(event) {
    if (typeof event.data === "string" && event.data.length === 1) {
      return controlDataFromCharacter(event.data);
    }
    return terminalDataFromKeyEvent(event, { forceCtrl: true });
  }

  function shouldHandleTextEvent(event) {
    const now = Date.now();
    if (now < suppressTextInputUntil) return true;
    return hasTrackedControlKey() && Boolean(controlDataFromTextEvent(event));
  }

  function handleTextEvent(event) {
    if (!shouldHandleTextEvent(event)) return true;
    if (Date.now() >= suppressTextInputUntil && hasTrackedControlKey()) {
      const data = controlDataFromTextEvent(event);
      if (data) sendTerminalData(data);
    }
    markHandled(event);
    return false;
  }

  // Ctrl+Shift+C / Ctrl+Shift+V — the standard terminal-emulator convention
  // (plain Ctrl+C stays SIGINT). Copy takes the xterm selection; paste goes
  // through term.paste() so bracketed-paste mode is honored and the data
  // flows out via the normal onData→write pipeline. Feature-detected: without
  // a clipboard API the chords fall through to the legacy control-code path.
  function copySelection() {
    try {
      const text = term.getSelection();
      if (!text) return;
      navigator.clipboard.writeText(text).catch(() => {});
    } catch (e) {
      /* clipboard may be unavailable/denied on this firmware */
    }
  }

  function pasteFromClipboard() {
    try {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text && !disposed) term.paste(text);
        })
        .catch(() => {});
    } catch (e) {
      /* clipboard may be unavailable/denied on this firmware */
    }
  }

  function clipboardShortcut(event) {
    if (
      event.type !== "keydown" ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey
    ) {
      return "";
    }
    const key = String(event.key || "").toLowerCase();
    const code = event.code || "";
    if (key === "c" || code === "KeyC") return "copy";
    if (key === "v" || code === "KeyV") return "paste";
    if (key === "f" || code === "KeyF") return "search";
    if (key === "t" || code === "KeyT") return "newtab";
    return "";
  }

  // Installed by the window chrome / session controller. Kept as setters
  // like the control-data/resize handlers so the wiring can bind after init.
  let searchRequestHandler = null;
  let newTabRequestHandler = null;

  function keyEventHandler(event) {
    if (handledEvents.has(event)) return false;

    updateControlTracking(event);

    if (oskActive) {
      // Text input belongs to the value diff while the OSK is up — the IME
      // both fires key events AND edits the field, so letting the normal path
      // run as well would send every character twice.
      //
      // Bail out WITHOUT markHandled: that would preventDefault, and the
      // default is the character being inserted into the proxy field, which is
      // the only thing the diff has to read. Suppressing it would leave a USB
      // keyboard typing into a dead terminal for as long as OSK mode is on —
      // the IME path would survive (composition does not go through keypress),
      // so it would look like "the on-screen keyboard broke real typing".
      if (event.type === "keypress") return false;
      if (event.type === "keydown") {
        // The remote's OSK confirm key puts NO newline in the field, so a diff
        // alone would swallow Enter entirely (see osk-input.mjs).
        if (isOskEnterEvent(event)) {
          syncOskInput();
          sendTerminalData("\r", { suppressFollowup: false });
          resetOskField();
          markHandled(event);
          return false;
        }
        // Backspace ONLY — deliberately not Delete. Backspace and DEL (0x7f)
        // both mean "remove the character before the cursor", so the
        // empty-field fallback below is the same key. Delete is the forward
        // delete (CSI 3~): folding it in here would have made it erase the
        // character to the LEFT on an empty field, and do nothing at all on a
        // non-empty one (the caret sits at the end, so a forward delete changes
        // no value and produces no diff). It falls through to the ordinary
        // path, which already sends \x1b[3~ and preventDefaults the field edit.
        if (event.key === "Backspace") {
          // With text in the field, let the textarea do the edit and let the
          // diff report it — that keeps the visible field and the shell in
          // step. With the field empty there is nothing to diff, so send the
          // delete ourselves: this is what makes backspacing past the start of
          // the proxy buffer (into text sent earlier) work at all.
          if (oskProxy.value.length === 0) {
            sendTerminalData("\x7f", { suppressFollowup: false });
            markHandled(event);
            return false;
          }
          return true; // textarea edits, poll/input picks it up
        }
      }
      // Everything else (arrows, Esc, Tab, Ctrl chords, function keys) keeps
      // the ordinary path below: none of them change the field's value, and
      // they are exactly the keys the OSK cannot produce.
    }

    const clipboard = clipboardShortcut(event);
    if (clipboard === "search" || clipboard === "newtab") {
      const handler =
        clipboard === "search" ? searchRequestHandler : newTabRequestHandler;
      if (!handler) return true;
      // Swallow the chord's keypress echo so it can't turn into a control
      // code in the shell underneath.
      suppressTextInputUntil = Date.now() + TEXT_SUPPRESS_MS;
      markHandled(event);
      handler();
      return false;
    }
    if (
      clipboard &&
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      if (clipboard === "copy") copySelection();
      else pasteFromClipboard();
      // Swallow the chord's keypress echo so it can't turn into a control
      // code (^C would send SIGINT right after copying).
      suppressTextInputUntil = Date.now() + TEXT_SUPPRESS_MS;
      markHandled(event);
      return false;
    }

    if (event.type === "keyup" || isControlKeyEvent(event)) return true;

    if (event.type === "keypress") return handleTextEvent(event);

    const data = terminalDataFromKeyEvent(event, {
      forceCtrl: hasTrackedControlKey(),
      appCursor: applicationCursorKeys(),
    });
    if (!data) return true;

    sendTerminalData(data);
    markHandled(event);
    return false;
  }

  function inputEventHandler(event) {
    if (handledEvents.has(event)) return false;
    // While the OSK is up the proxy field's own input/beforeinput events are
    // the diff's raw material, not a second delivery path — running the legacy
    // IME decision on them too would send everything twice.
    if (oskActive) return true;

    // `now` is omitted on purpose: inputEventDecision defaults it to Date.now()
    // internally, but only after its cheap type/data guards reject events we
    // don't react to — so non-text events never pay for the clock read.
    const decision = inputEventDecision(event, {
      suppressUntil: suppressTextInputUntil,
      ctrlTracked: hasTrackedControlKey(),
    });
    if (!decision) return true;

    // When the input event drove the send (no keydown preceded it — the
    // webOS-25 IME path) we don't want to suppress the *next* keystroke,
    // only the keydown→input duplicate. The keydown path keeps its
    // existing suppression behavior via sendTerminalData's default.
    if (decision.send) sendTerminalData(decision.send, { suppressFollowup: false });
    markHandled(event);
    return false;
  }

  // Native paste path (CDP-driven paste, any firmware that fires DOM paste
  // events on the focused sink). preventDefault stops a duplicate beforeinput.
  function pasteEventHandler(event) {
    if (disposed) return;
    const data =
      event.clipboardData &&
      typeof event.clipboardData.getData === "function" &&
      event.clipboardData.getData("text");
    if (typeof data === "string" && data.length) {
      event.preventDefault();
      event.stopPropagation();
      term.paste(data);
    }
  }

  // The proxy field's own change notifications. `input` covers the common
  // case, `compositionstart/end` bracket dead keys and predictive text so a
  // half-composed character is never sent, and the poll started with OSK mode
  // catches whatever fires neither.
  const oskInputListener = () => syncOskInput();
  const oskCompositionStart = () => {
    oskComposing = true;
  };
  const oskCompositionEnd = () => {
    oskComposing = false;
    syncOskInput();
  };
  oskProxy.addEventListener("input", oskInputListener);
  oskProxy.addEventListener("compositionstart", oskCompositionStart);
  oskProxy.addEventListener("compositionend", oskCompositionEnd);
  document.addEventListener(KEYBOARD_STATE_EVENT, handleKeyboardStateChange, true);
  // Seed from the property: the app can be mounted while the keyboard is
  // already up (a session opened from a view that had it open), and the event
  // only reports CHANGES.
  systemKeyboardUp = systemKeyboardVisible(window) === true;

  term.attachCustomKeyEventHandler(keyEventHandler);
  container.addEventListener("keydown", keyEventHandler, true);
  container.addEventListener("keypress", keyEventHandler, true);
  container.addEventListener("keyup", keyEventHandler, true);
  container.addEventListener("beforeinput", inputEventHandler, true);
  container.addEventListener("input", inputEventHandler, true);
  container.addEventListener("paste", pasteEventHandler, true);

  // --- Stuck-modifier guard -------------------------------------------
  // webOS stamps pointer events with the surface's keyboard-modifier state,
  // and that state latches: hide the app mid-chord (Ctrl+Alt+H) or switch
  // away with Shift held and the matching keyup is delivered to whichever
  // app took over — every later click on THIS surface then claims the
  // modifier, and the latch even survives a full app restart (confirmed
  // live 2026-07-24: shiftKey:true on every click until a physical Shift
  // tap). xterm turns a Shift-click into forced local selection (NO mouse
  // report → tmux tab clicks dead while motion reports keep flowing) and
  // encodes Ctrl/Alt into the SGR button code (C-M-MouseDown1 — tmux has no
  // binding). Track which modifiers are REALLY held via keydown/keyup;
  // trusted pointer events claiming a modifier we never saw pressed are
  // swallowed and re-dispatched without it. Deliberate Shift-clicks from a
  // real keyboard still work — their keydown is visible here first.
  const modifierDown = { Shift: false, Control: false, Alt: false, Meta: false };
  function trackModifierKey(event) {
    if (!(event.key in modifierDown)) return;
    modifierDown[event.key] = event.type === "keydown";
  }
  // On blur/background every "held" assumption is void — the release will
  // happen while some other app has the keyboard.
  function resetModifierTracking() {
    modifierDown.Shift = false;
    modifierDown.Control = false;
    modifierDown.Alt = false;
    modifierDown.Meta = false;
  }
  const modifierVisibilityListener = () => {
    if (document.hidden) resetModifierTracking();
  };
  function strippedPointerClone(event) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      buttons: event.buttons,
      relatedTarget: event.relatedTarget || null,
    };
    if (event.type === "wheel") {
      init.deltaX = event.deltaX;
      init.deltaY = event.deltaY;
      init.deltaZ = event.deltaZ;
      init.deltaMode = event.deltaMode;
      return new WheelEvent("wheel", init);
    }
    return new MouseEvent(event.type, init);
  }
  function stuckModifierGuard(event) {
    if (!event.isTrusted) return; // our own re-dispatch below
    const stuck =
      (event.shiftKey && !modifierDown.Shift) ||
      (event.ctrlKey && !modifierDown.Control) ||
      (event.altKey && !modifierDown.Alt) ||
      (event.metaKey && !modifierDown.Meta);
    if (!stuck) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.type === "mousedown" && debugLog) {
      debugLog("term_stuck_modifier_stripped", {
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
    }
    try {
      event.target.dispatchEvent(strippedPointerClone(event));
    } catch (e) {
      /* clone constructor unavailable — original event was already stopped */
    }
  }
  const STUCK_GUARD_EVENTS = [
    "mousedown",
    "mouseup",
    "mousemove",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "wheel",
  ];
  for (const type of STUCK_GUARD_EVENTS) {
    container.addEventListener(type, stuckModifierGuard, true);
  }
  window.addEventListener("keydown", trackModifierKey, true);
  window.addEventListener("keyup", trackModifierKey, true);
  window.addEventListener("blur", resetModifierTracking);
  document.addEventListener("visibilitychange", modifierVisibilityListener, true);
  // Debug-only forensics for the "tmux tab clicks dead after resume" family:
  // records what a mouse report would be computed from (active tracking
  // protocol, renderer dimensions, resulting cell), so a broken episode can be
  // diagnosed from the persisted debug log instead of by live reproduction.
  // debugEvent() no-ops when debug logging is off; clicks are rare enough that
  // building the payload unconditionally does not matter.
  if (debugLog) {
    container.addEventListener(
      "mousedown",
      (event) => {
        let protocol = null;
        let reportCoords = null;
        try {
          const core = term._core;
          protocol =
            core && core.coreMouseService
              ? core.coreMouseService.activeProtocol
              : null;
          if (core && core._mouseService && core.screenElement) {
            reportCoords =
              core._mouseService.getMouseReportCoords(event, core.screenElement) ||
              null;
          }
        } catch (e) {
          /* diagnostics only */
        }
        debugLog("term_mousedown_diag", {
          clientX: event.clientX,
          clientY: event.clientY,
          // Modifier flags matter: xterm encodes them into the SGR button
          // code (shift +4, alt +8, ctrl +16), and tmux has no binding for
          // e.g. C-M-MouseDown1Status — a modifier stuck since a Ctrl+Alt+H
          // hide (keyups delivered elsewhere) silently kills tab clicks
          // while motion reports keep flowing.
          button: event.button,
          buttons: event.buttons,
          isTrusted: event.isTrusted,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          targetClass:
            (event.target && String(event.target.className || event.target.tagName)) ||
            null,
          protocol,
          reportCoords,
          cols: term.cols,
          rows: term.rows,
          dims: rendererDimsSnapshot(),
        });
      },
      true,
    );
  }
  // Note: keydown/keypress are intentionally NOT registered on document or
  // window. The global Esc/keyboard guard lives in src/main.js so it can
  // run before any platform Back-mapping consumes the key. We still need
  // keyup at document/window scope so Ctrl-key release tracking works
  // even if focus has wandered out of the terminal frame.
  document.addEventListener("keyup", keyEventHandler, true);
  document.addEventListener("beforeinput", inputEventHandler, true);
  document.addEventListener("input", inputEventHandler, true);
  window.addEventListener("keyup", keyEventHandler, true);
  window.addEventListener("blur", resetControlTracking);
  window.addEventListener("resize", resizeListener);

  // webOS 25 collapses a backgrounded WebView to 0×0 and re-expands the
  // container in several steps on resume, but the *window* size never changes
  // so no `resize` event fires for the box growing back. The timed
  // resyncViewport() kick stops at the first non-collapsed layout, which can be
  // an intermediate size — leaving renderService.dimensions (hence tmux
  // mouse-mode click-cell mapping) stale once the container settles at full
  // size. Observe the container box directly and re-fit on every real size
  // change so the final layout always wins.
  let resizeObserver = null;
  let observerFitTimer = null;
  if (typeof ResizeObserver === "function") {
    let lastW = 0;
    let lastH = 0;
    resizeObserver = new ResizeObserver((entries) => {
      if (disposed || !entries.length) return;
      const box = entries[entries.length - 1].contentRect;
      // Ignore the 0×0 background collapse — but forget the cached size while
      // doing so. Otherwise a resume back to the *same* geometry (the normal
      // case, since the window size is persisted) is swallowed by the dedup
      // below, and the corrective re-fit this observer exists to provide never
      // runs.
      if (box.width < 1 || box.height < 1) {
        lastW = 0;
        lastH = 0;
        return;
      }
      if (Math.abs(box.width - lastW) < 1 && Math.abs(box.height - lastH) < 1) return;
      lastW = box.width;
      lastH = box.height;
      if (observerFitTimer) clearTimeout(observerFitTimer);
      observerFitTimer = setTimeout(() => {
        observerFitTimer = null;
        if (disposed) return;
        try {
          remeasureCharSize();
          fitToContainer();
          // Same-size fits are a no-op in term.resize(); re-derive the
          // renderer dimensions explicitly (see refreshRendererDimensions).
          refreshRendererDimensions();
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch (e) {
          /* terminal may be mid-teardown during a relaunch transition */
        }
      }, 60);
    });
    try {
      resizeObserver.observe(container);
    } catch (e) {
      resizeObserver = null;
    }
  }

  fitToContainer();
  loadTerminalFont()
    .then(() => {
      refreshTerminal();
      scheduleFontRefresh(120);
      scheduleFontRefresh(650);
    })
    .catch(() => {});
  focusContainer();
  function getFontSize() {
    return Number(term.options.fontSize) || initialFontSize;
  }

  function setFontSize(next) {
    if (disposed) return getFontSize();
    const size = clampFontSize(next);
    if (size === getFontSize()) return size;
    term.options.fontSize = size;
    // NO clearTextureAtlas here. The atlas is keyed on the font options and
    // the cell metrics (WebglRenderer._refreshCharAtlas -> acquireTextureAtlas),
    // so a size change already hands out a different atlas — and a freshly
    // acquired one has just been warmUp()'d. Clearing it threw that away and
    // made the following refresh rasterise every glyph a second time, which
    // measured ~1 s of the ~1.2 s a size step cost on the TV.
    try {
      fitToContainer();
      term.refresh(0, Math.max(0, term.rows - 1));
      scheduleFontRefresh(80);
    } catch (e) {
      /* terminal may be disposed during a relaunch transition */
    }
    return size;
  }

  return {
    term,
    fitToContainer,
    getFontSize,
    setFontSize,
    resyncViewport,
    rowsElement,
    screenElement,
    setTheme(palette) {
      if (disposed || !palette) return;
      try {
        lastPalette = palette;
        // On the WebGL renderer the foreground never reaches xterm as itself:
        // it is part of the glyph atlas's cache key, and moving it disposed
        // the atlas and re-rasterised every glyph on screen (~450 ms measured
        // on the TV, at the feed's setTheme cadence). pinTheme holds the key
        // still and carries the real foreground into the cells as flat ink;
        // cursor and selection pass through and stay live.
        term.options.theme =
          webglInk && webglInk.active() ? webglInk.pinTheme(palette) : palette;
        // Before the refresh: the rules describe slots 0-15 and the inverse
        // default from this very palette, so they have to be in place by the
        // time the rows are rebuilt. Always the caller's palette — the
        // stylesheet only matters to the DOM renderer, which must come back
        // to the real foreground, never the pinned one.
        applyCellBackgroundCss(palette);
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch (e) {
        /* terminal may be mid-teardown during a relaunch transition */
      }
    },
    // A deliberate theme change, as opposed to the feed drifting. Call it before
    // setTheme: on the WebGL renderer the palette's foreground reaches the
    // glyphs as flat ink rather than as xterm's foreground, and that ink is
    // rationed by an adoption deadband no theme in the registry is far enough
    // away to clear (see adoptFlatInk). Without this the theme button changes
    // the background, all 16 ANSI slots, the cursor and the chrome — and leaves
    // the body text on the previous theme's colour.
    adoptThemeInk(palette) {
      if (disposed || !palette) return;
      try {
        if (webglInk && webglInk.active()) webglInk.adoptFlatInk(palette);
      } catch (e) {
        /* renderer mid-teardown; the next enable() seeds the ink anyway */
      }
    },
    // Chameleon asks for the renderer that can carry per-glyph ink cheaply, and
    // gets told which one it actually got: WebGL2 can be missing, refused, or
    // lost at any moment, and the CSS ink path is still there for all of those.
    // Idempotent both ways — the theme controller calls it on every theme
    // change without tracking what is currently live.
    setGlyphRenderer(mode) {
      if (disposed) return "dom";
      if (mode === "webgl") {
        if (!webglInk) webglInk = createWebglInk({ term, onDebugEvent: debugLog, onDomRestored });
        if (webglInk.active()) return "webgl";
        if (!webglInk.enable()) return "dom";
        webglInk.setCellAlpha(readCellAlpha());
        // The swap replaced the renderer under the render service; re-derive
        // dimensions the same way a resume does.
        refreshRendererDimensions();
        return "webgl";
      }
      if (webglInk && webglInk.active()) webglInk.disable();
      return "dom";
    },

    // How the ink field should be handed over: as a texture the GPU samples, or
    // as an image the compositor clips to the text.
    inkMode() {
      return webglInk && webglInk.active() ? "webgl" : "image";
    },

    setInkTexture(texture) {
      if (disposed || !webglInk) return;
      webglInk.setInk(texture);
    },

    setCellAlpha(alpha) {
      if (disposed || !webglInk) return;
      webglInk.setCellAlpha(alpha);
    },

    focus: focusContainer,
    // On-screen keyboard, for use without a USB keyboard. Toggled from the
    // window chrome; returns the state it settled in so the caller can paint
    // the button without asking again.
    toggleOsk() {
      return oskActive ? closeOsk() : openOsk();
    },
    oskActive() {
      return oskActive;
    },
    setOskStateHandler(handler) {
      onOskStateChange = typeof handler === "function" ? handler : null;
    },
    setControlDataHandler(handler) {
      controlDataHandler = handler || null;
    },
    setResizeHandler(handler) {
      resizeHandler = handler || null;
    },
    setSearchRequestHandler(handler) {
      searchRequestHandler = handler || null;
    },
    setNewTabRequestHandler(handler) {
      newTabRequestHandler = handler || null;
    },
    searchAvailable: Boolean(searchAddon),
    findNext(query, options) {
      if (disposed || !searchAddon || !query) return false;
      try {
        return searchAddon.findNext(query, options);
      } catch (e) {
        return false;
      }
    },
    findPrevious(query, options) {
      if (disposed || !searchAddon || !query) return false;
      try {
        return searchAddon.findPrevious(query, options);
      } catch (e) {
        return false;
      }
    },
    clearSearch() {
      if (disposed || !searchAddon) return;
      try {
        if (typeof searchAddon.clearDecorations === "function") {
          searchAddon.clearDecorations();
        }
        term.clearSelection();
      } catch (e) {
        /* ignore */
      }
    },
    dispose() {
      disposed = true;
      stopOskPolling();
      oskProxy.removeEventListener("input", oskInputListener);
      oskProxy.removeEventListener("compositionstart", oskCompositionStart);
      oskProxy.removeEventListener("compositionend", oskCompositionEnd);
      document.removeEventListener(
        KEYBOARD_STATE_EVENT,
        handleKeyboardStateChange,
        true,
      );
      if (oskProxy.parentNode) oskProxy.parentNode.removeChild(oskProxy);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (observerFitTimer) clearTimeout(observerFitTimer);
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch (e) { /* ignore */ }
      }
      while (refreshTimers.length) clearTimeout(refreshTimers.pop());
      terminalResize.dispose();
      container.removeEventListener("keydown", keyEventHandler, true);
      container.removeEventListener("keypress", keyEventHandler, true);
      container.removeEventListener("keyup", keyEventHandler, true);
      container.removeEventListener("beforeinput", inputEventHandler, true);
      container.removeEventListener("input", inputEventHandler, true);
      container.removeEventListener("paste", pasteEventHandler, true);
      document.removeEventListener("keyup", keyEventHandler, true);
      document.removeEventListener("beforeinput", inputEventHandler, true);
      document.removeEventListener("input", inputEventHandler, true);
      window.removeEventListener("keyup", keyEventHandler, true);
      window.removeEventListener("blur", resetControlTracking);
      window.removeEventListener("resize", resizeListener);
      for (const type of STUCK_GUARD_EVENTS) {
        container.removeEventListener(type, stuckModifierGuard, true);
      }
      window.removeEventListener("keydown", trackModifierKey, true);
      window.removeEventListener("keyup", trackModifierKey, true);
      window.removeEventListener("blur", resetModifierTracking);
      document.removeEventListener("visibilitychange", modifierVisibilityListener, true);
      if (inputSink.parentNode) inputSink.parentNode.removeChild(inputSink);
      // Before term.dispose(), not after: tearing the addon down while the
      // terminal is still whole is the path xterm supports, and it is what
      // releases the GL context rather than leaving one per closed tab.
      if (webglInk) {
        webglInk.dispose();
        webglInk = null;
      }
      term.dispose();
    },
  };
}
