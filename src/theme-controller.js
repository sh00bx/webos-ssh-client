// Theme state + the reactive backdrop feed. While the effect is switched on
// (the toggle beside the flash slider) and a session is on screen, subscribe to
// the service's backdrop/watch feed — the composited screen, video plane
// included, sampled ~1.4×/s by the root-side backdropd daemon — and colour the
// shell against it.
//
// EVERY theme reacts; what differs is the colour it reacts in. That split is
// the whole design: the machinery here and in ink-field.mjs solves lightness
// for a contrast target and is identical for all of them, while the theme's
// `reactive` profile (themes.mjs) decides the hue — Chameleon complements the
// picture, the other four bend their own signature colour towards it. So the
// only thing this module needs to know about the active theme is to pass its
// profile down.
//
// The feed carries two things, and they drive two different surfaces:
//
//   * the screen average, which still derives one flat colour. That colour is
//     what the cursor, the selection, the window-chrome accent and any glyph
//     sitting on a filled cell get, because none of those are looking at the
//     picture directly.
//   * a tile grid of the screen, which derives the per-glyph ink map: every
//     letter contrasts with the picture *behind that letter*. An average is
//     the wrong statistic for that job — half a line over a dark suit and half
//     over a sunlit wall has no single right answer, and the flat version
//     visibly gave up on one half or the other.
//
// The map path costs no re-render at all: the colours reach the glyphs as a
// CSS background clipped to the text, so a frame is one custom property. The
// flat path still walks xterm's grid, so it keeps its repaint deadband.
//
// A daemon predating the grid sends averages only; then the map is never
// applied, `data-chameleon-ink` never appears, and the effect is exactly what
// it was before — which is also the fallback when a canvas is unavailable.
import { themeById, loadThemeId, saveThemeId, nextThemeId } from "./themes.mjs";
import { adaptiveShellFor, oklabDistance } from "./color.mjs";
import { buildInkField, computeVeil, decodeGrid, gridRectFor } from "./ink-field.mjs";
import { renderInkMap, renderInkTexture, releaseInkMap } from "./ink-map.mjs";
import { appState } from "./app-state.js";
import { debugEvent } from "./debug.js";
import { subscribeBackdrop, compactError } from "./service-client.js";
import {
  alphaForJump,
  buildAlphaLut,
  JUMP_PROFILES,
  settleFor,
  smoothingAlpha,
  stretchedSettle,
} from "./smoothing.mjs";
import {
  clampFlashPercent,
  clampSmoothingPercent,
  loadFlashPercent,
  loadReactiveEnabled,
  loadSmoothingPercent,
  saveFlashPercent,
  saveReactiveEnabled,
  saveSmoothingPercent,
} from "./prefs.js";

let currentThemeId = loadThemeId();
// Theme switch buttons register here so a cycle from any surface (terminal
// toolbar or connect form) keeps every visible button label in sync.
const themeButtons = new Set();

let backdropSub = null;
let backdropSmoothed = null;
let backdropLive = false;
// Which side of the background the text is currently on, fed back into the next
// derivation so the light/dark decision has an incumbent to defend (color.mjs).
let adaptiveSide = "light";
// Last ink colour actually pushed to xterm, for the repaint deadband.
let appliedInk = null;
// Smoothed backdrop grid (Float32, RGB per tile) and its dimensions, plus the
// per-tile light/dark decisions carried into the next frame so each tile has an
// incumbent side to defend — the same hysteresis the flat path uses, applied
// tile by tile.
let gridSmoothed = null;
// The previous frame's RAW tiles, for the cut detector alone. It has to be the
// raw picture and not the smoothed one: the smoothed lag is a function of the
// smoothing knob, so judging a cut by it makes the detector's threshold mean
// something different at every knob position (see CUT_FRAME_JUMP). Nulled
// wherever gridSmoothed is, since a frame-to-frame difference across a reset is
// not a difference at all.
let gridPrevRaw = null;
let gridW = 0;
let gridH = 0;
// What the tiles are a picture of ("video" = naked video plane, "display" =
// composited screen); a flip invalidates the smoothing history, because the
// two describe different layers of the same screen.
let gridSrc = "display";
// The source of the last grid we actually saw, or null when we have not seen
// one yet. `gridSrc` above cannot answer that question — it is initialised and
// reset to "display", so it reads as a genuine display frame during exactly the
// window where nothing is known: session start, and every resume before the
// first grid lands.
//
// This matters twice over, because a grid-less message on the video wire is
// ordinary traffic (the average and the grid are separate lines and do not
// always arrive in one read). Classifying those as "display" picks settling
// times 4.5× longer for the length of the gap — visible as the cursor and the
// accent stalling mid-transition — and, worse, flips what adaptiveShellFor
// computes: the display branch un-composites a panel that is not in a video
// sample at all, which at a low panel opacity can push the background past the
// light/dark threshold and put the ink on the wrong side.
let lastGridSrc = null;
// Mean per-channel movement accumulated since the last actual re-solve. The
// deadband has to be judged against this, not against a single frame's
// movement: at the vtcapture cadence (~10 Hz) a slow fade moves every frame
// by less than any sensible threshold, and comparing per-frame would skip
// the entire fade rather than the still frames in it.
let gridDrift = 0;
// The largest single-frame mean RAW jump seen since the last re-solve — the cut
// detector, kept separate from gridDrift on purpose (see CUT_FRAME_JUMP). The
// deadband above must stay post-alpha, because the ink is solved from the
// SMOOTHED grid and a picture whose smoothed value has not moved really does
// produce the same map; the cut floor must not, because it is asking about the
// picture rather than about our own filter.
let gridCutJump = 0;
let inkSides = null;
// The backgrounds those side decisions were made on — the deadband that keeps
// a tile from flipping under the influence of its own ink (see ink-field.mjs).
let inkAnchor = null;
// Where the (window-cropped) field sat on the full grid last frame; the sides
// and anchors above are only meaningful together with it.
let inkOrigin = null;
// Tiles under the window (plus the solve margin), as a mask over the coarse
// grid. Drift is only counted inside it: motion the window cannot see used to
// trigger solves whose map came out identical — CDP counting on the TV put
// that at roughly HALF of all solves (12.5/s solved, 6.5/s changed anything).
let driftMask = null;
let driftMaskCount = 0;
let driftMaskKey = "";
// The window's tile rect from the last solve — the message-cadence veil pass
// reuses it rather than reading geometry per message.
let lastPanelRect = null;
// Presentation probe (see SOLVE_MAX_INTERVAL_MS): smoothed interval between
// composited frames, sampled for a few frames right AFTER each map write —
// only then is damage guaranteed pending. A permanent rAF loop would be
// wrong here, not just wasteful: webOS renders on demand, so an idle page
// gets no BeginFrames, the loop would read that as "slow compositor",
// throttle further, cause even less damage — a self-starving spiral.
let probeId = 0;
let probeLastTs = 0;
let probeCount = 0;
let frameMsEma = 17;
// Solves are deferred until this time (nowMs) while the user types (see
// deferSolves). Not cleared on teardown — a stale value only ever lies a few
// hundred ms into the past.
let solveHoldUntil = 0;

