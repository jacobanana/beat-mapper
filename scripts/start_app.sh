#!/usr/bin/env bash
# One entry point to a running app, on a laptop or a fresh Claude container.
#
#   bash scripts/start_app.sh                 prepare + start the dev server
#   bash scripts/start_app.sh --prepare-only  install dependencies, then stop
#   bash scripts/start_app.sh --build         serve the production build instead
#
# Idempotent: a server already answering is reused, not restarted. Runtime
# state lives in .dev/ (gitignored): logs, pids, the prepared marker, the
# base URL. Stop everything with scripts/stop_app.sh.
#
# This is the frontend-only shape. A project with a backend adds its database
# and migrations to prepare() — the contract the rest of the workflow depends
# on is unchanged: after this returns, every check can run.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

run_dir="$repo_root/.dev"
mkdir -p "$run_dir"

PREPARE_ONLY=0
BUILD=0
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --build) BUILD=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PORT="${APP_PORT:-5173}"
# vite.config.ts sets base: '/beat-mapper/' for GitHub Pages, and the dev
# server honours it: the root URL is a 404 page, so poll and publish this one.
BASE_PATH="/beat-mapper"

log() { echo "[start_app] $*"; }

# --- prepare ----------------------------------------------------------------

prepare() {
  local t0=$SECONDS

  # package-lock.json newer than node_modules means a dependency moved since
  # the last install — the case a bare `[[ -d node_modules ]]` sails past.
  # `npm ci`, not `npm install`: install rewrites the lockfile under the npm
  # this container happens to have, and a session that starts with a dirty
  # package-lock.json sweeps it into the first `git commit -a`.
  if [[ ! -d node_modules || package-lock.json -nt node_modules ]]; then
    log "npm ci"
    npm ci --no-audit --no-fund >>"$run_dir/setup.log" 2>&1 || {
      tail -20 "$run_dir/setup.log"; exit 1
    }
  fi

  touch "$run_dir/prepared"
  log "prepared in $((SECONDS - t0))s"
}

prepare

if [[ $PREPARE_ONLY -eq 1 ]]; then
  exit 0
fi

# --- start ------------------------------------------------------------------

spawn() {
  local name="$1"; shift
  local pidfile="$run_dir/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "$name already running"
    return 0
  fi
  # setsid detaches the server from this shell's process group, so it survives
  # the command that started it returning.
  local detach=()
  command -v setsid >/dev/null && detach=(setsid)
  "${detach[@]}" nohup "$@" >"$run_dir/$name.log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  log "$name started (log: .dev/$name.log)"
}

if [[ $BUILD -eq 1 ]]; then
  log "vite build"
  npm run build >>"$run_dir/setup.log" 2>&1 || { tail -30 "$run_dir/setup.log"; exit 1; }
  spawn app npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort
else
  spawn app npx vite --host 127.0.0.1 --port "$PORT" --strictPort
fi

# --noproxy: a container's HTTPS_PROXY must not be consulted for localhost.
for _ in $(seq 1 30); do
  curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT$BASE_PATH/" >/dev/null 2>&1 && break
  sleep 1
done

base="http://127.0.0.1:$PORT$BASE_PATH"
echo "$base" >"$run_dir/base_url"
log "app: $base"
echo "$base"
