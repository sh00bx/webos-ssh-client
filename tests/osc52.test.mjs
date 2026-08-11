import assert from "assert";
import {
  clipboardTextFromOsc52,
  OSC52_MAX_BASE64_LENGTH,
} from "../src/osc52.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// The common shapes emitted by tmux/vim: "c;<data>", "p;<data>", empty selection.
assert.strictEqual(clipboardTextFromOsc52(`c;${b64("hello")}`), "hello");
assert.strictEqual(clipboardTextFromOsc52(`p;${b64("x")}`), "x");
assert.strictEqual(clipboardTextFromOsc52(`;${b64("no selection field")}`), "no selection field");

// UTF-8 survives the base64 round trip (multibyte + emoji).
assert.strictEqual(clipboardTextFromOsc52(`c;${b64("grün — 東京 🚀")}`), "grün — 東京 🚀");

// Newlines/tabs in copied text are preserved.
assert.strictEqual(clipboardTextFromOsc52(`c;${b64("a\nb\tc")}`), "a\nb\tc");

// Queries must be ignored — answering would leak the local clipboard.
assert.strictEqual(clipboardTextFromOsc52("c;?"), null);

// Clear (empty data) does nothing.
assert.strictEqual(clipboardTextFromOsc52("c;"), null);

// Malformed input never throws, always null.
assert.strictEqual(clipboardTextFromOsc52("no-separator"), null);
assert.strictEqual(clipboardTextFromOsc52("c;!!!not-base64!!!"), null);
assert.strictEqual(clipboardTextFromOsc52(null), null);
assert.strictEqual(clipboardTextFromOsc52(undefined), null);
assert.strictEqual(clipboardTextFromOsc52(123), null);

// Size cap: at the limit passes, over the limit is dropped.
const atLimit = "A".repeat(OSC52_MAX_BASE64_LENGTH);
assert.notStrictEqual(clipboardTextFromOsc52(`c;${atLimit}`), null);
assert.strictEqual(clipboardTextFromOsc52(`c;${atLimit}AAAA`), null);
assert.strictEqual(
  clipboardTextFromOsc52(`c;${b64("abc")}`, { maxBase64Length: 2 }),
  null,
);

console.log("osc52 tests passed");
