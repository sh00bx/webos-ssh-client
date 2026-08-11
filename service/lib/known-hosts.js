// Trust-on-first-use host key pinning.
const crypto = require("crypto");
const fs = require("fs");
const { KNOWN_HOSTS_FILE } = require("./config");
const { ensureLogStorage, writeJsonAtomic } = require("./storage");
const { debugLog } = require("./debug-log");

// Only a genuinely absent file means "nothing pinned yet". Any other failure
// (truncated/corrupt JSON, EIO, permissions) must NOT degrade to an empty map:
// the host verifier treats an empty map as first contact and would silently
// re-pin whatever key the server presents, turning one corrupted file into a
// silent downgrade of every host's TOFU pin. Throwing here reaches the
// verifier's catch, which fails the connection closed.
function loadKnownHosts() {
  let raw;
  try {
    raw = fs.readFileSync(KNOWN_HOSTS_FILE, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return {};
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("known_hosts.json is not an object");
  }
  return parsed;
}

// Read-only variant for knownhosts/list, which must stay answerable precisely
// when the file is broken — that is when the user needs to look at it.
function loadKnownHostsSafe() {
  try {
    return loadKnownHosts();
  } catch (e) {
    debugLog("knownhosts_load_failed", { error: e });
    return {};
  }
}

function saveKnownHosts(hosts) {
  ensureLogStorage();
  writeJsonAtomic(KNOWN_HOSTS_FILE, hosts);
}

function hostKeyFingerprint(key) {
  return (
    "SHA256:" +
    crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
  );
}

// The TOFU verifier for one connection attempt. The host key fingerprint is
// pinned on first contact and the handshake is refused when it later changes.
// ssh2 calls the verifier with the raw host key Buffer (no hostHash
// configured); a 1-arg function is treated as synchronous. getMismatch()
// carries the details into the client error handler, which turns them into
// the HOST_KEY_MISMATCH failure the UI explains to the user.
function createHostVerifier(hostId) {
  let mismatch = null;
  return {
    verifier(key) {
      try {
        const fingerprint = hostKeyFingerprint(key);
        const known = loadKnownHosts();
        const entry = known[hostId];
        if (!entry) {
          known[hostId] = { fingerprint, addedAt: Date.now() };
          saveKnownHosts(known);
          debugLog("hostkey_learned", { hostId, fingerprint });
          return true;
        }
        if (entry.fingerprint === fingerprint) return true;
        mismatch = { expected: entry.fingerprint, actual: fingerprint };
        debugLog("hostkey_mismatch", { hostId, mismatch });
        return false;
      } catch (e) {
        // A storage failure must not silently downgrade to accept-anything.
        mismatch = { storageError: e.message || String(e) };
        debugLog("hostkey_verify_failed", { hostId, error: e });
        return false;
      }
    },
    getMismatch() {
      return mismatch;
    },
  };
}

module.exports = {
  loadKnownHosts,
  loadKnownHostsSafe,
  saveKnownHosts,
  hostKeyFingerprint,
  createHostVerifier,
};
