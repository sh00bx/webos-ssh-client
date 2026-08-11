import assert from "node:assert";
import {
  CELL_ALPHA_FLOOR,
  CELL_ALPHA_VAR,
  INVERTED_DEFAULT_COLOR,
  buildCellBackgroundCss,
  cellAlphaFor,
  cellBackgroundStyle,
  indexedAnsiRgb,
  parseColorToRgb,
  rgbaWithAlphaVar,
} from "../src/cell-bg.mjs";

// --- parseColorToRgb: every colour form an xterm ITheme may carry.
assert.deepStrictEqual(parseColorToRgb("#62b487"), [98, 180, 135]);
assert.deepStrictEqual(parseColorToRgb("62b487"), null, "a bare hex is not a colour");
assert.deepStrictEqual(parseColorToRgb("#abc"), [170, 187, 204]);
// Alpha the theme carried is dropped: it is the slider's job now.
assert.deepStrictEqual(parseColorToRgb("#62b48780"), [98, 180, 135]);
assert.deepStrictEqual(parseColorToRgb("rgba(3, 4, 5, 0.96)"), [3, 4, 5]);
assert.deepStrictEqual(parseColorToRgb("rgb(3,4,5)"), [3, 4, 5]);
assert.deepStrictEqual(parseColorToRgb("rgb(0% 50% 100%)"), [0, 128, 255]);
assert.deepStrictEqual(parseColorToRgb("rgb(300, -20, 5)"), [255, 0, 5], "channels clamp");
assert.strictEqual(parseColorToRgb("red"), null, "named colours are not handled");
assert.strictEqual(parseColorToRgb(""), null);
assert.strictEqual(parseColorToRgb(null), null);
assert.strictEqual(parseColorToRgb(undefined), null);

// --- indexedAnsiRgb: must reproduce xterm's own DEFAULT_ANSI_COLORS tail
// exactly, or a rule would recolour the cell instead of re-alphaing it.
assert.strictEqual(indexedAnsiRgb(15), null, "slots 0-15 come from the theme");
assert.deepStrictEqual(indexedAnsiRgb(16), [0, 0, 0], "cube starts at black");
assert.deepStrictEqual(indexedAnsiRgb(231), [255, 255, 255], "cube ends at white");
assert.deepStrictEqual(indexedAnsiRgb(21), [0, 0, 255]);
assert.deepStrictEqual(indexedAnsiRgb(196), [255, 0, 0]);
assert.deepStrictEqual(indexedAnsiRgb(232), [8, 8, 8], "grey ramp start");
assert.deepStrictEqual(indexedAnsiRgb(255), [238, 238, 238], "grey ramp end");
assert.strictEqual(indexedAnsiRgb(256), null);

assert.strictEqual(
  rgbaWithAlphaVar([1, 2, 3]),
  "rgba(1, 2, 3, var(--term-cell-alpha))",
);
assert.strictEqual(CELL_ALPHA_VAR, "--term-cell-alpha");

// --- cellBackgroundStyle: the 24-bit inline-style path. Backgrounds get the
// variable, foregrounds and everything else pass through byte-identical.
assert.strictEqual(
  cellBackgroundStyle("background-color:#62b487"),
  "background-color:rgba(98, 180, 135, var(--term-cell-alpha))",
);
assert.strictEqual(
  cellBackgroundStyle("background-color:#62b487;"),
  "background-color:rgba(98, 180, 135, var(--term-cell-alpha))",
);
assert.strictEqual(
  cellBackgroundStyle("  background-color : #62b487 "),
  "background-color:rgba(98, 180, 135, var(--term-cell-alpha))",
);
// 24-bit *text* is exactly what must not fade — same shape, must not match.
assert.strictEqual(cellBackgroundStyle("color:#62b487"), "color:#62b487");
assert.strictEqual(
  cellBackgroundStyle("background-color:transparent"),
  "background-color:transparent",
  "unparseable colours keep xterm's own value",
);
assert.strictEqual(cellBackgroundStyle("letter-spacing:0.5px"), "letter-spacing:0.5px");
assert.strictEqual(cellBackgroundStyle("no-colon"), "no-colon");
assert.strictEqual(cellBackgroundStyle(""), "");
assert.strictEqual(cellBackgroundStyle(null), null, "non-strings survive unchanged");

// --- buildCellBackgroundCss.
const css = buildCellBackgroundCss({
  foreground: "#a4aca6",
  green: "#62b487",
  black: "#0e1311",
});
const lines = css.split("\n");
assert.strictEqual(lines.length, 257, "256 palette slots + the inverse default");
assert.ok(
  css.includes(
    ".term-wrapper .xterm-bg-2{background-color:rgba(98, 180, 135, var(--term-cell-alpha))!important}",
  ),
  "the theme's ANSI green (tmux's status bar) is re-alphaed",
);
assert.ok(
  css.includes(
    `.term-wrapper .xterm-bg-${INVERTED_DEFAULT_COLOR}{background-color:rgba(164, 172, 166, var(--term-cell-alpha))!important}`,
  ),
  "reverse video paints in the theme foreground",
);
// Slots the theme leaves unset fall back to xterm's own defaults, unchanged in
// hue: #cc0000 is DEFAULT_ANSI_COLORS[1].
assert.ok(css.includes(".xterm-bg-1{background-color:rgba(204, 0, 0, var(--term-cell-alpha))!important}"));
assert.ok(css.includes(".xterm-bg-231{background-color:rgba(255, 255, 255, var(--term-cell-alpha))!important}"));
// Every rule must be !important: xterm re-injects its own .xterm-bg-* rules on
// each theme change, and the selection path writes inline styles.
assert.ok(lines.every((line) => line.endsWith("!important}")));
assert.ok(lines.every((line) => line.startsWith(".term-wrapper .xterm-bg-")));
assert.strictEqual(
  buildCellBackgroundCss({ green: "#62b487" }, { scope: "#x", varName: "--a" }).split("\n")[2],
  "#x .xterm-bg-2{background-color:rgba(98, 180, 135, var(--a))!important}",
);
// A palette-less call still yields the full default sheet rather than throwing.
assert.strictEqual(buildCellBackgroundCss(null).split("\n").length, 257);

// --- cellAlphaFor: tracks the panel 1:1 above the floor, solid at 100%.
assert.strictEqual(cellAlphaFor(100), 1);
assert.strictEqual(cellAlphaFor(86), 0.86);
assert.strictEqual(cellAlphaFor(50), 0.5);
assert.strictEqual(cellAlphaFor(20), CELL_ALPHA_FLOOR, "the floor keeps bands readable");
assert.strictEqual(cellAlphaFor(0), CELL_ALPHA_FLOOR, "floored below the slider minimum");
assert.strictEqual(cellAlphaFor(140), 1, "never over-alpha");
assert.strictEqual(cellAlphaFor("nonsense"), 1, "lost state stays fully solid");
assert.strictEqual(cellAlphaFor(undefined), 1);
for (let p = 20; p <= 100; p += 5) {
  assert.ok(cellAlphaFor(p) >= cellAlphaFor(p - 5), "monotonic across the slider");
}

console.log("cell-bg tests passed");
