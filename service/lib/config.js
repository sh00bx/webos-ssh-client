const fs = require("fs");
const path = require("path");
const { clampInt } = require("./util");

// Storage layout under STORAGE_DIR:
//   keys/<id>.pem   private key (mode 0600)
//   keys/<id>.pass  passphrase, if user opted to store one (mode 0600)
//   keys.json       metadata: [{id, label, type}]
//   known_hosts.json  pinned host key fingerprints
//
// IMPORTANT: the service's $HOME points INTO the app install directory
// (/media/developer/apps/.../services/...), which appinstalld replaces on
// every update — storing there silently wipes keys and pinned host keys on
// each deploy (observed live 2026-07-03). The devmode jail mounts only the
// own service dir, /tmp (tmpfs) and /media/internal (rw, ext4, persistent)
// — verified via /proc/<svc>/mounts on the TV. So /media/internal is the
// only update-surviving location. Tradeoff: it is shared with other devmode
// apps (same uid 5301), while the install dir is jail-private; persistence
// wins here since losing keys/pins on every deploy defeats TOFU entirely.
function pickStorageDir() {
  const candidates = [];
  if (process.env.SSHCLIENT_STORAGE_DIR) {
    candidates.push(process.env.SSHCLIENT_STORAGE_DIR);
  }
  candidates.push("/media/internal/.com.pwntastic.sshclient");
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".sshclient"));
  candidates.push("/tmp/.sshclient");
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      /* not writable here — try the next candidate */
    }
  }
  return "/tmp/.sshclient";
}
const STORAGE_DIR = pickStorageDir();

module.exports = {
  STORAGE_DIR,
  KEYS_DIR: path.join(STORAGE_DIR, "keys"),
  META_FILE: path.join(STORAGE_DIR, "keys.json"),
  KNOWN_HOSTS_FILE: path.join(STORAGE_DIR, "known_hosts.json"),
  DEBUG_LOG_FILE: path.join(STORAGE_DIR, "debug.log"),
  DEBUG_LOG_OLD_FILE: path.join(STORAGE_DIR, "debug.log.1"),
  DEBUG_LOG_LIMIT: 1024 * 1024,
  DEBUG_LOG_READ_LIMIT: 512 * 1024,
  SERVICE_STARTED_AT: Date.now(),
  DEBUG_ENABLED_BY_ENV: /^(1|true|yes|on)$/i.test(
    String(process.env.SSHCLIENT_DEBUG || ""),
  ),
  SECRET_KEY_RE: /password|passphrase|private.?key|pem|secret/i,
  KEEPALIVE_ACTIVITY_NAME: "openclaw.sshclient.active-session",
  ACTIVE_IDLE_TIMEOUT_SECONDS: 60 * 60,
  IDLE_IDLE_TIMEOUT_SECONDS: 5,
  // Only our own app (and anonymous root luna-send, which carries no sender
  // identity) may call the service. Other sideloaded apps/services always
  // arrive with their app id / service name in message.sender.
  CALLER_ID_PREFIX: "com.pwntastic.sshclient",
  // Reap background sessions that have had no attached client for a long time
  // so a forgotten shell doesn't hold the SSH connection (and the keepalive
  // activity) forever. Generous by design — surviving Hide/resume for hours is
  // the whole point of the background service. The env-var floors (1000 / 20)
  // are load-bearing: tests/service-connect.test.js sets exactly those values.
  SESSION_REAP_MS: clampInt(
    process.env.SSHCLIENT_REAP_MS,
    24 * 60 * 60 * 1000,
    1000,
    7 * 24 * 60 * 60 * 1000,
  ),
  SESSION_REAP_CHECK_MS: clampInt(
    process.env.SSHCLIENT_REAP_CHECK_MS,
    10 * 60 * 1000,
    20,
    60 * 60 * 1000,
  ),
  OUTPUT_BUFFER_LIMIT: 1024 * 1024,
};
