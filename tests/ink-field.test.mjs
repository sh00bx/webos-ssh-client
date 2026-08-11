import assert from "node:assert";
import {
  buildInkField,
  computeVeil,
  decodeGrid,
  gridRectFor,
} from "../src/ink-field.mjs";
import {
  adaptiveShellFor,
  backgroundMetrics,
  compositeOver,
  contrastRatio,
  hexToRgb,
  luminanceForContrast,
  neutralLightnessForLuminance,
  oklabToRgbFast,
  rgbToOklch,
} from "../src/color.mjs";
import { THEMES } from "../src/themes.mjs";

const PANEL = [10, 11, 13];
// Most of the tests below drive the field with the veil turned off, because
// they are about the ink colour itself. With the veil on (the shipped default)
// the background is capped before the ink is solved, which is a different
// question — covered in its own section at the end.
const NO_SCRIM = { scrimTarget: 0 };

// How much painted contrast a theme profile is allowed to cost on any single
// tile, against the same tile solved with no profile.
//
// It is not zero, and that is the honest part. color.mjs used to claim outright
// that "no profile can make the shell less readable than Chameleon's", on the
// reasoning that nothing in the profile path touches lightness. The reasoning
// is right and the conclusion is still wrong: the solver aims for a contrast
// target in OKLab LIGHTNESS, and sRGB contrast is a different function of the
// same colour, so rotating hue and adding chroma at a fixed lightness does move
// the ratio a little. Measured across the whole cube below (5 themes × flash
// 0/0.5/1 × two panel alphas × three grids × 48 tiles) the worst single-tile
// loss is 0.491, on synthwave at full loudness; chameleon is exactly 0 by
// construction. This constant is where that bound is written down.
//
// The number that matters for READING is the absolute one, though, and it is
// reassuring in a way the relative figure is not: the worst painted contrast
// anywhere in the cube is 5.224 WITH profiles and 5.226 without. The floor is
// set by how far the lightness solver can reach on a mid-grey picture, not by
// any profile — the tiles that lose half a step are the ones starting around
// 7.3, which land near 6.8. That is why a relative bound is the right shape
// here and an absolute one would be theatre (the review that asked for this
// test measured the same thing: 7:1 is simply unreachable on some grids,
// INK_L_MAX being 0.94).
//
// Raised from 0.45 to 0.55 when the loudness envelope's top end went from 0.09
// to 0.13 ink chroma — deliberately, with the numbers above in hand, and only
// after the test had already gone red on the change. That is the whole point of
// having written it. Anything that pushes past 0.55 should shrink the envelope
// rather than move this line again.
const PROFILE_CONTRAST_TOLERANCE = 0.55;

// Builds a w×h grid from a function returning [r,g,b] per tile.
function makeGrid(w, h, fn) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { w, h, data };
}

function inkAt(field, fx, fy) {
  const o = (fy * field.w + fx) * 4;
  return [field.pixels[o], field.pixels[o + 1], field.pixels[o + 2]];
}

// What a glyph at this tile actually sits on, reproducing the composite the
// field solves against, so contrast can be checked independently of it.
function bgAt(grid, x, y, alpha) {
  const i = (y * grid.w + x) * 3;
  const sample = [grid.data[i], grid.data[i + 1], grid.data[i + 2]];
  // Clamped exactly as the field clamps it: a bright sample can un-composite
  // to over 255, which only means the panel is not really over that tile.
  const scene = sample.map((c, k) =>
    Math.min(255, Math.max(0, (c - PANEL[k] * alpha) / (1 - alpha))),
  );
  return compositeOver(PANEL, scene, alpha);
}

