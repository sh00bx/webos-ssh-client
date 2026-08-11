// End-to-end check of the local-shell path: builds tv-root/ptyd.c with the
// HOST compiler, starts it on a temp socket, and drives a real shell through
// the real service handlers (local/connect, write, resize, disconnect).
//
// Manual rather than part of `npm test` for the same reason sftp-e2e is: it
// needs a C compiler and a working /dev/ptmx, and it forks shells. Run it
// whenever ptyd.c or pty-frames.js changes — it is the ONLY place the C
// encoder and the JS decoder are checked against each other, and a framing
// mistake is invisible to every other test in this repo.
//
//   node tests/ptyd-e2e.manual.mjs
//
// The TV runs the same source built for ARM; what differs there is the kernel
// and busybox instead of the host's shell, neither of which touches the wire
// format.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

if (!fs.existsSync("/dev/ptmx")) {
  console.log("SKIP - no /dev/ptmx on this host");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptyd-e2e-"));
const binary = path.join(tmp, "ptyd");
const socket = path.join(tmp, "ptyd.sock");

try {
  execFileSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-o", binary,
    path.join(repo, "tv-root", "ptyd.c")], { stdio: "pipe" });
} catch (e) {
  console.log(`SKIP - could not build ptyd on this host: ${e.message}`);
  process.exit(0);
}

