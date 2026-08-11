import assert from "node:assert";
import { THEMES } from "../src/themes.mjs";
import {
  flashParams,
  INK_CHROMA_CEILING,
  reactiveGeometry,
  reactiveInkChroma,
  reactiveTintInto,
  UNCOMPOSITE_ALPHA_MAX,
  adaptiveShellFor,
  backdropBehindPanel,
  compositeOver,
  contrastRatio,
  hexToRgb,
  hexToRgbTriplet,
  oklabDistance,
  oklchToHex,
  oklchToRgb,
  relativeLuminance,
  rgbToHex,
  rgbToOklch,
  solveInkLightness,
} from "../src/color.mjs";

const PANEL = [10, 11, 13];
const base = { foreground: "#c6ccce", background: "rgba(4, 5, 6, 0.96)" };
const close = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// --- hex plumbing.
assert.deepStrictEqual(hexToRgb("#73ff9a"), [115, 255, 154]);
assert.deepStrictEqual(hexToRgb("73ff9a"), [115, 255, 154]);
assert.strictEqual(hexToRgb("#fff"), null, "short form is not accepted");
assert.strictEqual(hexToRgb(null), null);
assert.strictEqual(rgbToHex([115, 255, 154]), "#73ff9a");
assert.strictEqual(rgbToHex([-4, 260, 0.6]), "#00ff01", "channels clamp and round");
assert.strictEqual(hexToRgbTriplet("#73ff9a"), "115, 255, 154");
assert.strictEqual(hexToRgbTriplet("rgb(1,2,3)"), null);
assert.strictEqual(hexToRgbTriplet(undefined), null);

// --- OKLCh round-trips.
const white = rgbToOklch([255, 255, 255]);
close(white.L, 1, 0.001, "white is L=1");
close(white.C, 0, 0.001, "white has no chroma");
close(rgbToOklch([0, 0, 0]).L, 0, 0.001, "black is L=0");
// A neutral sample must report NO hue: handing a hue derived from sensor noise
// to everything downstream is the fault this module exists to fix.
assert.strictEqual(rgbToOklch([128, 128, 128]).h, 0, "grey has no hue");
assert.ok(rgbToOklch([128, 128, 129]).C < 0.005, "near-grey is near-neutral");
for (const hex of ["#62b487", "#c46259", "#7899ad", "#040506", "#f0e8d8"]) {
  const { L, C, h } = rgbToOklch(hexToRgb(hex));
  assert.strictEqual(oklchToHex(L, C, h), hex, `${hex} survives the round trip`);
}

// --- gamut mapping. A vivid blue at L=0.8 does not exist in sRGB; chroma has to
// give way, and lightness must NOT — that would be the HSL flare all over again.
const wanted = { L: 0.8, C: 0.3, h: 264 };
const mapped = rgbToOklch(oklchToRgb(wanted.L, wanted.C, wanted.h));
close(mapped.L, wanted.L, 0.01, "lightness is preserved");
assert.ok(mapped.C < wanted.C * 0.6, `chroma gave way (${mapped.C.toFixed(3)})`);
close(mapped.h, wanted.h, 1.5, "hue is preserved");
oklchToRgb(0.5, 0.4, 90).forEach((c) => {
  assert.ok(c >= 0 && c <= 255 && Number.isInteger(c), "output stays a byte");
});
// Constant perceptual lightness across the hue circle is the reason for OKLCh:
// the same request at every hue lands within a hair of one luminance.
const lums = [];
for (let h = 0; h < 360; h += 30) lums.push(relativeLuminance(oklchToRgb(0.75, 0.06, h)));
const spread = Math.max(...lums) / Math.min(...lums);
assert.ok(spread < 1.1, `luminance holds across hues (spread ${spread.toFixed(2)})`);

// --- contrast + compositing.
close(contrastRatio([255, 255, 255], [0, 0, 0]), 21, 0.01, "black on white is 21:1");
close(contrastRatio([0, 0, 0], [255, 255, 255]), 21, 0.01, "order does not matter");
close(contrastRatio([120, 120, 120], [120, 120, 120]), 1, 0.001, "same colour is 1:1");
assert.deepStrictEqual(compositeOver([0, 0, 0], [200, 200, 200], 0.5), [100, 100, 100]);
assert.deepStrictEqual(compositeOver([10, 20, 30], [50, 50, 50], 1), [10, 20, 30]);
assert.deepStrictEqual(compositeOver([10, 20, 30], [50, 60, 70], 0), [50, 60, 70]);

