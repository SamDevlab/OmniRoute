# Governor Incomplete-Pair Harness Recovery

## Starting State

- HEAD: `6e7b171ec9ae3b5824df1681fb5704aa2b09524b`
- Branch: `feature/s3-intelligence-governor-prework-20260810`
- PR: `SamDevlab/OmniRoute#12`
- Declared Governor configuration: `simulate / false / 0`
- Canary: `0` — not activated
- Worktree was clean and local `HEAD` matched `origin/feature/s3-intelligence-governor-prework-20260810` before this fix.
- PR checks at the start of this task: `dast-smoke`, `semgrep`, and `Fast Production Build` were `pass`; the workflow fast-path jobs and merge-integrity job were `skipping` under their expected rules. No check was pending or failing at that confirmation point.

No real benchmark, provider request, live smoke, calibration, provider configuration, credential copy, or server start was performed in this task.

## Previous Invalid Run

- Run ID: `20260819T214907Z-3fb4f07b`
- Previous HEAD: `735bbb9e189346d4475b03fbf6dddd80ec21e418`
- Requested pairs: `5`
- Durable artifacts: `manifest.json` and `operations.jsonl` present; `summary.json` correctly absent because the process crashed.
- Offline status: incomplete run
- Operations: 5 native preflights, 2 native arms, 2 Governor plans, 0 Governor arms, 1 `pair_complete`.
- The artifact contained 10 valid JSONL records and no malformed operation line.

## Crash Root Cause

The old finalization path called:

```text
pairLatencyWinner(native.request, governor.direct)
```

when `governor.direct` was `undefined`. The old function dereferenced `governor.qualityPass` before checking whether the arm existed. The recorded stack was:

```text
TypeError: Cannot read properties of undefined (reading 'qualityPass')
at pairLatencyWinner (scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs:1729)
at buildAuthoritativePair (...:1745)
```

There was a second defect: the old function expected `e2eCompletionMs` on request objects, while the authoritative arm stores that timing on the arm result. Therefore a complete pair could have incorrectly produced a latency tie even without the missing-arm crash.

## Why `governor.direct` Was Missing

Both old `governor_plan` records had:

| Pair | Case                            | Planned target | Plan present | Executable | Governor arm |
| ---- | ------------------------------- | -------------- | ------------ | ---------- | ------------ |
| 1    | `authoritative-exact-text`      | `null`         | no           | false      | absent       |
| 2    | `authoritative-structured-json` | `null`         | no           | false      | absent       |

The local runtime inspection was read-only and returned:

```json
{ "mode": "off", "flag": "off", "telemetry": true, "envMode": null }
```

`INTELLIGENCE_GOVERNOR_MODE` resolves with DB override, then environment, then definition default; the definition default is `off`. `applyGovernorToAutoComboOrder` returns a null context for `off` or `shadow`, so no counterfactual plan exists. The old harness wrote the intended manifest fields (`simulate / false / 0`) but did not verify the effective runtime mode before running preflights or pairs.

Therefore the root cause for both plans is:

```text
GOVERNOR_MODE_MISMATCH
root classification: HARNESS_LOGIC_ERROR
```

This is not evidenced as no-executable-target, stale-plan, target-unavailable, target-mismatch, or guardrail-rejection: no Governor plan was produced and no Governor target was selected. The old harness-failure label was directionally correct as a harness/configuration failure, but incomplete because it hid the actionable reason.

## Governor Plan Executability

The old artifact did not persist `unresolvedFields`, guardrails, active/eligible/healthy state, cooldown, lockout, exhaustion, circuit, or connection allowance. Those fields are therefore recorded as unavailable for the old run, not inferred.

The harness now persists, when evidence exists:

- plan presence and explicit plan state;
- selected/planned provider, model, target, and connection;
- `executable`, confidence, unresolved fields, reasons, and guardrails;
- effective Governor mode and mode-match result;
- target active/eligible/healthy, cooldown, lockout, exhausted, circuit, provider circuit state, connection allowance/state;
- revalidation result, failure class, failure reason, and root cause.

Legitimate non-executable plans are classified as Governor-plan-non-executable with a specific reason such as no-executable-target, guardrail-rejection, missing-capability-data, missing-connection, or target-not-allowed. They are not model-quality failures and do not receive an artificial latency loss.

## Pool Environment

The previous run reported:

- Raw: `11`
- Active: `11`
- Eligible: `11`
- Healthy: `11`
- Providers: `opencode`, `felo-web`
- Starting breakers: two `CLOSED`; starting cooldowns: zero; starting lockouts: zero.

This is a pool-health/readiness snapshot for Auto Combo candidates. It is not proof that Governor has an executable counterfactual plan. The current harness does not have a valid global scalar for executable readiness; executability is per-request and depends on the actual plan, candidate, guardrails, revalidation, and connection evidence. Executable readiness for the old run is therefore unproven, and the old records prove `0/2` observed executable plans because both plans were absent.

The smaller home-environment pool is documented as an environment difference only. No provider was added and no credential was copied or printed.

## Pair State Model

