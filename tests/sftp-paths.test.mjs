// The path arithmetic behind the file explorer. Pure, and the one part of the
// SCP feature where a mistake is a security bug rather than a cosmetic one: the
// service runs as root inside the devmode jail, so "the client would never send
// that path" is not an argument this file is allowed to make.
import assert from "node:assert";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

// Point the sandbox at a scratch directory so the test never depends on (or
// touches) /media/internal, which does not exist off the TV.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sshclient-sftp-test-"));
process.env.SSHCLIENT_FILES_DIR = ROOT;

const sftp = require("../service/lib/sftp.js");

assert.strictEqual(sftp.TV_ROOT, ROOT, "the sandbox honours SSHCLIENT_FILES_DIR");

// --- the TV sandbox holds ---------------------------------------------------
{
  const inside = [
    ["/", ROOT],
    ["", ROOT],
    ["/downloads", path.join(ROOT, "downloads")],
    ["downloads/a.bin", path.join(ROOT, "downloads/a.bin")],
    // Traversal that stays inside once collapsed is fine — this is a normal
    // "go up one level" from a subdirectory, not an escape.
    ["/downloads/../shots/x.png", path.join(ROOT, "shots/x.png")],
    // Leading traversal is collapsed against the sandbox root rather than
    // rejected: the client's "/" IS the sandbox, so "/.." is simply "/".
    ["/..", ROOT],
    ["../../../../etc/passwd", path.join(ROOT, "etc/passwd")],
    ["/etc/passwd", path.join(ROOT, "etc/passwd")],
  ];
  for (const [input, expected] of inside) {
    assert.strictEqual(
      sftp.resolveTvPath(input),
      expected,
      `resolveTvPath(${JSON.stringify(input)}) stays in the sandbox`,
    );
  }
}

// --- and the display path is the inverse ------------------------------------
{
  assert.strictEqual(sftp.tvDisplayPath(ROOT), "/", "the sandbox root shows as /");
  assert.strictEqual(
    sftp.tvDisplayPath(path.join(ROOT, "downloads/a.bin")),
    "/downloads/a.bin",
    "and nothing below it leaks the real prefix",
  );
  // Round-trip: whatever the client sends comes back as something it can send
  // again and land in the same place.
  for (const p of ["/", "/downloads", "/a/b/c.txt", "../../etc/passwd"]) {
    const abs = sftp.resolveTvPath(p);
    assert.strictEqual(
      sftp.resolveTvPath(sftp.tvDisplayPath(abs)),
      abs,
      `round-trip is stable for ${JSON.stringify(p)}`,
    );
  }
}

// --- the host side resolves against the remote home, POSIX-style ------------
{
  const home = "/home/pablo";
  assert.strictEqual(sftp.resolveHostPath("~", home), home, "~ is the home");
  assert.strictEqual(sftp.resolveHostPath("~/logs", home), "/home/pablo/logs");
  assert.strictEqual(sftp.resolveHostPath("logs", home), "/home/pablo/logs", "relative to home");
  assert.strictEqual(sftp.resolveHostPath("/var/log", home), "/var/log", "absolute wins");
  assert.strictEqual(sftp.resolveHostPath("", home), home, "empty is the home");
  assert.strictEqual(sftp.resolveHostPath("../x", home), "/home/x", "traversal is the user's own");
  assert.strictEqual(sftp.resolveHostPath("/a/../b", home), "/b", "and is collapsed");
  // The host side is deliberately NOT sandboxed — it is the user's own server,
  // reached with their own credentials, and a file manager that cannot leave
  // $HOME would be useless. Asserted so the asymmetry is a decision on the
  // record rather than an oversight someone "fixes" later.
  assert.ok(
    sftp.resolveHostPath("/etc/passwd", home) === "/etc/passwd",
    "the host side is not sandboxed, on purpose",
  );
  // POSIX separators even when the tests run on a platform whose path module
  // would use something else — the remote is always POSIX.
  assert.ok(!sftp.resolveHostPath("a/b", home).includes("\\"), "host paths stay POSIX");
}