// --- un-compositing our own panel back out of the sample. The numbers are a
// measured pair from the TV — one DISPLAY capture and one VIDEO capture of the
// same instant — so this checks the model against ground truth, not itself.
const recovered = backdropBehindPanel({ r: 44, g: 38, b: 52 }, PANEL, 0.25);
[54, 44, 62].forEach((truth, i) => {
  assert.ok(
    Math.abs(recovered[i] - truth) <= 4,
    `channel ${i} recovers the video plane (${recovered[i].toFixed(1)} vs ${truth})`,
  );
});
// Compositing the recovered scene back under the panel returns the sample.
compositeOver(PANEL, recovered, 0.25).forEach((c, i) =>
  close(c, [44, 38, 52][i], 0.001, "un-composite inverts composite"),
);
// The 1/(1-alpha) amplification is capped, and the result stays a colour.
backdropBehindPanel({ r: 255, g: 0, b: 128 }, PANEL, 0.99).forEach((c) =>
  assert.ok(c >= 0 && c <= 255, "stays in range at alpha 0.99"),
);
assert.deepStrictEqual(
  backdropBehindPanel({ r: 90, g: 90, b: 90 }, PANEL, 0.95),
  backdropBehindPanel({ r: 90, g: 90, b: 90 }, PANEL, UNCOMPOSITE_ALPHA_MAX),
  "alpha past the cap behaves as the cap",
);

// --- the ink solver hits its target from either side.
const darkBg = [12, 13, 15];
const lightSolved = solveInkLightness(0.04, 200, darkBg, "light");
assert.ok(
  contrastRatio(oklchToRgb(lightSolved, 0.04, 200), darkBg) >= 7,
  "light ink reaches the target over a dark background",
);
// ...and no further: ink is no brighter than it has to be.
assert.ok(
  contrastRatio(oklchToRgb(lightSolved - 0.02, 0.04, 200), darkBg) < 7,
  "the solution is the boundary, not the extreme",
);
const brightBg = [232, 230, 226];
assert.ok(
  contrastRatio(oklchToRgb(solveInkLightness(0.04, 200, brightBg, "dark"), 0.04, 200), brightBg) >= 7,
  "dark ink reaches the target over a bright background",
);
// An impossible target returns the bound rather than looping or throwing.
const hopeless = solveInkLightness(0.04, 200, [128, 128, 128], "light", 21);
assert.ok(hopeless > 0.9 && hopeless <= 1, "unreachable target saturates at the bound");