// Called from the session's input path on every keystroke: hold map solves
// briefly so the expensive text-clip raster never lands in the same frame as
// the keystroke's echo.
export function deferSolves(ms) {
  const until = nowMs() + ms;
  if (until > solveHoldUntil) solveHoldUntil = until;
}

function probeTick(ts) {
  probeId = 0;
  if (probeLastTs) {
    const dt = ts - probeLastTs;
    // Gaps over half a second are suspension, not contention.
    if (dt < 500) frameMsEma += (dt - frameMsEma) * 0.25;
  }
  probeLastTs = ts;
  if (++probeCount < 5) probeId = requestAnimationFrame(probeTick);
}

function startPresentProbe() {
  // Extend a running probe, never restart it: writes can arrive FASTER than
  // presented frames (that is the very condition this probe exists to
  // detect), and wiping the baseline on every write would keep the probe
  // from ever measuring a single interval — leaving the EMA at its healthy
  // default while the compositor drowns. (Shipped that way once: 13 writes/s
  // against a 267 ms presentation interval, floor never moved.)
  probeCount = 0;
  if (!probeId) {
    probeLastTs = 0;
    probeId = requestAnimationFrame(probeTick);
  }
}

function stopPresentProbe() {
  if (probeId) {
    cancelAnimationFrame(probeId);
    probeId = 0;
  }
  probeLastTs = 0;
  frameMsEma = 17;
}
let inkFrames = 0;
let inkMapApplied = false;
// Time (nowMs) of the last actual solve, for the repaint-rate floor.
let inkLastSolveTs = 0;
// The veil as smoothed over time, and the value last written to CSS (writes
// under the deadband are skipped; the CSS transition hides the steps).
let veilSmoothed = 0;
let veilApplied = 0;
// Whether veilSmoothed holds a value that belongs to the picture on screen.
// False after every teardown, and the next veil pass then writes the raw value
// straight out instead of easing towards it from zero. Without this the scrim
// ramps up from nothing on every resume — Hide/Show, the Back key, a
// screensaver, a grid stall — while the ink snaps to a fully veiled background
// on the same frame, so the text comes back washed out for 120-200 ms with no
// scene change to explain it. Same "no history, start fresh" rule the grid
// already uses (gridSmoothed is seeded from the first sample, not eased into).
let veilSeeded = false;
// Consecutive frames that carried no usable grid (see where it is counted).
let inkMapMissing = 0;
// Pending teardown after the feed reported itself unavailable (see the grace
// note where it is armed).
let backdropLostTimer = null;
// A solve deferred to the moment the interval floor opens (see applyInkMap:
// checking the floor only at frame edges quantised the effect to every second
// frame). The context is refreshed by every frame that arrives while armed,
// so the deferred solve always runs on the newest smoothed grid.
let solveTimer = null;
let solveTimerDue = 0;
let pendingSolve = null;
// Last flat ink actually handed to the DOM. The derivation drifts by a stone's
// throw every frame while the average settles, and --chameleon-flat-ink is an
// inherited custom property on the wrapper — writing it invalidates the
// computed style of every span in the terminal (the exact cost that pushed the
// map image to an inline style). Below the repaint deadband the change is
// invisible by definition, so it is not worth that invalidation.
let flatInkShown = null;
// --panel-bg-rgb only changes with the theme, and getComputedStyle on the body
// at the feed's cadence forces a style recalc per frame for a constant answer.
// Invalidated in applyTheme.
let panelRgbCache = null;
// The flat derivation (adaptiveShellFor) bisects ink lightness with a gamut
// search per step — a real cost per frame — while its input, the smoothed
// average, moves by fractions of a channel step between frames. Cache the
// result and only re-derive once the average has moved far enough from the
// anchor it was derived at to possibly change the outcome.
let derivedCache = null;
const DERIVE_EPSILON = 0.5;
// The loudness knob (0..1), persisted as a percentage. Read once at module
// load; the slider goes through setChameleonFlash, which invalidates everything
// derived from it so the new look lands on the next frame.
let flashLevel = clampFlashPercent(loadFlashPercent()) / 100;
// Whether the effect runs at all. Read once at module load; the toggle goes
// through setReactiveEnabled, which subscribes or tears down.
let reactiveOn = loadReactiveEnabled();
// How gently the effect follows the picture (0..1), persisted as a percentage.
// Picks a point in every settling range in smoothing.mjs at once. Nothing
// derived is cached on it, so the slider needs no invalidation — it changes the
// weight of the next step and that is all.
let smoothLevel = clampSmoothingPercent(loadSmoothingPercent()) / 100;
// Time of the last feed sample. The smoothing weights are computed from the gap
// to this, which is the whole point of the exercise: the feed's cadence is not
// constant (~25 Hz on the wire, ~1.4 Hz on the luna fallback, and the solve
// floor backs off under GPU contention), so a per-sample weight would be a
// different settling time on every path. Zeroed on teardown — a resumed feed
// starts fresh rather than easing in from a picture that is minutes old.
let lastSampleTs = 0;

// MONOTONIC, deliberately — every timestamp in this module reads from here.
//
// These values are all differences: elapsed time for the smoothing weights, and
// two interval floors (the solve floor and the typing hold) that are compared
// against a deadline. A wall clock makes each of those a lie whenever the clock
// is stepped, and this device does step it — it has no RTC, so it comes up at
// the epoch and jumps once NTP answers, right around when the user opens the
// app. Backwards, `dtMs` goes negative and smoothingAlpha's `!(dtMs > 0)` guard
// freezes every surface until the clock catches up, while `wait` in applyInkMap
// arms a setTimeout that far into the future and holds the map frozen for the
// length of the step. Forwards, dt clamps to the 2 s cap, which saturates every
// weight to ~1: the snap this whole module exists to remove.
//
// It must be all of them or none: mixing the two clocks would make one
// difference meaningful and the next one nonsense.
const nowMs =
  typeof performance === "object" && performance && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