// An sRGB grey with a given OKLab lightness: neutral linear channels are L³.
function greyAtLightness(L) {
  const linear = L * L * L;
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

// --- the whole point: one screen, two answers ------------------------------
// A shot that is near-black on the left and bright on the right. This is the
// case the single-colour version could not express, and the case the user is
// looking at: text over the dark half needs to be light, text over the bright
// half needs to be dark, at the same instant.
{
  const alpha = 0.25;
  const split = makeGrid(16, 9, (x) => (x < 8 ? [18, 16, 20] : [226, 222, 214]));
  const field = buildInkField(split, { ...NO_SCRIM, panelRgb: PANEL, panelAlpha: alpha, upsample: 2 });

  assert.strictEqual(field.w, 32, "the field is subdivided when asked");
  assert.strictEqual(field.h, 18);

  const darkSide = inkAt(field, 2, 9);
  const brightSide = inkAt(field, 29, 9);
  const darkSideL = rgbToOklch(darkSide).L;
  const brightSideL = rgbToOklch(brightSide).L;
  // Not "as light as possible" — as light as it needs to be for the target,
  // which over a near-black background is well short of white and is the whole
  // reason the shell does not glare on an OLED.
  assert.ok(
    darkSideL > 0.6,
    `ink over the dark half should be light, got L=${darkSideL.toFixed(2)}`,
  );
  assert.ok(
    brightSideL < 0.4,
    `ink over the bright half should be dark, got L=${brightSideL.toFixed(2)}`,
  );
  assert.ok(darkSideL - brightSideL > 0.3, "the two halves must be plainly different");

  // Both halves readable, measured against the background each glyph is on.
  const darkBg = bgAt(split, 1, 4, alpha);
  const brightBg = bgAt(split, 14, 4, alpha);
  assert.ok(contrastRatio(darkSide, darkBg) >= 6, "dark half falls short");
  assert.ok(contrastRatio(brightSide, brightBg) >= 6, "bright half falls short");

  // ...and the flat colour cannot do this, which is why the grid exists. The
  // average of this screen is mid-grey; whatever single colour it produces,
  // one of the two halves is left unreadable.
  const average = { r: (18 + 226) / 2, g: (16 + 222) / 2, b: (20 + 214) / 2 };
  const flat = adaptiveShellFor({}, average, { panelRgb: PANEL, panelAlpha: alpha });
  const flatInk = hexToRgb(flat.shell.foreground);
  const flatWorst = Math.min(
    contrastRatio(flatInk, darkBg),
    contrastRatio(flatInk, brightBg),
  );
  assert.ok(
    flatWorst < 3,
    `the flat colour is expected to fail one half (worst ${flatWorst.toFixed(1)}:1)`,
  );
  const fieldWorst = Math.min(
    contrastRatio(darkSide, darkBg),
    contrastRatio(brightSide, brightBg),
  );
  assert.ok(fieldWorst > flatWorst * 2, "the field must beat it by a wide margin");
}

// --- contrast is solved, not clamped, across the whole brightness range ----
{
  const alpha = 0.3;
  const ramp = makeGrid(16, 4, (x) => {
    const v = Math.round((x / 15) * 255);
    return [v, v, v];
  });
  const field = buildInkField(ramp, { ...NO_SCRIM, panelRgb: PANEL, panelAlpha: alpha });
  assert.strictEqual(field.w, ramp.w, "the default field is the grid's own resolution");
  for (let x = 0; x < 16; x++) {
    const bg = bgAt(ramp, x, 1, alpha);
    const ink = inkAt(field, x, 1);
    const ratio = contrastRatio(ink, bg);
    // Mid-grey is the one place neither side can reach the 7:1 target — that
    // is a property of the background, not a bug — but it must still be well
    // clear of unreadable.
    assert.ok(ratio >= 3.6, `grey step ${x}: only ${ratio.toFixed(1)}:1`);
  }
}

// --- a grey scene gets grey ink; a coloured one gets the complement --------
{
  const grey = makeGrid(8, 8, () => [120, 120, 120]);
  const neutral = rgbToOklch(inkAt(buildInkField(grey, { ...NO_SCRIM, panelAlpha: 0 }), 4, 4));
  assert.ok(
    neutral.C < 0.002,
    `a colourless scene must not invent a hue, got C=${neutral.C.toFixed(3)}`,
  );
  // With the panel in the way the same *screen* grey implies a scene that is
  // very slightly warm — the panel tint is not neutral either, and dividing it
  // back out is what says so. That much cast is real, and must stay a whisper.
  const throughPanel = rgbToOklch(inkAt(buildInkField(grey, { ...NO_SCRIM, panelRgb: PANEL, panelAlpha: 0.4 }), 4, 4));
  assert.ok(
    throughPanel.C < 0.02,
    `a near-grey scene must stay near-grey, got C=${throughPanel.C.toFixed(3)}`,
  );

  // A warm scene: the ink leans cool. `opposition` is 180 when the two hues are
  // exactly complementary and 0 when they coincide, so this fails loudly if the
  // negation in the tint ever turns into a copy.
  const warm = makeGrid(8, 8, () => [200, 90, 40]);
  const warmField = buildInkField(warm, { ...NO_SCRIM, panelRgb: PANEL, panelAlpha: 0.3 });
  const warmInk = rgbToOklch(inkAt(warmField, 4, 4));
  const warmScene = rgbToOklch([200, 90, 40]);
  assert.ok(warmInk.C > 0.005, "a vivid scene should tint the ink");
  const opposition = Math.abs(((warmInk.h - warmScene.h + 540) % 360) - 180);
  assert.ok(
    opposition > 150,
    `ink hue should oppose the scene, ${opposition.toFixed(0)}° of 180°`,
  );
}

// --- the side is chosen by which one can actually be read ----------------
// The regression this encodes is the one the TV showed: a white leaderboard
// behind the panel composites to a flat mid-grey, and light ink on it measured
// 3.6:1 where dark ink gives 4.8:1. A lightness threshold got this wrong; the
// comparison below is the fix.
{
  const opts = { ...NO_SCRIM, panelAlpha: 0 };
  const leaderboard = makeGrid(4, 4, () => [120, 120, 120]);
  const field = buildInkField(leaderboard, opts);
  assert.strictEqual(field.darkRatio, 1, "mid-grey must take dark ink");
  const ink = inkAt(field, 2, 2);
  const ratio = contrastRatio(ink, [120, 120, 120]);
  assert.ok(ratio > 4.5, `dark ink on mid-grey should reach ~4.8:1, got ${ratio.toFixed(2)}`);
  // ...and it must beat what the light side could have managed there.
  const lightBest = contrastRatio(oklabToRgbFast(0.94, 0, 0), [120, 120, 120]);
  assert.ok(ratio > lightBest, `${ratio.toFixed(2)} should beat light's ${lightBest.toFixed(2)}`);
}

// A clearly dark background still gets light ink, and a clearly bright one
// dark ink, whatever the incumbent says — hysteresis is a tie-breaker, not a
// veto.
{
  const opts = { ...NO_SCRIM, panelAlpha: 0 };
  const size = 4 * 4;
  const dark = buildInkField(makeGrid(4, 4, () => [20, 20, 20]), {
    ...opts,
    prevSides: new Uint8Array(size).fill(1),
  });
  assert.strictEqual(dark.darkRatio, 0, "near-black must give up dark ink");
  const bright = buildInkField(makeGrid(4, 4, () => [235, 235, 235]), {
    ...opts,
    prevSides: new Uint8Array(size),
  });
  assert.strictEqual(bright.darkRatio, 1, "near-white must take dark ink");
}

// --- stability: a tile does not flip under the influence of its own ink ---
{
  // The background where both sides are exactly equal — the worst case, where
  // the ink's effect on its own capture is worth more than the whole decision.
  const yLight = 0.94 ** 3;
  const yDark = 0.09 ** 3;
  const yEven = Math.sqrt((yLight + 0.05) * (yDark + 0.05)) - 0.05;
  const even = greyAtLightness(Math.cbrt(yEven));
  const opts = { ...NO_SCRIM, panelAlpha: 0 };
  const first = buildInkField(makeGrid(4, 4, () => [even, even, even]), opts);

  // Now feed back what the screen would look like WITH that ink painted on it:
  // roughly ten levels either way at typical glyph coverage. Neither direction
  // may change the decision, or the effect oscillates on every frame.
  for (const shift of [-12, -6, 6, 12]) {
    const v = even + shift;
    const next = buildInkField(makeGrid(4, 4, () => [v, v, v]), {
      ...opts,
      prevSides: first.sides,
      prevAnchor: first.anchor,
    });
    assert.strictEqual(
      next.darkRatio,
      first.darkRatio,
      `self-feedback of ${shift} levels flipped the tile`,
    );
  }

  // A real scene change is a different matter: it clears the deadband and the
  // tile decides again on the merits.
  const bright = buildInkField(makeGrid(4, 4, () => [235, 235, 235]), {
    ...opts,
    prevSides: first.sides,
    prevAnchor: first.anchor,
  });
  assert.strictEqual(bright.darkRatio, 1, "a real change must still be followed");
  const dark = buildInkField(makeGrid(4, 4, () => [15, 15, 15]), {
    ...opts,
    prevSides: bright.sides,
    prevAnchor: bright.anchor,
  });
  assert.strictEqual(dark.darkRatio, 0, "...in both directions");
}

// --- the panel footprint is honoured -------------------------------------
// Un-compositing outside the window would hand those tiles a scene brighter
// than the one on screen, and the interpolation would drag that error inwards.
{
  const grid = makeGrid(8, 8, () => [100, 100, 100]);
  const opts = { ...NO_SCRIM, panelRgb: PANEL, panelAlpha: 0.6 };
  const everywhere = buildInkField(grid, opts);
  const bounded = buildInkField(grid, {
    ...opts,
    panelGridRect: { x0: 0, y0: 0, x1: 4, y1: 8 },
  });
  const insideA = inkAt(everywhere, 1, 4);
  const insideB = inkAt(bounded, 1, 4);
  // Tile 5 sits outside the panel (x1 = 4) but inside the solve domain's
  // 2-tile margin — tiles beyond the margin are not solved at all any more,
  // which is the point of the domain crop.
  const outsideA = inkAt(everywhere, 5, 4);
  const outsideB = inkAt(bounded, 5, 4);
  assert.deepStrictEqual(insideA, insideB, "inside the panel nothing changes");

  // A raw-scene grid (backdropd's vtcapture path) must land on the same ink
  // as a composited grid of the same scene: what the un-composite recovers is
  // exactly what sceneIsRaw is handed directly. Rounding the composited bytes
  // costs up to half a channel step, amplified 1/(1-alpha) by the recovery.
  const alpha = 0.6;
  const scene = [180, 120, 60];
  const rawField = buildInkField(
    makeGrid(8, 8, () => scene),
    { ...opts, panelAlpha: alpha, sceneIsRaw: true },
  );
  const composited = buildInkField(
    makeGrid(8, 8, () => scene.map((c, k) => Math.round(PANEL[k] * alpha + c * (1 - alpha)))),
    { ...opts, panelAlpha: alpha },
  );
  const rawInk = inkAt(rawField, 4, 4);
  const compInk = inkAt(composited, 4, 4);
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(rawInk[c] - compInk[c]) <= 3,
      `raw and recovered scenes should agree, channel ${c}: ${rawInk[c]} vs ${compInk[c]}`,
    );
  }
  assert.notDeepStrictEqual(outsideA, outsideB, "outside it the tint is not divided out");
}

