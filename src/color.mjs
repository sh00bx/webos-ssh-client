// Colour maths for the adaptive "Chameleon" theme. Pure and DOM-free so it can
// be unit-tested (tests/color.test.mjs) — the effect itself is only observable
// on the TV, where the backdrop feed lives.
//
// The first version rotated the backdrop average's hue 180°, floored its
// saturation at 0.55 and clamped HSL lightness to 0.62-0.88. Run against real
// samples that turns out to be a pastel highlighter wheel with no relation to
// the picture: a mostly-dark screen averages to near-black, so its *hue* is
// noise, and forcing 55% saturation onto noise gives #f1d0d8 pink one moment
// and #69d3d3 turquoise the next. A neutral grey scene — no hue at all — came
// out turquoise. The lightness clamp also forbade dark text, so a bright scene
// under a near-transparent panel put pale tan on snow.
//
// This version splits the two jobs that were fused into that one colour:
//
//   ink   — the shell text. Hue is still the scene's complement, but chroma is
//           a whisper *derived from the scene's own chroma*, so a grey scene
//           gets genuinely neutral text; and lightness is SOLVED for a contrast
//           target against the background the glyph actually sits on (the panel
//           tint at the slider's alpha, over the scene). That is what lets ink
//           go dark over snow, which the old clamp could not express.
//   spark — cursor, selection and the window-chrome accent. Same complement,
//           chroma high, perceptual lightness fixed. Saturation is an asset on
//           a two-cell cursor and a liability across a screen of text, so this
//           is where the colour of the effect now lives.
//
// All of it in OKLCh rather than HSL, because HSL "lightness" is not
// brightness: hsl(60,55%,80%) and hsl(240,55%,80%) differ by more than 3:1 in
// luminance, which is why the old effect visibly flared and dimmed as the hue
// drifted. A fixed OKLCh L holds apparent brightness while the hue moves.

// Ink aims for the contrast the static themes already ship (phosphor's #a4aca6
// on #030405 is ~8.9:1), and is allowed to fall short rather than invent
// contrast the background cannot give — a mid-grey backdrop under a
// half-transparent panel has no high-contrast answer in either direction.
export const INK_TARGET_CONTRAST = 7;
// How much colour the scene is carrying, on a 0-1 scale, driving ink and spark
// chroma together. The reference is the chroma of a properly vivid scene — a
// sunset measures 0.18, a floodlit pitch 0.15 — and the square root is there
// because dim scenes are where the interesting values live: a dusk interior
// measures 0.03, and a linear map would render that as no colour at all.
export const CHROMA_REFERENCE = 0.12;
// Ink's chroma ceiling keeps "adaptive" from becoming "tinted": at 0.06 the cast
// is plainly there and still not nameable as a hue at a glance.
export const INK_CHROMA_MAX = 0.06;
// The hard ceiling on ink chroma, whatever the slider and the theme's own
// multiplier work out to together. The lightness solve is a closed form that
// assumes a near-neutral ink (see neutralLightnessForLuminance): its error is
// under 2% at INK_CHROMA_MAX and grows with chroma from there — so a loud theme
// at flash 100 is capped rather than allowed to quietly undershoot the contrast
// target it is holding the line for.
//
// Sized to CLEAR the loud end rather than to clip it: the slider tops out at
// 0.13 and the loudest theme multiplier is 1.25, so 0.1625 is what a fully
// loud Synthwave actually asks for. At the old 0.10 this constant was silently
// the binding limit for that theme and made most of the slider's top half inert
// — raising the envelope without raising this would have changed nothing.
// It is still a real backstop against a future profile with a wilder
// multiplier; the per-tile contrast bound in tests/ink-field.mjs is the guard
// that decides whether a given envelope is affordable at all.
export const INK_CHROMA_CEILING = 0.17;
// Ink never goes all the way to white or black. Not for contrast — for the
// effect: pure white has no chroma to carry, so letting the solver run to 1.0
// made the tint vanish on exactly the vivid scenes that should show it most,
// and put a full-brightness sheet of text on an OLED besides. It only costs
// contrast on backgrounds bright enough that the light side was losing anyway,
// where the side decision below then moves the text to the other side.
export const INK_L_MAX = 0.94;
export const INK_L_MIN = 0.09;
// Spark is the opposite bargain: chroma high enough to read as a colour, with a
// floor so a scene with no hue at all still gives the cursor some life — the one
// place the old saturation floor was the right instinct, just on the wrong
// surface. Its chroma range lives in flashParams (user-scaled); the lightness
// anchors below do not move with the knob.
const SPARK_L_ON_DARK = 0.78;
const SPARK_L_ON_LIGHT = 0.36;
const SELECTION_L_ON_DARK = 0.28;
const SELECTION_L_ON_LIGHT = 0.9;
const SELECTION_CHROMA_MAX = 0.055;
// Which side the text belongs on is a question about how the background *reads*,
// and WCAG relative luminance answers it badly: that formula weights green so
// heavily that a bright saturated orange scores 0.18 — nominally a dark
// background — so comparing achievable contrast left pale blue text floating on
// a sunset at 3.8:1. OKLCh lightness puts the same orange at 0.62, where anyone
// would tell you to write in black. Two thresholds rather than one, because
// flipping the whole shell between light-on-dark and dark-on-light is the most
// visible thing this code does and must not chatter at the boundary: dark ink
// takes over above ENTER and has to fall back below EXIT to give it up.
// ENTER sits just past the measured crossover: on neutral grey, black and white
// text come out equally readable at OKLCh L 0.565 (sRGB 118), so dark ink takes
// over once it is genuinely the better of the two. EXIT is far enough below to
// leave a band about 20 grey levels wide.
export const BG_READS_LIGHT_ENTER = 0.57;
export const BG_READS_LIGHT_EXIT = 0.51;

