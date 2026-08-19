# OmniRoute Governor — side-effect-free Native baseline — 2026-08-19

## Status

SIDE_EFFECT_FREE_BASELINE_VALIDATED

This correction was validated from:

- repository: `SamDevlab/OmniRoute`
- branch: `feature/s3-intelligence-governor-prework-20260810`
- HEAD at start: `994e9a3610c13fe1c6864d8d7052bc7a11263c5d`
- Governor contract: `simulate / false / 0`
- benchmark execution: **not run**
- server/providers/upstream requests: **not used**
- new PR or merge: **none**

Correction sentinel: `PREFLIGHT_STATE_CONTAMINATION=NO`.

The authoritative 5-pair/10-pair benchmark remains intentionally pending until this
correction is reviewed and the PR checks are green. No benchmark result is claimed here.

## Contamination found before the correction

The authoritative branch called `runAuthoritativeNativePreflight()` before Pair 1. That
function sent `request("auto/chat", ..., "authoritative-target-preflight")` to the live
OmniRoute server, then read telemetry and call-log state to infer the observed/final target.
This was a real dispatch, not a planning operation. It could therefore enter the normal
execution-side mutation paths: call logging/telemetry, connection cooldown, provider breaker,
or model lockout. It also made the later Native-vs-Governor pair conditional on a prior
physical request.

The old operation was persisted as `native_preflight`, which made that contamination visible
but did not prevent it.

## Correction

The authoritative path now:

1. builds one frozen Native routing snapshot before Pair 1;
2. resolves each workload's initial Native choice with
   `open-sse/services/combo/resolveAutoStrategy.ts::resolveAutoStrategyOrder`;
3. runs that production resolver in a child process with an in-memory DB branch and Governor
   forced off;
4. injects the frozen candidates into the production resolver; and
5. intercepts `fetch` so any attempted network call fails and is counted.

The correction does not copy or approximate scoring. It reuses the extracted production Auto
strategy resolution, including its capability filter, context filter, candidate composition,
intent/config handling, quota eligibility, explicit-router/rules selection, production scorer,
and native ordered fallback tail. The first returned target is the Native initial/first-choice
baseline. It is never replaced by a final fallback target.

The snapshot contains:

- resolved pool and target identities;
- candidates and production scored descriptors;
- health/reliability and capability metadata;
- provider breakers;
- connection cooldowns;
- model lockouts;
- active connection state and allowed connection identities; and
- routing configuration plus resilience settings used by the resolver.

Pricing evidence is not read or used by the corrected baseline path.

## Artifact contract

Future authoritative runs use `native_baseline_resolution`, never `native_preflight`. The
operation records include:

- `nativeBaselineTarget`, `nativeBaselineProvider`, `nativeBaselineModel`,
  `nativeBaselineConnection`;
- `nativeBaselineResolution: "side_effect_free"`;
- `baselineSnapshotId` and `baselineSnapshotHash`;
- `networkCalls: 0`, `providerModelRequests: 0`, and `routingStateMutation: false`; and
- equal before/after routing-state digests.

The manifest and offline accounting expose:

- Native provider/model preflight requests: `0`;
- Governor provider/model preflight requests: `0`; and
- side-effect-free baseline resolutions: `N`.

Each pair records `nativeBaselineTarget`, Native first actual target, Native final actual target,
baseline-vs-first/final comparisons, baseline drift, and Native fallback. A baseline drift or
an unproven first actual target invalidates the pair and stops the authoritative run. A final
target differing after a proven first target is recorded as fallback rather than being used as
the baseline.

The offline summarizer accepts the new operation and continues to read historical
`native_preflight` records only for backward-compatible diagnosis. New authoritative runs do
not emit that legacy operation type.

## Validation evidence

Focused validation passed:

```text
node --import tsx/esm --test \
tests/unit/omniroute-governor-native-baseline.test.ts \
  tests/unit/omniroute-governor-divergence-e2e-harness.test.ts
17 passed, 0 failed
```

The tests prove the resolver uses the production function, preserves provider/model/connection
identity and routing sentinels, makes zero network calls, makes zero provider/model requests,
keeps the state digest equal before/after, rejects baseline drift/unproven first actuals, and
lets `summarizeBenchmarkRun` reconstruct one side-effect-free resolution with zero physical
preflights.

The offline CLI proof also passed against a synthetic persisted run:

```text
node scripts/ad-hoc/omniroute-governor-run-summarizer.mjs --summarize-run="<run-dir>"
cliSummarizeRun: PASS
pairs 1
nativeBaselineResolutions 1
nativeBaselineProviderModelRequests 0
governorProviderModelPreflightRequests 0
nativePreflightRequests 0
nativeRequests 1
governorPlanningOperations 1
governorExecutionRequests 1
physicalAuthoritativeRequests 2
physicalRequestsIncludingPreflight 2
quality native 1 governor 1
```

This proves the offline summary reconstructs the same baseline-resolution and execution
accounting contract without a live benchmark. The synthetic manifest was intentionally marked
RUNNING, so the CLI status was INCOMPLETE_RUN; the accounting assertions passed.

The existing strict quality validator test also passed in the focused harness suite; fenced
JSON-only or exact-code output remains MODEL_QUALITY_FAILURE. No validator, workload,
scoring, ranking, reliability, health, or production routing code was changed.

The repository-wide `npm run test:unit` was started for additional context but was stopped after
out-of-scope Adobe Firefly `#8510` tests failed/entered long browser-credential flows. Those
failures are unrelated to the changed files; the focused correction suite remained green.

The PR check snapshot observed before this correction was: Fast Production Build `SUCCESS`,
Semgrep `SUCCESS`, expected workflow skips, and DAST smoke `FAIL` (run `32311391845`). That
pre-existing CI failure must be rechecked after the correction is pushed; it is not silently
treated as success here.

## Benchmark disposition

No `--authoritative-e2e`, no `--summarize-run` over a live benchmark run, no `/api/v1/chat/completions`,
no SSE, no calibration provider call, no canary activation, and no NVIDIA gate was used in this
correction. The benchmark can proceed only after the PR check rule is satisfied and this baseline
correction is accepted.
