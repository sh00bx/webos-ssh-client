/*
 * ptyd — pseudo-terminal provider for the webos-ssh-client "local shell".
 *
 * WHY THIS EXISTS (measured on LG-prod, webOS 25 / Rockhopper 10.3.0-25):
 * the app's Node service runs chrooted into /var/palm/jail/<service>/ as uid
 * 5301 with CapEff=0, and that jail's /dev contains exactly six entries —
 * console, log, logdir, null, shm, urandom. There is NO /dev/ptmx and NO
 * /dev/pts (verified: opening /dev/ptmx from inside the jail returns ENOENT).
 * So a terminal session cannot be created in-process no matter which library
 * is used: openpty(), forkpty(), and the busybox `script` applet all need the
 * ptmx multiplexor. The same wall is why every other webOS terminal project
 * ships a native helper.
 *
 * The helper therefore runs OUTSIDE the jail as root, allocates the pty
 * itself, and hands the two byte streams to the jailed service over a unix
 * socket. This mirrors backdropd, which is in this directory for the same
 * structural reason (a capability the jail does not have, exposed over a
 * loopback socket) — read that one first if this is your entry point.
 *
 * A UNIX socket rather than backdropd's loopback TCP, deliberately: this one
 * hands out a ROOT SHELL, and a TCP port on 127.0.0.1 is reachable by every
 * process on the TV. A socket inode carries ownership, so the kernel does the
 * access control for us — the socket is chowned to the uid that owns the app's
 * storage directory (i.e. whoever the jailer assigned to our service) and left
 * at mode 0600, inside a 0700 directory. Caveat worth stating plainly: webOS
 * hands the same uid 5301 to sideloaded devmode services in general, so this
 * keeps out other users and the sandboxed built-in apps, not a second devmode
 * service you installed yourself. On a rooted TV that is the same trust
 * boundary the app's key storage already lives behind (see service/lib/
 * config.js) — it is not a new exposure, but it is not a jail either.
 *
 * PROTOCOL — length-prefixed frames, identical framing in both directions:
 *
 *     [type:1][length:4 big-endian][payload:length]
 *
 *   client -> daemon
 *     0x04 HELLO   4 bytes: cols u16be, rows u16be
 *                  Must be first. The shell is spawned when it arrives (or
 *                  after HELLO_TIMEOUT_MS with defaults) so the very first
 *                  prompt is already drawn at the real window size.
 *     0x01 DATA    keystrokes / pasted text, written to the pty master
 *     0x02 RESIZE  4 bytes: cols u16be, rows u16be -> TIOCSWINSZ
 *
 *   daemon -> client
 *     0x05 READY   5 bytes: version u8, child pid u32be
 *     0x01 DATA    pty output
 *     0x03 EXIT    1 byte: exit status (0xff when the shell was signalled)
 *
 * Unknown frame types are skipped by length, so a newer client stays
 * compatible with this daemon as long as the framing holds. The JS side of
 * this protocol is service/lib/pty-frames.js — change the two together.
 *
 * One shell per connection, at most MAX_CLIENTS at a time. Flow control runs
 * in both directions: while a peer's buffer holds data we stop READING the
 * other side, so `cat /dev/urandom` throttles instead of ballooning the
 * daemon's memory.
 *
 * Deploy: /var/lib/webosbrew/ptyd, started by init.d hook 48-ptyd.
 * Build (see scripts/build-ptyd.sh):
 *   arm-buildroot-linux-musleabi-gcc -O2 -static -o ptyd ptyd.c
 * Static musl on purpose — no dlopen, no vendor library, nothing to break on
 * a firmware update, and it runs on the armhf userland under the aarch64
 * kernel.
 */
/* grantpt/unlockpt/ptsname are guarded behind _XOPEN_SOURCE in both musl's and
   glibc's <stdlib.h>, and the toolchain default (gnu17) does not set it. */
#define _GNU_SOURCE 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <limits.h>

#define PTYD_VERSION 1

