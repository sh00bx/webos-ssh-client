// File transfers between the TV and the session's host, in both directions.
//
// Streamed, never buffered. A TV recording or a build artifact is bigger than
// this service's heap, and the obvious readFile/writeFile pair would take the
// whole node process — and with it every live SSH session — down on a file the
// user had every right to copy. So both directions are a pipe with a byte
// counter on it, and the only thing held in memory is the counter.
//
// Written to a TEMPORARY NAME AND RENAMED on completion. An interrupted
// transfer otherwise leaves a file at the right path with the right name and
// the wrong length, which is the worst possible failure here: it looks done.
// Rename within a filesystem is atomic, so the destination name appears only
// once the bytes behind it are all there.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { debugLog } = require("./debug-log");
const { getSftp, hostHome, resolveTvPathReal, resolveHostPath, tvRootReady } = require("./sftp");

// Progress crosses the Luna bus as JSON and lands in a DOM update, so it is
// rate-limited rather than emitted per chunk: a 64 KiB chunk size on a fast LAN
// is thousands of events a second, which would cost more than the copy.
const PROGRESS_MS = 200;

// transferId -> { cancel(), sessionId }
const active = new Map();
let nextTransferId = 1;

function transferError(code, message, cause) {
  return Object.assign(new Error(message || code), { code, cause });
}

// A temp name beside the destination, so the rename never crosses a filesystem
// (which would silently become a copy, or fail with EXDEV).
function tempNameFor(dest, sep) {
  const dir = dest.slice(0, dest.lastIndexOf(sep) + 1);
  const base = dest.slice(dest.lastIndexOf(sep) + 1);
  return `${dir}.${base}.part-${process.pid}-${nextTransferId}`;
}

/**
 * Start a transfer. Returns { id, size } once the source has been stat'd and
 * the streams are wired; progress and completion arrive through the callbacks.
 *
 * direction: "download" = host -> TV, "upload" = TV -> host.
 */