// The three surfaces' smoothing lives in smoothing.mjs: settling times in
// milliseconds per surface and per feed source, picked by the one knob
// (smoothLevel) and stretched by how far the picture actually jumped. What used
// to be here — a per-sample weight per surface per source, plus a fast path
// that made big jumps land FASTER — is gone; see that module's header for why
// the sign of that last part was the problem.
// Floor between two map solves. The wire runs faster than this on purpose
// (fresher data for whichever frame does get solved); the solve+repaint is
// the expensive half — every update re-rasterises the text-clipped layer —
// and this is the knob that keeps the renderer honest. 55 rather than the
// original 80 rests on two 2026-07-30 measurements: the veil no longer
// re-rasterises the text layer (will-change, 0.5.19), and CDP counting showed
// barely half of all solves even produce a changed map — the other half were
// triggered by motion OUTSIDE the window, which the drift mask below now
// ignores. Verify renderer CPU under live video again if this is raised.
const SOLVE_MIN_INTERVAL_MS = 70;
// On the WebGL path that whole argument is void: a map update is a few
// kilobytes of texture and one extra draw call, not a raster of every glyph
// mask on the layer. Measured on the device right after the switch, the page
// presents at 16.7 ms p50 AND p95 — the ~100 ms spike that this floor existed
// to ration is simply gone — while the floor still held the effect to ~14
// solves/s. 40 ms is the wire (VT_INTERVAL_MS in backdropd), so this stops
// rationing and lets the map run as fresh as the data actually is; the
// presentation-tracked floor above still backs off on its own if the shared
// GPU process gets busy.
const SOLVE_MIN_INTERVAL_WEBGL_MS = 40;
// The floor is not one number, because the right rate is bounded by how fast
// this WebView is actually being PRESENTED — and that is not ours to decide:
// the GPU/browser process is shared with whatever app plays the video (the
// YouTube app's own WebView holds ~60% of a core by itself), and under that
// contention webOS presented this page at ~4 fps while our main thread sat
// idle (rAF p50 250 ms, event-loop lag 4 ms — measured 2026-07-30). Solving
// faster than frames can be shown is pure queueing: it raises the visible
// latency and the input lag at the same time, which is exactly what the
// fixed 55 ms floor did. So the floor tracks the measured presentation
// interval (see presentProbe): healthy compositor -> SOLVE_MIN, contended
// compositor -> we shed our share first.
// The scale factors are set by an A/B on the device (2026-07-30, ZDF live):
// with clip:text overridden off, presentation ran at 67 ms p50; with it on
// and the map updating a few times a second, 217 ms — one map update costs
// this Mali on the order of 100+ ms of GPU raster (thousands of glyph masks
// on an 1120×626 layer), and there is no partial-invalidation path for a
// background-image change. So under a loaded compositor the map is a
// ~1.5 Hz effect, full stop; spending more only buys queueing. Cuts stay
// twice as fast — a fresh colour right after a scene change is the update
// people actually notice, and single solves cannot raise the sustained rate.
const SOLVE_MAX_INTERVAL_MS = 700;
const SOLVE_FLOOR_PER_FRAME = 3;
const SOLVE_CUT_MAX_MS = 350;
// Except on a hard cut. Latency is FELT at scene cuts, and cuts are rare, so a
// frame whose picture unmistakably jumped (a real cut moves the mean by dozens
// of channel steps; pans and noise stay well under this) may solve on a shorter
// floor. Steady-state raster cost is untouched — this only moves single solves
// earlier, it cannot raise the sustained rate.
//
// Judged on how far the picture moved BETWEEN TWO FRAMES — not on how far the
// smoothing then travelled, and not on the gap still open between the two.
//
// Both of those were tried and both are the same mistake in different clothes:
// a quantity whose size depends on the smoothing knob. Post-alpha movement (the
// 0.5.32 shape) shrank 5-10× when this module slowed the grid down, so the cut
// path went quiet except under contention. The open raw-to-smoothed gap (the
// first repair) is worse in the other direction: under sustained motion it
// settles at roughly delta/alpha and STAYS there, so an ordinary pan of ~8
// channel steps per frame leaves a permanent ~42-step lag at the default knob
// and the "cut" floor silently becomes the steady-state floor — double the
// solve rate on exactly the contended path SOLVE_MAX_INTERVAL_MS exists to
// ration, which is the opposite of what a cut fast-path may cost.
//
// A frame-to-frame difference has neither problem: a pan gives the same small
// number every frame at every knob position, and only a real cut spikes it.
// It costs one extra grid-sized byte buffer (see gridPrevRaw) and one ~7 KB
// memcpy per frame, which is what makes "this can move single solves earlier
// but cannot raise the sustained rate" an actual guarantee rather than a hope.
//
// Threshold in mean per-channel steps between consecutive frames. A hard cut
// moves the mean by dozens; the 21 is inherited from what the old post-alpha
// threshold of 20 amounted to at the then-current grid weight of 0.95, i.e. a
// mean raw movement of ~21, and it now means that directly.
const CUT_FRAME_JUMP = 21;
const SOLVE_CUT_INTERVAL_MS = 45;
// The veil is decoupled from the map entirely (computeVeil runs per feed
// message — it is a solid fill, the cheap part of the effect), so it smooths at
// the wire's cadence with its own asymmetric settling times (SETTLE_RANGES
// veilUp/veilDown). The CSS transition papers over the steps; this deadband
// keeps writes that nobody can see out of the style attribute.
const VEIL_WRITE_DEADBAND = 0.008;
// OKLab distance below which a new ink colour is not worth a repaint. Roughly
// the point where a side-by-side comparison stops showing a difference.
const REPAINT_DEADBAND = 0.01;
// Wider on the WebGL path, and for a different reason than "invisible". The
// terminal foreground is part of the glyph atlas's cache key
// (CharAtlasUtils.configEquals); moving it used to throw the atlas away and
// re-rasterise every glyph on screen — measured at ~450 ms of main thread per
// occurrence, at this deadband's cadence. webgl-ink now PINS the foreground
// xterm sees (pinTheme) so the atlas survives every setTheme, which turns one
// of these repaints into a cheap full model walk (~1-2 ms) plus, rarely, the
// adoption of a new flat ink (its own coarser deadband lives in webgl-ink).
// The deadband stays wider than the DOM path's anyway: it also buys far less —
// the text takes its colour from the ink texture, so the theme foreground only
// reaches glyphs standing on a filled cell (a tmux bar, a diff band), where a
// slower colour is not noticeable. The map itself keeps running at the feed's
// rate; this only paces the leftovers.
const REPAINT_DEADBAND_WEBGL = 0.04;
// Mean per-channel movement of the smoothed grid (window tiles only), below
// which a frame is not worth re-solving. Half a channel step: anything under
// it barely survives the contrast solve's rounding back to 8 bits, and on
// this GPU every skipped map raster is ~100 ms of budget returned (see the
// floor constants above).
const GRID_DEADBAND = 0.5;
// Grid-less frames tolerated before the per-glyph map is taken down. Grid-less
// frames are not transport hiccups — the service pairs average and grid before
// forwarding — so a run of them means the daemon genuinely stopped serving
// grids. Six of them is ~4 s on the 700 ms luna fallback and ~360 ms on the
// vtcapture wire; both are fine, because on the fast wire the fallback to flat
// text is that much fresher too.
const INK_MAP_MISSING_LIMIT = 6;
// How long a dead feed keeps its last colours on screen before the shell
// falls back to the flat theme. A daemon restart (deploys do this) is gone
// for two seconds and the service only retries its socket every ten; tearing
// the whole effect down in the meantime read as the shell flashing to a flat
// look and back for no visible reason. The picture behind a dead feed is by
// definition not being tracked anyway, so a frozen map is the better wrong.
const BACKDROP_LOST_GRACE_MS = 15000;
// Fallback matches body[data-theme="chameleon"]'s --panel-bg-rgb in styles.css.
const PANEL_RGB_FALLBACK = [10, 11, 13];

// The panel tint is a CSS token, per theme, so the stylesheet stays the single
// place it is defined — read it back rather than duplicating the value here.
function panelRgbFromTheme() {
  if (panelRgbCache) return panelRgbCache;
  try {
    const raw = getComputedStyle(document.body).getPropertyValue("--panel-bg-rgb");
    const parts = String(raw).split(",").map((p) => Number.parseFloat(p));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      panelRgbCache = parts;
      return parts;
    }
  } catch (e) {
    /* no computed style available */
  }
  panelRgbCache = PANEL_RGB_FALLBACK;
  return PANEL_RGB_FALLBACK;
}

