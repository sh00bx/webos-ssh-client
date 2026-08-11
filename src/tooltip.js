// The hover tooltip layer.
//
// One bubble for the whole app, appended to <body> so it is never clipped by a
// panel and never inherits a wrapper's opacity (the terminal window is
// translucent, and a tooltip that fades with it is unreadable over video).
// Placement arithmetic lives in tooltip.mjs.
//
// Anchors are found by attribute, not by registration: anything carrying
// `data-tip` (or a plain `title`, which is absorbed on first hover — see
// absorbTitle) gets a bubble. That keeps call sites to a single attribute and
// means the controls that already had a `title` from the day they were written
// get a readable tooltip without being touched.
//
// Both pointer and focus open it. Focus matters more than hover here: a TV
// remote's D-pad moves the focus ring, and half the users of this app never
// produce a hover at all.

import { placeTip, tipIsShowable } from "./tooltip.mjs";

// Long enough that the Magic Remote's idle drift (it wanders a few px while the
// remote just lies on the sofa — see the drag-test note in the platform
// gotchas) does not paint the screen with bubbles on its way past, and long
// enough that crossing the toolbar to reach a button does not flash a bubble
// for every control on the way. 420ms was measured as too eager in use.
const SHOW_DELAY_MS = 750;
// The focus ring is a deliberate act, so its bubble comes up much sooner — but
// not instantly: holding a D-pad direction walks several controls per second,
// and one bubble per stop on the way is exactly the strobing this delay exists
// to prevent.
const FOCUS_DELAY_MS = 260;
// Once one bubble has been shown, neighbours open immediately: walking a
// toolbar should feel like reading a row of labels, not like waiting nine
// times.
const WARM_MS = 1200;
const HIDE_DELAY_MS = 60;

let tipEl = null;
let textEl = null;
let arrowEl = null;
let anchorEl = null;
let showTimer = null;
let hideTimer = null;
let lastHiddenAt = 0;
let installed = false;
// Watches the live anchor for `title`/`data-tip` edits: the sliders rewrite
// their own label on every step ("Panel opacity: 62%"), and a bubble that keeps
// showing the value from before the drag is worse than none.
let anchorObserver = null;

function ensureElements() {
  if (tipEl) return;
  tipEl = document.createElement("div");
  tipEl.className = "app-tip";
  // Presentation only. Every anchor also carries an aria-label (absorbTitle
  // makes sure of it), so announcing the bubble as well would say it twice.
  tipEl.setAttribute("aria-hidden", "true");
  textEl = document.createElement("span");
  textEl.className = "app-tip-text";
  arrowEl = document.createElement("i");
  arrowEl.className = "app-tip-arrow";
  tipEl.append(textEl, arrowEl);
  document.body.appendChild(tipEl);
}

// Move a `title` onto data-tip so the platform never draws its own bubble on
// top of ours, and mirror it into aria-label when the element has no accessible
// name of its own. Runs on every hover, not once: code that sets `el.title` at
// runtime (the tab strip, the sliders) keeps working unchanged.
function absorbTitle(el) {
  const title = el.getAttribute("title");
  if (title) {
    el.setAttribute("data-tip", title);
    el.removeAttribute("title");
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", title);
  }
  return el.getAttribute("data-tip") || "";
}

function findAnchor(node) {
  if (!node || typeof node.closest !== "function") return null;
  const el = node.closest("[data-tip], [title]");
  if (!el) return null;
  // An empty data-tip is an explicit opt-out: it lets a container carrying a
  // tip hold children that should stay silent.
  return absorbTitle(el) ? el : null;
}

function clearTimers() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function stopObserving() {
  if (anchorObserver) {
    anchorObserver.disconnect();
    anchorObserver = null;
  }
}

function observeAnchor(el) {
  stopObserving();
  if (typeof MutationObserver !== "function") return;
  anchorObserver = new MutationObserver(() => {
    if (anchorEl !== el) return;
    const text = absorbTitle(el);
    if (!text) {
      hideNow();
      return;
    }
    if (text !== textEl.textContent) {
      textEl.textContent = text;
      position(el);
    }
  });
  anchorObserver.observe(el, { attributes: true, attributeFilter: ["title", "data-tip"] });
}

