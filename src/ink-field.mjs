// The per-glyph half of the reactive backdrop effect: turns one backdrop *grid*
// into a field of ink colours, one per tile, each solved against the picture
// behind that tile rather than against the screen average. Every theme runs it;
// the theme's profile (options.reactive) only decides which hue the tint is
// spent on — the contrast solve below is the same for all of them.
//
// Why the average was never going to be enough: a shot that is dark on the
// left and bright on the right has an average that is wrong for both halves.
// The single-colour version put pale grey text across the whole shell, which
// read well over the dark side and vanished over the bright side — with no
// setting of any constant that could have fixed it, because the input had
// already thrown the information away. backdropd now serves the screen as a
// tile grid (see tv-root/backdropd.c) and this module solves each tile.
//
// The result is consumed as an image: ink-map.mjs encodes this field and hands
// it to CSS as a background clipped to the text, so every glyph picks up the
// colour at its own position at zero per-glyph cost. That is also why the field
// is deliberately low resolution — it is stretched and smoothed by the
// compositor, not drawn pixel for pixel.
//
// DOM-free on purpose: tests/ink-field.test.mjs covers the maths, which is the
// only part of the effect that can be checked anywhere but on the TV.

import {
  INK_L_MAX,
  INK_L_MIN,
  INK_TARGET_CONTRAST,
  UNCOMPOSITE_ALPHA_MAX,
  channelFromLinear,
  flashParams,
  linearFromChannel,
  luminanceForContrast,
  neutralLightnessForLuminance,
  oklabFromLinearInto,
  oklabToRgbInto,
  reactiveGeometry,
  reactiveInkChroma,
  reactiveTintInto,
} from "./color.mjs";

// Which side a tile's ink belongs on is decided by asking which side actually
// delivers more contrast on that tile — not by comparing the background's
// lightness against a threshold.
//
// The threshold version shipped first and was measured wrong on the TV: over a
// white leaderboard showing through the panel, the background composited to a
// flat mid-grey (120,120,120), which sits just under the threshold, so the ink
// stayed light and delivered 3.6:1 where dark ink would have given 4.8:1. Any
// fixed lightness threshold has this failure somewhere, because it answers
// "does this background look light" when the question is "which colour can be
// read on it".
//
// This is NOT the comparison that was tried and rejected when the single flat
// colour was rewritten. That one compared against *unbounded* white, which on a
// sunset scores an ink that cannot exist (pure white, 4.57:1) fractionally
// above the dark answer (4.53:1) and so kept pale text on a bright picture.
// Comparing at the bounds the ink is actually held to gets the sunset right and
// the leaderboard right, because it is comparing two colours that will really
// be painted.
const Y_LIGHTEST_INK = INK_L_MAX * INK_L_MAX * INK_L_MAX;
const Y_DARKEST_INK = INK_L_MIN * INK_L_MIN * INK_L_MIN;
// Stability is not bought with a margin on that comparison, and the arithmetic
// is worth recording because the obvious fix does not work. backdropd captures
// the finished screen, our own glyphs included, so a tile's ink biases the
// sample it will be judged by next time: dark ink makes its tile read darker,
// which then argues for light ink. At ~10% glyph coverage the ink swings the
// tile average by about ±10/255 — and near the point where the two sides are
// evenly matched, that is worth as much as the entire decision signal. A margin
// wide enough to absorb it (~1.5×) would also refuse the real flips this change
// exists to make (the leaderboard above wants one at 1.35×), and smoothing the
// comparison over time only makes the oscillation slower, because the bias is a
// steady offset rather than noise.
//
// So the deadband sits on the *input* instead: a tile keeps its side until the
// background it was decided on has moved further than the ink could possibly
// have moved it. Below that, the tile is not reconsidered at all and the loop
// cannot close; above it, a real scene change decides freshly on the merits.
// The margin is in cube-root luminance, which is near enough perceptually
// uniform, and 0.08 there is about 20 levels of mid-grey — twice the worst
// case feedback. Worth knowing what it bounds in the other direction: across
// that same width the ratio between the two sides moves by at most about 2×,
// so a held decision can never be much worse than the alternative. (An escape
// hatch for "badly wrong holds" was written and then removed once that was
// worked out: there is no state it could fire in.)
export const SIDE_RECONSIDER = 0.08;
// Applied only when a tile *is* being reconsidered, so a background hovering
// exactly on the boundary does not dither between two equally good answers.
export const SIDE_HYSTERESIS = 1.1;
// Subdividing the grid before solving would halve the width of one artefact:
// where neighbouring tiles disagree about the side, the compositor's own
// interpolation passes through mid-grey, and mid-grey ink on the mid-grey
// background at that spot is the one combination with no contrast at all.
// It is off by default because it was measured on the TV and is not worth its
// price: at 2 the field is four times the tiles, and the whole path cost 28-248
// ms a frame, which the user felt as a laggy shell. The artefact it fixes is
// one tile wide (about three character cells) and only appears on a hard
// lighting edge; the lag was on every keystroke.
export const FIELD_UPSAMPLE = 1;

