// End-to-end exercise of the SFTP layer against a REAL remote (the TV's own
// sshd, which is also the kind of server this app talks to). Covers the whole
// stack below the Luna handlers: channel open and reuse, listing, mkdir,
// transfer both ways with progress, byte-for-byte verification via md5 computed
// ON THE REMOTE, and cancel cleanup.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sftp-e2e-"));
process.env.SSHCLIENT_FILES_DIR = ROOT;

// Absolute so this can be run from anywhere; overridable because it is a manual
// test and the checkout is not always where the author's happens to be.
const REPO = process.env.SFTP_E2E_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Client } = require(`${REPO}/service/node_modules/ssh2`);
const sftpLib = require(`${REPO}/service/lib/sftp.js`);
const transfer = require(`${REPO}/service/lib/sftp-transfer.js`);

// A real host with a real sshd — this test transfers files against it. Point it
// at the TV (or any box you can reach as root over key auth).
const HOST = process.env.SFTP_E2E_HOST;
const USER = process.env.SFTP_E2E_USER || "root";
if (!HOST) {
  console.error("set SFTP_E2E_HOST=<ip> (and SFTP_E2E_USER if not root)");
  process.exit(2);
}
const REMOTE = "/tmp/sftp-e2e";

const sh = (cmd) =>
  execFileSync("ssh", ["-o", "StrictHostKeyChecking=no", `${USER}@${HOST}`, cmd], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();

sh(`rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);

const client = await new Promise((resolve, reject) => {
  const c = new Client();
  c.on("ready", () => resolve(c));
  c.on("error", reject);
  c.connect({
    host: HOST,
    port: 22,
    username: USER,
    agent: process.env.SSH_AUTH_SOCK,
    readyTimeout: 10000,
  });
});
const session = { id: "e2e", client, host: HOST };

// --- listing both sides -----------------------------------------------------
fs.writeFileSync(path.join(ROOT, "local.txt"), "from the tv");
const tvList = await sftpLib.listTv("/");
assert.ok(tvList.entries.some((e) => e.name === "local.txt"), "tv listing sees the file");

sh(`dd if=/dev/urandom of=${REMOTE}/remote.bin bs=1024 count=3072 2>/dev/null`);
const remoteMd5 = sh(`md5sum ${REMOTE}/remote.bin`).split(/\s+/)[0];
const hostList = await sftpLib.listHost(session, REMOTE);
const rb = hostList.entries.find((e) => e.name === "remote.bin");
assert.ok(rb, "host listing sees the file");
assert.strictEqual(rb.size, 3 * 1024 * 1024, "host listing reports the real size");
assert.ok(hostList.home && hostList.home.startsWith("/"), "remote home resolved");
console.log("  listing        ok (home =", hostList.home + ", size reported correctly)");

// --- download, with progress ------------------------------------------------
let progressEvents = 0;
let lastSeen = 0;
const downloaded = await new Promise((resolve, reject) => {
  transfer
    .startTransfer(session, {
      direction: "download",
      hostPath: `${REMOTE}/remote.bin`,
      tvPath: "/pulled.bin",
      onProgress: (p) => {
        progressEvents++;
        assert.ok(p.transferred >= lastSeen, "progress never goes backwards");
        assert.ok(p.total === 3 * 1024 * 1024, "progress carries the real total");
        lastSeen = p.transferred;
      },
      onDone: (d) => (d.ok ? resolve(d) : reject(new Error(d.errorText || d.errorCode))),
    })
    .catch(reject);
});
const localMd5 = crypto.createHash("md5").update(fs.readFileSync(path.join(ROOT, "pulled.bin"))).digest("hex");
assert.strictEqual(localMd5, remoteMd5, "downloaded bytes are identical (md5 computed on the remote)");
assert.strictEqual(downloaded.transferred, 3 * 1024 * 1024, "byte count matches");
assert.ok(!fs.readdirSync(ROOT).some((n) => n.includes(".part-")), "no temp file left behind");
console.log("  download       ok (3 MiB, md5", remoteMd5.slice(0, 12) + "…,", progressEvents, "progress events)");

// --- upload -----------------------------------------------------------------
const pushBytes = crypto.randomBytes(1024 * 1024);
fs.writeFileSync(path.join(ROOT, "push.bin"), pushBytes);
const pushMd5 = crypto.createHash("md5").update(pushBytes).digest("hex");
await new Promise((resolve, reject) => {
  transfer
    .startTransfer(session, {
      direction: "upload",
      hostPath: `${REMOTE}/pushed.bin`,
      tvPath: "/push.bin",
      onDone: (d) => (d.ok ? resolve(d) : reject(new Error(d.errorText || d.errorCode))),
    })
    .catch(reject);
});
assert.strictEqual(sh(`md5sum ${REMOTE}/pushed.bin`).split(/\s+/)[0], pushMd5, "uploaded bytes are identical");
assert.strictEqual(sh(`ls -a ${REMOTE} | grep -c part- || true`), "0", "no temp file left on the host");
console.log("  upload         ok (1 MiB, md5 verified on the remote)");

// --- mkdir on both sides ----------------------------------------------------
await sftpLib.mkdirTv("/newdir");
assert.ok(fs.statSync(path.join(ROOT, "newdir")).isDirectory(), "tv mkdir");
await sftpLib.mkdirHost(session, `${REMOTE}/newdir`);
assert.strictEqual(sh(`test -d ${REMOTE}/newdir && echo yes`), "yes", "host mkdir");
console.log("  mkdir          ok (both sides)");

// --- remove on the host, non-recursive --------------------------------------
sh(`mkdir -p ${REMOTE}/full && touch ${REMOTE}/full/x`);
let refused = false;
try {
  await sftpLib.removeHost(session, `${REMOTE}/full`, true);
} catch (e) {
  refused = true;
}
assert.ok(refused, "a non-empty remote directory is NOT removed");
assert.strictEqual(sh(`test -d ${REMOTE}/full && echo yes`), "yes", "and it is still there");
await sftpLib.removeHost(session, `${REMOTE}/pushed.bin`, false);
assert.strictEqual(sh(`test -e ${REMOTE}/pushed.bin || echo gone`), "gone", "a remote file is removed");
console.log("  remove         ok (file removed, non-empty dir refused)");

// --- the channel is REUSED, not reopened ------------------------------------
const first = await sftpLib.getSftp(session);
const second = await sftpLib.getSftp(session);
assert.strictEqual(first, second, "one SFTP channel is reused across operations");
console.log("  channel reuse  ok");

// --- cancel leaves nothing behind -------------------------------------------
sh(`dd if=/dev/urandom of=${REMOTE}/big.bin bs=1024 count=20480 2>/dev/null`);
const cancelResult = await new Promise((resolve, reject) => {
  transfer
    .startTransfer(session, {
      direction: "download",
      hostPath: `${REMOTE}/big.bin`,
      tvPath: "/big.bin",
      onProgress: (p) => {
        if (p.transferred > 0) transfer.cancelTransfer(p.id);
      },
      onDone: resolve,
    })
    .catch(reject);
});
assert.strictEqual(cancelResult.ok, false, "a cancelled transfer does not report success");
assert.strictEqual(cancelResult.cancelled, true, "and says it was cancelled");
assert.ok(!fs.existsSync(path.join(ROOT, "big.bin")), "cancel leaves no destination file");
assert.ok(!fs.readdirSync(ROOT).some((n) => n.includes(".part-")), "cancel leaves no partial file");
assert.strictEqual(transfer.activeCount(), 0, "no transfer left registered");
console.log("  cancel         ok (no destination, no .part, registry empty)");

client.end();
sh(`rm -rf ${REMOTE}`);
fs.rmSync(ROOT, { recursive: true, force: true });
console.log("sftp e2e passed against a real sshd");