// Paint the persisted theme during module evaluation — strictly before
// main.js's body runs and the first view mounts, so the login screen renders
// already themed (no default-look flash).
document.body.dataset.theme = themeById(currentThemeId).id;

export function currentTheme() {
  return themeById(currentThemeId);
}

export function currentThemeLabel() {
  return themeById(currentThemeId).label;
}

export function applyTheme(id, { persist = true } = {}) {
  const theme = themeById(id);
  currentThemeId = theme.id;
  document.body.dataset.theme = theme.id;
  // Everything derived is keyed on the theme — the panel colour, the base
  // shell, and now the hue profile too. The drift bump is what makes the switch
  // land immediately: without it the ink map keeps the previous theme's colours
  // until the picture happens to move, which on a still frame is forever.
  panelRgbCache = null;
  derivedCache = null;
  appliedInk = null;
  flatInkShown = null;
  gridDrift = Number.MAX_VALUE;
  if (persist) saveThemeId(theme.id);
  if (appState.session) {
    // Before setTheme, and it has to be its own call. On the WebGL renderer the
    // foreground xterm sees is pinned and the palette's real one travels as flat
    // ink, which pinTheme only adopts past a deadband — and the whole registry
    // fits inside that deadband, so a theme switch alone could never move it.
    // This is the one caller allowed to bypass it: a button press is not drift.
    if (typeof appState.session.adoptThemeInk === "function") {
      appState.session.adoptThemeInk(theme.shell);
    }
    if (typeof appState.session.setTheme === "function") {
      appState.session.setTheme(theme.shell);
    }
  }
  themeButtons.forEach((btn) => {
    if (!btn.isConnected) {
      themeButtons.delete(btn);
      return;
    }
    updateThemeButton(btn);
  });
  // Ink first, renderer second, and the order is load-bearing on the way OUT of
  // Chameleon: updateBackdropWatch is what tears the map down and drops the
  // attribute that turns the glyphs into a mask. Handing rendering back to the
  // DOM before that would leave a renderer painting `color: transparent` with
  // no image left to clip it to — a window of invisible text.
  updateBackdropWatch();
  syncGlyphRenderer();
}

export function cycleTheme() {
  applyTheme(nextThemeId(currentThemeId));
  debugEvent("ui_theme_cycle", { theme: currentThemeId });
  return currentThemeId;
}

export function chameleonFlashPercent() {
  return Math.round(flashLevel * 100);
}

export function reactiveEnabled() {
  return reactiveOn;
}

// What the active theme calls its variant of the effect ("bloom", "neon", …),
// for the toggle's label — the user is switching one named thing off, not a
// generic feature.
export function reactiveLabel() {
  const profile = themeById(currentThemeId).reactive;
  return (profile && profile.label) || "reactive";
}

// The on/off switch beside the flash slider. Order matters on the way OUT, for
// the same reason applyTheme documents: updateBackdropWatch tears the ink map
// down and drops the attribute that turns the glyphs into a mask, and handing
// rendering back to the DOM before that would leave a renderer painting
// `color: transparent` with nothing left to clip it to.
export function setReactiveEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === reactiveOn) return reactiveOn;
  reactiveOn = next;
  saveReactiveEnabled(next);
  derivedCache = null;
  gridDrift = Number.MAX_VALUE;
  debugEvent("ui_reactive_set", { enabled: next, theme: currentThemeId });
  updateBackdropWatch();
  syncGlyphRenderer();
  return reactiveOn;
}

// Live handler for the flash slider (long-press on the theme button). The
// caches all bake the old level in, so they are dropped; the drift bump makes
// the very next frame re-solve the map instead of waiting for the picture to
// move, which is what makes dragging the slider feel like it does something.
export function setChameleonFlash(percent) {
  const clamped = clampFlashPercent(percent);
  const level = clamped / 100;
  if (level === flashLevel) return clamped;
  flashLevel = level;
  saveFlashPercent(clamped);
  derivedCache = null;
  flatInkShown = null;
  appliedInk = null;
  gridDrift = Number.MAX_VALUE;
  debugEvent("ui_flash_set", { percent: clamped });
  return clamped;
}

export function backdropSmoothingPercent() {
  return Math.round(smoothLevel * 100);
}

// Live handler for the smoothing slider. Nothing derived is cached on the
// level — unlike the flash knob, which bakes into the colour derivation — so
// there is nothing to invalidate: the new value simply weights the next step.
// That also means dragging it is felt within one feed message rather than one
// solve, which is what makes it tunable from the couch.
export function setBackdropSmoothing(percent) {
  const clamped = clampSmoothingPercent(percent);
  const level = clamped / 100;
  if (level === smoothLevel) return clamped;
  smoothLevel = level;
  saveSmoothingPercent(clamped);
  debugEvent("ui_smoothing_set", { percent: clamped });
  return clamped;
}

function updateThemeButton(btn) {
  const theme = themeById(currentThemeId);
  const upcoming = themeById(nextThemeId(currentThemeId));
  btn.title = `Theme: ${theme.label} — switch to ${upcoming.label}`;
  btn.setAttribute("aria-label", btn.title);
  // Only the toolbar copy of this button has the long-press popover behind it
  // (the connect form has no backdrop effect to tune), and a tooltip promising
  // a gesture that does nothing is worse than a shorter tooltip. The owner of
  // the gesture marks its own button — see terminal-window.js.
  if (btn.dataset.longpress === "1") {
    btn.title += " · hold for the backdrop effect";
  }
  const name = btn.querySelector(".theme-name");
  if (name) name.textContent = theme.label;
}

export function registerThemeButton(btn) {
  themeButtons.add(btn);
  updateThemeButton(btn);
}

// Sessions must unregister their toolbar button on teardown: the registry is
// module-level and only prunes itself when the user cycles the theme. Without
// this, every closed session's button stays reachable — and with it, through
// the click listener's closure, its whole xterm instance and scrollback.
export function unregisterThemeButton(btn) {
  themeButtons.delete(btn);
}