// --- the veil ---------------------------------------------------------------
//
// Over a mid-grey background NO ink colour reaches 5:1 — that is arithmetic,
// not a tuning failure, and it is the ceiling every version of this effect kept
// hitting wherever a bright picture showed through a transparent panel. The way
// past it is the one subtitles have used forever: stop trying to find a colour
// that survives the background, and darken the background instead.
//
// The first version darkened per tile — exactly as much as each spot needed —
// and that was measurably right and visually wrong: patches of darkness
// drifting with the picture read as clouding, the artefact TV owners buy OLEDs
// to escape, and every veil update invalidated a second full-screen image
// layer, which the renderer paid for in raster time at the feed's cadence.
//
// So the veil is now ONE alpha for the whole window, sized on the bright end
// of the tile distribution (p95 in cube-root luminance — the max would let a
// single specular highlight dim the whole shell) and drawn as a plain
// background-color the client can animate. Uniform means no spatial structure
// to see, nothing extra to rasterise, and the few tiles brighter than the
// p95 cap still get best-effort ink from the per-tile solve below.
export const SCRIM_TARGET_CONTRAST = 6;
// Never a solid wall: past this the window stops being a window, and the last
// stretch buys very little contrast anyway.
export const SCRIM_MAX_ALPHA = 0.8;
// Share of tiles allowed to stay above the cap (the veil is solved for the
// brightness at this quantile, not the absolute brightest tile).
export const SCRIM_QUANTILE = 0.95;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// Both intermediate passes get a buffer that outlives the call. They are
// strictly internal — filled at the top of every build, consumed before it
// returns — so reusing them costs nothing in clarity and saves the garbage
// collector ~45 KB per frame at the feed's cadence. The *result* is still a
// fresh array, because the caller keeps it (and the previous one) around.
let sceneScratch = null;
let tintScratch = null;
// Fine-grid working set for the two passes of the solve (see below): the
// composited background per tile, its luminance, and the interpolated tint.
let bgScratch = null;
let lumScratch = null;
let fineTintScratch = null;
// Luminance histogram for the veil quantile, in cube-root buckets so the
// bright end — the only part the veil cares about — is finely resolved.
const lumHistogram = new Int32Array(64);
// Per-tile working values, hoisted for the same reason (see color.mjs).
const labScratch = new Float64Array(3);
const sampleRgbScratch = new Float64Array(3);
const sampleTintScratch = new Float64Array(2);

function scratchScene(size) {
  if (!sceneScratch || sceneScratch.length !== size) sceneScratch = new Float32Array(size);
  return sceneScratch;
}

function scratchTint(size) {
  if (!tintScratch || tintScratch.length !== size) tintScratch = new Float32Array(size);
  return tintScratch;
}

function scratchFine(tiles) {
  if (!lumScratch || lumScratch.length !== tiles) {
    bgScratch = new Float32Array(tiles * 3);
    lumScratch = new Float32Array(tiles);
    fineTintScratch = new Float32Array(tiles * 2);
  }
}

// Bilinear read of a w×h RGB grid at a fractional tile position, clamped at the
// edges. Written out rather than delegated to a canvas so the field can be
// computed and tested without a DOM.
function sampleGrid(data, w, h, gx, gy, out) {
  const x = clamp(gx, 0, w - 1);
  const y = clamp(gy, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * w + x0) * 3;
  const i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3;
  const i11 = (y1 * w + x1) * 3;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[c] = top + (bottom - top) * fy;
  }
  return out;
}

