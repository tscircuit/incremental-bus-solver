#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
artifact_directory="$(realpath -m "${1:-results/reproduction}")"
if [[ -e "$artifact_directory" ]]; then
  echo 'Choose a new output directory; prior measurements and incumbents are preserved.' >&2
  exit 1
fi
mkdir -p "$artifact_directory"
bun scripts/record-engine.ts "$artifact_directory"
baseline_exit=0
bun vendor/scripts/benchmark.ts --timeout-seconds 3600 \
  --output "$artifact_directory/baseline-clean.json" \
  --routes-directory "$artifact_directory/baseline-routes" \
  > "$artifact_directory/baseline.log" 2>&1 || baseline_exit=$?
head_exit=0
INCREMENTAL_RUN_DIRECTORY="$artifact_directory/official-final" \
  bun vendor/scripts/benchmark.ts --timeout-seconds 3600 --solver "$PWD/lib/solver.ts" \
  --output "$artifact_directory/new-final-clean.json" \
  --routes-directory "$artifact_directory/new-final-routes" \
  > "$artifact_directory/head.log" 2>&1 || head_exit=$?
bun scripts/report-comparison.ts --artifacts "$artifact_directory" \
  --base "$artifact_directory/baseline-clean.json" --head "$artifact_directory/new-final-clean.json"
if (( baseline_exit != 0 || head_exit != 0 )); then exit 1; fi
