# Via-aware local pruning (opt-in)

The patch includes the completed via-barrel pruning improvement and its independent four-layer DRC regression test. It changes the search protocol to `upstream-validation+pareto-quality-v3+via-aware-search-v1`, without changing the original physical checks or the five-component Pareto acceptance ordering.

The main implementation and the eleven-case fresh benchmark remain v3. Apply this patch only in an isolated checkout; it is not enabled by default:

```sh
git apply --check experiments/via-aware-local-pruning.patch
git apply experiments/via-aware-local-pruning.patch
bun test ./tests/refiner.test.ts ./tests/dataset.test.ts ./tests/adapter.test.ts ./tests/ledger.test.ts ./tests/via-aware.test.ts
bun run typecheck
```

The original quick check used a planar route helper that omitted via barrels. The full independent audit already rejected those conflicts. This patch includes the complete fixed and routed copper spans in the quick scene, avoiding those unnecessary full audits. The test proves an intermediate-layer shortcut is blocked by a full-stack via and separately confirms the original DRC rejects it.

Recorded evidence: 11 tests / 172 assertions passed. A separate **warm control** run, starting from a v3 checkpoint, exhausted 1988 proposals with 17 additional acceptances and 1971 rejections. Its final 1520.571708 mm copper, 601 turns and 150 short jogs save 0.792575 mm, 32 turns and 19 short jogs relative to the original control baseline. Independent replay matched all 1988 steps. This is not a fresh eleven-case performance result; no such comparison is claimed for this patch.
