#!/bin/sh
set -eu

cd "$(dirname "$0")"
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

wait_for() {
  url=$1
  pid=$2
  label=$3
  attempt=0
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "${label} is already responding at ${url}" >&2
    exit 1
  fi
  until curl -fsS "$url" >/dev/null 2>&1; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -ge 60 ]; then
      echo "${label} did not become ready at ${url}" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "${label} stopped while becoming ready at ${url}" >&2
    exit 1
  fi
}

(
  unset ZENCHRON_LLM_BASE_URL ZENCHRON_LLM_API_KEY
  exec go run ./cmd/zenchron
) &
api_pid=$!
wait_for "${control_plane_url}/healthz" "$api_pid" "Control plane"

(
  unset ZENCHRON_GITHUB_TOKEN ZENCHRON_GITHUB_APP_ID ZENCHRON_GITHUB_INSTALLATION_ID
  unset ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH
  exec go run ./cmd/zenchron-worker
) &
worker_pid=$!
wait_for "${control_plane_url}/api/v1/workers/healthz" "$worker_pid" "Local worker"

(cd dashboard && unset ZENCHRON_GITHUB_TOKEN ZENCHRON_GITHUB_APP_ID ZENCHRON_GITHUB_INSTALLATION_ID
  unset ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH ZENCHRON_LLM_BASE_URL ZENCHRON_LLM_API_KEY
  exec sh ./dev.sh) &
dashboard_pid=$!
wait_for "http://127.0.0.1:${ZENCHRON_DASHBOARD_PORT}" "$dashboard_pid" "Dashboard"

echo "Zenchron is ready at http://127.0.0.1:${ZENCHRON_DASHBOARD_PORT}"
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null &&
  kill -0 "$dashboard_pid" 2>/dev/null; do
  sleep 1
done
echo "A Zenchron service exited; stopping the remaining services." >&2
exit 1
