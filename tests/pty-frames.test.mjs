// Wire-format tests for the ptyd protocol (service/lib/pty-frames.js). The C
// side is tv-root/ptyd.c; tests/ptyd-e2e.manual.mjs drives the two against
// each other with a real shell, which is the only place the two encodings are
// checked to actually agree. What is covered here is the JS side alone: the
// byte layout, and the stream reassembly that a terminal makes unavoidable.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
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
} = require("../service/lib/pty-frames.js");

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

check("header is type + big-endian length", () => {
  const frame = encodeFrame(PTY_FRAME.DATA, Buffer.from("hi"));
  assert.equal(frame.length, HEADER_BYTES + 2);
  assert.equal(frame[0], 0x01);
  assert.equal(frame.readUInt32BE(1), 2);
  assert.equal(frame.subarray(HEADER_BYTES).toString(), "hi");
});

check("hello and resize carry cols then rows", () => {
  const hello = encodeHello(120, 40);
  assert.equal(hello[0], PTY_FRAME.HELLO);
  assert.equal(hello.readUInt16BE(HEADER_BYTES), 120);
  assert.equal(hello.readUInt16BE(HEADER_BYTES + 2), 40);
  const resize = encodeResize(120, 40);
  assert.equal(resize[0], PTY_FRAME.RESIZE);
  assert.deepEqual(resize.subarray(HEADER_BYTES), hello.subarray(HEADER_BYTES));
});

check("dimensions are clamped into what TIOCSWINSZ can take", () => {
  assert.equal(clampDimension(0, 80), 1);
  assert.equal(clampDimension(-5, 80), 1);
  assert.equal(clampDimension(99999, 80), 65535);
  assert.equal(clampDimension(NaN, 80), 80);
  assert.equal(clampDimension("120", 80), 120);
  // A zero row count would leave the shell's line editor with no screen to
  // draw on — the reason this clamp exists at all.
  const frame = encodeResize(0, 0);
  assert.equal(frame.readUInt16BE(HEADER_BYTES), 1);
  assert.equal(frame.readUInt16BE(HEADER_BYTES + 2), 1);
});

check("utf-8 payloads are byte-counted, not character-counted", () => {
  const frame = encodeData("äöü");
  assert.equal(frame.readUInt32BE(1), 6);
  assert.equal(frame.subarray(HEADER_BYTES).toString("utf8"), "äöü");
});

check("decoder reassembles a frame split across reads", () => {
  const decoder = createFrameDecoder();
  const frame = encodeData("hello world");
  // The worst realistic split: mid-header, so even the length is incomplete.
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3, 8)), []);
  const done = decoder.push(frame.subarray(8));
  assert.equal(done.length, 1);
  assert.equal(done[0].type, PTY_FRAME.DATA);
  assert.equal(done[0].payload.toString(), "hello world");
});

check("decoder returns every complete frame in one read", () => {
  const decoder = createFrameDecoder();
  const chunk = Buffer.concat([
    encodeFrame(PTY_FRAME.READY, Buffer.from([1, 0, 0, 0x30, 0x39])),
    encodeData("a"),
    encodeData("b"),
  ]);
  const frames = decoder.push(chunk);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, PTY_FRAME.READY);
  assert.equal(frames[1].payload.toString(), "a");
  assert.equal(frames[2].payload.toString(), "b");
});

check("a trailing partial frame does not disturb the complete ones", () => {
  const decoder = createFrameDecoder();
  const tail = encodeData("second");
  const frames = decoder.push(
    Buffer.concat([encodeData("first"), tail.subarray(0, 4)]),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), "first");
  const rest = decoder.push(tail.subarray(4));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].payload.toString(), "second");
});

check("zero-length payloads are frames, not end-of-stream", () => {
  const decoder = createFrameDecoder();
  const frames = decoder.push(encodeFrame(PTY_FRAME.EXIT, Buffer.alloc(0)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, PTY_FRAME.EXIT);
  assert.equal(frames[0].payload.length, 0);
});

check("an oversized length throws instead of buffering forever", () => {
  const decoder = createFrameDecoder();
  const bogus = Buffer.alloc(HEADER_BYTES);
  bogus[0] = PTY_FRAME.DATA;
  bogus.writeUInt32BE(MAX_PAYLOAD + 1, 1);
  assert.throws(() => decoder.push(bogus), /PTY_FRAME_OVERSIZE|too large/);
});

check("a payload exactly at the ceiling is still accepted", () => {
  const decoder = createFrameDecoder();
  const frame = encodeFrame(PTY_FRAME.DATA, Buffer.alloc(MAX_PAYLOAD, 0x41));
  const frames = decoder.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, MAX_PAYLOAD);
});

check("READY tolerates a payload shorter than this client expects", () => {
  assert.deepEqual(parseReady(Buffer.from([1, 0, 0, 0x30, 0x39])), {
    version: 1,
    pid: 12345,
  });
  // An older daemon that sends only the version must not be treated as an
  // error — the session is perfectly usable without the pid.
  assert.deepEqual(parseReady(Buffer.from([1])), { version: 1, pid: null });
  assert.deepEqual(parseReady(Buffer.alloc(0)), { version: 0, pid: null });
});

if (failures) {
  console.error(`${failures} pty-frames test(s) failed`);
  process.exit(1);
}
console.log("pty-frames tests passed");