// The user's one knob for how loud the effect is (0..1, the toolbar slider's
// percentage over 100). It scales the whole chroma envelope — ink cast, the
// scene-chroma reference that drives intensity, and the spark's range — and
// nothing else: contrast targets and lightness bounds stay put.
//
// THREE ANCHORED POINTS, not two, and that is why this is a curve rather than a
// lerp. The old linear mapping ran 0.03 → 0.09 with the midpoint falling out at
// 0.06, and the midpoint is not free to move: it is EXACTLY the tuning that
// shipped before the knob existed, a fresh install has to look unchanged, and a
// test asserts it. But the top was reported as still too flat — the slider ran
// out of travel before the effect ran out of headroom. Raising the loud end of
// a lerp would have dragged the midpoint up with it, so the mapping is now
// quadratic through all three anchors: 0 and 50 stay exactly where they were
// and every bit of the new range lands in the half the complaint was about.
//
//   quiet (0)    the quietest the effect has ever been, not off
//   mid (50)     bit-identical to the pre-knob tuning — asserted
//   loud (100)   ink chroma 0.13, up from 0.09
//
// The cost is real, bounded, and smaller than it looks. The closed-form
// lightness solve (see neutralLightnessForLuminance) grows less honest as
// chroma rises, so a tile can land below the 7:1 the solver aimed at: measured
// worst single-tile loss across every theme, flash level, panel alpha and grid
// in tests/ink-field.mjs is 0.491 at the new top end against 0.365 at the old
// one — the affected tiles start near 7.3 and land near 6.8. What does NOT move
// is the floor: the worst painted contrast anywhere in that cube is 5.224 with
// profiles and 5.226 without, because the real floor is how far the solver can
// reach on a mid-grey picture and no profile touches that. The test asserts the
// bound per tile rather than trusting this comment.
export function flashParams(flash) {
  const f = clamp01(Number.isFinite(flash) ? flash : 0.5);
  // The parabola through (0, quiet), (0.5, mid), (1, loud). Reduces to the old
  // straight line whenever mid is the average of the other two, so a parameter
  // that wants no extra push at the top can simply say so.
  //
  // Written around the MIDPOINT rather than around zero, which is not a
  // stylistic choice: the midpoint has to come back bit-exact (a test asserts
  // strict equality with the pre-knob tuning, and a fresh install must render
  // identically). In the textbook `a·f² + b·f + c` form it does not — the
  // coefficients are sums of the three anchors and f=0.5 came back 0.12000000000000002
  // for a nominal 0.12. Here the whole correction is multiplied by (f − 0.5),
  // which is exactly zero at the midpoint, so `mid` is returned untouched.
  const curve = (quiet, mid, loud) => {
    const d = f - 0.5;
    return mid + d * (loud - quiet + 2 * (loud + quiet - 2 * mid) * d);
  };
  return {
    inkChromaMax: curve(0.03, 0.06, 0.13),
    // Inverted: a LOWER reference means a pale scene drives the envelope
    // harder, so the loud end goes down, not up.
    chromaReference: curve(0.16, 0.12, 0.05),
    sparkChromaMin: curve(0.03, 0.06, 0.13),
    sparkChromaMax: curve(0.1, 0.16, 0.3),
  };
}

