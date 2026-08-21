# OmniRoute Native vs Governor Shadow Benchmark

## Starting state

- HEAD: 5078dae485892274e43ce58224974f0e4450f01b
- Branch: feature/s3-intelligence-governor-prework-20260810
- HEAD present on origin: yes, before this diagnostic commit
- Governor: simulate / false / 0
- Telemetry: enabled with sample rate 1
- Health: healthy; HTTP 200; 3 configured and active connections; 3 healthy credentials; 0 failed; 0 open breakers
- Runtime: port 20128 listening; no Windows restart or shutdown

## Global budget runtime validation

- comboTimeoutMs=0: PASS. The controlled neutral-model harness completed the fallback path with HTTP 200 and both synthetic candidates attempted.
- Positive temporary budget: PASS. A synthetic slow candidate was bounded, the remaining candidate was not started after the global budget expired, and the result was HTTP 504 with COMBO_TIMEOUT.
- Deadline and abort: PASS. The active attempt was aborted at the global budget boundary and the final classification was COMBO_TIMEOUT.
- Health side effects: PASS. The synthetic global timeout was classified by the router-owned path and did not penalize provider, connection, or model health.
- Production configuration: unchanged; the default remains comboTimeoutMs=0.

## Methodology

- Pilot size: 5 pairs; no scale-up because the pilot failed the operational-health gate.
- Inputs: five synthetic prompts requesting a unique fixed token; no user or sensitive data.
- Request parameters: auto/chat for Native, the same messages, temperature 0, max_tokens 32, non-streaming HTTP requests, and the same client timeout policy.
- Native arm: normal auto/chat routing.
- Governor direct arm: the executable target selected by the Governor's simulate telemetry for that Native request, then sent explicitly by the harness. Active routing was never enabled.
- Execution order: native_then_governor for every pair. This fixed order is a limitation because the telemetry plan was obtained from the Native request; no production routing was changed.
- Quality method: limited blind-free exact expected-token containment. Response content was inspected only in memory and was not written or printed; no LLM judge was used. A quality tie below means both arms failed this narrow check, not that broad answer quality was proven equivalent.

## Governor choices

The Governor produced an executable plan with no unresolved fields for 4 of 5 pairs. All four valid plans selected opencode/big-pickle, with low tier and cost_optimized strategy. The fifth pair timed out in the Native request before a correlated plan could be read.

| Governor target                        | Valid executable plans |
| -------------------------------------- | ---------------------: |
| opencode/big-pickle                    |                      4 |
| No plan after Native transport timeout |                      1 |

For the four plans, confidence was MEDIUM three times and HIGH once. The seven captured guardrails were YES in every valid plan: CAPABILITY_COMPATIBLE, CONTEXT_FITS, PROVIDER_AVAILABLE, QUOTA_ACCEPTABLE, REASONING_SUPPORTED, COMPRESSION_SUPPORTED, and USER_MAX_OUTPUT_RESPECTED.

## Native choices

Final response models were gemini-3-flash-preview three times, openai/gpt-oss-20b once, and no response once because of the client timeout. The telemetry first-choice fields were openrouter/liquid/lfm-2.5-2.6b:free once, gemini/gemini-2.5-flash once, and gemini/gemini-3-flash-preview twice; one pair had no correlated first choice.

The observed Native telemetry fields did not consistently match the final response model representation. Therefore the instrumented Native first-choice result is 0/5, but it is not reliable evidence of five first-choice failures. This discrepancy is retained as a remaining telemetry risk and was not changed in this task.

## Reliability

### Native

- Success: 4/5, 80%
- Failure: 1/5
- Timeout: 1/5
- Other errors: 0/5

### Governor direct

- Success: 0/4 executable direct attempts, 0%
- Failure: 4/4
- Timeout: 0/4
- HTTP 429: 4/4

The Governor direct target was operationally unhealthy for this pilot: every direct opencode/big-pickle attempt returned rate_limit_exceeded with HTTP 429. The harness did not give this arm fallback; direct choice and seeded fallback are intentionally separate metrics.

## First-choice success

- Native: 0/5 as instrumented; not interpretable because actualProvider/actualModel did not consistently identify the final response model.
- Governor direct: 0/4; every executable direct target failed before producing a response.

## Latency

| Arm             |      Min |      Mean |      P50 |       P95 |       Max |
| --------------- | -------: | --------: | -------: | --------: | --------: |
| Native          | 1,522 ms | 23,127 ms | 7,814 ms | 13,306 ms | 90,007 ms |
| Governor direct | 5,449 ms |  5,584 ms | 5,472 ms |  5,657 ms |  5,756 ms |

The Governor mean is not an efficiency win: all four measurements are failed 429 responses, while the Native mean includes four successful responses and one bounded client timeout.

## Attempts / fallback

- Native: 5 requests; the response fallback-attempts header reported 0 for the four HTTP 200 responses. Effective fallback depth cannot be reconstructed reliably because of the telemetry/final-model mismatch.
- Governor direct: 1 attempt per valid pair and fallback depth 0 by design; no fallback was allowed in this direct-choice metric.