#define SOCK_DIR "/tmp/.sshclient-ptyd"
#define SOCK_PATH SOCK_DIR "/ptyd.sock"
/* Opened relative to SOCK_DIR's descriptor, never by path — see main(). */
#define PIDFILE_NAME "ptyd.pid"
#define PIDFILE SOCK_DIR "/" PIDFILE_NAME
/* Whoever owns this directory is the uid the jailer gave our service; the
   socket is chowned to match. Falls back to FALLBACK_UID when the app has
   never run (fresh install, storage dir not created yet). */
#define OWNER_PROBE_DIR "/media/internal/.com.pwntastic.sshclient"
#define FALLBACK_UID 5301
#define FALLBACK_GID 5000

#define MAX_CLIENTS 4
/* Big enough that a full-screen repaint (a 4K-sized grid is ~200x60 cells
   with attributes) lands in one or two reads, small enough to be irrelevant
   to a TV's memory budget at MAX_CLIENTS. */
#define BUF_SIZE (128 * 1024)
/* A single frame's payload ceiling. Anything larger is a desynchronised or
   hostile peer, not a keystroke — drop the connection rather than trying to
   buffer it. */
#define MAX_PAYLOAD (64 * 1024)
#define FRAME_HEADER 5
/* A client that connects and then says nothing still gets a shell, so an
   interactive probe (`nc -U`) is not a dead session. */
#define HELLO_TIMEOUT_MS 2000

#define F_DATA 0x01
#define F_RESIZE 0x02
#define F_EXIT 0x03
#define F_HELLO 0x04
#define F_READY 0x05

#define DEFAULT_SHELL "/bin/sh"
#define DEFAULT_HOME "/home/root"
#define DEFAULT_PATH "/usr/sbin:/usr/bin:/sbin:/bin"

struct client {
  int sock;    /* unix socket to the jailed service */
  int master;  /* pty master; -1 before spawn and after the shell exits */
  pid_t child; /* shell pid; -1 before spawn and after it is reaped */
  /* The shell's process group, kept SEPARATELY from `child` because the
     reaper clears child the moment the shell dies — and the hangup at
     teardown is exactly the case where it has died. */
  pid_t pgid;
  long long accepted_ms;
  int spawned;
  int reaped;       /* child gone — flush what is queued, then close */
  int dead;         /* closed this pass; compacted out after the loop */
  int exit_pending; /* EXIT frame still to be queued (buffer was full) */
  unsigned char exit_code;
  /* Bytes read from the socket, awaiting frame parsing. Sized so one
     maximum-length frame always fits whole. */
  unsigned char in[FRAME_HEADER + MAX_PAYLOAD];
  int in_len;
  /* Parsed DATA payloads on their way to the pty master. */
  unsigned char to_pty[BUF_SIZE];
  int to_pty_len;
  /* Framed pty output on its way to the socket. */
  unsigned char to_sock[BUF_SIZE];
  int to_sock_len;
};

static volatile sig_atomic_t child_exited = 0;

