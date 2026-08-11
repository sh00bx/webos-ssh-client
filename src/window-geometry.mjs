// Geometry maths for the floating terminal window (resize clamping and
// edge/corner snapping). Pure: the viewport size is passed in rather than read
// from `window`, which is what makes it unit-testable — the window itself can
// only be exercised on the TV.
//
// The window is positioned by its distance from the right/bottom viewport
// edges, so offset 0 is flush against the near edge and `viewport - size` is
// flush against the far edge.

export const GEOMETRY_LIMITS = {
  minWidth: 480,
  minHeight: 240,
  viewportMargin: 0,
  edgeSnap: 40,
  // How much of the window must stay on screen when it is dragged off an edge.
  positionMinVisible: 80,
};

// A persisted offset within snapping distance of an edge is stored as exactly
// 0, so a window snapped flush stays flush when the viewport size changes.
export function normalizeEdgeOffset(value, snap = GEOMETRY_LIMITS.edgeSnap) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= snap ? 0 : rounded;
}

export function clampWidth(width, viewportWidth, limits = GEOMETRY_LIMITS) {
  const max = Math.max(limits.minWidth, viewportWidth - limits.viewportMargin);
  return Math.min(max, Math.max(limits.minWidth, Math.round(width)));
}

export function clampHeight(height, viewportHeight, limits = GEOMETRY_LIMITS) {
  const max = Math.max(limits.minHeight, viewportHeight - limits.viewportMargin);
  return Math.min(max, Math.max(limits.minHeight, Math.round(height)));
}

// Both position offsets clamp the same way — keep at least positionMinVisible
// of the window on screen at either end of the axis — so the two named
// exports are one function per axis over a shared body.
export function clampOffset(offset, size, viewport, limits = GEOMETRY_LIMITS) {
  const min = -(size - limits.positionMinVisible);
  const max = viewport - limits.positionMinVisible;
  return Math.min(max, Math.max(min, Math.round(offset)));
}

export function clampRight(right, width, viewportWidth, limits = GEOMETRY_LIMITS) {
  return clampOffset(right, width, viewportWidth, limits);
}

export function clampBottom(bottom, height, viewportHeight, limits = GEOMETRY_LIMITS) {
  return clampOffset(bottom, height, viewportHeight, limits);
}

// One axis of a resize drag, from the pointer travel to the geometry it
// produces. `sign` is -1 when the handle drags the NEAR edge (n/w) and +1 for
// the FAR edge (e/s) — the two are not symmetric, because the window is
// anchored by its distance from the far viewport edge:
//
//   near edge: only the size changes; the anchored edge never moves.
//   far edge:  the anchor has to walk out by exactly the size change, or the
//              window would grow away from the pointer out of its far side.
//
// The offset is derived from the CLAMPED size rather than from the pointer
// delta. That is what pins the opposite edge once the size hits its min or
// max: the size stops changing, so the anchor stops moving with it, instead
// of the window sliding on under a pointer that is no longer resizing it.
export function resizeAxis(
  { sign, startSize, startOffset, delta, viewport, minSize },
  limits = GEOMETRY_LIMITS,
) {
  const max = Math.max(minSize, viewport - limits.viewportMargin);
  const size = Math.min(max, Math.max(minSize, Math.round(startSize + delta * sign)));
  const offset =
    sign > 0
      ? clampOffset(startOffset + startSize - size, size, viewport, limits)
      : Math.round(startOffset);
  return { size, offset };
}

// How far the pointer must travel on a fullscreen toolbar before the press
// becomes a window move. A plain click has to stay a click, and the Magic
// Remote's pointer jitters by a couple of px while a button is held — the tab
// grip uses 5px for the same reason, but breaking a maximised window loose is
// the more surprising outcome of the two, so it asks for more intent.
export const FULLSCREEN_BREAKOUT_DISTANCE = 14;

// Where a maximised window lands when the pointer drags it loose, expressed in
// the same right/bottom offsets as everything else here.
//
// Horizontally the grab point keeps its FRACTION across the title bar, not its
// pixel offset: the bar being released is as wide as the screen and the one
// being created is not, so a pixel offset taken near the right-hand end would
// leave the pointer past the end of the restored window and the window would
// jump out from under it. The fraction is what Windows preserves, and it is
// what makes grabbing near the tabs keep you near the tabs.
//
// Vertically there is nothing to scale: the toolbar sits flush at the top of
// the wrapper in both states, so carrying the grab offset over unchanged puts
// the restored title bar back under the pointer.
export function restoredOffsets({
  pointerX,
  pointerY,
  grabOffsetY,
  width,
  height,
  viewportWidth,
  viewportHeight,
}) {
  const fraction =
    viewportWidth > 0 ? Math.min(1, Math.max(0, pointerX / viewportWidth)) : 0.5;
  const left = pointerX - fraction * width;
  const top = pointerY - grabOffsetY;
  return {
    right: Math.round(viewportWidth - left - width),
    bottom: Math.round(viewportHeight - top - height),
  };
}

// Pull an offset to 0 (flush near edge) or `viewport - size` (flush far edge)
// when it lands within the snap distance. Together the two axes give all four
// corners and the centred edges without any resize.
export function snapRight(right, width, viewportWidth, snap = GEOMETRY_LIMITS.edgeSnap) {
  const flushLeft = viewportWidth - width;
  if (Math.abs(right) <= snap) return 0;
  if (Math.abs(right - flushLeft) <= snap) return flushLeft;
  return right;
}

export function snapBottom(bottom, height, viewportHeight, snap = GEOMETRY_LIMITS.edgeSnap) {
  const flushTop = viewportHeight - height;
  if (Math.abs(bottom) <= snap) return 0;
  if (Math.abs(bottom - flushTop) <= snap) return flushTop;
  return bottom;
}
