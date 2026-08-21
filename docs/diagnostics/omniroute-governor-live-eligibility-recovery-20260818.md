# OmniRoute Governor — Live Eligibility and Recovery Investigation (2026-08-18)

## Scope and safety

This investigation used the local OmniRoute server at `http://127.0.0.1:20128`.
It did not change S3, routing policy, credentials, API keys, or persistent `.env`
configuration. The only repository change from this investigation is this diagnostic
report. No active route decision was enabled and no canary traffic was sent.

The server process was started with:

```text
INTELLIGENCE_GOVERNOR_MODE=simulate
INTELLIGENCE_GOVERNOR_TELEMETRY=true
GOVERNOR_ACTIVE_ENABLED=false
GOVERNOR_ACTIVE_CANARY_RATE=0
GOVERNOR_TELEMETRY_SAMPLE_RATE=1
```

The local database already contained the feature-flag override
`INTELLIGENCE_GOVERNOR_MODE=simulate`; it was read only and was not changed.
The computer was left on. No shutdown or restart was executed.

## Git state

```text
branch: feature/s3-intelligence-governor-prework-20260810
HEAD before report: a0280c82afd4f55097532d19161abaf189dc61fb
origin/feature/s3-intelligence-governor-prework-20260810: same HEAD
working tree before report: clean
```

## Previous benchmark

The previous Native-vs-Governor validation recorded:

| Arm                |                                              Result |
| ------------------ | --------------------------------------------------: |
| Native `auto/chat` |                                      5/5 successful |
| Governor direct    | 0/5; all direct OpenCode attempts returned HTTP 429 |
| Governor plans     |           5/5 executable, with no unresolved fields |

The Governor plans selected OpenCode free models while Native delivered OpenRouter.
That benchmark serialized planning and direct execution; it did not prove that a
Governor decision was made while the OpenCode model-lockout window was still active.

## Root cause

OpenCode returned HTTP 429 from the no-auth route:

```text
logical provider: opencode
resolved route: opencode-zen/opencode.ai/zen/v1/chat/completions
model: big-pickle
connection: noauth
classification: model-scoped transient rate limit
lock: opencode:big-pickle, reason=rate_limited, duration=3s
provider breaker: not opened
```

The shared namespace implementation is present. `getNoAuthLockProviderId()`
canonicalizes the routed `opencode-zen` identity to the logical `opencode` identity,
and `filterResilienceBlockedCandidates()` checks the synthetic `noauth` lock before a
virtual Auto Combo is materialized. The existing `#7623` test also proves that a lock
recorded under `opencode-zen` removes `opencode/big-pickle` from the logical pool.

The apparent Governor mismatch was timing, not a confirmed propagation defect. In the
controlled runtime sequence, the lock was recorded at `17:55:05.851` and the next
`auto/chat` request entered the server at `17:55:08.983`, approximately `3.13s`
later. The configured transient lock had therefore expired before the next pool was
constructed. The same pattern was present in the earlier serialized shadow benchmark:
the Governor plan was observed before its own direct OpenCode attempt, or after the
short lockout had expired.

`buildCounterfactualCandidates()` marks targets that survived the current Auto Combo
construction as `available: true`. That representation means “available in this
request’s constructed runtime pool”; it is not an independent upstream health probe.
Because the virtual factory re-applies the hard resilience filter on each request, no
production change is justified by this run. A concurrent cross-request stale-snapshot
case remains a future test opportunity, but it was not reproduced here.

## 429 propagation and eligibility

| Check                                         | Result                               | Evidence                                                      |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| 429 scope                                     | Model + synthetic no-auth connection | Runtime log: `opencode:big-pickle`, `connection stays active` |
| Shared no-auth namespace                      | PASS                                 | `opencode-zen` lock is visible as logical `opencode`          |
| Provider breaker propagation                  | PASS / intentionally unchanged       | No provider-wide breaker opened                               |
| Native hard eligibility during active lock    | PASS in focused test                 | Locked model absent from virtual pool                         |
| Governor plan during active lock              | Not reproduced in live request       | The measured next request started after the 3s lock expired   |
| Native/Governor mismatch after active blocker | NO causal mismatch established       | Previous plans were pre-failure or post-expiry                |
| Cooldown recovery                             | PASS                                 | Expired lock is lazily removed and candidate can return       |

The hard eligibility path is:

```text
429 → markAccountUnavailable → shared model lock
    → createVirtualAutoCombo → filterResilienceBlockedCandidates
    → orderedTargets/routableCandidates
    → Governor counterfactual plan
```

The dispatch path independently checks `isModelLocked()` before attempting a target.
Therefore `executable=true` in the observed plans means that the target was valid in
the pool snapshot used for that request and passed planning guardrails; it does not
mean that the Governor performed a fresh upstream call.

## Cost and scoring classification

The free-pricing correction is working as intended:

```text
selectedProvider: opencode
selectedModel: big-pickle
resolvedModelTier: low
estimatedCurrentCost: null
estimatedCounterfactualCost: 0
costEstimateBasis: PRE_REQUEST_BUDGET
confidence: MEDIUM
executable: true
unresolvedFields: []
```

Known factual free classification supplies zero input/output pricing for the
counterfactual model. Missing current pricing for the actual OpenRouter route remains
unknown and is not converted to zero. The focused pricing tests also confirm that an
unknown provider or paid model never receives fabricated zero pricing.

The zero counterfactual cost is therefore not the root cause of the 429. It does,
however, make OpenCode an attractive low-tier counterfactual while Native’s LKGP and
runtime fallback continue to prefer a healthy OpenRouter target. No provider-specific
score reduction, blacklist, or Governor policy change was applied.

## Felo classification

The direct no-auth Felo probe returned:

```text
provider: felo-web
model: felo-chat
connection: noauth
HTTP: 400
error: Felo thread creation failed with HTTP 400
```

The rejection occurred at the reverse-engineered
`POST https://felo.ai/api-proxy/main/search/threads` contract, before a stream key
was returned. The adapter’s unit tests pass for the documented payload and mocked
success/error paths, so this observation is classified as upstream contract or
service degradation, not an OmniRoute credential failure.

## Runtime auto/chat validation

The server reached HTTP 200 on `20128` and produced correlated Governor telemetry.
The additional serialized series used `model=auto/chat`, `stream=true`,
`max_tokens=4`, and unique short prompts.

```text
additional auto/chat: 10/10 HTTP 200
complete SSE: 10/10
Governor mode in telemetry: simulate
Native provider: openrouter (10/10)
Native model: qwen/qwen3.8-27b (10/10)
client latency: min 4638ms, mean 5984ms, p50 5811ms, max 9214ms
usage: 4 output tokens per request; 75–76 prompt tokens
```

The upstream OpenRouter backend label varied across responses, but the OmniRoute
provider remained `openrouter`. All ten correlated Governor plans selected
`opencode/big-pickle`, resolved tier `low`, had `estimatedCounterfactualCost=0`,
`costEstimateBasis=PRE_REQUEST_BUDGET`, `confidence=MEDIUM`, `executable=true`,
and `unresolvedFields=[]`. All seven guardrails were `YES` in those plans.

The relevant correlation IDs were:

```text
aecb10d2-e02d-4eb9-9e07-3634005e427a
dbc5c734-af46-49e1-8dd6-6eae3d1f9cca
2fea38a8-5dea-411c-a546-60a4392b5a3a
5807d0b6-8206-4bbb-98ce-fdfc1148844e
e3a2798f-2274-49ff-8290-9e5ed8dcf8ea
cdb359a5-f14c-44cf-8cf9-bc846a680b67
ed958194-974c-4d87-831b-81b44b63fbf7
a4d765af-8cbc-403b-abef-bc85d117a5e9
ee3937af-99d3-426c-b4ff-563da880949b
0720b2bc-5235-404b-bd02-64fa6ea7b89e
```

Because the active canary rate was zero and active mode was disabled:

```text
activeEligible: false
activeSelected: false
activeApplied: false
liveActiveControl: false
```

No route was changed by the Governor.

## Shadow validation

The prior five-pair pilot remains the only valid comparison in this investigation:

```text
Native: 5/5 successful
Governor direct: 0/5; 5 × HTTP 429 from OpenCode
```

The pilot was stopped at five pairs because the Governor arm was targeting a degraded
no-auth provider and the pool was not stable. It was not expanded to ten or twenty
pairs. The new auto/chat series was a reliability check, not a new Native-vs-Governor
direct benchmark.

## Tests and gates

Focused isolated tests:

```text
Governor focused suite: 30 passed, 0 failed
No-auth/fallback/Felo focused suite: 108 passed, 0 failed
```

The isolated test run included the no-auth lockout propagation tests, Felo executor
tests, account fallback service tests, OpenCode no-auth credential tests, and Governor
pricing/counterfactual/runtime tests. A direct run without the official isolated test
database had one false environmental failure because the persistent local feature-flag
override forced `simulate`; the isolated rerun passed `30/30`.

No production source file was modified. No benchmark script or temporary diagnostic
file was left in the repository.

## Decision

```text
Governor eligibility propagation: no confirmed bug
No-auth health propagation: existing path passes focused tests
Governor scoring bias: no fabricated-cost bug; known-free zero is intentional
Native vs Governor direct result: Native remains better under the observed degraded pool
Canary rate: 0
Canary activated: NO
```

Do not advance to `GOVERNOR_ACTIVE_CANARY_RATE=1` yet. The next exact action, before
any larger benchmark, is a same-process integration reproduction that holds a shared
no-auth model lock active while constructing the Auto Combo and Governor plan; only a
failure in that test should authorize a generic shared-eligibility code change.

## Final status

`D — NATIVE_STILL_BETTER`

`COMPUTER: LEFT ON — NO SHUTDOWN/RESTART EXECUTED`