// Same, for the two-component tint carried per coarse tile.
function sampleTint(tint, w, h, gx, gy, out) {
  const x = clamp(gx, 0, w - 1);
  const y = clamp(gy, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 2; c++) {
    const i00 = (y0 * w + x0) * 2 + c;
    const i10 = (y0 * w + x1) * 2 + c;
    const i01 = (y1 * w + x0) * 2 + c;
    const i11 = (y1 * w + x1) * 2 + c;
    const top = tint[i00] + (tint[i10] - tint[i00]) * fx;
    const bottom = tint[i01] + (tint[i11] - tint[i01]) * fx;
    out[c] = top + (bottom - top) * fy;
  }
  return out;
}

// The scene behind the panel, per tile. backdropd captures the finished screen,
// so inside the window every sample has our own panel tint composited into it;
// solving that composite for the bottom layer recovers the picture (the same
// reconstruction backdropBehindPanel does for the average, checked there
// against a paired VIDEO capture to within 3/255). Outside the window there is
// no tint to remove, and dividing it out anyway would hand the edge tiles a
// scene brighter than the one on screen — which is why the panel's own
// footprint is passed in rather than assumed to be everywhere.
function uncomposite(channel, panelChannel, alpha) {
  return clamp((channel - panelChannel * alpha) / (1 - alpha), 0, 255);
}

/**
 * @param sample  {w, h, data} — RGB bytes, row-major from the TOP-LEFT, as
 *                served by backdropd (already time-smoothed by the caller).
 * @param options panelRgb, panelAlpha, target, upsample, flash (the loudness
 *                knob, 0-1), reactive (the theme's hue profile),
 *                prevSides/prevAnchor
 *                (the previous frame's side decisions and the backgrounds they
 *                were made on),
 *                panelGridRect {x0,y0,x1,y1} in coarse-tile coordinates giving
 *                where the window sits on screen (omit if unknown: then the
 *                whole grid is treated as tinted, as it was before), and
 *                sceneIsRaw — set when the tiles are the naked video plane
 *                (backdropd's vtcapture path) rather than the composited
 *                screen: the sample IS the scene then, there is no panel in
 *                it to divide out, and none of our own glyphs either.
 * @returns {w, h, pixels: RGBA, sides, anchor, veil, origin, upsample,
 *          darkRatio, meanContrast} — w/h and all indices are in DOMAIN
 *          coordinates when panelGridRect cropped the solve; origin maps them
 *          back to the full grid. Callers passing prevSides/prevAnchor must
 *          pass prevOrigin (the previous result's origin) alongside.
 */
