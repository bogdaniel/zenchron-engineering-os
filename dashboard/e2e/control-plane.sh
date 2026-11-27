#!/bin/sh
set -eu

data_dir=.playwright-state
rm -rf "$data_dir"
mkdir -m 700 "$data_dir"
project_dir="$data_dir/projects/zenchron-engineering-os"
mkdir -p "$project_dir"
if [ "${ZENCHRON_E2E_EMPTY_WORKFLOWS:-false}" = true ]; then
  state_version="$(go run ./cmd/zenchron build-info | sed -n 's/.*"state_schema_version":\([0-9][0-9]*\).*/\1/p')"
  test -n "$state_version"
  printf '{"version":%s,"items":{}}\n' "$state_version" > "$data_dir/workflows.json"
fi
git -C "$project_dir" init -b main
git -C "$project_dir" config user.name "Zenchron E2E"
git -C "$project_dir" config user.email "zenchron-e2e@example.invalid"
printf 'Isolated browser test repository.\n' > "$project_dir/README.md"
git -C "$project_dir" add README.md
git -C "$project_dir" commit -m "Initialize E2E repository"
git -C "$project_dir" remote add origin 'https://worker:secret@example.invalid/zenchron/zenchron-engineering-os.git?token=hidden'
# Runs refuse to start unless local main equals origin's default branch, so origin resolves to a local bare
# repository holding main while the configured URL keeps exercising credential redaction.
origin_dir="$(pwd)/$data_dir/origin.git"
git init --quiet --bare -b main "$origin_dir"
git -C "$project_dir" push --quiet "$origin_dir" main
git -C "$project_dir" config "url.$origin_dir.insteadOf" \
  'https://worker:secret@example.invalid/zenchron/zenchron-engineering-os.git?token=hidden'
trap 'rm -rf "$data_dir"' EXIT INT TERM
ZENCHRON_DATA_DIR="$data_dir" go run ./cmd/zenchron serve