async function startTransfer(session, opts) {
  const { direction, hostPath, tvPath, onProgress, onDone } = opts;
  if (direction !== "download" && direction !== "upload") {
    throw transferError("BAD_DIRECTION", "direction must be download or upload");
  }
  if (!tvRootReady()) throw transferError("TV_STORAGE", "tv storage unavailable");

  const sftp = await getSftp(session);
  const home = await hostHome(session, sftp);
  const hostAbs = resolveHostPath(hostPath, home);
  const tvAbs = await resolveTvPathReal(tvPath);
  if (!tvAbs) throw transferError("OUT_OF_SANDBOX", "tv path outside sandbox");

  const id = String(nextTransferId++);

  // Stat the SOURCE first: the size is what makes the progress bar mean
  // anything, and a missing source should fail before a destination file has
  // been created. A source we cannot stat is still allowed through with size 0
  // — some servers refuse stat on a readable file — the bar then just counts up
  // without a total instead of the transfer being refused.
  let total = 0;
  if (direction === "download") {
    total = await new Promise((resolve) => {
      sftp.stat(hostAbs, (err, st) => resolve(!err && st && st.size ? st.size : 0));
    });
  } else {
    try {
      const st = await fsp.stat(tvAbs);
      if (st.isDirectory()) throw transferError("IS_DIRECTORY", "cannot transfer a directory");
      total = st.size;
    } catch (e) {
      if (e && e.code === "IS_DIRECTORY") throw e;
      throw transferError("NO_SOURCE", `cannot read ${tvPath}`, e);
    }
  }

  const destIsTv = direction === "download";
  const destFinal = destIsTv ? tvAbs : hostAbs;
  const destTemp = tempNameFor(destFinal, destIsTv ? path.sep : "/");

  if (destIsTv) {
    // The destination directory has to exist before the stream opens; the
    // client can name a folder that is only there on the other side.
    await fsp.mkdir(path.dirname(destFinal), { recursive: true, mode: 0o755 });
  }

  const source = destIsTv
    ? sftp.createReadStream(hostAbs)
    : fs.createReadStream(tvAbs);
  // TV-side sink opens with "wx" (O_CREAT|O_EXCL): the temp name is predictable
  // (pid + counter) and the sandbox dir is a world-writable devmode share, so a
  // pre-planted symlink at the temp name would otherwise let this root service
  // write the file's bytes anywhere. O_EXCL never follows a symlink final
  // component and refuses anything that already exists — same trick the txd
  // daemon uses for its record files.
  const sink = destIsTv
    ? fs.createWriteStream(destTemp, { mode: 0o644, flags: "wx" })
    : sftp.createWriteStream(destTemp);

  let sent = 0;
  let lastReport = 0;
  let finished = false;
  let cancelled = false;

  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    if (onProgress) onProgress({ id, transferred: sent, total });
  };

  // Every exit path funnels through here exactly once, so a failure can never
  // leave the temp file behind AND never fire two completions at the client.
  const settle = async (err) => {
    if (finished) return;
    finished = true;
    active.delete(id);
    try {
      source.destroy();
    } catch (e) {
      /* already closed */
    }
    try {
      sink.destroy();
    } catch (e) {
      /* already closed */
    }
    if (err) {
      // Best-effort cleanup of the partial file. Failing to remove it must not
      // replace the real error with a cleanup error.
      try {
        if (destIsTv) await fsp.unlink(destTemp);
        else await new Promise((r) => sftp.unlink(destTemp, () => r()));
      } catch (e) {
        /* nothing more we can do */
      }
      debugLog("sftp_transfer_fail", {
        sessionId: session.id,
        id,
        direction,
        cancelled,
        error: err,
      });
      if (onDone) {
        onDone({
          id,
          ok: false,
          cancelled,
          errorCode: cancelled ? "CANCELLED" : err.code || "TRANSFER_FAIL",
          errorText: String((err && err.message) || err),
          transferred: sent,
          total,
        });
      }
      return;
    }
    // Bytes are all there — now the name.
    try {
      if (destIsTv) await fsp.rename(destTemp, destFinal);
      else {
        await new Promise((resolve, reject) => {
          // Most servers refuse a rename onto an existing name, so clear it
          // first. An unlink failure is not fatal: the rename may still work.
          sftp.unlink(destFinal, () => {
            sftp.rename(destTemp, destFinal, (e) => (e ? reject(e) : resolve()));
          });
        });
      }
    } catch (e) {
      debugLog("sftp_transfer_rename_fail", { sessionId: session.id, id, error: e });
      if (onDone) {
        onDone({
          id,
          ok: false,
          errorCode: "RENAME_FAIL",
          errorText: String((e && e.message) || e),
          transferred: sent,
          total,
        });
      }
      return;
    }
    debugLog("sftp_transfer_done", {
      sessionId: session.id,
      id,
      direction,
      bytes: sent,
    });
    if (onDone) onDone({ id, ok: true, transferred: sent, total });
  };

  source.on("data", (chunk) => {
    sent += chunk.length;
    report(false);
  });
  source.on("error", (e) => settle(transferError("SOURCE_ERROR", String(e && e.message), e)));
  sink.on("error", (e) => settle(transferError("SINK_ERROR", String(e && e.message), e)));
  // "close" on the sink, not "finish" on the source: finish means the last
  // write was ACCEPTED, close means it actually landed. Renaming on finish
  // races the final flush, and on a slow link that produces a correctly named
  // file that is a few kilobytes short.
  sink.on("close", () => {
    if (cancelled) return;
    report(true);
    settle(null);
  });

  source.pipe(sink);

  active.set(id, {
    sessionId: session.id,
    cancel() {
      if (finished) return false;
      cancelled = true;
      settle(transferError("CANCELLED", "cancelled by client"));
      return true;
    },
  });

  debugLog("sftp_transfer_start", {
    sessionId: session.id,
    id,
    direction,
    total,
  });
  return { id, total };
}

function cancelTransfer(id) {
  const entry = active.get(String(id));
  if (!entry) return false;
  return entry.cancel();
}

// Every transfer belonging to a session that is going away. Without this a
// disconnect leaves a pipe writing into a dead channel and a .part file that
// nothing will ever clean up.
function cancelSessionTransfers(sessionId) {
  let n = 0;
  for (const [id, entry] of Array.from(active.entries())) {
    if (entry.sessionId !== sessionId) continue;
    entry.cancel();
    active.delete(id);
    n++;
  }
  return n;
}

function activeCount() {
  return active.size;
}

module.exports = { startTransfer, cancelTransfer, cancelSessionTransfers, activeCount };
