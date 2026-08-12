// One SSH connection: parameter parsing, ssh2 config incl. TOFU verifier and
// auth material, the shell stream wiring (decoders + output coalescing), and
// the attach path.
const { Client } = require("ssh2");
const { clampInt, genId, safeRespond } = require("./util");
const { debugLog } = require("./debug-log");
const {
  sessions,
  storeSession,
  addSubscriber,
  broadcast,
  bufferedOutput,
  bufferedTerminalModes,
  sessionSummary,
  closeSession,
  failSession,
  newestSession,
  removeSubscriberByToken,
} = require("./sessions");
const { attachShellStream } = require("./shell-stream");
const { createHostVerifier } = require("./known-hosts");
const { loadKeyForAuth } = require("./keystore");

function parseConnectParams(payload) {
  const params = payload || {};
  return {
    host: String(params.host || "").trim(),
    user: String(params.user || "").trim(),
    port: Number(params.port) || 22,
    auth: params.auth || {},
    cols: clampInt(params.cols, 80, 20, 500),
    rows: clampInt(params.rows, 24, 5, 200),
  };
}

// Builds the ssh2 config or returns { error: { errorCode, errorText } }.
function buildSshConfig(params, hostVerifier) {
  const sshConfig = {
    host: params.host,
    port: params.port,
    username: params.user,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    hostVerifier,
  };

  const auth = params.auth;
  if (auth.type === "password") {
    sshConfig.password = String(auth.password || "");
  } else if (auth.type === "publickey") {
    if (!auth.keyId) {
      return {
        error: {
          errorCode: "BAD_PARAMS",
          errorText: "auth.keyId required for publickey",
        },
      };
    }
    const loaded = loadKeyForAuth(auth.keyId, auth.passphrase);
    if (loaded.error) {
      return {
        error: {
          errorCode: loaded.error,
          errorText: loaded.errorText || loaded.error,
        },
      };
    }
    sshConfig.privateKey = loaded.privateKey;
    if (loaded.passphrase) sshConfig.passphrase = loaded.passphrase;
  } else {
    return {
      error: {
        errorCode: "BAD_AUTH",
        errorText: `unsupported auth type: ${auth.type}`,
      },
    };
  }
  return { sshConfig };
}

