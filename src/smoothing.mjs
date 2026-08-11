// Temporal smoothing for the reactive backdrop — the ambient-light problem,
// solved the way Hyperion solves it.
//
// WHY THIS EXISTS. Every surface the effect drives (the flat shell colour, the
// per-glyph ink grid, the veil) used to carry its own exponential average with
// a hand-tuned PER-SAMPLE weight, plus a fast path that made big changes land
// FASTER: the average snapped at half weight past a 48-step jump, the veil
// snapped outright past a 0.12 gap, and the grid ran at 0.95 — barely smoothed
// at all. That tuning came from a latency complaint and it answered it, but it
// also means a hard scene cut is a step change on the text: the thing the shell
// does most visibly is exactly the thing it does most abruptly.
//
// Two properties are wrong with a per-sample weight, and both are what Hyperion
// gets right:
//
//   1. A per-sample weight is a SAMPLE-RATE constant, not a time constant. Our
//      sample rate is not ours to choose: the wire runs at ~25 Hz, the legacy
//      luna fallback at ~1.4 Hz, and the solve cadence backs off on its own
//      when the shared GPU process is busy (down to ~1.5 Hz under load). The
//      same weight is therefore a different settling time on every path, and
//      re-tuning it per path is what the pile of *_VIDEO constants was.
//   2. Response speed was tied to jump SIZE the wrong way round. Hyperion's
//      smoothing has one settling time and everything — a candle flicker or a
//      hard cut — takes that long; nothing pops.
//
// So: one time-based mechanism for all three surfaces, parameterised in
// milliseconds, plus a deliberate inversion of the old fast paths — a bigger
// jump gets a LONGER settle, so a scene cut reads as a crossfade instead of a
// flash. That inversion is the actual answer to "strong colour changes are
// annoying"; the rest is what makes it hold on every feed rate.
//
// WHERE WE DEVIATE FROM HYPERION, AND WHY. Hyperion interpolates linearly
// towards the target at a fixed output frequency, which makes its result
// depend on how often the loop actually ran. We use the continuous-time form
// of the same idea, `alpha = 1 - exp(-k·dt/settle)`, which is EXACTLY
// composable: two 10 ms steps land on the same value as one 20 ms step, to
// float precision (asserted in the tests). On a feed whose cadence moves with
// GPU contention that is not a nicety — it is the difference between a
// settling time and a suggestion.
//
// One honest caveat on that word "exactly": it holds for a FIXED settle. The
// stretch below re-reads the settle from the gap that is still open, so within
// a single transition the coefficient shrinks as the gap closes and the result
// does acquire a mild dt dependence — measured at under 10% across the wire's
// normal cadence band (850 ms to 95% at dt=5 against 880 ms at dt=40 for a
// 60-step jump), rising to ~1.3 s only at dt=320. That is a deliberate trade:
// latching a per-transition settle would need per-tile state for 2300 tiles,
// and this module is pure by design. Any test of composability has to assert a
// tolerance band, not agreement.
//
// Everything here is pure: no DOM, no clock, no module state. The caller passes
// dt and reads back a weight.

// `settleMs` is quoted as the time to cover ~95% of a step, which is what a
// person actually means by "it takes half a second". exp(-3) ≈ 0.0498, so the
// time constant is settleMs/3.
const SETTLE_K = 3;

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// The weight to apply to (target - current) for a step of dt milliseconds.
// dt <= 0 → no movement; settle <= 0 → no smoothing at all (the knob's zero
// end), which must be an exact 1 rather than a very large exponent.
export function smoothingAlpha(dtMs, settleMs) {
  if (!(dtMs > 0)) return 0;
  if (!(settleMs > 0)) return 1;
  return 1 - Math.exp((-SETTLE_K * dtMs) / settleMs);
}

// Settling times are a range per surface, and the user's one knob picks a
// point in every range at once (see SETTLE_RANGES). Linear in the knob: the
// ranges are already chosen so that the interesting part of each is spread
// across the travel.
export function settleMsFor(range, level) {
  const t = clamp01(level);
  return range[0] + (range[1] - range[0]) * t;
}