The new pure harness state model is in `scripts/ad-hoc/omniroute-governor-pair-state.mjs` and covers:

- PAIR-COMPLETE-VALID
- NATIVE-ARM-MISSING
- GOVERNOR-PLAN-MISSING
- GOVERNOR-PLAN-NON-EXECUTABLE
- GOVERNOR-DIRECT-MISSING
- native/Governor HTTP and stream failures;
- native/Governor quality failures;
- STALE-PLAN, TARGET-MISMATCH, and HARNESS-FAILURE.

Evaluation is ordered as: native arm, Governor plan, plan executability, Governor arm, identity, HTTP, stream, quality, then latency. An executable plan without a direct arm is GOVERNOR-DIRECT-MISSING / HARNESS-FAILURE, is persisted, and requests a controlled benchmark-invalid stop. A missing plan caused by effective-mode mismatch is fail-closed before any authoritative preflight request.

## Winner Evaluation Preconditions

`pairLatencyWinner` now receives complete arm results and returns `null` when either arm is absent, not HTTP 200, not stream-complete, not quality-pass, or lacks finite total E2E timing. It cannot dereference an incomplete arm and it cannot convert an unavailable latency comparison into a tie.

For complete arms the order remains quality, success/complete-stream, then total E2E with the existing 15% threshold. Governor planning remains inside the Governor arm's total E2E timing. Upstream/provider duration is not used as E2E.

Invalid `pair_complete` records persist `winner: null`, `latencyWinner: null`, failure class/reason, pair state, native operation ID, Governor plan operation ID, and a null Governor arm operation ID when no arm exists.

## Five-Pair Gate Safety

The gate now safely reports requested, started, completed, valid, native/Governor HTTP, streams, quality, Governor plans, executable plans, identity, accounting, artifact integrity, and benchmark-invalid state. It requires five executable Governor plans, five Governor arms, five native arms, valid identities, quality pass, complete accounting, and intact artifacts. A missing Governor arm cannot throw.

The gate behavior was verified with:

1. five valid pairs — `PASS`;
2. four valid plus one non-executable plan — `FAIL`, executable count `4`, no artificial latency result;
3. four valid plus one harness-failure — FAIL, benchmark-invalid true.

## Preflight Audit

Native preflights are separate `native_preflight` operations and are target-readiness probes, not authoritative pair quality. In the previous run:

- the structured JSON preflight was model-quality-failure / invalid-json because the observed output was fenced JSON;
- the extraction preflight was model-quality-failure / empty-reconstructed-content.

Those failures were not included as authoritative pair quality: the prior artifact had five preflight operations but only two native authoritative arms, and the summary’s authoritative quality aggregate is derived from arm operations.

The strict validator contract remains unchanged. Markdown fences in JSON-only and exact-code responses remain quality failures; fences are not stripped.

### Preflight State Contamination

Preflight-state-contamination-risk = unproven.

The preflight path uses real chat requests, and the request pipeline contains normal breaker, connection cooldown, model-lockout, failure-counter, and success-clearing paths. The old harness captured only the initial pool snapshot; it did not capture a before/after resilience snapshot around preflights and did not isolate preflight state. The old artifact’s initial zero cooldowns/lockouts do not prove that later preflight failures could not affect later arms. No production change was made here; a future benchmark should snapshot and account for this explicitly before trusting preflight-derived readiness.

## Synthetic Tests

- Incomplete Governor direct: pre-fix dereference reproduced in a fixture; current evaluation survives and persists an explicit state.
- Non-executable plan: explicit Governor-plan-non-executable and no-executable-target.
- Executable plan with missing direct: Governor-direct-missing / harness-failure with controlled-stop signal.
- HTTP and stream failures: side-specific state and no latency comparison.
- Quality failures: quality winner is selected while latency remains not applicable.
- Target mismatch and stale plan: explicit states; mismatch requests stop, stale plan does not become model quality.
- Missing total E2E: valid structural pair with `latencyWinner: null`.
- Offline incomplete artifact: summary reads a plan plus invalid `pair_complete` with no Governor arm without throwing.
- Strict fenced-output validator tests remain green.

## Production Changes

None. Changes are limited to `scripts/ad-hoc`, `tests`, and this diagnostic report. No Governor scoring, ranking, reliability, health, tiering, pricing, provider selection, fallback, timeout, routing, workload, or validator code was changed.

## Tests

- Focused harness and persistence tests: `18/18` passed.
- `node --check` passed for the pair-state module, divergence harness, and persistence module.
- `git diff --check` passed.
- No real E2E benchmark was run.

## Governor

Declared configuration remains `simulate / false / 0`. The harness now records the effective mode and refuses an authoritative run when it does not match `simulate`; this home environment currently resolves effective mode `off`.

## Canary

`0` — not activated.

## Next Exact Action

After this fix is pushed and its CI is green, configure/verify the intended effective `simulate` mode without changing Governor production logic or adding providers, then run the published authoritative harness for five pairs. Use `manifest.json`, `operations.jsonl`, and `summary.json` as the only result sources; proceed to ten only after the five-pair gate passes. Do not use this report or the old terminal output as benchmark results.
