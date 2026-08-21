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
