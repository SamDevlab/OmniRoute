# OmniRoute Governor Simulate Benchmark

## Final status

`A - COMPLETE`

The Governor mode was changed through the official feature-flag API from
`off` to `simulate`. The live process hydrated the DB override without a
restart. Active control remained disabled and the canary rate remained zero.
The existing baseline contributes 20 classified requests and this run adds 20
classified simulate requests. All 20 simulate records show a counterfactual
divergence, while the executed route remained the native route or its native
fallback path.

Validation date: 2026-08-14

## Starting state

- Repository: `C:\Users\in9midia\Downloads\OmniRoute-S3`.
- Starting HEAD: `1fb518a53c063727b5f7b103028442c61f8e26b3`.
- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- Starting HEAD matched upstream and the working tree was clean.
- Existing server PID `2740` remained running; no `npm run dev`, process
  restart, Windows restart, or shutdown was performed.
- Health before and after: HTTP 200, `healthy`, three active connections.
- Official local login was used with an in-memory session cookie. No cookie,
  password, token, or authorization header was printed or persisted.

Previously validated evidence was reused without repeating the baseline:

- OpenRouter native: 1/1 PASS.
- NVIDIA native: 1/1 PASS.
- Gemini native: 5/5 PASS.
- Auto-Combo: five candidates, dedupe PASS, cross-connection isolation PASS.
- Auto/chat: 5/5 PASS and 10/10 PASS.
- Baseline: 20/20 SUCCESS, from the prior published report.

The simulate harness used the same request shape as the baseline: serial
`POST /api/v1/chat/completions`, `model=auto/chat`, streaming enabled,
`stream_options.include_usage=true`, `max_tokens=16`, a short indexed prompt,
the official authenticated session, and a 120-second request timeout.

## Governor reconciliation

### Previous effective state

The live feature-flag endpoint reported:

```text
INTELLIGENCE_GOVERNOR_MODE=off, source=default
INTELLIGENCE_GOVERNOR_TELEMETRY=true, source=default
```

The source precedence is:

```text
DB override > process.env > feature-flag default
```

There was no Governor mode key in either `server.env` file or the repository
`.env`, and no DB override existed. The code default for the mode is `off`.

### Official change

The authenticated `PUT /api/settings/feature-flags` endpoint was called with
only:

```json
{ "key": "INTELLIGENCE_GOVERNOR_MODE", "value": "simulate" }
```

The API returned HTTP 200, `source=db`, `requiresRestart=false`, and the live
feature-flag read immediately returned `simulate`. No other setting was
written. `GOVERNOR_ACTIVE_ENABLED` remained `false` and
`GOVERNOR_ACTIVE_CANARY_RATE` remained `0`; neither was changed, even
temporarily.

### Effective runtime

```text
Mode: simulate
Active: false
Canary: 0
Telemetry: true
```

The live Governor telemetry rows confirmed `governorMode=simulate`. Every
counterfactual plan also reported `liveActiveControl=false`.

No process restart was required or performed.

## Simulate safety proof

Three short authenticated proof requests were executed before the 20-request
run. All three completed with HTTP 200 and complete SSE streams.

| Request | Native/executed route                 | Governor simulated route | Result                |
| ------: | ------------------------------------- | ------------------------ | --------------------- |
|       1 | `openrouter/liquid/lfm-2.5-2.6b:free` | `opencode/big-pickle`    | Native route executed |
|       2 | `openrouter/liquid/lfm-2.5-2.6b:free` | `opencode/big-pickle`    | Native route executed |
|       3 | `openrouter/liquid/lfm-2.5-2.6b:free` | `opencode/big-pickle`    | Native route executed |

The three plans had `confidence=MEDIUM`, `executable=true`, no unresolved
fields, all listed guardrails `YES`, counterfactual cost `0` using the
pre-request budget basis, and `liveActiveControl=false`.

Safety proof: **PASS**. Execution influence detected: **NO**.

## Baseline

The following values are reused from the published 20-request baseline and
were not rerun:

- N: `20`.
- Success: `20`.
- Failure: `0`.
- Timeout: `0`.
- 429: `0`.
- Success rate: `100%`.
- Latency: min `2371 ms`, mean `4777 ms`, p50 `3240 ms`, p95 `10240 ms`, max
  `10412 ms`.
- Attempts: mean/p50/p95/max `1/1/1/1`.
- Fallback depth: mean/max `0/0`.
- Provider distribution: OpenRouter `20`.
- Model distribution: `liquid/lfm-2.5-2.6b:free` `20`.

## Simulate

Twenty requests were executed serially and persisted after each request to the
external sanitized JSONL artifact:

`C:\Users\in9midia\Downloads\OmniRoute-S3-reports\governor-simulate-benchmark-20260814\requests.jsonl`

