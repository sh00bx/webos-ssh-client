// keys/* and knownhosts/* Luna methods.
const fs = require("fs");
const path = require("path");
const { utils: { parseKey } } = require("ssh2");
const { KEYS_DIR } = require("../config");
const { ensureStorage } = require("../storage");
const { genId } = require("../util");
const { debugLog } = require("../debug-log");
const { loadMeta, saveMeta, hasPrivateMaterial } = require("../keystore");
const {
  loadKnownHosts,
  loadKnownHostsSafe,
  saveKnownHosts,
} = require("../known-hosts");

function registerKeysMethods(register) {
  register("keys/list", (message) => {
    message.respond({ returnValue: true, keys: loadMeta() });
  });

  register("keys/add", (message) => {
    const { label, privateKeyPem, passphrase } = message.payload || {};
    if (!label || !privateKeyPem) {
      return message.respond({
        returnValue: false,
        errorCode: "BAD_PARAMS",
        errorText: "label and privateKeyPem required",
      });
    }
    const parsed = parseKey(privateKeyPem, passphrase || undefined);
    let keyType = null;
    let encrypted = false;
    if (parsed instanceof Error) {
      // An encrypted key without its passphrase cannot be parsed — accept it
      // anyway and mark it encrypted, so the passphrase can be supplied on the
      // connect form each time instead of having to be stored beside the key.
      if (!passphrase && /encrypt|passphrase/i.test(parsed.message || "")) {
        encrypted = true;
      } else {
        return message.respond({
          returnValue: false,
          errorCode: "BAD_KEY",
          errorText: parsed.message,
        });
      }
    } else {
      // A public key parses successfully but carries no private material. Storing
      // it looks fine here and then makes every connect attempt throw inside
      // ssh2 — reject it at the door instead.
      if (!hasPrivateMaterial(parsed)) {
        return message.respond({
          returnValue: false,
          errorCode: "NOT_A_PRIVATE_KEY",
          errorText:
            "that is a public key — paste the matching private key (the file without the .pub suffix)",
        });
      }
      keyType = Array.isArray(parsed) ? parsed[0].type : parsed.type;
      // Only mark the key encrypted when it genuinely cannot be parsed without
      // the passphrase (a passphrase supplied for a plain key is ignored).
      if (passphrase) {
        encrypted = parseKey(privateKeyPem) instanceof Error;
      }
    }
    const id = genId();
    const pemPath = path.join(KEYS_DIR, id + ".pem");
    const passPath = path.join(KEYS_DIR, id + ".pass");
    // Storage lives on the shared /media/internal volume, so ENOSPC/EROFS are
    // real. Without this guard the throw escapes the handler and kills the
    // service (and every live session); a half-written key would also be left
    // behind with no metadata, invisible to keys/list and undeletable.
    try {
      ensureStorage();
      fs.writeFileSync(pemPath, privateKeyPem, { mode: 0o600 });
      if (passphrase) {
        fs.writeFileSync(passPath, passphrase, { mode: 0o600 });
      }
      const meta = loadMeta();
      meta.push({
        id,
        label: String(label),
        type: keyType || "encrypted",
        encrypted,
      });
      saveMeta(meta);
    } catch (e) {
      debugLog("keys_add_failed", { error: e });
      for (const orphan of [pemPath, passPath]) {
        try {
          if (fs.existsSync(orphan)) fs.unlinkSync(orphan);
        } catch (e2) {
          /* best effort — never mask the original failure */
        }
      }
      return message.respond({
        returnValue: false,
        errorCode: "SAVE_FAILED",
        errorText: e.message || String(e),
      });
    }
    message.respond({
      returnValue: true,
      id,
      type: keyType,
      encrypted,
      passphraseStored: Boolean(passphrase),
    });
  });

  register("keys/remove", (message) => {
    const { id } = message.payload || {};
    if (!id) {
      return message.respond({ returnValue: false, errorCode: "BAD_PARAMS" });
    }
    let meta = loadMeta();
    const before = meta.length;
    meta = meta.filter((k) => k.id !== id);
    if (meta.length === before) {
      return message.respond({ returnValue: false, errorCode: "NOT_FOUND" });
    }
    try {
      saveMeta(meta);
    } catch (e) {
      debugLog("keys_remove_failed", { error: e });
      return message.respond({
        returnValue: false,
        errorCode: "SAVE_FAILED",
        errorText: e.message || String(e),
      });
    }
    for (const ext of [".pem", ".pass"]) {
      const p = path.join(KEYS_DIR, id + ext);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { /* noop */ }
      }
    }
    message.respond({ returnValue: true });
  });

  register("knownhosts/list", (message) => {
    message.respond({ returnValue: true, hosts: loadKnownHostsSafe() });
  });

  // Forget a pinned host key (e.g. after a legitimate server reinstall). The
  // next connect re-pins via trust-on-first-use.
  register("knownhosts/remove", (message) => {
    const params = message.payload || {};
    const host = String(params.host || "").trim();
    const port = Number(params.port) || 22;
    if (!host) {
      return message.respond({
        returnValue: false,
        errorCode: "BAD_PARAMS",
        errorText: "host required",
      });
    }
    const hostId = `${host}:${port}`;
    // This is the repair path, so it must cope with a store it cannot read. An
    // unreadable file makes the host verifier refuse EVERY host (fail-closed,
    // by design) — if this handler then reported NOT_FOUND and left the bytes
    // alone, the app would be permanently unable to connect to anything with no
    // way out but a root shell. Resetting the store is safe: losing pins
    // degrades to trust-on-first-use, which is exactly what the user is asking
    // for here.
    let hosts;
    let repaired = false;
    try {
      hosts = loadKnownHosts();
    } catch (e) {
      debugLog("knownhosts_reset_unreadable", { hostId, error: e });
      hosts = {};
      repaired = true;
    }
    if (!repaired && !hosts[hostId]) {
      return message.respond({ returnValue: false, errorCode: "NOT_FOUND" });
    }
    delete hosts[hostId];
    try {
      saveKnownHosts(hosts);
    } catch (e) {
      return message.respond({
        returnValue: false,
        errorCode: "SAVE_FAILED",
        errorText: e.message || String(e),
      });
    }
    debugLog("hostkey_removed", { hostId, repaired });
    message.respond({ returnValue: true, removed: hostId, repaired });
  });
}

module.exports = { registerKeysMethods };
