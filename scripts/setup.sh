#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -d vendor ]]; then
  git clone --no-checkout https://github.com/tscircuit/bus-lanes-solver.git vendor
  git -C vendor checkout --detach 9fada5b83a67e0e49de54ee7ae8e6974b1c028eb
fi
test "$(git -C vendor rev-parse HEAD)" = 9fada5b83a67e0e49de54ee7ae8e6974b1c028eb || {
  echo 'vendor must be the pinned revision; refusing to change an existing checkout' >&2
  exit 1
}
(cd vendor && bun install --frozen-lockfile)
if [[ ! -e node_modules ]]; then ln -s vendor/node_modules node_modules; fi
