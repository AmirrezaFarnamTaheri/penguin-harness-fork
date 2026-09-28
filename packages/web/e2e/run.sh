#!/usr/bin/env bash
# End-to-end verification (Playwright + mock LLM): build plugins/core/server/web -> start mock Anthropic SSE ->
# start server (temp data root) -> run chat.spec.mjs. SKIP_BUILD=1 skips the build.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DATA="$(mktemp -d)"
# The server is a native Windows binary, and it does not resolve a POSIX /tmp path to
# the directory mktemp just created: PENGUIN_HOME and PENGUIN_WEB_DB then fall back to
# the machine's real ~/.penguin data root. Every run shares one long-lived database, so
# users and Sessions accumulate across runs and specs that create fixtures
# non-idempotently start failing with 409 on the second run instead of on a change.
# Hand the server a path spelled the way it reads it.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) DATA="$(cygpath -m "$DATA")" ;;
esac
MOCK_PORT="${MOCK_PORT:-8931}"
SRV_PORT="${SRV_PORT:-8930}"
# localhost, not 127.0.0.1: since the Workspace-preview split the server canonicalizes the
# App onto localhost and reserves 127.0.0.1 as the preview host, where /api answers 401.
export BASE_URL="http://localhost:$SRV_PORT"
export MOCK_URL="http://127.0.0.1:$MOCK_PORT"

cleanup() {
  stop_process() {
    pid="$1"
    [ -n "$pid" ] || return 0
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        # Git Bash starts native node.exe processes outside its POSIX process tree;
        # killing the shell PID alone leaves the server alive and its data DB locked.
        taskkill.exe //PID "$pid" //T //F >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
        ;;
      *) kill "$pid" 2>/dev/null || true ;;
    esac
  }
  stop_process "${MOCK_PID:-}"
  stop_process "${SRV_PID:-}"
  [ -n "${MOCK_PID:-}" ] && wait "$MOCK_PID" 2>/dev/null || true
  [ -n "${SRV_PID:-}" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== build core/server/web =="
  (cd "$ROOT" \
    && pnpm --filter @prismshadow/penguin-core build \
    && pnpm --filter @prismshadow/penguin-server build \
    && pnpm --filter @prismshadow/penguin-web build) || { echo "BUILD FAILED"; exit 1; }
fi

echo "== start mock LLM =="
MOCK_PORT=$MOCK_PORT node "$HERE/mock-llm.mjs" &
MOCK_PID=$!
# Same reasoning as the server below: a mock that lost the race for its port dies at
# once, and the specs would then stream from whatever stale process still holds it —
# which shows up as a suite that crawls and times out rather than as an obvious error.
sleep 1
if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo "mock LLM process $MOCK_PID died during startup (is port $MOCK_PORT already in use?)" >&2
  exit 1
fi

echo "== start server =="
# PENGUIN_SEED_ADMIN_PASSWORD pins the otherwise-random seeded admin password to the
# constant the specs use (ADMIN_PASSWORD in auth.mjs).
PENGUIN_HOME="$DATA" PORT=$SRV_PORT HOST=127.0.0.1 PENGUIN_WEB_DB="$DATA/web.db" \
  PENGUIN_WEB_DIST="$ROOT/packages/web/dist" \
  PENGUIN_SEED_ADMIN_PASSWORD=penguin-2026 \
  node "$ROOT/packages/server/dist/index.js" &
SRV_PID=$!

echo "== wait for server =="
# Refuse to run against a server this script did not start. If something already owns
# the port the node process above exits on EADDRINUSE, and the wait below would happily
# "succeed" against that other server — so the whole suite would run on someone else's
# data root, which is how one e2e run reports failures the next one cannot reproduce.
for _ in $(seq 1 40); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "server process $SRV_PID died during startup (is port $SRV_PORT already in use?)" >&2
    exit 1
  fi
  curl -sf "$BASE_URL/" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "== run playwright =="
cd "$ROOT/packages/web"
npx playwright test -c "$HERE/playwright.config.mjs" "$@"
