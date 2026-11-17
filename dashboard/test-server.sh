#!/bin/sh
set -eu

mkdir -p dist
cp index.html dist/index.html
cp -R public/. dist/
esbuild src/main.tsx --bundle --splitting --format=esm --sourcemap --outdir=dist --loader:.css=css --external:/sidebar-wave.png
exec node ./dev-server.cjs