// The daemon derives its directory and pidfile from the socket path, so this
// instance is fully isolated from an installed one: the temp dir is fresh, so
// there is no stale pidfile to make it exit 0 without ever listening.
const daemon = spawn(binary, ["-p", socket, "-s", "/bin/sh"], {
  stdio: ["ignore", "inherit", "inherit"],
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSocket() {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(socket)) return true;
    await delay(20);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Load the real service with webos-service stubbed, exactly like
// tests/service-connect.test.js — the point is to exercise the shipped
// handlers, not a reimplementation of them.
// ---------------------------------------------------------------------------
class FakeService {
  constructor(name) {
    this.name = name;
    this.handlers = new Map();
    this.activityManager = {
      idleTimeout: 5,
      create: (n, cb) => cb({ name: n, id: 1 }),
      complete: (a, cb) => cb && cb(a),
    };
    FakeService.instances.push(this);
  }
  register(name, requestHandler, cancelHandler) {
    this.handlers.set(name, { requestHandler, cancelHandler });
    return { on() {} };
  }
}
FakeService.instances = [];

const originalLoad = Module._load;
Module._load = function loadMock(request, parent, isMain) {
  if (request === "webos-service") return FakeService;
  return originalLoad.call(this, request, parent, isMain);
};

process.env.SSHCLIENT_STORAGE_DIR = path.join(tmp, "storage");
process.env.SSHCLIENT_PTYD_SOCKET = socket;

function makeMessage(payload) {
  const responses = [];
  return {
    uniqueToken: `tok-${Math.random()}`,
    payload,
    responses,
    respond(body) {
      responses.push(body);
    },
  };
}

function outputOf(message) {
  return message.responses
    .filter((r) => r.event === "data" || r.event === "replay")
    .map((r) => r.data)
    .join("");
}

async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  assert(await waitForSocket(), "ptyd should create its socket");
  const stat = fs.statSync(socket);
  check(
    "socket is not group- or world-accessible",
    (stat.mode & 0o077) === 0,
    `mode ${(stat.mode & 0o777).toString(8)}`,
  );

  require(path.join(repo, "service", "service.js"));
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");

  const service = FakeService.instances[0];
  const localConnect = service.handlers.get("local/connect");
  const localStatus = service.handlers.get("local/status");
  const write = service.handlers.get("write");
  const resize = service.handlers.get("resize");
  const disconnect = service.handlers.get("disconnect");
  const list = service.handlers.get("sessions/list");
  check("local/connect is registered", Boolean(localConnect));
  check("local/status is registered", Boolean(localStatus));
  if (!localConnect) throw new Error("nothing further to test");

  // --- reachability probe ---------------------------------------------------
  const status = makeMessage({});
  localStatus.requestHandler(status);
  await waitFor(() => status.responses.length > 0, "local/status reply");
  check(
    "local/status reports the running daemon as available",
    status.responses[0].available === true,
    JSON.stringify(status.responses[0]),
  );

  // --- connect --------------------------------------------------------------
  const session = makeMessage({ cols: 100, rows: 30 });
  localConnect.requestHandler(session);
  try {
    await waitFor(
      () => session.responses.some((r) => r.event === "ready"),
      "ready event",
    );
  } catch (e) {
    // What the service actually said is the whole diagnosis here — a bare
    // "timed out" would send the next reader looking at ptyd instead.
    console.error("responses so far:", JSON.stringify(session.responses));
    throw e;
  }
  const ready = session.responses.find((r) => r.event === "ready");
  const sessionId = ready.sessionId;
  check("connect yields a session id", Boolean(sessionId));

  // --- the session looks local in the listing -------------------------------
  const listing = makeMessage({});
  list.requestHandler(listing);
  const summary = listing.responses[0].sessions.find((s) => s.id === sessionId);
  check("session is summarised as kind=local", summary && summary.kind === "local",
    JSON.stringify(summary));
  check("summary carries the shell pid", Boolean(summary && summary.shellPid),
    JSON.stringify(summary && summary.shellPid));

  // --- it is a REAL tty, which is the entire point of the helper -------------
  write.requestHandler(makeMessage({ sessionId, data: "tty; echo MARK-$?\n" }));
  await waitFor(() => /MARK-0/.test(outputOf(session)), "tty to report success");
  check(
    "the shell is on a pty, not a pipe",
    /\/dev\/pts\/\d+/.test(outputOf(session)),
    outputOf(session).slice(-200),
  );

  // --- the size we asked for on HELLO is the size the shell sees -------------
  write.requestHandler(makeMessage({ sessionId, data: "stty size\n" }));
  await waitFor(() => /\b30 100\b/.test(outputOf(session)), "initial winsize", 3000)
    .then(() => check("HELLO carried the initial window size", true))
    .catch(() => check("HELLO carried the initial window size", false,
      outputOf(session).slice(-200)));

  // --- resize reaches TIOCSWINSZ --------------------------------------------
  resize.requestHandler(makeMessage({ sessionId, cols: 132, rows: 43 }));
  await delay(150);
  write.requestHandler(makeMessage({ sessionId, data: "stty size\n" }));
  await waitFor(() => /\b43 132\b/.test(outputOf(session)), "resized winsize", 3000)
    .then(() => check("resize reaches the pty", true))
    .catch(() => check("resize reaches the pty", false, outputOf(session).slice(-200)));

  // --- a burst larger than one read, to exercise the framing ----------------
  write.requestHandler(
    makeMessage({ sessionId, data: "awk 'BEGIN{for(i=0;i<4000;i++)print i}'\n" }),
  );
  await waitFor(() => /\n3999\b/.test(outputOf(session)), "bulk output", 10000)
    .then(() => {
      const text = outputOf(session);
      let missing = 0;
      for (let i = 0; i < 4000; i += 137) {
        if (!new RegExp(`(^|\\D)${i}\\r?\\n`).test(text)) missing++;
      }
      check("bulk output arrives without gaps", missing === 0, `${missing} sampled lines missing`);
    })
    .catch(() => check("bulk output arrives without gaps", false, "timed out"));

  // --- utf-8 across the wire -------------------------------------------------
  write.requestHandler(makeMessage({ sessionId, data: "printf 'ümläut-ok\\n'\n" }));
  await waitFor(() => /ümläut-ok/.test(outputOf(session)), "utf-8 echo", 3000)
    .then(() => check("multi-byte characters survive the round trip", true))
    .catch(() => check("multi-byte characters survive the round trip", false,
      outputOf(session).slice(-200)));

  // --- a paste larger than one frame -----------------------------------------
  // Regression: stream.write() used to encode whatever it was handed as ONE
  // DATA frame, and a length above MAX_PAYLOAD is a protocol violation to the
  // daemon — it dropped the connection and SIGHUPed the shell, while `write`
  // still answered returnValue:true. One term.paste() is one write, and a
  // clipboard is not bounded by 64 KiB. The SSH path never showed this because
  // ssh2 chunks channel writes itself.
  {
    // Fed to `wc -c` as many short lines rather than as one long one: a pty in
    // canonical mode caps a SINGLE line at ~4 KiB and discards the rest, so a
    // 200 KiB one-liner would be truncated by the line discipline and prove
    // nothing about our framing. The byte count coming back is the assertion —
    // it is 200 KiB, i.e. more than three MAX_PAYLOAD frames, and it also
    // exercises ptyd's to_pty backpressure, since 200 KiB does not fit in its
    // 128 KiB buffer.
    const LINE = "x".repeat(127) + "\n";
    const COUNT = 1600;
    const bytes = LINE.length * COUNT;
    write.requestHandler(makeMessage({ sessionId, data: "stty -echo; wc -c\n" }));
    await delay(300);
    write.requestHandler(makeMessage({ sessionId, data: LINE.repeat(COUNT) }));
    write.requestHandler(makeMessage({ sessionId, data: "\x04" })); // EOF for wc
    await waitFor(
      () => new RegExp(`\\b${bytes}\\b`).test(outputOf(session)),
      "wc to report the full byte count",
      20000,
    )
      .then(() => check("a paste larger than one frame arrives whole", true))
      .catch(() =>
        check(
          "a paste larger than one frame arrives whole",
          false,
          session.responses.some((r) => r.event === "close")
            ? "the session was DROPPED — the MAX_PAYLOAD split regressed"
            : `timed out waiting for ${bytes}`,
        ),
      );
    write.requestHandler(makeMessage({ sessionId, data: "stty echo\n" }));
    await delay(200);
  }

  // --- a background job must not hold the session open ----------------------
  // Regression: the teardown required the pty MASTER to have hung up, but a
  // process the shell leaves behind keeps the slave open, so the master
  // reported neither POLLIN nor POLLHUP and the connection, its two fds and
  // its MAX_CLIENTS slot were held forever — with the client still believing
  // the session was live.
  {
    const orphaned = makeMessage({ cols: 80, rows: 24 });
    localConnect.requestHandler(orphaned);
    await waitFor(
      () => orphaned.responses.some((r) => r.event === "ready"),
      "orphan-test session ready",
    );
    const orphanId = orphaned.responses.find((r) => r.event === "ready").sessionId;
    write.requestHandler(
      makeMessage({ sessionId: orphanId, data: "sleep 300 &\nexit\n" }),
    );
    await waitFor(
      () => orphaned.responses.some((r) => r.event === "close"),
      "close after exit with a background job",
      8000,
    )
      .then(() => check("`exit` closes the session even with a job left behind", true))
      .catch(() =>
        check("`exit` closes the session even with a job left behind", false,
          "no close event — the master drain regressed"),
      );
  }

  // --- the shell exiting on its own closes the session ----------------------
  write.requestHandler(makeMessage({ sessionId, data: "exit\n" }));
  await waitFor(
    () => session.responses.some((r) => r.event === "close"),
    "close event after exit",
    5000,
  )
    .then(() => check("`exit` closes the session", true))
    .catch(() => check("`exit` closes the session", false, "no close event"));

  const afterExit = makeMessage({});
  list.requestHandler(afterExit);
  check(
    "the exited session is gone from the registry",
    !afterExit.responses[0].sessions.some((s) => s.id === sessionId),
  );

  // --- disconnect on a live session -----------------------------------------
  const second = makeMessage({ cols: 80, rows: 24 });
  localConnect.requestHandler(second);
  await waitFor(
    () => second.responses.some((r) => r.event === "ready"),
    "second session ready",
  );
  const secondId = second.responses.find((r) => r.event === "ready").sessionId;
  const shellPid = (() => {
    const l = makeMessage({});
    list.requestHandler(l);
    const s = l.responses[0].sessions.find((x) => x.id === secondId);
    return s && s.shellPid;
  })();
  disconnect.requestHandler(makeMessage({ sessionId: secondId }));
  await delay(1500);
  check(
    "disconnect reaps the forked shell",
    shellPid ? !fs.existsSync(`/proc/${shellPid}`) : false,
    `pid ${shellPid} still present`,
  );
}

main()
  .catch((e) => {
    failures++;
    console.error(`FAIL - harness: ${(e && e.stack) || e}`);
  })
  .finally(async () => {
    try {
      daemon.kill("SIGKILL");
    } catch (e) {
      /* already gone */
    }
    await delay(100);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* leftover temp dir is harmless */
    }
    if (failures) {
      console.error(`${failures} ptyd e2e check(s) failed`);
      process.exit(1);
    }
    console.log("ptyd e2e checks passed");
    process.exit(0);
  });