// --- per-theme reactive profiles --------------------------------------------
//
// A profile (themes.mjs) says WHICH HUE the reaction is expressed in. Nothing
// here touches the lightness solve, the contrast target or the veil — the
// readability machinery runs upstream of every line below and cannot read a
// profile even in principle.
//
// That does NOT quite add up to "no profile can make the shell less readable",
// which is what this comment used to claim, so here is the honest version: the
// solve aims at a contrast target through OKLab LIGHTNESS, and sRGB contrast is
// a different function of the same colour, so rotating the hue and adding
// chroma at a fixed lightness moves the ratio slightly even though the
// lightness is untouched. Bounded and measured — worst single tile 0.491
// against a target of 7.0, on Synthwave at full loudness, and exactly 0 for
// Chameleon. tests/ink-field.test.mjs asserts that bound per tile against the
// unprofiled solve, which is the guard that has to catch it if a louder
// envelope ever starts spending real contrast. Widening the palette themes'
// crossings did not move it: the binding case is the loudest CHROMA, not the
// longest hue travel, so it stayed on Synthwave (Bloom's own worst even fell,
// 0.488 -> 0.468, while Cyanotype's rose 0.298 -> 0.401).
//
// Everything below works on the OKLab (a, b) vector rather than on a hue angle,
// and that is not a stylistic choice: the per-glyph field interpolates the tint
// between neighbouring tiles, and an angle cannot be interpolated across the
// 360° seam without special-casing it. A blend of two direction vectors can,
// which is also what makes the duotone mode a plain lerp.
//
// There used to be a third mode, "anchor": hold the theme's hue and lerp it a
// fraction `pull` of the way towards the scene's complement. It is gone, and
// not because nothing used it — three of the five themes did. The rotation a
// lerp between two unit vectors produces is asin(k·sinθ / |…|), i.e. SINE-
// shaped in the offset angle θ: maximal at θ=90° and zero at BOTH θ=0 and
// θ=180°. Since the target was the scene's complement, a theme anchored in the
// warm half of the wheel sat on one of those zeros for warm scenes and on the
// other for cold ones — the mode was blind on exactly the axis a moving picture
// travels, and liveliest on magenta-lit scenes that barely occur. Measured
// warm-to-cold ink movement was 0.008-0.035 OKLab against duotone's 0.196 on
// the same envelope. Do not reintroduce it for a theme that has ONE signature
// hue; give that theme two poles straddling its signature instead (themes.mjs).
export const MODE_COMPLEMENT = 0;
export const MODE_DUOTONE = 2;

// What an absent or unrecognised profile falls back to: exactly the effect as
// it shipped when Chameleon was the only theme that had one.
export const DEFAULT_REACTIVE = { mode: "complement", base: 0, chroma: 1 };

// Resolved profiles are cached per profile OBJECT (the registry's entries are
// module constants, so this is a lookup, not a rebuild) — the trig for the pole
// vectors would otherwise be paid on every frame of the feed.
const reactiveCache = new WeakMap();

function unitAt(deg, out) {
  const rad = (deg * Math.PI) / 180;
  out[0] = Math.cos(rad);
  out[1] = Math.sin(rad);
}

