// How sessions are named and what they may do (src/session-label.mjs). Small,
// but three views share it and the local-shell placeholders make the naive
// answer wrong: the service fills host/user/port for a local session so the
// rest of the pipeline needs no branch, which means the LABEL must branch.
import assert from "node:assert/strict";
import {
  canBrowseFiles,
  isLocalSession,
  sessionShortLabel,
  sessionTitle,
} from "../src/session-label.mjs";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}: ${(e && e.message) || e}`);
  }
}

const ssh = { kind: "ssh", host: "192.168.0.218", user: "root", port: 22 };
// Exactly what service/lib/local-session.js puts on the wire.
const local = { kind: "local", host: "localhost", user: "root", port: 0 };

check("an ssh session is labelled by host and identified by user@host:port", () => {
  assert.equal(sessionShortLabel(ssh), "192.168.0.218");
  assert.equal(sessionTitle(ssh), "root@192.168.0.218:22");
  assert.equal(isLocalSession(ssh), false);
});

check("a local session never shows its placeholder address", () => {
  assert.equal(sessionShortLabel(local), "local");
  assert.equal(isLocalSession(local), true);
  const title = sessionTitle(local);
  assert.ok(!/localhost/.test(title), `title leaked the placeholder: ${title}`);
  assert.ok(!/:0\b/.test(title), `title leaked port 0: ${title}`);
});

check("a session summary without `kind` is treated as ssh", () => {
  // Records created before the local transport existed, and any future
  // transport that forgets to set it, must not silently become "local".
  const legacy = { host: "10.0.0.5", user: "pi", port: 2222 };
  assert.equal(isLocalSession(legacy), false);
  assert.equal(sessionShortLabel(legacy), "10.0.0.5");
  assert.equal(sessionTitle(legacy), "pi@10.0.0.5:2222");
});

check("missing fields degrade to placeholders rather than 'undefined'", () => {
  assert.equal(sessionShortLabel({}), "?");
  assert.equal(sessionTitle({}), "?@?:22");
  assert.equal(sessionShortLabel(null), "?");
  assert.equal(isLocalSession(null), false);
  assert.equal(isLocalSession(undefined), false);
});

check("file browsing is offered for ssh sessions only", () => {
  // A local session's transport is a unix socket speaking five terminal
  // frames; there is no SFTP channel to open, and the service answers NO_SFTP.
  assert.equal(canBrowseFiles(ssh), true);
  assert.equal(canBrowseFiles(local), false);
  // Unknown session (a stale tab whose session is already gone) must not be
  // treated as local — the caller's own NO_SESSION path should handle it.
  assert.equal(canBrowseFiles(undefined), true);
});

if (failures) {
  console.error(`${failures} session-label test(s) failed`);
  process.exit(1);
}
console.log("session-label tests passed");