export function buildInkField(sample, options = {}) {
  const w = sample && sample.w;
  const h = sample && sample.h;
  const data = sample && sample.data;
  if (!w || !h || !data || data.length < w * h * 3) return null;

  const upsample = Math.max(1, Math.round(options.upsample || FIELD_UPSAMPLE));
  const panelRgb = options.panelRgb || [10, 11, 13];
  const rawAlpha = Number.isFinite(options.panelAlpha) ? options.panelAlpha : 0.86;
  const alpha = Math.min(Math.max(rawAlpha, 0), UNCOMPOSITE_ALPHA_MAX);
  const target = options.target || INK_TARGET_CONTRAST;
  // The veil's aim, as a contrast the lightest ink should reach. Zero turns it
  // off entirely, which is what the pre-scrim behaviour was — the light/dark
  // decision below only has anything to decide in that case, because any veil
  // strong enough to be worth drawing already caps the background well below
  // the point where dark ink could win.
  const scrimTarget = options.scrimTarget === undefined ? SCRIM_TARGET_CONTRAST : options.scrimTarget;
  const backgroundCap = scrimTarget > 0 ? (Y_LIGHTEST_INK + 0.05) / scrimTarget - 0.05 : Infinity;
  const rect = options.panelGridRect || null;
  const sceneIsRaw = Boolean(options.sceneIsRaw);
  // The user's loudness knob, scaling the tint envelope, and the active theme's
  // reactive profile, deciding the hue that envelope is spent on (color.mjs).
  const fp = flashParams(options.flash);
  const geo = reactiveGeometry(options.reactive);

  // --- solve domain ---------------------------------------------------------
  // The map is cropped to the glyph rows before it reaches CSS, so tiles far
  // outside the window are solved and thrown away — up to half the grid for a
  // windowed shell. When the window's position is known, the solve covers the
  // panel rect plus a 2-tile margin (one for the fractional crop edge, one for
  // the bilinear +1 neighbour), and everything downstream works in domain
  // coordinates; `origin` in the result maps them back. A welcome side effect:
  // the veil quantile is measured over the window's OWN backdrop, so a bright
  // patch far outside the window no longer dims it.
  let ox = 0;
  let oy = 0;
  let sw = w;
  let sh = h;
  if (rect) {
    ox = Math.min(Math.max(0, Math.floor(rect.x0) - 2), w - 1);
    oy = Math.min(Math.max(0, Math.floor(rect.y0) - 2), h - 1);
    sw = Math.max(1, Math.min(w, Math.ceil(rect.x1) + 2) - ox);
    sh = Math.max(1, Math.min(h, Math.ceil(rect.y1) + 2) - oy);
  }

  // --- pass 1: the scene, and the tint it earns, per coarse tile ------------
  // The tint is resolved here rather than on the fine grid because it is the
  // expensive half (a full OKLab conversion per tile) and the cheapest half to
  // interpolate: chroma this low reads as a cast over a region, never as an
  // edge, so nothing is lost by carrying it at the grid's own resolution.
  const scene = scratchScene(sw * sh * 3);
  const tint = scratchTint(sw * sh * 2);
  for (let y = 0; y < sh; y++) {
    const gy = oy + y;
    for (let x = 0; x < sw; x++) {
      const gx = ox + x;
      const i = y * sw + x;
      const src = (gy * w + gx) * 3;
      const inPanel =
        !rect || (gx + 0.5 >= rect.x0 && gx + 0.5 <= rect.x1 && gy + 0.5 >= rect.y0 && gy + 0.5 <= rect.y1);
      const a = sceneIsRaw ? 0 : inPanel ? alpha : 0;
      const r = uncomposite(data[src], panelRgb[0], a);
      const g = uncomposite(data[src + 1], panelRgb[1], a);
      const b = uncomposite(data[src + 2], panelRgb[2], a);
      scene[i * 3] = r;
      scene[i * 3 + 1] = g;
      scene[i * 3 + 2] = b;

      oklabFromLinearInto(
        linearFromChannel(r),
        linearFromChannel(g),
        linearFromChannel(b),
        labScratch,
      );
      const chroma = Math.sqrt(labScratch[1] * labScratch[1] + labScratch[2] * labScratch[2]);
      const intensity = chroma > 1e-4 ? Math.sqrt(Math.min(1, chroma / fp.chromaReference)) : 0;
      // Which hue this tile's ink takes is the theme's business (color.mjs);
      // how much of it the tile gets is the picture's. A hueless tile still
      // reaches here rather than short-circuiting to grey: under Chameleon it
      // comes out grey anyway (base 0), but a themed profile has a hue that
      // owes nothing to the sample and a floor that keeps it visible.
      const inkChroma = reactiveInkChroma(geo, fp.inkChromaMax, intensity);
      reactiveTintInto(
        geo,
        labScratch[1],
        labScratch[2],
        chroma,
        intensity,
        inkChroma,
        tint,
        i * 2,
      );
    }
  }

  // --- pass 2: the ink, per fine tile --------------------------------------
  const fw = sw * upsample;
  const fh = sh * upsample;
  const tiles = fw * fh;
  const pixels = new Uint8ClampedArray(tiles * 4);
  // Previous side decisions only carry over if they describe the SAME domain:
  // a moved or resized window shifts tile indices, and holding a side against
  // a different tile's anchor would be nonsense. (prevOrigin is optional for
  // callers that never crop — a full-grid solve has origin 0/0.)
  const prevOrigin = options.prevOrigin || null;
  const originMatches = prevOrigin ? prevOrigin.x === ox && prevOrigin.y === oy : ox === 0 && oy === 0;
  const prevSides =
    originMatches && options.prevSides && options.prevSides.length === tiles
      ? options.prevSides
      : null;
  const prevAnchor =
    originMatches && options.prevAnchor && options.prevAnchor.length === tiles
      ? options.prevAnchor
      : null;
  const sides = new Uint8Array(tiles);
  // The background each tile's side was decided on, carried to the next frame
  // so the deadband has something to measure against.
  const anchor = new Float32Array(tiles);
  const panelLuminance =
    0.2126 * linearFromChannel(panelRgb[0]) +
    0.7152 * linearFromChannel(panelRgb[1]) +
    0.0722 * linearFromChannel(panelRgb[2]);
  const sceneRgb = sampleRgbScratch;
  const tintAb = sampleTintScratch;
  let darkCount = 0;
  let contrastSum = 0;

  // Pass 2a: composite every tile's background and take the brightness
  // distribution — the veil is one number for the whole window, so it has to
  // be decided before any tile's ink can be solved.
  scratchFine(tiles);
  lumHistogram.fill(0);
  for (let fy = 0; fy < fh; fy++) {
    // Centre of this fine tile expressed in coarse-tile coordinates.
    const gy = (fy + 0.5) / upsample - 0.5;
    for (let fx = 0; fx < fw; fx++) {
      const gx = (fx + 0.5) / upsample - 0.5;
      const i = fy * fw + fx;
      if (upsample === 1) {
        // The fine grid IS the coarse grid then: both sample positions land
        // exactly on integer tile centres, where the bilinear reduces to a
        // copy — skip the interpolation arithmetic, its result is identical.
        sceneRgb[0] = scene[i * 3];
        sceneRgb[1] = scene[i * 3 + 1];
        sceneRgb[2] = scene[i * 3 + 2];
        tintAb[0] = tint[i * 2];
        tintAb[1] = tint[i * 2 + 1];
      } else {
        sampleGrid(scene, sw, sh, gx, gy, sceneRgb);
        sampleTint(tint, sw, sh, gx, gy, tintAb);
      }

      // What the glyph actually sits on: the panel tint, at the slider's
      // alpha, over the scene.
      const bgR = panelRgb[0] * rawAlpha + sceneRgb[0] * (1 - rawAlpha);
      const bgG = panelRgb[1] * rawAlpha + sceneRgb[1] * (1 - rawAlpha);
      const bgB = panelRgb[2] * rawAlpha + sceneRgb[2] * (1 - rawAlpha);
      bgScratch[i * 3] = bgR;
      bgScratch[i * 3 + 1] = bgG;
      bgScratch[i * 3 + 2] = bgB;
      fineTintScratch[i * 2] = tintAb[0];
      fineTintScratch[i * 2 + 1] = tintAb[1];
      const lum =
        0.2126 * linearFromChannel(bgR) +
        0.7152 * linearFromChannel(bgG) +
        0.0722 * linearFromChannel(bgB);
      lumScratch[i] = lum;
      const bucket = Math.min(63, (Math.cbrt(lum) * 64) | 0);
      lumHistogram[bucket]++;
    }
  }

  // The veil: how much panel the p95-bright tile needs to come down to the
  // cap. Solved in channel space on the grey of equal luminance, because that
  // is where the compositor mixes: veiling a channel value g towards the
  // panel's p by alpha lands on g*(1-a) + p*a, so the alpha that reaches the
  // cap falls straight out. A window already below the cap gets nothing.
  let veil = 0;
  {
    // Walk down from the bright end, spending the allowance on the brightest
    // tiles; the first bucket the allowance cannot cover is the one the veil
    // is sized for. (Breaking at the first non-empty bucket instead would
    // hand the whole allowance to a single specular highlight.)
    const allowedAbove = Math.max(1, Math.round(tiles * (1 - SCRIM_QUANTILE)));
    let spent = 0;
    let bucket = 0;
    for (let b = 63; b >= 0; b--) {
      if (spent + lumHistogram[b] > allowedAbove) {
        bucket = b;
        break;
      }
      spent += lumHistogram[b];
    }
    // Upper edge of the quantile bucket, back in luminance.
    const edge = (bucket + 1) / 64;
    const quantileLum = edge * edge * edge;
    if (quantileLum > backgroundCap) {
      const grey = channelFromLinear(quantileLum);
      const wanted = channelFromLinear(backgroundCap);
      const floor = channelFromLinear(panelLuminance);
      veil = grey > floor ? clamp((grey - wanted) / (grey - floor), 0, SCRIM_MAX_ALPHA) : 0;
    }
  }

  // Pass 2b: the ink, against the background as it will really look — through
  // the one veil the whole window shares.
  {
    for (let i = 0; i < tiles; i++) {
      tintAb[0] = fineTintScratch[i * 2];
      tintAb[1] = fineTintScratch[i * 2 + 1];
      let bgLuminance = lumScratch[i];
      if (veil > 0.004) {
        const lr = linearFromChannel(panelRgb[0] * veil + bgScratch[i * 3] * (1 - veil));
        const lg = linearFromChannel(panelRgb[1] * veil + bgScratch[i * 3 + 1] * (1 - veil));
        const lb = linearFromChannel(panelRgb[2] * veil + bgScratch[i * 3 + 2] * (1 - veil));
        bgLuminance = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      }

      // Perceptual-ish position of this background, and how far it has moved
      // since the side was last decided (see SIDE_RECONSIDER).
      const bgLevel = Math.cbrt(bgLuminance);
      // The best each side could do on this tile, at the bounds the ink is
      // actually held to.
      const lightBest =
        (Math.max(Y_LIGHTEST_INK, bgLuminance) + 0.05) /
        (Math.min(Y_LIGHTEST_INK, bgLuminance) + 0.05);
      const darkBest =
        (Math.max(bgLuminance, Y_DARKEST_INK) + 0.05) /
        (Math.min(bgLuminance, Y_DARKEST_INK) + 0.05);

      const wasDark = prevSides ? prevSides[i] === 1 : false;
      const hold =
        prevSides && prevAnchor && Math.abs(bgLevel - prevAnchor[i]) <= SIDE_RECONSIDER;

      let dark;
      if (hold) {
        dark = wasDark;
        anchor[i] = prevAnchor[i];
      } else {
        dark = wasDark
          ? darkBest * SIDE_HYSTERESIS >= lightBest
          : darkBest >= lightBest * SIDE_HYSTERESIS;
        anchor[i] = bgLevel;
      }
      sides[i] = dark ? 1 : 0;
      if (dark) darkCount++;

      const wanted = luminanceForContrast(bgLuminance, dark ? "dark" : "light", target);
      const inkL = clamp(neutralLightnessForLuminance(wanted), INK_L_MIN, INK_L_MAX);
      const o = i * 4;
      oklabToRgbInto(inkL, tintAb[0], tintAb[1], pixels, o);
      pixels[o + 3] = 255;

      const inkLuminance = inkL * inkL * inkL;
      contrastSum +=
        (Math.max(inkLuminance, bgLuminance) + 0.05) /
        (Math.min(inkLuminance, bgLuminance) + 0.05);
    }
  }

  return {
    w: fw,
    h: fh,
    pixels,
    sides,
    anchor,
    veil,
    panelRgb,
    // Where this (possibly cropped) field sits on the full grid, in coarse
    // tiles — the caller needs it to translate a full-grid crop rect into
    // field coordinates, and to hand the side decisions back next frame.
    origin: { x: ox, y: oy },
    upsample,
    darkRatio: darkCount / (fw * fh),
    meanContrast: contrastSum / (fw * fh),
  };
}

