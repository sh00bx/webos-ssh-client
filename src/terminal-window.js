// The terminal window chrome: wrapper/handles/toolbar/keybar/frame DOM,
// persisted geometry, opacity, fullscreen, drag-resize and drag-move. No Luna
// calls in this module — everything that must reach the service goes through
// the hooks handed to bindTerminal().
//
// Two-phase seam (load-bearing): createTerminalWindow() builds the DOM and
// wires only the listeners that do NOT need a terminal, so the toolbar is
// already live during the ≤1200ms font preload. bindTerminal() is called by
// the session controller after initTerminal() and wires everything whose
// handler needs the terminal for focus restore or size measurement. Do not
// collapse the two phases into one call.
//
// Focus invariant (see terminal.js on the non-editable input sink): every
// chrome control that can take DOM focus immediately gives it back —
// `event.currentTarget.blur(); terminal.focus();` — and the keybar buttons
// prevent focus entirely via mousedown→preventDefault. Any control added
// without this pattern swallows the next remote/keyboard event.
import {
  OPACITY_MIN,
  OPACITY_MAX,
  OPACITY_STEP,
  FLASH_MIN,
  FLASH_MAX,
  FLASH_STEP,
  SMOOTHING_MIN,
  SMOOTHING_MAX,
  SMOOTHING_STEP,
  clampOpacityPercent,
  loadOpacityPercent,
  saveOpacityPercent,
  opacityGlyphFor,
  loadKeyBarVisible,
  saveKeyBarVisible,
  loadFontSize,
  saveFontSize,
  loadWindowState,
  saveWindowState,
} from "./prefs.js";
import {
  clampBottom as clampBottomPure,
  clampHeight as clampHeightPure,
  clampRight as clampRightPure,
  clampWidth as clampWidthPure,
  normalizeEdgeOffset as normalizeEdgeOffsetPure,
  resizeAxis,
  snapBottom as snapBottomPure,
  snapRight as snapRightPure,
  restoredOffsets,
  GEOMETRY_LIMITS,
  FULLSCREEN_BREAKOUT_DISTANCE,
} from "./window-geometry.mjs";
import { cellAlphaFor } from "./cell-bg.mjs";
import {
  backdropSmoothingPercent,
  chameleonFlashPercent,
  cycleTheme,
  reactiveEnabled,
  reactiveLabel,
  registerThemeButton,
  setBackdropSmoothing,
  setChameleonFlash,
  setReactiveEnabled,
  unregisterThemeButton,
} from "./theme-controller.js";
import { isRemoteBackKey, printableDataFromKeyEvent } from "./keymap.mjs";
import {
  canBrowseFiles,
  isLocalSession,
  sessionShortLabel,
  sessionTitle,
} from "./session-label.mjs";
import { debugEvent } from "./debug.js";
const FONT_SIZE_STEP = 2;

// Key auto-repeat timing for the special-key bar (hold-to-repeat), roughly
// matching a physical keyboard's typematic defaults.
const KEYBAR_REPEAT_DELAY_MS = 400;
const KEYBAR_REPEAT_INTERVAL_MS = 90;
// Special-key bar for Magic-Remote-only use: keys a TV remote cannot produce.
// Arrow entries carry `cursor` so the send can honor DECCKM (application
// cursor keys mode, used by vim/tmux) at click time.
// `tip` says what the key DOES, not what it is: the label already says what it
// is, and "Esc" as a tooltip on a button reading "Esc" is noise.
const KEYBAR_KEYS = [
  { label: "Esc", data: "\x1b", tip: "Escape — leave insert mode, close a menu" },
  { label: "Tab", data: "\t", tip: "Tab — complete a path or command" },
  { label: "^C", data: "\x03", tip: "Ctrl+C — interrupt the running command" },
  { label: "↑", cursor: "A", tip: "Cursor up — previous command in the history" },
  { label: "↓", cursor: "B", tip: "Cursor down — next command in the history" },
  { label: "←", cursor: "D", tip: "Cursor left" },
  { label: "→", cursor: "C", tip: "Cursor right" },
  { label: "PgUp", data: "\x1b[5~", tip: "Page up in the scrollback" },
  { label: "PgDn", data: "\x1b[6~", tip: "Page down in the scrollback" },
];

