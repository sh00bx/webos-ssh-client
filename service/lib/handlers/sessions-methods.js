// Session-facing Luna methods: connect/attach/sessions·list/write/resize/
// disconnect. Registration goes through the gated register() from bus.js.
const { clampInt } = require("../util");
const { debugLog } = require("../debug-log");
const {
  sessions,
  sessionSummary,
  closeSession,
  removeSubscriberByToken,
} = require("../sessions");
const {
  handleConnect,
  handleAttach,
  handleConnectCancel,
} = require("../ssh-session");
const { handleLocalConnect, handleLocalStatus } = require("../local-session");

function registerSessionMethods(register) {
  register("connect", handleConnect, handleConnectCancel);

  // The local shell rides the exact same session machinery — the only thing
  // that differs is where the pty comes from (see local-session.js), so
  // write/resize/disconnect/attach below need no local-specific branch. The
  // cancel handler is shared with connect for the same reason: a subscription
  // is a subscription regardless of transport.
  register("local/connect", handleLocalConnect, handleConnectCancel);
  register("local/status", handleLocalStatus);

  register("attach", handleAttach, removeSubscriberByToken);

  register("sessions/list", (message) => {
    debugLog("sessions_list", { count: sessions.size });
    message.respond({
      returnValue: true,
      sessions: Array.from(sessions.values()).map(sessionSummary),
    });
  });

  register("write", (message) => {
    const { sessionId, data } = message.payload || {};
    const session = sessions.get(sessionId);
    if (!session) {
      return message.respond({ returnValue: false, errorCode: "NO_SESSION" });
    }
    if (!session.stream) {
      return message.respond({ returnValue: false, errorCode: "NOT_READY" });
    }
    try {
      const text = typeof data === "string" ? data : "";
      session.writeCount = (session.writeCount || 0) + 1;
      session.writeBytes = (session.writeBytes || 0) + Buffer.byteLength(text, "utf8");
      session.updatedAt = Date.now();
      if (!session.lastWriteLogAt || session.updatedAt - session.lastWriteLogAt > 5000) {
        session.lastWriteLogAt = session.updatedAt;
        debugLog("session_write", {
          sessionId,
          writeCount: session.writeCount,
          writeBytes: session.writeBytes,
          lastBytes: Buffer.byteLength(text, "utf8"),
        });
      }
      session.stream.write(text);
      message.respond({ returnValue: true });
    } catch (e) {
      debugLog("write_fail", { sessionId, error: e });
      message.respond({
        returnValue: false,
        errorCode: "WRITE_FAIL",
        errorText: e.message || String(e),
      });
    }
  });

  register("resize", (message) => {
    const { sessionId, cols, rows } = message.payload || {};
    const session = sessions.get(sessionId);
    if (!session) {
      return message.respond({ returnValue: false, errorCode: "NO_SESSION" });
    }
    if (!session.stream) {
      return message.respond({ returnValue: false, errorCode: "NOT_READY" });
    }
    try {
      // A sanity bound only. The floor is deliberately at xterm's own grid
      // minimum rather than at `connect`'s 20x5: the window can be dragged small
      // enough (240px tall, 28px font) to legitimately fit fewer than 5 rows, and
      // over-reporting the size would leave the remote drawing one line more than
      // the viewport shows. The collapsed-layout case that used to push a 2x1 pty
      // is prevented on the client side, where a 0x0 frame is now never measured.
      const safeCols = clampInt(cols, 80, 2, 500);
      const safeRows = clampInt(rows, 24, 1, 200);
      session.resizeCount = (session.resizeCount || 0) + 1;
      session.updatedAt = Date.now();
      debugLog("session_resize", {
        sessionId,
        cols: safeCols,
        rows: safeRows,
        resizeCount: session.resizeCount,
      });
      session.stream.setWindow(safeRows, safeCols, 0, 0);
      message.respond({ returnValue: true });
    } catch (e) {
      debugLog("resize_fail", { sessionId, error: e });
      message.respond({
        returnValue: false,
        errorCode: "RESIZE_FAIL",
        errorText: e.message || String(e),
      });
    }
  });

  register("disconnect", (message) => {
    const { sessionId } = message.payload || {};
    if (!sessions.has(sessionId)) {
      debugLog("disconnect_no_session", { sessionId });
      return message.respond({ returnValue: false, errorCode: "NO_SESSION" });
    }
    debugLog("disconnect_request", { sessionId });
    closeSession(sessionId, "client disconnect");
    message.respond({ returnValue: true });
  });
}

module.exports = { registerSessionMethods };
