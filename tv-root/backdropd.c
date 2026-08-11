/*
 * backdropd — screen-colour sampler for the webos-ssh-client "Chameleon"
 * adaptive terminal theme.
 *
 * The webOS web layer cannot see the video plane behind a transparent app
 * (system compositing happens after the page is rendered), so a root-side
 * helper does it and publishes the result over a localhost TCP socket that
 * the app's jailed Node service can reach (the jail has network; it has no
 * luna ACL for the capture service).
 *
 * Two capture paths, best first:
 *
 *  - libvtcapture (dlopen'd): a continuous capture session on the VIDEO
 *    plane's scaler output. Frames rotate at content rate (~50/s measured on
 *    the G4) in shared buffers, so a fresh 192×108 NV12 frame costs one
 *    function call — no luna round trip, no fork, no temp file. This is the
 *    same mechanism hyperion-webos/PicCap use, and it is what makes a ~10 Hz
 *    effect affordable when the old path delivered ~1 Hz. It needs a luna
 *    role for the names libvtcapture registers (com.webos.service.capture.
 *    client* via LSRegister, com.webos.rm.client.* via the legacy
 *    LSRegisterPubPriv inside libums_connector_impl); the boot hook installs
 *    those. Without the role, vtCapture_create() throws a C++ exception that
 *    a C program cannot catch — so the manifest's presence is checked before
 *    ever touching the library, and a TV without it just keeps the old path.
 *
 *  - luna executeOneShot (fallback): the composited DISPLAY as a BMP file,
 *    ~200 ms and a fork per shot, paced at 700 ms. Used while vtcapture is
 *    unavailable (no role, no video pipeline, transient errors).
 *
 * The two differ in *content*, and the client needs to know which it got:
 * vtcapture serves the naked video plane (what is genuinely behind the shell
 * — our own window is OSD and absent from it), the oneshot serves the
 * finished screen with the shell composited in. Hence the source token in
 * the grid line.
 *
 * Protocol (line-based). After every capture each connected client receives
 *
 *     rgb R G B\n                      (decimal 0-255, whole-frame average)
 *
 * and, for clients that asked for it, additionally
 *
 *     grid W H SRC <base64 of W*H*3 bytes>\n
 *
 * — the frame reduced to a W×H tile grid, row-major from the TOP-LEFT, three
 * bytes (R,G,B) per tile; SRC is "video" (naked video plane) or "display"
 * (composited screen). A client opts in by sending one line
 *
 *     grid W H\n                       (W ≤ 96, H ≤ 54; "grid 0 0" turns it off)
 *
 * The average line is kept unconditionally so an older client keeps working
 * against a newer daemon. While the video plane is static (paused stream,
 * menu) nothing is sent at all — the client keeps its last state, which is
 * also correct.
 *
 * Captures run ONLY while at least one client is connected; with none the
 * vtcapture session is closed and the daemon is fully idle (blocked in poll).
 *
 * Deploy: /var/lib/webosbrew/backdropd, started by init.d hook 47-backdropd
 * (which also installs the luna role files). Build:
 *   arm-webos-linux-gnueabi-gcc -O2 -o backdropd backdropd.c -ldl
 * (dynamic, NOT -static: dlopen against the TV's glibc-linked vendor lib.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <dlfcn.h>
#include <stdint.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define PORT 8093
#define MAX_CLIENTS 4
/* Luna-fallback pace: a shot costs ~200 ms and a fork, so this stays slow. */
#define INTERVAL_MS 700
/* vtcapture pace: reading the current buffer is nearly free, and the client
   throttles its own expensive work (solve + repaint) independently — so the
   wire runs faster than the client paints, and every paint uses a frame at
   most this old instead of one whole client-interval old. 40 rather than 60
   purely for freshness (the client's solve floor is the rate limit anyway);
   static content costs nothing regardless, because the content hash decides
   what is sent. Do NOT return this to a multiple of 20 ms without reading
   frame_sample_hash first: 60 ms aliased against the 3-buffer rotation at
   50 fps. */
