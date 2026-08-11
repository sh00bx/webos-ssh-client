// Theme registry. Each theme drives three surfaces:
//   1. The login screen + window chrome, via `body[data-theme="<id>"]` CSS token
//      overrides in styles.css (palette, type roles, signature flourish).
//   2. The xterm shell, via the `shell` palette object below (xterm ITheme
//      subset) applied at terminal init and on live switch.
//   3. Its own variant of the reactive backdrop effect, via `reactive` below.
// The first entry is the default. `phosphor` mirrors the historical look so an
// un-themed install is visually unchanged.
//
// --- reactive profiles ------------------------------------------------------
// The effect that used to be Chameleon's alone now runs under EVERY theme (one
// toggle, next to the flash slider, turns it off). What stays shared is the
// part that decides whether text can be read: ink lightness is solved for a
// contrast target against the picture behind each glyph, and the veil, the
// hysteresis and the pacing are the same code for all five. What a profile
// picks is the COLOUR that reaction is expressed in — which is where a theme
// either keeps its identity or loses it.
//
// Chameleon's answer (complement the scene's own hue) is the reason it has no
// palette of its own to lose. Under Amber it would be wrong twice over: an
// amber terminal that turns blue over a blue-lit shot is not an amber terminal,
// and the login screen next to it never moves. So the other four name TWO poles
// out of their own palette and cross between them:
//
//   mode: "complement" — the ink hue is the scene's complement (Chameleon).
//   mode: "duotone"    — the hue crosses between two poles (`hue` -> `hue2`) as
//                        the scene turns from cool to warm, measured against
//                        `warmHue`. `swing` scales how far that crossing goes.
//
// Two rules keep a crossing on-theme. The poles STRADDLE the theme's signature
// hue, so a colourless picture renders the theme's own colour and the scene
// swings it to either side of that; and `hue` is the WARMER pole, which is the
// one a COLD scene gets. That second one is Chameleon's rule — ink opposes the
// picture — and it is why a sunset throws Bloom towards its cyan rather than
// deeper into its green. Synthwave is the deliberate exception to the first:
// its two lights ARE its identity, so it keeps the asymmetric pair it shipped
// with and rests on their midpoint (its own blue, 277°) instead of on 340°.
//
//   base   — chroma floor, as a fraction of the ceiling the flash slider sets.
//            The scene's own chroma drives the rest. Chameleon's is 0 (a grey
//            scene must give grey text there — forcing a hue on a hueless
//            sample is the fault its whole colour model was rewritten to fix);
//            a palette theme's is not, because its hue is not a guess and a
//            green terminal should stay green in front of a black screen.
//   chroma — per-theme multiplier on that ceiling, so Synthwave can be louder
//            than Blueprint at the same slider position. Ink is capped anyway
//            (INK_CHROMA_CEILING in color.mjs).
//
// --- why there is no "anchor" mode any more ---------------------------------
// Bloom, Ember and Cyanotype shipped as `anchor`: hold the theme's hue, lerp it
// `pull` (0.10-0.22) of the way towards the scene's complement. On the TV all
// three read as not reacting at all, and the arithmetic says why. The rotation
// such a lerp produces is SINE-shaped in the angle between the anchor and the
// target: it peaks when the complement sits 90° off the anchor and falls to
// ZERO both when the complement is parallel to the anchor and when it is
// antipodal. Warm and cold scenes — the axis footage actually moves along —
// land on those two zeros for a theme anchored in the warm half of the wheel.
// So the mode was not merely tuned too quietly; its response was near-blind on
// the one axis that matters and loudest on the scenes (magenta-lit ones) that
// hardly occur. Measured as the OKLab distance between the ink over a vivid
// warm scene and over a vivid cold one at flash 100 (tests/color.test.mjs
// asserts this per theme, so these numbers are checked rather than claimed):
//
//   before   cyanotype 0.008  ember 0.024  bloom 0.035  chameleon 0.136  neon 0.196
//   after    cyanotype 0.071  bloom 0.090  ember 0.099  chameleon 0.136  neon 0.196
//
// Ember's whole reaction across warm-to-cold was a fifth of one noticeable
// step, against Neon — the only theme already on `duotone` — moving 25x
// further. Widening `pull` would have raised the peak of a curve whose zeros
// are in the wrong places; `duotone` is driven BY the warm/cool axis, which is
// why it was the one that worked. The character order the entries below
// describe survives the change, at a third of the spread.
//
// Hues are OKLCh angles, taken from each theme's own cursor colour: phosphor
// #5fbf85 is 155°, amber #cf962e is 78°, blueprint #6f9fcf is 249°, synthwave
// #cf5cae is 340° with its cyan #5fadc0 at 215°.

