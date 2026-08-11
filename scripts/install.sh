#!/usr/bin/env bash
# Install the most recent IPK from build/ on the configured TV via
# ares-install, then launch the app via ares-launch.
#
# Usage: scripts/install.sh [device-name]
#        With no argument the device named "tv" is used when it exists (that is
#        the name docs/INSTALL.md tells you to create); otherwise the device
#        ares itself flags as default. Do NOT just omit --device: ares falls
#        back to the literal name "emulator" when nothing is flagged default,
#        so an argument-less run would silently target the emulator.
set -euo pipefail

DEVICE="${1:-}"
APP_ID="com.pwntastic.sshclient"

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD_DIR="$ROOT/build"

resolve() {
  local cmd="$1"
  local found
  found="$(command -v "$cmd" || true)"
  if [ -z "$found" ] && [ -x "$HOME/.npm-global/bin/$cmd" ]; then
    found="$HOME/.npm-global/bin/$cmd"
  fi
  if [ -z "$found" ]; then
    echo "$cmd not found. Install with: npm install -g @webosose/ares-cli" >&2
    exit 1
  fi
  echo "$found"
}

ARES_INSTALL="$(resolve ares-install)"
ARES_LAUNCH="$(resolve ares-launch)"

IPK="$(ls -t "$BUILD_DIR"/*.ipk 2>/dev/null | head -1)"
if [ -z "$IPK" ]; then
  echo "No IPK in $BUILD_DIR. Run scripts/build.sh first." >&2
  exit 1
fi

if [ -z "$DEVICE" ]; then
  DEVICE_LIST="$("$ARES_INSTALL" --device-list 2>/dev/null || true)"
  if printf '%s\n' "$DEVICE_LIST" | grep -qE '^tv[[:space:]]'; then
    DEVICE="tv"
  else
    DEVICE="$(printf '%s\n' "$DEVICE_LIST" | awk '/\(default\)/ {print $1; exit}')"
  fi
  if [ -z "$DEVICE" ]; then
    echo "No ares device found. Add one with ares-setup-device --add tv --info ..." >&2
    exit 1
  fi
  echo "[install] no device given, using '$DEVICE'"
fi

echo "[install] $IPK -> $DEVICE"
"$ARES_INSTALL" --device "$DEVICE" "$IPK"

echo "[launch] $APP_ID on $DEVICE"
"$ARES_LAUNCH" --device "$DEVICE" "$APP_ID"
