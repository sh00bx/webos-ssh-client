// Placement arithmetic for the hover tooltip (src/tooltip.mjs).
//
// The cases that matter are all edge cases: a bubble under a button at the very
// bottom of the screen, a bubble wider than the space beside the button it
// belongs to, and an anchor that has been torn out of the DOM while the pointer
// still sits where it used to be.

import assert from "node:assert/strict";
import { placeTip, tipIsShowable, TIP_ARROW_INSET } from "../src/tooltip.mjs";

const VIEWPORT = { width: 1920, height: 1080 };

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

// A toolbar button in the middle of the screen: bubble below, centred, arrow
// on the button's centre line.
{
  const anchor = rect(900, 100, 40, 30);
  const placed = placeTip({
    anchor,
    tip: { width: 200, height: 40 },
    viewport: VIEWPORT,
  });
  assert.equal(placed.side, "below");
  assert.equal(placed.top, 130 + 9);
  assert.equal(placed.left, 920 - 100);
  assert.equal(placed.arrowLeft, 100);
}

// Anchored at the bottom edge: there is no room below, so it flips above.
{
  const anchor = rect(900, 1040, 40, 30);
  const placed = placeTip({
    anchor,
    tip: { width: 200, height: 40 },
    viewport: VIEWPORT,
  });
  assert.equal(placed.side, "above");
  assert.equal(placed.top, 1040 - 9 - 40);
}

// Near the bottom but with room to spare: still below. (Guards the boundary —
// an off-by-one here would flip every action row in the connect form.)
{
  const anchor = rect(900, 1000, 40, 19);
  const placed = placeTip({
    anchor,
    tip: { width: 200, height: 40 },
    viewport: VIEWPORT,
  });
  assert.equal(placed.side, "below");
  assert.equal(placed.top + 40, 1068);
}

// Neither side fits (a tall bubble on a short viewport): stays below and is
// clamped into the viewport rather than being flipped into an equally bad spot.
{
  const placed = placeTip({
    anchor: rect(100, 200, 40, 30),
    tip: { width: 200, height: 400 },
    viewport: { width: 600, height: 400 },
  });
  assert.equal(placed.side, "below");
  assert.equal(placed.top, 12);
}

// Right-edge anchor: the bubble is pushed left to stay on screen, and the arrow
// stays on the anchor instead of travelling with the bubble.
{
  const anchor = rect(1880, 100, 30, 30);
  const placed = placeTip({
    anchor,
    tip: { width: 300, height: 40 },
    viewport: VIEWPORT,
  });
  assert.equal(placed.left, 1920 - 12 - 300);
  // Anchor centre is 1895, bubble starts at 1608, so the arrow wants to sit
  // 287px in — one px past the inset that keeps it inside the bubble's end, so
  // it lands on 286.
  assert.equal(placed.arrowLeft, 300 - TIP_ARROW_INSET);
}

// Left-edge anchor, and a bubble so wide the arrow would fall off its left end.
{
  const placed = placeTip({
    anchor: rect(2, 100, 12, 12),
    tip: { width: 300, height: 40 },
    viewport: VIEWPORT,
  });
  assert.equal(placed.left, 12);
  assert.equal(placed.arrowLeft, TIP_ARROW_INSET);
}

// Bubble wider than the viewport: pinned to the near margin, never to a
// negative offset that would put the text off the left of the screen.
{
  const placed = placeTip({
    anchor: rect(100, 100, 40, 30),
    tip: { width: 900, height: 40 },
    viewport: { width: 600, height: 400 },
  });
  assert.equal(placed.left, 12);
}

// Showability: no text, a detached anchor, or a zero rect (a tab closed under
// the pointer) all mean "no bubble".
assert.equal(tipIsShowable({ text: "x", connected: true, rect: rect(0, 0, 10, 10) }), true);
assert.equal(tipIsShowable({ text: "", connected: true, rect: rect(0, 0, 10, 10) }), false);
assert.equal(tipIsShowable({ text: "x", connected: false, rect: rect(0, 0, 10, 10) }), false);
assert.equal(tipIsShowable({ text: "x", connected: true, rect: rect(0, 0, 0, 0) }), false);
assert.equal(tipIsShowable({ text: "x", connected: true, rect: null }), false);

console.log("tooltip.test.mjs: ok");
