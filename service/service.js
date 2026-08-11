// Service entry point: wiring only. The functionality lives under lib/ —
// see lib/bus.js (caller gate), lib/sessions.js (registry), lib/ssh-session.js
// (connect/attach), lib/keystore.js + lib/known-hosts.js (storage), and the
// handler groups under lib/handlers/.
//
// NOTE for deploys: scripts/build.sh must stage service/lib/ alongside this
// file — a missing lib/ passes every local check and then kills the service
// on the TV with MODULE_NOT_FOUND at the first Luna call.
const { STORAGE_DIR, DEBUG_LOG_FILE, SESSION_REAP_CHECK_MS } = require("./lib/config");
const { migrateLegacyStorage } = require("./lib/storage");
const { debugLog } = require("./lib/debug-log");
const { register } = require("./lib/bus");
const { initKeepAlive } = require("./lib/keepalive");
const { sessions, reapIdleSessions } = require("./lib/sessions");
const { registerSessionMethods } = require("./lib/handlers/sessions-methods");
const { registerDebugMethods } = require("./lib/handlers/debug-methods");
const { registerKeysMethods } = require("./lib/handlers/keys-methods");
const { registerFilesMethods } = require("./lib/handlers/files-methods");
const { registerBackdrop } = require("./lib/backdrop");

// Must run before any handler can read keys.json / known_hosts.json.
migrateLegacyStorage();

initKeepAlive({ countActiveSessions: () => sessions.size });

debugLog("service_start", {
  storageDir: STORAGE_DIR,
  debugLogFile: DEBUG_LOG_FILE,
  node: process.version,
});

// Last-resort net. Every session in this process shares one node runtime, so a
// throw in any single Luna handler would otherwise kill sessions that have
// nothing to do with it (the user's long-running background shell dies because
// someone mistyped a passphrase). Individual handlers still do their own error
// handling — this only stops one bug from reaping everything.
process.on("uncaughtException", (err) => {
  debugLog("uncaught_exception", { error: err });
  console.error("[sshclient] uncaught exception", (err && err.stack) || err);
});
process.on("unhandledRejection", (reason) => {
  debugLog("unhandled_rejection", { error: reason });
  console.error("[sshclient] unhandled rejection", reason);
});

const reapTimer = setInterval(reapIdleSessions, SESSION_REAP_CHECK_MS);
if (reapTimer && typeof reapTimer.unref === "function") reapTimer.unref();

registerSessionMethods(register);
registerDebugMethods(register);
registerKeysMethods(register);
registerFilesMethods(register);
registerBackdrop(register);

register("ping", (message) => {
  message.respond({ returnValue: true, pong: Date.now() });
});
