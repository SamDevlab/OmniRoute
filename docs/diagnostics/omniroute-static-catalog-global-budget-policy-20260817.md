# OmniRoute Static Catalog + Global Budget Policy

Starting HEAD: `fdecc36223e392ea84a96a5328dde3102634c89d`

## Git

- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- Repository: `SamDevlab/OmniRoute`.
- Write remote: `origin`.
- Read-only remote: `upstream` (`diegosouzapw/OmniRoute`). It was not used for push.
- Starting HEAD was present on `origin` and matched the branch upstream.
- The safety bundle `C:\Users\in9midia\Downloads\OmniRoute-S3-final-backup.bundle` was preserved.
- No GitHub/authentication investigation was reopened.

## Starting state

- Governor: `simulate / false / 0`.
- Canary: `0`, not activated.
- Candidate pool: 39 logical provider/model candidates.
  - Gemini: 5 synced candidates.
  - NVIDIA: 5 synced candidates.
  - OpenRouter: 18 synced candidates.
  - OpenCode: 6 static/no-auth candidates.
  - Felo: 5 static/no-auth candidates.
- The persisted local Governor feature flag resolves to `simulate`; no Governor rollout was changed.

## Provider catalog classes

The registry inspection found 227 provider definitions, 61 definitions with a `modelsUrl`, and 215
definitions with static model entries. These counts describe registry metadata, not the current
runtime pool; registry fallback entries for credentialed providers are not automatically active
static-only candidates.

| Class                        |                                                                        Providers/entries | Auth               | Source of truth and runtime meaning                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------: | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYNCED_AUTHORITATIVE         |                                     Gemini 5, NVIDIA 5, OpenRouter 18 current candidates | Credentialed       | Active connection-scoped synchronized catalog when marked authoritative.                                                                              |
| LIVE_DISCOVERY_AUTHORITATIVE |                                               61 registry definitions expose `modelsUrl` | Provider-dependent | Live discovery capability; authority depends on the provider/catalog contract.                                                                        |
| STATIC_ONLY_AUTH             | 158 model-bearing registry entries without `modelsUrl` and with non-`none` auth metadata | Credentialed       | Registry is a fallback source when no authoritative synced catalog is available; this is not proof of current upstream validity.                      |
| STATIC_ONLY_NO_AUTH          |                                                 OpenCode 6; Felo 5 in the flat auto pool | No-auth            | Registry model entries are the factual source used by the no-auth factory.                                                                            |
| OTHER no-auth                |                                  10 no-auth provider definitions in the no-auth registry | Mixed/no-auth      | Local CLI, video, browser/dynamic, reverse-engineered, or anonymous providers; only the approved no-auth auto allowlist is promoted to the flat pool. |
| VIRTUAL                      |                                                                                 `auto/*` | Synthetic          | Virtual combo targets and synthetic `connectionId=noauth`; not an upstream catalog.                                                                   |

## Static-only contract

### Current behavior and precedence

For no-auth auto candidates, `NOAUTH_PROVIDERS` controls eligibility, canonical provider id,
aliases, and service kinds. `REGISTRY[provider].models` supplies the model ids. Aliases affect the
routing/display prefix only; they do not create a second provider. Hidden, excluded, blocked, and
disabled settings filter the result. The no-auth factory uses a synthetic `connectionId` of
`noauth` and does not refresh a live catalog while building this pool.

OpenCode and Felo are the only current no-auth providers admitted to the flat auto pool by the
central `AUTO_COMBO_NOAUTH_ALLOWLIST`. This is an explicit reliability admission rule, not a
provider-specific pricing or error hack. Other no-auth definitions remain direct/family-only or
outside the LLM auto pool unless a separate reliability decision changes the allowlist.

### Confirmed validity policy

Static-only admission is a registry-backed availability assertion, not an eternal upstream-validity
assertion. A static model remains eligible after normal startup unless it is hidden/blocked,
temporarily model-locked, or otherwise filtered by the existing resilience/configuration gates.
There is no permanent blacklist created by this policy.

Structural and transient errors use the existing central taxonomy:

- A model-named unsupported/not-found response, including the existing `model ... is not
supported` forms and applicable model-access responses, is model-scoped where the classifier can
  prove that scope. It can trigger fallback and a temporary model lockout; it does not permanently
  delete the static registry entry.
- A resource/endpoint `404` is request-scoped when the existing resource-not-found predicate says
  so. A generic or ambiguous `404` is not treated as proof that the model was permanently removed.
- A `401`/`403` without model-unavailable wording remains an authentication, account, or provider
  error. Model-specific wording is eligible for model-scoped classification; no generic auth error
  is converted into a model deletion.
- `429` is rate/quota/cooldown behavior, not structural invalidity.
- `503` and the configured provider-breaker statuses are transient/provider health signals only
  when they are genuine upstream failures. A router-owned timeout is explicitly request-scoped.

Model lockout exists per provider + connection + model and is temporary/decaying; its default is
disabled, and a no-auth target can still use the synthetic `noauth` key when the feature is enabled.
Provider cooldown is separately in-memory and can also key a no-auth connection. Expired temporary
state is eligible again. There is no persistent static blacklist and no permanent invalidation path
introduced here.

