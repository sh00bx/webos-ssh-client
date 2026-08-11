#!/usr/bin/env bash
# Cut a Homebrew Channel release: build the IPK, write the manifest the channel
# reads, and (unless --dry-run) tag and publish both as a GitHub release.
#
# The channel index lives in a DIFFERENT repository (sh00bx/webos-apps) and is
# not touched here — it points at `releases/latest/download/<manifest>`, and the
# manifest names its IPK relatively, so a new version needs no edit anywhere
# else. Two invariants keep that true, and both are asserted below:
#   - the manifest asset always has the same file name,
#   - the IPK it names is in the same release.
#
# Usage:
#   scripts/release.sh              # build, manifest, tag, publish
#   scripts/release.sh --dry-run    # build + manifest only, print what it would do
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

APP_ID="com.pwntastic.sshclient"
REPO="sh00bx/webos-ssh-client"
MANIFEST_NAME="$APP_ID.manifest.json"
VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"

# The IPK must be built BEFORE the manifest is written: scripts/build.sh wipes
# build/ on every run, so a manifest written first is simply deleted.
echo "[release] building $APP_ID $VERSION"
bash "$ROOT/scripts/build.sh" >/dev/null

IPK="$ROOT/build/${APP_ID}_${VERSION}_all.ipk"
[ -f "$IPK" ] || { echo "expected $IPK, not found" >&2; exit 1; }

SHA="$(sha256sum "$IPK" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$IPK")"
# What the app occupies once unpacked, which is what the channel shows as the
# install size. The IPK is an `ar` archive with a gzipped tar inside it.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
( cd "$WORK" && ar x "$IPK" )
INSTALLED="$(tar tzvf "$WORK/data.tar.gz" | awk '{s+=$3} END {print s}')"

MANIFEST="$ROOT/build/$MANIFEST_NAME"
cat > "$MANIFEST" <<EOF
{
  "id": "$APP_ID",
  "version": "$VERSION",
  "type": "web",
  "title": "webossh",
  "appDescription": "SSH client for LG webOS — a terminal panel above whatever is on screen, with SFTP on the same connection and a local root shell on the TV.",
  "iconUri": "https://raw.githubusercontent.com/sh00bx/webos-ssh-client/main/icon-large.png",
  "sourceUrl": "https://github.com/sh00bx/webos-ssh-client",
  "rootRequired": "optional",
  "ipkUrl": "$(basename "$IPK")",
  "ipkHash": {
    "sha256": "$SHA"
  },
  "ipkSize": $SIZE,
  "installedSize": $INSTALLED
}
EOF

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MANIFEST"
echo "[release] $MANIFEST"
echo "          sha256 $SHA  ipk ${SIZE}B  installed ${INSTALLED}B"

if [ "$DRY" = 1 ]; then
  echo "[release] dry run — would create $TAG on $REPO with:"
  echo "          $(basename "$IPK")"
  echo "          $MANIFEST_NAME"
  exit 0
fi

command -v gh >/dev/null || { echo "gh not on PATH" >&2; exit 1; }

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "[release] $TAG exists — replacing its assets"
  gh release upload "$TAG" -R "$REPO" --clobber "$IPK" "$MANIFEST"
else
  # 🚨 The tag is created SERVER-SIDE, on whatever the public repo's main is.
  # Never `git push <tag>` from here: this checkout is the development repo, and
  # pushing a tag pushes the commit it points at — with every one of its
  # ancestors. That is how the full development history ended up in a repository
  # that was published as a single snapshot commit (see
  # scripts/publish-github.sh, which is the only thing that should write history
  # there). Publish the snapshot first, then release against it.
  TARGET="$(gh api "repos/$REPO/commits/main" --jq .sha)"
  echo "[release] tagging $TAG at ${TARGET:0:8} (published snapshot)"
  gh release create "$TAG" -R "$REPO" --target "$TARGET" --title "webossh $VERSION" \
    --notes "Install from the Homebrew Channel: https://raw.githubusercontent.com/sh00bx/webos-apps/main/repo.json" \
    "$IPK" "$MANIFEST"
fi

echo "[release] verifying the URLs the channel will use"
BASE="https://github.com/$REPO/releases/latest/download"
for url in "$BASE/$MANIFEST_NAME" "$BASE/$(basename "$IPK")"; do
  code="$(curl -sL -o /dev/null -w '%{http_code}' "$url")"
  echo "          $code  $url"
  [ "$code" = "200" ] || { echo "release asset not reachable" >&2; exit 1; }
done

# A 200 is not enough after a re-upload: GitHub's release CDN keeps serving the
# PREVIOUS copy of an asset for a while, and a stale manifest beside a fresh IPK
# is the one failure that looks like a broken app rather than a broken release —
# the channel checks the hash and refuses to install. Wait for the copy the
# world can see to be the copy we just made.
echo "[release] waiting for the CDN to serve the manifest we just uploaded"
for attempt in $(seq 1 30); do
  served="$(curl -sL "$BASE/$MANIFEST_NAME?cb=$attempt$$" | tr -d ' \n' || true)"
  case "$served" in
    *"$SHA"*) echo "          fresh after ${attempt}0s"; exit 0;;
  esac
  sleep 10
done
echo "the published manifest still advertises an older IPK hash — do not announce this release yet" >&2
exit 1
