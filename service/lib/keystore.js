// Stored private keys: metadata, key files, and the auth-time loader.
const fs = require("fs");
const path = require("path");
const { utils: { parseKey } } = require("ssh2");
const { KEYS_DIR, META_FILE } = require("./config");
const { ensureStorage, writeJsonAtomic } = require("./storage");

function loadMeta() {
  try {
    ensureStorage();
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveMeta(arr) {
  ensureStorage();
  writeJsonAtomic(META_FILE, arr);
}

// True when parseKey returned something that actually carries private key
// material. A *public* key parses fine (type is set) but has no private PEM —
// ssh2 rejects it, and it must never reach client.connect() (see below).
function hasPrivateMaterial(parsed) {
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || typeof key.getPrivatePEM !== "function") return false;
  try {
    return key.getPrivatePEM() !== null;
  } catch (e) {
    return false;
  }
}

// The decrypted PEM of a parsed key, or null if this parser build does not
// expose one (then the caller falls back to handing over the raw material).
function decryptedPrivatePem(parsed) {
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || typeof key.getPrivatePEM !== "function") return null;
  try {
    const pem = key.getPrivatePEM();
    return typeof pem === "string" && pem ? pem : null;
  } catch (e) {
    return null;
  }
}

function loadKeyForAuth(keyId, frontendPassphrase) {
  const meta = loadMeta().find((k) => k.id === keyId);
  if (!meta) return { error: "NO_KEY" };
  const keyPath = path.join(KEYS_DIR, keyId + ".pem");
  const passPath = path.join(KEYS_DIR, keyId + ".pass");
  if (!fs.existsSync(keyPath)) return { error: "NO_KEY_FILE" };
  const privateKey = fs.readFileSync(keyPath);
  let passphrase;
  if (fs.existsSync(passPath)) {
    passphrase = fs.readFileSync(passPath, "utf8");
  } else if (frontendPassphrase) {
    passphrase = String(frontendPassphrase);
  }
  if (meta.encrypted && !passphrase) {
    return {
      error: "PASSPHRASE_REQUIRED",
      errorText:
        "the key is encrypted and no passphrase is stored — enter it in the passphrase field",
    };
  }
  // Parse here rather than letting ssh2 do it inside connect(): ssh2's
  // Client.connect() THROWS synchronously on an unparseable key (wrong
  // passphrase) or one without private material (a .pub pasted by mistake).
  // That throw escapes the Luna handler and kills the whole service process —
  // taking every other live SSH session with it. Failing softly here keeps the
  // blast radius at this one connect attempt.
  const parsed = parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    return {
      error: "BAD_PASSPHRASE",
      errorText: `the key could not be decrypted — wrong passphrase? (${parsed.message})`,
    };
  }
  if (!hasPrivateMaterial(parsed)) {
    return {
      error: "NOT_A_PRIVATE_KEY",
      errorText:
        "the stored key contains no private key material — a public key was probably added instead of the private one",
    };
  }
  // Hand ssh2 the ALREADY DECRYPTED PEM rather than the encrypted bytes plus
  // the passphrase. ssh2 re-parses whatever it is given inside connect(); with
  // the original material that would run the pure-JS bcrypt-pbkdf derivation a
  // second time, and since every session shares this one single-threaded
  // process, that KDF blocks output and keystrokes for every OTHER live
  // session too.
  const decryptedPem = decryptedPrivatePem(parsed);
  if (decryptedPem) return { privateKey: decryptedPem };
  return { privateKey, passphrase };
}

module.exports = {
  loadMeta,
  saveMeta,
  hasPrivateMaterial,
  loadKeyForAuth,
};
