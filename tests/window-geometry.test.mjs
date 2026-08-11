import assert from "node:assert";
import {
  FULLSCREEN_BREAKOUT_DISTANCE,
  GEOMETRY_LIMITS,
  clampBottom,
  clampHeight,
  clampRight,
  clampWidth,
  normalizeEdgeOffset,
  resizeAxis,
  restoredOffsets,
  snapBottom,
  snapRight,
} from "../src/window-geometry.mjs";

const VW = 1920;
const VH = 1080;

// Size clamping: never below the minimum, never larger than the viewport.
assert.strictEqual(clampWidth(1000, VW), 1000);
assert.strictEqual(clampWidth(10, VW), GEOMETRY_LIMITS.minWidth);
assert.strictEqual(clampWidth(5000, VW), VW);
assert.strictEqual(clampWidth(640.4, VW), 640, "widths are rounded");
assert.strictEqual(clampHeight(600, VH), 600);
assert.strictEqual(clampHeight(1, VH), GEOMETRY_LIMITS.minHeight);
assert.strictEqual(clampHeight(5000, VH), VH);
// A viewport smaller than the minimum still yields the minimum, not a
// negative or inverted range.
assert.strictEqual(clampWidth(500, 200), GEOMETRY_LIMITS.minWidth);
assert.strictEqual(clampHeight(500, 100), GEOMETRY_LIMITS.minHeight);

// Position clamping keeps positionMinVisible px of the window on screen at
// either extreme.
const W = 800;
assert.strictEqual(clampRight(0, W, VW), 0);
assert.strictEqual(clampRight(-5000, W, VW), -(W - GEOMETRY_LIMITS.positionMinVisible));
assert.strictEqual(clampRight(5000, W, VW), VW - GEOMETRY_LIMITS.positionMinVisible);
const H = 500;
assert.strictEqual(clampBottom(-5000, H, VH), -(H - GEOMETRY_LIMITS.positionMinVisible));
assert.strictEqual(clampBottom(5000, H, VH), VH - GEOMETRY_LIMITS.positionMinVisible);

// Snapping: to the near edge (0) and to the far edge (viewport - size).
const snap = GEOMETRY_LIMITS.edgeSnap;
assert.strictEqual(snapRight(5, W, VW), 0, "near edge snaps to flush");
assert.strictEqual(snapRight(-5, W, VW), 0, "snapping is symmetric around 0");
assert.strictEqual(snapRight(snap, W, VW), 0, "the snap distance is inclusive");
assert.strictEqual(snapRight(snap + 1, W, VW), snap + 1, "beyond it, no snap");
assert.strictEqual(snapRight(VW - W - 5, W, VW), VW - W, "far edge snaps flush");
assert.strictEqual(snapRight(600, W, VW), 600, "the middle is left alone");
assert.strictEqual(snapBottom(3, H, VH), 0);
assert.strictEqual(snapBottom(VH - H + 4, H, VH), VH - H);
assert.strictEqual(snapBottom(400, H, VH), 400);

// Persisted offsets: near-edge values collapse to exactly 0 so a flush window
// stays flush; non-finite values mean "not set".
assert.strictEqual(normalizeEdgeOffset(12), 0);
assert.strictEqual(normalizeEdgeOffset(snap), 0);
assert.strictEqual(normalizeEdgeOffset(snap + 1), snap + 1);
assert.strictEqual(normalizeEdgeOffset(0), 0);
assert.strictEqual(normalizeEdgeOffset(-30), -30, "negative offsets are kept");
assert.strictEqual(normalizeEdgeOffset(NaN), null);
assert.strictEqual(normalizeEdgeOffset(undefined), null);
assert.strictEqual(normalizeEdgeOffset(null), null);

// Breaking a maximised window loose. The window being created is 1120x690 and
// the bar it was grabbed on was the full 1920 wide; the toolbar is 34px tall
// and sits flush at the top in both states.
const RW = 1120;
const RH = 690;
const restore = (pointerX, pointerY = 12) =>
  restoredOffsets({
    pointerX,
    pointerY,
    grabOffsetY: pointerY,
    width: RW,
    height: RH,
    viewportWidth: VW,
    viewportHeight: VH,
  });

