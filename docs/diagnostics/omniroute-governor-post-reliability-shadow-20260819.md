# Governor Post-Reliability Shadow Validation

## Starting state

- Branch: `feature/s3-intelligence-governor-prework-20260810`
- HEAD at validation start: `2adbc8f5bfd8b09d4ab21af5c0b2718f1acc6077`
- Governor: `simulate / active=false / canary=0`
- Telemetry: enabled, sample rate `1`
- Origin: `origin`
- No S3 code, production scoring, routing policy, credentials, persistent environment
  configuration, or canary control was changed.

The official server was started with the required process-local controls, listened on
`127.0.0.1:20128` (with 20131 and 20132 also listening), passed HTTP 200 health/readiness,
and was stopped gracefully after the runtime validation. Windows was not restarted or
shut down.

## Previous result

The historical pre-fix pilot was Native `5/5` versus Governor Direct `0/5`; Governor
selected `opencode/big-pickle`. That result is excluded from the current comparison
because it predates the published reliability/ranking correction.

## Reliability fix verification

The frozen snapshot immediately before the authoritative shadow round showed:

| Candidate                     | Recent outcomes | Reliability observed | Failure rate |         Health | Cooldown/lockout |
| ----------------------------- | --------------: | -------------------- | -----------: | -------------: | ---------------- |
| `openrouter/qwen/qwen3.8-27b` |   27/31 success | true                 |       0.1290 |         0.8710 | none/none        |
| `opencode/big-pickle`         |     0/4 success | true                 |       1.0000 |         0.0000 | none/none        |
| `felo-web/felo-chat`          |     0/2 success | false                |      unknown | 0.5000 neutral | none/none        |

All provider breakers and lockouts were clear at the freeze. The Governor selected Qwen
for all three plan-smoke requests and all ten authoritative shadow plans. This confirms
that the observed recent failure signal and degraded-tier ranking path are active in the
runtime; the old failed OpenCode candidate did not regain preference through the old
synthetic health default.

## Functional pool

The dynamic virtual pool was rebuilt from the running project and contained `531`
routable candidates:

| Provider   | Candidates |
| ---------- | ---------: |
| NVIDIA     |        102 |
| Gemini     |          5 |
| OpenRouter |        413 |
| OpenCode   |          6 |
| Felo       |          5 |
| Total      |        531 |

At the freeze, `raw=531`, `active=531`, and `eligible=531`; all five provider breakers
were closed and there were no lockouts. “Healthy” is not a static pool field: the
selected-plan health evidence was Qwen `0.871`, OpenCode `0.0`, and Felo neutral `0.5`.
The executable gate was `3/3` in plan smoke and `10/10` after immediate revalidation in
the authoritative shadow round.

## Plan smoke

Three serialized `auto/chat` smoke requests were correlated to persisted Governor rows.
Each response was HTTP 200 with a completed SSE stream.

| Smoke | Native terminal route         | Governor selection            | Executable | Confidence | Unresolved       |
| ----: | ----------------------------- | ----------------------------- | ---------- | ---------- | ---------------- |
|     1 | `openrouter/qwen/qwen3.8-27b` | `openrouter/qwen/qwen3.8-27b` | true       | MEDIUM     | `pricingOrUsage` |
|     2 | `openrouter/qwen/qwen3.8-27b` | `openrouter/qwen/qwen3.8-27b` | true       | MEDIUM     | `pricingOrUsage` |
|     3 | `openrouter/qwen/qwen3.8-27b` | `openrouter/qwen/qwen3.8-27b` | true       | MEDIUM     | `pricingOrUsage` |

All seven guardrails were `YES` in the three plans:
`CAPABILITY_COMPATIBLE`, `CONTEXT_FITS`, `PROVIDER_AVAILABLE`, `QUOTA_ACCEPTABLE`,
`REASONING_SUPPORTED`, `COMPRESSION_SUPPORTED`, and `USER_MAX_OUTPUT_RESPECTED`.

## Shadow methodology

The first five-pair attempt from before the harness correction is invalid and excluded:
server evidence showed semantic-cache hits in the direct arm. A second five-pair
verification run after the cache correction reached upstream, but its terminal JSON was
truncated by the tool session and is also excluded from the metrics. The diagnostic
harness was then kept unchanged for the authoritative round: it sends
`X-OmniRoute-No-Cache: true`, exposes cache status, performs a health/lockout/circuit
revalidation immediately before direct dispatch, and uses the expected-token/JSON-schema
quality checks. No production scoring or Governor policy was changed after the correction.

This means 20 pair operations occurred physically during the investigation, while only
the final 10-pair round below is treated as authoritative evidence. The two excluded
five-pair batches contribute no success, quality, latency, or choice metrics.

The authoritative round is valid:

- 10 total pairs, in the required alternating order.
- Same input per Native/Governor pair.
- Separate request/correlation IDs for Native, Governor plan, and Governor Direct.
- Governor Direct used the selected explicit target with no fallback.
- All 10 direct responses reported cache `MISS`; the Native/Governor arms reached the
  upstream runtime and did not use the invalidated semantic-cache result.
- All 10 Governor plans were correlated, executable, and revalidated as healthy.

## Pair results