#define VT_INTERVAL_MS 40
#define VT_RETRY_MS 3000
/* Backoff after a session that never produced a frame — that is what "no
   video is playing" looks like from here, and probing for one is not free
   (session setup plus ~3 s of failing reads). The price is that a stream
   started during the backoff reaches the fast path this many ms late; the
   luna fallback is already serving it meanwhile. */
#define VT_IDLE_RETRY_MS 10000
/* An unchanged buffer this long triggers one session restart: a paused video
   also looks like this (harmless — the restart is invisible), but a torn-down
   pipeline only reports itself through the restart failing, and that failure
   is what drops us to the luna fallback instead of freezing on stale tiles. */
#define VT_STALL_RESTART_MS 10000
/* Consecutive bad currentCaptureBuffInfo() ticks before the session is torn
   down. The first frame after process() can take a few ticks to appear, so
   this must comfortably cover session warm-up. */
#define VT_MAX_FAILS 30
#define CAP_W 192
#define CAP_H 108
/* Ceilings for a requested grid. 96×54 is already finer than the capture
   itself (192×108 = 2×2 source pixels per tile); past that the extra tiles
   carry no new information and only cost payload. */
#define MAX_GRID_W 96
#define MAX_GRID_H 54
#define CAP_PATH "/tmp/backdropd.bmp"
#define PIDFILE "/tmp/backdropd.pid"
/* One request line is tiny ("grid 64 36\n"); anything longer is not ours. */
#define INBUF 64
/* Worst-case grid line: header + source token + base64 of 96*54*3 bytes. */
#define OUTBUF (48 + ((MAX_GRID_W * MAX_GRID_H * 3 + 2) / 3) * 4 + 2)
/* A client that will not take the frame within this budget is not worth
   blocking the sampler for. */
#define SEND_TIMEOUT_MS 300

static const char CAPTURE_CMD[] =
    "luna-send -n 1 luna://com.webos.service.capture/executeOneShot "
    "'{\"path\":\"" CAP_PATH "\",\"method\":\"DISPLAY\",\"format\":\"BMP\","
    "\"width\":" "192" ",\"height\":" "108" "}' >/dev/null 2>&1";

struct client {
  int fd;
  int grid_w; /* 0 = average only */
  int grid_h;
  char in[INBUF];
  int in_len;
};

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ---- libvtcapture, resolved at runtime ---------------------------------- */

typedef struct { int16_t x, y; } vt_loc;
typedef struct { int16_t w, h; } vt_resolution;
typedef struct { int16_t a, b, c, d; } vt_region;
typedef struct {
  int32_t dump;
  vt_loc loc;
  vt_resolution reg;
  int32_t buf_cnt;
  int32_t frm;
} vt_props;
typedef struct {
  int32_t stride;
  vt_region planeregion;
  vt_region activeregion;
} vt_plane_info;
typedef struct {
  char *start_addr0; /* Y */
  char *start_addr1; /* interleaved UV, NV12 */
  int32_t size0;
  int32_t size1;
} vt_buffer_info;

/* Scaler-side dump of the video path — the naked video plane, post-scaling,
   before OSD blending. (3 would be the blend, 4 the OSD; both verified live
   on the G4, this is the one the effect wants.) */
#define VT_DUMP_DISPLAY_OUTPUT 2

static struct {
  int tried;    /* dlopen attempted (successfully or not) */
  void *lib;    /* non-NULL once loaded */
  void *(*create)(void);
  int (*init)(void *, const char *, char *);
  int (*preprocess)(void *, char *, vt_props *);
  int (*planeinfo)(void *, char *, vt_plane_info *);
  int (*process)(void *, char *);
  int (*buffinfo)(void *, vt_buffer_info *);
  int (*stop)(void *, char *);
  int (*postprocess)(void *, char *);
  int (*finalize)(void *, char *);
  int (*release)(void *);
} vt_api;

