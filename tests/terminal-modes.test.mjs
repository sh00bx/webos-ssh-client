// Tests for the private-mode tracker (service/lib/terminal-modes.js) that
// keeps mouse reporting alive across a re-attach. The bug it exists for is
// invisible in content: the replay looks perfect and every click is dropped,
// because the sequence that switched mouse reporting on scrolled out of the
// ring buffer hours ago.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createModeTracker,
  trackTerminalModes,
  terminalModeSequence,
  enabledTerminalModes,
} = require("../service/lib/terminal-modes.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}: ${(e && e.message) || e}`);
  }
}

// Feeds a stream in the given pieces, which is how a socket delivers it.
function track(...chunks) {
  const tracker = createModeTracker();
  for (const chunk of chunks) trackTerminalModes(tracker, chunk);
  return tracker;
}

check("a fresh session restores nothing", () => {
  assert.equal(terminalModeSequence(createModeTracker()), "");
  assert.deepEqual(enabledTerminalModes(createModeTracker()), []);
});

check("what tmux enables on attach comes back", () => {
  const tracker = track("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  assert.equal(terminalModeSequence(tracker), "\x1b[?1000h\x1b[?1002h\x1b[?1006h");
});

check("modes are restored in ascending order regardless of arrival order", () => {
  const tracker = track("\x1b[?2004h", "\x1b[?1006h", "\x1b[?1h");
  assert.deepEqual(enabledTerminalModes(tracker), [1, 1006, 2004]);
  assert.equal(terminalModeSequence(tracker), "\x1b[?1h\x1b[?1006h\x1b[?2004h");
});

check("one sequence can carry several modes", () => {
  const tracker = track("\x1b[?1000;1002;1006h");
  assert.deepEqual(enabledTerminalModes(tracker), [1000, 1002, 1006]);
});

check("a mode turned off again is not restored", () => {
  // vim enables mouse reporting and puts it back on exit.
  const tracker = track("\x1b[?1000h", "some output", "\x1b[?1000l");
  assert.equal(terminalModeSequence(tracker), "");
});

check("the last write in the stream wins", () => {
  const tracker = track("\x1b[?1006l\x1b[?1006h\x1b[?1006l\x1b[?1006h");
  assert.deepEqual(enabledTerminalModes(tracker), [1006]);
});

check("a sequence split across chunks is still seen", () => {
  // The socket splits wherever it likes; every split point has to work.
  const whole = "\x1b[?1000h";
  for (let cut = 1; cut < whole.length; cut++) {
    const tracker = track(whole.slice(0, cut), whole.slice(cut));
    assert.deepEqual(
      enabledTerminalModes(tracker),
      [1000],
      `split after ${cut} byte(s) lost the sequence`,
    );
  }
});

check("a sequence split into single bytes is still seen", () => {
  const tracker = track(...[..."\x1b[?1002;1006h"]);
  assert.deepEqual(enabledTerminalModes(tracker), [1002, 1006]);
});

check("the alternate screen is never restored", () => {
  // Restoring 1049 would swap away the buffer the replay was written into.
  const tracker = track("\x1b[?1049h\x1b[?47h\x1b[?1047h");
  assert.equal(terminalModeSequence(tracker), "");
});

check("rendering modes are left alone", () => {
  // Cursor visibility and autowrap describe content that is already drawn.
  const tracker = track("\x1b[?25l\x1b[?7l\x1b[?12h");
  assert.equal(terminalModeSequence(tracker), "");
});

check("a mode query is not a mode change", () => {
  // DECRQM shares the ESC [ ? prefix but ends in $p, not h/l.
  const tracker = track("\x1b[?1006$p");
  assert.equal(terminalModeSequence(tracker), "");
});

check("ordinary CSI and plain text are ignored", () => {
  const tracker = track("\x1b[1;5H\x1b[32mgreen\x1b[0m\r\nhi ?1000h there\r\n");
  assert.equal(terminalModeSequence(tracker), "");
});

check("a mode sequence surrounded by output is found", () => {
  const tracker = track("prompt$ tmux\r\n\x1b[?1000h\x1b[?1006hwindow content\r\n");
  assert.deepEqual(enabledTerminalModes(tracker), [1000, 1006]);
});

check("an unterminated sequence cannot grow without bound", () => {
  const tracker = createModeTracker();
  for (let i = 0; i < 200; i++) trackTerminalModes(tracker, "\x1b[?123456789;");
  assert.ok(tracker.carry.length <= 64, `carry grew to ${tracker.carry.length}`);
  // ...and the tracker still works afterwards.
  trackTerminalModes(tracker, "\x1b[?1006h");
  assert.deepEqual(enabledTerminalModes(tracker), [1006]);
});

check("non-string input is ignored rather than throwing", () => {
  const tracker = createModeTracker();
  trackTerminalModes(tracker, undefined);
  trackTerminalModes(tracker, null);
  trackTerminalModes(tracker, "");
  assert.equal(terminalModeSequence(tracker), "");
});

check("a missing tracker degrades to no restore", () => {
  // Sessions created before this existed have no tracker at all.
  assert.equal(terminalModeSequence(undefined), "");
  assert.deepEqual(enabledTerminalModes(undefined), []);
});

if (failures) {
  console.error(`${failures} terminal-modes test(s) failed`);
  process.exit(1);
}
console.log("terminal-modes tests passed");
