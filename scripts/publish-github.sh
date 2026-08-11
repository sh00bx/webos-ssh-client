#!/usr/bin/env bash
# Publish this working tree to the public GitHub repository as ONE snapshot
# commit per release.
#
# The development history lives on my own Forgejo: hundreds of commits, four
# long review documents, half of it a diary of things that turned out to be
# wrong. That is the right thing to keep for me and the wrong thing to hand a
# stranger who wants to read the code or file an issue. So GitHub gets the tree,
# not the archaeology: everything needed to build, run, package and understand
# the app, and nothing that only means something to the person who wrote it.
#
# What is left out is the whole difference between the two repositories — it is
# the EXCLUDE list below, and it is deliberately short. If something is worth
# keeping out of the public tree, put it there rather than deleting it from the
# working copy.
#
#   scripts/publish-github.sh --dry-run   # print the file list and stop
#   scripts/publish-github.sh             # commit + push the snapshot
#
# Releases are cut separately, by scripts/release.sh, against the same repo.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
REPO="sh00bx/webos-ssh-client"
REMOTE="https://github.com/$REPO.git"

# Paths (git pathspecs) that stay internal.
EXCLUDE=(
  ':!REVIEW-*.md'      # per-release review notes; useful to me, noise to everyone else
  ':!.codegraph'       # editor index
)

VERSION="$(node -p 'require("./package.json").version')"
MESSAGE="${1:-}"
DRY=0
if [ "$MESSAGE" = "--dry-run" ]; then DRY=1; MESSAGE=""; fi

# Only tracked files, so the snapshot can never pick up a build directory, a
# node_modules, or a stray key sitting in the working copy.
mapfile -t FILES < <(git ls-files -- . "${EXCLUDE[@]}")
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no files matched — is this a git checkout?" >&2
  exit 1
fi

echo "[publish] $VERSION — ${#FILES[@]} files"
if [ "$DRY" = 1 ]; then
  printf '  %s\n' "${FILES[@]}"
  echo "[publish] dry run — nothing pushed"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Clone the public repo when it already has history, so each publish adds one
# commit instead of orphaning the previous one; start fresh when it is empty.
if git clone --quiet --depth 1 "$REMOTE" "$WORK/pub" 2>/dev/null && [ -n "$(git -C "$WORK/pub" rev-parse --verify HEAD 2>/dev/null || true)" ]; then
  echo "[publish] adding a snapshot commit on top of the published history"
  # Remove everything tracked there, so a file dropped from the public tree
  # actually disappears instead of lingering from the previous snapshot.
  git -C "$WORK/pub" rm -r --quiet --cached . >/dev/null
  find "$WORK/pub" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
else
  echo "[publish] publishing into an empty repository"
  rm -rf "$WORK/pub"
  mkdir -p "$WORK/pub"
  git -C "$WORK/pub" init --quiet -b main
  git -C "$WORK/pub" remote add origin "$REMOTE"
fi

# The snapshot is authored by whoever owns the source commit being published, so
# a fresh clone on a machine with no global git identity still produces a commit
# with the same name on it rather than refusing to commit at all.
AUTHOR_NAME="$(git -C "$ROOT" log -1 --format=%an)"
AUTHOR_EMAIL="$(git -C "$ROOT" log -1 --format=%ae)"
git -C "$WORK/pub" config user.name "$AUTHOR_NAME"
git -C "$WORK/pub" config user.email "$AUTHOR_EMAIL"

for f in "${FILES[@]}"; do
  mkdir -p "$WORK/pub/$(dirname "$f")"
  cp -p "$ROOT/$f" "$WORK/pub/$f"
done

git -C "$WORK/pub" add -A
if git -C "$WORK/pub" diff --cached --quiet; then
  echo "[publish] nothing changed since the last snapshot"
  exit 0
fi

git -C "$WORK/pub" commit --quiet -m "${MESSAGE:-webossh $VERSION}"
git -C "$WORK/pub" push --quiet origin HEAD:main
echo "[publish] pushed $(git -C "$WORK/pub" rev-parse --short HEAD) to $REPO"