// --- the closed-form solve agrees with the definition it replaced ---------
{
  for (const bg of [[0, 0, 0], [64, 70, 60], [128, 128, 128], [200, 30, 30], [255, 255, 255]]) {
    const { luminance } = backgroundMetrics(bg);
    for (const side of ["light", "dark"]) {
      const wanted = luminanceForContrast(luminance, side, 7);
      if (wanted < 0 || wanted > 1) continue; // unreachable on this side
      const L = neutralLightnessForLuminance(wanted);
      // A neutral OKLab colour's linear channels are exactly L³, so the
      // luminance round-trips; that identity is what the field relies on.
      assert.ok(Math.abs(L * L * L - wanted) < 1e-12, "cube root must invert L³");
      const ratio = contrastRatio(oklabToRgbFast(L, 0, 0), bg);
      assert.ok(
        Math.abs(ratio - 7) < 0.1,
        `solved ink should land on the target, got ${ratio.toFixed(2)}:1 (${side}, ${bg})`,
      );
    }
  }
}

// --- decodeGrid: a torn payload is dropped, never half-applied ------------
{
  const bytes = [1, 2, 3, 250, 251, 252];
  const b64 = Buffer.from(bytes).toString("base64");
  const decoder = (s) => Buffer.from(s, "base64").toString("binary");
  const grid = decodeGrid(b64, 2, 1, decoder);
  assert.deepStrictEqual(Array.from(grid.data), bytes);
  assert.strictEqual(grid.w, 2);
  assert.strictEqual(decodeGrid(b64, 3, 1, decoder), null, "short payload rejected");
  assert.strictEqual(decodeGrid(b64, 1, 1, decoder), null, "long payload rejected");
  assert.strictEqual(decodeGrid("", 2, 1, decoder), null);
  assert.strictEqual(decodeGrid(b64, 0, 0, decoder), null);
}

