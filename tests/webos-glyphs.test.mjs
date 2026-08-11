import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, "src");

// Codepoints the webOS 25 font stack on the LG G4 has no glyph for. Every one
// of these shipped at some point and rendered as the .notdef box:
//
//   U+21B5  "↵"  search hint, twice, since the search bar existed
//   U+21BB  "↻"  the key picker's affordance on the login form
//   U+25AE  "▮"  the "back to the shell" marker on a files tab, 0.6.0-0.6.1
//
// Derived by rendering each candidate to a canvas ON THE DEVICE and comparing
// the pixels against an unassigned codepoint. Measuring text WIDTH — the usual
// trick — cannot work here: the UI face is monospace, so the .notdef box has
// exactly the same advance as a real glyph and every character looks present.
//
// Adding to this list is how a future firmware's gaps get recorded. Removing
// from it requires re-running that probe, not an opinion.
const NO_GLYPH = [0x21b5, 0x21bb, 0x25ae];

// The reason this is a source scan and not a render check: a unit test has no
// TV. What it CAN guarantee is that a symbol already known to be broken there
// never comes back — including in a comment, so that this file's own notation
// (U+25AE, never the character) is the only way to talk about them.
const files = fs
  .readdirSync(srcDir)
  .filter((f) => /\.(js|mjs|css)$/.test(f))
  .map((f) => path.join(srcDir, f));

assert.ok(files.length > 10, "the scan must actually be looking at the UI sources");

const offenders = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (NO_GLYPH.includes(cp)) {
        offenders.push(
          `${path.relative(root, file)}:${i + 1} uses U+${cp
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")}`,
        );
      }
    }
  }
}

assert.deepStrictEqual(
  offenders,
  [],
  `these codepoints render as an empty box on the TV:\n  ${offenders.join("\n  ")}`,
);

// The scan is only worth anything if it can fire. Prove it against a string
// containing the exact character it is meant to catch, built from its codepoint
// so this file stays free of the literal.
{
  const planted = `swap.textContent = "${String.fromCodePoint(0x25ae)}";`;
  const hits = [...planted].filter((ch) => NO_GLYPH.includes(ch.codePointAt(0)));
  assert.strictEqual(hits.length, 1, "the detector must catch a planted U+25AE");
}

// The replacements have to stay replacements. Nothing forces the tab controls
// to be SVG except this: a text glyph is one firmware away from being a box,
// and these two are the only controls on a tab.
const tabSource = fs.readFileSync(path.join(srcDir, "terminal-window.js"), "utf8");
for (const cls of ["term-tab-swap", "term-tab-x"]) {
  const block = tabSource.slice(tabSource.indexOf(`className = "${cls}"`));
  assert.match(
    block.slice(0, 400),
    /appendChild\(svgIcon\(/,
    `.${cls} must carry a drawn icon, not a character`,
  );
}

console.log("webos-glyph tests passed");
