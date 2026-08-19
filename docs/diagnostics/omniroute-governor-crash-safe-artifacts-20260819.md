# Governor Crash-Safe Benchmark Artifacts

## Starting State

- HEAD: d7d152c7b9de4d45c5a9624e56d287c1bb123a17
- Branch: feature/s3-intelligence-governor-prework-20260810
- Governor: simulate / false / 0
- Canary: 0
- Production changes expected: none

## Repository Safety

- Origin: SamDevlab/OmniRoute
- Upstream: diegosouzapw/OmniRoute, read-only
- Push protection: local pre-push hook rejects the upstream remote name and upstream URL
- PR: SamDevlab/OmniRoute#12, existing open draft PR; no new PR created
- Shared checkout: preserved on its original branch and HEAD

## Existing Persistence

Classification: FINAL_ONLY_PERSISTENCE.

The previous writer created one atomic all-in-one JSON file only from the final
output path. It did not create a manifest before Pair 1, append completed arms,
append completed pairs, handle SIGINT/SIGTERM, or provide offline reconstruction.

## New Artifact Layout

Each authoritative or calibration-recovery run creates a unique UTC runId with a
short random suffix under docs/diagnostics/governor-e2e-artifacts/. Runtime run
directories are ignored and are never intended for commit.

- manifest.json: created before the first request, initially RUNNING
- operations.jsonl: one fsynced JSON record per completed operation
- summary.json: atomically written only after normal finalization
- final-snapshot.json: preserved all-in-one diagnostic snapshot
- offline summarizer: scripts/ad-hoc/omniroute-governor-run-summarizer.mjs

The manifest records schemaVersion, runId, status, startedAt, gitHead, branch,
Governor state, requested pairs, authoritative mode, workload/validator hashes,
runtime base URL, and a sanitized pool snapshot.

## Crash Recovery

Pair-7 crash simulation: PASS.

The synthetic fixture persisted pairs 1–6, started Pair 7 with a governor_plan
record, omitted the pair completion record, and produced INCOMPLETE_RUN with
completedPairs equal to 6. No summary was fabricated.

## Terminal Loss

PASS. The offline summarizer reconstructs the run from manifest.json and
operations.jsonl without reading stdout, starting a server, using the database,
or contacting a provider.

## SIGINT

PASS. The shutdown handler marks the manifest ABORTED synchronously, preserves
completed operations, exits with the signal-compatible code, and does not write
a fabricated summary.

## Malformed JSONL

PASS. Valid preceding operations are retained, the malformed final record is
reported as MALFORMED_OPERATION_RECORD, and the run cannot be declared
COMPLETE.

## Atomic Summary

PASS. summary.json is written through a fsynced temporary file followed by
rename; only the exact summary.json path is read by the summarizer.

## Timers

- headersMs: PASS
- firstByteMs: PASS
- firstContentMs: PASS
- doneMs: PASS
- readerCloseMs: PASS
- completionMs: PASS
- totalE2EMs: PASS
- planningMs: PASS
- planningShare: PASS

Timing aggregates use the same ordered floor-percentile rule as the benchmark
helpers and are reconstructed from operation records rather than stdout.

## Offline Replay

- Complete run: PASS
- Incomplete run: PASS
- Pair-7 crash: PASS
- Malformed JSONL: PASS
- Terminal loss: PASS

## Accounting

PASS. Native preflight requests, Native arm requests, Governor planning
operations, Governor execution requests, authoritative physical requests, pair
count, and preflight-inclusive physical requests are reported separately.

## Output Bound

PASS. Persisted output previews are capped at MAX_PERSISTED_OUTPUT_BYTES
(4096 UTF-8 bytes) and set outputTruncated when truncation occurs. The final
snapshot keeps the existing diagnostic output while applying the same bound.

## Quality Contract

Historical Native: 10/10.

Historical Governor: 7/10.

Confirmed model quality failures: 3 MODEL_QUALITY_FAILURE cases. The strict
JSON/code validators and Markdown-fence behavior were not changed.

## Telemetry Privacy

RAW_PROMPT_PERSISTED: NO.

Evidence:

- open-sse/governor/types.ts marks rawPromptText as in-memory only.
- governorManager.ts passes only numeric/enum metadata to telemetry.
- src/lib/db/governorTelemetry.ts inserts an explicit metadata allowlist.
- governor_telemetry migrations contain no prompt/message/content/body columns.
- governor-telemetry-privacy.test.ts injects prompt, response, authorization, key,
  and token sentinels and verifies they do not appear in telemetry storage.
- operations.jsonl uses an independent allowlist/sanitizer and excludes prompt,
  response, headers, body, credential, token, and stack fields.

The synthetic benchmark final snapshot may retain synthetic workload prompts,
explicitly marked syntheticWorkload; production Governor telemetry remains
metadata-only.

## Tests

- Persistence and crash fixtures: PASS, 13/13
- Governor safety/privacy focused fixtures: PASS, 29/29
- Focused lint for changed files: PASS
- Syntax checks: PASS
- Diff check: PASS
- Vitest: PASS, 39 files / 355 tests
- Typecheck: PASS (`npm run typecheck:core`)
- Docs: PASS (`npm run check:docs-all`; only known soft drift warnings)
- Global lint: PREEXISTING_GLOBAL_LINT_ERRORS, 14 errors in untouched
  `tests/unit/chat-helpers.test.ts`; focused lint is clean
- Global unit suite: known preexisting Auggie worker hang; no unrelated fix attempted
- Secret scan: manual allowlist review PASS; gitleaks not installed in the environment

## CI

Quality Gates: previously pass/skipped according to PR checks; re-observe after push.

Semgrep: previously pass.

DAST and Fast Production Build: pending in the last observed PR check set.

The new commit must be pushed to PR #12 and its checks re-observed. No
benchmark is permitted while relevant required checks are not green.

## Production Code Changes

Expected: NONE.

Actual: NONE. Changes are limited to diagnostic harness persistence, offline
summarization, tests, ignore rules, and documentation.

## Governor

simulate / false / 0

## Canary

0 — NOT ACTIVATED

## Exact Next Action

Run the focused and repository gates, inspect the final diff for secrets and
runtime artifacts, commit the crash-safe harness changes, and push only to
origin on the existing PR #12. Do not execute a provider benchmark or activate
canary until the required CI checks are green and separately approved.