// One backdrop frame's worth of grid work: smooth it, solve a colour for every
// tile, crop the result to the glyph rows and hand it to CSS. Returns true if a
// map was applied, so the caller can tell the two paths apart in the log.
function applyInkMap(session, grid, flatInk, sceneIsRaw, dtMs) {
  const src = sceneIsRaw ? "video" : "display";
  if (grid.w !== gridW || grid.h !== gridH || src !== gridSrc) {
    // Dimensions can only change if the daemon was restarted with a different
    // request, and the source flips when it moves between its capture paths;
    // the smoothing history and the per-tile sides are meaningless across
    // either, and keeping them would mix two different pictures.
    gridW = grid.w;
    gridH = grid.h;
    gridSrc = src;
    gridSmoothed = null;
    gridPrevRaw = null;
    // The veil belongs in this list too, and that only became visible once it
    // started solving from the RAW grid: a source flip does not just change the
    // picture, it changes the MEASUREMENT. computeVeil un-composites the panel
    // out of a "display" sample and deliberately does not for a "video" one, so
    // the two are on different scales by construction — precisely the "no
    // history to ease from" case veilSeeded exists for. backdropd flips between
    // its vtcapture and luna paths on its own, with no teardown and no
    // `available:false`, so nothing else here would have caught it.
    veilSeeded = false;
    inkSides = null;
    inkAnchor = null;
    inkOrigin = null;
    driftMask = null;
    driftMaskCount = 0;
    driftMaskKey = "";
  }
  let moved = 0;
  let rawJump = 0;
  // The cut detector needs the PREVIOUS FRAME, not the smoothed state. Measured
  // against gridSmoothed it was the gap still open between the picture and our
  // own filter, which under sustained motion settles at roughly delta/alpha and
  // therefore STAYS above any fixed threshold: an ordinary pan (~8 channel steps
  // per frame) leaves a permanent 42-step lag at the default knob, so the "cut"
  // floor became the steady-state floor and doubled the solve rate on exactly
  // the contended path SOLVE_MAX_INTERVAL_MS exists to ration. A frame-to-frame
  // difference cannot do that: a pan produces the same small number every frame
  // whatever the smoothing is set to, and only a real cut spikes it.
  const havePrev = gridPrevRaw && gridPrevRaw.length === grid.data.length;
  if (!havePrev) gridPrevRaw = new Uint8Array(grid.data.length);
  if (!gridSmoothed || gridSmoothed.length !== grid.data.length) {
    gridSmoothed = Float32Array.from(grid.data);
    moved = Infinity;
    rawJump = Infinity;
  } else {
    // One weight table per frame, indexed per tile by how far that tile still
    // has to travel: a tile the picture barely moved settles at the base time,
    // a tile that cut outright gets the stretched one. Per tile and not per
    // frame, so a caption appearing in one corner does not put the whole map
    // into slow motion (see buildAlphaLut).
    const lut = buildAlphaLut(
      dtMs,
      settleFor("grid", sceneIsRaw, smoothLevel),
      JUMP_PROFILES.grid,
    );
    const tiles = gridSmoothed.length / 3;
    for (let t = 0, i = 0; t < tiles; t++, i += 3) {
      const d0 = grid.data[i] - gridSmoothed[i];
      const d1 = grid.data[i + 1] - gridSmoothed[i + 1];
      const d2 = grid.data[i + 2] - gridSmoothed[i + 2];
      // The tile's jump is its worst channel: a hue swing at constant
      // brightness is every bit as much a cut as a fade to black, and taking
      // the channels separately would let a tile change hue mid-transition.
      const a0 = d0 < 0 ? -d0 : d0;
      const a1 = d1 < 0 ? -d1 : d1;
      const a2 = d2 < 0 ? -d2 : d2;
      const a = alphaForJump(lut, a0 > a1 ? (a0 > a2 ? a0 : a2) : a1 > a2 ? a1 : a2);
      gridSmoothed[i] += d0 * a;
      gridSmoothed[i + 1] += d1 * a;
      gridSmoothed[i + 2] += d2 * a;
      // The smoothing covers the whole grid (the window can move); the drift
      // only counts what the window can see (see driftMask).
      if (!driftMask || driftMask[t]) {
        moved += (a0 + a1 + a2) * a;
        if (havePrev) {
          const p0 = grid.data[i] - gridPrevRaw[i];
          const p1 = grid.data[i + 1] - gridPrevRaw[i + 1];
          const p2 = grid.data[i + 2] - gridPrevRaw[i + 2];
          rawJump +=
            (p0 < 0 ? -p0 : p0) + (p1 < 0 ? -p1 : p1) + (p2 < 0 ? -p2 : p2);
        }
      }
    }
    const norm = driftMask && driftMaskCount ? driftMaskCount * 3 : gridSmoothed.length;
    moved /= norm;
    // No previous frame means no frame-to-frame answer; leave it at 0 rather
    // than reporting the first frame after a reset as a cut, which would put
    // every resume on the cut floor for no reason.
    rawJump = havePrev ? rawJump / norm : 0;
  }
  // One memcpy of ~7 KB per frame, which is what buys the guarantee above.
  gridPrevRaw.set(grid.data);
  // A picture that has not moved produces the same ink; solving it again and
  // handing the compositor an identical image is pure cost on a device where
  // this path was measured at tens of milliseconds. A paused stream, a menu, a
  // static desktop — all of them settle here and stop paying. Judged on the
  // movement since the last solve (see gridDrift), so ten slow frames buy the
  // same repaint one fast frame does. The interval floor is the other gate:
  // the wire is deliberately faster than the repaint budget.
  gridDrift += moved;
  if (rawJump > gridCutJump) gridCutJump = rawJump;
  if (inkMapApplied) {
    if (gridDrift < GRID_DEADBAND) return true;
    // The floor is a timer, not a frame-edge check. Checking it only when a
    // frame arrived meant a frame landing inside the floor waited for the NEXT
    // frame: with a 60 ms wire and an 80 ms floor that quantised the effect to
    // a 120 ms cadence — every value of the floor in (60, 120] bought the same
    // 8 fps. Arming a timer for the moment the floor opens makes the floor the
    // actual cadence, and cuts latency too: the solve runs mid-interval
    // instead of waiting out the rest of the wire tick. Frames arriving while
    // armed refresh the context, so the deferred solve uses the newest
    // smoothed grid.
    const now = nowMs();
    // Never solve meaningfully faster than the page is being presented.
    const presented = Math.max(frameMsEma, 17);
    const minInterval =
      typeof session.inkMode === "function" && session.inkMode() === "webgl"
        ? SOLVE_MIN_INTERVAL_WEBGL_MS
        : SOLVE_MIN_INTERVAL_MS;
    const floor =
      gridCutJump >= CUT_FRAME_JUMP
        ? Math.max(SOLVE_CUT_INTERVAL_MS, Math.min(SOLVE_CUT_MAX_MS, presented * 1.5))
        : Math.max(
            minInterval,
            Math.min(SOLVE_MAX_INTERVAL_MS, presented * SOLVE_FLOOR_PER_FRAME),
          );
    let wait = floor - (now - inkLastSolveTs);
    // Typing outranks the effect: a map raster started right before a
    // keystroke's frame turns the echo into a 100+ ms hitch (see the A/B
    // above). Input pushes the next solve out by a beat.
    if (solveHoldUntil > now) wait = Math.max(wait, solveHoldUntil - now);
    if (wait > 0) {
      pendingSolve = { session, flatInk, sceneIsRaw };
      const due = now + wait;
      // A cut arriving while a normal-floor timer is pending re-arms it
      // earlier; the reverse (lengthening) never happens.
      if (solveTimer && due < solveTimerDue) {
        clearTimeout(solveTimer);
        solveTimer = null;
      }
      if (!solveTimer) {
        solveTimer = setTimeout(firePendingSolve, wait);
        solveTimerDue = due;
      }
      return true;
    }
  }
  if (solveTimer) {
    clearTimeout(solveTimer);
    solveTimer = null;
  }
  pendingSolve = null;
  return solveInkMap(session, flatInk, sceneIsRaw);
}

