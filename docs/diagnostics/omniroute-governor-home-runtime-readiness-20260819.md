# OmniRoute Governor — Home Runtime Readiness — 2026-08-19

## Final status

`E — METHODOLOGY_BLOCKER`

The local Governor runtime is ready in `simulate / false / 0` and the offline
planning gate passed `10/10`, but the authoritative Native preflight has a
routing-state mutation path. The benchmark is therefore blocked until that
methodology is isolated or made side-effect free.

Starting HEAD: `046afbb66395a3771fb5b248485a17c642499170`

Repository: `SamDevlab/OmniRoute`

Branch: `feature/s3-intelligence-governor-prework-20260810`

PR: `SamDevlab/OmniRoute#12` (existing PR; no new PR and no merge)

## CI gate

Final `gh pr checks 12 --repo SamDevlab/OmniRoute` result:

| Check                              | Result                              |
| ---------------------------------- | ----------------------------------- |
| Quality Gates / Fast Quality Gates | `SKIPPED` — expected fast-path rule |
| Semgrep                            | `SUCCESS`                           |
| DAST smoke                         | `SUCCESS`                           |
| Fast Production Build              | `SUCCESS`                           |
| Change Classification              | `SUCCESS`                           |
| Merge integrity                    | `SKIPPED` — expected workflow rule  |

Other fast-path jobs were also `SKIPPED` by the workflow. `CI_GATE = PASS`.
The first observation had Fast Production Build pending; it completed before
the final check.

## Governor mode resolution

The source trace is:

- `src/shared/utils/featureFlags.ts:9-21`: precedence is DB override, then
  `process.env`, then definition default.
- `src/shared/constants/featureFlagDefinitions.ts:569-579`:
  `INTELLIGENCE_GOVERNOR_MODE` defaults to `off` and accepts only the declared
  enum values.
- `src/shared/utils/featureFlags.ts:117-127`: invalid or missing mode resolves
  fail-closed to `off`.
- `open-sse/governor/runtimeConfig.ts:14-40`:
  `GOVERNOR_ACTIVE_ENABLED` defaults to `false` and
  `GOVERNOR_ACTIVE_CANARY_RATE` defaults to `0`.

Previous off classification: **LOCAL_CONFIG_MISSING**.

The previous run had no DB override for the mode and no environment override;
the documented default consequently resolved to `off`. This was not a
production-route change and was not a new `pairLatencyWinner` regression.

## Official configuration mechanism

The supported mechanism is the authenticated administrative API
`/api/settings/feature-flags` (`src/app/api/settings/feature-flags/route.ts:27-146`).
It validates the declared flag and persists/removes the override through the
feature-flag DB module. No SQL, binary DB edit, harness hardcode, or production
hardcode was used.

Applied locally through the official API:

- `INTELLIGENCE_GOVERNOR_MODE = simulate` — source `db`
- `INTELLIGENCE_GOVERNOR_TELEMETRY = true` — source `db`
- `GOVERNOR_ACTIVE_ENABLED` — env `MISSING`, official fallback `false`
- `GOVERNOR_ACTIVE_CANARY_RATE` — env `MISSING`, official fallback `0`

## Effective state and restart persistence

| State           | Before             | After configuration | After OmniRoute-only restart |
| --------------- | ------------------ | ------------------- | ---------------------------- |
| Governor mode   | `off` / default    | `simulate` / DB     | `simulate` / DB              |
| Governor active | `false` / fallback | `false` / fallback  | `false` / fallback           |
| Canary rate     | `0` / fallback     | `0` / fallback      | `0` / fallback               |
| Telemetry       | `true` / default   | `true` / DB         | `true` / DB                  |

The effective resolver read while OmniRoute was running returned:
`simulate / false / 0 / telemetry=true`. The same read after stopping and
restarting only the OmniRoute process returned the same values.

## Pool and connections

The offline pool rebuild reported:

- Raw: `11`
- Active: `11`
- Eligible: `11`
- Healthy: `11`
- Provider targets: `opencode=6`, `felo-web=5`
- Provider circuit states: `opencode=CLOSED`, `felo-web=CLOSED`

Active persisted provider connections were `0`. Presence was recorded without
reading or printing secrets:

| Provider connection | Presence |
| ------------------- | -------- |
| OpenRouter          | `ABSENT` |
| Gemini              | `ABSENT` |
| NVIDIA              | `ABSENT` |
| OpenCode            | `ABSENT` |
| Felo                | `ABSENT` |

The 11 pool targets are synthetic/no-auth candidates in this home environment;
that is why pool eligibility and planning are present despite no persisted
credential connections.

## Offline 10-workload executability