## Cost

- Native: no reliable price metadata was available from the response/telemetry pair, so no Native cost was invented.
- Governor: estimatedCounterfactualCost was 0 in all 4 valid plans. estimatedCurrentCost was present once at 0.0000863 and null three times. Cost comparison is therefore incomplete; the zero counterfactual estimate is the known free-tier result, not evidence of a completed successful generation.
- Cost basis in the valid plans was PRE_REQUEST_BUDGET where recorded by the Governor telemetry. No cost was inferred from token counts alone.

## Quality

- Governor wins: 0
- Native wins: 0
- Ties: 4
- Unjudgeable: 1

All four comparable pairs failed the narrow expected-token containment check on both arms. This quality result is not sufficient to claim answer-quality equivalence because the test did not use an independent judge and intentionally discarded response text.

## Pairwise results

| Pair    | Native final model     | Governor target     | Native  | Governor    | Native latency | Governor latency | Quality     | Reliability |
| ------- | ---------------------- | ------------------- | ------- | ----------- | -------------: | ---------------: | ----------- | ----------- |
| alpha   | gemini-3-flash-preview | opencode/big-pickle | 200     | 429         |       2,985 ms |         5,472 ms | tie*        | Native      |
| bravo   | gemini-3-flash-preview | opencode/big-pickle | 200     | 429         |       7,814 ms |         5,657 ms | tie*        | Native      |
| charlie | gemini-3-flash-preview | opencode/big-pickle | 200     | 429         |       1,522 ms |         5,756 ms | tie*        | Native      |
| delta   | timeout                | unavailable         | timeout | unjudgeable |      90,007 ms |                — | unjudgeable | unjudgeable |
| echo    | openai/gpt-oss-20b     | opencode/big-pickle | 200     | 429         |      13,306 ms |         5,449 ms | tie*        | Native      |

The asterisk denotes that both arms failed the narrow exact-token check; it is not a general quality judgment.

## Counterfactual value

- Governor improved outcome: 0/4 comparable pairs.
- Governor worsened outcome: 4/4 comparable pairs on reliability because the selected direct target returned HTTP 429.
- Governor equivalent: 4/4 only under the narrow quality check; reliability was not equivalent.
- Unjudgeable: 1/5 because the Native request timed out before a correlated Governor plan existed.

This is evidence against the observed direct choice in this runtime state, not proof that the Governor algorithm is universally worse. The target concentration and the 429 state must be investigated before any active decision.

## Concentration

The Governor selected one target in 4/4 executable plans: opencode/big-pickle. The plans exposed low tier, cost_optimized routing, MEDIUM/HIGH confidence, zero counterfactual cost, and all guardrails YES, but did not expose enough independent score components in this harness to explain the saturation. No ranking or policy algorithm was changed.

## Conclusion

INCONCLUSIVE

The five-pair pilot is not a valid basis for a 10/20-pair superiority claim. It did establish a clear operational blocker for the direct choice: 4/4 selected targets returned HTTP 429, while one Native request reached the client timeout. Quality was also deliberately limited and cost data was incomplete.

## Canary readiness

NOT_READY

NO CANARY ACTIVATION IN THIS TASK. Governor remained simulate / false / 0 throughout, and no user route was changed. A separate canary review is not justified until the selected-target 429/cooldown state and the telemetry first-choice mismatch are resolved and a healthy pilot is repeated.

## Remaining risks

- The Governor concentrated on opencode/big-pickle even though its direct upstream returned HTTP 429 on every attempt in this pilot.
- The observed opencode lockout/rate-limit state may be temporary, so this result should not be generalized without a clean rerun.
- Native actualProvider/actualModel telemetry did not consistently match the final response model, making first-choice and fallback-depth analysis unreliable.
- The execution order was fixed Native then Governor, creating temporal and state-order bias.
- The quality check was intentionally narrow; no independent judge or response-quality score was used.
- Three of four Governor current-cost estimates were null, so cost superiority was not measurable.

## Exact next action

Investigate and document why the Governor's executable plan remains concentrated on opencode/big-pickle while its connection/model is rate-limited, then repeat a 5-pair pilot only after the target-health state is clean. Do not enable Active or change canary rate during that investigation.

## Final handoff

- FINAL STATUS: G — RUNTIME_VALIDATION_BLOCKED
- HEAD before this report: 5078dae485892274e43ce58224974f0e4450f01b
- Shadow pairs: 5/20 pilot; scale gate not passed
- GLOBAL BUDGET RUNTIME: PASS
- Governor: simulate / false / 0
- Canary: 0 — NOT ACTIVATED
- Code changes: sanitized ad-hoc benchmark harness only; no production, Governor, credential, or S3 changes
- Tests: harness syntax check, typecheck core, diff check, and documentation check recorded with this handoff
- Commit and push: this report and harness are committed and pushed to origin in a follow-up commit
- COMPUTER: LEFT ON — NO SHUTDOWN/RESTART EXECUTED