static struct {
  int active;
  void *driver;
  char client[128];
  int w, h, stride;
  char *last_addr;          /* last buffer address seen, for liveness only */
  unsigned long last_hash;  /* content hash of the last frame sent */
  long long last_change_ms; /* when address OR content last moved */
  int fails;                /* consecutive buffinfo errors */
  int got_frame;            /* this session has produced at least one frame */
} vt;

static long long vt_next_retry_ms; /* earliest next session attempt */

/* The role manifest the boot hook installs. Without it, vtCapture_create()
   aborts the whole process on an uncatchable C++ exception (LSRegisterPubPriv
   throw inside libums_connector_impl), so its absence means "never try". */
#define VT_MANIFEST "/var/luna-service2-dev/manifests.d/backdropd.json"

static int vt_load(void) {
  if (vt_api.tried) return vt_api.lib != NULL;
  vt_api.tried = 1;
  if (access(VT_MANIFEST, F_OK) != 0) return 0;
  void *lib = dlopen("libvtcapture.so.1", RTLD_NOW);
  if (!lib) return 0;
  vt_api.create = (void *(*)(void))dlsym(lib, "vtCapture_create");
  vt_api.init = (int (*)(void *, const char *, char *))dlsym(lib, "vtCapture_init");
  vt_api.preprocess =
      (int (*)(void *, char *, vt_props *))dlsym(lib, "vtCapture_preprocess");
  vt_api.planeinfo =
      (int (*)(void *, char *, vt_plane_info *))dlsym(lib, "vtCapture_planeInfo");
  vt_api.process = (int (*)(void *, char *))dlsym(lib, "vtCapture_process");
  vt_api.buffinfo =
      (int (*)(void *, vt_buffer_info *))dlsym(lib, "vtCapture_currentCaptureBuffInfo");
  vt_api.stop = (int (*)(void *, char *))dlsym(lib, "vtCapture_stop");
  vt_api.postprocess = (int (*)(void *, char *))dlsym(lib, "vtCapture_postprocess");
  vt_api.finalize = (int (*)(void *, char *))dlsym(lib, "vtCapture_finalize");
  vt_api.release = (int (*)(void *))dlsym(lib, "vtCapture_release");
  if (!vt_api.create || !vt_api.init || !vt_api.preprocess || !vt_api.planeinfo ||
      !vt_api.process || !vt_api.buffinfo || !vt_api.stop || !vt_api.postprocess ||
      !vt_api.finalize || !vt_api.release) {
    dlclose(lib);
    return 0;
  }
  vt_api.lib = lib;
  return 1;
}

static void vt_stop_session(void) {
  if (!vt.active) return;
  vt_api.stop(vt.driver, vt.client);
  vt_api.postprocess(vt.driver, vt.client);
  vt_api.finalize(vt.driver, vt.client);
  vt_api.release(vt.driver);
  memset(&vt, 0, sizeof(vt));
}

static int vt_start_session(void) {
  memset(&vt, 0, sizeof(vt));
  void *drv = vt_api.create();
  if (!drv) return -1;
  snprintf(vt.client, sizeof(vt.client), "%s", "00");
  if (vt_api.init(drv, "backdropd", vt.client) != 0) {
    vt_api.release(drv);
    return -1;
  }
  vt_props props;
  memset(&props, 0, sizeof(props));
  props.dump = VT_DUMP_DISPLAY_OUTPUT;
  props.reg.w = CAP_W;
  props.reg.h = CAP_H;
  props.buf_cnt = 3;
  props.frm = 30; /* advisory; the G4 rotates at content rate regardless */
  if (vt_api.preprocess(drv, vt.client, &props) != 0) {
    vt_api.finalize(drv, vt.client);
    vt_api.release(drv);
    return -1;
  }
  vt_plane_info plane;
  memset(&plane, 0, sizeof(plane));
  if (vt_api.planeinfo(drv, vt.client, &plane) != 0 || plane.planeregion.c <= 0 ||
      plane.planeregion.c > CAP_W || plane.planeregion.d <= 0 ||
      plane.planeregion.d > CAP_H || plane.stride < plane.planeregion.c) {
    vt_api.postprocess(drv, vt.client);
    vt_api.finalize(drv, vt.client);
    vt_api.release(drv);
    return -1;
  }
  if (vt_api.process(drv, vt.client) != 0) {
    vt_api.stop(drv, vt.client);
    vt_api.postprocess(drv, vt.client);
    vt_api.finalize(drv, vt.client);
    vt_api.release(drv);
    return -1;
  }
  vt.driver = drv;
  vt.w = plane.planeregion.c;
  vt.h = plane.planeregion.d;
  vt.stride = plane.stride;
  vt.active = 1;
  vt.last_change_ms = now_ms();
  return 0;
}