// --- gridRectFor: viewport pixels to tile coordinates ---------------------
{
  const rect = gridRectFor(
    { left: 960, top: 540, right: 1920, bottom: 1080 },
    1920,
    1080,
    64,
    36,
  );
  assert.deepStrictEqual(rect, { x0: 32, y0: 18, x1: 64, y1: 36 });
  assert.strictEqual(gridRectFor(null, 1920, 1080, 64, 36), null);
  assert.strictEqual(gridRectFor({ left: 0 }, 0, 1080, 64, 36), null);
}

// --- shape guards ---------------------------------------------------------
{
  assert.strictEqual(buildInkField(null), null);
  assert.strictEqual(buildInkField({ w: 4, h: 4, data: new Uint8Array(3) }), null);
  const field = buildInkField(makeGrid(4, 3, () => [10, 10, 10]), { upsample: 1 });
  assert.strictEqual(field.w, 4, "upsample 1 keeps the grid's own resolution");
  assert.strictEqual(field.h, 3);
  assert.strictEqual(field.pixels.length, 4 * 3 * 4);
  for (let i = 3; i < field.pixels.length; i += 4) {
    assert.strictEqual(field.pixels[i], 255, "the map is opaque");
  }
}

// --- the veil: readability where no ink colour could have won -------------
// One alpha for the whole window, sized on the bright end of the tile
// distribution (the per-tile version was measurably right and visually wrong —
// clouding — and cost a second full-screen image layer per frame).
{
  const alpha = 0.25;
  // Composite the veil the way the compositor will, so contrast can be checked
  // against what the glyph will really sit on.
  const veiled = (bg, a) => bg.map((c, k) => PANEL[k] * a + c * (1 - a));

  const dark = makeGrid(4, 4, () => [20, 20, 20]);
  const bright = makeGrid(4, 4, () => [235, 235, 235]);
  const opts = { panelRgb: PANEL, panelAlpha: alpha };

  // Where the picture is already dark the window stays exactly as see-through
  // as it was: no veil at all.
  assert.strictEqual(buildInkField(dark, opts).veil, 0, "a dark picture needs no veil");

  const brightField = buildInkField(bright, opts);
  const a = brightField.veil;
  assert.ok(a > 0.3 && a <= 0.8, `a bright picture should be veiled, got ${a.toFixed(2)}`);

  // The point of all of it: light ink now reads on the bright half, which is
  // exactly what no colour could achieve before.
  const bg = bgAt(bright, 1, 1, alpha);
  const ink = inkAt(brightField, 1, 1);
  const before = contrastRatio(ink, bg);
  const after = contrastRatio(ink, veiled(bg, a));
  assert.ok(after >= 4.5, `veiled contrast should clear 4.5:1, got ${after.toFixed(2)}`);
  assert.ok(after > before * 1.5, `the veil must actually buy contrast (${before.toFixed(2)} -> ${after.toFixed(2)})`);

  // And with the background capped there is nothing left for the light/dark
  // flip to decide, which is why the shell stops switching sides under moving
  // content.
  assert.strictEqual(brightField.darkRatio, 0, "a veiled background keeps light ink");
  assert.strictEqual(
    buildInkField(bright, { ...opts, scrimTarget: 0 }).darkRatio,
    1,
    "without the veil the same picture would have flipped to dark ink",
  );

  // Uniform means the bright REGION decides for the window: a mostly-dark
  // picture with a bright band still gets a veil strong enough for the band
  // (it is well above the 5% the quantile ignores), and a lone bright tile —
  // one of sixteen — does NOT dim the whole window.
  const banded = makeGrid(4, 4, (x) => (x >= 2 ? [235, 235, 235] : [20, 20, 20]));
  const bandVeil = buildInkField(banded, opts).veil;
  assert.ok(bandVeil > 0.3, `a bright half must drive the veil, got ${bandVeil.toFixed(2)}`);
  const speck = makeGrid(4, 4, (x, y) => (x === 0 && y === 0 ? [235, 235, 235] : [20, 20, 20]));
  const speckVeil = buildInkField(speck, opts).veil;
  assert.ok(
    speckVeil < bandVeil / 2,
    `one bright tile in sixteen must not dim the window like a bright half does (${speckVeil.toFixed(2)} vs ${bandVeil.toFixed(2)})`,
  );
}

