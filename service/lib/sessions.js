// The session registry: the sessions map, subscriber bookkeeping, the replay
// buffer, and the two teardown paths (closeSession / failSession).
const { OUTPUT_BUFFER_LIMIT, SESSION_REAP_MS } = require("./config");
const { safeRespond, getMessageToken } = require("./util");
const { debugLog } = require("./debug-log");
const { updateKeepAlive } = require("./keepalive");
const {
  createModeTracker,
  trackTerminalModes,
  terminalModeSequence,
  enabledTerminalModes,
} = require("./terminal-modes");

// sessionId -> { id, client, stream, subscribers, outputBuffer, ...metadata }
const sessions = new Map();
const subscriptionsByToken = new Map();

function storeSession(sessionId, session) {
  sessions.set(sessionId, session);
  updateKeepAlive("session stored");
}

function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  sessions.delete(sessionId);
  // Any file transfer on this session is riding an SFTP channel on the very
  // client that is about to be ended. Left alone it would keep piping into a
  // dead channel and leave its .part file behind with nothing to clean it up.
  // Required lazily: sftp-transfer pulls in ./sftp, which pulls in this module.
  try {
    require("./sftp-transfer").cancelSessionTransfers(sessionId);
  } catch (e) {
    debugLog("transfer_cleanup_fail", { sessionId, error: e });
  }
  session.sftp = null;
  session.sftpPending = null;
  if (session.subscriptionTokens) {
    for (const token of session.subscriptionTokens) {
      subscriptionsByToken.delete(token);
    }
  }
  updateKeepAlive("session removed");
  return session;
}

function addSubscriber(session, message) {
  if (!session || !message) return;
  session.subscribers.add(message);
  const token = getMessageToken(message);
  if (token) {
    subscriptionsByToken.set(token, { sessionId: session.id, message });
    session.subscriptionTokens.add(token);
  }
  debugLog("subscriber_add", {
    sessionId: session.id,
    subscribers: session.subscribers.size,
    hasToken: Boolean(token),
  });
}

function removeSubscriberByToken(message) {
  const token = getMessageToken(message);
  if (!token) {
    debugLog("subscriber_remove_ignored", { reason: "missing token" });
    return null;
  }
  const entry = subscriptionsByToken.get(token);
  if (!entry) {
    debugLog("subscriber_remove_ignored", { reason: "unknown token" });
    return null;
  }
  subscriptionsByToken.delete(token);
  const session = sessions.get(entry.sessionId);
  if (session) {
    session.subscribers.delete(entry.message);
    session.subscriptionTokens.delete(token);
    session.updatedAt = Date.now();
    session.lastDetachAt = session.updatedAt;
    debugLog("subscriber_remove", {
      sessionId: session.id,
      subscribers: session.subscribers.size,
      stage: session.stage,
    });
  } else {
    debugLog("subscriber_remove_missing_session", { sessionId: entry.sessionId });
  }
  return session || null;
}

function broadcast(session, body) {
  if (!session) return;
  for (const subscriber of Array.from(session.subscribers)) {
    safeRespond(subscriber, body);
  }
}

function appendOutput(session, data) {
  const text = typeof data === "string" ? data : String(data || "");
  if (!text) return;
  // Before any trimming: the mode tracker has to see every byte the remote
  // sent, and the ring below deliberately throws bytes away.
  if (!session.termModes) session.termModes = createModeTracker();
  trackTerminalModes(session.termModes, text);
  let chunk = text;
  let bytes = Buffer.byteLength(chunk, "utf8");
  if (bytes > OUTPUT_BUFFER_LIMIT) {
    chunk = Buffer.from(chunk, "utf8")
      .subarray(bytes - OUTPUT_BUFFER_LIMIT)
      .toString("utf8");
    bytes = Buffer.byteLength(chunk, "utf8");
    session.outputBuffer = [];
    session.outputBytes = 0;
  }
  session.outputBuffer.push({ text: chunk, bytes });
  session.outputBytes += bytes;
  while (session.outputBytes > OUTPUT_BUFFER_LIMIT && session.outputBuffer.length) {
    const removed = session.outputBuffer.shift();
    session.outputBytes -= removed.bytes;
  }
}

