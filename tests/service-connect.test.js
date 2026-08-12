const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const originalLoad = Module._load;
const tempStorage = fs.mkdtempSync(path.join(os.tmpdir(), "sshclient-service-test-"));
process.env.SSHCLIENT_STORAGE_DIR = tempStorage;
// Fast reaping so the idle-session reap test completes quickly (1000 is the
// service-side minimum for SSHCLIENT_REAP_MS).
process.env.SSHCLIENT_REAP_MS = "1000";
process.env.SSHCLIENT_REAP_CHECK_MS = "50";

class FakeService {
  constructor(name) {
    this.name = name;
    this.handlers = new Map();
    this.createdActivities = [];
    this.completedActivities = [];
    this.activityManager = {
      idleTimeout: 5,
      create: (name, callback) => {
        const activity = { name, id: this.createdActivities.length + 1 };
        this.createdActivities.push(activity);
        callback(activity);
      },
      complete: (activity, callback) => {
        this.completedActivities.push(activity);
        if (callback) callback(activity);
      },
    };
    FakeService.instances.push(this);
  }

  register(name, requestHandler, cancelHandler) {
    this.handlers.set(name, { requestHandler, cancelHandler });
    return { on() {} };
  }
}
FakeService.instances = [];

class FakeStream {
  constructor() {
    this.events = new Map();
    this.stderr = {
      on: (event, handler) => {
        this.events.set(`stderr:${event}`, handler);
      },
    };
    this.writes = [];
    this.window = null;
    this.ended = false;
  }

  on(event, handler) {
    this.events.set(event, handler);
    return this;
  }

  emit(event, value) {
    const handler = this.events.get(event);
    if (handler) handler(value);
  }

  write(data) {
    this.writes.push(data);
  }

  setWindow(rows, cols, height, width) {
    this.window = { rows, cols, height, width };
  }

  end() {
    this.ended = true;
  }
}

class FakeClient {
  constructor() {
    this.events = new Map();
    this.connectedConfig = null;
    this.ended = false;
    this.stream = null;
    FakeClient.instances.push(this);
  }

  on(event, handler) {
    this.events.set(event, handler);
    return this;
  }

  emit(event, value) {
    const handler = this.events.get(event);
    if (handler) handler(value);
  }

  connect(config) {
    this.connectedConfig = config;
  }

  shell(options, opts, callback) {
    // ssh2 signature: shell(wndopts[, opts], callback)
    if (typeof opts === "function") {
      callback = opts;
      opts = undefined;
    }
    this.shellOptions = options;
    this.shellEnvOpts = opts;
    this.stream = new FakeStream();
    callback(null, this.stream);
  }

  end() {
    this.ended = true;
  }
}
FakeClient.instances = [];