export function reactiveGeometry(profile) {
  const p = profile && typeof profile === "object" ? profile : DEFAULT_REACTIVE;
  const cached = reactiveCache.get(p);
  if (cached) return cached;
  const mode = p.mode === "duotone" ? MODE_DUOTONE : MODE_COMPLEMENT;
  const pole = [0, 0];
  const geo = {
    mode,
    label: typeof p.label === "string" ? p.label : "reactive",
    swing: clamp01(Number.isFinite(p.swing) ? p.swing : 1),
    base: clamp01(Number.isFinite(p.base) ? p.base : 0),
    chroma: Number.isFinite(p.chroma) && p.chroma > 0 ? p.chroma : 1,
  };
  unitAt(Number.isFinite(p.hue) ? p.hue : 0, pole);
  geo.ax = pole[0];
  geo.ay = pole[1];
  unitAt(Number.isFinite(p.hue2) ? p.hue2 : Number.isFinite(p.hue) ? p.hue : 0, pole);
  geo.bx = pole[0];
  geo.by = pole[1];
  unitAt(Number.isFinite(p.warmHue) ? p.warmHue : 60, pole);
  geo.wx = pole[0];
  geo.wy = pole[1];
  reactiveCache.set(p, geo);
  return geo;
}

// How much chroma the ink carries for a scene of this `intensity` (0-1): the
// profile's floor, plus the scene's own contribution over what is left.
export function reactiveInkChroma(geo, maxChroma, intensity) {
  const amount = geo.base + (1 - geo.base) * clamp01(intensity);
  return Math.min(INK_CHROMA_CEILING, maxChroma * geo.chroma * amount);
}

