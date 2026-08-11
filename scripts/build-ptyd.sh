#!/usr/bin/env bash
# Cross-compile tv-root/ptyd.c for the TV.
#
# Static musl on purpose. backdropd next to it is built DYNAMIC because it
# dlopen's a vendor library (libvtcapture) and therefore has to match the TV's
# glibc; ptyd calls nothing but libc, so a static binary is strictly better —
# no interpreter, no version skew, and a firmware update cannot break it.
#
# The result is an ELF32 ARM binary. The TV's kernel is aarch64 but its
# userland is 32-bit ARM (backdropd, ds5_txd and every other helper on that
# device are ELF32), so this is the right target.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/tv-root/ptyd"

# The Bootlin musl toolchain, the same one the other static ARM helpers in this
# workspace are built with. Override CC to use a different one.
DEFAULT_CC="$HOME/x-tools/armv5-eabi--musl--stable-2025.08-1/bin/arm-buildroot-linux-musleabi-gcc"
CC="${CC:-$DEFAULT_CC}"

if ! command -v "$CC" >/dev/null 2>&1 && [ ! -x "$CC" ]; then
  echo "cross compiler not found: $CC" >&2
  echo "Set CC=/path/to/arm-...-gcc, or install the Bootlin armv5 musl toolchain." >&2
  exit 1
fi

# -Werror here and not only in CI: this binary runs as root and forks shells,
# so a warning is not something to look at later.
echo "[build-ptyd] $CC -> $OUT"
"$CC" -O2 -Wall -Wextra -Werror -static -o "$OUT" "$ROOT/tv-root/ptyd.c"

if command -v file >/dev/null 2>&1; then
  file "$OUT"
fi
ls -lh "$OUT"