### Revalidation and drift

Static-only providers do not have the same freshness contract as authoritative synchronized
providers. Revalidation currently comes from model-lockout/provider-cooldown expiry, registry or
application updates, and explicit operator configuration/refresh/restart. There is no approved
upstream freshness source or generic TTL in this code path, so no TTL or invented live fallback was
added. This is an explicit STATIC_ONLY_REVALIDATION_GAP; the admission and error/health semantics
are already centralized and fail-closed enough for the current scope.

### OpenCode

- Registry models: `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`,
  `nemotron-3-ultra-free`, and `north-mini-code-free`.
- Endpoint strategy: no-auth public HTTP through the registered OpenCode Zen base URL.
- Pool policy: admitted by the central no-auth allowlist; registry entries are the model source.
- Failure policy: model-named unsupported responses are temporary model-scoped failures; generic
  auth, resource, rate-limit, and upstream failures retain their existing classifications.

### Felo

- Registry models: `felo-chat`, `felo-search`, `felo-scholar`, `felo-social`, and `felo-document`.
- Endpoint strategy: no-auth reverse-engineered search/thread HTTP endpoint.
- Pool policy: admitted by the same central no-auth allowlist; registry category entries are the
  model source.
- Failure policy: the same generic model/resource/rate-limit/upstream taxonomy applies. No Felo-only
  invalidation rule was added.

Conclusion: STATIC_ONLY_POLICY_ALREADY_CORRECT for admission, filtering, and existing health/error
semantics, with the separately documented STATIC_ONLY_REVALIDATION_GAP for upstream freshness.

## comboTimeoutMs

- Definition/default: `open-sse/services/comboConfig.ts`, `comboTimeoutMs: 0`.
- Config source: combo config merged by `resolveComboConfig`/`phaseComboSetup`; the validation object
  is passthrough and preserves this optional field.
- Per-candidate timeout: `DEFAULT_COMBO_TARGET_TIMEOUT_MS = 120000`; a local `AbortController`
  aborts the active target and returns `504 combo_target_timeout`.
- Global fallback budget: `comboTimeoutMs > 0` is an explicit opt-in absolute deadline for the
  sequential fallback dispatch phase. With `0`, no global deadline is installed and legacy
  unlimited-iteration behavior remains.
- Caller/request timeout: the external request signal and stream/body/readiness limits remain
  separate from both combo timers.
- History: local Git history documents `0` as disabled/backward-compatible behavior. The previous
  implementation checked the elapsed time after a target completed; it did not bound an active
  target or retry/cooldown sleeps.

## Global budget policy

### Chosen policy

Keep the production default at `0`. A positive `comboTimeoutMs` is an explicit deployment/combo
contract, not a newly invented default. This preserves existing callers while making a configured
budget enforceable.

For a positive budget, the sequential fallback phase uses:

```text
deadline = fallbackPhaseStart + comboTimeoutMs
remaining = deadline - now
attemptTimeout = min(targetTimeout, remaining)
```

If `remaining <= 0`, no new target starts. Retry delays, fallback delays, set-retry delays, and
cooldown-aware waits are bounded by the remaining budget or skipped/terminated when they cannot fit.
An active target receives an abort at the global deadline rather than consuming its full target
timeout first. Specialized dispatch-prelude strategies retain their existing ownership and timer
scope; extending one absolute deadline across those separate fan-out/pipeline lifecycles remains a
follow-up decision, not an untested expansion here.

Global exhaustion is classified as router-owned `combo_global_timeout` internally and as the
existing combo-level COMBO_TIMEOUT response, with `504` diagnostics. It is request-scoped and is
not attributed to the last provider, model, or connection. The combo loop returns before provider
breaker, connection cooldown, model lockout, or Governor active health paths process the synthetic
global timeout. Timers are cleared by the runner's `finally` path, and the caller abort signal
continues to cancel waits/dispatches.

Default decision: `KEEP 0`.

## Code changes

- `open-sse/services/combo.ts`
  - Plumbed `comboTimeoutMs` from setup into an absolute fallback deadline.
  - Applied remaining-budget target timeouts and bounded retry/fallback/set/cooldown waits.
  - Skipped new targets after expiry and bypassed health bookkeeping for router-owned expiry.
- `open-sse/services/combo/targetTimeoutRunner.ts`
  - Added global-deadline support, `combo_global_timeout` classification, response marker, abort
    reason, and distinct diagnostics/logging while preserving the existing target timeout path.
- `open-sse/services/combo/comboPredicates.ts`
  - Classified `combo_global_timeout` as request-scoped.
- `open-sse/services/comboConfig.ts`
  - Updated the default-policy comment to document disabled `0` and deadline semantics.
- `tests/unit/combo-routing-engine.test.ts`
  - Covered active-target abort, remaining-target skip, and `comboTimeoutMs=0` compatibility.
- `tests/unit/combo-target-timeout-runner.test.ts`
  - Covered remaining-budget timeout, abort propagation, marker, and internal code.