// --- cropping the solve to the window changes nothing the window can see.
// The domain crop exists to skip tiles outside the panel; every tile INSIDE
// the panel must come out bit-identical to the full-grid solve. (Veil off via
// scrimTarget: 0 so tiles are independent — the veil legitimately differs,
// since cropped it is measured over the window's own backdrop.)
{
  const w = 32;
  const h = 18;
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = (i * 37) % 256;
    data[i * 3 + 1] = (i * 91) % 256;
    data[i * 3 + 2] = (i * 53) % 256;
  }
  const rect = { x0: 8.3, y0: 4.2, x1: 20.7, y1: 12.9 };
  const opts = { panelRgb: [10, 11, 13], panelAlpha: 0.3, scrimTarget: 0 };
  const fullField = buildInkField({ w, h, data }, { ...opts, panelGridRect: null });
  const cropped = buildInkField({ w, h, data }, { ...opts, panelGridRect: rect });
  assert.strictEqual(fullField.origin.x, 0);
  assert.ok(cropped.w < fullField.w && cropped.h < fullField.h, "the crop actually shrinks the field");
  let compared = 0;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const inPanel = gx + 0.5 >= rect.x0 && gx + 0.5 <= rect.x1 && gy + 0.5 >= rect.y0 && gy + 0.5 <= rect.y1;
      if (!inPanel) continue;
      const lx = gx - cropped.origin.x;
      const ly = gy - cropped.origin.y;
      for (let c = 0; c < 4; c++) {
        assert.strictEqual(
          cropped.pixels[(ly * cropped.w + lx) * 4 + c],
          fullField.pixels[(gy * fullField.w + gx) * 4 + c],
          `tile ${gx},${gy} channel ${c} matches the full solve`,
        );
      }
      compared++;
    }
  }
  assert.ok(compared > 50, `the comparison covered the panel (${compared} tiles)`);
  // Sides only carry over when the domain matches — a moved window must not
  // hold stale decisions against shifted indices.
  const moved = buildInkField(
    { w, h, data },
    {
      ...opts,
      panelGridRect: { x0: rect.x0 + 4, y0: rect.y0, x1: rect.x1 + 4, y1: rect.y1 },
      prevSides: cropped.sides,
      prevAnchor: cropped.anchor,
      prevOrigin: cropped.origin,
    },
  );
  assert.notStrictEqual(moved.origin.x, cropped.origin.x, "the moved window has a new origin");
}