// The inversion of the old cut fast paths. `jump` is the distance still to be
// covered, in whatever unit the profile is written in (channel steps for the
// picture, veil alpha for the veil). Movement below `calm` is noise and settles
// at the base time; at `cut` and beyond the settle is stretched by the full
// factor, so the biggest changes are the gentlest ones.
//
// Never returns less than baseMs — the cap exists to stop a stretch running
// away, not to override a deliberately slow base (the legacy display path is
// slower than any cap here, on purpose: its samples contain our own glyphs and
// under-damping it oscillates).
export function stretchedSettle(baseMs, jump, profile) {
  const { calm, cut, stretch, maxMs } = profile;
  // A zero-width band has no curve to place the jump on. Without this the
  // division yields ±Infinity or NaN, clamp01 passes NaN straight through (both
  // of its comparisons are false), and smoothingAlpha's `!(settleMs > 0)` guard
  // then LAUNDERS that NaN into a full snap — the one behaviour this module
  // exists to remove, arrived at through a value that reads as "finite" to any
  // test asserting on the alpha. Same shape as buildAlphaLut's `span > 0` guard.
  if (!(cut > calm)) return baseMs;
  const t = clamp01((Math.abs(jump) - calm) / (cut - calm));
  const settle = baseMs * (1 + (stretch - 1) * t);
  const ceiling = Math.max(baseMs, maxMs);
  return settle > ceiling ? ceiling : settle;
}

// Per-tile settling would mean an exp() per tile per frame (2304 tiles at 25 Hz
// on a Mali-class GPU's spare CPU cycles). The stretch curve is smooth, so
// quantise the jump into buckets once per frame and look the weight up per
// tile; 32 of them hold the table within ~0.007 of the exact weight (asserted
// in the tests), which is far below what the grid deadband already tolerates.
//
// Deliberately per TILE and not one weight for the whole grid: a picture where
// only part of the frame cuts (a caption appearing, a light turning on in the
// corner) should slow down only the tiles that changed, otherwise one loud
// corner drags the entire map into slow motion.
export function buildAlphaLut(dtMs, baseMs, profile, buckets = 32) {
  const alphas = new Float32Array(buckets);
  const span = profile.cut - profile.calm;
  for (let i = 0; i < buckets; i++) {
    // Bucket centres, so the coarse curve sits on the fine one rather than
    // consistently under- or overshooting it.
    const t = buckets === 1 ? 0 : (i + 0.5) / buckets;
    const jump = profile.calm + span * t;
    alphas[i] = smoothingAlpha(dtMs, stretchedSettle(baseMs, jump, profile));
  }
  return { alphas, calm: profile.calm, invSpan: span > 0 ? 1 / span : 0, buckets };
}

export function alphaForJump(lut, jump) {
  const t = clamp01((Math.abs(jump) - lut.calm) * lut.invSpan);
  let i = (t * lut.buckets) | 0;
  if (i >= lut.buckets) i = lut.buckets - 1;
  return lut.alphas[i];
}