// --- adaptiveShellFor.
const shellKeys = ["foreground", "cursor", "cursorAccent", "selectionBackground"];
const purpleScene = { r: 44, g: 38, b: 52 };
const purple = adaptiveShellFor(base, purpleScene, { panelRgb: PANEL, panelAlpha: 0.25 });
assert.strictEqual(purple.shell.background, base.background, "the base palette carries through");
shellKeys.forEach((key) => assert.match(purple.shell[key], /^#[0-9a-f]{6}$/, key));
assert.match(purple.accent, /^#[0-9a-f]{6}$/);
assert.ok(purple.contrast >= 6.9, `ink keeps its contrast (${purple.contrast.toFixed(1)}:1)`);
// Counter-tint: a purple scene must not produce purple text.
const inkHue = rgbToOklch(hexToRgb(purple.shell.foreground)).h;
const sceneHue = rgbToOklch(backdropBehindPanel(purpleScene, PANEL, 0.25)).h;
// Signed distance from a half turn, wrapped into (-180, 180].
close(((inkHue - sceneHue - 180 + 540) % 360) - 180, 0, 3, "ink sits opposite the scene");

// A neutral scene must give neutral text — the loudest failure of the old
// effect was turning grey into turquoise.
const greyInk = rgbToOklch(
  hexToRgb(
    adaptiveShellFor(base, { r: 128, g: 128, b: 128 }, {
      panelRgb: PANEL,
      panelAlpha: 0.6,
    }).shell.foreground,
  ),
);
assert.ok(greyInk.C < 0.012, `grey scene gives neutral ink (C=${greyInk.C.toFixed(3)})`);

// Ink stays disciplined and spark stays vivid at every scene in the set — the
// whole thesis of the split, so it is asserted rather than eyeballed.
const scenes = [
  { r: 44, g: 38, b: 52 }, { r: 196, g: 96, b: 44 }, { r: 48, g: 120, b: 60 },
  { r: 128, g: 128, b: 128 }, { r: 210, g: 214, b: 222 }, { r: 14, g: 20, b: 38 },
  { r: 0, g: 0, b: 0 }, { r: 70, g: 34, b: 14 },
];
for (const alpha of [0.2, 0.25, 0.5, 0.86, 1]) {
  for (const scene of scenes) {
    const out = adaptiveShellFor(base, scene, { panelRgb: PANEL, panelAlpha: alpha });
    const where = `scene ${JSON.stringify(scene)} at alpha ${alpha}`;
    const ink = rgbToOklch(hexToRgb(out.shell.foreground));
    const spark = rgbToOklch(hexToRgb(out.accent));
    assert.ok(ink.C <= 0.061, `ink stays a whisper: ${where} (C=${ink.C.toFixed(3)})`);
    assert.ok(spark.C >= 0.05, `spark carries colour: ${where} (C=${spark.C.toFixed(3)})`);
    assert.ok(
      contrastRatio(hexToRgb(out.shell.cursorAccent), hexToRgb(out.shell.cursor)) > 4,
      `the glyph inside the cursor stays readable: ${where}`,
    );
    // Selection has to invert with the side, or a dark band would land under
    // dark ink the moment the shell flips over a bright scene.
    assert.ok(
      contrastRatio(hexToRgb(out.shell.foreground), hexToRgb(out.shell.selectionBackground)) > 4.5,
      `selected text stays readable: ${where}`,
    );
    assert.ok(out.contrast >= 3.4, `ink never collapses: ${where} (${out.contrast.toFixed(1)}:1)`);
    assert.ok(["light", "dark"].includes(out.side));
  }
}

// A bright scene under a transparent panel must move the text to dark. The old
// lightness clamp could not express this and left pale tan on snow.
const snow = adaptiveShellFor(base, { r: 210, g: 214, b: 222 }, {
  panelRgb: PANEL,
  panelAlpha: 0.25,
});
assert.strictEqual(snow.side, "dark", "bright scene flips ink dark");
assert.ok(rgbToOklch(hexToRgb(snow.shell.foreground)).L < 0.5, "and the ink really is dark");
// The same scene behind a near-opaque panel does not: nothing shows through, so
// there is nothing to adapt to.
assert.strictEqual(
  adaptiveShellFor(base, { r: 210, g: 214, b: 222 }, { panelRgb: PANEL, panelAlpha: 0.95 }).side,
  "light",
  "an opaque panel keeps the shell light-on-dark",
);

// Side hysteresis: the incumbent has to be beaten by a margin, so a scene
// drifting across the tie point cannot strobe between white and black text.
const rampSide = (v, prevSide) =>
  adaptiveShellFor(base, { r: v, g: v, b: v }, {
    panelRgb: PANEL,
    panelAlpha: 0.25,
    prevSide,
  }).side;
let flipUp = null;
for (let v = 0; v <= 255 && flipUp === null; v++) if (rampSide(v, "light") === "dark") flipUp = v;
let flipDown = null;
for (let v = 255; v >= 0 && flipDown === null; v--) if (rampSide(v, "dark") === "light") flipDown = v;
assert.ok(flipUp !== null && flipDown !== null, "both flips happen somewhere on the ramp");
assert.ok(flipUp - flipDown > 8, `the flips leave a dead zone (${flipDown} -> ${flipUp})`);

// --- the repaint deadband can tell "same colour" from "moved".
assert.strictEqual(oklabDistance("#a4a3a3", "#a4a3a3"), 0);
assert.ok(oklabDistance("#a4a3a3", "#a5a4a4") < 0.01, "a byte of drift is not a repaint");
assert.ok(oklabDistance("#a4a3a3", "#96bdcf") > 0.05, "a real move is");
assert.strictEqual(oklabDistance("#a4a3a3", "nonsense"), Infinity, "unparseable never matches");

// --- the flash knob's midpoint IS the pre-knob tuning, and omitting it means
// the midpoint — so nothing changes for an untouched install.
{
  const mid = flashParams(0.5);
  assert.strictEqual(mid.inkChromaMax, 0.06);
  assert.strictEqual(mid.chromaReference, 0.12);
  assert.strictEqual(mid.sparkChromaMin, 0.06);
  assert.strictEqual(mid.sparkChromaMax, 0.16);
  assert.deepStrictEqual(flashParams(undefined), mid, "no flash option = midpoint");
  const quiet = flashParams(0);
  const loud = flashParams(1);
  assert.ok(loud.inkChromaMax > mid.inkChromaMax && mid.inkChromaMax > quiet.inkChromaMax);
  assert.ok(loud.chromaReference < mid.chromaReference, "louder = intensity saturates earlier");
  assert.ok(loud.sparkChromaMax > mid.sparkChromaMax);
  assert.deepStrictEqual(flashParams(7), loud, "out-of-range clamps");
  // The full derivation follows the knob in the direction it promises.
  const scene = { r: 140, g: 60, b: 40 };
  const opts = { panelRgb: PANEL, panelAlpha: 0.25 };
  const quietSpark = rgbToOklch(hexToRgb(adaptiveShellFor(base, scene, { ...opts, flash: 0 }).accent)).C;
  const loudSpark = rgbToOklch(hexToRgb(adaptiveShellFor(base, scene, { ...opts, flash: 1 }).accent)).C;
  assert.ok(loudSpark > quietSpark + 0.02, `spark chroma follows the knob (${quietSpark} -> ${loudSpark})`);
}

// --- per-theme reactive profiles ------------------------------------------
// The registry itself is under test here, not just the engine: a profile with a
// misspelt mode would silently fall back to Chameleon's complement and take the
// theme's identity with it, which is exactly the kind of fault that only shows
// up on the TV in front of a moving picture.
{
  const opts = { panelRgb: PANEL, panelAlpha: 0.25 };
  const profileOf = (id) => THEMES.find((t) => t.id === id).reactive;
  const hueOf = (hex) => rgbToOklch(hexToRgb(hex)).h;
  // Signed hue distance, wrapped into (-180, 180].
  const hueGap = (a, b) => ((a - b + 540) % 360) - 180;

  for (const theme of THEMES) {
    const p = theme.reactive;
    assert.ok(p && typeof p.label === "string", `${theme.id} names its variant`);
    assert.ok(
      ["complement", "duotone"].includes(p.mode),
      `${theme.id} has a mode the engine knows (${p.mode})`,
    );
    if (p.mode !== "complement") {
      assert.ok(Number.isFinite(p.hue), `${theme.id} names a first pole`);
      assert.ok(p.base > 0, `${theme.id} keeps its colour on a colourless scene`);
      // A duotone with no second pole is not a quiet duotone, it is a DEAD one:
      // reactiveGeometry falls hue2 back to hue, both pole vectors come out
      // identical, and the lerp between them stops depending on t at all — the
      // profile then returns the same hue for a scene and its exact opposite.
      // The same freeze arrives via hue2 === hue, so the guard is a separation,
      // not a null check. 20° is well under the narrowest shipped crossing (64°)
      // and well over anything that could be a rounding artefact.
      assert.ok(Number.isFinite(p.hue2), `${theme.id} names a second pole`);
      assert.ok(
        Math.abs(hueGap(p.hue, p.hue2)) >= 20,
        `${theme.id}: its two poles are ${Math.abs(hueGap(p.hue, p.hue2)).toFixed(1)}° apart, ` +
          `which is not a crossing`,
      );
    }
  }

  // Chameleon must be BIT-IDENTICAL to the unprofiled effect: this whole change
  // is meant to add four variants, not to alter the one that already shipped.
  for (const scene of scenes) {
    for (const flash of [0, 0.5, 1]) {
      assert.deepStrictEqual(
        adaptiveShellFor(base, scene, { ...opts, flash, reactive: profileOf("chameleon") }).shell,
        adaptiveShellFor(base, scene, { ...opts, flash }).shell,
        `chameleon is the unprofiled default (${JSON.stringify(scene)} @ ${flash})`,
      );
    }
  }

  // Where a duotone RESTS — the hue a colourless picture leaves it on — has to
  // be a colour the theme already owns. Nothing else in either suite ties the
  // profile to the palette: phosphor's poles could be moved from 120/190 to
  // 0/70 and every other assertion still passed, which would have shipped a
  // green terminal that reacts in orange. The resting hue is the bisector of the
  // two pole VECTORS, and for the three themes built around one signature colour
  // that bisector is the signature itself (the cursor). Synthwave is the
  // exception the registry documents: its poles are two lights rather than one
  // colour plus two neighbours, so it rests on their midpoint, which is its own
  // blue — measured at 4.9° off, hence a 6° tolerance rather than 5.
  const restsOn = { phosphor: "cursor", amber: "cursor", blueprint: "cursor", synthwave: "blue" };
  const bisectorOf = (p) =>
    (((Math.atan2(
      Math.sin((p.hue * Math.PI) / 180) + Math.sin((p.hue2 * Math.PI) / 180),
      Math.cos((p.hue * Math.PI) / 180) + Math.cos((p.hue2 * Math.PI) / 180),
    ) *
      180) /
      Math.PI) +
      360) %
    360;
  for (const theme of THEMES) {
    const p = theme.reactive;
    if (!p || p.mode !== "duotone") continue;
    const key = restsOn[theme.id];
    assert.ok(key, `${theme.id}: name the palette colour this theme rests on`);
    const own = rgbToOklch(hexToRgb(theme.shell[key])).h;
    assert.ok(
      Math.abs(hueGap(bisectorOf(p), own)) < 6,
      `${theme.id}: it rests on the palette's own ${key} ` +
        `(bisector ${bisectorOf(p).toFixed(1)}° vs ${own.toFixed(1)}°)`,
    );
  }

  // ...and it never leaves the crossing it declared. This replaces the asin
  // bound the retired `anchor` mode needed, and it is a stronger guarantee for
  // a weaker reason: the ink direction is a NORMALISED LERP of the two pole
  // vectors, and such a blend cannot leave the shorter arc between them for any
  // t at all. So the bound is simply half the crossing, measured from the
  // bisector, and it holds by construction rather than by tuning — what this
  // catches is the engine drifting away from that construction. The 1.2° margin
  // is the trip through 8-bit sRGB, kept from the bound it replaces (measured
  // worst excess there was 0.551°, and the quantisation is the same here).
  for (const theme of THEMES) {
    const p = theme.reactive;
    if (!p || p.mode !== "duotone") continue;
    const bisector = bisectorOf(p);
    const half = Math.abs(hueGap(p.hue, p.hue2)) / 2;
    for (const scene of scenes) {
      for (const flash of [0, 1]) {
        const out = adaptiveShellFor(base, scene, { ...opts, flash, reactive: p });
        const gap = hueGap(hueOf(out.accent), bisector);
        assert.ok(
          Math.abs(gap) <= half + 1.2,
          `${theme.id} stays inside its crossing: scene ${JSON.stringify(scene)} put it ` +
            `${gap.toFixed(1)}° off the bisector (max ${(half + 1.2).toFixed(1)}°)`,
        );
      }
    }
  }

  // ...and it still has a colour in front of a picture that has none, which is
  // the one place it must NOT behave like Chameleon.
  const grey = { r: 128, g: 128, b: 128 };
  for (const id of ["phosphor", "amber", "blueprint", "synthwave"]) {
    const p = profileOf(id);
    const ink = rgbToOklch(
      hexToRgb(adaptiveShellFor(base, grey, { ...opts, reactive: p }).shell.foreground),
    );
    assert.ok(ink.C > 0.012, `${id} tints a grey scene (C=${ink.C.toFixed(3)})`);
    // A duotone with no scene colour to lean on sits BETWEEN its two poles —
    // and "between" for this engine is the midpoint of two unit VECTORS, not
    // the arithmetic mean of two angles. They agree only while the pair does
    // not straddle 0°, which synthwave's 340/215 happens not to do; an ordinary
    // ember/rose duotone (355 and 25) would have the engine at 10° while the
    // arithmetic mean says 190 — the test would fail on correct code, and fail
    // by 180°. Same class of error as the atan bound above.
    const expected =
      p.mode === "duotone"
        ? (Math.atan2(
            Math.sin((p.hue * Math.PI) / 180) + Math.sin((p.hue2 * Math.PI) / 180),
            Math.cos((p.hue * Math.PI) / 180) + Math.cos((p.hue2 * Math.PI) / 180),
          ) *
            180) /
            Math.PI
        : p.hue;
    assert.ok(
      Math.abs(hueGap(ink.h, expected)) < 25,
      `${id} tints it in its own hue (${ink.h.toFixed(0)}° vs ${expected.toFixed(0)}°)`,
    );
  }
  assert.ok(
    rgbToOklch(hexToRgb(adaptiveShellFor(base, grey, { ...opts, reactive: profileOf("chameleon") }).shell.foreground)).C <
      0.012,
    "chameleon still refuses to invent a hue",
  );

  // Every duotone crosses between its two lights with the temperature of the
  // scene, and crosses the RIGHT WAY: `hue` is the warmer pole and belongs to a
  // COLD scene, `hue2` the cooler one and belongs to a warm scene. Ink opposes
  // the picture — Chameleon's rule, which the palette themes now follow too.
  // Getting this backwards is invisible to every other assertion here (the
  // resting hue, the arc bound and the travel floor below all hold either way)
  // and would simply look wrong on the TV. Note that "warmer" is cos(h −
  // warmHue), not the smaller angle: past 240° the wheel has turned far enough
  // that the higher number is the warmer one, which is why Cyanotype's poles
  // read backwards from Bloom's and Ember's.
  const warmness = (h, p) => Math.cos(((h - (p.warmHue ?? 60)) * Math.PI) / 180);
  for (const theme of THEMES) {
    const p = theme.reactive;
    if (!p || p.mode !== "duotone") continue;
    assert.ok(
      warmness(p.hue, p) > warmness(p.hue2, p),
      `${theme.id}: hue (${p.hue}°) must be the warmer pole, hue2 (${p.hue2}°) the cooler`,
    );
    const warm = hueOf(adaptiveShellFor(base, { r: 200, g: 90, b: 30 }, { ...opts, reactive: p }).accent);
    const cold = hueOf(adaptiveShellFor(base, { r: 30, g: 60, b: 200 }, { ...opts, reactive: p }).accent);
    assert.ok(
      Math.abs(hueGap(warm, p.hue2)) < 20,
      `${theme.id}: a warm scene reaches the cool pole (${warm.toFixed(0)}° vs ${p.hue2}°)`,
    );
    assert.ok(
      Math.abs(hueGap(cold, p.hue)) < 20,
      `${theme.id}: a cold scene reaches the warm pole (${cold.toFixed(0)}° vs ${p.hue}°)`,
    );
  }

  // --- the effect has to be VISIBLE, on every theme ---------------------------
  // The defect this whole section exists to prevent, stated as a number. Three
  // themes shipped on the retired `anchor` mode and read on the TV as not
  // reacting at all; the suite was entirely green, because every assertion above
  // is about where the ink may NOT go and none was about it having to go
  // anywhere. So: the OKLab distance between the ink over a vivid warm scene and
  // over a vivid cold one, both at the same lightness and chroma so only their
  // hue differs.
  //
  // Lightness is normalised out of the comparison (both inks are re-rendered at
  // L 0.8) on purpose. Every theme reacts in lightness identically — that half
  // is the shared contrast solve — so leaving it in would have flattered exactly
  // the profiles that were not reacting.
  //
  // The floor is 0.05, comfortably under the quietest shipped theme and well
  // over what the retired tuning managed. Measured at flash 1:
  //
  //   before   cyanotype 0.008  ember 0.024  bloom 0.035  chameleon 0.136  neon 0.196
  //   after    cyanotype 0.071  bloom 0.090  ember 0.099  chameleon 0.136  neon 0.196
  //
  // i.e. the old tuning fails this by a factor of six on Blueprint, which is the
  // mutation that proves the assertion can fire.
  //
  // Measured at the DEFAULT panel opacity (86). The whole effect scales with
  // that slider and the floor is not portable across it: behind a thin panel
  // the background is mostly picture, the contrast solve pushes the ink close to
  // white, and near-white ink has no room left to carry chroma. At opacity 65
  // the same five come out 0.107 / 0.126 / 0.032 / 0.073 / 0.043 — every theme
  // still reacts, the ordering is not even the same one, and Cyanotype would sit
  // just over a 0.03 floor. Pinning two alphas at once would therefore pin the
  // quietest theme to within 6% of failing, which is a tripwire for any retune
  // rather than a guard against a dead profile. One representative alpha, and
  // this note, is the honest trade.
  {
    const TRAVEL_FLOOR = 0.05;
    const vivid = (h) => {
      const [r, g, b] = oklchToRgb(0.55, 0.11, h);
      return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
    };
    // Panel alpha is the shipped one here, not this block's thin 0.25: the
    // question is what the user sees, and behind a thin panel every theme has an
    // easier time of it.
    const seen = { ...opts, panelAlpha: 0.86, flash: 1 };
    const hueOnly = (hex) => {
      const ok = rgbToOklch(hexToRgb(hex));
      return oklchToHex(0.8, ok.C, ok.h);
    };
    for (const theme of THEMES) {
      const p = theme.reactive;
      const warm = adaptiveShellFor(theme.shell, vivid(45), { ...seen, reactive: p });
      const cold = adaptiveShellFor(theme.shell, vivid(255), { ...seen, reactive: p });
      const travel = oklabDistance(
        hueOnly(warm.shell.foreground),
        hueOnly(cold.shell.foreground),
      );
      assert.ok(
        travel >= TRAVEL_FLOOR,
        `${theme.id} (${p.label}) visibly reacts: warm-to-cold ink travel ` +
          `${travel.toFixed(3)} is under the ${TRAVEL_FLOOR} floor`,
      );
    }
  }

  // The engine's own guarantees: the tint carries exactly the chroma asked for,
  // and no theme multiplier can push ink past the ceiling the lightness solve
  // is accurate to.
  const out = new Float64Array(2);
  reactiveTintInto(reactiveGeometry(profileOf("phosphor")), 0.05, -0.02, 0.0539, 1, 0.04, out, 0);
  close(Math.hypot(out[0], out[1]), 0.04, 1e-9, "the tint is the requested chroma");
  reactiveTintInto(reactiveGeometry(profileOf("chameleon")), 0, 0, 0, 0, 0.04, out, 0);
  close(Math.hypot(out[0], out[1]), 0.04, 1e-9, "a hueless sample still yields a direction");
  // The ceiling is a BACKSTOP, and the shipped envelope has to fit under it.
  // It used to be the other way round — this assertion read `strictEqual(...,
  // INK_CHROMA_CEILING)`, i.e. it demanded that the loudest theme at the
  // loudest setting be clipped — and that is exactly what made the top of the
  // slider feel flat: Synthwave asked for 0.1125 and got 0.10, so a good part
  // of its travel did nothing at all. The ceiling is now sized to clear the
  // loud end, and what needs guarding is that relationship, not the number.
  const loudGeo = reactiveGeometry(profileOf("synthwave"));
  const loudest = reactiveInkChroma(loudGeo, flashParams(1).inkChromaMax, 1);
  assert.ok(
    loudest < INK_CHROMA_CEILING,
    `the loudest shipped theme gets what it asks for (${loudest} vs ceiling ${INK_CHROMA_CEILING})`,
  );
  assert.strictEqual(
    loudest,
    flashParams(1).inkChromaMax * loudGeo.chroma,
    "...which is exactly the envelope times its own multiplier, unclipped",
  );
  // But the backstop is still a backstop: a profile with a wilder multiplier
  // than anything in the registry is clipped rather than allowed to walk the
  // lightness solve out of its accurate range.
  assert.strictEqual(
    reactiveInkChroma(reactiveGeometry({ mode: "duotone", hue: 0, hue2: 40, chroma: 4 }), flashParams(1).inkChromaMax, 1),
    INK_CHROMA_CEILING,
    "a profile past the ceiling is capped",
  );
  assert.ok(
    reactiveInkChroma(reactiveGeometry(profileOf("blueprint")), flashParams(0.5).inkChromaMax, 0) > 0,
    "the floor is a floor, not a minimum scene chroma",
  );
  // An unknown profile is not a crash and not a surprise: it is Chameleon.
  assert.strictEqual(reactiveGeometry({ mode: "nonsense" }).base, 0);
  assert.strictEqual(reactiveGeometry(undefined).mode, reactiveGeometry({}).mode);
}

console.log("color tests passed");