export function createTerminalWindow({ root, debugEnabled, onHide, onDisconnect, onDebug }) {
  const wrapper = document.createElement("div");
  wrapper.className = "term-wrapper";

  // All four edges plus all four corners. The window is anchored by its
  // right/bottom offsets, so the n/w side of a handle only has to change the
  // size while the e/s side also walks the anchor — see startDrag(). The two
  // mixed corners (ne/sw) are just one sign of each kind.
  function makeHandle(name) {
    const el = document.createElement("div");
    el.className = `resize-handle ${name}`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  const handleNw = makeHandle("nw");
  const handleN = makeHandle("n");
  const handleNe = makeHandle("ne");
  const handleW = makeHandle("w");
  const handleE = makeHandle("e");
  const handleSw = makeHandle("sw");
  const handleS = makeHandle("s");
  const handleSe = makeHandle("se");

  // A corner is the meeting point of two edges, and the affordance should say
  // so: hovering (or dragging) a corner lights BOTH adjacent edge glows, not
  // just its own bracket — otherwise a corner reads as a decoration between
  // two grab zones rather than as the strongest grab zone of the three.
  const cornerCompanions = new Map([
    [handleNw, [handleN, handleW]],
    [handleNe, [handleN, handleE]],
    [handleSw, [handleS, handleW]],
    [handleSe, [handleS, handleE]],
  ]);
  function setCompanionsLit(handle, lit) {
    for (const edge of cornerCompanions.get(handle) || []) {
      edge.classList.toggle("edge-lit", lit);
    }
  }
  for (const corner of cornerCompanions.keys()) {
    corner.addEventListener("mouseenter", () => setCompanionsLit(corner, true));
    corner.addEventListener("mouseleave", () => setCompanionsLit(corner, false));
  }

  // Live grid readout while a resize drag is running: the size that matters
  // in a terminal is cols x rows, not pixels, and the pty reflows during the
  // drag anyway — so show the number the reflow just produced. ASCII "x" on
  // purpose: U+00D7 is exactly the kind of glyph this firmware's font tends
  // to be missing (see the svgIcon comment above).
  const resizeReadout = document.createElement("div");
  resizeReadout.className = "resize-readout";
  resizeReadout.setAttribute("aria-hidden", "true");
  let readoutFadeTimer = null;

  const toolbar = document.createElement("div");
  toolbar.className = "term-toolbar";

  // Hairline divider between toolbar clusters (zoom │ tabs │ view controls).
  function toolbarSeparator() {
    const el = document.createElement("span");
    el.className = "tb-sep";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  // Tab affordances are drawn, not typed. The webOS 25 font stack has no glyph
  // for several symbols that look obvious on a desktop: U+25AE (the terminal
  // marker that shipped in 0.6.1), U+21B5 and U+21BB all came back as the
  // .notdef box on this firmware. Width measurement can NOT detect that here —
  // the face is monospace, so the box and a real glyph share an advance and
  // only the rendered pixels differ (see tests/webos-glyphs.test.mjs). Rather
  // than keep a per-firmware allowlist for controls the user has to hit, the
  // icons that carry meaning are paths.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(paths, label) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    if (label) svg.setAttribute("data-icon", label);
    return svg;
  }
  const ICON_FOLDER = ["M1.8 12.6V4.2a.6.6 0 0 1 .6-.6h3.5l1.4 1.8H13.6a.6.6 0 0 1 .6.6v6.6a.6.6 0 0 1-.6.6H2.4a.6.6 0 0 1-.6-.6z"];
  const ICON_PROMPT = ["M3.2 4.8 6.6 8l-3.4 3.2", "M8.6 11.6h4.4"];
  const ICON_CLOSE = ["M4.4 4.4l7.2 7.2", "M11.6 4.4l-7.2 7.2"];

  // Terminator-style tab strip: one button per live service session plus a
  // "+" for a new one. The DOM lives here; the data and the actions come from
  // the session controller via setTabs() and the bindTerminal() hooks
  // (onSelectTab / onNewTab) — the chrome knows nothing about sessions.
  // Hidden until the first setTabs() delivers a session list. Appended to the
  // toolbar after the zoom group below.
  const tabsGroup = document.createElement("div");
  tabsGroup.className = "term-tabs";
  tabsGroup.hidden = true;
  let tabHooks = null;
  // Set in bindTerminal(): the window-move drag core, callable with the
  // original mousedown event. Lets the ACTIVE tab double as a move grip.
  let windowMoveStarter = null;

  // Click-vs-drag disambiguation for the active tab: only engage the window
  // move once the pointer has actually travelled, so a plain click still
  // lands as a click (focus restore). 5px Manhattan distance — the Magic
  // Remote jitters a little on every press.
  function armTabMove(downEvent) {
    const sx = downEvent.clientX;
    const sy = downEvent.clientY;
    function onMove(ev) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      cleanup();
      if (windowMoveStarter) windowMoveStarter(downEvent);
    }
    function cleanup() {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", cleanup, true);
    }
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", cleanup, true);
  }
  let boundTerminalRef = null;
  // A tab is a (session, mode) pair, not a session. One connection can show two
  // tabs — the shell and the file explorer — because they are two views of the
  // same authenticated transport (see file-explorer.js). `key` is what identity
  // is compared on; `sessionId` is what the service is told.
  let tabsState = { tabs: [], activeKey: null };

  // Tabs speak the user's own status-line dialect: `1:192.168.0.218*` like a
  // tmux window list — index, host, `*` on the active one. The label shows
  // the FULL host; Chrome-style width handling lives in the CSS (tabs grow
  // to a max that fits a full IPv4, and shrink evenly with ellipsis when the
  // strip runs out of room). user@host:port stays in the tooltip.
  function renderTabs() {
    tabsGroup.textContent = "";
    if (!tabsState.tabs.length) {
      tabsGroup.hidden = true;
      return;
    }
    tabsGroup.hidden = false;
    for (const [index, s] of tabsState.tabs.entries()) {
      const btn = document.createElement("button");
      btn.type = "button";
      const isActive = Boolean(s.key) && s.key === tabsState.activeKey;
      const isFiles = s.mode === "scp";
      const isLocal = isLocalSession(s);
      btn.className =
        "term-tab" +
        (isActive ? " active" : "") +
        (isFiles ? " term-tab-files" : "") +
        (isLocal ? " term-tab-local" : "");
      btn.title = `${isFiles ? "Files — " : ""}${sessionTitle(s)}`;
      const label = document.createElement("span");
      label.className = "term-tab-label";
      // The file tab wears the same index as its shell — they are one
      // connection, and numbering them separately would suggest two logins.
      label.textContent = `${index + 1}:${sessionShortLabel(s)}${isActive ? "*" : ""}`;
      // Which of the pair is this? Identity on the left, action on the right —
      // so the folder that MARKS a files tab and the folder that OPENS one are
      // told apart by position and by the fact that only the action is a
      // button. A shell tab carries no marker: the absence is the marker, and
      // two icons per tab would not survive the width budget anyway.
      const parts = [];
      if (isFiles) {
        const mark = svgIcon(ICON_FOLDER, "files");
        mark.setAttribute("class", "term-tab-icon");
        parts.push(mark);
      }
      // The mode switch: an SSH tab offers its files, a files tab offers its
      // shell. Same button, opposite direction — which is what makes the pair
      // feel like one connection rather than two unrelated tabs. The icon shows
      // the DESTINATION, so it always answers "where does this take me".
      //
      // A local shell has no second view to swap to (no SFTP without an SSH
      // transport — see canBrowseFiles), so it gets no swap control at all
      // rather than one that reports a failure when pressed.
      const swap = canBrowseFiles(s) || isFiles ? document.createElement("span") : null;
      if (swap) {
        swap.className = "term-tab-swap";
        swap.appendChild(svgIcon(isFiles ? ICON_PROMPT : ICON_FOLDER, isFiles ? "terminal" : "files"));
        swap.setAttribute("role", "button");
        swap.setAttribute("aria-label", isFiles ? "Open terminal for this host" : "Open files for this host");
        swap.dataset.tip = isFiles
        ? "Switch to this host's shell — same connection"
        : "Browse this host's files — same connection, no second login";
      }
      // Chrome-style close on the right of every tab. A nested <button> would
      // be invalid HTML, so it is a span and the tab's click handler routes on
      // the target.
      const closeX = document.createElement("span");
      closeX.className = "term-tab-x";
      closeX.appendChild(svgIcon(ICON_CLOSE, "close"));
      closeX.setAttribute("role", "button");
      closeX.setAttribute("aria-label", "Close tab");
    // Closing a files tab is not closing a session: the shell tab beside it,
    // and the connection both share, stay exactly where they are.
    closeX.dataset.tip = isFiles ? "Close this view, keep the connection" : "Disconnect and close this tab";
      btn.append(...parts, label, ...(swap ? [swap] : []), closeX);
      btn.addEventListener("click", (event) => {
        // Focus invariant: give DOM focus straight back (see header comment).
        event.currentTarget.blur();
        const hit = (sel) =>
          event.target && event.target.closest && event.target.closest(sel);
        if (hit(".term-tab-x")) {
          if (tabHooks && tabHooks.onCloseTab) tabHooks.onCloseTab(s.key);
          return;
        }
        if (hit(".term-tab-swap")) {
          const hook = isFiles ? tabHooks && tabHooks.onOpenTerminal : tabHooks && tabHooks.onOpenFiles;
          if (hook) hook(s.sessionId);
          return;
        }
        if (isActive) {
          if (boundTerminalRef) boundTerminalRef.focus();
          return;
        }
        if (tabHooks && tabHooks.onSelectTab) tabHooks.onSelectTab(s.key);
      });
      // Hold-and-drag on the ACTIVE tab moves the window (its click already
      // belongs to us — inactive tabs keep their switch semantics untouched).
      if (isActive) {
        btn.addEventListener("mousedown", (event) => {
          if (event.button !== 0 && event.button !== undefined) return;
          if (
            event.target &&
            event.target.closest &&
            (event.target.closest(".term-tab-x") || event.target.closest(".term-tab-swap"))
          ) {
            return;
          }
          armTabMove(event);
        });
      }
      tabsGroup.appendChild(btn);
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "term-tab term-tab-new";
    addBtn.textContent = "+";
    addBtn.dataset.tip = "Open another connection — back to the login form";
    addBtn.setAttribute("aria-label", "New tab");
    addBtn.addEventListener("click", (event) => {
      event.currentTarget.blur();
      if (tabHooks && tabHooks.onNewTab) tabHooks.onNewTab();
    });
    tabsGroup.appendChild(addBtn);
  }

  // Called by the session controller whenever the service's session list is
  // (re)fetched. Safe before bindTerminal() — clicks simply no-op until the
  // hooks exist.
  function setTabs(tabs, activeKey) {
    tabsState = {
      tabs: Array.isArray(tabs) ? tabs : [],
      activeKey: activeKey || null,
    };
    renderTabs();
  }

  const zoomGroup = document.createElement("div");
  zoomGroup.className = "zoom-group";
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.type = "button";
  zoomOutBtn.textContent = "A−";
  zoomOutBtn.dataset.tip = "Smaller terminal font";
  zoomOutBtn.setAttribute("aria-label", "Decrease font size");
  const fontReadout = document.createElement("span");
  fontReadout.className = "font-readout";
  const zoomInBtn = document.createElement("button");
  zoomInBtn.type = "button";
  zoomInBtn.textContent = "A+";
  zoomInBtn.dataset.tip = "Larger terminal font";
  zoomInBtn.setAttribute("aria-label", "Increase font size");
  zoomGroup.append(zoomOutBtn, fontReadout, zoomInBtn);
  toolbar.appendChild(zoomGroup);

  // Cluster order: zoom │ tabs (flexes, fills the middle) │ view controls,
  // then the session buttons on the far right.
  toolbar.appendChild(toolbarSeparator());
  toolbar.appendChild(tabsGroup);
  toolbar.appendChild(toolbarSeparator());

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.className = "icon-btn";
  fullscreenBtn.dataset.tip = "Fill the screen, or go back to a window (drag the toolbar to tear a full-screen window loose)";
  fullscreenBtn.setAttribute("aria-label", "Toggle fullscreen");
  toolbar.appendChild(fullscreenBtn);

  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "icon-btn theme-btn";
  themeBtn.textContent = "◑";
  // Marks this copy as the one carrying the long-press popover, so its tooltip
  // says so (see updateThemeButton). Must be set BEFORE registering: the
  // registration writes the first tooltip text.
  themeBtn.dataset.longpress = "1";
  registerThemeButton(themeBtn);
  // NOTE: the click listener is attached in bindTerminal() — the toolbar is
  // already live during the font-preload await, and the handler needs the
  // terminal for focus restore.
  toolbar.appendChild(themeBtn);

  // --- Backdrop reaction (long-press on the theme button) -------------------
  // A plain click cycles the theme (wired in bindTerminal); HOLDING the
  // button opens this popover with the effect's on/off toggle and its loudness
  // slider. Phase-1 territory on purpose: nothing here needs the terminal — the
  // controls talk to the theme controller, and focus restore on close goes
  // through boundTerminalRef, which is simply null before bind.
  const THEME_LONGPRESS_MS = 450;
  const flashPop = document.createElement("div");
  flashPop.className = "flash-pop";
  // The toggle doubles as the label, and that is the point: every theme reacts
  // in its own way now, so the thing being switched has a name ("bloom",
  // "neon", …) and the popover is where the user finds out which one is on.
  // Plain text, not a glyph or a checkbox: the bundled fonts guarantee very few
  // symbols (see the tofu note in the platform gotchas), and a real <input
  // type=checkbox> would need its own remote-focus and hit-target handling
  // where a button already has both.
  const flashToggle = document.createElement("button");
  flashToggle.type = "button";
  flashToggle.className = "flash-toggle";
  const flashName = document.createElement("span");
  flashName.className = "flash-name";
  const flashState = document.createElement("span");
  flashState.className = "flash-state";
  flashToggle.append(flashName, flashState);
  // Two sliders now, so each gets a name: loudness (how much colour the effect
  // is allowed to use) and smoothing (how gently it follows the picture). One
  // row each, built the same way.
  function buildFlashRow(label, min, max, step) {
    const row = document.createElement("div");
    row.className = "flash-row";
    const name = document.createElement("span");
    name.className = "flash-label";
    name.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "flash-slider";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    const readout = document.createElement("span");
    readout.className = "flash-readout";
    row.append(name, slider, readout);
    return { row, slider, readout };
  }

  const flashRow = buildFlashRow("colour", FLASH_MIN, FLASH_MAX, FLASH_STEP);
  const smoothRow = buildFlashRow("smooth", SMOOTHING_MIN, SMOOTHING_MAX, SMOOTHING_STEP);
  const flashSlider = flashRow.slider;
  const smoothSlider = smoothRow.slider;
  flashPop.append(flashToggle, flashRow.row, smoothRow.row);
  wrapper.appendChild(flashPop);

  let flashPopOpen = false;
  let themePressTimer = null;
  // Set when a long-press consumed the interaction: the browser fires a click
  // on release anyway, and that click must not also cycle the theme.
  let suppressThemeClick = false;

  function updateFlashReadout(value) {
    flashRow.readout.textContent = `${value}%`;
    const title = `Backdrop colour: ${value}%`;
    flashSlider.title = title;
    flashSlider.setAttribute("aria-label", title);
  }

  function updateSmoothReadout(value) {
    smoothRow.readout.textContent = `${value}%`;
    const title = `Backdrop smoothing: ${value}%`;
    smoothSlider.title = title;
    smoothSlider.setAttribute("aria-label", title);
  }

  // Both the state and the NAME are refreshed here, not just at build time: the
  // variant belongs to the active theme, and the theme can have been cycled
  // several times since this popover was last open.
  function updateFlashToggle() {
    const on = reactiveEnabled();
    const name = reactiveLabel();
    flashName.textContent = name;
    flashState.textContent = on ? "on" : "off";
    flashToggle.classList.toggle("on", on);
    flashToggle.setAttribute("aria-pressed", on ? "true" : "false");
    // The slider still works while the effect is off — it sets the loudness the
    // next switch-on will use — so it is dimmed rather than disabled: a
    // disabled control cannot take remote focus, and losing focus inside an
    // open popover on a TV is a dead end.
    flashPop.classList.toggle("off", !on);
    const title = `Backdrop reaction (${name}): ${on ? "on" : "off"}`;
    flashToggle.title = title;
    flashToggle.setAttribute("aria-label", title);
  }

  function onFlashDocPointerDown(event) {
    if (!flashPop.contains(event.target) && !themeBtn.contains(event.target)) {
      closeFlashPop(true);
    }
  }

  function closeFlashPop(refocus) {
    if (!flashPopOpen) return;
    flashPopOpen = false;
    flashPop.classList.remove("open");
    document.removeEventListener("pointerdown", onFlashDocPointerDown, true);
    if (refocus && boundTerminalRef) boundTerminalRef.focus();
  }

  function openFlashPop() {
    if (flashPopOpen) return;
    flashPopOpen = true;
    const value = chameleonFlashPercent();
    flashSlider.value = String(value);
    updateFlashReadout(value);
    const smoothValue = backdropSmoothingPercent();
    smoothSlider.value = String(smoothValue);
    updateSmoothReadout(smoothValue);
    updateFlashToggle();
    // Open before measuring: a display:none element has no offsetWidth.
    flashPop.classList.add("open");
    const btnRect = themeBtn.getBoundingClientRect();
    const wrapRect = wrapper.getBoundingClientRect();
    flashPop.style.top = `${Math.round(btnRect.bottom - wrapRect.top + 6)}px`;
    const centered = Math.round(
      btnRect.left - wrapRect.left + btnRect.width / 2 - flashPop.offsetWidth / 2,
    );
    const maxLeft = wrapper.clientWidth - flashPop.offsetWidth - 8;
    flashPop.style.left = `${Math.max(8, Math.min(centered, maxLeft))}px`;
    document.addEventListener("pointerdown", onFlashDocPointerDown, true);
    // The slider HOLDS focus while the popover is open — a deliberate
    // exception to the give-focus-back invariant at the top of this file:
    // remote/keyboard arrows are how the value is adjusted without dragging.
    // Closing (outside click, Esc/Back, theme click) restores the terminal.
    flashSlider.focus();
    debugEvent("ui_flash_open", {
      percent: value,
      smoothing: smoothValue,
      reactive: reactiveEnabled(),
    });
  }

  function cancelThemePress() {
    if (themePressTimer) {
      clearTimeout(themePressTimer);
      themePressTimer = null;
    }
  }

  themeBtn.addEventListener("pointerdown", () => {
    suppressThemeClick = false;
    cancelThemePress();
    themePressTimer = setTimeout(() => {
      themePressTimer = null;
      suppressThemeClick = true;
      openFlashPop();
    }, THEME_LONGPRESS_MS);
  });
  themeBtn.addEventListener("pointerup", cancelThemePress);
  themeBtn.addEventListener("pointerleave", cancelThemePress);
  themeBtn.addEventListener("pointercancel", cancelThemePress);

  // Switching the effect on or off keeps the popover open and focus inside it:
  // the toggle and the slider are one control surface, and the usual case after
  // switching back on is reaching straight for the loudness.
  flashToggle.addEventListener("click", () => {
    setReactiveEnabled(!reactiveEnabled());
    updateFlashToggle();
    flashSlider.focus();
  });
  flashToggle.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || isRemoteBackKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      closeFlashPop(true);
    }
  });

  flashSlider.addEventListener("input", () => {
    updateFlashReadout(setChameleonFlash(flashSlider.value));
  });
  flashSlider.addEventListener("change", () => {
    updateFlashReadout(setChameleonFlash(flashSlider.value));
  });
  smoothSlider.addEventListener("input", () => {
    updateSmoothReadout(setBackdropSmoothing(smoothSlider.value));
  });
  smoothSlider.addEventListener("change", () => {
    updateSmoothReadout(setBackdropSmoothing(smoothSlider.value));
  });

  // Up/Down move between the two sliders. They have to be taken away from the
  // range input first: Chromium treats Up and Down as increment/decrement, so
  // without this the second row would be unreachable with a remote — the
  // popover holds focus by design (see openFlashPop) and left/right is the only
  // pair the user gets back.
  function wireSliderKeys(slider, above, below) {
    slider.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || isRemoteBackKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        closeFlashPop(true);
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      // preventDefault BEFORE resolving the target, not after. At the end of the
      // run there is no neighbour, and letting that key through hands it back to
      // Chromium's increment/decrement — so the one press that means "is there
      // another row?" silently edited the value it was navigating past.
      event.preventDefault();
      event.stopPropagation();
      const target = event.key === "ArrowUp" ? above : below;
      if (target) target.focus();
    });
  }

  wireSliderKeys(flashSlider, flashToggle, smoothSlider);
  wireSliderKeys(smoothSlider, flashSlider, null);
  // Down from the toggle lands on the first slider, so the whole popover is one
  // vertical run.
  flashToggle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    flashSlider.focus();
  });

  const opacityGroup = document.createElement("div");
  opacityGroup.className = "opacity-group";
  const opacityGlyph = document.createElement("span");
  opacityGlyph.className = "opacity-glyph";
  opacityGlyph.setAttribute("aria-hidden", "true");
  const opacitySlider = document.createElement("input");
  opacitySlider.type = "range";
  opacitySlider.className = "opacity-slider";
  opacitySlider.min = String(OPACITY_MIN);
  opacitySlider.max = String(OPACITY_MAX);
  opacitySlider.step = String(OPACITY_STEP);
  // NOTE: listeners attached in bindTerminal(), alongside the theme button,
  // for the same reason (needs the terminal for focus restore).
  opacityGroup.append(opacityGlyph, opacitySlider);
  toolbar.appendChild(opacityGroup);

  const keyBarToggle = document.createElement("button");
  keyBarToggle.type = "button";
  keyBarToggle.className = "icon-btn keybar-toggle";
  keyBarToggle.textContent = "⌨";
  keyBarToggle.dataset.tip = "Row of keys a remote cannot send: Esc, Tab, ^C, arrows, PgUp/PgDn";
  keyBarToggle.setAttribute("aria-label", "Toggle special-key bar");
  toolbar.appendChild(keyBarToggle);

  // The system on-screen keyboard. Distinct from the key bar next to it: that
  // one sends the keys a remote CANNOT produce (Esc, Tab, ^C), this one is how
  // you type letters at all when there is no USB keyboard attached. Only
  // ASCII in the glyph — the bundled fonts are the only ones on the device and
  // a keyboard emoji is not in them (see the glyph-tofu note in the platform
  // gotchas), so this is drawn as text.
  const oskToggle = document.createElement("button");
  oskToggle.type = "button";
  oskToggle.className = "icon-btn osk-toggle";
  oskToggle.textContent = "abc";
  oskToggle.dataset.tip = "Type with the webOS on-screen keyboard when no USB keyboard is attached";
  oskToggle.setAttribute("aria-label", "Toggle the on-screen keyboard");
  toolbar.appendChild(oskToggle);

  const keyBar = document.createElement("div");
  keyBar.className = "term-keybar";
  keyBar.setAttribute("aria-label", "Special keys");
  const keyBarButtons = KEYBAR_KEYS.map((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = entry.label;
    btn.dataset.tip = entry.tip;
    // Keep DOM focus on the terminal: a focused button would swallow the
    // next remote/keyboard event.
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    keyBar.appendChild(btn);
    return { btn, entry };
  });
  let keyBarVisible = loadKeyBarVisible();

  function applyKeyBarVisibility() {
    keyBar.hidden = !keyBarVisible;
    wrapper.classList.toggle("keybar-on", keyBarVisible);
    keyBarToggle.classList.toggle("active", keyBarVisible);
  }

  let opacityPercent = loadOpacityPercent();

  function applyOpacity() {
    wrapper.style.setProperty("--term-alpha", String(opacityPercent / 100));
    // Filled cell backgrounds resolve their alpha from this variable — both the
    // .xterm-bg-* rules and the patched inline styles (cell-bg.mjs) — so the
    // grid follows the slider without a re-render.
    const cellAlpha = cellAlphaFor(opacityPercent);
    wrapper.style.setProperty("--term-cell-alpha", String(cellAlpha));
    // The DOM renderer re-resolves that variable on its own; the WebGL one
    // writes cell backgrounds as vertex colours and has to be told, or the
    // slider would appear to do nothing to filled cells until the next line of
    // output happened to rebuild the rectangles. Null before bindTerminal, and
    // a no-op unless the WebGL renderer is actually live.
    if (boundTerminalRef && typeof boundTerminalRef.setCellAlpha === "function") {
      boundTerminalRef.setCellAlpha(cellAlpha);
    }
    opacitySlider.value = String(opacityPercent);
    opacityGlyph.textContent = opacityGlyphFor(opacityPercent);
    const title = `Panel opacity: ${opacityPercent}%`;
    opacitySlider.title = title;
    opacitySlider.setAttribute("aria-label", title);
  }

  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.textContent = "Hide";
  hideBtn.dataset.tip = "Put the window away and leave the session running (Ctrl+Alt+H or Back)";
  hideBtn.addEventListener("click", onHide);
  const disconnectBtn = document.createElement("button");
  disconnectBtn.type = "button";
  disconnectBtn.className = "tb-danger";
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.dataset.tip = "Log out and end this session (Ctrl+Alt+Q or Ctrl+Alt+X)";
  disconnectBtn.addEventListener("click", onDisconnect);
  if (debugEnabled) {
    const debugBtn = document.createElement("button");
    debugBtn.type = "button";
    debugBtn.textContent = "Debug";
    debugBtn.dataset.tip = "Show the in-app event log (Ctrl+Alt+D)";
    debugBtn.addEventListener("click", onDebug);
    toolbar.appendChild(debugBtn);
  }
  toolbar.appendChild(hideBtn);
  toolbar.appendChild(disconnectBtn);

  const frame = document.createElement("div");
  frame.className = "term-frame";
  frame.textContent = "Loading terminal...";
  // The file explorer mounts HERE rather than replacing the frame: switching
  // between a host's shell tab and its files tab must not tear the terminal
  // down. xterm loses its scrollback, its pty size and its renderer on unmount,
  // and re-creating all of that to look at a directory listing would make the
  // pair of tabs feel like two logins — which is exactly what sharing one
  // connection is meant to avoid. So both live in the window at once and only
  // one is displayed.
  const filesHost = document.createElement("div");
  filesHost.className = "term-files";
  filesHost.hidden = true;
  wrapper.append(
    handleNw,
    handleN,
    handleNe,
    handleW,
    handleE,
    handleSw,
    handleS,
    handleSe,
    toolbar,
    keyBar,
    frame,
    filesHost,
    resizeReadout,
  );
  applyKeyBarVisibility();
  applyOpacity();
  root.appendChild(wrapper);

  const persistedWindow = loadWindowState();
  const persistedFontSize = loadFontSize();
  let windowState = {
    width: Number.isFinite(persistedWindow && persistedWindow.width)
      ? persistedWindow.width
      : null,
    height: Number.isFinite(persistedWindow && persistedWindow.height)
      ? persistedWindow.height
      : null,
    right: normalizeEdgeOffset(persistedWindow && persistedWindow.right),
    bottom: normalizeEdgeOffset(persistedWindow && persistedWindow.bottom),
    fullscreen: persistedWindow
      ? persistedWindow.fullscreen === true
      : true,
  };
  // Thin viewport-aware wrappers over the pure maths in window-geometry.mjs.
  function normalizeEdgeOffset(value) {
    return normalizeEdgeOffsetPure(value);
  }

  function clampWidth(w) {
    return clampWidthPure(w, window.innerWidth);
  }

  function clampHeight(h) {
    return clampHeightPure(h, window.innerHeight);
  }

  function clampRight(r, currentWidth) {
    const w = Number.isFinite(currentWidth) ? currentWidth : wrapper.offsetWidth;
    return clampRightPure(r, w, window.innerWidth);
  }

  function clampBottom(b, currentHeight) {
    const h = Number.isFinite(currentHeight) ? currentHeight : wrapper.offsetHeight;
    return clampBottomPure(b, h, window.innerHeight);
  }

  function snapRight(r, w) {
    return snapRightPure(r, w, window.innerWidth);
  }

  function snapBottom(b, h) {
    return snapBottomPure(b, h, window.innerHeight);
  }

  function applyWindowGeometry() {
    if (windowState.fullscreen) {
      wrapper.classList.add("fullscreen");
      wrapper.style.width = "";
      wrapper.style.height = "";
      wrapper.style.right = "";
      wrapper.style.bottom = "";
    } else {
      wrapper.classList.remove("fullscreen");
      if (Number.isFinite(windowState.width)) {
        wrapper.style.width = `${clampWidth(windowState.width)}px`;
      } else {
        wrapper.style.width = "";
      }
      if (Number.isFinite(windowState.height)) {
        wrapper.style.height = `${clampHeight(windowState.height)}px`;
      } else {
        wrapper.style.height = "";
      }
      if (Number.isFinite(windowState.right)) {
        wrapper.style.right = `${clampRight(windowState.right)}px`;
      } else {
        wrapper.style.right = "";
      }
      if (Number.isFinite(windowState.bottom)) {
        wrapper.style.bottom = `${clampBottom(windowState.bottom)}px`;
      } else {
        wrapper.style.bottom = "";
      }
    }
    fullscreenBtn.textContent = windowState.fullscreen ? "❐" : "⛶";
  }
  applyWindowGeometry();

  // ------------------------------------------------------------------
  // Phase-2 state. Everything below is inert until bindTerminal() runs.
  // ------------------------------------------------------------------

  // End-of-drag callback of an in-flight resize/move drag. destroy() invokes
  // it so the window-level mousemove/mouseup listeners can't outlive the
  // session when it is disposed mid-drag.
  let activeDragEnd = null;
  let keyBarRepeatDelay = null;
  let keyBarRepeatTimer = null;
  let viewportListener = null;

  function stopKeyBarRepeat() {
    if (keyBarRepeatDelay) {
      clearTimeout(keyBarRepeatDelay);
      keyBarRepeatDelay = null;
    }
    if (keyBarRepeatTimer) {
      clearInterval(keyBarRepeatTimer);
      keyBarRepeatTimer = null;
    }
  }

  // --------------------------------------------------------------
  // End-of-session options bar ("Reconnect / Login"). Shown by the session
  // controller AFTER cleanup ran, so it must not depend on bind state or on
  // destroy() not having run. The countdown interval self-clears when the
  // wrapper leaves the DOM (navigation wipes #app wholesale).
  // --------------------------------------------------------------
  let endBar = null;

  function removeEndOptions() {
    if (!endBar) return;
    const bar = endBar;
    endBar = null;
    clearInterval(bar.timer);
    if (bar.el.parentNode) bar.el.parentNode.removeChild(bar.el);
  }

  function showEndOptions({ onReconnect, onLogin, autoLoginMs }) {
    removeEndOptions();
    const el = document.createElement("div");
    el.className = "term-endbar";
    const reconnectBtn = document.createElement("button");
    reconnectBtn.type = "button";
    reconnectBtn.textContent = "Reconnect";
    const loginBtn = document.createElement("button");
    loginBtn.type = "button";
    const deadline = Date.now() + autoLoginMs;
    const loginLabel = () =>
      `Login (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s)`;
    loginBtn.textContent = loginLabel();
    reconnectBtn.addEventListener("click", () => {
      removeEndOptions();
      onReconnect();
    });
    loginBtn.addEventListener("click", () => {
      removeEndOptions();
      onLogin();
    });
    el.append(reconnectBtn, loginBtn);
    wrapper.appendChild(el);
    const timer = setInterval(() => {
      if (!el.isConnected) {
        clearInterval(timer);
        return;
      }
      loginBtn.textContent = loginLabel();
    }, 500);
    endBar = { el, timer, reconnectBtn };
    focusEndOptions();
  }

  // A focused button takes the next Enter/OK press — exactly what we want
  // here, unlike everywhere else in the chrome. But NEVER while backgrounded:
  // main.js deliberately blurs on visibilitychange→hidden so this overlay
  // cannot hold a keyboard grab over the app the user switched to (the
  // Kodi-remote-dead scenario) — grabbing focus from a background `close`
  // event would silently reintroduce exactly that. The resume path calls
  // this again via the session handle's focus().
  function focusEndOptions() {
    if (!endBar || document.hidden) return;
    try {
      endBar.reconnectBtn.focus();
    } catch (e) {
      /* ignore */
    }
  }

  function bindTerminal(terminal, hooks) {
    const { term } = terminal;

    boundTerminalRef = terminal;
    tabHooks = {
      onSelectTab: hooks.onSelectTab || null,
      onNewTab: hooks.onNewTab || null,
      onCloseTab: hooks.onCloseTab || null,
      onOpenFiles: hooks.onOpenFiles || null,
      onOpenTerminal: hooks.onOpenTerminal || null,
    };
    renderTabs();

    fontReadout.textContent = `${terminal.getFontSize()}px`;

    function applyFontSize(next) {
      const applied = terminal.setFontSize(next);
      fontReadout.textContent = `${applied}px`;
      saveFontSize(applied);
      debugEvent("ui_terminal_fontsize", {
        sessionId: hooks.sessionId(),
        fontSize: applied,
      });
      hooks.onSizeChanged();
      terminal.focus();
      return applied;
    }

    themeBtn.addEventListener("click", (event) => {
      // A click that ends a long-press already did its job (the popover).
      if (suppressThemeClick) {
        suppressThemeClick = false;
        event.currentTarget.blur();
        return;
      }
      closeFlashPop(false);
      cycleTheme();
      event.currentTarget.blur();
      terminal.focus();
    });

    opacitySlider.addEventListener("input", () => {
      opacityPercent = clampOpacityPercent(opacitySlider.value);
      applyOpacity();
    });

    // `change` fires once when the drag ends — persist there, and hand DOM
    // focus back to the terminal so the next remote/keyboard event isn't
    // swallowed by the slider.
    opacitySlider.addEventListener("change", () => {
      opacityPercent = clampOpacityPercent(opacitySlider.value);
      applyOpacity();
      saveOpacityPercent(opacityPercent);
      debugEvent("ui_terminal_opacity", {
        sessionId: hooks.sessionId(),
        percent: opacityPercent,
      });
      opacitySlider.blur();
      terminal.focus();
    });

    // Scroll wheel over the slider nudges it — cheap precision for the Magic
    // Remote, which is clumsy at short drags.
    opacityGroup.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      opacityPercent = clampOpacityPercent(opacityPercent + direction * OPACITY_STEP);
      applyOpacity();
      saveOpacityPercent(opacityPercent);
    });

    function sendKeyBarData(entry) {
      let data = entry.data;
      if (entry.cursor) {
        // The send must honor DECCKM (application cursor keys mode) at click
        // time, which is why this stays in the chrome next to the term handle.
        let appCursor = false;
        try {
          appCursor = Boolean(term.modes && term.modes.applicationCursorKeysMode);
        } catch (e) {
          /* modes API missing on older xterm */
        }
        data = (appCursor ? "\x1bO" : "\x1b[") + entry.cursor;
      }
      if (!data) return;
      // onSendData reports whether the session was ready to take input; skip
      // the focus steal while the connection is still being established.
      if (hooks.onSendData(data)) terminal.focus();
    }

    // Key auto-repeat, like a physical keyboard: press sends immediately, and
    // holding the Magic Remote pointer down keeps sending (400ms delay, then
    // ~11/s) — essential for PgUp/PgDn scrollback and arrow navigation. The
    // send happens on mousedown (not click), so release/leave simply stops the
    // repeat without a duplicate trailing send.
    keyBarButtons.forEach(({ btn, entry }) => {
      btn.addEventListener("mousedown", (event) => {
        if (event.button !== 0 && event.button !== undefined) return;
        stopKeyBarRepeat();
        sendKeyBarData(entry);
        keyBarRepeatDelay = setTimeout(() => {
          keyBarRepeatDelay = null;
          keyBarRepeatTimer = setInterval(
            () => sendKeyBarData(entry),
            KEYBAR_REPEAT_INTERVAL_MS,
          );
        }, KEYBAR_REPEAT_DELAY_MS);
      });
      btn.addEventListener("mouseleave", stopKeyBarRepeat);
    });
    // The pointer may be released anywhere on screen, not just over the key.
    window.addEventListener("mouseup", stopKeyBarRepeat, true);

    keyBarToggle.addEventListener("click", (event) => {
      keyBarVisible = !keyBarVisible;
      saveKeyBarVisible(keyBarVisible);
      applyKeyBarVisibility();
      debugEvent("ui_terminal_keybar", {
        sessionId: hooks.sessionId(),
        visible: keyBarVisible,
      });
      hooks.onSizeChanged();
      event.currentTarget.blur();
      terminal.focus();
    });

    if (typeof terminal.toggleOsk === "function") {
      // The terminal owns the state (it can also be turned off by the user
      // dismissing the keyboard itself), so the button is painted from a
      // callback rather than from what the click thinks it did.
      if (typeof terminal.setOskStateHandler === "function") {
        terminal.setOskStateHandler((active) => {
          oskToggle.classList.toggle("active", Boolean(active));
          oskToggle.setAttribute("aria-pressed", String(Boolean(active)));
        });
      }
      oskToggle.addEventListener("click", (event) => {
        const active = terminal.toggleOsk();
        debugEvent("ui_terminal_osk", {
          sessionId: hooks.sessionId(),
          active: Boolean(active),
        });
        // Blur the BUTTON but do not call terminal.focus() here: focus is the
        // whole mechanism (the proxy textarea must hold it for webOS to raise
        // the keyboard), and toggleOsk has already put it where it belongs.
        event.currentTarget.blur();
      });
    } else {
      oskToggle.hidden = true;
    }

    zoomOutBtn.addEventListener("click", (event) => {
      applyFontSize(terminal.getFontSize() - FONT_SIZE_STEP);
      event.currentTarget.blur();
    });
    zoomInBtn.addEventListener("click", (event) => {
      applyFontSize(terminal.getFontSize() + FONT_SIZE_STEP);
      event.currentTarget.blur();
    });

    function setFullscreen(value) {
      const next = Boolean(value);
      if (next === windowState.fullscreen) return;
      windowState = { ...windowState, fullscreen: next };
      saveWindowState(windowState);
      applyWindowGeometry();
      debugEvent("ui_terminal_fullscreen", {
        sessionId: hooks.sessionId(),
        fullscreen: next,
      });
      hooks.onSizeChanged();
    }

    fullscreenBtn.addEventListener("click", (event) => {
      setFullscreen(!windowState.fullscreen);
      event.currentTarget.blur();
      terminal.focus();
    });

    // `edges` says which side of the window the handle drags, per axis: -1 is
    // the near side (n/w), +1 the far side (e/s), 0 means that axis is not
    // resized at all. It takes signs rather than the old "x"/"y"/"xy" axis
    // string because the window is anchored bottom-right and the two
    // directions therefore behave differently — resizeAxis() has the why.
    function startDrag(handle, edges, event) {
      if (event.button !== 0 && event.button !== undefined) return;
      if (windowState.fullscreen) return;
      event.preventDefault();
      const ex = edges.x || 0;
      const ey = edges.y || 0;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = wrapper.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      const startRight = window.innerWidth - rect.right;
      const startBottom = window.innerHeight - rect.bottom;
      handle.classList.add("dragging");
      setCompanionsLit(handle, true);
      document.body.classList.add("term-resizing");
      if (readoutFadeTimer) {
        clearTimeout(readoutFadeTimer);
        readoutFadeTimer = null;
      }
      updateReadout();
      resizeReadout.classList.add("visible");
      const baseCursor =
        ex && ey
          ? ex === ey
            ? "nwse-resize"
            : "nesw-resize"
          : ex
            ? "ew-resize"
            : "ns-resize";
      document.body.style.cursor = baseCursor;
      let dx = 0;
      let dy = 0;
      let rafScheduled = false;

      // The geometry a given pointer position produces. Both the per-frame
      // commit and the save on release go through it, so what is persisted is
      // exactly what was on screen when the button came up.
      function resolved() {
        const horizontal = ex
          ? resizeAxis({
              sign: ex,
              startSize: startW,
              startOffset: startRight,
              delta: dx,
              viewport: window.innerWidth,
              minSize: GEOMETRY_LIMITS.minWidth,
            })
          : null;
        const vertical = ey
          ? resizeAxis({
              sign: ey,
              startSize: startH,
              startOffset: startBottom,
              delta: dy,
              viewport: window.innerHeight,
              minSize: GEOMETRY_LIMITS.minHeight,
            })
          : null;
        return {
          width: horizontal && horizontal.size,
          height: vertical && vertical.size,
          right: ex > 0 ? horizontal.offset : null,
          bottom: ey > 0 ? vertical.offset : null,
        };
      }

      // The readout shows what the reflow PRODUCED, not what the pixels ask
      // for — fitToContainer() returns the grid it just fitted, so the number
      // is the truth even while the size is pinned at its min.
      function updateReadout() {
        try {
          const size = terminal.fitToContainer();
          resizeReadout.textContent = `${size.cols} x ${size.rows}`;
        } catch (e) {
          /* ignore transient fit errors during drag */
        }
      }

      function commitFrame() {
        rafScheduled = false;
        const next = resolved();
        if (next.width !== null) wrapper.style.width = `${next.width}px`;
        if (next.height !== null) wrapper.style.height = `${next.height}px`;
        if (next.right !== null) wrapper.style.right = `${next.right}px`;
        if (next.bottom !== null) wrapper.style.bottom = `${next.bottom}px`;
        updateReadout();
      }

      function onMove(ev) {
        dx = ev.clientX - startX;
        dy = ev.clientY - startY;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(commitFrame);
        }
      }

      function onUp() {
        activeDragEnd = null;
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        handle.classList.remove("dragging");
        setCompanionsLit(handle, false);
        document.body.classList.remove("term-resizing");
        document.body.style.cursor = "";
        // Let the final size linger long enough to be read, then fade. The
        // timer is cleared on the next drag start so a quick re-grab never
        // races a fade against a show.
        readoutFadeTimer = setTimeout(() => {
          readoutFadeTimer = null;
          resizeReadout.classList.remove("visible");
        }, 650);
        const final = resolved();
        if (final.width !== null) windowState.width = final.width;
        if (final.height !== null) windowState.height = final.height;
        if (final.right !== null) windowState.right = final.right;
        if (final.bottom !== null) windowState.bottom = final.bottom;
        saveWindowState(windowState);
        hooks.onSizeChanged();
        debugEvent("ui_terminal_resize_drag", {
          sessionId: hooks.sessionId(),
          axis: `${ey < 0 ? "n" : ey > 0 ? "s" : ""}${ex < 0 ? "w" : ex > 0 ? "e" : ""}`,
          width: windowState.width,
          height: windowState.height,
        });
        // Focus invariant (see module header): the drag stole DOM focus from
        // the terminal despite the preventDefault — typing was dead after a
        // resize until the user tabbed around. Hand it back explicitly.
        terminal.focus();
      }

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      activeDragEnd = onUp;
    }

    handleN.addEventListener("mousedown", (e) => startDrag(handleN, { y: -1 }, e));
    handleW.addEventListener("mousedown", (e) => startDrag(handleW, { x: -1 }, e));
    handleNw.addEventListener("mousedown", (e) =>
      startDrag(handleNw, { x: -1, y: -1 }, e),
    );
    handleE.addEventListener("mousedown", (e) => startDrag(handleE, { x: 1 }, e));
    handleS.addEventListener("mousedown", (e) => startDrag(handleS, { y: 1 }, e));
    handleSe.addEventListener("mousedown", (e) =>
      startDrag(handleSe, { x: 1, y: 1 }, e),
    );
    handleNe.addEventListener("mousedown", (e) =>
      startDrag(handleNe, { x: 1, y: -1 }, e),
    );
    handleSw.addEventListener("mousedown", (e) =>
      startDrag(handleSw, { x: -1, y: 1 }, e),
    );

    function startMove(event) {
      if (event.button !== 0 && event.button !== undefined) return;
      // Any non-interactive toolbar surface starts a move (Chrome titlebar
      // semantics): background, tab-strip filler, separators, readouts.
      // Only real controls keep their clicks. The old `target === toolbar`
      // check silently killed window moving once toolbar children (opacity
      // group, then the flexing tab strip) covered nearly all of the bar —
      // only a few px of bare gap were left to grab. The active tab also
      // routes here, via armTabMove()'s drag threshold.
      const t = event.target;
      if (t !== toolbar && t.closest && t.closest("button, input")) return;
      beginWindowMove(event);
    }

    // Dragging the title bar of a maximised window restores it and carries on
    // moving it, the way a maximised window behaves on a desktop. The press
    // itself does nothing: the window only breaks loose once the pointer has
    // travelled FULLSCREEN_BREAKOUT_DISTANCE, so clicking the bar (or missing a
    // button) leaves fullscreen alone. Everything below the break-out is the
    // ordinary move drag, re-based on the geometry the restore just produced.
    function beginWindowMove(event) {
      event.preventDefault();
      const rect = wrapper.getBoundingClientRect();
      // Where on the title bar the pointer grabbed. Fullscreen or not, the
      // toolbar is flush with the top of the wrapper, so this offset is what
      // puts the restored bar back under the pointer.
      const grabOffsetY = event.clientY - rect.top;
      // Set while the window is still maximised and has not travelled far
      // enough to break loose. Nothing is written to windowState until it
      // clears — otherwise a stray click on the bar would overwrite the saved
      // windowed position with the fullscreen one (0/0) and the window would
      // come back flush in the corner.
      let awaitingBreakout = windowState.fullscreen;
      const pressX = event.clientX;
      const pressY = event.clientY;
      let startX = pressX;
      let startY = pressY;
      let startRight = window.innerWidth - rect.right;
      let startBottom = window.innerHeight - rect.bottom;
      let w = rect.width;
      let h = rect.height;
      toolbar.classList.add("moving");
      document.body.classList.add("term-resizing");
      document.body.style.cursor = "grabbing";
      let pendingRight = startRight;
      let pendingBottom = startBottom;
      let rafScheduled = false;

      function commit() {
        rafScheduled = false;
        wrapper.style.right = `${clampRight(snapRight(pendingRight, w), w)}px`;
        wrapper.style.bottom = `${clampBottom(snapBottom(pendingBottom, h), h)}px`;
      }

      // Leave fullscreen mid-drag and re-base the move on the window that
      // appears. The size comes from applyWindowGeometry (the last windowed
      // size, or the CSS default if there has never been one), so it is read
      // back off the element rather than computed — that is also what keeps
      // this correct when the persisted width is null.
      //
      // The restore is anchored on where the bar was GRABBED, not on where the
      // pointer had reached by the time it crossed the break-out distance: the
      // grab point is what the fraction means, and the travel since then is
      // already the drag's own delta, applied right below. Anchoring on the
      // current position would count that travel twice.
      function breakOut(ev) {
        awaitingBreakout = false;
        windowState = { ...windowState, fullscreen: false };
        applyWindowGeometry();
        const restored = wrapper.getBoundingClientRect();
        w = restored.width;
        h = restored.height;
        const offsets = restoredOffsets({
          pointerX: pressX,
          pointerY: pressY,
          grabOffsetY,
          width: w,
          height: h,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        startX = pressX;
        startY = pressY;
        startRight = offsets.right;
        startBottom = offsets.bottom;
        pendingRight = startRight - (ev.clientX - startX);
        pendingBottom = startBottom - (ev.clientY - startY);
        // Committed synchronously rather than through the rAF: a break-out
        // released before the next frame would otherwise leave the element
        // showing its fullscreen geometry while onUp saved the restored one.
        commit();
        // The pty is now looking at a much smaller window; tell it once, here,
        // rather than per frame like the resize drag does.
        hooks.onSizeChanged();
        debugEvent("ui_terminal_fullscreen_breakout", {
          sessionId: hooks.sessionId(),
          right: pendingRight,
          bottom: pendingBottom,
        });
      }

      function onMove(ev) {
        if (awaitingBreakout) {
          if (
            Math.abs(ev.clientX - pressX) + Math.abs(ev.clientY - pressY) <
            FULLSCREEN_BREAKOUT_DISTANCE
          ) {
            return;
          }
          breakOut(ev);
          return;
        }
        pendingRight = startRight - (ev.clientX - startX);
        pendingBottom = startBottom - (ev.clientY - startY);
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(commit);
        }
      }

      function onUp() {
        activeDragEnd = null;
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        toolbar.classList.remove("moving");
        document.body.classList.remove("term-resizing");
        document.body.style.cursor = "";
        // Still maximised: the press never became a drag, so leave both the
        // fullscreen flag and the saved windowed geometry exactly as they were.
        if (awaitingBreakout) {
          terminal.focus();
          return;
        }
        windowState.right = normalizeEdgeOffset(clampRight(snapRight(pendingRight, w), w));
        windowState.bottom = normalizeEdgeOffset(clampBottom(snapBottom(pendingBottom, h), h));
        saveWindowState(windowState);
        debugEvent("ui_terminal_move_drag", {
          sessionId: hooks.sessionId(),
          right: windowState.right,
          bottom: windowState.bottom,
        });
        // Same focus invariant as the resize drag above.
        terminal.focus();
      }

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      activeDragEnd = onUp;
    }

    toolbar.addEventListener("mousedown", startMove);
    windowMoveStarter = beginWindowMove;

    // --------------------------------------------------------------
    // Scrollback search (Ctrl+Shift+F). The input is a non-editable fake
    // field edited via keydown, exactly like the connect form — a real
    // <input> focused on webOS pops the system on-screen keyboard. The bar
    // overlays the terminal absolutely, so the frame height math and the
    // pty size are untouched by opening it.
    // --------------------------------------------------------------
    if (terminal.searchAvailable) {
      const searchBar = document.createElement("div");
      searchBar.className = "term-search";
      searchBar.hidden = true;
      const searchGlyph = document.createElement("span");
      searchGlyph.className = "term-search-glyph";
      searchGlyph.textContent = "/";
      searchGlyph.setAttribute("aria-hidden", "true");
      const searchField = document.createElement("div");
      searchField.className = "term-search-field";
      searchField.tabIndex = 0;
      searchField.setAttribute("role", "searchbox");
      searchField.setAttribute("aria-label", "Search scrollback");
      const searchHint = document.createElement("span");
      searchHint.className = "term-search-hint";
      // U+23CE, not U+21B5: the return arrow this used to carry is one of the
      // symbols with no glyph on this firmware, so it rendered as a box.
      searchHint.textContent = "⏎ next · ⇧⏎ prev · esc";
      searchBar.append(searchGlyph, searchField, searchHint);
      wrapper.appendChild(searchBar);

      let searchQuery = "";

      function renderSearchField() {
        searchField.textContent = searchQuery;
      }

      function openSearch() {
        searchBar.hidden = false;
        renderSearchField();
        debugEvent("ui_search_open", { sessionId: hooks.sessionId() });
        try {
          searchField.focus();
        } catch (e) {
          /* ignore */
        }
      }

      function closeSearch() {
        if (searchBar.hidden) return;
        searchBar.hidden = true;
        searchQuery = "";
        renderSearchField();
        terminal.clearSearch();
        terminal.focus();
      }

      searchField.addEventListener("keydown", (event) => {
        // Handled keys must not bubble: Escape/Back would otherwise reach the
        // app-global handler and hide the whole overlay.
        if (event.key === "Escape" || isRemoteBackKey(event)) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (!searchQuery) return;
          if (event.shiftKey) terminal.findPrevious(searchQuery);
          else terminal.findNext(searchQuery);
          return;
        }
        if (event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          searchQuery = searchQuery.slice(0, -1);
          renderSearchField();
          if (searchQuery) terminal.findNext(searchQuery, { incremental: true });
          else terminal.clearSearch();
          return;
        }
        const ch = printableDataFromKeyEvent(event);
        if (ch) {
          event.preventDefault();
          event.stopPropagation();
          searchQuery += ch;
          renderSearchField();
          terminal.findNext(searchQuery, { incremental: true });
        }
      });

      terminal.setSearchRequestHandler(openSearch);
    }

    viewportListener = () => {
      if (windowState.fullscreen) return;
      let changed = false;
      if (Number.isFinite(windowState.width)) {
        const clamped = clampWidth(windowState.width);
        if (clamped !== windowState.width) {
          windowState.width = clamped;
          changed = true;
        }
      }
      if (Number.isFinite(windowState.height)) {
        const clamped = clampHeight(windowState.height);
        if (clamped !== windowState.height) {
          windowState.height = clamped;
          changed = true;
        }
      }
      if (Number.isFinite(windowState.right)) {
        const clamped = normalizeEdgeOffset(clampRight(windowState.right));
        if (clamped !== windowState.right) {
          windowState.right = clamped;
          changed = true;
        }
      }
      if (Number.isFinite(windowState.bottom)) {
        const clamped = normalizeEdgeOffset(clampBottom(windowState.bottom));
        if (clamped !== windowState.bottom) {
          windowState.bottom = clamped;
          changed = true;
        }
      }
      if (changed) {
        applyWindowGeometry();
        saveWindowState(windowState);
        hooks.onSizeChanged();
      }
    };
    window.addEventListener("resize", viewportListener);
  }

  // Safe to call before bindTerminal() (the cancelled-open path) and more
  // than once.
  function destroy() {
    if (activeDragEnd) {
      const endDrag = activeDragEnd;
      activeDragEnd = null;
      try {
        endDrag();
      } catch (e) {
        /* drag teardown must never block cleanup */
      }
    }
    stopKeyBarRepeat();
    removeEndOptions();
    // The flash popover holds a document-level listener while open.
    cancelThemePress();
    closeFlashPop(false);
    // The theme registry is module-level and only prunes itself when the user
    // cycles the theme. Without this, every closed session's toolbar button
    // stays reachable — and with it, through the click listener's closure, its
    // whole xterm instance and 5000-line scrollback.
    unregisterThemeButton(themeBtn);
    window.removeEventListener("mouseup", stopKeyBarRepeat, true);
    if (viewportListener) {
      window.removeEventListener("resize", viewportListener);
      viewportListener = null;
    }
  }

  // Show the explorer or the terminal. The key bar is a terminal thing (it
  // sends control codes into a pty) and would be actively misleading over a
  // file list, so it goes with it; applyKeyBarVisibility restores whatever the
  // user's own setting was on the way back rather than force-showing it.
  function showFiles(on) {
    filesHost.hidden = !on;
    frame.hidden = Boolean(on);
    wrapper.classList.toggle("files-mode", Boolean(on));
    if (on) keyBar.hidden = true;
    else applyKeyBarVisibility();
  }

  return {
    wrapper,
    frame,
    filesHost,
    showFiles,
    persistedFontSize,
    bindTerminal,
    setTabs,
    showEndOptions,
    removeEndOptions,
    focusEndOptions,
    destroy,
  };
}