// --- the standalone veil agrees with the one the field solves against ------
{
  const w = 16, h = 9;
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = i % 2 ? 220 : 40;
    data[i * 3] = v; data[i * 3 + 1] = v; data[i * 3 + 2] = v;
  }
  const opts = { panelRgb: [10, 11, 13], panelAlpha: 0.3 };
  const fieldVeil = buildInkField({ w, h, data }, opts).veil;
  const standalone = computeVeil({ w, h, data }, opts);
  assert.ok(
    Math.abs(fieldVeil - standalone) < 0.03,
    `computeVeil tracks the field's veil (${standalone.toFixed(3)} vs ${fieldVeil.toFixed(3)})`,
  );
  assert.strictEqual(computeVeil({ w, h, data }, { ...opts, scrimTarget: 0 }), 0, "scrimTarget 0 disables it");
}

// --- the theme's profile colours the field without spending its contrast ----
// The per-tile path and the flat path have to agree about what a theme looks
// like (they colour the same screen), and neither may buy that look with
// readability — the contrast solve is deliberately downstream of the hue.
{
  const w = 10;
  const h = 8;
  // A picture with real colour in it, so the profile has a temperature to cross
  // on, and a flat grey one, where it has none and rests on its bisector.
  const lit = makeGrid(w, h, (x) => (x < w / 2 ? [150, 60, 30] : [30, 60, 150]));
  const grey = makeGrid(w, h, () => [96, 96, 96]);
  const opts = { panelRgb: PANEL, panelAlpha: 0.3, ...NO_SCRIM };
  const phosphor = { label: "bloom", mode: "duotone", hue: 120, hue2: 190, warmHue: 60, swing: 1, base: 0.45 };
  const chromaAt = (field, i) => rgbToOklch([
    field.pixels[i * 4],
    field.pixels[i * 4 + 1],
    field.pixels[i * 4 + 2],
  ]);

  for (const grid of [lit, grey]) {
    const plain = buildInkField(grid, opts);
    const themed = buildInkField(grid, { ...opts, reactive: phosphor });
    for (let i = 0; i < w * h; i++) {
      const ink = chromaAt(themed, i);
      assert.ok(ink.C > 0.01, `tile ${i} carries the theme's colour (C=${ink.C.toFixed(3)})`);
      // Inside the crossing, not on one pole: the two halves of `lit` are a
      // warm and a cold shot, so this grid deliberately drives the profile to
      // BOTH ends. 155° is the bisector of 120/190 and the tube's own green;
      // half the crossing plus a degree of 8-bit rounding is the whole range
      // the theme is allowed to occupy.
      assert.ok(
        Math.abs(((ink.h - 155 + 540) % 360) - 180) < 36,
        `tile ${i} carries the theme's HUE (${ink.h.toFixed(0)}° vs 155° ± 35°)`,
      );
    }
    // Same lightness decisions, same readability: only the hue moved.
    //
    // ⚠️ This block used to assert `sides`, `meanContrast` and `veil` equal
    // between the two runs, and all three of those are STRUCTURALLY incapable
    // of failing. The tint reaches exactly one expression — the (a,b) pair
    // handed to oklabToRgbInto at the end of the per-tile loop — while `sides`
    // comes from lightBest/darkBest, `veil` from the luminance histogram and
    // the solved lightness from neutralLightnessForLuminance, every one of them
    // computed in the earlier pass, before any profile is read. Verified by
    // running the pair with an absurd profile (chroma 50, i.e. pinned at the
    // ceiling on every tile): sidesEq true, veilEq true, meanContrastEq true to
    // sixteen digits — and pixelsEq false. Three green assertions over a screen
    // that had visibly changed.
    //
    // What actually needs guarding is the PAINTED contrast, per tile and paired
    // against the unprofiled run: the ink is a colour on a real background, and
    // a hue rotation at fixed lightness does move the contrast ratio, just not
    // the lightness the solver aimed for. Absolute bounds are no use here
    // (INK_L_MAX = 0.94 puts 7:1 out of reach on these grids — the unprofiled
    // worst case is 6.02 on `lit`), so the guarantee this file can honestly
    // make is a RELATIVE one: adding a theme profile never costs more than a
    // hair of contrast on any tile.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bg = bgAt(grid, x, y, opts.panelAlpha);
        const themedContrast = contrastRatio(inkAt(themed, x, y), bg);
        const plainContrast = contrastRatio(inkAt(plain, x, y), bg);
        assert.ok(
          themedContrast >= plainContrast - PROFILE_CONTRAST_TOLERANCE,
          `tile ${x},${y}: the profile does not spend contrast ` +
            `(${plainContrast.toFixed(3)} -> ${themedContrast.toFixed(3)})`,
        );
      }
    }
    assert.deepStrictEqual(themed.sides, plain.sides, "the profile does not move the light/dark line");
  }

  // Under Chameleon's own profile the grey picture still gives grey ink: the
  // floor belongs to the themes that have a hue of their own.
  const cham = buildInkField(grey, { ...opts, reactive: { mode: "complement", base: 0 } });
  assert.ok(chromaAt(cham, 0).C < 0.01, "chameleon leaves a colourless picture colourless");
  assert.deepStrictEqual(
    Array.from(buildInkField(grey, opts).pixels),
    Array.from(cham.pixels),
    "...and is what an omitted profile falls back to",
  );
}