/* Sparse content fingerprint of one NV12 frame (~1000 sampled bytes). "Has
   the picture changed" cannot be answered from the buffer ADDRESS alone: at
   50 fps — every European broadcast — the 3-buffer rotation takes exactly
   3 * 20 ms = 60 ms, the tick's own period, so the poll lands on the same
   buffer of the cycle every time and the address reads "unchanged" from a
   picture in full motion. Only clock drift occasionally slipped that lock,
   which put ONE frame every few seconds on the wire for live TV — the very
   content in front of which the effect is actually watched. Torn reads (the
   frame is being written while sampled) just mean one extra send; the client
   smooths harder than that. */
static unsigned long frame_sample_hash(const unsigned char *yp,
                                       const unsigned char *uvp,
                                       int cw, int ch, int stride) {
  unsigned long h = 1469598103ul;
  for (int y = 0; y < ch; y += 4) {
    const unsigned char *row = yp + (long)y * stride;
    for (int x = 0; x < cw; x += 8) h = h * 131 + row[x];
  }
  /* A few chroma samples too, so a pure colour shift under constant
     brightness (fades, tints) still counts as change. */
  int cuvh = ch / 2, cuvw = cw / 2;
  for (int y = 0; y < cuvh; y += 4) {
    const unsigned char *row = uvp + (long)y * stride;
    for (int x = 0; x < cuvw; x += 8) {
      h = h * 131 + row[2 * x];
      h = h * 131 + row[2 * x + 1];
    }
  }
  return h;
}

/* Reduce one NV12 frame to the tile grid and the whole-frame average.
   Limited-range BT.709, integer arithmetic — HDR streams land a little off,
   which the effect can afford (the old BMP path was no truer). grid_w/grid_h
   may be 0 (average only). */
