#!/usr/bin/env bash
# Build the webOS IPK:
#   1. bundle the frontend with esbuild,
#   2. install service-side npm prod deps,
#   3. stage app + service into build/stage/,
#   4. ares-package the staged dirs.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD_DIR="$ROOT/build"
STAGE_APP="$BUILD_DIR/stage/app"
STAGE_SVC="$BUILD_DIR/stage/service"

ARES_PACKAGE="$(command -v ares-package || true)"
if [ -z "$ARES_PACKAGE" ] && [ -x "$HOME/.npm-global/bin/ares-package" ]; then
  ARES_PACKAGE="$HOME/.npm-global/bin/ares-package"
fi
if [ -z "$ARES_PACKAGE" ]; then
  echo "ares-package not found. Install with:" >&2
  echo "  npm install -g @webosose/ares-cli" >&2
  exit 1
fi

echo "[build] cleaning $BUILD_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$STAGE_APP" "$STAGE_SVC"

VERSION="$(node -p 'require("./package.json").version')"
echo "[build] version $VERSION (from package.json)"

echo "[build] bundling frontend"
( cd "$ROOT" && npm run --silent build:frontend )

echo "[build] staging app"
# package.json is the single source of the version: it is injected into the
# bundle (build:frontend) and stamped into the staged appinfo.json here, so the
# badge in the UI can never disagree with the installed app again.
node -e '
  const fs = require("fs");
  const info = JSON.parse(fs.readFileSync("appinfo.json", "utf8"));
  info.version = process.argv[1];
  fs.writeFileSync(process.argv[2], JSON.stringify(info, null, 2) + "\n");
' "$VERSION" "$STAGE_APP/appinfo.json"
cp "$ROOT/index.html" "$STAGE_APP/"
cp -r "$ROOT/dist" "$STAGE_APP/"
[ -f "$ROOT/icon.png" ] && cp "$ROOT/icon.png" "$STAGE_APP/"
[ -f "$ROOT/icon-large.png" ] && cp "$ROOT/icon-large.png" "$STAGE_APP/"
[ -d "$ROOT/assets" ] && cp -r "$ROOT/assets" "$STAGE_APP/"

# The two root helpers travel INSIDE the app payload (src/root-helpers.js copies
# them to /var/lib/webosbrew on start, using Homebrew Channel's exec as the way
# to get root). Unconditional and fail-loud: a build that quietly produced an
# IPK without them would install cleanly, run, and simply have no local shell
# and no adaptive theme — the kind of failure nobody reports as a build problem.
# Binaries are committed rather than cross-compiled here on purpose; the
# toolchain is not a build dependency of the app (scripts/build-ptyd.sh rebuilds
# them when the C changes).
echo "[build] staging root helpers"
mkdir -p "$STAGE_APP/tv-root"
for f in ptyd backdropd 47-backdropd 48-ptyd; do
  cp "$ROOT/tv-root/$f" "$STAGE_APP/tv-root/$f"
  chmod 755 "$STAGE_APP/tv-root/$f"
done

echo "[build] installing service prod deps"
( cd "$ROOT/service" && npm ci --omit=dev --no-fund --no-audit --silent )

echo "[build] staging service"
# Copy services.json, package.json, service.js, lib/, and node_modules — drop
# the lockfile (the device runtime does not need it). Forgetting lib/ would
# pass every local check and then kill the service on the TV with
# MODULE_NOT_FOUND at the first Luna call.
cp "$ROOT/service/services.json" "$STAGE_SVC/"
cp "$ROOT/service/package.json" "$STAGE_SVC/"
cp "$ROOT/service/service.js" "$STAGE_SVC/"
# Unconditional on purpose: a missing lib/ must fail the build loudly here,
# not surface as MODULE_NOT_FOUND on the TV.
cp -r "$ROOT/service/lib" "$STAGE_SVC/"
if [ -d "$ROOT/service/node_modules" ]; then
  cp -r "$ROOT/service/node_modules" "$STAGE_SVC/"
  echo "[build] pruning service native/test artifacts"
  find "$STAGE_SVC/node_modules" -type f -name "*.node" -delete
  find "$STAGE_SVC/node_modules" -type d \
    \( -name build -o -name test -o -name tests -o -name .github \) \
    -prune -exec rm -rf {} +
fi

echo "[build] ares-package"
"$ARES_PACKAGE" -o "$BUILD_DIR" "$STAGE_APP" "$STAGE_SVC"

echo "[build] result:"
ls -lh "$BUILD_DIR"/*.ipk