// The veil alone, straight from the coarse grid — no upsampling, no tint, no
// ink. buildInkField computes its own internally (the ink must be solved
// against the veiled background), but the WRITTEN veil rides on this one at
// the feed's cadence: it is a solid-colour fill, the one part of the effect
// this GPU paints for free, so it can answer a brightness change in ~80 ms
// while the expensive glyph map takes its budgeted time (see the pacing notes
// in theme-controller.js). Small disagreements between the two are converged
// away by the caller's smoothing.
export function computeVeil(sample, options = {}) {
  const w = sample && sample.w;
  const h = sample && sample.h;
  const data = sample && sample.data;
  if (!w || !h || !data || data.length < w * h * 3) return 0;
  const panelRgb = options.panelRgb || [10, 11, 13];
  const rawAlpha = Number.isFinite(options.panelAlpha) ? options.panelAlpha : 0.86;
  const alpha = Math.min(Math.max(rawAlpha, 0), UNCOMPOSITE_ALPHA_MAX);
  const scrimTarget = options.scrimTarget === undefined ? SCRIM_TARGET_CONTRAST : options.scrimTarget;
  if (!(scrimTarget > 0)) return 0;
  const backgroundCap = (Y_LIGHTEST_INK + 0.05) / scrimTarget - 0.05;
  const rect = options.panelGridRect || null;
  const sceneIsRaw = Boolean(options.sceneIsRaw);
  let x0 = 0;
  let y0 = 0;
  let x1 = w;
  let y1 = h;
  if (rect) {
    x0 = Math.min(Math.max(0, Math.floor(rect.x0)), w - 1);
    y0 = Math.min(Math.max(0, Math.floor(rect.y0)), h - 1);
    x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(rect.x1)));
    y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(rect.y1)));
  }
  lumHistogram.fill(0);
  let tiles = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      const a = sceneIsRaw ? 0 : alpha;
      const sr = uncomposite(data[i], panelRgb[0], a);
      const sg = uncomposite(data[i + 1], panelRgb[1], a);
      const sb = uncomposite(data[i + 2], panelRgb[2], a);
      const lum =
        0.2126 * linearFromChannel(panelRgb[0] * rawAlpha + sr * (1 - rawAlpha)) +
        0.7152 * linearFromChannel(panelRgb[1] * rawAlpha + sg * (1 - rawAlpha)) +
        0.0722 * linearFromChannel(panelRgb[2] * rawAlpha + sb * (1 - rawAlpha));
      lumHistogram[Math.min(63, (Math.cbrt(lum) * 64) | 0)]++;
      tiles++;
    }
  }
  if (!tiles) return 0;
  const allowedAbove = Math.max(1, Math.round(tiles * (1 - SCRIM_QUANTILE)));
  let spent = 0;
  let bucket = 0;
  for (let b = 63; b >= 0; b--) {
    if (spent + lumHistogram[b] > allowedAbove) {
      bucket = b;
      break;
    }
    spent += lumHistogram[b];
  }
  const edge = (bucket + 1) / 64;
  const quantileLum = edge * edge * edge;
  if (quantileLum <= backgroundCap) return 0;
  const panelLuminance =
    0.2126 * linearFromChannel(panelRgb[0]) +
    0.7152 * linearFromChannel(panelRgb[1]) +
    0.0722 * linearFromChannel(panelRgb[2]);
  const grey = channelFromLinear(quantileLum);
  const wanted = channelFromLinear(backgroundCap);
  const floor = channelFromLinear(panelLuminance);
  return grey > floor ? clamp((grey - wanted) / (grey - floor), 0, SCRIM_MAX_ALPHA) : 0;
}

