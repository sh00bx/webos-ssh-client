// Install (and keep current) the two root helpers that ship inside this IPK.
//
// The app itself runs jailed, and two of its features cannot: the local shell
// needs a pty, and the jail has no /dev/ptmx at all (see the measurement in
// tv-root/ptyd.c), while the adaptive theme needs the display capture API,
// which is refused on the public bus. Both therefore live in small ARM binaries
// that run as root outside the jail — ptyd and backdropd — with a webosbrew
// boot hook each.
//
// Until 0.8 those two were installed by hand over SSH (scripts/install-ptyd.sh).
// That is fine for a development TV and useless for anyone installing from the
// Homebrew Channel, so both binaries and both hooks now travel in the app
// payload, and this module copies them into place on start.
//
// Root comes from Homebrew Channel's own service, which is what made the TV
// rooted in the first place: org.webosbrew.hbchannel.service/exec runs a shell
// command as root. No Homebrew Channel means no root, which is a supported
// configuration — the app then runs with remote SSH sessions only, and says so
// through localShellAvailable() rather than failing.
//
// Idempotent and cheap: the script compares before it copies and only restarts
// a daemon whose binary actually changed, so the common case (nothing to do) is
// one luna round trip that touches nothing.

import { lunaCall } from "./luna.js";
import { debugEvent } from "./debug.js";

const HB_SERVICE = "luna://org.webosbrew.hbchannel.service";

// Where the app was unpacked. Read from the document URL rather than guessed:
// a Homebrew Channel install lands in /media/cryptofs/apps/..., a developer-mode
// install in /media/developer/apps/..., and hardcoding either would break the
// other.
export function appDirFromHref(href) {
  if (typeof href !== "string") return null;
  const withoutQuery = href.split("#")[0].split("?")[0];
  const match = /^file:\/\/(\/.*)\/[^/]*$/.exec(withoutQuery);
  if (!match) return null;
  let dir;
  try {
    dir = decodeURIComponent(match[1]);
  } catch (e) {
    return null;
  }
  // This string is interpolated into a command that runs as root, so it is
  // whitelisted rather than escaped: anything that is not a plain absolute path
  // of ordinary path characters is refused outright. Quoting mistakes in a root
  // shell are not a class of bug worth being clever about.
  if (!/^\/[A-Za-z0-9._\-/]*$/.test(dir)) return null;
  if (dir.indexOf("..") !== -1) return null;
  return dir;
}

// One entry per helper: the binary, its boot hook, and the pidfile each daemon
// writes (both guard against double-starts with it, which is why re-running a
// hook is safe).
const HELPERS = [
  { bin: "backdropd", hook: "47-backdropd", pidfile: "/tmp/backdropd.pid" },
  { bin: "ptyd", hook: "48-ptyd", pidfile: "/tmp/.sshclient-ptyd/ptyd.pid" },
];

