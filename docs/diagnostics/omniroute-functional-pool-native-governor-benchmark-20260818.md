# OmniRoute Functional Pool — Native vs Governor Validation (2026-08-18)

## Scope and safety

This validation used the local OmniRoute server at `http://127.0.0.1:20128` and
the native `/api/v1/chat/completions` path. No S3 configuration, routing policy,
credential, API key, or persistent `.env` value was changed. NVIDIA was treated as
an ordinary discovered provider, not as a global gate. No benchmark used a fixed
provider/model, and no active route decision was enabled.

Governor controls for the server process were:

```text
INTELLIGENCE_GOVERNOR_MODE=simulate
INTELLIGENCE_GOVERNOR_TELEMETRY=true
GOVERNOR_ACTIVE_ENABLED=false
GOVERNOR_ACTIVE_CANARY_RATE=0
GOVERNOR_TELEMETRY_SAMPLE_RATE=1
```

The computer was left on. No shutdown or restart was executed.

## Git and runtime

```text
branch: feature/s3-intelligence-governor-prework-20260810
HEAD: 3f7ece5fd17aba2619c684b3f958ea5b4f75ce3e
origin branch: same HEAD before this report
server: listening on 0.0.0.0:20128
health: HTTP 200 / healthy
activeConnections: 3
credentialHealth: total=3, healthy=3, failed=0
provider breakers: all CLOSED
lockouts: []
admission rejects: 0
```

The server was started with `npm run dev` and was stopped gracefully after the
validation. Ports `20128`, `20131`, and `20132` were checked after shutdown.

## Discovery and functional pool

Native discovery with `refresh=true` produced the following safe metadata:

| Provider   | Discovery result | Models | Notes                                                                |
| ---------- | ---------------: | -----: | -------------------------------------------------------------------- |
| NVIDIA     |   HTTP 200 / API |    102 | Live catalog available; not used as a gate                           |
| OpenRouter |   HTTP 200 / API |    423 | Live catalog available                                               |
| Gemini     | HTTP 200 / cache |      5 | Upstream discovery returned invalid-key 400; cached catalog retained |

The synchronized catalog subsequently contained 102 NVIDIA, 413 OpenRouter, and
5 Gemini models. The dynamic no-auth registry pool contained 11 candidates:
6 `opencode` models and 5 `felo-web` models. The server's runtime auto combo also
materialized the credentialed/synchronized candidates; the runtime log reported
531 auto targets. No model was inserted or hardcoded by this validation.

Direct candidate probes were serialized and short:

| Dynamic candidate |   Result | Classification                                          |
| ----------------- | -------: | ------------------------------------------------------- |
| `oc/big-pickle`   | HTTP 429 | OpenCode upstream rate limit; native model lockout only |
| `felo/felo-chat`  | HTTP 400 | Felo upstream request rejection                         |

These failures did not open a provider breaker or make the runtime unhealthy.

## Auto/chat validation

The formal auto/chat series was cumulative: 3 requests, then 2 more to reach 5,
then 5 more to reach 10. Each request was streaming, serialized, used a short
synthetic prompt, and set `max_tokens=16`.

```text
3/3: HTTP 200, complete SSE, no 429/404/503/504/timeout
5/5 cumulative: HTTP 200, complete SSE
10/10 cumulative: HTTP 200, complete SSE
actual provider: openrouter (10/10)
actual model: qwen/qwen3.8-27b (10/10)
latency: min 3439 ms, mean 6288 ms, p50 6134 ms, p95 8052 ms, max 10015 ms
usage per request: 60 prompt tokens, 16 output tokens, 76 total tokens
fallback attempts: 0 on the successful OpenRouter first choice observations
```

The one initial correlation smoke request also completed with HTTP 200; it is not
included in the 10-request aggregate above.

## Governor telemetry

All 10 auto/chat requests produced correlated Governor telemetry. The response
`X-Correlation-Id` was present and matched the persisted telemetry row used for
the plan lookup; each shadow pair also kept distinct native, planning, and direct
execution correlation IDs.

The auto/chat Governor plans consistently contained the following representative
shape:

```text
governorMode: simulate
selectedProvider: opencode
selectedModel: hy3-free (varied among the dynamic free pool)
resolvedModelTier: low
routingStrategy: cost_optimized
estimatedCurrentCost: null
estimatedCounterfactualCost: 0
costEstimateBasis: PRE_REQUEST_BUDGET
estimatedSavings: null
confidence: MEDIUM
executable: true
unresolvedFields: []
CAPABILITY_COMPATIBLE: YES
CONTEXT_FITS: YES
PROVIDER_AVAILABLE: YES
QUOTA_ACCEPTABLE: YES
REASONING_SUPPORTED: YES
COMPRESSION_SUPPORTED: YES
USER_MAX_OUTPUT_RESPECTED: YES
activeEligible: false
activeSelected: false
activeApplied: false
liveActiveControl: false
```

The actual Native result remained OpenRouter. This is the expected separation:
the Governor recommendation is counterfactual in `simulate`, while Native routing
and its fallback path remain authoritative for the delivered response.

## Native vs Governor Shadow

Because auto/chat was 10/10 successful and telemetry was correlated, a five-pair
pilot was run with the required alternating order:

```text
Pair 1 Native → Governor
Pair 2 Governor → Native
Pair 3 Native → Governor
Pair 4 Governor → Native
Pair 5 Native → Governor
```

For every Governor arm, the plan was read in `simulate`, required
`executable=true`, and its selected target was then executed explicitly. No direct
Governor response was delivered as a real user response.

| Arm                | Success |       Errors | Latency min / mean / p50 / p95 / max  |
| ------------------ | ------: | -----------: | ------------------------------------- |
| Native `auto/chat` |     5/5 |            0 | 3687 / 8585 / 9669 / 11808 / 12867 ms |
| Governor direct    |     0/5 | 5 × HTTP 429 | 5509 / 5598 / 5601 / 5623 / 5735 ms   |

Governor planning was correlated and executable in 5/5 pairs. It selected
`opencode/big-pickle` or `opencode/deepseek-v4-flash-free`; each direct execution
then received the same upstream OpenCode 429 behavior. Native routed to
OpenRouter and completed all five requests. The objective exact-token quality check
did not pass in either arm, so no quality advantage is claimed; reliability favored
Native 5–0. The pool was not stable after the no-auth degradation, so the shadow
run was intentionally stopped at five pairs rather than expanded to ten or twenty.

## Interpretation

The Intelligence Governor correction is operationally visible: candidate, tier,
context, cost basis, and all guardrails resolve without `INSUFFICIENT_DATA`; the
free counterfactual cost is represented as known zero rather than unknown pricing.
The runtime and fallback path remain available when a Governor-recommended no-auth
target fails after planning. The observed 429/400 results are provider/model-level
degradation, not evidence of a Governor policy, breaker, correlation, or timeout
architecture regression.

No production-code change was justified by this run. The only deliverable change
is this diagnostic report.

## Validation commands

```text
native discovery: GET /api/providers/{id}/models?refresh=true (in-process native handler)
health: curl.exe -sS http://127.0.0.1:20128/api/monitoring/health
auto/chat: streaming POST /api/v1/chat/completions, model=auto/chat, max_tokens=16
shadow: scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs --pairs=5
```

## Final status

`E — PROVIDER_DEGRADATION_HANDLED`

The functional auto path and Governor telemetry were validated; a localized
OpenCode/Felo degradation was observed and native fallback handled it without
activating the Governor.

`COMPUTER: LEFT ON — NO SHUTDOWN/RESTART EXECUTED`
