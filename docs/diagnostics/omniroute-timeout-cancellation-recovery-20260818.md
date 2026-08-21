# OmniRoute timeout, cancellation and recovery audit — 2026-08-18

## Scope and controls

- Repository: `C:\Users\in9midia\Downloads\OmniRoute-S3`.
- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- Starting HEAD: `3c9c87a84`.
- Origin was fetched with `git fetch --all --prune`; no upstream push was attempted.
- Runtime controls were process-local and remained:
  - `INTELLIGENCE_GOVERNOR_MODE=simulate`
  - `INTELLIGENCE_GOVERNOR_TELEMETRY=true`
  - `GOVERNOR_ACTIVE_ENABLED=false`
  - `GOVERNOR_ACTIVE_CANARY_RATE=0`
  - `GOVERNOR_TELEMETRY_SAMPLE_RATE=1`
- No API key, secret, ciphertext, or credential value was printed, stored in code, or added to telemetry.
- No auto/chat, Governor 3/3, shadow, benchmark, or canary activation was executed after the NVIDIA gate blocked.

## Root cause and confirmed fixes

### External abort classification

`src/shared/utils/fetchTimeout.ts` used to convert every `AbortError` into `FetchTimeoutError`. That conflated the local timer with a caller cancellation such as parent abort or client disconnect. The fix tracks the source of the abort, propagates the external abort reason, removes the listener in `finally`, and creates `FetchTimeoutError` only when the utility's own timer fired.

This utility is used by safe outbound/provider-validation/video/image surfaces. It is not the response-start timeout path used by NVIDIA's `DefaultExecutor`, so it was a real cancellation-classification bug but not the direct cause of the observed NVIDIA 504.

### Hedge cancellation classification

`open-sse/services/combo/targetTimeoutRunner.ts` used to turn a parent hedge cancellation into a generic 502 after aborting the child. The fix adds the internal `combo_hedge_cancelled` classification, returns HTTP 499 immediately when the parent cancels, and races the cancellation response so a child that ignores the signal cannot hold the combo until its target timeout. `open-sse/services/combo/comboPredicates.ts` treats that code as request-scoped, preserving the existing no-provider-health-mutation rule.

Local timer behavior is unchanged: `combo_target_timeout` and `combo_global_timeout` remain typed 504 request-scoped failures. A generic upstream 504 remains a provider failure and can update model/connection/provider resilience state.

## Timeout map

| Layer                                     |               Default | Meaning                                                                           | NVIDIA path                              |
| ----------------------------------------- | --------------------: | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `FETCH_CONNECT_TIMEOUT_MS`                |                  30 s | TCP connect timeout                                                               | yes, dispatcher                          |
| Generic `requestTimeout.ts` map           |              30–120 s | provider-specific helper utility                                                  | not used by NVIDIA default chat executor |
| `DEFAULT_COMBO_TARGET_TIMEOUT_MS`         |                 120 s | Combo target time-to-first-response bound; streaming body continues after headers | only combo routing                       |
| Stream readiness                          | 80 s, capped at 180 s | Time waiting for the first valid stream signal                                    | downstream stream path                   |
| `FETCH_TIMEOUT_MS` / fetch headers / body |                 600 s | Default upstream response-start/body ceiling                                      | yes, executor/dispatcher                 |
| `STREAM_IDLE_TIMEOUT_MS`                  |                 600 s | No upstream data between chunks                                                   | yes, downstream stream path              |
| API bridge proxy                          |                 600 s | Bridge proxy request timeout                                                      | bridge paths only                        |
| API bridge server request                 |                 300 s | Bridge server request timeout default                                             | bridge paths only                        |
| API bridge server headers                 |                  60 s | Bridge header timeout default                                                     | bridge paths only                        |
| API bridge keepalive                      |                   5 s | Bridge socket keepalive                                                           | bridge paths only                        |
| Stream disconnect grace                   |                  10 s | Wait for completion bookkeeping after a client close                              | yes, stream finalization                 |
| Combo global budget                       |                     0 | Disabled by default; positive `comboTimeoutMs` is opt-in                          | auto/combo only                          |
| Combo retry delay                         |                   2 s | Default same-target retry delay                                                   | generic combo only                       |
| API-key transient cooldown                |                   3 s | Observed native cooldown after the NVIDIA 504                                     | yes, connection/model recovery           |

With the default combo global budget of zero, there is no single finite router-owned wall-clock bound for all fallback work. The dispatch count is capped at 30, but each target is bounded by its own target/stream timers and may include retry/cooldown waits. An external request/client abort remains the final bound when the caller supplies one.

## NVIDIA runtime gate

The official `npm run dev` process listened on `http://127.0.0.1:20128`; health returned HTTP 200 with 3 configured, active, and healthy connections. One streaming request was made to `POST /api/v1/chat/completions` for `nvidia/google/gemma-4-31b-it`, with `max_tokens=8` and a short diagnostic prompt.

- HTTP response: 200 SSE envelope with keepalive frames; no completed assistant response.
- Request ID: `43d3f019-1e3a-4c1b-a67c-749e76df3d79`.
- Correlation ID: `ab291c44-385e-4da5-aba2-e6a040d16b9d`.
- Client latency: 600412 ms.
- Server evidence: the request reached the NVIDIA adapter and received a 504 classified as `server_error` after approximately 315 s; the native path recorded a model lockout and a 3 s cooldown, then retried.
- Final server evidence: at the client 600 s deadline the SSE request was aborted with `request_signal_aborted`; no assistant usage/completion frame was available.
- This was one client request with native internal retries, not the forbidden NVIDIA serial 3/3 gate.

The 504 was not an OmniRoute synthetic `combo_target_timeout` or `combo_global_timeout`: this was an explicit NVIDIA model request, the adapter path emitted the provider `server_error` classification, and the local 600 s deadline only ended the still-open SSE request afterward. The upstream/provider stall remains unresolved.

## Tests

- Focused timeout/cancellation/health suite: **46 passed, 0 failed**.
- `npm run typecheck:core`: **passed**.
- `git diff --check`: **passed**.
- `npm run test:vitest`: **322 tests passed in 35 files; 4 worker-start errors** in unrelated UI test files (`useDisplayBaseUrl`, `DistributeProxiesButton`, `ProviderCooldownCard`, `Sidebar.search`).
- `npm run test:unit`: started, exposed unrelated pre-existing Adobe Firefly and Agent Bridge failures, then was interrupted while an unrelated long integration case continued; it was not used as a passing gate.

## Final classification before commit

**B — CODE_FIXED_RUNTIME_BLOCKED**

The timeout/cancellation semantics covered by this audit are fixed and regression-tested. Runtime readiness passed, but NVIDIA 1/1 remained blocked by a real upstream 504/retry-duration behavior, so NVIDIA 3/3 and all dependent auto/Governor/shadow/benchmark gates were not run.

## Next action

Investigate NVIDIA upstream 504 latency/retry behavior separately, then rerun only a bounded NVIDIA 1/1 gate after the model cooldown clears. Do not activate `GOVERNOR_ACTIVE_CANARY_RATE=1` as part of that investigation.