- `tests/unit/combo/combo-target-timeout-standards.test.ts`
  - Covered global timeout breaker/exhaustion isolation alongside the existing target-timeout
    health standards.

No Governor policy, catalog, provider credentials, S3 content, environment file, or canary setting
was changed.

## Regression tests

- Combo routing engine: **88/88 pass**, 0 fail.
- Timeout runner + target/global timeout health standards: **13/13 pass**, 0 fail.
- Catalog/pool/virtual/Governor/stream regression set in isolated temporary `DATA_DIR`:
  **44/44 pass**, 0 fail.
- 429 and no-auth/model-lockout regressions: **12/12 pass**, 0 fail.
- Model-unavailable classification regressions: **8/8 pass**, 0 fail.
- `npm run typecheck:core`: **PASS**.
- `git diff --check`: **PASS** (only normal LF/CRLF conversion warnings).
- The same 44-test set against the persistent local DB produced 43/44 because its DB feature flag
  override forced `simulate`; this was reproduced, not changed, and the isolated run passed 44/44.

## Runtime

- Listener check: `127.0.0.1:20128` was not listening.
- 3-5 smoke: **NOT EXECUTED**; starting/restarting the server was explicitly prohibited.
- 5/5 gate: **NOT EXECUTED**.
- 10/10 gate: **NOT EXECUTED**.
- 20-request confirmation: **NOT EXECUTED**.
- No benchmark was run and no upstream request was made by this validation.

## Governor

`simulate / false / 0`.

The local effective mode was observed as `simulate`; active was false and the configured canary rate
remained `0`. No active decision or rollout was enabled.

## Canary

`0 - NOT ACTIVATED`.

## Remaining risks

- Static registry drift cannot be proven fresh without an approved live discovery/freshness
  contract. Temporary lockout expiry intentionally allows re-evaluation of the static entry.
- `comboTimeoutMs=0` remains unlimited by design for backward compatibility; deployments that need
  an SLA must configure a positive value explicitly.
- The new deadline covers the sequential fallback phase. Specialized dispatch-prelude lifecycles
  have separate ownership and were not broadened without dedicated tests.
- Runtime 3-5 smoke remains pending because no server was already running and no restart was
  authorized.

## Canary readiness

NOT_READY.

The policy and focused tests are complete, but runtime smoke could not be performed in this task.
Canary review must remain a separate decision and must not change the current `0` rate here.

## Exact next action

In a separate explicitly authorized runtime-validation task, start the local server with
`simulate / false / 0`, execute only the short 3-5 native `auto/chat` smoke, and review the
specialized-prelude deadline scope before any separate canary decision. Do not activate canary in
that review without explicit authorization.

## Final status fields

- FINAL STATUS: `D - IMPLEMENTATION_VALIDATION_PENDING`
- HEAD: final commit containing this report (verified after commit/push)
- HEAD present on origin: to be verified after push
- Working tree: intended changes only before commit
- Write remote: `origin`
- Governor: `simulate / false / 0`
- Canary: `0 - NOT ACTIVATED`
- Candidate pool: 39
- Static-only providers identified: 10 no-auth definitions; OpenCode and Felo are the current flat-auto static-only cases
- OpenCode policy: central no-auth allowlist + registry models + temporary generic resilience semantics
- Felo policy: central no-auth allowlist + registry category models + temporary generic resilience semantics
- Static structural error semantics: model-named unsupported/access errors may be model-scoped and temporarily locked; generic endpoint/auth errors are not permanent model deletion
- Static transient error semantics: 429/503 and ambiguous resource failures retain cooldown/fallback/provider semantics
- Static revalidation: lockout/cooldown expiry, registry/application update, or operator refresh; no invented TTL
- `comboTimeoutMs` current default/semantics: `0`, disabled/unlimited legacy behavior; positive values are sequential fallback absolute deadlines
- Global budget policy: explicit positive opt-in; min(target timeout, remaining), bounded waits, no new target after expiry, router-owned classification
- Default decision: `KEEP 0`
- Deadline behavior: active target aborts at remaining budget; later dispatches and waits are bounded/skipped
- Global exhaustion classification: internal `combo_global_timeout`, external combo COMBO_TIMEOUT/504
- Health side-effects: router-owned global expiry is request-scoped and does not poison provider/connection/model/Governor health
- Code changes: combo deadline plumbing, timeout classification, config documentation, focused regression tests
- Tests: combo 88/88; timeout/health 13/13; catalog/pool/Governor/stream 44/44 isolated; 429/lockout 12/12; classifier 8/8; typecheck PASS; diff check PASS
- 3-5: NOT EXECUTED (no listener; no restart)
- 5/5: NOT EXECUTED
- 10/10: NOT EXECUTED
- 20 confirmation: NOT EXECUTED
- Commit: created after this report and recorded in the final handoff
- Push to origin: pending at report creation; will be verified explicitly
- Remaining risks: static freshness, default disabled budget, specialized-prelude scope, runtime smoke pending
- CANARY READINESS: NOT_READY
- NEXT EXACT ACTION: separate authorized 3-5 runtime smoke, then independent canary review
- COMPUTER: LEFT ON - NO SHUTDOWN/RESTART EXECUTED
