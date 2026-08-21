# OmniRoute S3 — final Governor validation

## Scope

- Repository: `SamDevlab/OmniRoute`
- Branch: `feature/s3-intelligence-governor-prework-20260810`
- Benchmark HEAD: `f0131af4c5999eb9d54487fd4f6f66ef7c2003bb`
- Governor: `simulate / false / 0`
- Telemetry: enabled
- Canary: `0` (not activated)
- NVIDIA: not a gate

## Runtime recovery and health root cause

`better-sqlite3@13.0.2` was absent from `node_modules`. The package's distributed
Windows prebuilt was installed in a temporary directory with `--ignore-scripts`
and passed a real in-memory SQLite test. The verified package was then materialized
locally in `node_modules`; no manifest or lockfile change was made.

The health route module imported successfully and a direct call to `GET()` returned
HTTP 200. The webpack development server accepted a listener but did not complete
the HTTP health request within 60 seconds. The same supported `run-next.mjs` runtime
using Turbopack returned HTTP 200 in 1.45 seconds. Therefore the observed issue was
classified as `NEXT_WEBPACK_HANG`; no application source fix was required.

## Readiness

The official offline readiness harness reported:

- Native baselines: 10/10
- Canonical identities: 10/10
- Governor plans: 10/10
- Governor guardrails: 10/10
- Governor executable: 10/10
- Provider/model requests: 0
- Planning-only mode: true
- Preflight state contamination: `NO`
- Pool: raw 11, active 11, eligible 11, healthy 11
- Pool providers: `opencode` 6, `felo-web` 5
- Breakers: CLOSED

## Authoritative benchmark

Run ID: `20260821T001612Z-c9ef5d19`

Artifacts were read from the persisted `manifest.json`, `operations.jsonl`, and
`summary.json` under the temporary run directory. The run requested five pairs and
started two. It stopped before pair 3, as required, because the manifest recorded:

- `stopReason`: `BENCHMARK_INVALID`
- `failureClass`: `TARGET_MISMATCH`
- `failureReason`: `NATIVE_BASELINE_DRIFT`

The durable five-pair gate therefore failed and pairs 3–10 were not executed.

Offline summarization reconstructed the persisted run without warnings:

- Pairs completed: 2/5
- Native HTTP/stream: 2/2
- Governor HTTP/stream: 2/2
- Governor plans/executable: 2/2
- Native quality: 1/2
- Governor quality: 1/2
- Identity: PASS in the offline gate summary
- Accounting: PASS
- Artifact integrity: PASS
- Invalid pairs: 2
- Failure class observed in replay: `MODEL_QUALITY_FAILURE`
- Offline replay: semantically coincident with `summary.json`

The structured JSON case reproduced a model-quality failure. Strict validators were
preserved; no Markdown fences were stripped and no validator was relaxed. Because
the five-pair gate did not complete, no E2E winner is declared.

## Conclusion

`DECISION_BENCHMARK: INCONCLUSIVE`

The Governor's E2E advantage cannot be determined from this invalid, incomplete run.
Cost remains incomplete. Active mode and canary were not enabled.

## Final authoritative rerun after replay fix

The exact CI-validated HEAD was `0a3035b3a7ea9e98cbc1c59ac8dd7302cdd85b44`.
Required checks were successful: Quality Gates, Governor Harness, Semgrep, DAST
smoke, and Fast Production Build. The expected advisory build skip was not treated
as a failure. Runtime used Turbopack; `/api/monitoring/health` returned HTTP 200 in
2340 ms. Effective Governor state was `simulate / false / 0`, telemetry enabled,
and canary `0`.

The official readiness gate passed with pool raw/active/eligible/healthy `11/11/11/11`,
10/10 plans, 10/10 guardrails, 10/10 executable plans, zero provider/model requests,
and `PREFLIGHT_STATE_CONTAMINATION=NO`.

New authoritative run: `20260821T022100Z-27ab5601`.

Artifacts were read from the durable `manifest.json`, `operations.jsonl`, and
`summary.json` files at:

`docs/diagnostics/governor-e2e-artifacts/20260821T022100Z-27ab5601/`

The run stopped after pair 1, before pairs 2–10, because the Native first actual
target was `opencode/deepseek-v4-flash-free` while the side-effect-free Native
baseline was `opencode/big-pickle`.
The artifact records `baselineDrift=true`, `stopReason=BENCHMARK_INVALID`,
`failureClass=TARGET_MISMATCH`, and `failureReason=NATIVE_BASELINE_DRIFT`.
The baseline snapshot had zero provider/model requests, zero network calls, no
routing-state mutation, and identical before/after home-state digests.
The physical call-log sequence for Pair 1 began with
`opencode/deepseek-v4-flash-free` and then tried Felo targets; its `auto/chat` row
was only the virtual aggregate error row. `DID_PHYSICAL_FALLBACK_TO_AUTO_CHAT=NO`.

