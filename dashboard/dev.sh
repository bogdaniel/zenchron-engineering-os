#!/bin/sh

mkdir -p dist
cp index.html dist/index.html
cp -R public/. dist/
esbuild src/main.tsx --bundle --splitting --format=esm --sourcemap --outdir=dist --loader:.css=css --external:/sidebar-wave.png --watch=forever &
watcher=$!
node ./dev-server.cjs &
server=$!
stop() {
  trap - EXIT INT TERM
  kill "$server" "$watcher" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
}
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait "$server"
