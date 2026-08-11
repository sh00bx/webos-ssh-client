// The local-shell transport: a session whose pty lives in the ptyd helper
// instead of on a remote host.
//
// WHY A HELPER AT ALL. The service is chrooted into
// /var/palm/jail/<service>/ as uid 5301 with no capabilities, and that jail's
// /dev has six entries — console, log, logdir, null, shm, urandom. No
// /dev/ptmx, no /dev/pts (verified on the device: open("/dev/ptmx") from
// inside the jail is ENOENT). So there is no way to allocate a terminal in
// this process, with or without a native module: openpty(), forkpty() and the
// busybox `script` applet all need the ptmx multiplexor. child_process.spawn()
// does work, but a pipe is not a tty — no job control, no ^C, no curses — and
// shipping that as "local shell" would be a worse lie than not having one.
// tv-root/ptyd.c runs outside the jail, allocates the pty, and hands the two
// byte streams back over a unix socket; the socket's owner is the access
// control (see that file's header).
//
// The session this produces is deliberately indistinguishable from an SSH one
// downstream: `stream` duck-types ssh2's ClientChannel, so write/resize/
// disconnect/attach/replay and the whole subscriber machinery in sessions.js
// work unchanged, and the only place that knows the difference is the `kind`
// field on the summary (which the UI uses for the label).
const net = require("net");
const { EventEmitter } = require("events");
const { clampInt, genId, safeRespond } = require("./util");
const { debugLog } = require("./debug-log");
const {
  sessions,
  storeSession,
  addSubscriber,
  broadcast,
  closeSession,
  failSession,
} = require("./sessions");
const { attachShellStream } = require("./shell-stream");
const {
  PTY_FRAME,
  MAX_PAYLOAD,
  encodeFrame,
  encodeHello,
  encodeResize,
  createFrameDecoder,
  parseReady,
} = require("./pty-frames");

// Must match SOCK_PATH in ptyd.c. Overridable for the host-side test harness
// (tests/ptyd-e2e.manual.mjs), which runs a real ptyd against a temp path.
const PTYD_SOCKET =
  process.env.SSHCLIENT_PTYD_SOCKET || "/tmp/.sshclient-ptyd/ptyd.sock";
// The daemon spawns the shell on HELLO and answers READY immediately after,
// so a connect that has not been answered by now is not going to be.
const READY_TIMEOUT_MS = 5000;

