#!/usr/bin/env bash
# Install the local-shell helper on a ROOTED TV from a development machine:
# build ptyd, copy it and its boot hook into /var/lib/webosbrew/, and start it.
#
# NOTE (0.8.0): end users do not need this. ptyd and backdropd now travel inside
# the IPK and install themselves on first start, using Homebrew Channel to get
# root (src/root-helpers.js). This script stays because it is the fast path
# while working on the C: it builds from tv-root/ptyd.c and pushes the result
# without rebuilding or reinstalling the app.
#
# Requires root SSH to the TV, which on a webosbrew-rooted device is the
# openssh the Homebrew Channel installs. Usage:
#
#   TV_HOST=192.168.0.50 scripts/install-ptyd.sh
#   TV_HOST=192.168.0.50 TV_KEY=~/.ssh/LG scripts/install-ptyd.sh
#   TV_HOST=192.168.0.50 scripts/install-ptyd.sh --uninstall
#
# If the key is passphrase-protected, load it into an agent FIRST — this script
# does not prompt, and ssh inheriting no agent would hang on a TTY that may not
# be there.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

TV_HOST="${TV_HOST:-}"
if [ -z "$TV_HOST" ]; then
  echo "Set TV_HOST=<tv-ip> (and TV_KEY=<path> if your root key is not ~/.ssh/LG)." >&2
  exit 2
fi
TV_USER="${TV_USER:-root}"
TV_KEY="${TV_KEY:-$HOME/.ssh/LG}"
DEST_DIR="/var/lib/webosbrew"
HOOK_DIR="$DEST_DIR/init.d"

SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
[ -f "$TV_KEY" ] && SSH_OPTS+=(-i "$TV_KEY")

tv() { ssh "${SSH_OPTS[@]}" "$TV_USER@$TV_HOST" "$@"; }

# Stop a running daemon. The pid is VALIDATED before use rather than passed
# straight to kill: this runs as root on the TV, and an unquoted `kill $(cat
# …)` word-splits whatever is in the file into kill's argument list — content
# like "-9 -1" would then be a whole-TV kill. (The pidfile now lives inside the
# daemon's own 0700 directory, so that is belt and braces, but the script also
# has to cope with a stale file from an older layout.)
STOP_CMD='p=""; for f in /tmp/.sshclient-ptyd/ptyd.pid /tmp/ptyd.pid; do
            [ -f "$f" ] && p=$(cat "$f" 2>/dev/null) && break
          done
          case "$p" in ""|*[!0-9]*) ;; *) kill "$p" 2>/dev/null;; esac
          rm -f /tmp/.sshclient-ptyd/ptyd.pid /tmp/ptyd.pid'

if [ "${1:-}" = "--uninstall" ]; then
  echo "[ptyd] removing from $TV_HOST"
  # Kill first, then remove: the running daemon holds the socket, and leaving
  # it listening after the binary is gone would be the worst of both.
  tv "$STOP_CMD; \
      rm -rf /tmp/.sshclient-ptyd; \
      rm -f /var/lib/webosbrew/ptyd /var/lib/webosbrew/init.d/48-ptyd; \
      echo '[tv] removed'"
  exit 0
fi

echo "[ptyd] building"
bash "$ROOT/scripts/build-ptyd.sh" >/dev/null
BIN="$ROOT/tv-root/ptyd"
[ -f "$BIN" ] || { echo "build produced no $BIN" >&2; exit 1; }

echo "[ptyd] checking $TV_HOST"
tv "mkdir -p '$HOOK_DIR'" >/dev/null

# rm before scp, never overwrite in place: replacing a RUNNING binary gets
# ETXTBSY on this platform, and a partially written one is worse than none.
# The daemon is stopped first for the same reason.
echo "[ptyd] stopping any running instance"
tv "$STOP_CMD; rm -f /var/lib/webosbrew/ptyd; true" >/dev/null

echo "[ptyd] copying binary + boot hook"
scp "${SSH_OPTS[@]}" "$BIN" "$TV_USER@$TV_HOST:$DEST_DIR/ptyd" >/dev/null
scp "${SSH_OPTS[@]}" "$ROOT/tv-root/48-ptyd" "$TV_USER@$TV_HOST:$HOOK_DIR/48-ptyd" >/dev/null
tv "chmod 755 '$DEST_DIR/ptyd' '$HOOK_DIR/48-ptyd'" >/dev/null

echo "[ptyd] starting"
tv "sh '$HOOK_DIR/48-ptyd'" >/dev/null

# Verify against the thing the app actually needs — the socket, with the right
# owner — rather than against "the process is running". A daemon that came up
# and bound a socket the jailed service cannot open is the failure mode worth
# catching here, and it is invisible in `ps`.
echo "[ptyd] verifying"
tv 'sleep 1; ls -l /tmp/.sshclient-ptyd/ptyd.sock 2>&1; \
    printf "pid: "; cat /tmp/.sshclient-ptyd/ptyd.pid 2>/dev/null || echo "(no pidfile)"; \
    printf "storage owner: "; ls -ld /media/internal/.com.pwntastic.sshclient 2>/dev/null | awk "{print \$3}" || echo "(app has not run yet)"'

cat <<'EOF'

Done. The "Local shell" button on the connect form (or Ctrl+Alt+L) now opens a
root shell on the TV. The boot hook restarts ptyd after a reboot.

If the socket above is owned by root rather than by the service uid, the app
has never run on this TV yet: start it once, then re-run this script so ptyd
picks up the right owner.
EOF
