# Original eleven-case benchmark, 2026-11-01

Dataset: `tscircuit/bus-lanes-solver` at `9fada5b83a67e0e49de54ee7ae8e6974b1c028eb`; FanoutSolver dependency `15857f17beed0f228b2e29544f7ce393af297c86`. These are the actual eleven AM3352 placements, not the older twelve-case carrier fixtures. Each requires 47 signals and 161 immutable power dogbones. Bun 1.3.2, ARM64 Ubuntu, four CPUs, approximately 8 GB RAM.

| Result | Baseline | Incremental v3 |
| --- | ---: | ---: |
| Valid fixtures | 11/11 | 11/11 |
| Required signals routed | 517 | 517 |
| Total planar copper, mm | 21867.976347 | 21834.829754 |
| Ordinary turns | 8984 | 8923 |
| Short jogs | 2918 | 2890 |
| Solver time, minutes | 107.6 | 139.3 |
| Worker time including final validation, minutes | 110.5 | 142.3 |

Seven fixtures improved and four were unchanged within the proposal budget. There were 22 accepted and 9461 rejected attempts across 9483 saved steps. Signal footprint area and maximum detour were unchanged for every fixture. Initial route geometry matched baseline exactly in all eleven cases. The measured improvements therefore came from the local edits. Timings varied with host load; there is no speedup claim.

There is no upstream scalar score. The unchanged original harness, physical validator, output-shape checks and quality measurements remain authoritative. The separately disclosed acceptance ordering requires independent validation, no increase in any of area/copper/turns/short-jogs/max-detour, and at least one strict improvement. Required nets, input hashes, fixed copper, DDR constraints and manufacturing rules were preserved. All 22 completed route exports were freshly independently revalidated and their scores matched the original worker reports exactly.

See [scores.csv](scores.csv) for every fixture and [results.json](results.json) for score components, original validation outcomes, timings, input hashes, counters and measured worker file hashes. [dataset-checksums.json](dataset-checksums.json) pins the original validators and fixtures. The publication changes documentation, evidence, CI and reproduction tooling; the four measured solver/worker modules retain their original hashes.

Earlier infrastructure attempts remain preserved on the original remote: one supplemental paired left worker and the first baseline inner-left worker were OOM-killed; a baseline inner-above worker was intentionally stopped to serialize the memory-heavy jobs. The two affected baseline measurements were rerun serially with unchanged inputs, checks and 3600-second budgets. Head control was unconditionally remeasured once because the first run preceded checkpoint-integrity helpers. No best-of-repeat selection was used. Final measurement sets have no routing/validation failures or implementation fallbacks. Raw routes, verbose logs and multi-gigabyte checkpoint histories are deliberately excluded from this PR.

## Reproduce

```sh
bash scripts/setup.sh
bun run test
bun run typecheck
bash scripts/reproduce-benchmark.sh results/reproduction
```

Choose a new output directory each time. The script freshly solves all eleven baseline cases, then all eleven head cases, in the original fresh-worker harness. Cold workers run serially with the original 3600-second per-case solver budget and 3615-second process watchdog. It preserves failures, writes raw reports/valid-route exports/checkpoints, independently audits every completed export, and writes `comparison.json` and `comparison.csv`. This can take several hours. Audits and checkpoint writes add time outside the cooperative 180-second proposal-loop limit; the overall upstream limits remain enforced.

Local verification also passed 10 main tests / 168 assertions, type checking, the original four-orientation two-fanout regression suite (3 tests / 20415 assertions), fresh independent replay at v3 step 1103, 11483 selected history states, and 19 shared-ledger records checked for strict monotonicity. The separately labeled [via-aware patch](../../experiments/README.md) has 11 tests / 172 assertions and a warm control replay at step 1988. Its warm gains are not included in the fresh v3 table above; no full fresh v4 comparison is claimed.
