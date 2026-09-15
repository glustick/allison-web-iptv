#!/usr/bin/env bash
# Started as root (either `docker run --user 0`, or a stack manager overriding the image's own
# unprivileged default): take the chance to fix ownership of the two directories the server
# genuinely needs to write — a host bind mount created by an earlier, root-running build belongs
# to the wrong uid and would otherwise fail with EACCES — then drop to the unprivileged user and
# stay there. When the container already starts as `node` (the default), this does nothing.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/appdata}" "${TRANSCODE_TMP_DIR:-/transcode}"; do
    if [ -e "$dir" ]; then
      chown -R node:node "$dir" 2>/dev/null || true
    fi
  done
  if command -v gosu > /dev/null 2>&1; then
    exec gosu node "$@"
  fi
  echo "[entrypoint] gosu is unavailable, so this will keep running as root (uid 0)" >&2
fi

exec "$@"
