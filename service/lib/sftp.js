// The file-transfer half of a session: an SFTP channel on the SAME ssh2 client
// the shell is already using, plus the TV-local side of the exchange.
//
// WHY A CHANNEL AND NOT A SECOND CONNECTION. SSH multiplexes: one authenticated
// transport carries as many channels as you like, and SFTP is just another
// channel next to the shell's. Opening one costs a round trip and no
// authentication at all, which is the difference between an SCP tab appearing
// instantly and an SCP tab asking for the password again. It also means we do
// NOT have to keep credentials in memory after connect — the app deliberately
// stopped doing that, and re-dialling would have brought it straight back.
//
// The channel is opened lazily on first use and cached on the session, because
// most sessions never transfer a file, and torn down with the session (ssh2
// closes every channel when the client ends). A channel that dies on its own —
// a server-side sftp subsystem restart, a network blip — clears the cache so
// the next call opens a fresh one rather than failing forever.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const posix = path.posix;
const { debugLog } = require("./debug-log");

// The TV side of the exchange, and the only place on this device the app will
// read or write. It sits under /media/internal for the same reason the keystore
// does: the devmode jail mounts the service's own install directory (replaced
// wholesale on every update), /tmp (tmpfs, gone on reboot) and /media/internal
// (persistent ext4) — so this is the one location where a downloaded file is
// still there tomorrow. Being shared with other devmode apps is the point here
// rather than a tradeoff: a file the user pulled off a server is only useful if
// something else on the TV can open it.
const TV_ROOT = process.env.SSHCLIENT_FILES_DIR || "/media/internal/sshclient";

// Directory listings are capped. A remote `/usr/bin` is thousands of entries,
// every one of them crossing the Luna bus as JSON and then becoming a DOM node
// on a TV — and nobody navigates a 5000-entry list with a D-pad anyway. The
// response says so explicitly (`truncated`) rather than silently showing a
// prefix, because a missing file the user can SEE is missing is a different
// problem from one that simply is not there.
const LIST_LIMIT = 2000;

function tvRootReady() {
  try {
    fs.mkdirSync(TV_ROOT, { recursive: true, mode: 0o755 });
    return true;
  } catch (e) {
    debugLog("sftp_tv_root_fail", { dir: TV_ROOT, error: e });
    return false;
  }
}

