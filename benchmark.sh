#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" = --help ]]; then
  echo 'Fresh solve and local refinement of all 11 pinned AM3352 samples by default.'
  echo 'Usage: ./benchmark.sh [--timeout-seconds 3600] [--require-all-solved]'
  echo 'Uses the unchanged upstream harness, 1024 proposals / 180 seconds refinement, within the overall sample budget.'
  echo 'Samples: control control-inner1 right left above inner-layers inner-layers-right inner-layers-left inner-layers-above inner-layers-complete-ca outer-layers'
  echo 'Resume/debug: bun scripts/cli.ts {resume|inspect|replay|snapshot} --directory DIR --sample NAME'
  exit 0
fi
run_number=1
while [[ -e "results/run${run_number}" ]]; do run_number=$((run_number+1)); done
run_directory="$PWD/results/run${run_number}"
mkdir -p "$run_directory"
INCREMENTAL_RUN_DIRECTORY="$run_directory/search" bun vendor/scripts/benchmark.ts --solver "$PWD/lib/solver.ts" --output "$run_directory/report.json" --routes-directory "$run_directory/valid-routes" "$@" 2>&1 | tee "$run_directory/logs.txt"
