#!/bin/sh
set -eu

data_dir=.playwright-state
rm -rf "$data_dir"
mkdir -m 700 "$data_dir"
project_dir="$data_dir/projects/zenchron-engineering-os"
mkdir -p "$project_dir"
git -C "$project_dir" init -b main
git -C "$project_dir" config user.name "Zenchron E2E"
git -C "$project_dir" config user.email "zenchron-e2e@example.invalid"
printf 'Isolated browser test repository.\n' > "$project_dir/README.md"
git -C "$project_dir" add README.md
git -C "$project_dir" commit -m "Initialize E2E repository"
git -C "$project_dir" remote add origin 'https://worker:secret@example.invalid/zenchron/zenchron-engineering-os.git?token=hidden'
trap 'rm -rf "$data_dir"' EXIT INT TERM
ZENCHRON_DATA_DIR="$data_dir" go run ./cmd/zenchron
