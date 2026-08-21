# OmniRoute Governor shadow 429 investigation — 2026-08-17

## Scope and safety

- Repository: `OmniRoute-S3`.
- Starting commit: `c471c0925`.
- Governor remained `simulate`; active control was disabled and canary rate stayed `0`.
- No provider policy, routing configuration, credential, API key, or S3 change was made.
- No secret, authorization header, upstream response content, or decrypted credential was recorded.
- Windows was not shut down or restarted. The local dev server was restarted once because the prior process had stopped answering liveness probes and had grown to approximately 4.5 GB; the replacement was started with process-local environment variables only.

## Executive result

The four Governor HTTP 429s in the first pilot had two causes:

1. The first and fourth attempts were expected external rate limiting from the public no-auth OpenCode endpoint.
2. The second and third attempts exposed a real selection/health-visibility defect: the failure was recorded under the routed provider identity `opencode-zen`, while the logical auto pool checked `opencode`. The model lockout therefore did not remove `opencode/big-pickle` from the next Governor candidate pool.

The minimal fix canonicalizes only the existing no-auth sibling lockout namespace. It does not change provider alias resolution, authentication, endpoint selection, 429 classification, or Governor policy.

## Runtime controls

The effective status was checked after the server restart:

| Control           | Effective value                  |
| ----------------- | -------------------------------- |
| Governor mode     | `simulate`                       |
| Telemetry         | `true`                           |
| Active enabled    | `false`                          |
| Canary rate       | `0`                              |
| Active breaker    | `closed`                         |
| Liveness          | HTTP 200 from `/api/health/ping` |
| Monitoring health | `healthy` at the final check     |

The task's active-canary settings were not enabled for this investigation. No active selection or route application was possible.

## Reconstruction of the first pilot

The pilot used fixed `native_then_governor` order. The Native `auto/chat` request generated the simulate telemetry plan; the harness then issued exactly one direct request to the selected Governor target with fallback depth `0`.

| Pair    | Native plan UTC                | Governor target       | Dispatch start UTC | Final status | Lockout recorded UTC | Lockout         |
| ------- | ------------------------------ | --------------------- | ------------------ | -----------: | -------------------- | --------------- |
| alpha   | 15:05:12.388                   | `opencode/big-pickle` | 15:05:14.926       |          429 | 15:05:20.286         | 3 s, failure 1  |
| bravo   | 15:05:20.412                   | `opencode/big-pickle` | 15:05:28.157       |          429 | 15:05:33.762         | 6 s, failure 2  |
| charlie | 15:05:33.879                   | `opencode/big-pickle` | 15:05:35.321       |          429 | 15:05:41.042         | 12 s, failure 3 |
| delta   | no plan; Native client timeout | —                     | —                  |            — | —                    | —               |
| echo    | 15:07:12.003                   | `opencode/big-pickle` | 15:07:24.405       |          429 | 15:07:29.809         | 3 s, failure 1  |

All four direct 429s were the same logical route: `opencode/big-pickle`, resolved for execution as `opencode-zen/big-pickle`, using the synthetic `noauth` connection and the public endpoint `https://opencode.ai/zen/v1/chat/completions`. The upstream message was generic rate limiting and no `Retry-After` header was visible in the captured logs. The executor performed its normal two intra-request 429 retries; the harness did not add hidden attempts or fallback.

The key temporal evidence is that the Bravo plan was created about 126 ms after Alpha's lockout and the Charlie plan about 117 ms after Bravo's lockout. Echo occurred after the previous short lockout had expired, so it is consistent with a fresh external 429 rather than proof of another stale-state selection.

## Root-cause classification

### A — Selection bug

Confirmed for the repeated middle attempts and fixed. `auto/chat` built synthetic candidates under logical provider `opencode`, while dispatch resolved the selected model to `opencode-zen`. The lockout was written using the execution identity, but candidate filtering queried the logical identity.

### B — Health visibility bug

Confirmed as the mechanism behind A. `isModelLocked("opencode-zen", "noauth", "big-pickle")` was true while `isModelLocked("opencode", "noauth", "big-pickle")` was false. The Governor counterfactual input also did not carry an explicit model-lockout or connection-cooldown field; it relied on the already-filtered Auto-Combo candidate pool. Because the pool missed the lockout, the Governor saw the candidate as available.

### C — Rate-limit classification gap

Not the cause of the repeated selection. The generic 429 was classified as `rate_limited`, and model-only lockout backoff escalated 3 s → 6 s → 12 s. The public endpoint supplied no durable quota scope or `Retry-After` signal, so the initial external condition remains only temporarily observable.

