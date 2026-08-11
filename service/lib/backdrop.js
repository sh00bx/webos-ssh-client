// Backdrop colour feed for the "Chameleon" adaptive theme. backdropd is a
// tiny root daemon (deployed via webosbrew boot hook; sources in tv-root/)
// that samples the composited screen — video plane included — through the LG
// capture luna service and pushes "rgb R G B" lines on 127.0.0.1:8093. The
// jailed service has no luna ACL for the capture service, but the jail does
// have loopback network access, so TCP is the bridge. backdropd captures only
// while a client socket is open; keeping the socket connected exactly while
// subscribers exist is what turns the effect on and off for free.
//
// Since the daemon also serves the screen as a tile grid ("grid W H <base64>",
// row-major from the top-left, 3 bytes per tile), this asks for one on every
// connect and forwards it verbatim: the client needs the picture *behind each
// glyph*, which no single average can carry. A daemon predating the grid
// ignores the request line and keeps sending averages, and the client falls
// back to a single colour — so an un-updated TV degrades instead of breaking.
const net = require("net");
const { safeRespond, getMessageToken } = require("./util");
const { debugLog } = require("./debug-log");

const BACKDROP_PORT = 8093;
// 30×30 screen pixels per tile at 1080p — about three character cells wide,
// and 3×3 source pixels of the daemon's 192×108 capture, so it is close to the
// point where a finer grid would only be interpolating. One frame is 9 KB of
// base64 at ~1.4 Hz.
const BACKDROP_GRID_W = 64;
const BACKDROP_GRID_H = 36;
// How long an average waits for the grid of the same capture before being sent
// on its own. Comfortably longer than the gap between two lines of one frame
// (they are written back to back) and comfortably shorter than the capture
// interval, so a daemon that stops sending grids costs one frame, not a stall.
const BACKDROP_GRID_WAIT_MS = 300;
const BACKDROP_RETRY_MS = 10000;
const backdropWatchers = new Map(); // token -> subscription message
let backdropSocket = null;
let backdropRetryTimer = null;
let backdropBuffer = "";
let backdropAvailable = false;
// Whether this daemon serves grids at all, and the average held back waiting
// for one (see the note where they are used).
let gridSeen = false;
let pendingAverage = null;
let pendingTimer = null;
// The newest average seen on the wire, kept beyond its own data event. The
// daemon writes the average, then the grid, per frame — but a 9 KB grid very
// often completes in a LATER read than its 16-byte average, and at the
// vtcapture cadence (~9 frames/s) the chunking settles into exactly that
// phase for every frame. A completed grid therefore pairs with this, not
// with an average from its own event.
let lastAverage = null;

function buildBody(average, grid) {
  const body = {
    returnValue: true,
    subscribed: true,
    available: true,
    r: average.r,
    g: average.g,
    b: average.b,
  };
  if (grid) body.grid = grid;
  return body;
}

