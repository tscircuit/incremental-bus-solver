# incremental-bus-solver

An incremental refinement solver for bus routes. It starts with a fresh solution from the pinned `bus-lanes-solver`, then replaces local ordinary-wire runs while retaining the remaining routes, vias, coupled rails and sampled curves. DDR is the first validation target; the repository name does not restrict the routing model to DDR.

The repository was created through [create-repo PR #107](https://github.com/tscircuit/create-repo/pull/107). This implementation is submitted as a draft for review. No merge, release or deployment is authorized.

## Source and dataset contract

The vendor revision is `9fada5b83a67e0e49de54ee7ae8e6974b1c028eb` and the FanoutSolver dependency is `15857f17beed0f228b2e29544f7ce393af297c86`. The default upstream benchmark declares **11 AM3352 placements**, each with 47 required signal nets and 161 immutable power dogbones. The older AM62L/two-fanout regressions are separate fixtures and must not be counted as the current 11-placement benchmark.

The unmodified `scripts/benchmark.ts`, fixture loader, `validateAm3352Sample`, `validateAm3352OutputShape`, quality measurements and independent FanoutSolver copper checks remain authoritative. Checks include original pad identities and joins, fixed-copper provenance, unchanged board constraints, permitted layers, copper/via dimensions and spans, drill spacing, self-clearance, angles, bus length bounds/skew, differential-pair skew and coupling. Matching includes full pad-to-pad planar copper; the source does not infer via-depth or package delay.

There is **no upstream scalar score**. This implementation reports the existing metrics and uses a separate Pareto acceptance ordering on signal envelope area, planar copper length, ordinary turns, short jogs and maximum detour. A candidate must pass the original independent audit, improve at least one component, and increase none. A smaller but infeasible route never becomes an incumbent. This ordering does not alter fixture rules or upstream scoring.

## Setup and verification

Requires Bun; this run uses task-local Bun 1.3.2 on ARM64 Ubuntu. Run `bash scripts/setup.sh` with Bun on PATH. Setup creates a task-local vendor checkout at the exact pinned commit and installs its frozen dependencies; it refuses to replace another checkout. Dependencies and the vendor checkout are excluded from version control.

```sh
bun run test
bun run typecheck
./benchmark.sh --help
./benchmark.sh --timeout-seconds 3600
```

`benchmark.sh` runs the original full eleven-case benchmark in fresh worker processes and loads `lib/solver.ts` via the upstream `--solver` extension. Results go into a new `results/runN` directory. Each sample retains the original 3600-second total budget. The proposal loop stops after 1024 attempts or its 180-second cooperative time budget, capped by the remaining sample time calculated before the refinement child starts. Initial/final independent audits, proposal generation and checkpoint writes add overhead; an individual step can overrun the loop bound. The original harness still enforces its 3600-second solver budget and 3615-second process watchdog. A completed route that exceeds that budget is reported as a timeout. Saved state permits further local search after the measured fresh run. No speedup is promised.

The adapter writes initial routing progress at step boundaries, normally every five seconds, under `search/progress/`. A blocking upstream optimization step can delay a heartbeat. These records are explicitly exploratory and contain phase, step, elapsed time, routed/required counts and solver statistics. Candidate decisions and original audit reports live under the fixture's checkpoint directory. A refinement worker error retains the original route, writes a `requests/*.failure.json` record, and must be reported as an implementation fallback rather than a successful refinement. The original harness still audits final returned copper.

## Inspect, resume and replay

Use the directory containing fixture subdirectories (`search` in a benchmark run), not the individual fixture directory:

```sh
bun scripts/cli.ts inspect --directory results/run1/search --sample control
bun scripts/cli.ts resume --directory results/run1/search --sample control --steps 256
bun scripts/cli.ts replay --directory results/run1/search --sample control
bun scripts/cli.ts snapshot --directory results/run1/search --sample control
bun scripts/cli.ts snapshot --directory results/run1/search --sample control --candidate CANDIDATE_SHA256
```

`current.json` is the atomic pointer to an immutable search-state object. Objects form a history chain through `previous`; route blobs are addressed by SHA256. Candidate snapshots contain the changed trace and an immutable base-route hash. Each decision records run/step IDs, incumbent and candidate hashes, score components, acceptance/rejection reason and independent audit when evaluated. Cheap clearance rejections intentionally skip the expensive full score/audit and are labeled accordingly. `snapshot` writes local SVG views of all four layers, explicitly labeling exploratory candidates. Only independently validated completed routes enter the upstream harness's valid-route export directory.

A checkpoint stores the pending proposal queue, seen proposals, seed, accepted/rejected counters, validated best and contract/input/revision hashes. Resuming continues that queue instead of restarting the bus. Seeded replay is deterministic from the recorded initial route and saved step count. The upstream initial search and a wall-clock stop can complete different numbers of steps on different hardware; they are not claimed to be bit-for-bit reproducible by elapsed time alone.

`bun scripts/summarize-run.ts results/run1/search/control` verifies the decision-history hashes and writes a compact `summary.json` with rejection counts, violation types, accepted signal names and metric gains. `bun scripts/collect-best.ts ROOT...` admits checkpoints or original valid-route exports into the task's shared `best-by-fixture` ledger. It preserves source provenance, independently audits promotions, and rejects any result that fails to improve the current validated incumbent. Collection does not relabel retained routes as fresh measurements.

The writer lock prevents concurrent mutation of one search. After an ungraceful process stop, confirm that its writer has exited before removing that fixture's `writer.lock`. The last committed state remains resumable. A proposal in flight is recomputed after a crash. Old contracts or changed inputs are rejected on restore.

`import --sample NAME --routes FILE --directory DIR` starts a separately labeled retained-output experiment after independently revalidating the original input and routes. It is not fresh solve performance. The lower-level `fresh` CLI is a development driver; use `benchmark.sh` for comparisons through the canonical fresh-process harness.

## Measured local results

The original eleven-case benchmark completed **11/11 valid cases for both baseline and incremental solver**, with all 517 required signals and unchanged fixed copper and rules. Every completed export was then independently revalidated with the original physical and output-shape checks. Seven cases improved under the disclosed Pareto ordering; four retained their initial route. All five initial score components matched the corresponding baseline, so these measured gains came from the incremental edits.

| Metric, summed across eleven fixtures | Baseline | Incremental |
| --- | ---: | ---: |
| Planar copper, mm | 21867.976347 | 21834.829754 |
| Ordinary turns | 8984 | 8923 |
| Short jogs | 2918 | 2890 |

Signal footprint area and maximum detour were unchanged in every case. There were 22 accepted and 9461 rejected attempts across 9483 saved steps. Total solver time increased from 107.6 to 139.3 minutes; worker time including fixture loading and final validation increased from 110.5 to 142.3 minutes. Audit overhead is material, and host contention varied. This is a quality improvement, with no speedup claim.

The [benchmark evidence](benchmarks/2026-11-01/README.md), [per-fixture scores](benchmarks/2026-11-01/scores.csv) and [compact results](benchmarks/2026-11-01/results.json) contain the measurements, validation outcomes and pinned source hashes. Full routes, logs and content-addressed checkpoint histories remain preserved on the original remote; they are excluded from this PR. Two baseline infrastructure interruptions were rerun serially; the first control head measurement was also unconditionally rerun after checkpoint-integrity helpers changed. Earlier attempts remain preserved, with no best-of-repeat selection. The final measurements use unchanged 3600-second budgets and identical frozen worker modules.

The separate via-aware warm control experiment exhausted its queue at step 1988, after 17 additional accepted edits starting from an already refined route. Its final copper was 1520.571708 mm, with 601 turns and 150 short jogs. Relative to the original control baseline that saves 0.792575 mm, 32 turns and 19 short jogs. It is additional retained-state evidence, not the fresh eleven-case result. Fresh independent replay matched the saved v3 history at step 1103 and the warm via-aware history at step 1988.

## Current limits

The local search currently approximates ordinary wire runs. It preserves paired rails and curves, and does not yet relocate an entire matched bus or negotiate multiple obstructing nets together. Valid improvements can be small, and long plateaus are expected. The generic engine accepts a caller-supplied validator; the canonical benchmark adapter integrates the native AM3352 fixture audit specifically. Other fixture shapes fall back to the original solver and are explicitly marked as skipped refinement.

The opt-in [via-aware experiment](experiments/README.md) adds full-stack via barrels to the quick clearance approximation. The original independent full-board audit already rejected these conflicts in this branch's parent. The experimental branch has its own checkpoint protocol and warm dataset experiment; do not describe its retained-route results as a fresh full-dataset benchmark. Apply its patch in an isolated checkout to resume or replay that protocol. It is not enabled by default.

Reproduce the full paired benchmark with `bash scripts/reproduce-benchmark.sh results/reproduction`. This runs the original eleven-case baseline and the incremental solver serially, preserving failures and the unchanged 3600-second per-case budget. See the benchmark evidence for exact methodology and prior infrastructure reruns.
