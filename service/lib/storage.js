const fs = require("fs");
const path = require("path");
const { STORAGE_DIR, KEYS_DIR, META_FILE } = require("./config");

function ensureStorage() {
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, "[]", { mode: 0o600 });
  }
}

function ensureLogStorage() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
}

// Write via a temp file + rename so an interrupted write (power cut, ENOSPC on
// the shared /media/internal volume) can never leave a truncated JSON file
// behind. A plain writeFileSync truncates first, and a zero-length keys.json or
// known_hosts.json parses as "nothing stored" — which silently loses key
// metadata and, worse, drops every pinned host key (see known-hosts.js).
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// One-time migration from the legacy in-install-dir storage: copy key
// material and pinned hosts over if the new location does not have them yet.
// service.js calls this as its first statement after the requires — it must
// run before any handler can read keys.json / known_hosts.json.
function migrateLegacyStorage() {
  try {
    if (process.env.SSHCLIENT_STORAGE_DIR) return;
    const legacy = process.env.HOME
      ? path.join(process.env.HOME, ".sshclient")
      : null;
    if (!legacy || legacy === STORAGE_DIR || !fs.existsSync(legacy)) return;
    for (const name of ["keys.json", "known_hosts.json"]) {
      const src = path.join(legacy, name);
      const dst = path.join(STORAGE_DIR, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.writeFileSync(dst, fs.readFileSync(src), { mode: 0o600 });
      }
    }
    const legacyKeys = path.join(legacy, "keys");
    const dstKeys = path.join(STORAGE_DIR, "keys");
    if (fs.existsSync(legacyKeys)) {
      fs.mkdirSync(dstKeys, { recursive: true, mode: 0o700 });
      for (const file of fs.readdirSync(legacyKeys)) {
        const src = path.join(legacyKeys, file);
        const dst = path.join(dstKeys, file);
        if (!fs.existsSync(dst) && fs.statSync(src).isFile()) {
          fs.writeFileSync(dst, fs.readFileSync(src), { mode: 0o600 });
        }
      }
    }
  } catch (e) {
    /* best effort — never block service start on migration */
  }
}

module.exports = {
  ensureStorage,
  ensureLogStorage,
  writeJsonAtomic,
  migrateLegacyStorage,
};
