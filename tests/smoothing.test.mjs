import assert from "node:assert";
import {
  alphaForJump,
  buildAlphaLut,
  clamp01,
  JUMP_PROFILES,
  SETTLE_RANGES,
  settleFor,
  settleMsFor,
  smoothingAlpha,
  stretchedSettle,
} from "../src/smoothing.mjs";

const close = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

// --- the weight itself ------------------------------------------------------

// The property the whole module exists for. A per-sample weight is a
// sample-rate constant; this one is a time constant, and "time constant" is
// only true if splitting a step in two lands in the same place. Our feed's
// cadence moves with GPU contention, so this is not a nicety.
{
  const settle = 300;
  const step = (value, dt) => value + (1 - value) * smoothingAlpha(dt, settle);
  const oneStep = step(0, 40);
  let split = 0;
  for (let i = 0; i < 4; i++) split = step(split, 10);
  close(split, oneStep, 1e-12, "4x10ms must equal 1x40ms");

  let manySteps = 0;
  for (let i = 0; i < 100; i++) manySteps = step(manySteps, 1);
  close(manySteps, step(0, 100), 1e-12, "100x1ms must equal 1x100ms");
}

// Settling time means what it says: ~95% of the step covered after settleMs.
{
  close(smoothingAlpha(500, 500), 0.95, 0.01, "one settling time covers ~95%");
  close(smoothingAlpha(1000, 500), 0.9975, 0.01, "two cover ~99.75%");
}

// Degenerate inputs must not produce NaN weights — a single NaN entering
// gridSmoothed would poison every later frame through the exponential.
assert.strictEqual(smoothingAlpha(0, 300), 0, "no elapsed time, no movement");
assert.strictEqual(smoothingAlpha(-5, 300), 0, "a clock going backwards is not movement");
assert.strictEqual(smoothingAlpha(40, 0), 1, "zero settle is no smoothing at all");
assert.strictEqual(smoothingAlpha(40, -1), 1, "negative settle degrades to no smoothing");
for (const dt of [0, 1, 40, 700, 5000]) {
  for (const settle of [0, 45, 300, 4000]) {
    const a = smoothingAlpha(dt, settle);
    assert.ok(Number.isFinite(a) && a >= 0 && a <= 1, `alpha out of range: ${dt}/${settle}`);
  }
}

// --- the stretch (the inversion of the old cut fast paths) ------------------

// The point of the exercise: a bigger jump is a SLOWER one, so a scene cut
// crossfades where it used to pop.
{
  const p = JUMP_PROFILES.flat;
  const calm = stretchedSettle(300, 0, p);
  const mid = stretchedSettle(300, (p.calm + p.cut) / 2, p);
  const cut = stretchedSettle(300, p.cut, p);
  assert.strictEqual(calm, 300, "movement below the noise floor settles at the base time");
  assert.ok(mid > calm && cut > mid, "settling time must grow with the jump");
  close(cut, 300 * p.stretch, 1e-9, "a full cut gets the full stretch");
  assert.strictEqual(
    stretchedSettle(300, p.cut * 10, p),
    cut,
    "beyond a cut there is nothing left to stretch",
  );
  assert.strictEqual(stretchedSettle(300, -p.cut, p), cut, "direction does not matter");
}

// The cap bounds a runaway stretch; it must never SHORTEN a deliberately slow
// base. The legacy display path is slower than any cap here on purpose — its
// samples contain our own glyphs, and under-damping it oscillates.
{
  const p = JUMP_PROFILES.flat;
  assert.strictEqual(stretchedSettle(4000, p.cut, p), 4000, "cap must not undercut the base");
  assert.strictEqual(stretchedSettle(1000, p.cut, p), p.maxMs, "cap bounds the stretch");
  assert.ok(p.maxMs < 1000 * p.stretch, "this test only means something if the cap binds");
}

// --- the knob ---------------------------------------------------------------