// Writes the ink's chroma vector for one sample into out[offset], out[offset+1].
// `a`/`b`/`chroma` describe the SCENE, `intensity` is how much colour it is
// carrying (0-1, the same number that scales the chroma), and `scale` is the
// chroma the ink should end up with (reactiveInkChroma above, or the spark's).
//
// Everything the scene is allowed to MOVE is scaled by that intensity, and that
// is not a refinement — it is the same lesson the module header opens with. A
// sample's hue direction is a unit vector however faint the colour behind it
// is, so without this a shot that is grey to the eye still swings the hue by
// the profile's full allowance, on noise. (Measured: a neutral 128-grey scene
// un-composited through our own slightly blue panel reads as faintly warm, and
// drove Synthwave all the way to its cyan pole.) With it, a colourless picture
// leaves a duotone exactly between its two lights — which, for the four themes
// whose poles straddle their signature hue, is that signature — and colour has
// to be really there before it moves anything.
//
// The hueless case is then handled per mode rather than globally: with no hue
// in the sample a complement is arithmetic noise and must not be invented, but
// a duotone profile is not guessing — both its poles are the theme's, and a
// green terminal in front of a black screen should still be green. Complement
// mode answers with the 180° direction the old polar code produced for a hue-0
// sample, so a grey scene keeps giving Chameleon exactly the spark it always
// did (ink chroma there is zero anyway, base being 0).
export function reactiveTintInto(geo, a, b, chroma, intensity, scale, out, offset) {
  const hueless = !(chroma > 1e-4);
  const confidence = clamp01(intensity);
  let dx;
  let dy;
  if (geo.mode === MODE_DUOTONE) {
    // Where the scene sits on the cool-to-warm axis, and therefore which of the
    // two lights is on. A hueless scene sits exactly between them.
    const warmth = hueless ? 0 : ((a * geo.wx + b * geo.wy) / chroma) * confidence;
    const t = clamp01(0.5 + 0.5 * geo.swing * warmth);
    dx = geo.ax + (geo.bx - geo.ax) * t;
    dy = geo.ay + (geo.by - geo.ay) * t;
  } else if (hueless) {
    dx = -1;
    dy = 0;
  } else {
    dx = -a / chroma;
    dy = -b / chroma;
  }
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 1e-6)) {
    // Only reachable from a duotone profile with antipodal poles, which no
    // registry entry has — but a zero-length direction would come out of
    // oklabToRgbInto as a NaN colour, so it is worth the branch.
    out[offset] = 0;
    out[offset + 1] = 0;
    return;
  }
  out[offset] = (dx / len) * scale;
  out[offset + 1] = (dy / len) * scale;
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampRange(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(channel) {
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

export function hexToRgb(hex) {
  const match = HEX_RE.exec(String(hex || "").trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(rgb) {
  return `#${rgb
    .map((c) => Math.round(clampRange(c, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`;
}

// "#7fb3d5" -> "127, 179, 213". Returns null for anything unparseable, so
// callers can leave the existing CSS value in place. The triplet form exists
// because rgba() compositions have to happen at the CSS use site — see the
// note on --panel-bg-rgb in styles.css.
export function hexToRgbTriplet(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgb.join(", ") : null;
}

// --- OKLab / OKLCh (Björn Ottosson's matrices) -----------------------------

// Linearised sRGB for every 8-bit channel value, so the per-tile ink field can
// analyse thousands of colours a frame without paying pow() for each channel.
// Sampling to integers first costs at most half a channel step, which is below
// what any of this resolves.
export const SRGB_LINEAR_TABLE = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i);
  return table;
})();

// The 8-bit channel whose linear value is `linear` — the inverse of the table
// above. The scrim solves "how much darker does this tile have to be" in
// channel space, because that is the space the compositor blends in.
export function channelFromLinear(linear) {
  const c = linearToSrgb(clamp01(linear)) * 255;
  return c < 0 ? 0 : c > 255 ? 255 : c;
}

export function linearFromChannel(channel) {
  const i = channel < 0 ? 0 : channel > 255 ? 255 : Math.round(channel);
  return SRGB_LINEAR_TABLE[i];
}

export function oklabFromLinear(lr, lg, lb) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

// The same, writing into a caller-owned triple instead of returning a fresh
// object. Every allocation-free variant in this file exists for one reason:
// the ink field calls them thousands of times per frame, and the object per
// call was showing up on the TV as collection pauses in the middle of typing —
// the solve time swung between 6 ms and 68 ms until the hot path stopped
// allocating. Nothing else should need these.
export function oklabFromLinearInto(lr, lg, lb, out) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

// Only the lightness, for the light/dark decision, without computing the two
// chroma components the caller would throw away.
export function oklabLightnessFromLinear(lr, lg, lb) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

export function rgbToOklch(rgb) {
  const { L, a, b } = oklabFromLinear(
    srgbToLinear(rgb[0]),
    srgbToLinear(rgb[1]),
    srgbToLinear(rgb[2]),
  );
  const C = Math.sqrt(a * a + b * b);
  // Below that chroma the hue is arithmetic noise rather than a colour, and
  // reporting 0 is what stops a neutral sample from handing a random hue to
  // everything downstream — the single biggest fault in the old effect.
  const h = C < 1e-4 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C, h: (h + 360) % 360 };
}

// Linear-light sRGB, before the transfer function. Kept separate from the
// encoded form because the gamut test below only needs this one: whether a
// channel is inside 0-1 is the same question before and after a transfer
// function that is monotonic and fixes both ends — and asking it here keeps
// pow() out of the search loop entirely.
function oklabToLinearRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function encodeChannels(linear) {
  return [
    Math.round(clamp01(linearToSrgb(linear[0])) * 255),
    Math.round(clamp01(linearToSrgb(linear[1])) * 255),
    Math.round(clamp01(linearToSrgb(linear[2])) * 255),
  ];
}

const GAMUT_EPSILON = 0.0001;

function inGamut(channels) {
  return channels.every((c) => c >= -GAMUT_EPSILON && c <= 1 + GAMUT_EPSILON);
}

function channelInGamut(c) {
  return c >= -GAMUT_EPSILON && c <= 1 + GAMUT_EPSILON;
}

// Scratch for the allocation-free conversion below. Safe as a module singleton
// because nothing here yields: it is filled and consumed inside one call.
const linearScratch = new Float64Array(3);

function oklabToLinearRgbInto(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return (
    channelInGamut(out[0]) && channelInGamut(out[1]) && channelInGamut(out[2])
  );
}

