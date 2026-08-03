#!/bin/bash
# Idempotent release publisher for the PUBLIC repo qingyu321/Little-Claude.
#
# Fixes two historical failures:
# 1. The old `find src-tauri/target -path '*/release/bundle/*'` matched ~250
#    files (deb intermediates, linuxdeploy caches, icons...), not just the
#    installers.  We now match narrow suffix whitelists only.
# 2. Parallel matrix jobs raced to create the same draft release, and
#    `gh release view` cannot see draft releases (the tags endpoint 404s on
#    them), so the create-or-upload logic broke.  We resolve the release via
#    the LIST endpoint (which sees drafts) and upload with clobber semantics
#    (delete same-name asset first) plus retries.
#
# Usage: publish.sh <tag> <repo> <title> [prerelease]
# Env:  GH_TOKEN must have write access to <repo>.
set -euo pipefail

TAG="$1"
REPO="$2"
TITLE="$3"
PRERELEASE="${4:-false}"

# `--prerelease` is a boolean flag — it must NOT take a value. Passing
# `--prerelease false` makes gh parse "false" as a positional (file) argument,
# the file doesn't exist, and the create call fails (run 10: "could not create
# or resolve release for v1.1.1"). Emit the flag only when prerelease is true.
PRERELEASE_ARGS=()
if [ "$PRERELEASE" = "true" ]; then
  PRERELEASE_ARGS=(--prerelease)
fi

mapfile -t ASSETS < <(find src-tauri/target -path '*/release/bundle/*' -type f \( \
  -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o \
  -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.exe' -o -name '*.exe.sig' \))
if [ ${#ASSETS[@]} -eq 0 ]; then
  echo "ERROR: no bundle assets found under src-tauri/target" >&2
  exit 1
fi
echo "Uploading ${#ASSETS[@]} assets:"
for f in "${ASSETS[@]}"; do echo "  $f"; done

release_id() {
  # `|| true`: with pipefail, `head -1` exiting early SIGPIPEs gh once the
  # release list grows past one page (>31 releases) — without it the pipeline
  # fails and set -e kills the script.
  gh api "repos/${REPO}/releases" --paginate -q ".[] | select(.tag_name == \"${TAG}\") | .id" | head -1 || true
}

RID="$(release_id)"
if [ -z "$RID" ]; then
  if RID="$(gh release create "$TAG" --repo "$REPO" --title "$TITLE" --draft \
      "${PRERELEASE_ARGS[@]}" \
      --notes "See the assets to download and install this version." --json id -q .id 2>/dev/null)"; then
    echo "created release $TAG (id=$RID)"
  else
    echo "release create raced with a parallel job; resolving via list..."
    RID="$(release_id)"
  fi
fi
if [ -z "$RID" ]; then
  echo "ERROR: could not create or resolve release for $TAG" >&2
  exit 1
fi
echo "release id: $RID"

for f in "${ASSETS[@]}"; do
  name="$(basename "$f")"
  # GitHub sanitizes asset names on upload (spaces -> dots, illegal chars
  # -> underscores).  Match and upload the SANITIZED name so clobber finds
  # assets left by earlier runs — the v1.1.1-alpha.1 failure was exactly
  # this: clobber matched the raw space name, GitHub had stored the dot
  # name, so the upload 422'd on the same-name asset five times.
  asset_name="${name// /\.}"
  # clobber: drop a same-name asset left by an earlier run
  gh api "repos/${REPO}/releases/${RID}/assets" --paginate -q \
    ".[] | select(.name == \"${asset_name}\") | .id" | while read -r aid; do
      gh api -X DELETE "repos/${REPO}/releases/assets/${aid}" >/dev/null || true
    done
  enc="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$asset_name")"
  ok=0
  for try in 1 2 3 4 5; do
    # stderr is NOT swallowed so a failing upload shows gh's HTTP error
    # (e.g. "HTTP 422") in the Actions log instead of a bare retry line.
    if gh api -X POST -H "Content-Type: application/octet-stream" --input "$f" \
        "uploads.github.com/repos/${REPO}/releases/${RID}/assets?name=${enc}" >/dev/null; then
      ok=1
      break
    fi
    echo "  upload retry $try for $name" >&2
    sleep 3
  done
  if [ "$ok" -ne 1 ]; then
    echo "ERROR: upload failed for $name" >&2
    exit 1
  fi
  echo "  uploaded $name"
done
echo "PUBLISH DONE"