// The pointer keeps its fraction across the bar, so the window it lands on
// covers the same relative part of the screen it was grabbed at.
const middle = restore(VW / 2);
assert.strictEqual(middle.right, (VW - RW) / 2, "a centred grab restores centred");
// Grabbing at either end puts that end of the window under the pointer rather
// than throwing the pointer off it: this is the case a pixel offset gets wrong.
assert.strictEqual(restore(VW - 1).right, 0, "a grab at the right edge stays at the right edge");
assert.strictEqual(restore(0).right, VW - RW, "a grab at the left edge stays at the left edge");
// Same input read the other way round: the pointer must still be over the
// window on both axes, whatever fraction it was at.
for (const x of [0, 1, 400, 960, 1500, VW - 1, VW]) {
  const left = VW - restore(x).right - RW;
  assert.ok(
    x >= left && x <= left + RW,
    `pointer at ${x} must land on the restored window (${left}..${left + RW})`,
  );
}
// Vertically the grab offset carries over unchanged, so the restored title bar
// is under the pointer wherever on the bar it was pressed.
for (const y of [0, 12, 33]) {
  assert.strictEqual(
    restore(600, y).bottom,
    VH - RH,
    `a grab ${y}px down the bar restores flush to the top`,
  );
}
// A pointer beyond the viewport (the remote can report one) is clamped to the
// ends rather than extrapolated into a window that is nowhere near it.
assert.strictEqual(
  restore(VW + 500).right,
  -500,
  "past the right edge the fraction stops at 1 instead of extrapolating",
);
assert.deepStrictEqual(restore(-40), { right: VW - RW + 40, bottom: VH - RH });
// A degenerate viewport falls back to a centred grab instead of dividing by 0.
assert.strictEqual(
  restoredOffsets({
    pointerX: 0, pointerY: 0, grabOffsetY: 0,
    width: RW, height: RH, viewportWidth: 0, viewportHeight: 0,
  }).right,
  -RW / 2,
);

// ---------------------------------------------------------------------
// Resize drags. The window is anchored bottom-right, so the near edges
// (n/w) resize without touching the offset and the far edges (e/s) have to
// walk it — same pointer travel, two different results.
// ---------------------------------------------------------------------
const near = (delta, startSize = 800, startOffset = 100) =>
  resizeAxis({
    sign: -1, startSize, startOffset, delta, viewport: VW,
    minSize: GEOMETRY_LIMITS.minWidth,
  });
const far = (delta, startSize = 800, startOffset = 100) =>
  resizeAxis({
    sign: 1, startSize, startOffset, delta, viewport: VW,
    minSize: GEOMETRY_LIMITS.minWidth,
  });

// Near edge: dragging AWAY from the window (left/up, negative delta) grows it,
// and the anchored far edge stays exactly where it was.
assert.deepStrictEqual(near(-120), { size: 920, offset: 100 });
assert.deepStrictEqual(near(120), { size: 680, offset: 100 });

// Far edge: dragging away from the window (right/down, positive delta) grows
// it, and the offset shrinks by the same amount so the NEAR edge stays put.
assert.deepStrictEqual(far(120), { size: 920, offset: -20 });
assert.deepStrictEqual(far(-120), { size: 680, offset: 220 });
// Which is the whole point: near edge = viewport - offset - size, unmoved.
for (const delta of [-400, -120, 0, 120, 400]) {
  const { size, offset } = far(delta);
  assert.strictEqual(VW - offset - size, VW - 100 - 800, "far drag pins the near edge");
}

// At the minimum size the window stops shrinking — and the offset stops
// growing with it, so the pinned edge does not slide on under a pointer that
// is no longer resizing anything.
const floored = far(-5000);
assert.strictEqual(floored.size, GEOMETRY_LIMITS.minWidth);
assert.strictEqual(floored.offset, 100 + 800 - GEOMETRY_LIMITS.minWidth);
assert.deepStrictEqual(far(-9999), floored, "past the floor nothing moves further");
assert.strictEqual(near(5000).size, GEOMETRY_LIMITS.minWidth);
assert.strictEqual(near(5000).offset, 100, "a floored near drag still leaves the offset alone");

// Ceiling: the size stops at the viewport.
assert.strictEqual(far(5000).size, VW);
assert.strictEqual(near(-5000).size, VW);

// Growing the far edge of an already half-off-screen window can never push it
// past the min-visible floor: the floor is measured from the size, which grows
// exactly as fast as the offset drops. It is only ever more visible than it
// was — worth pinning down, because it is why the far drag needs no extra
// guard beyond the shared clamp.
for (const delta of [0, 200, 600, 5000]) {
  const { size, offset } = far(delta, 800, -600);
  assert.ok(
    offset >= -(size - GEOMETRY_LIMITS.positionMinVisible),
    `an off-screen window stays grabbable while its far edge grows (${delta})`,
  );
}

// Vertical is the same function with the height minimum.
assert.deepStrictEqual(
  resizeAxis({
    sign: 1, startSize: 400, startOffset: 0, delta: -300, viewport: VH,
    minSize: GEOMETRY_LIMITS.minHeight,
  }),
  { size: GEOMETRY_LIMITS.minHeight, offset: 400 - GEOMETRY_LIMITS.minHeight },
);

// Fractional pointer deltas and sub-pixel start sizes (getBoundingClientRect
// returns them) round to whole pixels rather than leaking into the style.
const fractional = far(0.6, 800.4, 100.2);
assert.strictEqual(fractional.size, 801);
assert.strictEqual(fractional.offset, 100);

// The break-out distance has to be above the tab grip's 5px (a tab drag hands
// the same press on, and must not trip it) and below anything a click can
// produce on the Magic Remote.
assert.ok(
  FULLSCREEN_BREAKOUT_DISTANCE > 5 && FULLSCREEN_BREAKOUT_DISTANCE < 40,
  "break-out distance sits between the tab grip and an accidental swipe",
);

console.log("window-geometry tests passed");
