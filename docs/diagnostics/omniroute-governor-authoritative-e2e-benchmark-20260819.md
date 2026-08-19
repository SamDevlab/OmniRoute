# OmniRoute Governor Authoritative E2E Benchmark

## Starting State

- HEAD: `8652d81b88cad9ddd91728a4b355db370e3f8b1f`
- Branch: `feature/s3-intelligence-governor-prework-20260810`
- Origin: `SamDevlab/OmniRoute`
- Governor: `simulate / false / 0`
- Canary: `0`

The local server was started with transient process settings only. No `.env`, `server.env`,
`DATA_DIR`, encryption key, credential, or production file was changed. The server health route
returned HTTP 200/healthy and ports 20128, 20131, and 20132 were listening. Runtime status was
confirmed as simulation mode, active disabled, canary zero, telemetry enabled, and sample rate one.

## Calibration Basis

The previous authoritative calibration passed: Native `3/3`, Governor `3/3`. The earlier `2/3`
Governor result remains classified as a model-quality difference and was not reopened. The earlier
ten-pair result remains preliminary and non-authoritative and was not reused.

## Methodology Freeze

- Workload frozen before requests: yes
- Validators frozen before requests: yes
- Governor scoring/ranking/policy frozen: yes
- Production code changes: none
- Arm contract: same prompt, stream mode, temperature zero, `max_tokens=128`, no system prompt,
  tools, or response format, same timeout, and same deterministic validator
- Order: Native → Governor for odd pairs; Governor → Native for even pairs
- Latency threshold: 15% of total E2E, only when both arms succeed, complete SSE, and pass quality
- No LLM judge or subjective scoring was used

The harness performed ten fixed Native target preflights before Pair 1 so Governor-first pairs had
the factual current Native target without adding a request between Governor planning and execution.
Those ten setup requests are reported separately and excluded from authoritative pair accounting.

## Pool Freeze

- Snapshot: `2026-08-19T17:48:59.868Z`
- Raw: `531`
- Active: `531`
- Eligible: `531`
- Healthy: `531`
- Executable: per-request; Governor plans were executable `10/10`
- Provider distribution: NVIDIA `102`, Gemini `5`, OpenRouter `413`, OpenCode `6`, Felo `5`
- Provider breakers: all `CLOSED`
- Relevant cooldowns: none
- Relevant model lockouts: none

## Authoritative Workload

| Pair | Category              | Validator                                           | Expected result                        |
| ---: | --------------------- | --------------------------------------------------- | -------------------------------------- |
|    1 | exact text            | normalized exact text                               | `AUTHORITATIVE-EXACT-OK`               |
|    2 | structured JSON       | parsed JSON semantic equality                       | `{"status":"ok","value":17}`           |
|    3 | `ARITHMETIC`          | numeric equality                                    | `42`                                   |
|    4 | `EXTRACTION`          | required JSON fields                                | ticket `T-2048`, priority `high`       |
|    5 | `CLASSIFICATION`      | closed-set exact category                           | `plant`                                |
|    6 | Portuguese structured | required JSON fields                                | status `ok`, idioma `pt`, valor `17`   |
|    7 | English structured    | required JSON fields                                | status `ok`, language `en`, value `17` |
|    8 | transformation        | deterministic exact output                          | `ALPHA-BETA-GAMMA`                     |
|    9 | short reasoning       | verifiable numeric result                           | `24`                                   |
|   10 | simple code           | exact static code check plus local arithmetic check | `function add(a, b) { return a + b; }` |

The structured validators parse JSON and compare only the required fields. The simple-code
validator rejects fences and checks the expected function text plus a deterministic `2 + 3 = 5`
static check; it does not use `eval` or an LLM judge.

## Five-Pair Gate

- Pairs: `5`
- Native HTTP: `5/5`
- Native streams: `5/5`
- Governor plans: `5/5`
- Governor executable: `5/5`
- Governor HTTP: `5/5`
- Governor streams: `5/5`
- Accounting: `PASS`
- Identity: `PASS`
- Correlation: `PASS`
- Invalid: `0`
- Forbidden harness/validator/stale/target/systemic failures: none
- Gate: `PASS`

