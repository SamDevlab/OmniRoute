# Governor Ranking + Reliability Recovery

## Starting state

- HEAD before this work: `fed8890e7c48f84f602c6e80cff18beefeaa5417`
- Branch: `feature/s3-intelligence-governor-prework-20260810`
- Governor: `simulate / active=false / canary=0`
- Telemetry: enabled, sample rate `1`
- Previous Native-vs-Governor pilot: Native `5/5`; Governor Direct `0/5`
- Previous Governor target: `opencode/big-pickle`

No S3 code, routing policy, credentials, persistent `.env`, or canary control was changed.
The computer was left on; no Windows restart or shutdown was executed.

## Ranking pipeline

The relevant path is:

```text
createVirtualAutoCombo
  -> buildAutoCandidates
  -> buildCounterfactualCandidates
  -> resolveGovernorPricingEvidence / capabilities
  -> resolveCounterfactualPlan
  -> Governor telemetry
```

`buildAutoCandidates()` reads the rolling `usage_history` model statistics through
`getModelLatencyStats()` and constructs the routable candidate data. The historical
window is 24 hours. The prior native Auto Combo score has weighted factors, but the
Governor counterfactual did not use that weighted score: it first filtered by hard
eligibility and the recommended tier, then selected the highest `healthScore` in that
tier. Confidence and cost were plan metadata/estimates, not an independent score
contribution.

## Features

| Feature                  | Source                                               | Range/default                     | Governor use                                                | Recency/persistence             |
| ------------------------ | ---------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| Candidate availability   | Current virtual Auto Combo pool                      | boolean; unavailable is excluded  | hard guardrail                                              | current request                 |
| Capability compatibility | Resolved model capabilities + required capabilities  | YES/NO/UNKNOWN                    | hard guardrail                                              | current catalog/request         |
| Context fit              | Candidate context window and estimated prompt tokens | YES/NO/UNKNOWN                    | hard guardrail                                              | current catalog/request         |
| Provider/quota           | Connection and quota state                           | YES/NO/UNKNOWN                    | hard rejection only for NO                                  | current runtime                 |
| Tier                     | Factual pricing/model classification                 | low/medium/high/highest/preserve  | preferred tier, then distance tie-break                     | current catalog                 |
| Cost                     | Explicit price or known-free zero                    | numeric or null                   | cost estimate only; null remains unresolved                 | request budget + catalog        |
| Reliability              | Persisted `success` outcomes from `usage_history`    | failure rate 0..1                 | health rank after this fix                                  | rolling 24h; minimum 3 outcomes |
| Health                   | `1 - observed failureRate`, otherwise neutral        | 0..1; missing is 0.5              | primary ranking signal when preferred tier is degraded      | request-built candidate         |
| Confidence               | Governor plan evidence completeness                  | LOW/MEDIUM/HIGH                   | metadata, not ranking                                       | current plan                    |
| Latency                  | Historical p95/stddev                                | positive ms or bootstrap fallback | native Auto Combo only; not Governor counterfactual ranking | rolling 24h                     |

The native Auto Combo weights remain unchanged. They are quota `.15`, health `.20`,
cost inverse `.15`, latency inverse `.12`, task fit `.08`, stability `.05`, tier
priority `.05`, tier affinity `.05`, specificity `.05`, context `.05`, and connection
density `.05`; cache/reset are currently zero-weight. Those weights explain native
Auto Combo behavior, not the Governor counterfactual selection.

## Previous winning candidate

Before the fix, `opencode/big-pickle` won because it was a known-free `low` tier
candidate and the Governor selected only candidates in the recommended low tier.
Its 4 recent failures were below the existing native-history threshold of 10, so
`buildAutoCandidates()` supplied the synthetic `errorRate=0.05`; Governor health
therefore looked like `0.95` instead of reflecting the observed failures. The healthy
Qwen candidate was `high/preserve` and was not in the exact low-tier ranking set.

## Score breakdown