### D / F — Static no-auth and expected external limit

Confirmed as a contributing condition. OpenCode's public no-auth endpoint can rate-limit the shared synthetic route. The first and Echo 429s are compatible with that external state. This does not explain why the next two plans ignored an active lockout; that part was the A/B defect.

### E — Harness methodology

The harness is sanitized and does one direct Governor attempt per valid plan, but its order is fixed Native→Governor and therefore has temporal/order bias. That bias did not cause the four OpenCode 429s: the Native final providers in the first pilot were OpenRouter/Gemini/OpenAI, not OpenCode. The new three-pair rerun was blocked before plan creation by Native NVIDIA timeouts, so no claim about Governor-vs-Native efficiency is made.

## Minimal fix

Files changed:

- `src/sse/services/noAuthProviderSiblings.ts`
  - Added `getNoAuthLockProviderId(providerId)`, derived from the existing no-auth sibling map.
  - `opencode`, `opencode-zen`, and `opencode-go` now share the lockout namespace only for the existing synthetic no-auth sibling relationship.
- `open-sse/services/accountFallback.ts`
  - `getCanonicalLockProvider()` applies the no-auth lock namespace after normal `resolveProviderId()` resolution.
- `tests/unit/noauth-autocombo-lockout-7623.test.ts`
  - Added a regression proving that a routed `opencode-zen/noauth/big-pickle` lockout is visible to the logical `opencode` identity and removes `opencode/big-pickle` from the virtual auto pool.

No model price, quota policy, active Governor control, executor URL, credential path, or provider alias behavior was changed.

## Validation after the fix

### Automated

- TDD regression before the production change: 1 expected failure (`false !== true`).
- `noauth-autocombo-lockout-7623.test.ts`: 4/4 passed after the fix.
- `7993-noauth-proxy-routing.test.ts`: 2/2 passed.
- `auth-noauth-fallback-loop-3061.test.ts`: 6/6 passed.
- `account-fallback-service.test.ts`: 78/78 passed.
- Focused total after the fix: 90/90 tests passed.
- `npm run typecheck:core`: passed.
- `git diff --check`: passed.

### Three-pair runtime rerun

The permitted post-fix pilot was run with `--pairs=3`, still `simulate / active=false / canary=0`, and the existing fixed Native→Governor harness order.

| Arm                | Count | Success | Timeout | Valid Governor plans |
| ------------------ | ----: | ------: | ------: | -------------------: |
| Native `auto/chat` |     3 |       0 |       3 |                    — |
| Governor direct    |     0 |       0 |       0 |                    0 |

All three Native calls selected `nvidia/google/gemma-4-31b-it` through the existing LKGP path and reached the 90 s client timeout without a response or correlation ID. The rerun therefore produced no Governor plan and no direct Governor request; it is an experimental/environmental block, not evidence for or against the lockout fix. The requested five-pair expansion was not run.

## Guardrails and telemetry availability

For the original four valid Governor plans:

- `selectedProvider`: `opencode`.
- `selectedModel`: `big-pickle`.
- `resolvedModelTier`: `low`.
- `executable`: `true`.
- `unresolvedFields`: `[]`.
- Guardrails: capability, context fit, provider availability, quota, reasoning, compression, and user output budget all reported passing.
- `routingStrategy`: `cost_optimized`.
- `confidence`: three `MEDIUM`, one `HIGH`.
- `estimatedCounterfactualCost`: `0` in all four valid plans; current-cost data was incomplete in three plans.

The plan telemetry did not expose model-lockout, connection-cooldown, or provider-breaker features. The fix prevents the stale candidate from reaching that layer by correcting the earlier resilience candidate filter.

## Efficiency conclusion

`CURRENT EFFICIENCY EVIDENCE=NOT_VALIDLY_TESTED`

The first pilot showed Native reliability advantage against the observed OpenCode target, but it was confounded by the now-fixed stale candidate and fixed execution order. The post-fix three-pair rerun was not comparable because all Native requests timed out at NVIDIA before a Governor plan existed. No benchmark scale-up, canary activation, or efficiency superiority claim is justified.

## Final handoff

- `FINAL STATUS=F_PARTIAL_PUSHED`
- Governor: `simulate / active=false / canary=0`.
- Benchmark: stopped at the required three-pair diagnostic rerun; five and twenty were not run.
- Active route changes: none.
- Secrets/keys in output, code, telemetry, or Git: none.
- Windows shutdown/restart: not performed.
