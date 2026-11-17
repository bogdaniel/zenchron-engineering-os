#!/bin/sh
set -eu

exec "$HOME/.local/bin/zenchron-engineering" start "$@"