// Writes one solved ink colour straight into a byte buffer. This is the field's
// innermost call — see the note on oklabFromLinearInto for why it takes an
// offset instead of returning a triple.
export function oklabToRgbInto(L, a, b, out, offset) {
  const lightness = clamp01(L);
  if (!oklabToLinearRgbInto(lightness, a, b, linearScratch)) {
    // Only reachable near the lightness extremes; a near-neutral ink (which is
    // most of them) never gets here at all.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < FIELD_GAMUT_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (oklabToLinearRgbInto(lightness, a * mid, b * mid, linearScratch)) lo = mid;
      else hi = mid;
    }
    oklabToLinearRgbInto(lightness, a * lo, b * lo, linearScratch);
  }
  out[offset] = Math.round(clamp01(linearToSrgb(linearScratch[0])) * 255);
  out[offset + 1] = Math.round(clamp01(linearToSrgb(linearScratch[1])) * 255);
  out[offset + 2] = Math.round(clamp01(linearToSrgb(linearScratch[2])) * 255);
}

// Reduces chroma until the colour fits sRGB, which is what makes "constant
// perceptual lightness" true in practice: a vivid blue at L=0.8 does not exist
// in sRGB, and letting the channels clip lands on a different hue AND a
// different lightness — the exact flare that moving off HSL was meant to stop.
export function oklchToRgb(L, C, h) {
  const rad = (h * Math.PI) / 180;
  return oklabToRgbInGamut(clamp01(L), Math.max(0, C) * Math.cos(rad), Math.max(0, C) * Math.sin(rad), 20);
}

