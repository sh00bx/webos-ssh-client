// src/root-helpers.js writes a shell program that runs as ROOT on the TV, from
// a path taken out of the document URL. Both halves of that sentence are worth a
// test: the path must be refused unless it is an ordinary absolute path, and the
// script must keep the properties that make it safe to run on every app start.
//
// Imported through a tiny stub for ./luna.js and ./debug.js so this stays a
// plain node test — neither of those has any business being loaded here.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

// Minimal ESM loader shim: rewrite the two browser-only imports to data URLs
// that export the same names as no-ops.
const source = await readFile(path.join(srcDir, "root-helpers.js"), "utf8");
const stubbed = source
  .replace(
    'import { lunaCall } from "./luna.js";',
    "const lunaCall = (uri, method, params, ok) => { globalThis.__lastLunaCall = { uri, method, params }; ok({ stdoutString: 'hb=1 backdropd=ok ptyd=ok' }); };",
  )
  .replace('import { debugEvent } from "./debug.js";', "const debugEvent = () => {};");
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`
);
const { appDirFromHref, __installScript, bootstrapRootHelpers } = mod;

// --- where the app is -------------------------------------------------------

// Homebrew Channel install and developer-mode install: both are ordinary
// absolute paths and both must resolve, which is the whole reason the directory
// is read from the URL instead of hardcoded.
assert.equal(
  appDirFromHref(
    "file:///media/cryptofs/apps/usr/palm/applications/com.pwntastic.sshclient/index.html",
  ),
  "/media/cryptofs/apps/usr/palm/applications/com.pwntastic.sshclient",
);
assert.equal(
  appDirFromHref(
    "file:///media/developer/apps/usr/palm/applications/com.pwntastic.sshclient/index.html?x=1#y",
  ),
  "/media/developer/apps/usr/palm/applications/com.pwntastic.sshclient",
);

// Everything that is not a plain local path is refused rather than escaped.
assert.equal(appDirFromHref("http://localhost:8080/index.html"), null);
assert.equal(appDirFromHref("file:///media/apps/a%27b/index.html"), null); // quote
assert.equal(appDirFromHref("file:///media/apps/a%20b/index.html"), null); // space
assert.equal(appDirFromHref("file:///media/apps/a%3Bb/index.html"), null); // semicolon
assert.equal(appDirFromHref("file:///media/apps/%24(id)/index.html"), null); // substitution
assert.equal(appDirFromHref("file:///media/apps/../../etc/index.html"), null); // traversal
assert.equal(appDirFromHref(undefined), null);
assert.equal(appDirFromHref(""), null);

// --- what the script promises ----------------------------------------------

const script = __installScript("/media/cryptofs/apps/usr/palm/applications/com.pwntastic.sshclient");

// Both helpers and both boot hooks are covered.
for (const name of ["backdropd", "ptyd", "47-backdropd", "48-ptyd"]) {
  assert.ok(script.includes(name), `script must handle ${name}`);
}

// No Homebrew Channel → the script says so and stops, rather than scattering
// files into a directory tree that does not exist.
assert.ok(/if \[ ! -d "\$D" \]; then echo "hb=0"; exit 0; fi/.test(script));

// A pid out of a pidfile is never passed to kill unvalidated: `kill $(cat …)`
// as root would take a pidfile containing "-9 -1" and kill the whole TV.
assert.ok(script.includes('case "$p" in ""|*[!0-9]*)'));
assert.ok(!/kill \$\(cat/.test(script));
assert.ok(!/kill \$p\b/.test(script), "pid must be quoted at the kill site");

// Never copy over a live binary (ETXTBSY on this platform): stage next to it,
// remove, then move into place.
assert.ok(script.includes('cp "$1" "$2.new"'));
assert.ok(script.includes('rm -f "$2"; mv "$2.new" "$2"'));

// Restart only on change. Re-running a boot hook is free (both daemons guard
// themselves with a pidfile), but restarting backdropd drops the colour feed
// and restarting ptyd kills every open local shell.
assert.ok(script.includes('if [ "$ch" = 1 ]; then stopit "$pf"; sleep 1; fi'));

// The app directory is single-quoted and, having passed appDirFromHref, cannot
// contain a quote to break out with.
assert.ok(script.startsWith("A='/media/cryptofs/apps/usr/palm/applications/com.pwntastic.sshclient'"));

// The run leaves a one-line record behind. Without it, a run that decides to do
// nothing (the normal case) is indistinguishable from a run that never happened.
assert.ok(script.includes('> "$D/.sshclient-helpers.log"'));

// Real newlines between statements, and no semicolon glued onto a `do` or a
// `done`: joining the lines with "; " instead produced `for … do; set --`,
// which every POSIX shell rejects — and the app would only have found out on
// the TV, where the failure looks like "the helpers just did not install".
assert.ok(script.includes("\n"));
assert.ok(!/\bdo;/.test(script));
assert.ok(!/done;/.test(script));

// --- the call ---------------------------------------------------------------

const result = await bootstrapRootHelpers({
  href: "file:///media/cryptofs/apps/usr/palm/applications/com.pwntastic.sshclient/index.html",
});
assert.equal(result.ok, true);
assert.equal(result.homebrew, true);
assert.equal(globalThis.__lastLunaCall.uri, "luna://org.webosbrew.hbchannel.service");
assert.equal(globalThis.__lastLunaCall.method, "exec");

// Second call is a no-op: this runs on every app start, and doing the work twice
// in one page life would mean two concurrent daemon restarts.
const again = await bootstrapRootHelpers({ href: "file:///media/x/index.html" });
assert.ok(again.skipped);

console.log("root-helpers.test.mjs: ok");
