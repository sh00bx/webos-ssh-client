// Pumping bytes from a live shell channel into a session's subscribers.
//
// Extracted from ssh-session.js so the local-shell transport (local-session.js,
// which talks to ptyd over a unix socket) gets the identical decoder, output
// coalescing and close/error handling instead of a second, subtly different
// copy. The only thing it requires of `stream` is the shape ssh2's
// ClientChannel has and local-session.js reproduces:
//
//   stream.on("data" | "close" | "error"), stream.stderr.on("data" | "error")
//
// Everything below this line is transport-agnostic on purpose.
const { StringDecoder } = require("string_decoder");
const { debugLog } = require("./debug-log");
const { sessions, appendOutput, broadcast, closeSession } = require("./sessions");

// Coalesce bursty output: one Luna broadcast (JSON round-trip) per chunk
// causes jank during fast output. Batch whatever arrives within a short window
// into a single data event; the added echo latency is imperceptible.
const OUTPUT_FLUSH_MS = 10;

function attachShellStream(sessionId, stream) {
  // Decode per stream: the transport may chunk mid-codepoint, so a per-chunk
  // toString("utf8") emits replacement chars into the live stream and
  // (persistently) into the replay buffer. StringDecoder carries the partial
  // sequence over to the next chunk.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let pendingOutput = "";
  let flushTimer = null;
  const flushOutput = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingOutput) return;
    const data = pendingOutput;
    pendingOutput = "";
    const active = sessions.get(sessionId);
    if (!active) return;
    active.updatedAt = Date.now();
    active.outputEvents = (active.outputEvents || 0) + 1;
    appendOutput(active, data);
    broadcast(active, {
      returnValue: true,
      event: "data",
      sessionId,
      data,
    });
  };
  const onData = (decoder) => (chunk) => {
    if (!sessions.has(sessionId)) return;
    pendingOutput += decoder.write(chunk);
    if (!flushTimer && pendingOutput) {
      flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
    }
  };
  stream.on("data", onData(stdoutDecoder));
  if (stream.stderr) stream.stderr.on("data", onData(stderrDecoder));

  stream.on("close", () => {
    debugLog("stream_close", { sessionId });
    // Deliver any decoder remainder and coalesced tail before the close
    // event, or the last burst of output is lost.
    pendingOutput += stdoutDecoder.end() + stderrDecoder.end();
    flushOutput();
    closeSession(sessionId, "stream closed");
  });
  // Without an error listener an abnormal channel teardown throws in the
  // service process and tears down EVERY session.
  stream.on("error", (err) => {
    debugLog("stream_error", { sessionId, error: err });
    flushOutput();
    closeSession(
      sessionId,
      "stream error: " + ((err && err.message) || String(err)),
    );
  });
  if (stream.stderr) {
    stream.stderr.on("error", (err) => {
      debugLog("stream_stderr_error", { sessionId, error: err });
    });
  }
}

module.exports = { attachShellStream, OUTPUT_FLUSH_MS };