Because the gate passed, the harness continued to Pairs 6–10 using the unchanged workload and
validators. It never ran more than ten authoritative pairs.

## Pair Results

All authoritative responses were HTTP 200, complete SSE, and had a persisted finish reason of
`stop`. Native selected and executed `openrouter/qwen/qwen3.8-27b` in all ten pairs. Governor
planned and executed `openrouter/openai/gpt-4o-mini-2024-07-18` in all ten pairs. Planned target,
executed target, and allowed connection identity passed in every Governor arm.

| Pair | Case                  | Order             | Native quality | Governor quality | Native call duration* | Governor call duration* | Quality result          |
| ---: | --------------------- | ----------------- | -------------: | ---------------: | --------------------: | ----------------------: | ----------------------- |
|    1 | exact text            | Native → Governor |           pass |             pass |               7107 ms |                  973 ms | tie pending E2E latency |
|    2 | structured JSON       | Governor → Native |           pass |             pass |               1309 ms |                 1370 ms | tie pending E2E latency |
|    3 | arithmetic            | Native → Governor |           pass |             pass |               2801 ms |                  633 ms | tie pending E2E latency |
|    4 | extraction            | Governor → Native |           pass |             fail |               2961 ms |                  862 ms | Native quality win      |
|    5 | classification        | Native → Governor |           pass |             pass |               2078 ms |                  619 ms | tie pending E2E latency |
|    6 | Portuguese structured | Governor → Native |           pass |             pass |               2273 ms |                  992 ms | tie pending E2E latency |
|    7 | English structured    | Native → Governor |           pass |             fail |               1973 ms |                  835 ms | Native quality win      |
|    8 | transformation        | Governor → Native |           pass |             pass |               1813 ms |                  797 ms | tie pending E2E latency |
|    9 | short reasoning       | Native → Governor |           pass |             pass |               2800 ms |                 1157 ms | tie pending E2E latency |
|   10 | simple code           | Governor → Native |           pass |             fail |               3029 ms |                  755 ms | Native quality win      |

\* These are persisted provider call durations, included only as an ancillary diagnostic. They
are not substituted for client-side total E2E, planning-inclusive E2E, headers, TTFT, or completion.

The three Governor quality failures were factual model-quality failures: the extraction and
English structured responses were JSON fenced in Markdown, and the simple-code response was
JavaScript fenced in Markdown. The validators correctly rejected those responses because the
frozen contracts required JSON/code output without wrappers. No validator, SSE, target, or
connection failure occurred.

## Accounting

- Authoritative pairs: `10`
- Native requests: `10`
- Governor planning operations: `10`
- Governor execution requests: `10`
- Physical authoritative requests: `20`
- Preflight setup requests, excluded: `10`
- Correlation records: `20/20` arm requests; planning correlation IDs: `10/10`
- Target identity: `10/10`
- Invalid pairs: `0`

## Native Aggregate

- HTTP: `10/10`
- Stream: `10/10`
- Quality: `10/10`
- Attempts mean: `1`
- Attempts max: `1`
- Fallbacks: `0`
- Headers mean/p50/p95: not recoverable from persisted call logs
- TTFT mean/p50/p95: not recoverable from persisted call logs
- Completion mean/p50/p95/max: not recoverable as client-side values
- E2E mean/p50/p95/max: not recoverable from the retained compact-output transcript

## Governor Aggregate

- Plans: `10/10`
- Executable: `10/10`
- HTTP: `10/10`
- Stream: `10/10`
- Quality: `7/10`
- Planning mean/p50/p95/max: harness serialized these fields, but they were not persisted outside
  the transient compact-output transcript
- Headers: not recoverable from persisted call logs
- TTFT: not recoverable from persisted call logs
- Execution completion: not recoverable as client-side values
- E2E mean/p50/p95/max: not recoverable from the retained compact-output transcript
- Planning share mean/p50: not recoverable from the retained compact-output transcript