// The deferred half of applyInkMap's interval floor. backdropRestoreStatic
// clears the timer on every teardown path, but a session can also close
// between arming and firing — so everything used here is re-checked.
function firePendingSolve() {
  solveTimer = null;
  const p = pendingSolve;
  pendingSolve = null;
  if (!p || !backdropSub || !gridSmoothed) return;
  const session = p.session;
  if (
    !session ||
    session.closed ||
    appState.session !== session ||
    typeof session.setInkMap !== "function"
  ) {
    return;
  }
  // A keystroke may have landed while this timer waited; its hold wins.
  const now = nowMs();
  if (solveHoldUntil > now) {
    pendingSolve = p;
    solveTimer = setTimeout(firePendingSolve, solveHoldUntil - now);
    solveTimerDue = solveHoldUntil;
    return;
  }
  solveInkMap(session, p.flatInk, p.sceneIsRaw);
}

// Rebuilds the drift mask when the window's tile footprint changes. Same
// rounding as the solve domain in buildInkField, so the two agree about which
// tiles matter.
function updateDriftMask(rect) {
  if (!rect || !gridW || !gridH) {
    driftMask = null;
    driftMaskCount = 0;
    driftMaskKey = "";
    return;
  }
  const x0 = Math.max(0, Math.floor(rect.x0) - 2);
  const y0 = Math.max(0, Math.floor(rect.y0) - 2);
  const x1 = Math.min(gridW, Math.ceil(rect.x1) + 2);
  const y1 = Math.min(gridH, Math.ceil(rect.y1) + 2);
  const key = `${gridW}x${gridH}:${x0},${y0},${x1},${y1}`;
  if (key === driftMaskKey && driftMask) return;
  driftMaskKey = key;
  driftMask = new Uint8Array(gridW * gridH);
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      driftMask[y * gridW + x] = 1;
      count++;
    }
  }
  driftMaskCount = count;
}

// One actual solve — field, map image, veil, DOM handoff. The gates live in
// applyInkMap (and firePendingSolve re-validates the deferred context).
function solveInkMap(session, flatInk, sceneIsRaw) {
  gridDrift = 0;
  gridCutJump = 0;
  inkLastSolveTs = nowMs();

  const geometry =
    typeof session.backdropGeometry === "function" ? session.backdropGeometry() : null;
  if (!geometry) return false;
  const { rows, panel, viewportW, viewportH } = geometry;

  const started = nowMs();
  const panelRect = gridRectFor(panel, viewportW, viewportH, gridW, gridH);
  updateDriftMask(panelRect);
  lastPanelRect = panelRect;
  const field = buildInkField(
    { w: gridW, h: gridH, data: gridSmoothed },
    {
      panelRgb: panelRgbFromTheme(),
      panelAlpha:
        typeof session.panelAlpha === "function" ? session.panelAlpha() : undefined,
      prevSides: inkSides,
      prevAnchor: inkAnchor,
      prevOrigin: inkOrigin,
      panelGridRect: panelRect,
      sceneIsRaw,
      flash: flashLevel,
      reactive: themeById(currentThemeId).reactive,
    },
  );
  if (!field) return false;
  inkSides = field.sides;
  inkAnchor = field.anchor;
  inkOrigin = field.origin;
  const solved = nowMs();

  // The rows crop is computed on the FULL fine grid and translated into the
  // field's domain — the field only covers the window's neighbourhood now.
  const ups = field.upsample || 1;
  const full = gridRectFor(rows, viewportW, viewportH, gridW * ups, gridH * ups);
  const crop = full
    ? {
        x0: full.x0 - field.origin.x * ups,
        y0: full.y0 - field.origin.y * ups,
        x1: full.x1 - field.origin.x * ups,
        y1: full.y1 - field.origin.y * ups,
      }
    : null;
  // Two containers for the same solved colours, chosen by whichever renderer
  // is carrying the glyphs.
  //
  // On the WebGL path the field goes over as raw bytes and the shader looks the
  // colour up per fragment, so this step is a few kilobytes and a texture
  // upload. On the CSS path it has to become a picture the compositor clips to
  // the text — one image for the whole rows box, because a per-row-strip
  // variant with change detection was built and measured on the device
  // (2026-07-31): video moves the field globally, every strip changed on every
  // solve, and the 40 separate images/invalidations made presentation ~30x
  // worse. The veil is NOT handled here on either path; it follows the feed
  // directly (see handleBackdropMessage).
  const webgl = typeof session.inkMode === "function" && session.inkMode() === "webgl";
  const ink = webgl ? renderInkTexture(field, crop) : renderInkMap(field, crop);
  if (!ink) return false;
  const encoded = nowMs();
  // Perceptual deadband on the flat ink: --chameleon-flat-ink is an inherited
  // custom property, so every write invalidates the computed style of every
  // span in the terminal, and the derivation drifts by a hair each frame while
  // the average settles. Below the repaint deadband the difference is
  // invisible; hand the DOM the previous colour and skip the invalidation.
  if (!flatInkShown || oklabDistance(flatInkShown, flatInk) >= REPAINT_DEADBAND) {
    flatInkShown = flatInk;
  }
  session.setInkMap(
    webgl ? { texture: ink, flatInk: flatInkShown } : { url: ink, flatInk: flatInkShown },
  );
  // Damage is pending now — sample how fast it actually reaches the glass.
  startPresentProbe();

  // Every twentieth frame, split by stage: the cost of this path is the one
  // thing about it that cannot be checked anywhere but on the TV, and the
  // first measurement there (28-248 ms) is what set the field resolution and
  // the deadband above.
  if (inkFrames++ % 20 === 0) {
    debugEvent("ui_backdrop_field", {
      mode: webgl ? "webgl" : "image",
      grid: `${gridW}x${gridH}`,
      field: `${field.w}x${field.h}`,
      darkPct: Math.round(field.darkRatio * 100),
      contrast: Math.round(field.meanContrast * 10) / 10,
      msSolve: solved - started,
      msEncode: encoded - solved,
      msApply: nowMs() - encoded,
    });
  }
  return true;
}