function oklabToRgbInGamut(lightness, a, b, steps) {
  let linear = oklabToLinearRgb(lightness, a, b);
  if (!inGamut(linear)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < steps; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinearRgb(lightness, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    linear = oklabToLinearRgb(lightness, a * lo, b * lo);
  }
  return encodeChannels(linear);
}

export function oklchToHex(L, C, h) {
  return rgbToHex(oklchToRgb(L, C, h));
}

// The per-tile field's conversion. Cartesian rather than polar because the
// field interpolates the tint between tiles, and a hue angle cannot be
// interpolated across the 360° seam without special-casing it — an (a, b)
// vector can, and the complement this effect is built on is just its negation.
//
// It keeps the gamut discipline on a shorter search. Skipping it and letting
// the channels clip was measured and rejected: at the lightness extremes —
// exactly where ink lands over a very dark or very bright picture — clipping
// moved channels by up to 14/255 and the hue by 27°. Keeping it is nearly free
// because the search runs on linear values, so the three pow()s are paid once
// at the end however many steps it takes. Eight of them bound the chroma error
// at 0.4%, which at INK_CHROMA_MAX is a rounding difference.
const FIELD_GAMUT_STEPS = 8;

export function oklabToRgbFast(L, a, b) {
  return oklabToRgbInGamut(clamp01(L), a, b, FIELD_GAMUT_STEPS);
}

export function oklchToRgbFast(L, C, h) {
  const rad = (h * Math.PI) / 180;
  return oklabToRgbFast(L, C * Math.cos(rad), C * Math.sin(rad));
}

// Perceptual distance, used as the repaint deadband: two colours closer than
// this are the same colour as far as a viewer is concerned.
export function oklabDistance(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return Infinity;
  const toLab = (rgb) => {
    const { L, C, h } = rgbToOklch(rgb);
    const rad = (h * Math.PI) / 180;
    return [L, C * Math.cos(rad), C * Math.sin(rad)];
  };
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

// --- contrast ---------------------------------------------------------------

export function relativeLuminance(rgb) {
  return (
    0.2126 * srgbToLinear(rgb[0]) +
    0.7152 * srgbToLinear(rgb[1]) +
    0.0722 * srgbToLinear(rgb[2])
  );
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Both numbers the ink solver needs about one background, sharing the single
// linearisation they are both built on — the per-tile field asks for this
// thousands of times per frame, and doing it twice would double the pow() bill
// for nothing. WCAG luminance decides how *far* the ink has to go; OKLab
// lightness decides which *side* it goes to (see BG_READS_LIGHT_ENTER).
export function backgroundMetrics(rgb) {
  const lr = linearFromChannel(rgb[0]);
  const lg = linearFromChannel(rgb[1]);
  const lb = linearFromChannel(rgb[2]);
  return {
    luminance: 0.2126 * lr + 0.7152 * lg + 0.0722 * lb,
    lightness: oklabFromLinear(lr, lg, lb).L,
  };
}

// The lightness a NEUTRAL ink needs to hit a given luminance. For an achromatic
// OKLab colour the three linear channels are all exactly L³ (the matrix rows
// sum to 1 by construction), so the whole bisection collapses to a cube root.
// The ink carries chroma up to INK_CHROMA_MAX, which moves its luminance by
// under 2% — a 7:1 target landing at 6.9:1, which is why the field can use this
// closed form where the single flat colour still bisects for the exact answer.
export function neutralLightnessForLuminance(luminance) {
  return Math.cbrt(luminance > 0 ? luminance : 0);
}

// The luminance an ink needs for `target` contrast against a background of
// `bgLuminance`, inverting the WCAG ratio directly. This is the closed form of
// what solveInkLightness bisects for: the ratio is monotonic in the ink's
// luminance, so there is exactly one answer, and a field of thousands of tiles
// cannot afford 24 conversions each to rediscover it. A negative result means
// the dark side cannot reach the target at all — the caller clamps.
export function luminanceForContrast(bgLuminance, side, target) {
  return side === "dark"
    ? (bgLuminance + 0.05) / target - 0.05
    : target * (bgLuminance + 0.05) - 0.05;
}

// What the browser does for rgba(top, alpha) painted over bottom.
export function compositeOver(top, bottom, alpha) {
  const a = clamp01(alpha);
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a));
}

// The 1/(1-alpha) amplification below runs away as the panel approaches opaque,
// so the alpha it uses is capped here. Past this point the glyph sits on the
// panel for all practical purposes and the scene barely enters the contrast
// maths, so a rough scene estimate costs nothing.
export const UNCOMPOSITE_ALPHA_MAX = 0.75;

// backdropd captures method DISPLAY — the finished screen, our own panel
// included — so the raw sample is the scene already darkened by our own tint,
// and feeding it straight back in has the shell voting on its own colour.
// Solving the composite for the bottom layer recovers the scene: checked against
// a paired VIDEO capture from the same instant, DISPLAY (44,38,52)
// un-composited at alpha 0.25 over panel (10,11,13) gives (55,47,65) where the
// video plane's own average was (54,44,62).
export function backdropBehindPanel(sample, panelRgb, panelAlpha) {
  const alpha = Math.min(clamp01(panelAlpha), UNCOMPOSITE_ALPHA_MAX);
  return [sample.r, sample.g, sample.b].map((channel, i) =>
    clampRange((channel - panelRgb[i] * alpha) / (1 - alpha), 0, 255),
  );
}

// --- the effect -------------------------------------------------------------

// Contrast is monotonic in lightness on either side of the background, so a
// bisection finds the boundary. Taking the *smallest* passing lightness on the
// light side is deliberate: ink ends up no brighter than it has to be, which on
// an OLED is the difference between legible and glaring.
function smallestPassingLightness(passes, min, max) {
  if (!passes(max)) return max;
  let lo = min;
  let hi = max;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function largestPassingLightness(passes, min, max) {
  if (!passes(min)) return min;
  let lo = min;
  let hi = max;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function solveInkLightness(
  chroma,
  hue,
  bg,
  side,
  target = INK_TARGET_CONTRAST,
) {
  const passes = (L) => contrastRatio(oklchToRgb(L, chroma, hue), bg) >= target;
  return side === "dark"
    ? largestPassingLightness(passes, INK_L_MIN, INK_L_MAX)
    : smallestPassingLightness(passes, INK_L_MIN, INK_L_MAX);
}

// `sample` is one smoothed backdrop reading ({r,g,b}, 0-255). `panelRgb` and
// `panelAlpha` describe the tint drawn between it and the text — without them
// there is no way to know what the glyph sits on, and the point of this rewrite
// is that the answer depends on it. `prevSide` carries the last chosen ink
// direction back in so the light/dark decision can hold its ground.
// `sceneIsRaw` marks a sample taken from the naked video plane (backdropd's
// vtcapture path): that reading has no panel composited into it, so dividing
// one out would invent a scene brighter than the real one. `reactive` is the
// active theme's profile (see the top of this section); omitting it gives the
// complement behaviour Chameleon has always had.
const shellDirScratch = new Float64Array(2);

export function adaptiveShellFor(baseShell, sample, options = {}) {
  const panelRgb = options.panelRgb || [10, 11, 13];
  const panelAlpha = Number.isFinite(options.panelAlpha) ? options.panelAlpha : 0.86;
  const scene = options.sceneIsRaw
    ? [sample.r, sample.g, sample.b]
    : backdropBehindPanel(sample, panelRgb, panelAlpha);
  const bg = compositeOver(panelRgb, scene, panelAlpha);

  const fp = flashParams(options.flash);
  const geo = reactiveGeometry(options.reactive);
  const { C: sceneChroma, h: sceneHue } = rgbToOklch(scene);
  // Back to Cartesian for the profile, then out to an angle again for the two
  // oklchToHex calls below. Polar is the right shape here — this is ONE colour
  // per frame, with nothing to interpolate it against — but the direction it
  // starts from has to be the same code the per-tile field runs, or the cursor
  // and the text under it would drift apart.
  const sceneRad = (sceneHue * Math.PI) / 180;
  const intensity = Math.sqrt(Math.min(1, sceneChroma / fp.chromaReference));
  reactiveTintInto(
    geo,
    sceneChroma * Math.cos(sceneRad),
    sceneChroma * Math.sin(sceneRad),
    sceneChroma,
    intensity,
    1,
    shellDirScratch,
    0,
  );
  const hue =
    ((Math.atan2(shellDirScratch[1], shellDirScratch[0]) * 180) / Math.PI + 360) % 360;
  const inkChroma = reactiveInkChroma(geo, fp.inkChromaMax, intensity);
  // The spark keeps its own floor (a cursor with no colour at all is the one
  // thing the very first version got right) and takes the theme's multiplier on
  // top. No ceiling: oklchToRgb gamut-maps whatever comes out, and a cursor is
  // two cells.
  const sparkChroma =
    (fp.sparkChromaMin + (fp.sparkChromaMax - fp.sparkChromaMin) * intensity) * geo.chroma;

  // Does the background read as light? That, not a contrast comparison, decides
  // which side the text sits on; the solver below only decides how far it goes.
  const bgLightness = rgbToOklch(bg).L;
  const wasDark = options.prevSide === "dark";
  const side =
    bgLightness >= (wasDark ? BG_READS_LIGHT_EXIT : BG_READS_LIGHT_ENTER)
      ? "dark"
      : "light";
  const onLight = side === "dark";

  const inkL = solveInkLightness(inkChroma, hue, bg, side);
  const foreground = oklchToHex(inkL, inkChroma, hue);
  const spark = oklchToHex(
    onLight ? SPARK_L_ON_LIGHT : SPARK_L_ON_DARK,
    sparkChroma,
    hue,
  );
  return {
    shell: Object.assign({}, baseShell, {
      foreground,
      cursor: spark,
      // The glyph inside a block cursor rides on spark, not on the panel.
      cursorAccent: oklchToHex(onLight ? 0.97 : 0.1, inkChroma, hue),
      selectionBackground: oklchToHex(
        onLight ? SELECTION_L_ON_LIGHT : SELECTION_L_ON_DARK,
        Math.min(SELECTION_CHROMA_MAX, sparkChroma * 0.5),
        hue,
      ),
    }),
    accent: spark,
    side,
    // Reported so the debug log can answer "why is the text this colour" —
    // otherwise unanswerable from a screenshot.
    contrast: contrastRatio(hexToRgb(foreground), bg),
  };
}