// What the user sees when ptyd is not installed. ENOENT on the socket path is
// by far the most likely failure and it has one specific fix, so say it —
// "connection refused" would send someone looking at the network.
function describeSocketError(err) {
  const code = (err && err.code) || "";
  if (code === "ENOENT") {
    return (
      "local shell helper (ptyd) is not running. Install it with " +
      "scripts/install-ptyd.sh from the repo, or start it on the TV with " +
      "/var/lib/webosbrew/ptyd."
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return (
      "the local shell helper refused this service (socket owned by another " +
      "uid). Restart ptyd on the TV so it re-reads the app's storage owner."
    );
  }
  return `local shell helper unreachable: ${(err && err.message) || code || "unknown error"}`;
}

// A ClientChannel-shaped view of the ptyd connection. ssh2's channel is the
// contract the rest of the service already speaks, so meeting it here is what
// keeps local sessions out of every other module.
function createPtyStream(socket) {
  const stream = new EventEmitter();
  const decoder = createFrameDecoder();
  // ssh2 splits stderr onto its own sub-stream. A pty does not — the slave is
  // one device and the shell's stderr is already interleaved into it — but the
  // shape has to be there because shell-stream.js subscribes to it.
  stream.stderr = new EventEmitter();
  let closed = false;
  let exitCode = null;

  socket.on("data", (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      // A desynchronised length field means every byte after it is of unknown
      // meaning; there is nothing to salvage.
      stream.emit("error", e);
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.type === PTY_FRAME.DATA) {
        stream.emit("data", frame.payload);
      } else if (frame.type === PTY_FRAME.READY) {
        stream.emit("ready", parseReady(frame.payload));
      } else if (frame.type === PTY_FRAME.EXIT) {
        exitCode = frame.payload.length ? frame.payload[0] : null;
        stream.emit("exit", exitCode);
      }
      // Unknown frame types are ignored, matching the daemon's own
      // skip-by-length rule for the other direction.
    }
  });

  socket.on("error", (err) => {
    if (closed) return;
    stream.emit("error", err);
  });

  socket.on("close", () => {
    if (closed) return;
    closed = true;
    stream.exitCode = exitCode;
    stream.emit("close");
  });

  // 🔑 Split at MAX_PAYLOAD. A frame larger than that is a PROTOCOL VIOLATION
  // to the daemon — ptyd's parser cannot tell an oversized length from a
  // desynchronised stream, so it drops the connection and SIGHUPs the shell.
  // One write here is one Luna `write` call, which is one term.paste(), and a
  // paste is bounded only by the clipboard: OSC 52 admits ~75 KiB of text and
  // a selection over the scrollback is unbounded. The SSH path never showed
  // this because ssh2 chunks channel writes itself — which is exactly why it
  // has to be done explicitly here.
  stream.write = (data) => {
    if (closed || !data) return false;
    const buf = Buffer.from(data, "utf8");
    if (!buf.length) return true;
    let ok = true;
    for (let offset = 0; offset < buf.length; offset += MAX_PAYLOAD) {
      ok = socket.write(
        encodeFrame(PTY_FRAME.DATA, buf.subarray(offset, offset + MAX_PAYLOAD)),
      );
    }
    return ok;
  };
  // ssh2's signature, which sessions-methods.js calls positionally.
  stream.setWindow = (rows, cols) => {
    if (closed) return;
    socket.write(encodeResize(cols, rows));
  };
  stream.end = () => {
    if (closed) return;
    socket.end();
  };
  stream.destroy = () => {
    closed = true;
    socket.destroy();
  };
  return stream;
}

function parseLocalParams(payload) {
  const params = payload || {};
  return {
    cols: clampInt(params.cols, 80, 20, 500),
    rows: clampInt(params.rows, 24, 5, 200),
  };
}

function createLocalSessionRecord(sessionId, params, client) {
  return {
    id: sessionId,
    kind: "local",
    // Kept in the SSH-shaped fields so nothing downstream has to branch: the
    // tab strip, the session list and the debug log all read these. The UI
    // renders `kind` instead when it is "local" — see sessionLabel() in
    // src/session-label.mjs.
    host: "localhost",
    port: 0,
    user: "root",
    client,
    stream: null,
    subscribers: new Set(),
    subscriptionTokens: new Set(),
    outputBuffer: [],
    outputBytes: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: "connecting",
    lastAttachAt: Date.now(),
    lastDetachAt: null,
    writeCount: 0,
    writeBytes: 0,
    resizeCount: 0,
    outputEvents: 0,
    lastWriteLogAt: 0,
  };
}