function backdropRestoreStatic() {
  stopPresentProbe();
  if (backdropLostTimer) {
    clearTimeout(backdropLostTimer);
    backdropLostTimer = null;
  }
  if (solveTimer) {
    clearTimeout(solveTimer);
    solveTimer = null;
  }
  solveTimerDue = 0;
  pendingSolve = null;
  flatInkShown = null;
  derivedCache = null;
  backdropSmoothed = null;
  // With no history left to smooth against, an elapsed time measured from
  // before the teardown would be meaningless; the next sample starts fresh.
  lastSampleTs = 0;
  gridSmoothed = null;
  gridPrevRaw = null;
  gridW = 0;
  gridH = 0;
  gridSrc = "display";
  lastGridSrc = null;
  gridDrift = 0;
  gridCutJump = 0;
  inkLastSolveTs = 0;
  veilSmoothed = 0;
  veilApplied = 0;
  veilSeeded = false;
  inkSides = null;
  inkAnchor = null;
  inkOrigin = null;
  driftMask = null;
  driftMaskCount = 0;
  driftMaskKey = "";
  inkMapApplied = false;
  inkMapMissing = 0;
  if (appState.session && typeof appState.session.setInkMap === "function") {
    appState.session.setInkMap(null);
  }
  if (appState.session && typeof appState.session.setVeil === "function") {
    appState.session.setVeil(null);
  }
  lastPanelRect = null;
  releaseInkMap();
  // Both are baselines for the *next* live sample. Leaving them behind would
  // have the deadband compare against a colour that is no longer on screen, so
  // the first sample after a restart could be swallowed.
  appliedInk = null;
  adaptiveSide = "light";
  if (backdropLive) {
    backdropLive = false;
    debugEvent("ui_backdrop_static", {});
  }
  const theme = themeById(currentThemeId);
  if (appState.session && typeof appState.session.setTheme === "function") {
    appState.session.setTheme(theme.shell);
    if (typeof appState.session.setAccent === "function") appState.session.setAccent(null);
  }
}

function handleBackdropMessage(resp) {
  if (!backdropSub || !resp) return;
  if (resp.available === false) {
    // Not immediately: freeze the current colours and give the feed a grace
    // window to come back (see BACKDROP_LOST_GRACE_MS).
    if (!backdropLostTimer) {
      backdropLostTimer = setTimeout(() => {
        backdropLostTimer = null;
        backdropRestoreStatic();
      }, BACKDROP_LOST_GRACE_MS);
    }
    return;
  }
  if (typeof resp.r !== "number") return; // subscription ack
  if (backdropLostTimer) {
    clearTimeout(backdropLostTimer);
    backdropLostTimer = null;
  }
  // The source rides on the grid, but it describes the average of the same
  // frame just as much: both lines are reduced from one capture. A message
  // without a grid therefore does not mean "display" — it means this read
  // carried no grid line, which is ordinary traffic on either path. Latch the
  // last source we actually saw and answer from that; only before the very
  // first grid is the answer unknown, and there the composited path is the safe
  // assumption (it is what the daemon falls back to, and un-compositing a panel
  // that IS in the sample is the milder error of the two).
  if (resp.grid && resp.grid.src) lastGridSrc = resp.grid.src === "video" ? "video" : "display";
  const sceneIsRaw = lastGridSrc === "video";
  // Every surface below smooths against the same elapsed time, from the same
  // clock read: they are three views of one picture and must not drift apart.
  // A gap longer than the cap is a suspended app or a restarted daemon, not a
  // slow frame — the weight saturates at 1 there anyway, and capping keeps the
  // arithmetic honest if the clock jumps.
  const sampleTs = nowMs();
  const dtMs = lastSampleTs ? Math.min(sampleTs - lastSampleTs, 2000) : 0;
  lastSampleTs = sampleTs;
  if (backdropSmoothed) {
    const dr = resp.r - backdropSmoothed.r;
    const dg = resp.g - backdropSmoothed.g;
    const db = resp.b - backdropSmoothed.b;
    // The whole-frame average is one colour under the entire shell, so its
    // jump is judged on the worst channel and the stretch runs longest here:
    // this is the surface a scene cut used to flash.
    const jump = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    const avgSmoothing = smoothingAlpha(
      dtMs,
      stretchedSettle(settleFor("flat", sceneIsRaw, smoothLevel), jump, JUMP_PROFILES.flat),
    );
    backdropSmoothed = {
      r: backdropSmoothed.r + dr * avgSmoothing,
      g: backdropSmoothed.g + dg * avgSmoothing,
      b: backdropSmoothed.b + db * avgSmoothing,
    };
  } else {
    backdropSmoothed = { r: resp.r, g: resp.g, b: resp.b };
  }
  const theme = themeById(currentThemeId);
  // Belt to updateBackdropWatch's braces: it unsubscribes when the effect goes
  // off, but a message already in flight would otherwise still paint.
  if (!reactiveOn) return;
  const session = appState.session;
  if (!session || session.closed || typeof session.setTheme !== "function") return;
  // Re-derive the flat shell only once the smoothed average has moved far
  // enough from the anchor of the last derivation to possibly change the
  // outcome. The derivation bisects ink lightness with a gamut search per
  // step; paying that on every frame for an input that moved by a fraction of
  // a channel step was measurable, constant load. The anchor comparison (not
  // frame-to-frame movement) keeps a slow fade accumulating towards the
  // epsilon instead of hiding under it.
  const panelRgb = panelRgbFromTheme();
  const panelAlpha =
    typeof session.panelAlpha === "function" ? session.panelAlpha() : undefined;
  let derived;
  if (
    derivedCache &&
    derivedCache.sceneIsRaw === sceneIsRaw &&
    derivedCache.panelAlpha === panelAlpha &&
    derivedCache.panelRgb === panelRgb &&
    Math.abs(backdropSmoothed.r - derivedCache.avg.r) < DERIVE_EPSILON &&
    Math.abs(backdropSmoothed.g - derivedCache.avg.g) < DERIVE_EPSILON &&
    Math.abs(backdropSmoothed.b - derivedCache.avg.b) < DERIVE_EPSILON
  ) {
    derived = derivedCache.derived;
  } else {
    derived = adaptiveShellFor(theme.shell, backdropSmoothed, {
      panelRgb,
      panelAlpha,
      prevSide: adaptiveSide,
      sceneIsRaw,
      flash: flashLevel,
      reactive: theme.reactive,
    });
    derivedCache = {
      derived,
      avg: { r: backdropSmoothed.r, g: backdropSmoothed.g, b: backdropSmoothed.b },
      panelAlpha,
      panelRgb,
      sceneIsRaw,
    };
  }
  adaptiveSide = derived.side;

  // The map first, and outside the deadband below: it is where the text colour
  // actually comes from once the grid is available, it costs no re-render, and
  // gating it on the *average* having moved would freeze the per-glyph effect
  // through exactly the shots that keep a steady average while the picture
  // moves under the window.
  let mapped = false;
  // Hoisted for the veil block below, which wants the picture as it IS rather
  // than as the map is easing towards it. ⚠️ decodeGrid hands back a reused
  // scratch buffer that is only valid until the next decode — safe here because
  // both consumers run synchronously in this same message, and it must stay
  // that way: nothing may retain `decoded` past the end of this function.
  let decoded = null;
  if (resp.grid && typeof session.setInkMap === "function") {
    decoded = decodeGrid(resp.grid.data, resp.grid.w, resp.grid.h);
    if (decoded) {
      mapped = applyInkMap(session, decoded, derived.shell.foreground, sceneIsRaw, dtMs);
    }
  }
  // A frame with no usable grid must NOT take the map down on its own. Doing
  // that was visible as the whole shell flashing to a single colour for the
  // best part of a second: the average and the grid are separate lines on the
  // feed and do not always arrive in the same read, so a grid-less frame is
  // normal traffic, not a fault. (The service now pairs them, which is the
  // real fix; this is the belt to that pair of braces.) Only a run of them
  // means the grid has genuinely stopped, and a map a few seconds stale is
  // still far better than a flash of flat text.
  if (mapped) {
    inkMapMissing = 0;
  } else if (inkMapApplied && ++inkMapMissing >= INK_MAP_MISSING_LIMIT) {
    session.setInkMap(null);
    if (typeof session.setVeil === "function") session.setVeil(null);
    inkMapApplied = false;
    inkMapMissing = 0;
    // The scrim came down with it, so what veilSmoothed remembers is a picture
    // that is no longer on screen — and grids can come back many seconds later
    // over a completely different shot. Resuming the ease from that value steps
    // the panel to a darkness the picture does not explain; re-seed instead.
    veilSeeded = false;
  }
  if (mapped) inkMapApplied = true;

  // The veil follows the FEED, not the solve: it is a solid fill — the one
  // part of the effect this GPU paints for free — so a brightness change
  // answers in ~80 ms while the glyph map takes its budgeted time. Uses the
  // window rect from the last solve; until one ran there is nothing to veil.
  if (
    inkMapApplied &&
    lastPanelRect &&
    (decoded || gridSmoothed) &&
    typeof session.setVeil === "function"
  ) {
    // Solved from the RAW grid, not the smoothed one. The scrim is the only
    // part of this engine whose job is readability rather than looks, and
    // feeding it gridSmoothed put 0.5.32's deliberate slowness in front of it
    // twice over: the grid eases towards the new picture, and then the veil
    // eases towards that. It was invisible while the grid ran at 0.95 per
    // sample and the veil snapped past a 0.12 gap — this commit removed both,
    // and a night-to-snow cut then left the text at 1.5-2.6:1 for ~120 ms on a
    // glass panel. The veil leading the ink is the safe direction: it only ever
    // makes the background darker than the ink was solved against.
    //
    // Falls back to the smoothed grid on a grid-less message, which is normal
    // traffic (see the hoist above); its dimensions are the ones gridW/gridH
    // describe, the decoded grid's are its own.
    const veilSample = decoded || { w: gridW, h: gridH, data: gridSmoothed };
    const rawVeil = computeVeil(veilSample, {
      panelRgb: panelRgbFromTheme(),
      panelAlpha,
      panelGridRect: lastPanelRect,
      sceneIsRaw,
    });
    if (!veilSeeded) {
      // No history to ease from — the same rule the grid follows, where the
      // first sample after a teardown seeds gridSmoothed outright. Easing from
      // zero here while the ink snaps to a fully veiled background is what made
      // the terminal come back washed out after every Hide/Show and every
      // screensaver, with no scene change to explain it.
      veilSmoothed = rawVeil;
      veilApplied = rawVeil;
      veilSeeded = true;
    } else {
      const veilGap = rawVeil - veilSmoothed;
      // The one asymmetry in the whole engine. More veil means the picture got
      // brighter and the text is about to be hard to read — readability is not a
      // matter of taste, so that direction stays quick (it used to snap outright).
      // Less veil only gives transparency back, and easing that is free.
      const veilBase = settleFor(veilGap > 0 ? "veilUp" : "veilDown", sceneIsRaw, smoothLevel);
      veilSmoothed +=
        veilGap *
        smoothingAlpha(
          dtMs,
          veilGap > 0 ? veilBase : stretchedSettle(veilBase, veilGap, JUMP_PROFILES.veil),
        );
      if (Math.abs(veilSmoothed - veilApplied) >= VEIL_WRITE_DEADBAND) {
        veilApplied = veilSmoothed;
      }
    }
    const p = panelRgbFromTheme();
    session.setVeil(
      veilApplied > 0.004
        ? `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${veilApplied.toFixed(3)})`
        : null,
    );
  }

  // Repainting for a change nobody can see is pure cost — every setTheme walks
  // xterm's whole grid — and at this cadence it also reads as a shimmer on the
  // text. Only paint once the colour has actually moved. (The atlas is safe
  // either way now: on the WebGL renderer the foreground is pinned, see
  // REPAINT_DEADBAND_WEBGL above.)
  const themeDeadband =
    typeof session.inkMode === "function" && session.inkMode() === "webgl"
      ? REPAINT_DEADBAND_WEBGL
      : REPAINT_DEADBAND;
  if (appliedInk && oklabDistance(appliedInk, derived.shell.foreground) < themeDeadband) {
    return;
  }
  appliedInk = derived.shell.foreground;
  session.setTheme(derived.shell);
  if (typeof session.setAccent === "function") session.setAccent(derived.accent);
  if (!backdropLive) {
    backdropLive = true;
    debugEvent("ui_backdrop_live", {
      theme: currentThemeId,
      variant: (theme.reactive && theme.reactive.label) || "reactive",
      ink: derived.shell.foreground,
      spark: derived.accent,
      side: derived.side,
      contrast: Math.round(derived.contrast * 10) / 10,
      perGlyph: mapped,
    });
  }
}