Module._load = function loadMock(request, parent, isMain) {
  if (request === "webos-service") return FakeService;
  if (request === "ssh2") {
    return {
      Client: FakeClient,
      utils: {
        // Mirrors ssh2's real ParsedKey contract closely enough for the paths
        // the service depends on: an Error for an undecryptable key, and
        // otherwise an object exposing getPrivatePEM() — which returns null for
        // a public key. The service uses exactly that to tell a private key
        // from a public one before handing anything to Client.connect(), which
        // throws synchronously on bad material.
        parseKey(pem, passphrase) {
          const text = String(pem);
          if (/ENCRYPTED/.test(text) && !passphrase) {
            return new Error(
              "Encrypted private OpenSSH key detected, but no passphrase given",
            );
          }
          if (/ENCRYPTED/.test(text) && passphrase !== "pw") {
            return new Error("OpenSSH key integrity check failed -- bad passphrase?");
          }
          // Real ssh2 rejects malformed public-key material outright rather
          // than returning a key whose getPrivatePEM() is null, so only a
          // well-formed line takes the public branch — otherwise a test could
          // pass against the mock while failing against ssh2.
          if (/^ssh-(rsa|ed25519)\s/.test(text)) {
            if (!/^ssh-(rsa|ed25519) [A-Za-z0-9+/]{40,}={0,2}(\s|$)/.test(text)) {
              return new Error("Malformed OpenSSH public key");
            }
            return { type: "ssh-ed25519", getPrivatePEM() { return null; } };
          }
          return {
            type: "ssh-rsa",
            getPrivatePEM() {
              return "-----BEGIN RSA PRIVATE KEY-----\n";
            },
          };
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Fail by default. Cleared only after the async block below has run to
// completion, so a hang or an early return can no longer exit 0 with the
// assertions silently unexecuted.
process.exitCode = 1;

require("../service/service.js");

// The service installs process-level safety nets so one handler's bug cannot
// kill every SSH session. Verify they exist, then drop them: inside the test
// runner they would swallow assertion failures and turn a red run green.
assert(
  process.listenerCount("uncaughtException") > 0,
  "service should install an uncaughtException guard",
);
assert(
  process.listenerCount("unhandledRejection") > 0,
  "service should install an unhandledRejection guard",
);
process.removeAllListeners("uncaughtException");
process.removeAllListeners("unhandledRejection");

const service = FakeService.instances[0];
assert(service, "service should be created");

const connect = service.handlers.get("connect");
const attach = service.handlers.get("attach");
const write = service.handlers.get("write");
const resize = service.handlers.get("resize");
const disconnect = service.handlers.get("disconnect");
const listSessions = service.handlers.get("sessions/list");
const debugInfo = service.handlers.get("debug/info");
const debugLogs = service.handlers.get("debug/logs");
const debugClear = service.handlers.get("debug/clear");
const debugEnable = service.handlers.get("debug/enable");
const debugDisable = service.handlers.get("debug/disable");
const debugEvent = service.handlers.get("debug/event");

assert(connect, "connect handler should be registered");
assert(attach, "attach handler should be registered");
assert(listSessions, "sessions/list handler should be registered");
assert(debugInfo, "debug/info handler should be registered");
assert(debugLogs, "debug/logs handler should be registered");
assert(debugClear, "debug/clear handler should be registered");
assert(debugEnable, "debug/enable handler should be registered");
assert(debugDisable, "debug/disable handler should be registered");
assert(debugEvent, "debug/event handler should be registered");
assert.strictEqual(typeof connect.cancelHandler, "function");

// Shell output is coalesced behind a short flush timer in the service, so
// data/replay effects are asynchronous — wait past the flush window before
// asserting on them.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FLUSH_WAIT_MS = 30;

function makeMessage(payload, token) {
  const responses = [];
  return {
    uniqueToken: token,
    payload,
    responses,
    respond(body) {
      responses.push(body);
    },
  };
}

// A genuine ed25519 public key line. ssh2 parses this successfully but
// getPrivatePEM() returns null — which is exactly the shape the service has to
// reject, since handing it to Client.connect() throws synchronously.
const PUBLIC_KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIC2G4KPmpyVNx5uvXtZ6wE/EyvUlDfBQ0BxelagOt/T user@host";

const connectPayload = {
  host: "example.test",
  port: 2222,
  user: "alice",
  cols: 132,
  rows: 43,
  auth: { type: "password", password: "secret" },
};

{
  const clearReply = [];
  debugClear.requestHandler({
    payload: {},
    respond(body) {
      clearReply.push(body);
    },
  });
  assert.strictEqual(clearReply[0].returnValue, true);

  debugEvent.requestHandler({
    payload: {
      event: "test_disabled_debug",
      details: { visible: "not written" },
    },
    respond() {},
  });

  const disabledInfoReply = [];
  debugInfo.requestHandler({
    payload: {},
    respond(body) {
      disabledInfoReply.push(body);
    },
  });
  assert.strictEqual(disabledInfoReply[0].enabled, false);

  const disabledLogsReply = [];
  debugLogs.requestHandler({
    payload: { maxBytes: 65536 },
    respond(body) {
      disabledLogsReply.push(body);
    },
  });
  assert.strictEqual(disabledLogsReply[0].returnValue, true);
  assert.strictEqual(disabledLogsReply[0].enabled, false);
  assert.doesNotMatch(disabledLogsReply[0].log, /test_disabled_debug/);

  const enableReply = [];
  debugEnable.requestHandler({
    payload: {},
    respond(body) {
      enableReply.push(body);
    },
  });
  assert.strictEqual(enableReply[0].returnValue, true);
  assert.strictEqual(enableReply[0].enabled, true);

  debugEvent.requestHandler({
    payload: {
      event: "test_secret_sanitizer",
      details: {
        password: "secret-password",
        nested: { passphrase: "secret-passphrase" },
        visible: "safe",
      },
    },
    respond() {},
  });

  const infoReply = [];
  debugInfo.requestHandler({
    payload: {},
    respond(body) {
      infoReply.push(body);
    },
  });
  assert.strictEqual(infoReply[0].storageDir, tempStorage);
  assert.strictEqual(infoReply[0].logPath, path.join(tempStorage, "debug.log"));
  assert.strictEqual(infoReply[0].enabled, true);

  const logsReply = [];
  debugLogs.requestHandler({
    payload: { maxBytes: 65536 },
    respond(body) {
      logsReply.push(body);
    },
  });
  assert.strictEqual(logsReply[0].returnValue, true);
  assert.match(logsReply[0].log, /test_secret_sanitizer/);
  assert.match(logsReply[0].log, /\[redacted\]/);
  assert.doesNotMatch(logsReply[0].log, /secret-password/);
  assert.doesNotMatch(logsReply[0].log, /secret-passphrase/);

  const disableReply = [];
  debugDisable.requestHandler({
    payload: {},
    respond(body) {
      disableReply.push(body);
    },
  });
  assert.strictEqual(disableReply[0].returnValue, true);
  assert.strictEqual(disableReply[0].enabled, false);
}

{
  const message = makeMessage(connectPayload, "pending-token");

  assert.doesNotThrow(() => connect.requestHandler(message));
  const client = FakeClient.instances[0];

  assert.deepStrictEqual(message.responses[0], {
    returnValue: true,
    event: "status",
    sessionId: message.responses[0].sessionId,
    stage: "connecting",
  });
  const sessionId = message.responses[0].sessionId;
  assert(sessionId, "status response should include a session id");
  assert.strictEqual(client.connectedConfig.host, "example.test");
  assert.strictEqual(client.connectedConfig.port, 2222);
  assert.strictEqual(client.connectedConfig.username, "alice");
  assert.strictEqual(client.connectedConfig.password, "secret");
  assert.strictEqual(service.createdActivities.length, 1);
  assert.strictEqual(service.activityManager.idleTimeout, 3600);

  connect.cancelHandler({ uniqueToken: "pending-token" });

  assert.strictEqual(client.ended, false);
  assert.strictEqual(message.responses.length, 1);

  const listReply = [];
  listSessions.requestHandler({
    payload: {},
    respond(body) {
      listReply.push(body);
    },
  });
  assert.strictEqual(listReply[0].sessions.length, 1);
  assert.strictEqual(listReply[0].sessions[0].id, sessionId);
  assert.strictEqual(listReply[0].sessions[0].stage, "connecting");
  assert.strictEqual(listReply[0].sessions[0].subscribers, 0);

  const disconnectReply = [];
  disconnect.requestHandler({
    payload: { sessionId },
    respond(body) {
      disconnectReply.push(body);
    },
  });
  assert.deepStrictEqual(disconnectReply[0], { returnValue: true });
  assert.strictEqual(client.ended, true);
  assert.strictEqual(service.completedActivities.length, 1);
  assert.strictEqual(service.activityManager.idleTimeout, 5);
}

{
  // Caller guard: senders outside our app id are denied; our own app id and
  // anonymous (no sender — root luna-send) callers pass.
  const denied = [];
  listSessions.requestHandler({
    payload: {},
    sender: "com.evil.app",
    respond(b) { denied.push(b); },
  });
  assert.strictEqual(denied[0].returnValue, false);
  assert.strictEqual(denied[0].errorCode, "CALLER_DENIED");

  const allowed = [];
  listSessions.requestHandler({
    payload: {},
    sender: "com.pwntastic.sshclient",
    respond(b) { allowed.push(b); },
  });
  assert.strictEqual(allowed[0].returnValue, true);

  // luna-send (root/devmode only) registers as com.webos.lunasend-<pid>.
  const lunaSend = [];
  listSessions.requestHandler({
    payload: {},
    sender: "com.webos.lunasend-12345",
    respond(b) { lunaSend.push(b); },
  });
  assert.strictEqual(lunaSend[0].returnValue, true);

  // EVERY registered method must sit behind the gate. With handlers spread
  // over several files, a single direct service.register() call would
  // silently drop the gate for that method — this loop makes that impossible
  // to miss. A foreign sender must get CALLER_DENIED from all of them.
  for (const [methodName, entry] of service.handlers) {
    const replies = [];
    entry.requestHandler({
      payload: {},
      sender: "com.evil.app",
      isSubscription: true,
      respond(b) { replies.push(b); },
    });
    assert(
      replies.length >= 1 &&
        replies[0].returnValue === false &&
        replies[0].errorCode === "CALLER_DENIED",
      `method "${methodName}" must deny foreign callers, got ${JSON.stringify(replies[0])}`,
    );
  }
}

{
  // Encrypted key without a stored passphrase: accepted at add time, and
  // connect demands the passphrase instead of failing with BAD_KEY.
  const keysAdd = service.handlers.get("keys/add");
  const keysRemove = service.handlers.get("keys/remove");
  assert(keysAdd && keysRemove, "keys handlers should be registered");

  const addReply = [];
  keysAdd.requestHandler({
    payload: {
      label: "enc-test",
      privateKeyPem:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nENCRYPTED\n-----END OPENSSH PRIVATE KEY-----",
    },
    respond(b) { addReply.push(b); },
  });
  assert.strictEqual(addReply[0].returnValue, true);
  assert.strictEqual(addReply[0].encrypted, true);
  assert.strictEqual(addReply[0].passphraseStored, false);
  const encKeyId = addReply[0].id;

  const noPass = makeMessage(
    { host: "h.test", port: 22, user: "u", auth: { type: "publickey", keyId: encKeyId } },
    "enc-nopass-token",
  );
  connect.requestHandler(noPass);
  const passFail = noPass.responses.find((r) => r.returnValue === false);
  assert(passFail, "connect without passphrase should fail");
  assert.strictEqual(passFail.errorCode, "PASSPHRASE_REQUIRED");

  const withPass = makeMessage(
    {
      host: "h.test",
      port: 22,
      user: "u",
      auth: { type: "publickey", keyId: encKeyId, passphrase: "pw" },
    },
    "enc-pass-token",
  );
  const clientsBefore = FakeClient.instances.length;
  connect.requestHandler(withPass);
  assert.strictEqual(FakeClient.instances.length, clientsBefore + 1);
  const passClient = FakeClient.instances[FakeClient.instances.length - 1];
  // ssh2 is handed the ALREADY DECRYPTED PEM, not the encrypted key plus its
  // passphrase: it re-parses whatever it gets inside connect(), and repeating
  // the bcrypt-pbkdf derivation would block this single-threaded process — and
  // therefore every other live SSH session — for a second time.
  assert.strictEqual(
    passClient.connectedConfig.passphrase,
    undefined,
    "no passphrase should be handed to ssh2 once the key is decrypted",
  );
  assert.match(
    String(passClient.connectedConfig.privateKey),
    /BEGIN RSA PRIVATE KEY/,
    "the decrypted PEM should be passed through",
  );
  const encSessionId = withPass.responses[0].sessionId;
  disconnect.requestHandler({ payload: { sessionId: encSessionId }, respond() {} });

  const removeReply = [];
  keysRemove.requestHandler({
    payload: { id: encKeyId },
    respond(b) { removeReply.push(b); },
  });
  assert.strictEqual(removeReply[0].returnValue, true);
}

{
  // Trust-on-first-use host key verification.
  const message = makeMessage(connectPayload, "hostkey-token");
  connect.requestHandler(message);
  const client = FakeClient.instances[FakeClient.instances.length - 1];
  const verifier = client.connectedConfig.hostVerifier;
  assert.strictEqual(typeof verifier, "function", "hostVerifier should be set");
  assert.strictEqual(verifier(Buffer.from("host-key-A")), true, "first key pins");
  assert.strictEqual(verifier(Buffer.from("host-key-A")), true, "same key passes");
  assert.strictEqual(verifier(Buffer.from("host-key-B")), false, "changed key fails");
  client.emit("error", new Error("Host verification failed"));
  const failure = message.responses.find((r) => r.returnValue === false);
  assert(failure, "mismatch should fail the session");
  assert.strictEqual(failure.errorCode, "HOST_KEY_MISMATCH");
  assert.match(failure.errorText, /HOST KEY CHANGED/);

  const knownList = service.handlers.get("knownhosts/list");
  const knownRemove = service.handlers.get("knownhosts/remove");
  assert(knownList && knownRemove, "knownhosts handlers should be registered");
  const listReply = [];
  knownList.requestHandler({ payload: {}, respond(b) { listReply.push(b); } });
  assert(listReply[0].hosts["example.test:2222"], "pinned host should be listed");
  const removeReply = [];
  knownRemove.requestHandler({
    payload: { host: "example.test", port: 2222 },
    respond(b) { removeReply.push(b); },
  });
  assert.strictEqual(removeReply[0].returnValue, true);
  const listReply2 = [];
  knownList.requestHandler({ payload: {}, respond(b) { listReply2.push(b); } });
  assert(!listReply2[0].hosts["example.test:2222"], "removed host should be gone");
}

{
  // A corrupt known_hosts.json must NOT be treated as "nothing pinned yet":
  // that would silently re-pin whatever key the server presents and quietly
  // undo trust-on-first-use for every host.
  const knownHostsFile = path.join(tempStorage, "known_hosts.json");
  const message = makeMessage(connectPayload, "corrupt-knownhosts-token");
  connect.requestHandler(message);
  const client = FakeClient.instances[FakeClient.instances.length - 1];
  const verifier = client.connectedConfig.hostVerifier;
  assert.strictEqual(verifier(Buffer.from("host-key-A")), true, "first key pins");

  fs.writeFileSync(knownHostsFile, "{ truncated");
  const corruptMessage = makeMessage(connectPayload, "corrupt-knownhosts-2");
  connect.requestHandler(corruptMessage);
  const corruptClient = FakeClient.instances[FakeClient.instances.length - 1];
  assert.strictEqual(
    corruptClient.connectedConfig.hostVerifier(Buffer.from("attacker-key")),
    false,
    "a corrupt pin store must fail closed, not relearn",
  );
  // The recovery handlers must stay usable while the file is broken.
  const listReply = [];
  service.handlers.get("knownhosts/list").requestHandler({
    payload: {},
    respond(b) { listReply.push(b); },
  });
  assert.strictEqual(listReply[0].returnValue, true);

  // ...and knownhosts/remove must REPAIR an unreadable store rather than
  // reporting NOT_FOUND. Fail-closed verification means a corrupt file blocks
  // every host, so if the one in-app escape hatch refused to touch it, the app
  // could never connect to anything again without a root shell.
  const repairReply = [];
  service.handlers.get("knownhosts/remove").requestHandler({
    payload: { host: "whatever.test", port: 22 },
    respond(b) { repairReply.push(b); },
  });
  assert.strictEqual(repairReply[0].returnValue, true);
  assert.strictEqual(repairReply[0].repaired, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(knownHostsFile, "utf8")), {});

  // With a readable store again, a genuine connect pins normally.
  const healedMessage = makeMessage(connectPayload, "healed-knownhosts");
  connect.requestHandler(healedMessage);
  const healedClient = FakeClient.instances[FakeClient.instances.length - 1];
  assert.strictEqual(
    healedClient.connectedConfig.hostVerifier(Buffer.from("host-key-C")),
    true,
    "a repaired store pins on first contact again",
  );
  disconnect.requestHandler({
    payload: { sessionId: healedMessage.responses[0].sessionId },
    respond() {},
  });
  fs.rmSync(knownHostsFile, { force: true });
  disconnect.requestHandler({
    payload: { sessionId: message.responses[0].sessionId },
    respond() {},
  });
  disconnect.requestHandler({
    payload: { sessionId: corruptMessage.responses[0].sessionId },
    respond() {},
  });
}

{
  // A public key parses fine but has no private material. ssh2's connect()
  // throws synchronously on it, which would kill the whole service process —
  // so it must be rejected when the key is stored.
  const keysAdd = service.handlers.get("keys/add");
  const reply = [];
  keysAdd.requestHandler({
    payload: { label: "pub", privateKeyPem: PUBLIC_KEY_LINE },
    respond(b) { reply.push(b); },
  });
  assert.strictEqual(reply[0].returnValue, false);
  assert.strictEqual(reply[0].errorCode, "NOT_A_PRIVATE_KEY");

  // Malformed material must take the BAD_KEY path instead, matching ssh2.
  const malformed = [];
  keysAdd.requestHandler({
    payload: { label: "junk", privateKeyPem: "ssh-ed25519 AAAAC3Nza user@host" },
    respond(b) { malformed.push(b); },
  });
  assert.strictEqual(malformed[0].returnValue, false);
  assert.strictEqual(malformed[0].errorCode, "BAD_KEY");
}

{
  // A wrong passphrase must fail this one connect, not throw out of the
  // handler (which would take every other live session down with it).
  const keysAdd = service.handlers.get("keys/add");
  const addReply = [];
  keysAdd.requestHandler({
    payload: {
      label: "enc-badpass",
      privateKeyPem:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nENCRYPTED\n-----END OPENSSH PRIVATE KEY-----",
    },
    respond(b) { addReply.push(b); },
  });
  const keyId = addReply[0].id;
  const clientsBefore = FakeClient.instances.length;
  const message = makeMessage(
    {
      host: "h.test",
      port: 22,
      user: "u",
      auth: { type: "publickey", keyId, passphrase: "wrong" },
    },
    "bad-passphrase-token",
  );
  connect.requestHandler(message);
  const failure = message.responses.find((r) => r.returnValue === false);
  assert(failure, "a wrong passphrase should fail the connect");
  assert.strictEqual(failure.errorCode, "BAD_PASSPHRASE");
  assert.strictEqual(
    FakeClient.instances.length,
    clientsBefore,
    "no ssh2 client should be constructed for an unusable key",
  );
  service.handlers.get("keys/remove").requestHandler({
    payload: { id: keyId },
    respond() {},
  });
}

(async () => {
  const message = makeMessage(connectPayload, "ready-token");

  connect.requestHandler(message);
  const client = FakeClient.instances[FakeClient.instances.length - 1];
  client.emit("ready");

  const ready = message.responses.find((response) => response.event === "ready");
  assert(ready, "ready response should be emitted");
  assert.strictEqual(client.shellOptions.term, "xterm-256color");
  assert.strictEqual(client.shellOptions.cols, 132);
  assert.strictEqual(client.shellOptions.rows, 43);

  const writeReply = [];
  write.requestHandler({
    payload: { sessionId: ready.sessionId, data: "uptime\n" },
    respond(body) {
      writeReply.push(body);
    },
  });
  assert.deepStrictEqual(writeReply[0], { returnValue: true });
  assert.deepStrictEqual(client.stream.writes, ["uptime\n"]);

  const resizeReply = [];
  resize.requestHandler({
    payload: { sessionId: ready.sessionId, cols: 100, rows: 30 },
    respond(body) {
      resizeReply.push(body);
    },
  });
  assert.deepStrictEqual(resizeReply[0], { returnValue: true });
  assert.deepStrictEqual(client.stream.window, {
    rows: 30,
    cols: 100,
    height: 0,
    width: 0,
  });

  // The clamp is a sanity bound, not a minimum useful size. Its floor sits at
  // xterm's own grid minimum so a legitimately small window (dragged to 240px
  // with a 28px font can fit fewer than 5 rows) is reported truthfully —
  // over-reporting would leave the remote drawing a line the viewport cannot
  // show. Guarding against a collapsed 0x0 layout is the client's job.
  const smallReply = [];
  resize.requestHandler({
    payload: { sessionId: ready.sessionId, cols: 40, rows: 4 },
    respond(body) { smallReply.push(body); },
  });
  assert.deepStrictEqual(smallReply[0], { returnValue: true });
  assert.deepStrictEqual(client.stream.window, {
    rows: 4,
    cols: 40,
    height: 0,
    width: 0,
  });

  // Absurd values are still rejected rather than forwarded to the pty.
  const absurdReply = [];
  resize.requestHandler({
    payload: { sessionId: ready.sessionId, cols: 99999, rows: -5 },
    respond(body) { absurdReply.push(body); },
  });
  assert.deepStrictEqual(absurdReply[0], { returnValue: true });
  assert.deepStrictEqual(client.stream.window, {
    rows: 1,
    cols: 500,
    height: 0,
    width: 0,
  });
  resize.requestHandler({
    payload: { sessionId: ready.sessionId, cols: 100, rows: 30 },
    respond() {},
  });

  connect.cancelHandler({ uniqueToken: "ready-token" });
  const responseCountAfterDetach = message.responses.length;
  client.stream.emit("data", Buffer.from("hello from buffer\n"));
  await delay(FLUSH_WAIT_MS);
  assert.strictEqual(message.responses.length, responseCountAfterDetach);

  const attachMessage = makeMessage({ sessionId: ready.sessionId }, "attach-token");
  attach.requestHandler(attachMessage);
  assert.strictEqual(attachMessage.responses[0].event, "attached");
  assert.strictEqual(attachMessage.responses[0].session.id, ready.sessionId);
  assert.strictEqual(attachMessage.responses[1].event, "status");
  assert.strictEqual(attachMessage.responses[1].stage, "ready");
  assert.strictEqual(attachMessage.responses[2].event, "replay");
  assert.strictEqual(attachMessage.responses[2].data, "hello from buffer\n");
  assert.strictEqual(attachMessage.responses[3].event, "ready");

  client.stream.emit("data", Buffer.from("live output\n"));
  await delay(FLUSH_WAIT_MS);
  assert.strictEqual(
    attachMessage.responses[attachMessage.responses.length - 1].data,
    "live output\n",
  );

  // A multibyte char split across chunks must arrive intact (StringDecoder).
  const umlaut = Buffer.from("ä", "utf8");
  client.stream.emit("data", umlaut.subarray(0, 1));
  client.stream.emit("data", umlaut.subarray(1));
  await delay(FLUSH_WAIT_MS);
  assert.strictEqual(
    attachMessage.responses[attachMessage.responses.length - 1].data,
    "ä",
  );

  // Mouse reporting has to survive the replay ring dropping the sequence that
  // switched it on. tmux emits it once when it first attaches; a client that
  // reloads hours later replays only the tail, and without a restore it comes
  // up with clicks silently dead while tmux still believes they work.
  client.stream.emit("data", Buffer.from("\x1b[?1000h\x1b[?1006h"));
  // More than OUTPUT_BUFFER_LIMIT in one go, so the enable sequence is gone
  // from the ring rather than merely old.
  client.stream.emit("data", Buffer.from("x".repeat(1024 * 1024 + 4096)));
  await delay(FLUSH_WAIT_MS);
  const modeMessage = makeMessage({ sessionId: ready.sessionId }, "modes-token");
  attach.requestHandler(modeMessage);
  const modeReplay = modeMessage.responses.find((r) => r.event === "replay");
  assert(modeReplay, "attach should replay buffered output");
  const MODE_RESTORE = "\x1b[?1000h\x1b[?1006h";
  assert.ok(
    modeReplay.data.endsWith(MODE_RESTORE),
    "replay should end with the restored modes",
  );
  assert.ok(
    !modeReplay.data.slice(0, -MODE_RESTORE.length).includes("\x1b[?1000h"),
    "the ring should have dropped the original enable sequence",
  );
  const modeAttached = modeMessage.responses.find((r) => r.event === "attached");
  assert.deepStrictEqual(modeAttached.session.terminalModes, [1000, 1006]);
  attach.cancelHandler({ uniqueToken: "modes-token" });

  attach.cancelHandler({ uniqueToken: "attach-token" });
  const responseCountAfterAttachDetach = attachMessage.responses.length;
  client.stream.emit("data", Buffer.from("detached again\n"));
  await delay(FLUSH_WAIT_MS);
  assert.strictEqual(attachMessage.responses.length, responseCountAfterAttachDetach);

  // Reaping: a session with no attached client is closed after
  // SSHCLIENT_REAP_MS (1000ms here) by the periodic reap check.
  const reapMessage = makeMessage(connectPayload, "reap-token");
  connect.requestHandler(reapMessage);
  const reapClient = FakeClient.instances[FakeClient.instances.length - 1];
  reapClient.emit("ready");
  const reapReady = reapMessage.responses.find((r) => r.event === "ready");
  assert(reapReady, "reap-test session should become ready");
  connect.cancelHandler({ uniqueToken: "reap-token" });
  await delay(1300);
  const reapList = [];
  listSessions.requestHandler({
    payload: {},
    respond(b) { reapList.push(b); },
  });
  assert(
    !reapList[0].sessions.some((s) => s.id === reapReady.sessionId),
    "idle detached session should be reaped",
  );
  assert.strictEqual(reapClient.ended, true, "reaped session should end the client");
})().then(
  () => {
    Module._load = originalLoad;
    fs.rmSync(tempStorage, { recursive: true, force: true });
    process.exitCode = 0;
    console.log("service-connect tests passed");
  },
  (err) => {
    Module._load = originalLoad;
    fs.rmSync(tempStorage, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  },
);
