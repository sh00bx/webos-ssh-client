// File-manager Luna methods: listing, mkdir, remove, and transfers in both
// directions. Registration goes through the gated register() from bus.js.
//
// "side" is always one of "tv" or "host". The TV side is a plain fs under a
// fixed sandbox and needs no session; the host side rides an SFTP channel on
// the session's existing ssh2 client (see lib/sftp.js for why a channel and not
// a second connection).
const { debugLog } = require("../debug-log");
const { sessions } = require("../sessions");
const { safeRespond } = require("../util");
const sftp = require("../sftp");
const transfers = require("../sftp-transfer");

// Everything below shares one shape: resolve the session when the host side is
// involved, run the operation, and turn a throw into a structured reply rather
// than letting it reach the process-level handler (which would log it as if a
// session had crashed).
function replyError(message, e, fallback) {
  const code = (e && e.code) || fallback || "FILES_FAIL";
  safeRespond(message, {
    returnValue: false,
    errorCode: String(code),
    errorText: String((e && e.message) || e || code),
  });
}

function sessionFor(message, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    safeRespond(message, { returnValue: false, errorCode: "NO_SESSION" });
    return null;
  }
  return session;
}

function registerFilesMethods(register) {
  // Where the TV side starts, and what the client should call it. Asked once
  // when an explorer opens, so the client never has to hardcode the sandbox.
  register("files/roots", (message) => {
    const ok = sftp.tvRootReady();
    safeRespond(message, {
      returnValue: true,
      tvRoot: "/",
      tvRootLabel: "TV",
      tvAvailable: ok,
      listLimit: sftp.LIST_LIMIT,
    });
  });

  register("files/list", async (message) => {
    const { sessionId, side, path: rawPath } = message.payload || {};
    try {
      if (side === "tv") {
        const result = await sftp.listTv(rawPath);
        return safeRespond(message, { returnValue: true, side: "tv", ...result });
      }
      const session = sessionFor(message, sessionId);
      if (!session) return undefined;
      const result = await sftp.listHost(session, rawPath);
      return safeRespond(message, { returnValue: true, side: "host", ...result });
    } catch (e) {
      debugLog("files_list_fail", { sessionId, side, path: rawPath, error: e });
      return replyError(message, e, "LIST_FAIL");
    }
  });

  register("files/mkdir", async (message) => {
    const { sessionId, side, path: rawPath } = message.payload || {};
    try {
      if (side === "tv") await sftp.mkdirTv(rawPath);
      else {
        const session = sessionFor(message, sessionId);
        if (!session) return undefined;
        await sftp.mkdirHost(session, rawPath);
      }
      debugLog("files_mkdir", { sessionId, side, path: rawPath });
      return safeRespond(message, { returnValue: true });
    } catch (e) {
      return replyError(message, e, "MKDIR_FAIL");
    }
  });

  register("files/remove", async (message) => {
    const { sessionId, side, path: rawPath, isDir } = message.payload || {};
    try {
      if (side === "tv") await sftp.removeTv(rawPath);
      else {
        const session = sessionFor(message, sessionId);
        if (!session) return undefined;
        await sftp.removeHost(session, rawPath, Boolean(isDir));
      }
      debugLog("files_remove", { sessionId, side, path: rawPath, isDir: Boolean(isDir) });
      return safeRespond(message, { returnValue: true });
    } catch (e) {
      return replyError(message, e, "REMOVE_FAIL");
    }
  });

  // A transfer is a SUBSCRIPTION, because the interesting part is what happens
  // between the request and the answer. The first reply carries the id and the
  // total so the client can draw a bar immediately; progress events follow; a
  // final event with `done` closes it out. A client that goes away mid-copy
  // just stops being written to — the transfer itself is not cancelled by a
  // lost subscriber, because the user pressing Hide should not lose the file.
  register("files/transfer", async (message) => {
    const { sessionId, direction, hostPath, tvPath } = message.payload || {};
    if (!message.isSubscription) {
      return safeRespond(message, {
        returnValue: false,
        errorCode: "NEEDS_SUBSCRIPTION",
        errorText: "call with subscribe:true",
      });
    }
    const session = sessionFor(message, sessionId);
    if (!session) return undefined;
    try {
      const { id, total } = await transfers.startTransfer(session, {
        direction,
        hostPath,
        tvPath,
        onProgress: (p) => {
          safeRespond(message, { returnValue: true, event: "progress", ...p });
        },
        onDone: (d) => {
          safeRespond(message, { returnValue: true, event: "done", done: true, ...d });
        },
      });
      return safeRespond(message, {
        returnValue: true,
        event: "started",
        id,
        total,
        direction,
      });
    } catch (e) {
      debugLog("files_transfer_start_fail", { sessionId, direction, error: e });
      return replyError(message, e, "TRANSFER_FAIL");
    }
  });

  register("files/cancel", (message) => {
    const { id } = message.payload || {};
    const cancelled = transfers.cancelTransfer(id);
    debugLog("files_cancel", { id, cancelled });
    safeRespond(message, { returnValue: true, cancelled });
  });
}

module.exports = { registerFilesMethods };