The diagnostic harness
`scripts/ad-hoc/omniroute-governor-home-runtime-readiness-20260819.mjs`
reused the production Auto Combo pool builder, Governor planner, and target
guardrail revalidation. It did not invoke `/api/v1/chat/completions`, an
upstream provider, or a model.

For the matrix below, `active` means the selected target is active; Governor
runtime active remains `false`. `CD`, `LO`, and `EX` mean cooldown, lockout, and
exhaustion guardrails are clear (`true`).

| Workload              | Plan | Target / connection              | Active | Eligible | Healthy | CD   | LO   | EX   | Circuit allowed | Connection allowed | Guardrails | Executable | Failure |
| --------------------- | ---- | -------------------------------- | ------ | -------- | ------- | ---- | ---- | ---- | --------------- | ------------------ | ---------- | ---------- | ------- |
| EXACT_TEXT            | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| STRUCTURED_JSON       | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| ARITHMETIC            | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| EXTRACTION            | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| CLASSIFICATION        | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| PORTUGUESE_STRUCTURED | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| ENGLISH_STRUCTURED    | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| TRANSFORMATION        | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| SHORT_REASONING       | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |
| SIMPLE_CODE           | YES  | `opencode/big-pickle` / `noauth` | true   | true     | true    | true | true | true | true            | true               | PASS       | true       | —       |

Readiness counts:

- Plans: `10/10`
- Guardrails: `10/10`
- Executable: `10/10`
- Runtime: `simulate / false / 0`, telemetry enabled
- `RUNTIME_READINESS = PASS`

Target distribution was `opencode/big-pickle=10`. This is
**LOW_DIVERSITY_ENVIRONMENT**: it is an environmental limitation, not a planner
failure, and no ranking/scoring was changed to force diversity.

The strict JSON-only and exact-code validators remain unchanged. No model output
was produced in this readiness run, so no quality pass is claimed for model
responses.

## Native preflight contamination audit

`PREFLIGHT_STATE_CONTAMINATION = YES` for benchmark methodology.

This readiness task did not run Native preflight; its observed current-run
provider/model request count was zero. However, the authoritative harness calls
`request("auto/chat", ...)` from
`scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs:1732-1733`.
The real request path contains routing-state mutation paths:

- `src/sse/handlers/chat.ts:412-415` records breaker success/failure.
- `src/sse/handlers/chat.ts:1840-1845`, `1889-1894`, and `2096-2102` can call
  `markAccountUnavailable`.
- `src/sse/handlers/chatHelpers.ts:492` clears account error state on success,
  while `:520-525` marks an account unavailable on stream failure.
- `src/sse/services/auth.ts:1878` persists connection cooldown/backoff state.
- `open-sse/services/accountFallback.ts:745-750` and `:972-976` contain model
  lockout and provider-failure state paths.

Therefore the preflight can affect reliability, health, breaker, cooldown,
lockout, provider-failure counters, and routing eligibility before the paired
measurement. A before/after snapshot alone would not make this methodology
side-effect free. This is the benchmark blocker.

## Tests and validation

Passing isolated focused runs (temporary test SQLite only):

- Governor status: `1/1`
- Simulate feature flag: `1/1`
- Runtime closure: `14/14`
- Governor feature flags/failure isolation: `3/3`
- Shadow isolation: `2/2`
- Telemetry privacy: `2/2`
- Active canary: `3/3`
- Active V1: `1/1`
- Counterfactual planner: `9/9`
- Incomplete-pair harness: `5/5`
- Divergence/E2E harness and offline summarizer: `13/13`

Total focused isolated result: `54/54` passed.

Additional checks passed: diagnostic script `node --check`, Prettier check,
and `git diff --check`. The separate feature-flag settings test still contains
the pre-existing count assertion `47` while the current definitions expose
`49`; it is unrelated to this diagnostic and was not changed.

No authoritative benchmark or calibration-recovery run was executed, so there
is no `manifest.json`/`operations.jsonl`/`summary.json` run to summarize. The
offline summarizer tests passed against their hermetic fixtures.

## Production and benchmark outcome

Production code changes: `NONE`.

Diagnostic tooling added: `scripts/ad-hoc/omniroute-governor-home-runtime-readiness-20260819.mjs`.

Provider/model requests executed: `0`.

Benchmark executed: `NO`.

Benchmark permission: **BENCHMARK_BLOCKED** because
`PREFLIGHT_STATE_CONTAMINATION=YES`, despite `CI_GATE=PASS` and offline
`RUNTIME_READINESS=PASS`.

The OmniRoute startup did make non-model background control-plane attempts for
Arena/OpenRouter metadata; these were not provider/model chat requests and were
not part of the readiness harness.

Next exact action: isolate or remove routing-state mutations from the Native
preflight, then rerun the CI/readiness gates. Do not start the authoritative
5-pair benchmark until the preflight classification is no longer `YES`.