// Resolve a caller-supplied TV path against the sandbox and refuse anything
// that lands outside it — LEXICALLY. path.resolve collapses "../" and pins
// absolute paths under TV_ROOT, which stops an escape the client can NAME: a
// traversal string, an absolute path from a client bug, an empty string
// resolving to the process cwd. What it cannot see is the filesystem itself —
// a symlink planted inside the sandbox pointing at / passes this check — which
// is why every actual operation goes through resolveTvPathReal below.
function resolveTvPath(input) {
  const raw = typeof input === "string" && input ? input : "/";
  // Treat the sandbox as the filesystem root from the client's point of view:
  // it never learns the real prefix, which also means a stored path stays valid
  // if TV_ROOT ever moves.
  const joined = path.resolve(TV_ROOT, "." + path.posix.resolve("/", raw));
  const rel = path.relative(TV_ROOT, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return joined;
}

// The lexical check above, then the filesystem's own answer. TV_ROOT sits on a
// world-writable devmode share and this service runs as root, so a symlink
// planted there by anything else on the TV must not turn "/escape/passwd" into
// /etc/passwd. After resolving lexically, ask fs.realpath what the path (or,
// for a path about to be created, its deepest EXISTING ancestor) actually is,
// and require that to still sit inside the realpath'd sandbox root.
//
// What this guarantees: at the moment of the check, no component of the path
// resolves outside the sandbox — a planted symlink is refused rather than
// followed, for reads, deletes and creates alike. What it does not attempt is
// closing the race between this check and the operation behind it; that would
// need O_NOFOLLOW-style plumbing the sftp/streams API here does not expose.
async function resolveTvPathReal(input) {
  const abs = resolveTvPath(input);
  if (abs === null) return null;
  if (!tvRootReady()) return null;
  let rootReal;
  try {
    rootReal = await fsp.realpath(path.resolve(TV_ROOT));
  } catch (e) {
    debugLog("sftp_tv_root_realpath_fail", { dir: TV_ROOT, error: e });
    return null;
  }
  let probe = abs;
  for (;;) {
    let real;
    try {
      real = await fsp.realpath(probe);
    } catch (e) {
      // Not there yet (mkdir, download destination): check the parent instead.
      const parent = path.dirname(probe);
      if (parent === probe) return null; // ran out of ancestors — refuse
      probe = parent;
      continue;
    }
    const rel = path.relative(rootReal, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return abs;
  }
}

// The path as the client should see it: sandbox-relative, always absolute-ish.
function tvDisplayPath(absolute) {
  const rel = path.relative(TV_ROOT, absolute);
  return "/" + (rel === "" ? "" : rel.split(path.sep).join("/"));
}

function resolveHostPath(input, home) {
  const raw = typeof input === "string" && input ? input : ".";
  if (raw === "~" || raw.startsWith("~/")) {
    return posix.resolve(home || "/", raw === "~" ? "." : raw.slice(2));
  }
  if (raw.startsWith("/")) return posix.resolve(raw);
  return posix.resolve(home || "/", raw);
}

// One SFTP channel per session, opened on demand.
function getSftp(session) {
  if (!session || !session.client) {
    return Promise.reject(Object.assign(new Error("no session"), { code: "NO_SESSION" }));
  }
  // A local session has no SSH transport to hang a channel on — its "client"
  // is the unix socket to ptyd, which speaks a five-frame terminal protocol and
  // nothing else. The UI never offers a files tab for one (see canBrowseFiles
  // in src/session-label.mjs), so reaching here means a stale tab or a direct
  // luna-send; either way, say what is actually wrong instead of letting
  // `session.client.sftp is not a function` escape as a generic failure.
  if (session.kind === "local" || typeof session.client.sftp !== "function") {
    return Promise.reject(
      Object.assign(new Error("file transfer needs an SSH session"), {
        code: "NO_SFTP",
      }),
    );
  }
  if (session.sftp) return Promise.resolve(session.sftp);
  if (session.sftpPending) return session.sftpPending;
  session.sftpPending = new Promise((resolve, reject) => {
    let settled = false;
    // ssh2 calls back with an error rather than throwing, but a client that is
    // mid-teardown can also simply never answer. Without this the SCP tab would
    // sit on a spinner for as long as the user left it there.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.sftpPending = null;
      reject(Object.assign(new Error("sftp open timed out"), { code: "SFTP_TIMEOUT" }));
    }, 15000);
    try {
      session.client.sftp((err, sftp) => {
        if (settled) {
          // The timeout already rejected this attempt — but the channel the
          // late success just opened is real, and nobody will ever hold it.
          // Close it, or every timed-out attempt leaks one sftp subsystem
          // channel for the life of the session.
          if (!err && sftp) {
            try {
              sftp.end();
            } catch (e) {
              /* channel already gone */
            }
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        session.sftpPending = null;
        if (err) {
          debugLog("sftp_open_fail", { sessionId: session.id, error: err });
          return reject(Object.assign(err, { code: err.code || "SFTP_OPEN_FAIL" }));
        }
        session.sftp = sftp;
        // Drop the cache when the channel goes away on its own, so the next
        // call opens a new one instead of writing into a dead pipe forever.
        const forget = () => {
          if (session.sftp === sftp) session.sftp = null;
        };
        sftp.on("close", forget);
        sftp.on("end", forget);
        sftp.on("error", (e) => {
          debugLog("sftp_channel_error", { sessionId: session.id, error: e });
          forget();
        });
        debugLog("sftp_open", { sessionId: session.id });
        resolve(sftp);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.sftpPending = null;
      reject(Object.assign(e, { code: "SFTP_OPEN_THREW" }));
    }
  });
  return session.sftpPending;
}

// The remote home directory, resolved once per session. Every relative path the
// client sends is interpreted against it, so an SCP tab opens where the shell
// would have.
function hostHome(session, sftp) {
  if (session.sftpHome) return Promise.resolve(session.sftpHome);
  return new Promise((resolve) => {
    sftp.realpath(".", (err, resolved) => {
      session.sftpHome = !err && resolved ? resolved : "/";
      resolve(session.sftpHome);
    });
  });
}

function entryType(attrs) {
  if (!attrs) return "file";
  if (typeof attrs.isDirectory === "function" && attrs.isDirectory()) return "dir";
  if (typeof attrs.isSymbolicLink === "function" && attrs.isSymbolicLink()) return "link";
  return "file";
}

// Directories first, then case-insensitive by name — the order a file manager
// is expected to have, done here so both sides agree and the client never has
// to re-sort a list it may have received truncated.
function sortEntries(entries) {
  entries.sort((a, b) => {
    if (a.type === "dir" !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

async function listTv(rawPath) {
  if (!tvRootReady()) {
    throw Object.assign(new Error("tv storage unavailable"), { code: "TV_STORAGE" });
  }
  const abs = await resolveTvPathReal(rawPath);
  if (!abs) throw Object.assign(new Error("path outside sandbox"), { code: "OUT_OF_SANDBOX" });
  const names = await fsp.readdir(abs);
  const truncated = names.length > LIST_LIMIT;
  const slice = truncated ? names.slice(0, LIST_LIMIT) : names;
  const entries = [];
  for (const name of slice) {
    let st = null;
    try {
      st = await fsp.lstat(path.join(abs, name));
    } catch (e) {
      // A file that vanished between readdir and lstat is not an error worth
      // failing the whole listing over.
      continue;
    }
    entries.push({
      name,
      type: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file",
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
    });
  }
  return { path: tvDisplayPath(abs), entries: sortEntries(entries), truncated };
}

async function listHost(session, rawPath) {
  const sftp = await getSftp(session);
  const home = await hostHome(session, sftp);
  const abs = resolveHostPath(rawPath, home);
  const list = await new Promise((resolve, reject) => {
    sftp.readdir(abs, (err, entries) => (err ? reject(err) : resolve(entries || [])));
  });
  const truncated = list.length > LIST_LIMIT;
  const slice = truncated ? list.slice(0, LIST_LIMIT) : list;
  const entries = slice.map((e) => ({
    name: e.filename,
    type: entryType(e.attrs),
    size: (e.attrs && e.attrs.size) || 0,
    mtime: e.attrs && e.attrs.mtime ? e.attrs.mtime * 1000 : 0,
  }));
  return { path: abs, entries: sortEntries(entries), truncated, home };
}

async function mkdirTv(rawPath) {
  // TV_STORAGE first: resolveTvPathReal also returns null when the storage
  // itself is unavailable, and that must not surface as a sandbox violation.
  if (!tvRootReady()) {
    throw Object.assign(new Error("tv storage unavailable"), { code: "TV_STORAGE" });
  }
  const abs = await resolveTvPathReal(rawPath);
  if (!abs) throw Object.assign(new Error("path outside sandbox"), { code: "OUT_OF_SANDBOX" });
  await fsp.mkdir(abs, { recursive: false, mode: 0o755 });
}

async function mkdirHost(session, rawPath) {
  const sftp = await getSftp(session);
  const home = await hostHome(session, sftp);
  const abs = resolveHostPath(rawPath, home);
  await new Promise((resolve, reject) => {
    sftp.mkdir(abs, (err) => (err ? reject(err) : resolve()));
  });
}

// Deletion is deliberately NON-recursive on both sides. A recursive remote
// delete driven from a D-pad, over a link the user cannot see the far end of,
// is the one operation in this app that can destroy something irreplaceable in
// a single confirm — and rmdir failing on a non-empty directory is a perfectly
// good way of saying "look inside first".
async function removeTv(rawPath) {
  if (!tvRootReady()) {
    throw Object.assign(new Error("tv storage unavailable"), { code: "TV_STORAGE" });
  }
  const abs = await resolveTvPathReal(rawPath);
  if (!abs) throw Object.assign(new Error("path outside sandbox"), { code: "OUT_OF_SANDBOX" });
  if (abs === path.resolve(TV_ROOT)) {
    throw Object.assign(new Error("refusing to remove the root"), { code: "IS_ROOT" });
  }
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) await fsp.rmdir(abs);
  else await fsp.unlink(abs);
}

async function removeHost(session, rawPath, isDir) {
  const sftp = await getSftp(session);
  const home = await hostHome(session, sftp);
  const abs = resolveHostPath(rawPath, home);
  if (abs === "/") throw Object.assign(new Error("refusing to remove /"), { code: "IS_ROOT" });
  await new Promise((resolve, reject) => {
    const done = (err) => (err ? reject(err) : resolve());
    if (isDir) sftp.rmdir(abs, done);
    else sftp.unlink(abs, done);
  });
}

module.exports = {
  TV_ROOT,
  LIST_LIMIT,
  getSftp,
  hostHome,
  resolveTvPath,
  resolveTvPathReal,
  tvDisplayPath,
  resolveHostPath,
  tvRootReady,
  listTv,
  listHost,
  mkdirTv,
  mkdirHost,
  removeTv,
  removeHost,
};