for (const [kind, ranges] of Object.entries(SETTLE_RANGES)) {
  for (const src of ["video", "display"]) {
    const range = ranges[src];
    assert.ok(range[0] < range[1], `${kind}.${src}: range must open upwards`);
    assert.strictEqual(settleMsFor(range, 0), range[0], `${kind}.${src}: 0 is the fast end`);
    assert.strictEqual(settleMsFor(range, 1), range[1], `${kind}.${src}: 1 is the calm end`);
    assert.ok(
      settleMsFor(range, 0.5) > range[0] && settleMsFor(range, 0.5) < range[1],
      `${kind}.${src}: the default must sit inside the range`,
    );
    // Out-of-range levels are clamped, not extrapolated: a corrupt pref must
    // not produce a negative settling time (which reads as "no smoothing").
    assert.strictEqual(settleMsFor(range, -3), range[0], `${kind}.${src}: clamps below`);
    assert.strictEqual(settleMsFor(range, 12), range[1], `${kind}.${src}: clamps above`);
  }
  // The legacy display feed samples the composited screen, our own text
  // included, so its floor is damping and not taste: it must stay slower than
  // the video path at every position of the knob.
  for (const level of [0, 0.25, 0.5, 1]) {
    assert.ok(
      settleMsFor(ranges.display, level) > settleMsFor(ranges.video, level),
      `${kind}: the self-feedback path must stay the slower one (level ${level})`,
    );
  }
}

// The surfaces keep their established ordering: one flat colour under the whole
// shell reads as a flicker when it moves, a tile only recolours the letters
// standing on it.
for (const level of [0, 0.5, 1]) {
  assert.ok(
    settleFor("flat", true, level) > settleFor("grid", true, level),
    `flat must stay slower than the per-glyph map (level ${level})`,
  );
  assert.ok(
    settleFor("veilUp", true, level) < settleFor("veilDown", true, level),
    `the veil must go on faster than it comes off (level ${level})`,
  );
}

assert.strictEqual(settleFor("grid", true, 0.5), settleMsFor(SETTLE_RANGES.grid.video, 0.5));
assert.strictEqual(settleFor("grid", false, 0.5), settleMsFor(SETTLE_RANGES.grid.display, 0.5));

// --- the per-tile lookup table ---------------------------------------------

// The table is an optimisation, so what matters is that it agrees with the
// function it stands in for. Bucket centres, hence a half-bucket of slack.
{
  const dt = 40;
  const base = 260;
  const p = JUMP_PROFILES.grid;
  const lut = buildAlphaLut(dt, base, p);
  for (let jump = 0; jump <= p.cut * 1.5; jump += 1) {
    const exact = smoothingAlpha(dt, stretchedSettle(base, jump, p));
    close(alphaForJump(lut, jump), exact, 0.01, `lut disagrees at jump ${jump}`);
  }
  // Monotone: every step towards a cut must be a step towards slower.
  let prev = Infinity;
  for (let jump = 0; jump <= p.cut; jump += p.cut / 32) {
    const a = alphaForJump(lut, jump);
    assert.ok(a <= prev + 1e-9, `weights must not rise with the jump (at ${jump})`);
    prev = a;
  }
  // Out of range in both directions, including the exact top of the range,
  // which is the index that overflows a naive (t * buckets) | 0.
  assert.strictEqual(alphaForJump(lut, 0), lut.alphas[0], "below the floor: fastest bucket");
  assert.strictEqual(alphaForJump(lut, 1e6), lut.alphas[lut.buckets - 1], "above: slowest");
  assert.strictEqual(alphaForJump(lut, p.cut), lut.alphas[lut.buckets - 1], "exact top");
  // The sign is stripped, because the veil hands this a signed gap.
  assert.strictEqual(alphaForJump(lut, -p.cut), alphaForJump(lut, p.cut), "direction-blind");
  assert.strictEqual(alphaForJump(lut, -1), lut.alphas[0], "a small negative gap is still calm");
  for (const a of lut.alphas) assert.ok(a >= 0 && a <= 1, "every bucket is a usable weight");
}

