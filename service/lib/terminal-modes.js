// Terminal private modes that have to survive a re-attach.
//
// The replay buffer is a byte-capped ring (OUTPUT_BUFFER_LIMIT), so a client
// that reloads hours into a session gets the tail of the output and nothing
// else. Content is all that costs — but a terminal's *modes* are set once, by
// a sequence that scrolled out of the ring long ago. tmux enables mouse
// reporting when it first attaches and never repeats it unless something makes
// it redraw, so a fresh xterm comes up with mouse tracking off while tmux still
// believes the client reports clicks: keyboard works, every click is dropped,
// and only a resize (SIGWINCH → tmux re-emits its modes) brings them back.
// That was the "tmux tab clicks are dead" report of 2026-08-12.
//
// So we watch the output stream for DECSET/DECRST of the modes that decide how
// *input* is encoded, and hand the surviving state to the next attach.
//
// Deliberately NOT tracked:
//   - 1049/47/1047 (alternate screen). Restoring those would swap the buffer
//     the replay was just written into and blank the screen.
//   - 7 (DECAWM), 25 (cursor visibility) and friends: they change how the
//     replayed content would be *rendered*, but it is already rendered — the
//     ring holds the output as the remote drew it.
// Everything here defaults to off in a fresh terminal, which is what makes
// "emit the ones that are on" a complete restore rather than half of one.
const TRACKED_MODES = new Set([
  1, // DECCKM — cursor keys send SS3 instead of CSI
  9, // X10 mouse
  1000, // VT200 mouse (press/release)
  1001, // highlight mouse tracking
  1002, // button-event tracking (drag)
  1003, // any-event tracking (motion)
  1004, // focus in/out reporting
  1005, // UTF-8 mouse coordinates
  1006, // SGR mouse coordinates
  1015, // urxvt mouse coordinates
  1016, // SGR-pixel mouse coordinates
  2004, // bracketed paste
]);

// A private-mode set/reset: ESC [ ? <params> h|l. The final byte is matched as
// any letter so that a non-mode sequence sharing the prefix (a DECRQM query,
// ESC [ ? 1000 $ p) fails the match instead of being read as a mode change.
const MODE_SEQUENCE = /\x1b\[\?([0-9;]*)([a-zA-Z])/g;
// The tail of a chunk that could still grow into a MODE_SEQUENCE. A 1 MiB
// stream arrives in arbitrary pieces and an escape sequence is not guaranteed
// to be whole in any of them.
const PARTIAL_SEQUENCE = /\x1b(?:\[(?:\?[0-9;]*)?)?$/;
// Caps what an unterminated sequence can pin in memory. Real ones are far
// shorter; a stream that keeps emitting digits after ESC [ ? is malformed, and
// dropping it costs at most one mode restore.
const MAX_CARRY = 64;

function createModeTracker() {
  return { modes: new Map(), carry: "" };
}

// Feeds one chunk of terminal output through the tracker. Order matters and
// duplicates are normal: a mode set twice is just set, a mode set then reset is
// off, and the last write in the stream wins.
function trackTerminalModes(tracker, text) {
  if (!tracker || typeof text !== "string" || !text) return tracker;
  const buffer = tracker.carry + text;
  let scanned = 0;
  let match;
  MODE_SEQUENCE.lastIndex = 0;
  while ((match = MODE_SEQUENCE.exec(buffer)) !== null) {
    scanned = match.index + match[0].length;
    const final = match[2];
    if (final !== "h" && final !== "l") continue;
    const enabled = final === "h";
    // One sequence can carry several modes: ESC [ ? 1000;1002;1006 h.
    for (const part of match[1].split(";")) {
      if (!part) continue;
      const mode = Number(part);
      if (TRACKED_MODES.has(mode)) tracker.modes.set(mode, enabled);
    }
  }
  const tail = buffer.slice(Math.max(scanned, buffer.length - MAX_CARRY));
  const partial = tail.match(PARTIAL_SEQUENCE);
  tracker.carry = partial ? partial[0] : "";
  return tracker;
}

// The modes currently on, as the sequence that turns them on again. Ascending
// numeric order so the output is stable and diffable.
function terminalModeSequence(tracker) {
  if (!tracker || !tracker.modes || !tracker.modes.size) return "";
  const enabled = [];
  for (const [mode, on] of tracker.modes) {
    if (on) enabled.push(mode);
  }
  enabled.sort((a, b) => a - b);
  return enabled.map((mode) => `\x1b[?${mode}h`).join("");
}

// Diagnostics: which modes a session would restore, as plain numbers. A silent
// no-op restore is otherwise indistinguishable from a tracker that never ran.
function enabledTerminalModes(tracker) {
  if (!tracker || !tracker.modes) return [];
  const enabled = [];
  for (const [mode, on] of tracker.modes) {
    if (on) enabled.push(mode);
  }
  return enabled.sort((a, b) => a - b);
}

module.exports = {
  TRACKED_MODES,
  createModeTracker,
  trackTerminalModes,
  terminalModeSequence,
  enabledTerminalModes,
};