### Request-level classification

- N: `20`.
- Success: `16`.
- Failure: `0`.
- Timeout: `4`.
- 429: `0` as final request outcome.
- Other: `0`.
- Success rate: `80%`.

The four timeout classifications preserve the actual `TimeoutError` observed
by the streaming harness. They were not retried or converted into successes.

### Metrics

- Latency: min `1824 ms`, mean `31418 ms`, p50 `2573 ms`, p95 `120013 ms`, max
  `120014 ms`.
- Attempts: mean `3.25`, p50 `1`, p95 `10`, max `11`.
- Fallback depth: mean `2.25`, max `10`.
- Final provider distribution: OpenRouter `19`, Gemini `1`.
- Final model distribution:
  - `liquid/lfm-2.5-2.6b:free`: `15`.
  - `gemini-3-flash-preview`: `1`.
  - `nvidia/nemotron-nano-9b-v2:free`: `1`.
  - `cohere/north-mini-code:free`: `1`.
  - `nvidia/nemotron-nano-12b-v2-vl:free`: `2`.

### Counterfactual divergence

- Divergence count: `20/20`.
- Divergence rate: `100%`.
- Governor simulated choice: `opencode/big-pickle` for all 20 plans.
- The simulated choice was never dispatched.

The dominant mapping was:

```text
native openrouter/liquid/lfm-2.5-2.6b:free
  -> simulated opencode/big-pickle
  -> executed openrouter/liquid/lfm-2.5-2.6b:free
```

This occurred for 15 requests. The remaining five requests followed native
fallback paths after upstream 429/503/404 or timeout events; none executed the
Governor's `opencode/big-pickle` counterfactual.

### Fallback observations

Requests 1-15 completed normally on the OpenRouter free model. Request 16
encountered an OpenRouter 429/503 sequence and then completed through Gemini
after ten native attempts. Requests 17-20 recorded final request timeouts after
native fallback attempts; the attempt logs include upstream 429, 503, 404
model-not-found, and client-abort/timeout statuses. The provider breaker stayed
`CLOSED`, connection cooldowns were zero after completion, and no active model
lockout remained in the runtime health endpoints.

These are real native fallback/provider reliability outcomes, not Governor
execution. The simulate benchmark intentionally preserves them rather than
rerunning failed requests.

## Comparison

| Metric                    | Baseline |  Simulate |
| ------------------------- | -------: | --------: |
| Classified                |       20 |        20 |
| Success                   |       20 |        16 |
| Timeout                   |        0 |         4 |
| Success rate              |     100% |       80% |
| Latency mean              |  4777 ms |  31418 ms |
| Latency p50               |  3240 ms |   2573 ms |
| Latency p95               | 10240 ms | 120013 ms |
| Latency max               | 10412 ms | 120014 ms |
| Attempts mean             |     1.00 |      3.25 |
| Attempts p95              |        1 |        10 |
| Attempts max              |        1 |        11 |
| Fallback depth mean       |     0.00 |      2.25 |
| Fallback depth max        |        0 |        10 |
| Counterfactual divergence |      n/a |     20/20 |

The performance difference is not interpreted as a causal Governor gain or
regression: simulate did not control execution. The observed difference is
consistent with native provider/fallback state during the later requests.

## Benchmark gate

- Baseline 20/20 classified: **YES**.
- Simulate 20/20 classified: **YES** (`16 SUCCESS`, `4 TIMEOUT`).
- Total 40 classified: **YES**.
- Governor during simulate: `simulate / false / 0`.
- No execution influence: **YES**.
- Benchmark 20+20: **COMPLETE**.

## Tests

- Official settings API: PASS, mode changed and read back as `simulate` with no
  restart required.
- Runtime telemetry: PASS, three proof rows and 20 simulate rows reported
  `governorMode=simulate`.
- Safety invariant: PASS, simulated route was not executed.
- `git diff --check`: PASS.
- Documentation checks: PASS; existing soft drift warnings only.
- No full code-test suite was rerun because no production code or tests changed.

## Code changes

No production code, tests, credentials, environment files, database files,
WAL/SHM files, or routing policy code were changed. The only repository change
is this sanitized diagnostic report.

## Remaining blockers

The Governor simulate benchmark is complete. A separate reliability issue was
observed under native fallback pressure: four late requests timed out after
multiple upstream 429/503/404 outcomes. This does not invalidate the simulate
safety proof, but it should be investigated as a separate fallback/provider
reliability task before any active rollout.

## Exact next action

Keep `INTELLIGENCE_GOVERNOR_MODE=simulate`, `Active=false`, and
`GOVERNOR_ACTIVE_CANARY_RATE=0` until the fallback reliability issue is
reviewed. Do not enable active control or canary as part of this benchmark.