There is no Governor weighted score or persisted per-feature contribution object to
report. The actual pre-fix selection was a deterministic tier filter followed by
`healthScore` descending, not a cost/latency/quality weighted sum. The equivalent
numeric decomposition is therefore:

| Candidate                     | Tier before fix |                   Observed outcomes | Governor health before fix | Result before fix                 |
| ----------------------------- | --------------- | ----------------------------------: | -------------------------: | --------------------------------- |
| `opencode/big-pickle`         | low             |                         0/4 success |             0.95 synthetic | selected                          |
| `openrouter/qwen/qwen3.8-27b` | preserve/high   | 22/22 success in the prior snapshot |                       1.00 | excluded by exact low-tier filter |

After the fix, the same generic candidate fields are:

| Candidate                     | Observed outcomes in current 24h window | `reliabilityObserved` | `failureRate` | Governor health |
| ----------------------------- | --------------------------------------: | --------------------- | ------------: | --------------: |
| `opencode/big-pickle`         |                             0/4 success | true                  |          1.00 |            0.00 |
| `openrouter/qwen/qwen3.8-27b` |                           26/30 success | true                  |        0.1333 |          0.8667 |

When every candidate in the preferred tier is degraded below `0.8`, the Governor
now ranks the full suitable set by health, then tier distance, then stable original
order. A healthy candidate in the preferred tier still wins; no provider or model
name is special-cased.

## Cost analysis

`cost=0` is used only for a factual known-free classification. Unknown pricing stays
`null`; it is not converted into zero. The previous OpenCode counterfactual had a real
known-free zero price. The current Qwen candidate has no explicit price in the current
pricing evidence, so its runtime plan correctly reports unknown cost rather than
claiming it is free.

PRE_REQUEST_BUDGET means the Governor estimated cost using the request's estimated
input tokens and the requested output budget (`max_tokens`/`max_completion_tokens`).
It is a pre-request estimate, not an allowance and not actual post-response billing.

## Missing values

- Unknown pricing: `null`, unresolved as `pricingOrUsage`; never zero.
- Missing reliability history: `reliabilityObserved=false`, Governor health neutral
  at `0.5`; it is not optimistic-best.
- Reliability history below 3 outcomes: treated as unobserved for Governor health.
- Missing context window: `CONTEXT_FITS=UNKNOWN` according to existing guardrail
  semantics; no context window was invented.
- Missing quota/provider status: may remain `UNKNOWN` during planning unless it is
  explicitly `NO`.
- Missing latency: existing native bootstrap/default behavior remains unchanged.

## Recent failure signal

Recent provider/model outcomes are persisted in `usage_history`, including status and
error code. The existing aggregate statistics classify each row as success or failure;
they do not currently provide a separate Governor weight for 429 versus 400, 404, or
5xx. The OpenCode 429 evidence therefore enters this fix as an observed failure rate,
while its short hard lockout remains a separate eligibility mechanism. Client aborts
return before `persistFailureUsage()` and are not counted as provider reliability
failures. The signal decays through the existing 24-hour rolling window and recovers
as subsequent successful rows replace the failure ratio; it is not a permanent
blacklist.

## Reliability signal

The minimum change reuses `getModelLatencyStats()` and its persisted outcome history.
`buildAutoCandidates()` now exposes `failureRate` only when at least three valid
historical outcomes exist and marks the source with `reliabilityObserved`. Governor
candidate health prefers this observed rate over the old synthetic `errorRate`; an
unobserved candidate is neutral. Native Auto Combo's existing `errorRate` behavior is
otherwise preserved.

## Confidence

Confidence remains evidence metadata and is not itself a ranking weight. The previous
`MEDIUM` confidence did not prevent a low-cost candidate from being selected. In the
new runtime plans the selected Qwen candidate was `executable=true`, but confidence
was still `MEDIUM` because pricing/usage evidence was unresolved. This is fail-closed:
the plan does not claim a savings value when current or counterfactual cost is unknown.

## Root cause classification

Confirmed causes:

- RECENT_FAILURE_SIGNAL_MISSING: failures below the native 10-sample history
  threshold were hidden from Governor health by the synthetic `errorRate=0.05`.
- STATIC_PROVIDER_UNCERTAINTY_IGNORED: the exact preferred-tier filter could select
  a low-tier candidate without comparing it to an observed healthy candidate in another
  tier once the preferred candidate degraded.
- MISSING_DATA_OPTIMISTIC_DEFAULT: missing reliability was previously able to fall
  through to an optimistic-looking error default; it is now neutral for Governor.

Not confirmed: fabricated free pricing, provider-specific hardcoding, a lockout
propagation bug, or a cost normalization bug.

## Policy

The invariants are:

1. An ineligible candidate can never become an executable recommendation.
2. A currently eligible candidate with recent observed failures remains available but
   loses ranking preference when a healthier suitable candidate exists.
3. Unknown cost is never treated as known zero.
4. Unknown reliability is neutral, not better than observed healthy reliability.
5. Successful outcomes can recover ranking within the rolling history.
6. No provider/model is blacklisted by name, and the short hard lockout is unchanged.

The implementation keeps the preferred tier when it contains at least one reliable
candidate (`health >= 0.8`). It broadens ranking only when the entire preferred tier is
degraded or absent, using health first and tier distance as a stable generic tie-break.

## Code changes

- `open-sse/services/autoCombo/scoring.ts`: added the provenance marker
  `reliabilityObserved`.
- `open-sse/services/combo.ts`: derives an observed failure rate from the existing
  rolling usage history when at least three outcomes exist; native scoring inputs are
  otherwise preserved.
- `open-sse/governor/autoComboRuntime.ts`: Governor health now consumes observed
  failure rate and treats unobserved reliability neutrally.
- `open-sse/governor/counterfactual.ts`: generic health-aware selection with preferred
  tier preservation, degraded-tier fallback, tier-distance tie-break, and stable order.
- Tests updated in `tests/unit/governor/counterfactual.test.ts`,
  `tests/unit/governor/auto-combo-pricing.test.ts`, and
  `tests/unit/combo-speed-telemetry-6875.test.ts`.

## Tests

- Governor focused suite: `59/59` passed, `0` failed.
- Combo reliability/telemetry focused test: `11/11` passed, `0` failed.
- `npm run typecheck:core`: passed.
- `git diff --check`: passed.
- Full `npm run test:unit`: not completed; unrelated Adobe Firefly route tests
  (`#8510`) failed in the local environment and the long run was interrupted.
- Official `npm run test:vitest`: `326` tests passed in `37` files, but two unrelated
  UI worker-start errors occurred for `useDisplayBaseUrl.test.tsx` and
  `DistributeProxiesButton.test.tsx`; this is not classified as a full-suite pass.
- `npm run check:docs-all`: passed; the gate reported only the repository's existing
  soft count/version drift warnings, while doc links and fabricated-claim checks passed.
- Secret scan: no credential values, authorization headers, cookies, or tokens were
  added to the repository or report.

## Runtime pool

The live pool was rebuilt from the current local runtime state, not from hardcoded
historical choices: 531 routable candidates were observed (NVIDIA 102, Gemini 5,
OpenRouter 413, OpenCode 6, Felo 5). The server listened on `127.0.0.1:20128` and
health returned HTTP 200. The process was started with:

```text
INTELLIGENCE_GOVERNOR_MODE=simulate
INTELLIGENCE_GOVERNOR_TELEMETRY=true
GOVERNOR_ACTIVE_ENABLED=false
GOVERNOR_ACTIVE_CANARY_RATE=0
GOVERNOR_TELEMETRY_SAMPLE_RATE=1
```

Effective controls were verified as `simulate`, telemetry `true`, active `false`,
canary `0`, and sample rate `1`.

## Native 3

Three serial `auto/chat` requests were executed with `stream=true`, `max_tokens=128`,
and short distinct prompts. All client responses were HTTP 200. The terminal routes
and sanitized usage were:

| Request | Terminal provider/model                          | Prompt/output tokens | Client latency | Fallback evidence                         |
| ------: | ------------------------------------------------ | -------------------: | -------------: | ----------------------------------------- |
|       1 | `openrouter/openai/gpt-4o-mini-2024-07-18`       |                22/88 |      53,176 ms | Qwen upstream failures before final route |
|       2 | `nvidia/nvidia/llama-3.1-nemotron-nano-vl-8b-v1` |               33/128 |      19,212 ms | NVIDIA model 404 before final route       |
|       3 | `openrouter/google/gemini-3.1-flash-image`       |                14/14 |      11,644 ms | OpenRouter model 502 before final route   |

These are Native outcomes; Governor remained simulate-only and did not alter routing.

## Governor plan 3

Three Governor telemetry rows were recorded. The request-provided correlation header
was not preserved as the telemetry correlation key; the generated IDs were
`83d6d34e-bde0-40dd-a636-da4b89ea860a`, `0514fd75-6767-4711-9221-e8c73820498c`,
and `2b652033-164e-48b7-aa96-4d9bc420f358`. The rows show the initial runtime
selection before native fallback, while the usage table above shows the terminal route.

All three plans selected `openrouter/qwen/qwen3.8-27b`, with `resolvedModelTier=preserve`,
`estimatedCurrentCost=null`, `estimatedCounterfactualCost=null`,
`costEstimateBasis=null`, `estimatedSavings=null`, `confidence=MEDIUM`,
`executable=true`, and `unresolvedFields=["pricingOrUsage"]`. All seven guardrails
were `YES`. The current recommendation distribution was Qwen `3/3`; OpenCode was
`0/3`. `activeEligible`, `activeSelected`, `activeApplied` were not activated, and
`liveActiveControl=false`.

This is the expected reliability direction: the Governor no longer selected the
recently failed OpenCode model. It does not prove Qwen is free or produce a zero cost;
the missing Qwen pricing remains explicitly unresolved.

## Shadow 5

Not run. The task gate was not reached because the new runtime plan was not a valid
cost-complete counterfactual for a direct comparison, and the Native pool exhibited
multiple live fallback events. The prior valid pilot remains Native `5/5` versus
Governor Direct `0/5`, with Governor OpenCode attempts returning HTTP 429.

## Shadow 10

Not run. No additional direct traffic was sent after the prior `0/5` Governor pilot,
and canary remained disabled.

## Results

Native runtime: `3/3` client HTTP 200, with fallback activity observed in all three
requests. Governor plan selection: Qwen `3/3`, OpenCode `0/3`; direct Governor
success remains the previous `0/5` and was not rerun.

Pairwise Native-vs-Governor results for this run: not applicable; no new direct shadow
pairs were executed. The runtime validates ranking direction, not end-to-end Governor
superiority.

## Efficiency conclusion

The generic reliability correction is directionally effective: observed recent
failures now affect Governor ranking after the hard lockout expires, and successful
history can restore a candidate. Native remains the only arm with a completed current
runtime result; no claim of overall Governor superiority is made.

## Canary

`0 — NOT ACTIVATED`

`GOVERNOR_ACTIVE_ENABLED=false` and `GOVERNOR_ACTIVE_CANARY_RATE=0` were preserved.

## Remaining risks

- Governor still lacks a weighted per-feature score breakdown and status-specific
  reliability weighting; 429, 400, 404, and 5xx currently enter the aggregate failure
  signal alike.
- Correlation headers supplied by the validation client were not the persisted
  Governor correlation IDs, so runtime correlation requires timestamp/order matching.
- Qwen pricing remains unknown in the current catalog, so cost-complete Governor
  comparisons require explicit pricing or a factual free classification.
- The full Vitest suite had two worker-start errors and the full Node unit suite did not
  complete because of unrelated Adobe Firefly test failures.

## Exact next action

Review the remaining catalog/pricing and telemetry-correlation gaps in a separate
read-only validation. Do not activate canary or run a larger direct benchmark until
the Governor plan is cost-complete and the worker/environment failures are resolved.