// Per-glyph ink is cheap on a GPU and ruinous in CSS (one background-image
// change re-rasterises every glyph mask on the layer — 100+ ms on this TV), so
// the effect asks for the WebGL renderer whenever it is switched on, and the
// DOM renderer is what the shell falls back to with it off. The terminal
// answers with what it actually got: WebGL2 may be unavailable or refused, in
// which case the CSS path still works and this is invisible.
//
// Keyed on the toggle, NOT on the theme: every theme reacts now, so a theme
// cycle no longer swaps renderers — which also means it no longer throws away a
// GL context and a glyph atlas on every press of the theme button.
//
// Deliberately NOT tied to visibility: a hidden app unsubscribes from the feed,
// and rebuilding a GL context and a glyph atlas every time the user tabs away
// would cost far more than the idle renderer does.
let lastGlyphRenderer = null;

function syncGlyphRenderer() {
  const session = appState.session;
  if (!session || session.closed || typeof session.setGlyphRenderer !== "function") return;
  const mode = reactiveOn ? "webgl" : "dom";
  const got = session.setGlyphRenderer(mode);
  if (got !== lastGlyphRenderer) {
    lastGlyphRenderer = got;
    debugEvent("ui_glyph_renderer", { want: mode, got });
  }
}

export function updateBackdropWatch() {
  const want = Boolean(
    reactiveOn &&
      appState.session &&
      !appState.session.closed &&
      typeof appState.session.setTheme === "function" &&
      appState.overlayVisible &&
      !document.hidden &&
      appState.activeView === "session",
  );
  if (want && !backdropSub) {
    // Before the first sample arrives, so the first solve already has somewhere
    // to put its texture. This is also the hook that catches a session mounting
    // with the effect already on, where applyTheme never runs.
    syncGlyphRenderer();
    debugEvent("ui_backdrop_subscribe", {});
    backdropSub = subscribeBackdrop(handleBackdropMessage, (err) => {
      debugEvent("ui_backdrop_error", { error: compactError(err) });
      backdropRestoreStatic();
    });
  } else if (!want && backdropSub) {
    debugEvent("ui_backdrop_unsubscribe", {});
    const sub = backdropSub;
    backdropSub = null;
    try {
      if (sub && typeof sub.cancel === "function") sub.cancel();
    } catch (e) {
      /* bridge already gone */
    }
    backdropRestoreStatic();
  }
}