static void nv12_reduce(const unsigned char *yp, const unsigned char *uvp,
                        int cw, int ch, int stride, int grid_w, int grid_h,
                        unsigned char *grid, int *avg_r, int *avg_g, int *avg_b) {
  static long ysum[MAX_GRID_W * MAX_GRID_H];
  static long ycnt[MAX_GRID_W * MAX_GRID_H];
  static long usum[MAX_GRID_W * MAX_GRID_H];
  static long vsum[MAX_GRID_W * MAX_GRID_H];
  static long uvcnt[MAX_GRID_W * MAX_GRID_H];
  int gw = grid_w > 0 ? grid_w : 1;
  int gh = grid_h > 0 ? grid_h : 1;
  int tiles = gw * gh;
  memset(ysum, 0, sizeof(long) * tiles);
  memset(ycnt, 0, sizeof(long) * tiles);
  memset(usum, 0, sizeof(long) * tiles);
  memset(vsum, 0, sizeof(long) * tiles);
  memset(uvcnt, 0, sizeof(long) * tiles);

  for (int y = 0; y < ch; y++) {
    const unsigned char *row = yp + (long)y * stride;
    int ty = (y * gh) / ch;
    long base = (long)ty * gw;
    for (int x = 0; x < cw; x++) {
      long t = base + (x * gw) / cw;
      ysum[t] += row[x];
      ycnt[t]++;
    }
  }
  int cuvh = ch / 2, cuvw = cw / 2;
  for (int y = 0; y < cuvh; y++) {
    const unsigned char *row = uvp + (long)y * stride;
    int ty = ((2 * y) * gh) / ch;
    long base = (long)ty * gw;
    for (int x = 0; x < cuvw; x++) {
      long t = base + ((2 * x) * gw) / cw;
      usum[t] += row[2 * x];
      vsum[t] += row[2 * x + 1];
      uvcnt[t]++;
    }
  }

  long tr = 0, tg = 0, tb = 0;
  for (int t = 0; t < tiles; t++) {
    int yv = ycnt[t] ? (int)(ysum[t] / ycnt[t]) : 16;
    int uv = uvcnt[t] ? (int)(usum[t] / uvcnt[t]) : 128;
    int vv = uvcnt[t] ? (int)(vsum[t] / uvcnt[t]) : 128;
    int c = yv - 16, d = uv - 128, e = vv - 128;
    /* BT.709: R = 1.164C + 1.793E; G = 1.164C - 0.213D - 0.533E;
               B = 1.164C + 2.112D — scaled by 256. */
    int r = (298 * c + 459 * e + 128) >> 8;
    int g = (298 * c - 55 * d - 136 * e + 128) >> 8;
    int b = (298 * c + 541 * d + 128) >> 8;
    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;
    if (grid_w > 0) {
      grid[t * 3] = (unsigned char)r;
      grid[t * 3 + 1] = (unsigned char)g;
      grid[t * 3 + 2] = (unsigned char)b;
    }
    tr += r;
    tg += g;
    tb += b;
  }
  /* Tiles are near-equal in size (192×108 over ≤96×54), so the unweighted
     tile mean is the frame mean for every purpose this average serves. */
  *avg_r = (int)(tr / tiles);
  *avg_g = (int)(tg / tiles);
  *avg_b = (int)(tb / tiles);
}

/* ---- luna oneshot fallback (BMP reduction) ------------------------------- */

static int read_le32(const unsigned char *p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24);
}

/* Reduce a 24bpp BMP to its average and, when grid_w/grid_h are non-zero, to a
   grid_w × grid_h tile grid written row-major from the top-left into `grid`
   (3 bytes per tile). Returns 0 on success.

   Orientation matters here in a way it never did for the average: a BMP with
   positive height is stored bottom-up, so the first row in the file is the
   bottom of the screen. Getting that backwards would flip the whole effect
   vertically — text at the top of the shell would take its colour from the
   picture at the bottom. */