function handleLocalConnect(message) {
  const params = parseLocalParams(message.payload);
  const sessionId = genId();

  debugLog("local_connect_request", {
    sessionId,
    socket: PTYD_SOCKET,
    cols: params.cols,
    rows: params.rows,
  });

  const socket = net.connect(PTYD_SOCKET);
  socket.setNoDelay(true);
  const stream = createPtyStream(socket);

  // closeSession() ends `session.client`; for SSH that is the ssh2 Client, here
  // it is the socket behind the pty stream. Same one-method contract.
  const client = {
    end() {
      try {
        stream.end();
      } catch (e) {
        /* already gone */
      }
      // A shell blocked on output that nobody is reading would keep the socket
      // half-open forever; the daemon SIGHUPs its child when the connection
      // drops, so make sure it actually drops.
      const hardClose = setTimeout(() => {
        try {
          stream.destroy();
        } catch (e) {
          /* already gone */
        }
      }, 1000);
      if (typeof hardClose.unref === "function") hardClose.unref();
    },
  };

  const session = createLocalSessionRecord(sessionId, params, client);
  storeSession(sessionId, session);
  addSubscriber(session, message);

  broadcast(session, {
    returnValue: true,
    event: "status",
    sessionId,
    stage: "connecting",
  });

  let settled = false;
  const readyTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    debugLog("local_ready_timeout", { sessionId });
    try {
      socket.destroy();
    } catch (e) {
      /* noop */
    }
    failSession(
      sessionId,
      message,
      "PTYD_TIMEOUT",
      "local shell helper accepted the connection but never answered",
    );
  }, READY_TIMEOUT_MS);
  if (typeof readyTimer.unref === "function") readyTimer.unref();

  socket.on("connect", () => {
    // HELLO carries the size so the shell's very first prompt is already drawn
    // at the real window width — the daemon spawns on this frame.
    socket.write(encodeHello(params.cols, params.rows));
    const current = sessions.get(sessionId);
    if (!current) return;
    current.stage = "opening shell";
    current.updatedAt = Date.now();
    broadcast(current, {
      returnValue: true,
      event: "status",
      sessionId,
      stage: "opening shell",
    });
  });

  stream.on("ready", (info) => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    const current = sessions.get(sessionId);
    if (!current) {
      try {
        stream.destroy();
      } catch (e) {
        /* noop */
      }
      return;
    }
    current.stream = stream;
    current.stage = "ready";
    current.updatedAt = Date.now();
    current.ptydVersion = info.version;
    current.shellPid = info.pid;
    debugLog("local_shell_ready", {
      sessionId,
      ptydVersion: info.version,
      shellPid: info.pid,
      cols: params.cols,
      rows: params.rows,
    });
    broadcast(current, { returnValue: true, event: "ready", sessionId });
    attachShellStream(sessionId, stream);
  });

  // The shell exited on its own (user typed `exit`). Record the status so the
  // close reason says something more useful than "stream closed"; the actual
  // teardown rides the close event that follows.
  stream.on("exit", (code) => {
    const current = sessions.get(sessionId);
    if (current) current.exitCode = code;
    debugLog("local_shell_exit", { sessionId, exitCode: code });
  });

  stream.on("error", (err) => {
    if (settled) {
      // After ready, the stream's own error handler (installed by
      // attachShellStream) owns the teardown.
      return;
    }
    settled = true;
    clearTimeout(readyTimer);
    debugLog("local_connect_error", { sessionId, error: err });
    failSession(sessionId, message, "PTYD_UNAVAILABLE", describeSocketError(err));
  });

  stream.on("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(readyTimer);
      failSession(
        sessionId,
        message,
        "PTYD_UNAVAILABLE",
        "local shell helper closed the connection before the shell started",
      );
      return;
    }
    // attachShellStream is only wired once ready fired; before that there is
    // nothing else to close the session.
    if (sessions.has(sessionId) && !sessions.get(sessionId).stream) {
      closeSession(sessionId, "local shell helper disconnected");
    }
  });
}

// Cheap reachability probe for the UI, so the connect form can label the
// button honestly instead of offering a shell that will fail on click.
function handleLocalStatus(message) {
  const socket = net.connect(PTYD_SOCKET);
  let answered = false;
  const finish = (body) => {
    if (answered) return;
    answered = true;
    try {
      socket.destroy();
    } catch (e) {
      /* noop */
    }
    safeRespond(message, body);
  };
  const timer = setTimeout(
    () => finish({ returnValue: true, available: false, reason: "timeout" }),
    1500,
  );
  if (typeof timer.unref === "function") timer.unref();
  socket.on("connect", () => {
    clearTimeout(timer);
    // Connecting is the whole test: ptyd accepts, then waits for HELLO and
    // spawns nothing until it arrives (or until its 2s timeout, which the
    // destroy below beats).
    finish({ returnValue: true, available: true, socket: PTYD_SOCKET });
  });
  socket.on("error", (err) => {
    clearTimeout(timer);
    finish({
      returnValue: true,
      available: false,
      reason: (err && err.code) || "error",
      errorText: describeSocketError(err),
    });
  });
}

module.exports = {
  handleLocalConnect,
  handleLocalStatus,
  createPtyStream,
  describeSocketError,
  PTYD_SOCKET,
};