The harness source and runtime output path now serialize `headersMs`, `firstByteMs`,
`firstContentMs`, `doneMs`, `completionMs`, `readerCompleted`, stream event count, quality result,
correlation IDs, planned/executed target identity, `planningMs`, total E2E, planning share, and
accounting. The compact output from this run exceeded the terminal capture limit; the database
retains provider-call summaries but not those client-side timer fields. No values are fabricated.

## Speed

- Official p50 ratio Native/Governor: unavailable because total client-side E2E p50 was not retained
- Official mean ratio Native/Governor: unavailable for the same reason
- Ancillary provider-call-duration p50: Native `2273 ms`, Governor `835 ms`; this is not an E2E
  winner and excludes Governor planning overhead

## Pairwise

- Governor wins: not determinable without retained total-E2E latency for the seven quality ties
- Native wins: `3` quality wins
- Ties: seven quality ties pending total-E2E latency classification
- Invalid: `0`
- Governor quality wins: `0`
- Native quality wins: `3`
- Governor latency wins: not determinable from persisted data
- Native latency wins: not determinable from persisted data

## Choice Distribution

- Agreement: `0/10`
- Disagreement: `10/10`
- Native distribution: `openrouter/qwen/qwen3.8-27b` — `10`
- Governor distribution: `openrouter/openai/gpt-4o-mini-2024-07-18` — `10`
- Governor concentration: `100%`

## Outliers

- Persisted provider-call slowest Native arm: Pair 1, `7107 ms`
- Persisted provider-call slowest Governor arm: Pair 2, `1370 ms`
- Observed cause: provider-call duration only; the authoritative client-side E2E outlier cannot
  be identified without the retained harness timer rows. Outliers were not excluded.

## Decision Benchmark

Previous conclusion: `INCONCLUSIVE`. It remains unchanged.

## E2E Conclusion

E2E inconclusive.

The five-pair structural gate passed, all ten pairs were valid, and the Governor had a material
quality regression (`7/10` versus Native `10/10`). However, the authoritative total-E2E and
planning-inclusive timer aggregates were not retained after the compact terminal output was
truncated, so this run cannot answer whether planning-inclusive Governor latency was materially
better. The persisted provider-call durations are explicitly insufficient for that decision.

## Cost

`INCOMPLETE` and out of scope. No savings were inferred.

## NVIDIA

Not a gate. No NVIDIA investigation or benchmark decision was performed.

## Overall Conclusion

The runtime path is structurally reliable for this sample: HTTP, SSE completion, Governor
planning, executable plans, correlation, target identity, and connection guardrails all passed.
The quality result is unfavorable to Governor on three deterministic cases. The latency question
remains inconclusive because planning-inclusive client timers were not durably retained.

## Canary

`0 — NOT ACTIVATED`

## Canary Readiness

Not ready: the benchmark has a confirmed quality regression and lacks retained authoritative
latency aggregates. Governor remains `simulate / false / 0`.

## Remaining Risks

- Governor quality regression from Markdown fences under exact structured/code contracts
- Client-side timer capture is transient; future benchmark runs need durable result retention
- The ten Native target preflights are excluded from pair metrics but can affect provider cache/state
- Pricing remains incomplete and was not used in the conclusion

## Durable artifact contract

The prior run did not retain a complete JSON artifact. The harness now persists the complete
authoritative result before printing it, including raw per-arm output, quality reason, headers,
first-byte/first-content timing, `doneMs`, completion timing, reader/event state, correlation IDs,
target identity, `planningMs`, planning share, and accounting. The writer is atomic and converts
`Map` state to JSON objects so terminal truncation cannot erase the diagnostic record.

- Writer: `scripts/ad-hoc/omniroute-governor-benchmark-persistence.mjs`
- Default directory: `docs/diagnostics/governor-e2e-artifacts/`
- Optional destination: `OMNIROUTE_GOVERNOR_E2E_OUTPUT`
- Artifact schema: `1`
- Authoritative and calibration-recovery paths persist both successful and failed gate results.

This persistence change was validated without executing another benchmark. The Governor remains
`simulate / false / 0` with canary `0`; a future benchmark still requires separate approval.