static int bmp_reduce(const char *path, int *r, int *g, int *b,
                      int grid_w, int grid_h, unsigned char *grid) {
  static unsigned char buf[CAP_W * CAP_H * 3 + 4096];
  /* Tile accumulators: sums plus a per-tile pixel count, since the last tile
     in a row/column can be short when the capture size is not a multiple of
     the grid size. */
  static long sums[MAX_GRID_W * MAX_GRID_H * 3];
  static long counts[MAX_GRID_W * MAX_GRID_H];
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof(buf));
  close(fd);
  if (n < 54 || buf[0] != 'B' || buf[1] != 'M') return -1;
  int offset = read_le32(buf + 10);
  int width = read_le32(buf + 18);
  int height = read_le32(buf + 22);
  int bpp = buf[28] | (buf[29] << 8);
  if (bpp != 24 || width <= 0 || width > CAP_W) return -1;
  int bottom_up = 1;
  if (height < 0) {
    height = -height;
    bottom_up = 0;
  }
  if (height <= 0 || height > CAP_H) return -1;
  if (offset < 54 || offset > n) return -1;
  int tiles = grid_w * grid_h;
  if (tiles) {
    memset(sums, 0, sizeof(long) * tiles * 3);
    memset(counts, 0, sizeof(long) * tiles);
  }
  int stride = ((width * 3) + 3) & ~3;
  long sum_r = 0, sum_g = 0, sum_b = 0, count = 0;
  for (int y = 0; y < height; y++) {
    long row = (long)offset + (long)y * stride;
    if (row + (long)width * 3 > n) break;
    const unsigned char *px = buf + row;
    /* Screen-space row: BMP row 0 is the bottom when stored bottom-up. */
    int sy = bottom_up ? (height - 1 - y) : y;
    int ty = tiles ? (sy * grid_h) / height : 0;
    for (int x = 0; x < width; x++, px += 3) {
      sum_b += px[0];
      sum_g += px[1];
      sum_r += px[2];
      count++;
      if (!tiles) continue;
      int tx = (x * grid_w) / width;
      long t = (long)ty * grid_w + tx;
      sums[t * 3] += px[2];
      sums[t * 3 + 1] += px[1];
      sums[t * 3 + 2] += px[0];
      counts[t]++;
    }
  }
  if (!count) return -1;
  *r = (int)(sum_r / count);
  *g = (int)(sum_g / count);
  *b = (int)(sum_b / count);
  if (tiles) {
    for (int t = 0; t < tiles; t++) {
      /* An empty tile can only happen if the capture came back smaller than
         the grid; the screen average is the least wrong answer for it. */
      long c = counts[t];
      grid[t * 3] = (unsigned char)(c ? sums[t * 3] / c : *r);
      grid[t * 3 + 1] = (unsigned char)(c ? sums[t * 3 + 1] / c : *g);
      grid[t * 3 + 2] = (unsigned char)(c ? sums[t * 3 + 2] / c : *b);
    }
  }
  return 0;
}

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Standard base64 with padding. Returns the number of characters written. */
static int b64_encode(const unsigned char *src, int len, char *dst) {
  int o = 0;
  for (int i = 0; i < len; i += 3) {
    int b0 = src[i];
    int b1 = (i + 1 < len) ? src[i + 1] : 0;
    int b2 = (i + 2 < len) ? src[i + 2] : 0;
    dst[o++] = B64[b0 >> 2];
    dst[o++] = B64[((b0 & 3) << 4) | (b1 >> 4)];
    dst[o++] = (i + 1 < len) ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    dst[o++] = (i + 2 < len) ? B64[b2 & 63] : '=';
  }
  return o;
}

/* Write the whole buffer or give up. The sockets are non-blocking so a large
   grid line can be split by the kernel's send buffer; treating a short write
   as success (which was safe for the 16-byte average line) would put a
   truncated frame on the wire and desynchronise the client's line parser for
   good. Returns 0 on success, -1 if the client should be dropped. */
static int send_all(int fd, const char *buf, int len) {
  int sent = 0;
  while (sent < len) {
    ssize_t w = send(fd, buf + sent, len - sent, 0);
    if (w > 0) {
      sent += (int)w;
      continue;
    }
    if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd p;
      p.fd = fd;
      p.events = POLLOUT;
      int rc = poll(&p, 1, SEND_TIMEOUT_MS);
      if (rc > 0 && (p.revents & POLLOUT)) continue;
      return -1;
    }
    if (w < 0 && errno == EINTR) continue;
    return -1;
  }
  return 0;
}

/* "grid W H" — the only request the protocol has. Anything else is ignored,
   which keeps stray input harmless. */
static void handle_request(struct client *c, const char *line) {
  int w, h;
  if (sscanf(line, "grid %d %d", &w, &h) != 2) return;
  if (w <= 0 || h <= 0) {
    c->grid_w = 0;
    c->grid_h = 0;
    return;
  }
  c->grid_w = w > MAX_GRID_W ? MAX_GRID_W : w;
  c->grid_h = h > MAX_GRID_H ? MAX_GRID_H : h;
}

/* Consume whatever arrived and dispatch complete lines. Returns -1 on EOF. */
static int client_read(struct client *c) {
  char tmp[128];
  ssize_t rn = recv(c->fd, tmp, sizeof(tmp), 0);
  if (rn == 0) return -1;
  if (rn < 0) return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
  for (ssize_t i = 0; i < rn; i++) {
    char ch = tmp[i];
    if (ch == '\n' || ch == '\r') {
      if (c->in_len) {
        c->in[c->in_len] = '\0';
        handle_request(c, c->in);
      }
      c->in_len = 0;
      continue;
    }
    /* Overlong line: keep dropping until the terminator rather than
       truncating it into something that might parse. */
    if (c->in_len < INBUF - 1) c->in[c->in_len++] = ch;
  }
  return 0;
}