// Each `shell` is a full xterm ITheme: full colour schemes (distinct hues),
// not a single-hue tint, so apps stay readable and varied. Tuned MUTED for
// OLED — desaturated, lower-luminance colours, near-black opaque backgrounds,
// soft-grey (not white) foregrounds, dimmed accents — so nothing glows and the
// large filled tmux status bar isn't harsh. A theme's identity comes from its
// background, cursor, selection and login design. Moods: Gruvbox-material for
// Amber, Nord for Blueprint, dimmed neon for Synthwave.
// Blueprint intentionally maps the ANSI green slot to steel blue: tmux's
// default status bar paints with SGR green (`status-style bg=green`), so this
// is the only client-side lever that turns the footer blue. Everything
// green-coded (git adds, PS1 success) shifts blue with it — coherent for a
// monochrome blueprint look.
export const THEMES = [
  {
    id: "phosphor",
    label: "Phosphor",
    // Bloom: a P1 tube whose glow drifts with the room in front of it. 35°
    // either side of the tube's own green, which lands the cold pole on the
    // palette's cyan (#62b0a3, 182°) and the warm one between its yellow (110°)
    // and its green. A phosphor that drifts off green is a different tube, so
    // this is the narrowest crossing that is still plainly a crossing.
    reactive: {
      label: "bloom",
      mode: "duotone",
      hue: 120,
      hue2: 190,
      warmHue: 60,
      swing: 1,
      base: 0.45,
    },
    shell: {
      background: "rgba(3, 4, 5, 0.96)",
      foreground: "#a4aca6",
      cursor: "#5fbf85",
      cursorAccent: "#030405",
      selectionBackground: "#18301f",
      black: "#0e1311",
      red: "#bf6a61",
      green: "#62b487",
      yellow: "#aaad6a",
      blue: "#6a9fb5",
      magenta: "#9b86b0",
      cyan: "#62b0a3",
      white: "#9ea69f",
      brightBlack: "#48514b",
      brightRed: "#cf7e74",
      brightGreen: "#79c79a",
      brightYellow: "#c0c07e",
      brightBlue: "#84b6c9",
      brightMagenta: "#ad9cc4",
      brightCyan: "#7fc7ba",
      brightWhite: "#bac1bb",
    },
  },
  {
    id: "amber",
    label: "Amber CRT",
    // Ember: amber is the one signature the scene can push somewhere
    // interesting without leaving the theme — a warm ember over a cold shot,
    // a greener gold over a hot one. 35° either side of the tube's amber,
    // reaching towards the palette's red (27°) and its green (117°) without
    // arriving at either; the loudest of the three single-signature themes,
    // with a little extra chroma to sell it.
    reactive: {
      label: "ember",
      mode: "duotone",
      hue: 43,
      hue2: 113,
      warmHue: 60,
      swing: 1,
      base: 0.5,
      chroma: 1.1,
    },
    shell: {
      background: "rgba(8, 5, 2, 0.96)",
      foreground: "#beae8e",
      cursor: "#cf962e",
      cursorAccent: "#080502",
      selectionBackground: "#3a2a12",
      black: "#322a1e",
      red: "#c46259",
      green: "#94a05a",
      yellow: "#c19a52",
      blue: "#779a90",
      magenta: "#bb7f90",
      cyan: "#84a276",
      white: "#beae8e",
      brightBlack: "#6b5a3e",
      brightRed: "#d4756a",
      brightGreen: "#a7b36e",
      brightYellow: "#d4ab5c",
      brightBlue: "#8fb0a6",
      brightMagenta: "#cf95a6",
      brightCyan: "#98b88a",
      brightWhite: "#d2c4a2",
    },
  },
  {
    id: "blueprint",
    label: "Blueprint",
    // Cyanotype: a print, not a light source, so it stays the quietest of the
    // five — the narrowest crossing (32° either side of the print's blue) and
    // the only chroma multiplier below 1. Its cold pole is the palette's own
    // cyan (#79a8b5, 217°); the warm one is an indigo just past its blue, which
    // is where a Prussian-blue print goes in the deep tones anyway. Note the
    // poles read backwards from the other three: past 240° the wheel has turned
    // far enough that the HIGHER angle is the warmer one.
    reactive: {
      label: "cyanotype",
      mode: "duotone",
      hue: 281,
      hue2: 217,
      warmHue: 60,
      swing: 1,
      base: 0.5,
      chroma: 0.85,
    },
    shell: {
      background: "rgba(3, 10, 18, 0.96)",
      foreground: "#b1bcc9",
      cursor: "#6f9fcf",
      cursorAccent: "#030a12",
      selectionBackground: "#123250",
      black: "#28323f",
      red: "#b06b72",
      green: "#5d82b0",
      yellow: "#cab47e",
      blue: "#7790ad",
      magenta: "#a3849d",
      cyan: "#79a8b5",
      white: "#b1bcc9",
      brightBlack: "#46546a",
      brightRed: "#c08087",
      brightGreen: "#7ba0cc",
      brightYellow: "#d6c190",
      brightBlue: "#8fa6c4",
      brightMagenta: "#b89cb2",
      brightCyan: "#92bdca",
      brightWhite: "#c8d1dd",
    },
  },
  {
    id: "synthwave",
    label: "Synthwave",
    // Neon: the loud one, and the theme the other three were rebuilt to imitate
    // — its poles are 125° apart against their 64-70°, and it is the widest
    // crossing that stays on-palette because BOTH of its lights are signature
    // colours rather than one signature and two neighbours. A warm shot throws
    // the shell cyan and a cold one throws it magenta, driven by the picture
    // instead of by a gradient.
    reactive: {
      label: "neon",
      mode: "duotone",
      hue: 340,
      hue2: 215,
      warmHue: 60,
      swing: 1,
      base: 0.45,
      chroma: 1.25,
    },
    shell: {
      background: "rgba(5, 2, 14, 0.96)",
      foreground: "#bcadd2",
      cursor: "#cf5cae",
      cursorAccent: "#05020e",
      selectionBackground: "#2c1542",
      black: "#241b33",
      red: "#cf5f6a",
      green: "#6cbf9a",
      yellow: "#ceba74",
      blue: "#7878c4",
      magenta: "#c46fa8",
      cyan: "#5fadc0",
      white: "#b4a5cb",
      brightBlack: "#544870",
      brightRed: "#d97f87",
      brightGreen: "#85cdaf",
      brightYellow: "#dccb8c",
      brightBlue: "#9389d0",
      brightMagenta: "#d490bd",
      brightCyan: "#7fc4d4",
      brightWhite: "#d3c8e4",
    },
  },
  {
    // The theme that has no colour of its own: it takes the complement of
    // whatever is behind the window (backdrop/watch feed, sampled by the
    // root-side backdropd daemon) and wears that. The other four react in
    // their own palette; this one reacts in the picture's.
    //
    // The palette below is (a) the static fallback when the feed is
    // unavailable or the effect is switched off and (b) the base every
    // reactive override is applied on top of. Its ANSI colours are
    // deliberately stone-muted: the reactive foreground is meant to be the
    // only loud colour on screen.
    id: "chameleon",
    label: "Chameleon",
    reactive: { label: "chameleon", mode: "complement", base: 0 },
    shell: {
      background: "rgba(4, 5, 6, 0.96)",
      foreground: "#c6ccce",
      cursor: "#c6ccce",
      cursorAccent: "#040506",
      selectionBackground: "#262c30",
      black: "#101314",
      red: "#b56f68",
      green: "#7fae8d",
      yellow: "#b0a878",
      blue: "#7899ad",
      magenta: "#9c8bab",
      cyan: "#7fada6",
      white: "#a8aeb0",
      brightBlack: "#4a5257",
      brightRed: "#c58079",
      brightGreen: "#93bfa0",
      brightYellow: "#c2ba8c",
      brightBlue: "#8dabbe",
      brightMagenta: "#ad9dbc",
      brightCyan: "#93bfb8",
      brightWhite: "#c2c8ca",
    },
  },
];

const STORAGE_KEY = "ssh-client.theme";
const DEFAULT_ID = THEMES[0].id;

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

export function loadThemeId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && THEMES.some((theme) => theme.id === raw)) return raw;
  } catch (e) {
    /* storage disabled */
  }
  return DEFAULT_ID;
}

export function saveThemeId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch (e) {
    /* ignore quota / disabled storage */
  }
}

export function nextThemeId(id) {
  const index = THEMES.findIndex((theme) => theme.id === id);
  const next = index < 0 ? 0 : (index + 1) % THEMES.length;
  return THEMES[next].id;
}