function clearPendingAverage() {
  pendingAverage = null;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function backdropBroadcast(body) {
  for (const watcher of backdropWatchers.values()) {
    safeRespond(watcher, body);
  }
}

function backdropTeardown() {
  if (backdropRetryTimer) {
    clearTimeout(backdropRetryTimer);
    backdropRetryTimer = null;
  }
  if (backdropSocket) {
    const sock = backdropSocket;
    backdropSocket = null;
    try {
      sock.destroy();
    } catch (e) {
      /* already gone */
    }
  }
  backdropBuffer = "";
  backdropAvailable = false;
  gridSeen = false;
  lastAverage = null;
  clearPendingAverage();
}

function backdropScheduleRetry() {
  if (backdropRetryTimer || !backdropWatchers.size) return;
  backdropRetryTimer = setTimeout(() => {
    backdropRetryTimer = null;
    backdropConnect();
  }, BACKDROP_RETRY_MS);
  if (typeof backdropRetryTimer.unref === "function") backdropRetryTimer.unref();
}

function backdropConnect() {
  if (backdropSocket || !backdropWatchers.size) return;
  const sock = net.connect({ host: "127.0.0.1", port: BACKDROP_PORT });
  backdropSocket = sock;
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    if (sock !== backdropSocket) return;
    try {
      sock.write(`grid ${BACKDROP_GRID_W} ${BACKDROP_GRID_H}\n`);
    } catch (e) {
      /* averages still arrive; the client degrades to a single colour */
    }
  });
  sock.on("data", (chunk) => {
    if (sock !== backdropSocket) return;
    backdropBuffer += chunk;
    const lines = backdropBuffer.split("\n");
    backdropBuffer = lines.pop();
    let latest = null;
    let latestGrid = null;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = /^rgb (\d+) (\d+) (\d+)$/.exec(trimmed);
      if (m) {
        latest = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
        continue;
      }
      // The grid follows the average it belongs to, so a chunk holding more
      // than one frame keeps the newest of each and drops the rest — the
      // colour of a frame nobody will see is not worth a message. The
      // optional source token says what the tiles are a picture OF: "video"
      // is the naked video plane (nothing of our own window in it), the
      // default "display" is the composited screen, panel included — the
      // client un-composites the panel only in the second case.
      const gm = /^grid (\d+) (\d+) (?:([a-z]+) )?([A-Za-z0-9+/=]+)$/.exec(trimmed);
      if (gm) {
        latestGrid = {
          w: Number(gm[1]),
          h: Number(gm[2]),
          src: gm[3] === "video" ? "video" : "display",
          data: gm[4],
        };
      }
    }
    if (latest) lastAverage = latest;
    if (!lastAverage) return; // a grid before any average has nothing to ride on
    if (!backdropAvailable) {
      backdropAvailable = true;
      debugLog("backdrop_available", { grid: Boolean(latestGrid) });
    }
    // Only when the payload is the length the header claims: a short read that
    // slipped through would decode to a grid with a torn last row, which the
    // client cannot tell from a real one.
    let grid = null;
    if (latestGrid && latestGrid.w > 0 && latestGrid.h > 0) {
      const expected = Math.ceil((latestGrid.w * latestGrid.h * 3) / 3) * 4;
      if (latestGrid.data.length === expected) grid = latestGrid;
    }

    // The two lines of one capture do not necessarily arrive together: the
    // average is 16 bytes and the grid is 9 KB, so a read very often ends
    // between them — at the fast-path cadence, for EVERY frame. Forwarding the
    // average on its own tells the client "this frame has no grid" (which used
    // to flash the per-glyph map away), and dropping a grid because no average
    // shared its read would starve the map at full feed rate. So an average
    // waits briefly for a grid, and a completed grid pairs with the newest
    // average seen on the wire — the daemon writes them in that order.
    if (grid) {
      gridSeen = true;
      clearPendingAverage();
      backdropBroadcast(buildBody(lastAverage, grid));
      return;
    }
    if (!latest) return; // nothing new completed in this read
    if (!gridSeen) {
      // A daemon that predates the grid never sends one; nothing to wait for.
      backdropBroadcast(buildBody(latest, null));
      return;
    }
    // Hold it, but not forever: if the grid stops coming (daemon replaced or
    // restarted without the request) the feed has to keep working.
    pendingAverage = latest;
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const held = pendingAverage;
        pendingAverage = null;
        if (held && backdropWatchers.size) {
          gridSeen = false;
          debugLog("backdrop_grid_lost", {});
          backdropBroadcast(buildBody(held, null));
        }
      }, BACKDROP_GRID_WAIT_MS);
      if (typeof pendingTimer.unref === "function") pendingTimer.unref();
    }
  });
  const onGone = () => {
    if (sock !== backdropSocket) return;
    const wasAvailable = backdropAvailable;
    backdropSocket = null;
    backdropBuffer = "";
    backdropAvailable = false;
    gridSeen = false;
    lastAverage = null;
    clearPendingAverage();
    if (!backdropWatchers.size) return;
    if (wasAvailable) {
      debugLog("backdrop_lost", {});
      backdropBroadcast({ returnValue: true, subscribed: true, available: false });
    }
    backdropScheduleRetry();
  };
  sock.on("error", () => {
    /* close fires next; onGone handles both paths */
  });
  sock.on("close", onGone);
}

function registerBackdrop(register) {
  register(
    "backdrop/watch",
    (message) => {
      if (!message.isSubscription) {
        return safeRespond(message, {
          returnValue: false,
          errorCode: "SUBSCRIPTION_REQUIRED",
          errorText: "call with subscribe:true",
        });
      }
      const token = getMessageToken(message);
      if (!token) {
        return safeRespond(message, {
          returnValue: false,
          errorCode: "NO_TOKEN",
          errorText: "subscription token unavailable",
        });
      }
      backdropWatchers.set(token, message);
      debugLog("backdrop_watch_add", { watchers: backdropWatchers.size });
      safeRespond(message, {
        returnValue: true,
        subscribed: true,
        available: backdropAvailable,
      });
      backdropConnect();
    },
    (message) => {
      const token = getMessageToken(message);
      if (token) backdropWatchers.delete(token);
      debugLog("backdrop_watch_remove", { watchers: backdropWatchers.size });
      if (!backdropWatchers.size) backdropTeardown();
    },
  );
}

module.exports = { registerBackdrop };
