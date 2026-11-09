#!/bin/sh
set -eu

cd "$(dirname "$0")"
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
PATH="$(pwd)/dashboard/node_modules/.bin:${PATH}"
export PATH

: "${ZENCHRON_LISTEN_ADDR:=127.0.0.1:8080}"
: "${ZENCHRON_DASHBOARD_PORT:=4173}"
control_plane_url="http://${ZENCHRON_LISTEN_ADDR}"
: "${ZENCHRON_CONTROL_PLANE_URL:=$control_plane_url}"
: "${ZENCHRON_API_PROXY:=$control_plane_url}"
export ZENCHRON_LISTEN_ADDR ZENCHRON_CONTROL_PLANE_URL ZENCHRON_API_PROXY ZENCHRON_DASHBOARD_PORT

api_pid=
worker_pid=
dashboard_pid=
stop() {
  trap - EXIT INT TERM
  for pid in "$dashboard_pid" "$worker_pid" "$api_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$dashboard_pid" "$worker_pid" "$api_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_free() {
  url=$1
  label=$2
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "${label} is already responding at ${url}" >&2
    exit 1
  fi
}

wait_for() {
  url=$1
  pid=$2
  label=$3
  attempt=0
  while :; do
    if [ -n "${4:-}" ]; then
      curl -fsS -H "$4" "$url" >/dev/null 2>&1 && break
    else
      curl -fsS "$url" >/dev/null 2>&1 && break
    fi
    if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -ge 60 ]; then
      echo "${label} did not become ready at ${url}" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "${label} stopped while becoming ready at ${url}" >&2
    return 1
  fi
}

dashboard_url="http://127.0.0.1:${ZENCHRON_DASHBOARD_PORT}"
ensure_free "${control_plane_url}/healthz" "Control plane"
ensure_free "$dashboard_url" "Dashboard"

(
  unset ZENCHRON_LLM_BASE_URL ZENCHRON_LLM_API_KEY
  exec go run ./cmd/zenchron
) &
api_pid=$!
api_ready=0
if wait_for "${control_plane_url}/healthz" "$api_pid" "Control plane"; then
  api_ready=1
else
  echo "Control plane unavailable; starting the dashboard anyway." >&2
fi

if [ "$api_ready" -eq 1 ]; then
  (
    unset ZENCHRON_GITHUB_TOKEN ZENCHRON_GITHUB_APP_ID ZENCHRON_GITHUB_INSTALLATION_ID
    unset ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH ZENCHRON_GITHUB_CLIENT_ID ZENCHRON_GITHUB_CLIENT_SECRET
    unset ZENCHRON_SESSION_SECRET ZENCHRON_GITHUB_ALLOWED_USERS ZENCHRON_PUBLIC_URL
    exec go run ./cmd/zenchron-worker
  ) &
  worker_pid=$!
  if ! wait_for "${control_plane_url}/api/v1/workers/healthz" "$worker_pid" "Local worker" \
      "Authorization: Bearer ${ZENCHRON_WORKER_TOKEN:-}"; then
    echo "Local worker unavailable; the dashboard will remain available." >&2
  fi
fi

(cd dashboard && unset ZENCHRON_GITHUB_TOKEN ZENCHRON_GITHUB_APP_ID ZENCHRON_GITHUB_INSTALLATION_ID
  unset ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH ZENCHRON_GITHUB_CLIENT_ID ZENCHRON_GITHUB_CLIENT_SECRET
  unset ZENCHRON_SESSION_SECRET ZENCHRON_WORKER_TOKEN ZENCHRON_GITHUB_ALLOWED_USERS ZENCHRON_PUBLIC_URL
  unset ZENCHRON_LLM_BASE_URL ZENCHRON_LLM_API_KEY
  exec sh ./dev.sh) &
dashboard_pid=$!
if ! wait_for "$dashboard_url" "$dashboard_pid" "Dashboard"; then exit 1; fi

echo "Zenchron dashboard is ready at ${dashboard_url}"
while kill -0 "$dashboard_pid" 2>/dev/null; do
  if [ -n "$api_pid" ] && ! kill -0 "$api_pid" 2>/dev/null; then
    echo "Control plane stopped; dashboard remains available at ${dashboard_url}." >&2
    api_pid=
  fi
  if [ -n "$worker_pid" ] && ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "Local worker stopped; dashboard remains available at ${dashboard_url}." >&2
    worker_pid=
  fi
  sleep 1
done
echo "Dashboard stopped; stopping the remaining Zenchron services." >&2
