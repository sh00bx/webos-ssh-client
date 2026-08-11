// Placement arithmetic for the hover tooltip. Pure functions on plain rects so
// they can be tested without a DOM (the rest of the tooltip lives in
// tooltip.js, which is browser-only).
//
// Why a tooltip layer of our own rather than the browser's `title` bubble: on
// this platform the native bubble is drawn by the host UI, which on webOS means
// it either never appears for the Magic Remote pointer or appears in the
// system's own font at the system's own size — unreadable from a couch and
// unstyleable. Everything else in this app is drawn by us for exactly that
// reason (see the theme popover), so the tooltip is too.

export const TIP_GAP = 9;
export const TIP_MARGIN = 12;
// Keeps the arrow inside the tooltip's rounded ends when the bubble has been
// pushed sideways by the viewport clamp.
export const TIP_ARROW_INSET = 14;

function clamp(value, min, max) {
  // max < min happens when the tooltip is wider (or taller) than the space it
  // has to fit in — pin to min then, so it overflows off the far edge rather
  // than off the near one, where the anchor is.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Position a tooltip against its anchor.
 *
 * Below the anchor by default — the toolbar and the form's action rows both sit
 * with free space beneath them, and a bubble above a toolbar button would cover
 * the tab strip. Flips above only when it genuinely does not fit below.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} anchor viewport rect
 * @param {{width:number, height:number}} tip measured bubble size
 * @param {{width:number, height:number}} viewport
 * @returns {{left:number, top:number, side:"above"|"below", arrowLeft:number}}
 */
export function placeTip({ anchor, tip, viewport, gap = TIP_GAP, margin = TIP_MARGIN }) {
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - tip.height;
  const fitsBelow = belowTop + tip.height <= viewport.height - margin;
  const fitsAbove = aboveTop >= margin;
  const side = !fitsBelow && fitsAbove ? "above" : "below";

  const top = clamp(
    side === "below" ? belowTop : aboveTop,
    margin,
    viewport.height - margin - tip.height,
  );

  const anchorCenter = anchor.left + (anchor.right - anchor.left) / 2;
  const left = clamp(
    anchorCenter - tip.width / 2,
    margin,
    viewport.width - margin - tip.width,
  );

  // The arrow tracks the anchor, not the bubble: once the clamp above has
  // shoved the bubble away from a screen edge, an arrow centred on the bubble
  // would point at nothing.
  const arrowLeft = clamp(
    anchorCenter - left,
    TIP_ARROW_INSET,
    Math.max(TIP_ARROW_INSET, tip.width - TIP_ARROW_INSET),
  );

  return {
    left: Math.round(left),
    top: Math.round(top),
    side,
    arrowLeft: Math.round(arrowLeft),
  };
}

/**
 * Should a hover on this element open a tooltip at all?
 *
 * Only elements that were given a tip, and only while they are actually on
 * screen: a stale anchor (a tab that was closed while the pointer sat on it)
 * measures as a zero rect, and a bubble at 0,0 pointing at nothing is worse
 * than no bubble.
 */
export function tipIsShowable({ text, connected, rect }) {
  if (!text) return false;
  if (!connected) return false;
  if (!rect) return false;
  return rect.right > rect.left && rect.bottom > rect.top;
}