int main(void) {
  /* pidfile duplicate-start guard (start-stop-daemon --exec cannot match a
     previous instance reliably across updates; see 45-ds5-tmpld notes). */
  int pfd = open(PIDFILE, O_RDONLY);
  if (pfd >= 0) {
    char pidbuf[16] = {0};
    read(pfd, pidbuf, sizeof(pidbuf) - 1);
    close(pfd);
    int oldpid = atoi(pidbuf);
    if (oldpid > 0 && kill(oldpid, 0) == 0) return 0; /* already running */
  }
  pfd = open(PIDFILE, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (pfd >= 0) {
    char pidbuf[16];
    int len = snprintf(pidbuf, sizeof(pidbuf), "%d\n", getpid());
    write(pfd, pidbuf, len);
    close(pfd);
  }

  signal(SIGPIPE, SIG_IGN);

  int lsock = socket(AF_INET, SOCK_STREAM, 0);
  if (lsock < 0) return 1;
  int one = 1;
  setsockopt(lsock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* localhost only */
  addr.sin_port = htons(PORT);
  if (bind(lsock, (struct sockaddr *)&addr, sizeof(addr)) < 0) return 1;
  if (listen(lsock, 4) < 0) return 1;

  static unsigned char grid[MAX_GRID_W * MAX_GRID_H * 3];
  static char out[OUTBUF];
  struct client clients[MAX_CLIENTS];
  int nclients = 0;
  long long last_luna_ms = 0;

  for (;;) {
    struct pollfd pfds[1 + MAX_CLIENTS];
    int npolled = nclients; /* pfds[] below covers exactly this many clients */
    pfds[0].fd = lsock;
    pfds[0].events = POLLIN;
    for (int i = 0; i < npolled; i++) {
      pfds[1 + i].fd = clients[i].fd;
      pfds[1 + i].events = POLLIN; /* requests, and EOF detection */
    }
    /* Idle forever with no clients; otherwise pace the capture loop at the
       cadence of whichever path is live. */
    int timeout = npolled ? (vt.active ? VT_INTERVAL_MS : INTERVAL_MS) : -1;
    int rc = poll(pfds, 1 + npolled, timeout);
    if (rc < 0) {
      if (errno == EINTR) continue;
      return 1;
    }

    /* Service readable clients first: a request must be applied before the
       capture it was meant for. Only entries that were actually polled this
       round are inspected. */
    for (int k = 0; k < npolled; k++) {
      if (!(pfds[1 + k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      int fd = pfds[1 + k].fd;
      int idx = -1;
      for (int i = 0; i < nclients; i++) {
        if (clients[i].fd == fd) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue;
      if (client_read(&clients[idx]) < 0) {
        close(fd);
        clients[idx] = clients[--nclients];
      }
    }

    if (pfds[0].revents & POLLIN) {
      int c = accept(lsock, NULL, NULL);
      if (c >= 0) {
        if (nclients < MAX_CLIENTS) {
          fcntl(c, F_SETFL, O_NONBLOCK);
          memset(&clients[nclients], 0, sizeof(struct client));
          clients[nclients].fd = c;
          nclients++;
        } else {
          close(c);
        }
      }
    }

    if (!nclients) {
      vt_stop_session(); /* nobody watching — stop holding the video path */
      continue;
    }

    /* One capture, one reduction, at the finest grid anyone asked for. Tile
       boundaries differ per grid size, so a second size would mean a second
       pass over the pixels; instead every grid client is served this grid and
       told its real dimensions in the line header. In practice there is
       exactly one client — the app's own service. */
    int want_w = 0, want_h = 0;
    for (int i = 0; i < nclients; i++) {
      if (clients[i].grid_w > want_w) want_w = clients[i].grid_w;
      if (clients[i].grid_h > want_h) want_h = clients[i].grid_h;
    }

    long long now = now_ms();
    int avg_r = 0, avg_g = 0, avg_b = 0;
    const char *src = "display";
    int have_frame = 0;

    if (!vt.active && vt_load() && now >= vt_next_retry_ms) {
      if (vt_start_session() != 0) vt_next_retry_ms = now + VT_RETRY_MS;
    }

    if (vt.active) {
      vt_buffer_info buf;
      memset(&buf, 0, sizeof(buf));
      if (vt_api.buffinfo(vt.driver, &buf) != 0 || !buf.start_addr0 ||
          !buf.start_addr1) {
        if (++vt.fails >= VT_MAX_FAILS) {
          /* A session that never yielded a frame is what "no video playing"
             looks like; probing again in 3 s would put the feed on a 50%
             duty cycle for as long as the home screen is up. */
          int had = vt.got_frame;
          vt_stop_session();
          vt_next_retry_ms = now + (had ? VT_RETRY_MS : VT_IDLE_RETRY_MS);
        }
      } else {
        vt.fails = 0;
        /* What to SEND is decided by content (see frame_sample_hash); the
           address only proves the pipeline is alive. */
        unsigned long hash = frame_sample_hash(
            (const unsigned char *)buf.start_addr0,
            (const unsigned char *)buf.start_addr1, vt.w, vt.h, vt.stride);
        if (buf.start_addr0 != vt.last_addr) {
          vt.last_addr = buf.start_addr0;
          vt.last_change_ms = now;
        }
        if (hash != vt.last_hash || !vt.got_frame) {
          vt.last_hash = hash;
          vt.last_change_ms = now;
          nv12_reduce((const unsigned char *)buf.start_addr0,
                      (const unsigned char *)buf.start_addr1, vt.w, vt.h,
                      vt.stride, want_w, want_h, grid, &avg_r, &avg_g, &avg_b);
          src = "video";
          have_frame = 1;
          vt.got_frame = 1;
        } else if (now - vt.last_change_ms > VT_STALL_RESTART_MS) {
          /* Static content: the client's state is already right, sending the
             same frame again would only burn its solve budget. Neither the
             address nor the content moving for this long earns the one
             restart that smokes out a dead pipeline (see above); a paused
             video whose buffers still rotate never restarts at all. */
          vt_stop_session();
          vt_next_retry_ms = now; /* retry immediately next tick */
        }
      }
    }

    /* The luna fallback serves whenever vtcapture is not delivering — which
       includes an open session still warming up (its first frame can be
       seconds away if it ever comes). It does NOT run while vtcapture has
       delivered and merely reports "unchanged": that is a valid answer, and
       the composited oneshot would repaint the client's map with our own
       window baked in. Paced separately because the loop ticks at the vt
       cadence, and a ~200 ms blocking fork per 100 ms tick would not fit. */
    if (!have_frame && !(vt.active && vt.got_frame)) {
      if (now - last_luna_ms >= INTERVAL_MS) {
        last_luna_ms = now;
        if (system(CAPTURE_CMD) == 0 &&
            bmp_reduce(CAP_PATH, &avg_r, &avg_g, &avg_b, want_w, want_h, grid) == 0)
          have_frame = 1;
      }
    }
    if (!have_frame) continue;

    char avg_line[32];
    int avg_len =
        snprintf(avg_line, sizeof(avg_line), "rgb %d %d %d\n", avg_r, avg_g, avg_b);

    int grid_len = 0;
    if (want_w && want_h) {
      grid_len = snprintf(out, sizeof(out), "grid %d %d %s ", want_w, want_h, src);
      grid_len += b64_encode(grid, want_w * want_h * 3, out + grid_len);
      out[grid_len++] = '\n';
    }

    for (int i = 0; i < nclients;) {
      int drop = send_all(clients[i].fd, avg_line, avg_len) < 0;
      if (!drop && clients[i].grid_w && grid_len) {
        drop = send_all(clients[i].fd, out, grid_len) < 0;
      }
      if (drop) {
        close(clients[i].fd);
        clients[i] = clients[--nclients];
      } else {
        i++;
      }
    }
  }
}