// A stalled feed (dt 0) must not move anything, and a single bucket must not
// divide by a zero span.
{
  const zero = buildAlphaLut(0, 260, JUMP_PROFILES.grid);
  for (const a of zero.alphas) assert.strictEqual(a, 0, "no elapsed time, no movement");
  // ⚠️ Assert on stretchedSettle ITSELF, not on the alpha it feeds. This used to
  // check only that the weight came back finite — which it always did, because
  // the failure launders itself into a perfectly finite 1: a zero-width band
  // divides by zero, clamp01 passes the NaN straight through (both of its
  // comparisons are false against NaN), and smoothingAlpha's `!(settleMs > 0)`
  // guard reads that NaN as "no smoothing asked for" and returns exactly 1. A
  // full snap — the single behaviour this module exists to remove — arriving
  // through a value the old assertion certified as healthy.
  const degenerate = { calm: 5, cut: 5, stretch: 2, maxMs: 900 };
  assert.strictEqual(
    stretchedSettle(260, 5, degenerate),
    260,
    "a zero-width band falls back to the base settle, not to NaN",
  );
  assert.ok(
    smoothingAlpha(40, stretchedSettle(260, 40, degenerate)) < 1,
    "...so it still smooths rather than snapping",
  );
  const one = buildAlphaLut(40, 260, degenerate, 1);
  assert.ok(Number.isFinite(alphaForJump(one, 5)), "a zero-width profile must not divide by zero");
  assert.ok(alphaForJump(one, 5) < 1, "and the single bucket is a weight, not a snap");
}

// --- the display path really is damped like the weights it replaced ----------
// The ranges are the one place in this module where a number can be wrong
// without anything else noticing: they are pure tuning, every value "works",
// and the old assertion here only checked that display was slower than video —
// which stayed true even when the display floors were 2.4x under-damped for a
// whole release, because they were derived from a time CONSTANT while settleMs
// is time-to-95%. So pin the fast end to the per-sample weight it is meant to
// reproduce at the luna path's real 700 ms cadence.
{
  const LUNA_MS = 700;
  // ⚠️ BOTH SIDES. A `<=` here is not a pin, it is a floor, and every
  // over-damped value satisfies it — a reviewer put the display ranges up by
  // 100× (settling in ~844 SECONDS) and this whole suite stayed green. The fix
  // this block exists to guard was itself a factor-of-2.4 error in the same
  // quantity, so a one-sided assertion could not have caught its own subject.
  // The band is what makes the derivation in smoothing.mjs — 700·ln(0.05)/
  // ln(1−w) = 8440 at w=0.22 and 2290 at w=0.6 — a checkable claim.
  close(
    smoothingAlpha(LUNA_MS, settleFor("flat", false, 0)),
    0.22,
    0.005,
    "the flat display floor reproduces the 0.22 weight it replaced",
  );
  close(
    smoothingAlpha(LUNA_MS, settleFor("grid", false, 0)),
    0.6,
    0.005,
    "the grid display floor reproduces the 0.6 weight it replaced",
  );
  // The slow end is otherwise unasserted anywhere, so bound it too — loosely,
  // since it is taste rather than a reproduction of anything.
  for (const kind of ["flat", "grid"]) {
    assert.ok(
      settleFor(kind, false, 1) < 30000,
      `${kind} display: the calm end stays inside half a minute`,
    );
  }
  // ...and the knob can only make it calmer from there, never louder.
  for (const kind of ["flat", "grid"]) {
    assert.ok(
      settleFor(kind, false, 1) > settleFor(kind, false, 0),
      `${kind} display: turning the knob up lengthens the settle`,
    );
  }
}

// --- clamp01 ----------------------------------------------------------------

assert.strictEqual(clamp01(-1), 0);
assert.strictEqual(clamp01(2), 1);
assert.strictEqual(clamp01(0.25), 0.25);

console.log("smoothing tests passed");
