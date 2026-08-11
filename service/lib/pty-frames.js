// The JS half of the ptyd wire protocol. The C half is tv-root/ptyd.c — the
// frame table is duplicated in that file's header comment, and the two must be
// changed together.
//
//     [type:1][length:4 big-endian][payload:length]
//
// Length-prefixed rather than line-based (which is what backdropd uses on its
// own socket) because this carries raw terminal bytes in both directions:
// there is no byte value a shell cannot emit, so no delimiter is safe, and an
// escape scheme would cost a scan over every byte of output.

const PTY_FRAME = {
  DATA: 0x01,
  RESIZE: 0x02,
  EXIT: 0x03,
  HELLO: 0x04,
  READY: 0x05,
};

const HEADER_BYTES = 5;
// Must match MAX_PAYLOAD in ptyd.c. A frame claiming more than this is a
// desynchronised or hostile peer, not a keystroke — the decoder throws and the
// caller drops the connection rather than trying to buffer it.
const MAX_PAYLOAD = 64 * 1024;

function encodeFrame(type, payload) {
  const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame[0] = type & 0xff;
  frame.writeUInt32BE(body.length, 1);
  if (body.length) body.copy(frame, HEADER_BYTES);
  return frame;
}

// cols/rows are clamped to what a u16 can carry AND to something a terminal
// could plausibly be: ptyd hands these straight to TIOCSWINSZ, and a bogus
// size there is a real (if harmless-looking) way to wedge a shell's line
// editor.
function encodeWindow(type, cols, rows) {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16BE(clampDimension(cols, 80), 0);
  payload.writeUInt16BE(clampDimension(rows, 24), 2);
  return encodeFrame(type, payload);
}

function clampDimension(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(65535, Math.max(1, Math.round(num)));
}

function encodeHello(cols, rows) {
  return encodeWindow(PTY_FRAME.HELLO, cols, rows);
}

function encodeResize(cols, rows) {
  return encodeWindow(PTY_FRAME.RESIZE, cols, rows);
}

function encodeData(data) {
  return encodeFrame(PTY_FRAME.DATA, Buffer.from(data, "utf8"));
}

// Incremental decoder: feed it whatever the socket delivered, get back the
// frames that are complete. Partial frames stay buffered — a TCP-like stream
// splits wherever it likes, and a terminal repaint is routinely larger than
// one read.
function createFrameDecoder() {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const frames = [];
      let offset = 0;
      for (;;) {
        if (pending.length - offset < HEADER_BYTES) break;
        const type = pending[offset];
        const length = pending.readUInt32BE(offset + 1);
        if (length > MAX_PAYLOAD) {
          // Do not try to resynchronise: once the length field is wrong, every
          // byte after it is of unknown meaning.
          const error = new Error(`ptyd frame too large: ${length}`);
          error.code = "PTY_FRAME_OVERSIZE";
          throw error;
        }
        if (pending.length - offset < HEADER_BYTES + length) break;
        frames.push({
          type,
          payload: pending.subarray(
            offset + HEADER_BYTES,
            offset + HEADER_BYTES + length,
          ),
        });
        offset += HEADER_BYTES + length;
      }
      // One slice per push rather than one per frame: subarray shares memory,
      // so the frames handed out above stay valid.
      pending = offset ? pending.subarray(offset) : pending;
      return frames;
    },
  };
}

// READY payload: version u8, child pid u32be. A short payload means a daemon
// older than this client — report what is there rather than throwing, since
// the session itself is perfectly usable either way.
function parseReady(payload) {
  if (!payload || !payload.length) return { version: 0, pid: null };
  return {
    version: payload[0],
    pid: payload.length >= 5 ? payload.readUInt32BE(1) : null,
  };
}

module.exports = {
  PTY_FRAME,
  HEADER_BYTES,
  MAX_PAYLOAD,
  encodeFrame,
  encodeHello,
  encodeResize,
  encodeData,
  createFrameDecoder,
  parseReady,
  clampDimension,
};
