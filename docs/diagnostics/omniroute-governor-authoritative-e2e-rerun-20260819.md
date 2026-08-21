# Governor Authoritative E2E Rerun

## Starting State

- HEAD: `735bbb9e189346d4475b03fbf6dddd80ec21e418`
- CI Gate: PASS before runtime execution. Quality Gates, Semgrep, DAST smoke,
  and Fast Production Build were successful for this HEAD.
- Governor: `simulate / false / 0`
- Canary: `0 — NOT ACTIVATED`
- Production code, workload, validators, scoring, reliability, health, and
  ranking were not changed.

## Execution Result

The published harness was invoked with:

```text
node --import tsx/esm scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs --authoritative-e2e --pairs=5
```

The run became invalid before the five-pair gate could be evaluated. The
published harness threw `TypeError: Cannot read properties of undefined
(reading 'qualityPass')` in `pairLatencyWinner` while building an authoritative
pair whose Governor result had no direct arm. No code or harness fix was made
in this task, and pairs 6–10 were not executed.

## Artifact Integrity

- runId: `20260819T214907Z-3fb4f07b`
- run directory: `docs/diagnostics/governor-e2e-artifacts/20260819T214907Z-3fb4f07b/`
- `manifest.json`: PASS — created before requests; remains `RUNNING` because
  the process crashed before finalization.
- `operations.jsonl`: PASS — 10 valid records, no malformed JSONL.
  - `native_preflight`: 5
  - `native_arm`: 2
  - `governor_plan`: 2
  - `governor_arm`: 0
  - `pair_complete`: 1
- `summary.json`: FAIL — correctly absent after the crash.
- final snapshot: FAIL — correctly absent after the crash.
- offline reconstruction: PASS for incomplete-run recovery. The offline CLI
  returned exit code 2 and reconstructed 'INCOMPLETE_RUN' from the manifest and
  JSONL. There is no live final summary to compare with because finalization
  never occurred; the run is therefore not a valid benchmark result.
- maximum persisted `outputPreview`: 38 bytes, below the 4096-byte bound.

The authoritative source for the values below is the incomplete run artifact,
not terminal output.

## Pool

- Raw: 11
- Active: 11
- Eligible: 11
- Healthy: 11
- Providers: `opencode`, `felo-web`
- Breakers: 2
- Cooldowns: 0
- Lockouts: 0

Preflight requests are accounted separately and are not authoritative arms.

## Five-Pair Gate

'NOT EVALUATED — BENCHMARK_INVALID'.

The reconstructed partial gate had only 1 closed pair out of 5 requested:

- invalid pairs: 1
- Native HTTP: 1
- Native complete SSE: 0
- Governor plans in the closed pair: 1
- Governor executable: 0
- Governor HTTP: 0
- Governor complete SSE: 0
- target identity: FAIL
- accounting: FAIL

The gate cannot be passed or interpreted as a five-pair quality result.

## Pair Results

| Pair | Case            | Order             | Persisted result                                                                                         |
| ---- | --------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | EXACT_TEXT      | native → Governor | Native arm HTTP 200 but stream failure; Governor plan non-executable ('HARNESS_FAILURE'); pair invalid   |
| 2    | STRUCTURED_JSON | Governor → native | Governor plan non-executable; Native arm HTTP 200/complete/quality pass; no pair completion before crash |
| 3–5  | —               | —                 | Not attempted after the harness crash                                                                    |

The first five Native preflights were executed independently. The preflight
for 'STRUCTURED_JSON' persisted a fenced JSON response and classified it as
'MODEL_QUALITY_FAILURE' / 'invalid_json'; the strict validator was preserved.
The 'EXTRACTION' preflight classified an empty reconstructed response as
'MODEL_QUALITY_FAILURE' / 'empty_reconstructed_content'.

## Partial Native Aggregate

These are partial arm aggregates only, not a benchmark conclusion:

- HTTP: 2/2
- Stream: 1/2
- Quality: 1/2
- Headers: mean 2059 ms, p50 2054 ms, p95 2054 ms, max 2064 ms
- TTFT: mean/p50/p95 5455 ms
- Completion: mean 6412.5 ms, p50 5677 ms, p95 5677 ms, max 7148 ms
- E2E: mean 9602 ms, p50 8863 ms, p95 8863 ms, max 10341 ms
- Attempts: mean 1, max 1
- Fallbacks: 0

## Partial Governor Aggregate

- Plans: 2
- Executable: 0
- HTTP/stream/quality arms: 0/0/0
- Planning: mean 1 ms, p50 0 ms, p95 0 ms, max 2 ms
- Planning share: unavailable because no Governor arm completed
- Headers, TTFT, execution completion, and E2E: unavailable

Governor planning was not compared against upstream/direct duration. No speed
ratio was calculated because the run was invalid and no Governor arm completed.

## Quality Delta and Pairwise

- Quality delta: not computable from this invalid run
- Native/Governor p50 E2E ratio: not computable
- Native/Governor mean E2E ratio: not computable
- Governor wins: 0
- Native wins: 0
- Ties: 1 partial/invalid record
- Invalid: 1
- Governor quality wins: 0
- Native quality wins: 0
- Governor latency wins: 0
- Native latency wins: 0

## Historical Failure Cases

- EXTRACTION: current preflight 'MODEL_QUALITY_FAILURE' with
  'empty_reconstructed_content'; no validator relaxation was applied.
- ENGLISH_STRUCTURED: not reached in the authoritative arm run.
- SIMPLE_CODE: not reached in the authoritative arm run.
- Fenced JSON was observed in the current 'STRUCTURED_JSON' preflight and was
  rejected by the existing JSON-only validator. Markdown fences were not
  removed.

The artifact does not support declaring a reproducible 10-pair format
regression or a Governor latency advantage. The run was invalid before that
question could be measured.

## Model Distribution and Failure Correlation

- Native preflight target: `opencode/big-pickle` for the five preflights.
- Partial Native arm targets: `auto/auto/chat`, `opencode/hy3-free`.
- Governor arm targets: none.
- Observed 'MODEL_QUALITY_FAILURE': `opencode/big-pickle` preflight, cases
  'STRUCTURED_JSON' and 'EXTRACTION'.
- Observed 'STREAM_FAILURE': partial Native arm for 'EXACT_TEXT'.
- Observed 'HARNESS_FAILURE': non-executable Governor plan path.

## Conclusions

- Decision benchmark: 'INCONCLUSIVE'
- E2E conclusion: 'E2E_INCONCLUSIVE'
- Cost: 'INCOMPLETE' — pricing was not used.
- NVIDIA: `NOT A GATE`
- Canary readiness: 'NOT_READY'
- Governor: `simulate / false / 0`
- Canary: `0 — NOT ACTIVATED`

This run cannot answer whether the Governor maintains an E2E advantage without
repeating the historical 7/10 format-obedience regression. It must not be used
as evidence for Canary Readiness.

## Exact Next Action

Treat this as 'BENCHMARK_INVALID'. Review and fix the published harness path
that assumes `governor.direct` exists, in a separate change with new CI and
without relaxing validators or removing fences. Then rerun the authoritative
5-pair gate before attempting pairs 6–10.

## Environment

- Runtime started only for this attempt and was gracefully stopped afterward.
- Ports 20128, 20131, and 20132 were verified during readiness.
- No Windows shutdown or restart was performed.
- Runtime artifacts remain local and ignored; none are staged for Git.