// --- listing the sandbox ----------------------------------------------------
{
  fs.mkdirSync(path.join(ROOT, "zeta"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "alpha"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "Beta.txt"), "hello");
  fs.writeFileSync(path.join(ROOT, "a-file.bin"), Buffer.alloc(2048));

  const listed = await sftp.listTv("/");
  assert.strictEqual(listed.path, "/", "lists the sandbox as /");
  const names = listed.entries.map((e) => e.name);
  // Directories first, then case-insensitive by name — the order a file manager
  // is expected to have. Case matters here: a case-SENSITIVE sort would put
  // "Beta.txt" before "a-file.bin", which reads as a bug to anyone looking at it.
  assert.deepStrictEqual(
    names,
    ["alpha", "zeta", "a-file.bin", "Beta.txt"],
    "directories first, then case-insensitive by name",
  );
  const bin = listed.entries.find((e) => e.name === "a-file.bin");
  assert.strictEqual(bin.type, "file");
  assert.strictEqual(bin.size, 2048, "sizes are real");
  assert.ok(bin.mtime > 0, "and so are mtimes");
  assert.strictEqual(listed.truncated, false);

  // A path outside the sandbox is refused rather than silently clamped, so a
  // client bug surfaces as an error instead of as a listing of the wrong place.
  // resolveTvPath collapses traversal, so the only way to actually point
  // outside is a symlink planted INSIDE the sandbox — the sandbox is a
  // world-writable devmode share and the service runs as root, so the realpath
  // check has to refuse the planted link rather than follow it.
  let linked = true;
  try {
    fs.symlinkSync("/etc", path.join(ROOT, "escape"));
  } catch (e) {
    linked = false; // no symlink privilege here — the escape checks are skipped
  }
  if (linked) {
    await assert.rejects(
      () => sftp.listTv("/escape"),
      (e) => e.code === "OUT_OF_SANDBOX",
      "a symlink pointing outside the sandbox is refused, not followed",
    );
    assert.strictEqual(
      await sftp.resolveTvPathReal("/escape/passwd"),
      null,
      "and nothing below it resolves either",
    );
    await assert.rejects(
      () => sftp.removeTv("/escape"),
      (e) => e.code === "OUT_OF_SANDBOX",
      "delete through the planted link is refused too",
    );
    fs.unlinkSync(path.join(ROOT, "escape"));

    // A symlink that stays inside the sandbox is the user's own business.
    fs.symlinkSync(path.join(ROOT, "alpha"), path.join(ROOT, "inward"));
    const viaInward = await sftp.listTv("/inward");
    assert.ok(Array.isArray(viaInward.entries), "a symlink pointing inside is still followed");
    fs.unlinkSync(path.join(ROOT, "inward"));
  }

  // A path that does not exist yet (a download destination, a new folder) is
  // checked at its deepest existing ancestor rather than refused outright.
  assert.strictEqual(
    await sftp.resolveTvPathReal("/alpha/new/deep.bin"),
    path.join(ROOT, "alpha/new/deep.bin"),
    "a not-yet-existing path under a real directory resolves",
  );
}

// --- removing ---------------------------------------------------------------
{
  await assert.rejects(
    () => sftp.removeTv("/"),
    (e) => e.code === "IS_ROOT",
    "the sandbox root itself is never removable",
  );
  fs.writeFileSync(path.join(ROOT, "doomed.txt"), "x");
  await sftp.removeTv("/doomed.txt");
  assert.ok(!fs.existsSync(path.join(ROOT, "doomed.txt")), "a file is removed");

  fs.mkdirSync(path.join(ROOT, "full"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "full/inner.txt"), "x");
  await assert.rejects(
    () => sftp.removeTv("/full"),
    (e) => e.code === "ENOTEMPTY" || e.code === "EEXIST",
    "a non-empty directory is NOT removed recursively — deletion is one level, on purpose",
  );
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log("sftp-paths tests passed");
