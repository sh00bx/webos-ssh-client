import assert from "node:assert";
import { nextInRing, nextInRow } from "../src/focus-ring.mjs";

const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };
const ring = [a, b, c];

// --- vertical ring: steps and wraps ---------------------------------------
assert.strictEqual(nextInRing(ring, a, 1), b, "down goes to the next control");
assert.strictEqual(nextInRing(ring, b, -1), a, "up goes to the previous one");
assert.strictEqual(nextInRing(ring, c, 1), a, "down off the end wraps to the top");
assert.strictEqual(nextInRing(ring, a, -1), c, "up off the top wraps to the end");

// Focus parked outside the form (on <body> after a control was removed, which
// is exactly what happens when a session's Confirm button ends a session).
assert.strictEqual(nextInRing(ring, null, 1), a, "down with no focus enters at the top");
assert.strictEqual(
  nextInRing(ring, { id: "gone" }, -1),
  c,
  "up with stale focus enters at the end",
);

assert.strictEqual(nextInRing([], a, 1), null, "an empty ring moves nowhere");
assert.strictEqual(nextInRing(null, a, 1), null, "a missing ring moves nowhere");
assert.strictEqual(nextInRing([a], a, 1), a, "a single control is its own neighbour");

// --- row: steps but never wraps -------------------------------------------
assert.strictEqual(nextInRow(ring, a, 1), b, "right goes to the next button");
assert.strictEqual(nextInRow(ring, c, -1), b, "left goes to the previous one");
assert.strictEqual(nextInRow(ring, c, 1), null, "right at the end of a row stops");
assert.strictEqual(nextInRow(ring, a, -1), null, "left at the start of a row stops");
assert.strictEqual(
  nextInRow(ring, { id: "gone" }, 1),
  null,
  "a control that is not in the row moves nowhere",
);
assert.strictEqual(nextInRow([], a, 1), null, "an empty row moves nowhere");

console.log("focus-ring tests passed");