function createSessionRecord(sessionId, params, client) {
  return {
    id: sessionId,
    kind: "ssh",
    host: params.host,
    port: params.port,
    user: params.user,
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

function wireClientEvents(client, sessionId, message, { params, hostVerifier }) {
  const hostId = `${params.host}:${params.port}`;

  client.on("ready", () => {
    const session = sessions.get(sessionId);
    if (!session) {
      try { client.end(); } catch (e) { /* noop */ }
      return;
    }

    debugLog("ssh_ready", { sessionId });
    session.stage = "opening shell";
    session.updatedAt = Date.now();
    broadcast(session, {
      returnValue: true,
      event: "status",
      sessionId,
      stage: "opening shell",
    });

    // term: xterm-256color → 256-colour apps work; xterm.js renders the full
    // 256-colour cube and 24-bit truecolour. COLORTERM advertises truecolour so
    // apps that gate 24-bit output on it will emit it (best-effort: the SSH
    // server must AcceptEnv COLORTERM, else it is silently ignored). Inside tmux
    // the user still needs an RGB terminal-overrides/-features entry to avoid
    // truecolour being down-sampled to 256.
    const shellOpts = { env: { COLORTERM: "truecolor" } };
    client.shell(
      { term: "xterm-256color", cols: params.cols, rows: params.rows },
      shellOpts,
      (err, stream) => {
        if (err) {
          failSession(
            sessionId,
            message,
            "SHELL_FAIL",
            err.message || String(err),
          );
          return;
        }

        const current = sessions.get(sessionId);
        if (!current) {
          try { stream.end(); } catch (e) { /* noop */ }
          try { client.end(); } catch (e) { /* noop */ }
          return;
        }
        current.stream = stream;
        current.stage = "ready";
        current.updatedAt = Date.now();
        debugLog("shell_ready", { sessionId, cols: params.cols, rows: params.rows });

        broadcast(current, {
          returnValue: true,
          event: "ready",
          sessionId,
        });

        attachShellStream(sessionId, stream);
      },
    );
  });

  client.on("error", (err) => {
    const isAuthFail =
      err && (err.level === "client-authentication" || err.code === "EAUTH");
    debugLog("client_error", {
      sessionId,
      authFailed: Boolean(isAuthFail),
      error: err,
    });
    const hostKeyMismatch = hostVerifier.getMismatch();
    if (hostKeyMismatch) {
      const detail = hostKeyMismatch.storageError
        ? `host key check failed: ${hostKeyMismatch.storageError}`
        : `HOST KEY CHANGED for ${hostId} — expected ${hostKeyMismatch.expected}, ` +
          `got ${hostKeyMismatch.actual}. Someone could be intercepting the ` +
          `connection. If the server was reinstalled on purpose, clear the ` +
          `pinned key (service method knownhosts/remove) and reconnect.`;
      failSession(sessionId, message, "HOST_KEY_MISMATCH", detail);
      return;
    }
    failSession(
      sessionId,
      message,
      isAuthFail ? "AUTH_FAIL" : "SSH_ERROR",
      err.message || String(err),
      isAuthFail ? { authFailed: true } : null,
    );
  });

  client.on("end", () => {
    debugLog("client_end", { sessionId });
    closeSession(sessionId, "remote end");
  });
  client.on("close", () => {
    debugLog("client_close", { sessionId });
    closeSession(sessionId, "remote close");
  });
}

function handleConnect(message) {
  const params = parseConnectParams(message.payload);

  if (!params.host || !params.user) {
    return message.respond({
      returnValue: false,
      errorCode: "BAD_PARAMS",
      errorText: "host and user are required",
    });
  }

  const hostVerifier = createHostVerifier(`${params.host}:${params.port}`);
  const built = buildSshConfig(params, hostVerifier.verifier);
  if (built.error) {
    return message.respond({
      returnValue: false,
      errorCode: built.error.errorCode,
      errorText: built.error.errorText,
    });
  }

  const client = new Client();
  const sessionId = genId();
  const session = createSessionRecord(sessionId, params, client);

  debugLog("connect_request", {
    sessionId,
    host: params.host,
    port: params.port,
    user: params.user,
    authType: params.auth.type,
    cols: params.cols,
    rows: params.rows,
  });

  storeSession(sessionId, session);
  addSubscriber(session, message);

  broadcast(session, {
    returnValue: true,
    event: "status",
    sessionId,
    stage: "connecting",
  });

  wireClientEvents(client, sessionId, message, { params, hostVerifier });

  debugLog("client_connect_call", { sessionId });
  // ssh2 validates the key material synchronously inside connect() and throws
  // rather than emitting "error". loadKeyForAuth already pre-parses the key so
  // the known triggers are caught earlier, but an unexpected throw here would
  // otherwise escape the Luna handler and terminate the service — and with it
  // every other session. Fail just this session instead.
  try {
    client.connect(built.sshConfig);
  } catch (e) {
    debugLog("client_connect_threw", { sessionId, error: e });
    failSession(sessionId, message, "SSH_CONFIG", e.message || String(e));
  }
}

function handleAttach(message) {
  const params = message.payload || {};
  const requestedId = params.sessionId ? String(params.sessionId) : "";
  const session = requestedId ? sessions.get(requestedId) : newestSession();
  if (!session) {
    debugLog("attach_no_session", { requestedId });
    return message.respond({
      returnValue: false,
      errorCode: "NO_SESSION",
    });
  }

  addSubscriber(session, message);
  session.lastAttachAt = Date.now();
  session.updatedAt = session.lastAttachAt;
  debugLog("attach_request", {
    requestedId,
    sessionId: session.id,
    stage: session.stage,
    ready: Boolean(session.stream),
    replayBytes: session.outputBytes || 0,
  });
  safeRespond(message, {
    returnValue: true,
    event: "attached",
    session: sessionSummary(session),
  });
  safeRespond(message, {
    returnValue: true,
    event: "status",
    sessionId: session.id,
    stage: session.stage,
  });
  // The replayed tail plus the terminal modes the remote set outside it. The
  // modes ride in the replay payload rather than in an event of their own so
  // that they cannot arrive before the content they apply to, and so a client
  // that predates them needs no change to benefit.
  const replay = bufferedOutput(session);
  const modes = bufferedTerminalModes(session);
  if (replay || modes) {
    safeRespond(message, {
      returnValue: true,
      event: "replay",
      sessionId: session.id,
      data: replay + modes,
    });
  }
  if (session.stream) {
    safeRespond(message, {
      returnValue: true,
      event: "ready",
      sessionId: session.id,
    });
  }
}

function handleConnectCancel(message) {
  removeSubscriberByToken(message);
}

module.exports = { handleConnect, handleAttach, handleConnectCancel };