// --- the SHIPPED profiles, over the whole loudness envelope ------------------
// The block above proves the property on one hand-written profile at the
// default loudness. That is the easy half of the envelope: at flash 0.5 the ink
// chroma tops out around 0.06 and INK_CHROMA_CEILING never binds, so a change
// to the ceiling — the single knob most likely to be reached for when someone
// wants the effect louder — cannot be felt there at all. (Confirmed: raising it
// from 0.10 to 0.24 left the block above green.)
//
// So drive the real registry across the whole envelope, against the backgrounds
// that make it worst: contrast is scarcest where the ink is at its lightest,
// which is over a dark picture behind a thin panel. This is the test that has
// to go red first if the loudness tuning ever starts buying its look with
// readability — and it does: raising the loud end of inkChromaMax to 0.15 fails
// it immediately.
//
// What this block does NOT guard is INK_CHROMA_CEILING. With the shipped
// envelope the largest any profile can ask for is synthwave's 0.1625, under the
// 0.17 cap, so the cap never binds anywhere in the cube below and changing it
// leaves this file green (checked at 0.05 and at 1.0). That is deliberate — the
// ceiling is a backstop, not a working limit — and it is pinned from both sides
// in tests/color.test.mjs instead. Do not add a ceiling claim here.
{
  const w = 8;
  const h = 6;
  const grids = [
    // A dark shot with real colour in it — the anchored profiles' worst case,
    // because the ink runs light and any chroma spent is contrast not spent.
    makeGrid(w, h, (x) => (x < w / 2 ? [18, 22, 34] : [40, 20, 14])),
    // A bright saturated one, where the ink runs dark instead.
    makeGrid(w, h, (x) => (x < w / 2 ? [210, 190, 120] : [120, 190, 230])),
    // And a neutral mid grey, where an anchored profile leans on its base
    // chroma floor with no scene colour to justify it.
    makeGrid(w, h, () => [128, 128, 128]),
  ];

  for (const theme of THEMES) {
    for (const flash of [0, 0.5, 1]) {
      for (const panelAlpha of [0.3, 0.86]) {
        const opts = { panelRgb: PANEL, panelAlpha, flash, ...NO_SCRIM };
        for (const grid of grids) {
          const plain = buildInkField(grid, opts);
          const themed = buildInkField(grid, { ...opts, reactive: theme.reactive });
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const bg = bgAt(grid, x, y, panelAlpha);
              const themedContrast = contrastRatio(inkAt(themed, x, y), bg);
              const plainContrast = contrastRatio(inkAt(plain, x, y), bg);
              assert.ok(
                themedContrast >= plainContrast - PROFILE_CONTRAST_TOLERANCE,
                `${theme.id} at flash ${flash}, panel ${panelAlpha}, tile ${x},${y}: ` +
                  `profile costs contrast (${plainContrast.toFixed(3)} -> ${themedContrast.toFixed(3)})`,
              );
            }
          }
        }
      }
    }
  }
}

console.log("ink-field tests passed");