static void on_sigchld(int sig) {
  (void)sig;
  child_exited = 1;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Append to a linear buffer, refusing rather than truncating: a partial frame
   on the wire desynchronises the peer's parser permanently, so the caller
   treats "does not fit" as backpressure and stops reading the source. */
static int buf_append(unsigned char *buf, int *len, const unsigned char *src,
                      int n) {
  if (n <= 0) return 0;
  if (*len + n > BUF_SIZE) return -1;
  memcpy(buf + *len, src, (size_t)n);
  *len += n;
  return 0;
}

static void buf_consume(unsigned char *buf, int *len, int n) {
  if (n <= 0) return;
  if (n >= *len) {
    *len = 0;
    return;
  }
  memmove(buf, buf + n, (size_t)(*len - n));
  *len -= n;
}

/* Queue one frame for the client. Returns -1 when it does not fit, which the
   caller turns into backpressure on the pty side. */
static int queue_frame(struct client *c, unsigned char type,
                       const unsigned char *payload, int len) {
  unsigned char header[FRAME_HEADER];
  if (c->to_sock_len + FRAME_HEADER + len > BUF_SIZE) return -1;
  header[0] = type;
  header[1] = (unsigned char)((len >> 24) & 0xff);
  header[2] = (unsigned char)((len >> 16) & 0xff);
  header[3] = (unsigned char)((len >> 8) & 0xff);
  header[4] = (unsigned char)(len & 0xff);
  buf_append(c->to_sock, &c->to_sock_len, header, FRAME_HEADER);
  if (len > 0) buf_append(c->to_sock, &c->to_sock_len, payload, len);
  return 0;
}

static void apply_winsize(int master, int cols, int rows) {
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
  ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
  ioctl(master, TIOCSWINSZ, &ws);
}

/* openpty() by hand: it is four POSIX calls, and doing it here keeps the
   daemon free of libutil (which the musl static build would have to grow a
   dependency on for no other reason). */
static int pty_open(int *master_out, char *slave_name, size_t slave_len) {
  int master = open("/dev/ptmx", O_RDWR | O_NOCTTY);
  if (master < 0) return -1;
  if (grantpt(master) < 0 || unlockpt(master) < 0) {
    close(master);
    return -1;
  }
  const char *name = ptsname(master);
  if (!name || strlen(name) >= slave_len) {
    close(master);
    return -1;
  }
  strncpy(slave_name, name, slave_len - 1);
  slave_name[slave_len - 1] = '\0';
  *master_out = master;
  return 0;
}

/* Fork the login shell onto a fresh pty. Parent keeps the master. */
static pid_t spawn_shell(const char *shell, int cols, int rows,
                         int *master_out) {
  char slave_name[128];
  int master = -1;
  if (pty_open(&master, slave_name, sizeof(slave_name)) < 0) return -1;
  apply_winsize(master, cols, rows);

  pid_t pid = fork();
  if (pid < 0) {
    close(master);
    return -1;
  }
  if (pid == 0) {
    /* Child: become a session leader so the pty is a real CONTROLLING
       terminal. Without that there is no job control, ^C does not raise
       SIGINT, and curses apps misbehave in ways that read as "the shell is
       broken" rather than as a missing ioctl. */
    setsid();
    int slave = open(slave_name, O_RDWR);
    if (slave < 0) _exit(127);
    ioctl(slave, TIOCSCTTY, 0);
    dup2(slave, STDIN_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDERR_FILENO);
    if (slave > STDERR_FILENO) close(slave);
    close(master);
    /* The daemon's own descriptors (listen socket, the other clients' masters
       and sockets) must not leak into a root shell the user is about to type
       into. */
    for (int fd = STDERR_FILENO + 1; fd < 64; fd++) close(fd);

    signal(SIGPIPE, SIG_DFL);
    signal(SIGCHLD, SIG_DFL);

    /* A deliberate, minimal environment, passed explicitly rather than
       inherited: the boot hook's environment carries none of what an
       interactive shell needs and whatever init happened to export. TERM has
       to agree with what the client actually renders (xterm.js — 256 colours
       plus truecolour). */
    struct stat st;
    const char *home = (stat(DEFAULT_HOME, &st) == 0 && S_ISDIR(st.st_mode))
                           ? DEFAULT_HOME
                           : "/";
    if (chdir(home) != 0 && chdir("/") != 0) _exit(127);
    char home_env[128];
    char pwd_env[128];
    char shell_env[192];
    snprintf(home_env, sizeof(home_env), "HOME=%s", home);
    snprintf(pwd_env, sizeof(pwd_env), "PWD=%s", home);
    snprintf(shell_env, sizeof(shell_env), "SHELL=%s", shell);
    char *envp[] = {
        (char *)"TERM=xterm-256color",
        (char *)"COLORTERM=truecolor",
        (char *)"PATH=" DEFAULT_PATH,
        (char *)"USER=root",
        (char *)"LOGNAME=root",
        home_env,
        pwd_env,
        shell_env,
        NULL,
    };
    /* argv[0] with a leading dash is what makes busybox ash (and every other
       Bourne shell) run as a LOGIN shell, i.e. read /etc/profile. */
    execle(shell, "-sh", (char *)NULL, envp);
    _exit(127);
  }

  set_nonblock(master);
  *master_out = master;
  return pid;
}

/* Spawn this connection's shell and tell the client about it. BOTH spawn sites
   go through here — the HELLO frame and the HELLO timeout — because they used
   to differ: the timeout path forked a perfectly good shell and never sent
   READY, so a client whose HELLO was late got a live shell it could not use
   and then failed its own 5s ready timeout blaming the daemon. */
static void client_spawn(struct client *c, const char *shell, int cols,
                         int rows) {
  c->spawned = 1;
  c->child = spawn_shell(shell, cols, rows, &c->master);
  if (c->child < 0) return;
  c->pgid = c->child; /* the child called setsid(), so it leads its own group */
  unsigned char ready[5];
  ready[0] = PTYD_VERSION;
  ready[1] = (unsigned char)((c->child >> 24) & 0xff);
  ready[2] = (unsigned char)((c->child >> 16) & 0xff);
  ready[3] = (unsigned char)((c->child >> 8) & 0xff);
  ready[4] = (unsigned char)(c->child & 0xff);
  queue_frame(c, F_READY, ready, sizeof(ready));
}

static void client_close(struct client *c) {
  if (c->sock >= 0) close(c->sock);
  if (c->master >= 0) close(c->master);
  /* SIGHUP the shell's process group, which is what a real terminal hangup
     looks like. Gated on pgid rather than on `child`: the reaper sets child to
     -1 as soon as the shell exits, and a shell that has ALREADY exited leaving
     a child behind is precisely the case this exists for — gating on child
     meant the signal was never sent then.
     Residual, and the same in every terminal emulator: a job the user
     backgrounded with `&` under job control sits in its OWN process group and
     is not reached by this. Closing the master already hangs up the foreground
     group; reaching the rest would mean walking /proc for the session id. */
  if (c->pgid > 0) kill(-c->pgid, SIGHUP);
  if (c->child > 0) kill(c->child, SIGHUP);
  c->sock = -1;
  c->master = -1;
  c->child = -1;
  c->pgid = -1;
  c->dead = 1;
}

/* Parse whatever complete frames are buffered. Returns -1 when the connection
   must be dropped (protocol violation), 0 otherwise. */
static int client_parse(struct client *c, const char *shell) {
  for (;;) {
    if (c->in_len < FRAME_HEADER) return 0;
    unsigned char type = c->in[0];
    long len = ((long)c->in[1] << 24) | ((long)c->in[2] << 16) |
               ((long)c->in[3] << 8) | (long)c->in[4];
    if (len < 0 || len > MAX_PAYLOAD) return -1;
    if (c->in_len < FRAME_HEADER + len) return 0;
    unsigned char *payload = c->in + FRAME_HEADER;

    if (type == F_HELLO || type == F_RESIZE) {
      int cols = 80, rows = 24;
      if (len >= 4) {
        cols = (payload[0] << 8) | payload[1];
        rows = (payload[2] << 8) | payload[3];
      }
      if (type == F_HELLO && !c->spawned) {
        client_spawn(c, shell, cols, rows);
        if (c->child < 0) return -1;
      } else if (c->master >= 0) {
        apply_winsize(c->master, cols, rows);
      }
    } else if (type == F_DATA) {
      /* DATA before the spawn is legal and buffered: the HELLO-timeout spawn
         flushes it into the shell. */
      if (buf_append(c->to_pty, &c->to_pty_len, payload, (int)len) < 0) {
        /* The pty is not draining. Leave the frame unconsumed — the socket
           stops being polled for reads until there is room, and the POLLOUT
           path re-enters here once the master has taken some bytes. */
        return 0;
      }
    }
    /* Unknown types fall through to the consume below: skipped by length,
       which is what lets a newer client talk to this daemon. */
    buf_consume(c->in, &c->in_len, (int)(FRAME_HEADER + len));
  }
}

int main(int argc, char **argv) {
  const char *shell = DEFAULT_SHELL;
  const char *sock_path = SOCK_PATH;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "-s") && i + 1 < argc) shell = argv[++i];
    else if (!strcmp(argv[i], "-p") && i + 1 < argc) sock_path = argv[++i];
  }

  signal(SIGPIPE, SIG_IGN);
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_sigchld;
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, NULL);

  /* Who may connect. See the header comment: the socket's owner IS the access
     control, so getting this wrong either locks the app out or opens a root
     shell to every uid on the TV. */
  uid_t owner_uid = FALLBACK_UID;
  gid_t owner_gid = FALLBACK_GID;
  struct stat probe;
  if (stat(OWNER_PROBE_DIR, &probe) == 0 && probe.st_uid != 0) {
    owner_uid = probe.st_uid;
    owner_gid = probe.st_gid;
  }

  /* 🔑 Create the socket directory WITHOUT ever touching it by path again.
     /tmp is world-writable and sticky and is shared with the jail, tmpfs is
     empty at boot, and this daemon starts late (boot hook 48) — so any local
     uid can get there first and plant a SYMLINK named .sshclient-ptyd. mkdir()
     then returns EEXIST, and a path-based chown/chmod after it would follow
     that link and hand an attacker-chosen directory to our uid at mode 0700:
     root-privileged arbitrary chown, one boot hook away from full root. The
     fix is to open the directory with O_NOFOLLOW|O_DIRECTORY and do everything
     through the descriptor, which cannot be redirected afterwards.
     A leftover directory is accepted only when root or our own service uid
     owns it — the first is what a previous run of THIS code leaves behind
     before the chown, the second is what it leaves after. */
  /* The directory is derived from the socket path rather than fixed, so
     `-p /some/where/ptyd.sock` is genuinely self-contained — which is what
     lets tests/ptyd-e2e.manual.mjs run a real daemon in a temp directory
     without colliding with an installed one. */
  char dir_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  snprintf(dir_path, sizeof(dir_path), "%s", sock_path);
  char *slash = strrchr(dir_path, '/');
  if (!slash || slash == dir_path) return 1;
  *slash = '\0';

  mkdir(dir_path, 0700);
  int dirfd = open(dir_path, O_DIRECTORY | O_NOFOLLOW | O_RDONLY);
  if (dirfd < 0) return 1; /* a symlink or a non-directory sits there */
  struct stat dst;
  if (fstat(dirfd, &dst) != 0 || !S_ISDIR(dst.st_mode) ||
      (dst.st_uid != 0 && dst.st_uid != owner_uid &&
       dst.st_uid != geteuid())) {
    close(dirfd);
    return 1;
  }
  if (fchown(dirfd, owner_uid, owner_gid) != 0) { /* best effort */ }
  fchmod(dirfd, 0700);

  /* Duplicate-start guard, same reasoning as backdropd: the boot hook runs
     again after a firmware update or a manual re-run, and start-stop-daemon
     --exec cannot match a previous instance reliably once the binary has been
     replaced underneath it. The pidfile lives INSIDE the 0700 directory above
     and is opened relative to that descriptor with O_NOFOLLOW — as a fixed
     /tmp path it was both a root-privileged arbitrary truncate (symlink) and a
     one-line permanent denial of service (write "1", kill(1,0) succeeds, ptyd
     refuses to start for the rest of the boot). The parsed pid is
     range-checked rather than trusted to atoi. */
  int pfd = openat(dirfd, PIDFILE_NAME, O_RDONLY | O_NOFOLLOW);
  if (pfd >= 0) {
    char pidbuf[16] = {0};
    ssize_t rn = read(pfd, pidbuf, sizeof(pidbuf) - 1);
    close(pfd);
    if (rn > 0) {
      pidbuf[rn] = '\0';
      char *end = NULL;
      long oldpid = strtol(pidbuf, &end, 10);
      if (end != pidbuf && oldpid > 1 && oldpid <= INT_MAX &&
          kill((pid_t)oldpid, 0) == 0) {
        close(dirfd);
        return 0; /* already running */
      }
    }
  }
  pfd = openat(dirfd, PIDFILE_NAME, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
               0600);
  if (pfd >= 0) {
    char pidbuf[16];
    int len = snprintf(pidbuf, sizeof(pidbuf), "%d\n", getpid());
    if (write(pfd, pidbuf, (size_t)len) < 0) { /* pidfile is advisory */ }
    close(pfd);
  }
  close(dirfd);

  unlink(sock_path);
  int lsock = socket(AF_UNIX, SOCK_STREAM, 0);
  if (lsock < 0) return 1;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, sock_path, sizeof(addr.sun_path) - 1);
  /* umask so bind() itself never leaves a world-writable inode on disk, even
     for the instant before the chmod below lands. */
  mode_t old_umask = umask(0177);
  int bound = bind(lsock, (struct sockaddr *)&addr, sizeof(addr));
  umask(old_umask);
  if (bound < 0) return 1;
  if (chown(sock_path, owner_uid, owner_gid) != 0) { /* best effort */ }
  chmod(sock_path, 0600);
  if (listen(lsock, 4) < 0) return 1;
  set_nonblock(lsock);

  static struct client clients[MAX_CLIENTS];
  int nclients = 0;

  for (;;) {
    if (child_exited) {
      child_exited = 0;
      for (;;) {
        int status = 0;
        pid_t gone = waitpid(-1, &status, WNOHANG);
        if (gone <= 0) break;
        for (int i = 0; i < nclients; i++) {
          if (clients[i].child != gone) continue;
          clients[i].exit_code =
              (unsigned char)(WIFEXITED(status) ? WEXITSTATUS(status) : 0xff);
          clients[i].exit_pending = 1;
          clients[i].child = -1;
          clients[i].reaped = 1;
        }
      }
    }

    struct pollfd pfds[1 + 2 * MAX_CLIENTS];
    int slot_sock[MAX_CLIENTS];
    int slot_master[MAX_CLIENTS];
    /* Cleared for EVERY slot, not just the ones in use: accept() below can add
       a client after this array was filled, and that client's slots would
       otherwise be read as uninitialised stack — an arbitrary index into
       pfds[]. It simply waits for the next poll instead. */
    for (int i = 0; i < MAX_CLIENTS; i++) {
      slot_sock[i] = -1;
      slot_master[i] = -1;
    }
    int npolled = 1;
    pfds[0].fd = lsock;
    pfds[0].events = POLLIN;
    pfds[0].revents = 0;

    int timeout = -1;
    for (int i = 0; i < nclients; i++) {
      struct client *c = &clients[i];

      /* Retry a deferred EXIT frame as soon as the outbound buffer drained. */
      if (c->exit_pending && queue_frame(c, F_EXIT, &c->exit_code, 1) == 0) {
        c->exit_pending = 0;
      }

      short sev = 0;
      /* Stop reading the socket while either the pty-bound buffer or the
         frame-assembly buffer is full — that is the backpressure keeping a
         paste bigger than the pty's own buffer from being dropped. */
      if (c->to_pty_len < BUF_SIZE && c->in_len < (int)sizeof(c->in)) {
        sev |= POLLIN;
      }
      if (c->to_sock_len > 0) sev |= POLLOUT;
      if (sev) {
        slot_sock[i] = npolled;
        pfds[npolled].fd = c->sock;
        pfds[npolled].events = sev;
        pfds[npolled].revents = 0;
        npolled++;
      }

      if (c->master >= 0) {
        short mev = 0;
        /* Symmetrically: stop reading the pty while the socket-bound buffer is
           full, so a runaway `cat` throttles instead of growing us. */
        if (c->to_sock_len + FRAME_HEADER < BUF_SIZE) mev |= POLLIN;
        if (c->to_pty_len > 0) mev |= POLLOUT;
        if (mev) {
          slot_master[i] = npolled;
          pfds[npolled].fd = c->master;
          pfds[npolled].events = mev;
          pfds[npolled].revents = 0;
          npolled++;
        }
      }

      if (!c->spawned) {
        long long due = c->accepted_ms + HELLO_TIMEOUT_MS - now_ms();
        if (due < 0) due = 0;
        if (timeout < 0 || due < timeout) timeout = (int)due;
      }
    }

    int rc = poll(pfds, (nfds_t)npolled, timeout);
    if (rc < 0) {
      if (errno == EINTR) continue;
      return 1;
    }

    long long now = now_ms();

    if (pfds[0].revents & POLLIN) {
      int fd = accept(lsock, NULL, NULL);
      if (fd >= 0) {
        if (nclients >= MAX_CLIENTS) {
          close(fd);
        } else {
          set_nonblock(fd);
          struct client *c = &clients[nclients++];
          memset(c, 0, sizeof(*c));
          c->sock = fd;
          c->master = -1;
          c->child = -1;
          c->accepted_ms = now;
        }
      }
    }

    for (int i = 0; i < nclients; i++) {
      struct client *c = &clients[i];
      int drop = 0;

      /* A client that never sent HELLO still gets a shell, at the default
         size — `nc -U` for a smoke test should land in a usable shell. */
      if (!c->spawned && now - c->accepted_ms >= HELLO_TIMEOUT_MS) {
        client_spawn(c, shell, 80, 24);
        if (c->child < 0) drop = 1;
      }

      /* The shell has been reaped but its master is still open. Drain what it
         wrote before exiting, then close the master ourselves.
         poll() cannot drive this: a process the shell left behind (`sleep 300
         &` then `exit`) keeps the SLAVE open, so the master reports neither
         POLLIN (nothing more to read) nor POLLHUP (the slave is still there)
         and neither returns EIO — the connection, its two descriptors and its
         MAX_CLIENTS slot were held forever, while the client kept believing
         the session was live and wrote keystrokes into a master nobody read.
         Draining BEFORE closing is what keeps the shell's last line. */
      if (!drop && c->reaped && c->child < 0 && c->master >= 0) {
        for (;;) {
          int cap = BUF_SIZE - c->to_sock_len - FRAME_HEADER;
          if (cap <= 0) break; /* no room; resume after the socket drains */
          unsigned char chunk[16 * 1024];
          if (cap > (int)sizeof(chunk)) cap = (int)sizeof(chunk);
          ssize_t rn = read(c->master, chunk, (size_t)cap);
          if (rn > 0) {
            queue_frame(c, F_DATA, chunk, (int)rn);
            continue;
          }
          if (rn < 0 && errno == EINTR) continue;
          /* EOF, EIO, or EAGAIN with nothing left: all mean "done". */
          close(c->master);
          c->master = -1;
          break;
        }
      }

      int si = slot_sock[i];
      int mi = slot_master[i];

      if (!drop && si >= 0 && (pfds[si].revents & POLLIN)) {
        int room = (int)sizeof(c->in) - c->in_len;
        if (room > 0) {
          ssize_t rn = recv(c->sock, c->in + c->in_len, (size_t)room, 0);
          if (rn == 0) {
            drop = 1;
          } else if (rn < 0) {
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
              drop = 1;
            }
          } else {
            c->in_len += (int)rn;
            if (client_parse(c, shell) < 0) drop = 1;
          }
        }
      }
      if (!drop && si >= 0 &&
          (pfds[si].revents & (POLLERR | POLLHUP | POLLNVAL))) {
        drop = 1;
      }

      /* POLLHUP is deliberately part of the trigger, not a separate branch.
         The kernel reports it on a pty master as soon as the slave side is
         gone, and it does so WHETHER OR NOT it was requested — so a shell that
         exits without leaving output behind sets POLLHUP with no POLLIN, and a
         read-on-POLLIN-only branch never notices the session ended. (It also
         never stops: poll returns immediately on the same POLLHUP forever,
         which is a busy loop on a TV.) Reading first and treating the hangup
         as end-of-stream only once the read comes up empty is what keeps the
         shell's last line — POLLIN and POLLHUP arrive together when both are
         true. */
      if (!drop && mi >= 0 && c->master >= 0 &&
          (pfds[mi].revents & (POLLIN | POLLHUP | POLLERR))) {
        unsigned char chunk[16 * 1024];
        int cap = BUF_SIZE - c->to_sock_len - FRAME_HEADER;
        if (cap > (int)sizeof(chunk)) cap = (int)sizeof(chunk);
        int hung_up = (pfds[mi].revents & (POLLHUP | POLLERR)) != 0;
        if (cap > 0) {
          ssize_t rn = read(c->master, chunk, (size_t)cap);
          if (rn > 0) {
            queue_frame(c, F_DATA, chunk, (int)rn);
          } else if (rn == 0 || (rn < 0 && errno == EIO)) {
            /* EIO on a pty master is the slave side closing, i.e. the shell
               exited. The EXIT frame comes from the SIGCHLD path; all this
               does is stop polling a dead master. */
            close(c->master);
            c->master = -1;
            c->reaped = 1;
          } else if (rn < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            /* Nothing left to drain — if the peer is gone, we are done. */
            if (hung_up) {
              close(c->master);
              c->master = -1;
              c->reaped = 1;
            }
          } else if (rn < 0 && errno != EINTR) {
            drop = 1;
          }
        } else if (hung_up && c->to_pty_len == 0) {
          /* No room to take more output and no way to make any: the shell is
             gone and the socket side is what still has to drain. */
          close(c->master);
          c->master = -1;
          c->reaped = 1;
        }
      }

      if (!drop && mi >= 0 && c->master >= 0 &&
          (pfds[mi].revents & POLLOUT) && c->to_pty_len > 0) {
        ssize_t wn = write(c->master, c->to_pty, (size_t)c->to_pty_len);
        if (wn > 0) {
          buf_consume(c->to_pty, &c->to_pty_len, (int)wn);
          /* Room again: whatever was left unparsed on the wire can move. */
          if (client_parse(c, shell) < 0) drop = 1;
        } else if (wn < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
                   errno != EINTR) {
          drop = 1;
        }
      }

      if (!drop && si >= 0 && (pfds[si].revents & POLLOUT) &&
          c->to_sock_len > 0) {
        ssize_t wn = send(c->sock, c->to_sock, (size_t)c->to_sock_len, 0);
        if (wn > 0) {
          buf_consume(c->to_sock, &c->to_sock_len, (int)wn);
        } else if (wn < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
                   errno != EINTR) {
          drop = 1;
        }
      }

      /* The shell is gone and its last output plus the EXIT frame have been
         delivered — nothing more will ever come from this connection. */
      if (!drop && c->reaped && c->master < 0 && c->child < 0 &&
          !c->exit_pending && c->to_sock_len == 0) {
        drop = 1;
      }

      if (drop) client_close(c);
    }

    /* Compact AFTER the pass, never inside it. Swapping the tail into a freed
       slot mid-loop makes the moved client inherit the dropped one's entry in
       slot_sock[]/slot_master[] — i.e. its revents — and a client that moved
       into the slot of one that just hung up is then dropped for POLLHUP it
       never got. That cost a full debugging session: the symptom was that a
       session opened right after a reachability probe died instantly with
       EPIPE, which reads like a daemon crash and is not. */
    {
      int kept = 0;
      for (int i = 0; i < nclients; i++) {
        if (clients[i].dead) continue;
        if (kept != i) clients[kept] = clients[i];
        kept++;
      }
      nclients = kept;
    }
  }
}