function bufferedOutput(session) {
  if (!session || !session.outputBuffer.length) return "";
  return session.outputBuffer.map((chunk) => chunk.text).join("");
}

// The mode sequence an attaching client needs to end up in the state the remote
// thinks it is in. Written AFTER the replay, not before: the replayed tail can
// contain mode changes of its own, and those are older than what the tracker
// holds — the tracker saw the whole stream, so it wins.
function bufferedTerminalModes(session) {
  return session ? terminalModeSequence(session.termModes) : "";
}

function sessionSummary(session) {
  return {
    id: session.id,
    // "ssh" | "local". Defaulted rather than required so a record built before
    // the local transport existed still summarises as an SSH session.
    kind: session.kind || "ssh",
    // Only set for local sessions: the pid of the shell ptyd forked. Purely
    // diagnostic — it is what makes a stuck local session identifiable in a
    // root shell without guessing from `ps`.
    shellPid: session.shellPid || null,
    host: session.host,
    port: session.port,
    user: session.user,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stage: session.stage,
    ready: Boolean(session.stream),
    subscribers: session.subscribers.size,
    bufferedBytes: session.outputBytes || 0,
    // Which private modes an attach would restore. Diagnostic only, but it is
    // the one piece of state that made the dead-clicks bug invisible: without
    // it, "the tracker restored nothing" and "the tracker never ran" look the
    // same from outside.
    terminalModes: enabledTerminalModes(session.termModes),
    writeCount: session.writeCount || 0,
    writeBytes: session.writeBytes || 0,
    resizeCount: session.resizeCount || 0,
    outputEvents: session.outputEvents || 0,
    lastAttachAt: session.lastAttachAt || null,
    lastDetachAt: session.lastDetachAt || null,
  };
}

function closeSession(sessionId, reason) {
  const session = removeSession(sessionId);
  if (!session) return;
  session.stage = "closed";
  session.updatedAt = Date.now();
  debugLog("session_close", {
    sessionId,
    reason: reason || "closed",
    summary: sessionSummary(session),
    writeCount: session.writeCount || 0,
    writeBytes: session.writeBytes || 0,
    resizeCount: session.resizeCount || 0,
    outputBytes: session.outputBytes || 0,
    outputEvents: session.outputEvents || 0,
  });
  broadcast(session, {
    returnValue: true,
    event: "close",
    sessionId,
    reason: reason || "closed",
  });
  try {
    session.client.end();
  } catch (e) {
    /* noop */
  }
}

function failSession(sessionId, message, errorCode, errorText, extra) {
  const session = removeSession(sessionId);
  if (!session) return;
  session.stage = "error";
  session.updatedAt = Date.now();
  debugLog("session_error", {
    sessionId,
    errorCode,
    errorText,
    extra,
    summary: sessionSummary(session),
  });
  const body = {
    returnValue: false,
    errorCode,
    errorText,
  };
  if (extra && typeof extra === "object") Object.assign(body, extra);
  if (session.subscribers.size) {
    broadcast(session, body);
  } else {
    safeRespond(message, body);
  }
  try {
    session.client.end();
  } catch (e) {
    /* noop */
  }
}

function newestSession() {
  let newest = null;
  for (const session of sessions.values()) {
    if (!newest || session.updatedAt > newest.updatedAt) newest = session;
  }
  return newest;
}

function reapIdleSessions() {
  const now = Date.now();
  for (const session of Array.from(sessions.values())) {
    if (session.subscribers.size) continue;
    const idleSince = session.lastDetachAt || session.createdAt || 0;
    if (now - idleSince >= SESSION_REAP_MS) {
      debugLog("session_reaped", {
        sessionId: session.id,
        idleMs: now - idleSince,
      });
      closeSession(session.id, "idle timeout: no client attached");
    }
  }
}

module.exports = {
  sessions,
  storeSession,
  removeSession,
  addSubscriber,
  removeSubscriberByToken,
  broadcast,
  appendOutput,
  bufferedOutput,
  bufferedTerminalModes,
  sessionSummary,
  closeSession,
  failSession,
  newestSession,
  reapIdleSessions,
};