function position(el) {
  const rect = el.getBoundingClientRect();
  const placed = placeTip({
    anchor: rect,
    tip: { width: tipEl.offsetWidth, height: tipEl.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  tipEl.style.left = `${placed.left}px`;
  tipEl.style.top = `${placed.top}px`;
  tipEl.classList.toggle("above", placed.side === "above");
  arrowEl.style.left = `${placed.arrowLeft}px`;
}

function showNow(el) {
  ensureElements();
  const text = absorbTitle(el);
  if (!tipIsShowable({ text, connected: el.isConnected, rect: el.getBoundingClientRect() })) {
    hideNow();
    return;
  }
  anchorEl = el;
  textEl.textContent = text;
  // Measure before revealing: `.open` only adds opacity, so the bubble already
  // has its final size here and one layout pass is enough.
  tipEl.classList.add("measuring");
  position(el);
  tipEl.classList.remove("measuring");
  tipEl.classList.add("open");
  observeAnchor(el);
}

function hideNow() {
  clearTimers();
  stopObserving();
  if (anchorEl) lastHiddenAt = Date.now();
  anchorEl = null;
  if (tipEl) tipEl.classList.remove("open");
}

function scheduleShow(el) {
  if (anchorEl === el) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    return;
  }
  clearTimers();
  const warm = anchorEl !== null || Date.now() - lastHiddenAt < WARM_MS;
  if (warm) {
    showNow(el);
    return;
  }
  showTimer = setTimeout(() => {
    showTimer = null;
    // The pointer may have left during the delay; the element may have been
    // re-rendered under it. showNow re-checks both.
    showNow(el);
  }, SHOW_DELAY_MS);
}

function scheduleHide() {
  clearTimers();
  if (!anchorEl) return;
  // Small grace period so crossing the seam between two parts of one control
  // (a tab and its close ×) does not flicker the bubble off and on.
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideNow();
  }, HIDE_DELAY_MS);
}

function onPointerOver(event) {
  // A button held down is a drag in progress (window move, resize, slider) —
  // the last thing that should happen then is a bubble under the pointer.
  if (event.buttons) return;
  const el = findAnchor(event.target);
  if (el) scheduleShow(el);
  else scheduleHide();
}

function onPointerOut(event) {
  const el = findAnchor(event.target);
  if (!el || el === anchorEl) scheduleHide();
}

function onFocusIn(event) {
  // Focus opens the bubble only for controls that were given a tip on purpose,
  // never for one absorbed from a `title` that exists for other reasons — the
  // path readout in the file explorer titles itself with the full path, and
  // having that cover the listing every time the pane takes focus would be a
  // regression for remote users.
  const el = event.target;
  if (!el || typeof el.closest !== "function") return;
  const anchor = el.closest("[data-tip]");
  if (!anchor || !anchor.getAttribute("data-tip")) {
    hideNow();
    return;
  }
  clearTimers();
  hideNow();
  showTimer = setTimeout(() => {
    showTimer = null;
    // Still the focused element? A held direction key has moved on by now.
    if (document.activeElement && document.activeElement.closest &&
        document.activeElement.closest("[data-tip]") === anchor) {
      showNow(anchor);
    }
  }, FOCUS_DELAY_MS);
}

export function hideTooltip() {
  hideNow();
}

export function initTooltips() {
  if (installed) return;
  installed = true;
  ensureElements();
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", hideNow, true);
  // Anything that means "the user is doing something now" closes it: a press,
  // a key, a wheel, leaving the app. A tooltip is only ever a hint about what
  // is under the pointer, never a thing to interact with.
  document.addEventListener("pointerdown", hideNow, true);
  document.addEventListener("keydown", hideNow, true);
  document.addEventListener("wheel", hideNow, { capture: true, passive: true });
  window.addEventListener("resize", hideNow);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideNow();
  });
}