function installScript(appDir) {
  const table = HELPERS.map((h) => `"${h.bin} ${h.hook} ${h.pidfile}"`).join(" ");
  // Written for busybox ash (the TV's /bin/sh). Notes on the sharp edges:
  //  - `rm` before `mv`, never a copy over a live binary: replacing a running
  //    executable in place is ETXTBSY on this platform, and a half-written one
  //    is worse than an old one.
  //  - a pid read out of a pidfile is validated before it reaches kill: this
  //    runs as root, and `kill $(cat …)` word-splits whatever is in the file,
  //    so a file containing "-9 -1" would kill the TV.
  //  - the daemon is only stopped when its binary actually changed. Restarting
  //    backdropd drops the colour feed and restarting ptyd kills every local
  //    shell, and neither is an acceptable price for launching the app.
  return [
    `A='${appDir}'`,
    "D=/var/lib/webosbrew",
    "H=$D/init.d",
    // No webosbrew directory means no Homebrew Channel means no root path at
    // all. Report it and stop — this is not an error.
    'if [ ! -d "$D" ]; then echo "hb=0"; exit 0; fi',
    'mkdir -p "$H" 2>/dev/null',
    'alive() { p=$(cat "$1" 2>/dev/null); case "$p" in ""|*[!0-9]*) return 1;; esac; kill -0 "$p" 2>/dev/null; }',
    'stopit() { p=$(cat "$1" 2>/dev/null); case "$p" in ""|*[!0-9]*) return 0;; esac; kill "$p" 2>/dev/null; }',
    'sync_file() { if cmp -s "$1" "$2"; then return 1; fi; cp "$1" "$2.new" || return 1; chmod 755 "$2.new"; rm -f "$2"; mv "$2.new" "$2"; return 0; }',
    'O=""',
    `for x in ${table}; do`,
    "set -- $x; b=$1; h=$2; pf=$3",
    'if [ ! -f "$A/tv-root/$b" ]; then O="$O $b=absent"; continue; fi',
    "ch=0",
    'if sync_file "$A/tv-root/$b" "$D/$b"; then ch=1; fi',
    'if [ -f "$A/tv-root/$h" ]; then if sync_file "$A/tv-root/$h" "$H/$h"; then ch=1; fi; fi',
    // A changed binary is stopped and given a moment to go away: the daemons
    // refuse to start while the pid in their pidfile is still alive, so
    // starting the new one too early would leave nothing running at all.
    'if [ "$ch" = 1 ]; then stopit "$pf"; sleep 1; fi',
    'if [ "$ch" = 1 ] || ! alive "$pf"; then sh "$H/$h" >/dev/null 2>&1; if [ "$ch" = 1 ]; then O="$O $b=updated"; else O="$O $b=started"; fi; else O="$O $b=ok"; fi',
    "done",
    // A no-op run is invisible by design (nothing is copied, nothing is
    // restarted), which makes "did this ever run?" unanswerable on a TV whose
    // owner is not going to open the in-app debug log. One line of state costs
    // nothing and answers it: cat /var/lib/webosbrew/.sshclient-helpers.log
    'echo "$(date) hb=1$O" > "$D/.sshclient-helpers.log" 2>/dev/null',
    'echo "hb=1$O"',
    // Newlines, not semicolons: `for … do; …` and `done;` are syntax errors in
    // the TV's busybox ash (and in every other POSIX shell), so the lines above
    // cannot simply be glued together. JSON carries the newlines fine.
  ].join("\n");
}

function parseState(reply) {
  const text = (reply && (reply.stdoutString || reply.stdout || "")) || "";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return {
    homebrew: /\bhb=1\b/.test(flat),
    detail: flat,
  };
}

let started = false;

/**
 * Fire-and-forget. Resolves with a small state object; never rejects, because
 * nothing downstream depends on it: without root the app simply keeps the
 * features that do not need it, and the next launch tries again.
 *
 * Call this AFTER the backend service has been talked to at least once. ptyd
 * hands the socket to whoever owns the app's storage directory, and that
 * directory is created by the service on its first call — starting ptyd before
 * that leaves it falling back to the stock jail uid, which is right on this
 * firmware but is not something to rely on.
 */
export function bootstrapRootHelpers({ href = window.location && window.location.href } = {}) {
  if (started) return Promise.resolve({ skipped: "already ran" });
  started = true;

  const appDir = appDirFromHref(href);
  if (!appDir) {
    debugEvent("root_helpers_no_app_dir", { href: href || null });
    return Promise.resolve({ ok: false, reason: "app directory not resolvable" });
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    lunaCall(
      HB_SERVICE,
      "exec",
      { command: installScript(appDir) },
      (reply) => {
        const state = parseState(reply);
        debugEvent("root_helpers_ready", {
          durationMs: Date.now() - startedAt,
          homebrew: state.homebrew,
          detail: state.detail,
        });
        resolve({ ok: true, ...state });
      },
      (err) => {
        // By far the most likely cause is that Homebrew Channel is not
        // installed, which is exactly the case where there is nothing to do.
        debugEvent("root_helpers_unavailable", {
          durationMs: Date.now() - startedAt,
          error: err && (err.errorText || err.errorCode || String(err)),
        });
        resolve({ ok: false, reason: (err && err.errorText) || "no homebrew channel" });
      },
    );
  });
}

// Exported for the test: the script is a shell program written from JS, and the
// parts of it worth pinning down (no unquoted pid, no copy over a live binary)
// are easier to assert on than to review by eye every time it changes.
export const __installScript = installScript;