// ---------------------------------------------------------------------------
// The tuning.
//
// Two feed sources, and they are different problems, not different speeds:
//
//   video   — the naked video plane from vtcapture at ~25 Hz. None of our own
//             glyphs are in it, so smoothing here is purely about how the
//             effect should FEEL.
//   display — the legacy luna one-shot fallback at ~1.4 Hz, i.e. what runs when
//             nothing is playing: the home screen, a menu, a paused stream. It
//             samples the composited screen, our own text included, so the
//             shell's ink is part of its own input.
//
// A correction to what this comment used to claim, because the numbers under it
// were wrong for a reason worth writing down. The display floors were derived
// from the old weights' TIME CONSTANTS (700/0.22 and 700/0.6, i.e. 3.2 s and
// 1.2 s) — but `settleMs` here is time-to-95%, which is three time constants.
// So the shipped floors were ~2.4× less damped than the weights they were meant
// to reproduce, and no knob position on that path reached them; the default sat
// at 0.53 per sample, essentially the 0.5 that 0.5.27's own notes record as
// measured-bad ("chased every camera cut and never settled"). The ends below
// are the real equivalents: 700 · ln(0.05)/ln(1−w) = 8440 ms at w=0.22 and
// 2290 ms at w=0.6.
//
// It is NOT, as this file used to say, load-bearing damping against a feedback
// oscillation. That claim does not survive: an exponential average cannot
// remove a steady offset (ink-field.mjs says so where the per-tile deadband is
// defined), the ink→sample→ink loop gain is ~0.02, and the deadbands that
// actually break the loop sit on the INPUT and do not care how fast we smooth.
// It is a feel floor, and the knob should be able to move in both directions
// from it — hence a range rather than a fixed value.
//
// Ranges are [knob at 0, knob at 100]. The zero end reproduces the per-sample
// weight that shipped before this module existed, and the default (50) is the
// calmer half. That is exact on the display path; on the video path it is
// deliberately not, and cannot be, because the old tuning there was two
// behaviours rather than one — a base weight for drift plus fast paths that
// made CUTS land faster. Reproducing the base weight would mean reproducing a
// cut response of 173 ms and a veil that snapped in 0 ms, which is the thing
// the user asked us to stop doing. Sub-cut drift at knob 0 is therefore quicker
// than 0.5.31's, and a cut at knob 0 is slower.
export const SETTLE_RANGES = {
  // The flat colour drives the cursor, the accent and glyphs on filled cells.
  // It is one colour under the whole shell, so it is the one that reads as a
  // flicker when it moves — the slowest of the three, as it always was.
  // 8440 at the fast end is exactly the old 0.22-per-sample weight at the luna
  // path's 700 ms cadence — a long number only because that path samples eight
  // times slower than the wire. The stretch is inert here (the ceiling is
  // max(baseMs, maxMs) and maxMs is far below this), which is fine: at 1.4 Hz
  // there is no such thing as a cut you could respond to differently.
  flat: { video: [110, 1100], display: [8440, 18000] },
  // The per-glyph map is what makes the text track the picture. Too slow here
  // and the colours belong to a shot that has already moved on, which is the
  // complaint that pushed this to 0.95 in the first place — hence a much
  // shorter range than the flat colour's.
  grid: { video: [45, 520], display: [2290, 6000] },
  // The veil is asymmetric on purpose, and it is the one place where readability
  // outranks calm. Rising = the picture got brighter = the text is about to be
  // hard to read, and the scrim is the thing that fixes it, so it goes on
  // quickly (it used to snap outright). Falling = the picture got darker = the
  // text is already comfortable and the veil is only stealing transparency, so
  // it eases off.
  veilUp: { video: [60, 300], display: [300, 900] },
  veilDown: { video: [90, 800], display: [600, 1700] },
};

// `calm` and `cut` for the picture are in channel steps of the 0..255 average.
// 48 is inherited from the old AVG_CUT_DELTA, which was measured as the point
// where a whole-frame average change is unmistakably a scene cut rather than a
// pan or codec noise — the same threshold, now used to slow down rather than to
// speed up. `calm` sits just above the noise floor of the reduced grid.
export const JUMP_PROFILES = {
  flat: { calm: 4, cut: 48, stretch: 2.2, maxMs: 1800 },
  grid: { calm: 4, cut: 48, stretch: 2.2, maxMs: 1200 },
  // Veil jumps are in veil alpha (0..1). 0.12 was the old snap threshold.
  veil: { calm: 0.02, cut: 0.25, stretch: 2, maxMs: 1600 },
};

// One place that turns (surface, source, knob) into a settling time, so the
// controller never indexes the table by hand.
export function settleFor(kind, sceneIsRaw, level) {
  const ranges = SETTLE_RANGES[kind];
  return settleMsFor(sceneIsRaw ? ranges.video : ranges.display, level);
}