// Where the window sits on the backdrop grid. The grid always covers the whole
// screen, so this is a straight proportional map from viewport pixels — and it
// is also how the map image gets lined up with the glyphs (see ink-map.mjs).
export function gridRectFor(rect, viewportW, viewportH, gridW, gridH) {
  if (!rect || !viewportW || !viewportH) return null;
  return {
    x0: (rect.left / viewportW) * gridW,
    y0: (rect.top / viewportH) * gridH,
    x1: (rect.right / viewportW) * gridW,
    y1: (rect.bottom / viewportH) * gridH,
  };
}

// Decodes backdropd's base64 tile payload. Returns null rather than a partial
// grid: a torn payload would show up as a band of wrong-coloured text across
// the shell, which is worse than one skipped frame.
//
// The returned bytes are a reused scratch buffer, valid until the next call —
// the one caller (theme-controller) folds them into its own smoothed grid in
// the same tick, and a fresh 7 KB array per message at the wire's ~24 Hz was
// nothing but garbage-collector feed.
let decodeScratch = null;

export function decodeGrid(base64, w, h, decoder) {
  const decode = decoder || (typeof atob === "function" ? atob : null);
  if (!decode || !base64 || !w || !h) return null;
  let binary;
  try {
    binary = decode(base64);
  } catch (e) {
    return null;
  }
  const expected = w * h * 3;
  if (binary.length !== expected) return null;
  if (!decodeScratch || decodeScratch.length !== expected) {
    decodeScratch = new Uint8Array(expected);
  }
  const data = decodeScratch;
  for (let i = 0; i < expected; i++) data[i] = binary.charCodeAt(i) & 255;
  return { w, h, data };
}