All responses below were HTTP 200 with completed SSE streams. Both arms chose
`openrouter/qwen/qwen3.8-27b`; Native had no fallback and Governor Direct had one direct
attempt. Quality is the deterministic harness check, not an LLM judge.

| Pair | Category                          | Native quality / latency | Governor quality / latency | Pairwise |
| ---: | --------------------------------- | -----------------------: | -------------------------: | -------- |
|    1 | factual                           |         fail / 14,172 ms |            fail / 2,298 ms | tie      |
|    2 | instruction following             |          fail / 3,249 ms |            fail / 1,531 ms | tie      |
|    3 | JSON structured                   |          fail / 3,495 ms |            fail / 2,087 ms | tie      |
|    4 | deterministic reasoning           |          fail / 4,123 ms |            fail / 1,003 ms | tie      |
|    5 | simple code                       |          fail / 4,776 ms |            fail / 1,978 ms | tie      |
|    6 | Portuguese structured instruction |          fail / 3,192 ms |            fail / 2,308 ms | tie      |
|    7 | English structured instruction    |          fail / 4,528 ms |            fail / 1,894 ms | tie      |
|    8 | simple transformation             |          fail / 4,797 ms |            pass / 1,818 ms | Governor |
|    9 | short reasoning                   |          fail / 3,951 ms |            fail / 1,920 ms | tie      |
|   10 | small coding/data task            |          fail / 4,063 ms |            fail / 2,118 ms | tie      |

## Aggregate Native

- Requests: `10`
- Success: `10/10`
- Quality: `0/10`
- First-choice/fallback: `1.0` attempt mean, `1` maximum, `0` fallback recoveries
- Latency: min `3,192 ms`, mean `5,035 ms`, p50 `4,063 ms`, p95 `4,797 ms`, max
  `14,172 ms`
- Provider/model distribution: Qwen `10/10`

## Aggregate Governor

- Plans: `10/10` correlated
- Executable plans: `10/10`
- Revalidated direct targets: `10/10`
- Direct success: `10/10`
- Quality: `1/10`
- Latency: min `1,003 ms`, mean `1,896 ms`, p50 `1,920 ms`, p95 `2,298 ms`, max
  `2,308 ms`
- Provider/model distribution: Qwen `10/10`
- Top-target concentration: `10/10 = 100%` of valid plans

## Choice agreement

Native and Governor selected the same provider/model in `10/10` pairs (`100%`). This is
consistent with the corrected Governor converging on the currently healthy Qwen target;
it is not evidence that the Governor is universally superior.

## Errors

| Arm             | 429 | 400 | 404 | 5xx | Timeout |
| --------------- | --: | --: | --: | --: | ------: |
| Native          |   0 |   0 |   0 |   0 |       0 |
| Governor Direct |   0 |   0 |   0 |   0 |       0 |

The runtime health gate was healthy before the shadow. After the round, the background
credential-health tester recorded one NVIDIA `504` timeout; no shadow arm targeted NVIDIA,
all provider breakers remained `CLOSED`, and this did not contaminate the pair results.
It remains an operational readiness risk.

## Pricing

- Resolved: **NO** for the selected Qwen model.
- Governor plans retained `estimatedCurrentCost=null`,
  `estimatedCounterfactualCost=null`, `costEstimateBasis=null`,
  `estimatedSavings=null`, and `unresolvedFields=["pricingOrUsage"]`.
- Cost conclusion: **INCOMPLETE**. No cost advantage or free classification is inferred.

## Efficiency conclusion

For this bounded workload and frozen pool, the Governor is directionally better: success
was equal at `10/10`, quality was not lower (`1/10` versus `0/10`), and direct latency was
lower (mean `1,896 ms` versus `5,035 ms`) with no direct fallback or error. The quality
margin is small and both arms converged on the same target, so this is not a universal
quality claim and is not a cost-efficiency result.

## Canary

`0 — NOT ACTIVATED`.

`GOVERNOR_ACTIVE_ENABLED=false` and `GOVERNOR_ACTIVE_CANARY_RATE=0` were preserved for
the entire validation. No route was changed by the Governor.

## Canary readiness

**NOT_READY** for a separate canary decision. The reliability/success shadow passed, but
Qwen cost remains unresolved and the post-run NVIDIA credential-health timeout needs an
operational review first.

## Code changes

No production code was changed. The tracked diagnostic harness
`scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs` was updated to:

- support the 10-case workload and `--start` offset;
- bypass semantic-cache contamination for the shadow;
- revalidate health, breaker, and lockout state before direct dispatch;
- record deterministic quality, cache, and target-validity evidence;
- allow executable plans with unresolved pricing, as required by the task.

## Tests and checks

- `node --check scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs`: passed.
- Authoritative shadow: 10/10 Native and 10/10 Governor Direct completed.
- Governor plan correlation: 10/10.
- Governor executable/revalidated: 10/10.
- Prior validation retained: Governor focused tests `59/59`, combo reliability/telemetry
  `11/11`, core typecheck passed, and `git diff --check` passed.
- No secret values, authorization headers, cookies, database files, or environment files
  were added to the repository.

## Exact next action

Keep the Governor in `simulate / false / 0`. Perform a separate read-only canary-readiness
review for Qwen pricing evidence and the NVIDIA credential-health timeout. Do not activate
canary or claim cost efficiency until pricing is resolved and the health issue is
understood.
