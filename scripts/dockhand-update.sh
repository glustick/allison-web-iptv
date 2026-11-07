#!/usr/bin/env bash
# Deploy one tag of this app to the Dockhand-managed stack on the Docker host.
#
# Rebuilt 2026-11-07, after the original was lost in the move to the AGENT share. The original spoke
# to Dockhand's HTTP API; that API is undocumented in this repo and answers 401 without a session,
# so this speaks to the *host* over SSH and lets `docker compose` do the work — the same thing
# Dockhand does, with no API token to store anywhere.
#
# It is deliberately honest about the one thing it cannot do for itself: talk to docker.sock. If the
# SSH user is not in the docker group, it stops **before touching anything** and prints the one-line
# fix, rather than half-deploying a stack.
#
#   ./scripts/dockhand-update.sh v0.92.0          # deploy a tag
#   DRY_RUN=1 ./scripts/dockhand-update.sh v0.92.0  # print the plan, change nothing
#
# Env: IMAGE (default ghcr.io/glustick/allison-web-iptv), SSH_HOST (default `laptopserver`, which
# is an ~/.ssh/config alias for 192.168.0.20), STACK_DIR (skips discovery), HEALTH_URL, PRUNE=0,
# HEALTH_TIMEOUT_S.
set -euo pipefail

TAG="${1:-latest}"
IMAGE="${IMAGE:-ghcr.io/glustick/allison-web-iptv}"
SSH_HOST="${SSH_HOST:-laptopserver}"
STACK_DIR="${STACK_DIR:-}"
HEALTH_URL="${HEALTH_URL:-http://192.168.0.20:8085/api/health}"
DRY_RUN="${DRY_RUN:-0}"
PRUNE="${PRUNE:-1}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
STACKS_ROOT="/var/lib/docker/volumes/dockhand_data/_data/stacks"

die() { echo "dockhand-update: $*" >&2; exit 1; }
say() { echo "dockhand-update: $*"; }
ssh_do() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST" "$@"; }

case "$TAG" in
  v[0-9]*|latest) ;;
  *) die "expected a release tag like v0.92.0, or 'latest' (got '$TAG')" ;;
esac

say "checking ssh to $SSH_HOST"
ssh_do 'true' >/dev/null 2>&1 || die "cannot SSH to $SSH_HOST with key-based auth. Set SSH_HOST, or ssh-copy-id first."

say "checking docker access on $SSH_HOST"
DOCKER_OK=0
if ssh_do 'docker info >/dev/null 2>&1'; then DOCKER_OK=1; fi

if [ "$DRY_RUN" = "1" ] && [ "$DOCKER_OK" = "0" ]; then
  # A dry run is most useful exactly when the real one cannot proceed, so it reports the blocker
  # instead of sharing it.
  say "docker access: NO — a real run would stop here (nothing has been changed)"
  say "would: back up compose.yaml, pin image to $IMAGE:$TAG, docker compose pull + up -d, then poll $HEALTH_URL"
  exit 0
fi

if [ "$DOCKER_OK" = "0" ]; then
  cat >&2 <<EOF
dockhand-update: the SSH user cannot reach docker.sock on $SSH_HOST.
  One-time fix, on $SSH_HOST:   sudo usermod -aG docker "\$USER"    # then log out and back in
  Or run this script on that host with sudo.
  Nothing was changed.
EOF
  exit 3
fi

if [ -z "$STACK_DIR" ]; then
  say "looking for the stack under $STACKS_ROOT (needs passwordless sudo for grep)"
  STACK_DIR="$(ssh_do "sudo -n grep -rl --include=compose.yaml '$IMAGE' '$STACKS_ROOT' 2>/dev/null | head -1" || true)"
  if [ -z "$STACK_DIR" ]; then
    cat >&2 <<EOF
dockhand-update: could not find a compose.yaml naming $IMAGE under $STACKS_ROOT.
  Pass STACK_DIR=/path/to/stack explicitly. If discovery failed because sudo needs a password,
  that is the same blocker as above; nothing was changed.
EOF
    exit 4
  fi
fi
COMPOSE="$STACK_DIR/compose.yaml"
say "stack: $STACK_DIR"

CURRENT_LINE="$(ssh_do "grep -m1 -E '^\s*image:' '$COMPOSE'" || true)"
say "current image: ${CURRENT_LINE:-<none found>}"
say "target image:  $IMAGE:$TAG"

if [ "$DRY_RUN" = "1" ]; then
  say "dry run: would back up compose.yaml, pin the image, pull and recreate, then poll $HEALTH_URL"
  exit 0
fi

say "backing up compose.yaml and pinning the tag"
ssh_do "cp '$COMPOSE' '$COMPOSE.bak-\$(date +%Y%m%d-%H%M%S)' && sed -i -E 's|^([[:space:]]*image:[[:space:]]*).*$|\1$IMAGE:$TAG|' '$COMPOSE'" \
  || die "could not rewrite $COMPOSE — the backup beside it is untouched"

say "pulling and recreating"
ssh_do "cd '$STACK_DIR' && docker compose -f '$COMPOSE' pull && docker compose -f '$COMPOSE' up -d" \
  || die "docker compose failed; the previous image is still on disk — restore the .bak compose file and re-run to roll back"

say "waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT_S}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
version=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(curl -sS -m 5 "$HEALTH_URL" 2>/dev/null || true)"
  version="$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  case "$body" in
    *'"ok":true'*) [ -n "$version" ] && break ;;
  esac
  sleep 3
done

if [ -z "$version" ]; then
  die "the container did not report healthy within ${HEALTH_TIMEOUT_S}s — check 'docker compose logs' on $SSH_HOST and roll back with the .bak compose file if needed"
fi

say "live and healthy: version $version"

if [ "$PRUNE" = "1" ]; then
  say "pruning dangling images (bounded: a stopped dockerd cannot hold this open)"
  ssh_do "timeout 60 docker image prune -f" >/dev/null 2>&1 || say "prune skipped (docker did not answer in time)"
fi

say "done — $IMAGE:$TAG is running on $SSH_HOST"