The five-pair gate failed with 1 started/completed pair, 0 valid pairs, Native
identity `FAIL`, Governor identity `PASS`, accounting `PASS`, artifact integrity
`PASS`, and `benchmarkInvalid=true`. No further physical requests were issued.
Governor planning was included in E2E accounting (`81 ms` planning; Governor E2E
`6665 ms`), but no winner is declared because the benchmark was structurally invalid.
Strict validators remain unchanged; no Markdown fences or validator relaxation was
introduced.

The required `--summarize-run` replay produced the same run status, pair counts,
five-pair gate, identity results, accounting, quality counts, E2E timings, planning
timings, and target distributions as the persisted execution summary, with zero
warnings. This confirms the offline summary is consistent with the authoritative
artifacts.

`DECISION_BENCHMARK: INCONCLUSIVE`

The Governor's E2E advantage remains undetermined: the new run exposed a Native
baseline/first-actual routing mismatch before a valid Native-vs-Governor comparison
could be completed. The historical invalid run remains historical only; it was not
resumed or reused.

## Root-cause diagnosis after the invalid rerun

The apparent LKGP explanation was tested without model requests. The production
LKGP for `auto/chat` was present as provider metadata `opencode`; the isolated worker
saw no LKGP. With the frozen Pair 1 snapshot, both resolutions selected the same
first target:

| Resolution              | First target          | Network/provider-model requests |
| ----------------------- | --------------------- | ------------------------------: |
| Without LKGP            | `opencode/big-pickle` |                           0 / 0 |
| With real LKGP metadata | `opencode/big-pickle` |                           0 / 0 |

Therefore `LKGP_PARITY_ROOT_CAUSE=NOT_CONFIRMED`.

The decisive evidence is temporal contamination before and during the run. The
unsupported diagnostic command `--help` was not recognized by the old harness and
fell through to the non-authoritative execution path while the Turbopack runtime was
active. The household call log contains 44 physical rows from `02:20:11` through
`02:20:59`, immediately before the authoritative run began at `02:21:00`; those
requests changed live provider/model resilience state. The Pair 1 request then began
at `02:21:48`, after that untracked activity. The frozen baseline could not observe
this live-state transition, so the result is not evidence of clean production-vs-
baseline routing parity.

Root cause classification: `OTHER_ROUTING_INPUT_PARITY_BUG` in the benchmark
precondition/harness, specifically unguarded unsupported CLI input plus live-state
contamination between snapshot and dispatch. Production routing semantics were not
changed.

The harness now rejects unsupported arguments before pool/request work, and excludes
the virtual `auto/chat` aggregate row from physical call-log identity evidence. The
historical runs `20260821T001612Z-c9ef5d19` and `20260821T022100Z-27ab5601` remain
invalid and must not be resumed.

## Clean authoritative run — production-path parity proven

Validation used HEAD `e06d7a1aa8e1c508d4d0092fd6741a8f0f33862e`, equal locally and
on origin, with one Turbopack runtime. Effective Governor state was
`simulate / false / 0`, telemetry was enabled, and canary remained `0`. The
required CI checks were green or expected advisory skips.

Readiness passed 10/10 for native baselines, canonical identities, plans,
guardrails, and executable plans. The production-path parity probe passed 10/10
through real `handleComboChat` with an injected `handleSingleModel` interceptor;
it observed zero network/provider calls before interception and prevented physical
dispatch. The physical high-water marker stayed unchanged through both preflight
phases.

New authoritative run: `20260821T102320Z-2faf68e8`. Durable artifacts are in
`docs/diagnostics/governor-e2e-artifacts/20260821T102320Z-2faf68e8/`. The run
stopped after pair 1 of the requested 5 and was not expanded to 10. The manifest
records `BENCHMARK_INVALID`, `TARGET_MISMATCH`, and `NATIVE_BASELINE_DRIFT`.
Native baseline was `opencode/mimo-v2.5-free`; first actual was
`opencode/big-pickle`; final actual was `felo-web/felo-document`. Native fallback
was true, so Native identity failed. Governor planning was included in E2E; its
executable target was `opencode/hy3-free`, with 38 ms planning and 3890 ms total
E2E. Governor quality/HTTP/stream passed for the single arm; Native quality and
stream failed. No winner is declared.

The persisted five-pair gate is false: 1 pair started/completed, 0 valid, Native
identity failed, Governor identity passed, accounting passed, and artifact
integrity passed. Artifact accounting records 2 authoritative physical requests
(1 Native arm and 1 Governor execution). The external call log records 9 new rows;
8 are virtual `auto/chat` fallback rows excluded by the physical-marker rule.

The official offline `--summarize-run` replay matches `summary.json` for status,
pair counts, gate, identity, failure classes, quality, HTTP, stream, accounting,
E2E, planning, and target distributions, with zero warnings. No pricing result is
claimed. `DECISION_BENCHMARK: INCONCLUSIVE`. The invalid run is preserved and was
not rerun, resumed, or patched; strict validators remain unchanged.
