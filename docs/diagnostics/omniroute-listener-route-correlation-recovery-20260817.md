# OmniRoute Listener + Route + Correlation Recovery

Starting HEAD: `b809a0f29` (`diag: record NVIDIA live discovery and shadow blocker`).

## Listener recovery

Starting listener: **NONE** on ports 20128, 20131 and 20132.

Startup command: `npm run dev`, with process-local controls:
`INTELLIGENCE_GOVERNOR_MODE=simulate`, `INTELLIGENCE_GOVERNOR_TELEMETRY=true`,
`GOVERNOR_ACTIVE_ENABLED=false`, `GOVERNOR_ACTIVE_CANARY_RATE=0` and
`GOVERNOR_TELEMETRY_SAMPLE_RATE=1`.

PID: `17276`, command `node --max-old-space-size=8192 scripts/dev/run-next.mjs dev`,
process start observed at `2026-08-17 14:36:42`.

Listener: recovered on `0.0.0.0:20128`; the same startup also reported 20131 and 20132.
Health: `GET /api/monitoring/health` returned HTTP 200 with `status=healthy`,
`activeConnections=3`, `configuredCount=3` and `activeCount=3`. A later health probe reported
credential health `3 healthy / 0 failed`.

DB path reported by startup: `C:\Users\in9midia\.omniroute\storage.sqlite`.

Startup warnings were limited to optional OAuth integrations not configured, the default initial
password warning, and external provider-statistics/Arena fetch timeouts. No startup fatal error
was observed.

## Route investigation

Harness previous path: `POST /api/v1/chat/completions`.

Expected route: the same path, implemented by
`src/app/api/v1/chat/completions/route.ts`. It accepts JSON POST requests and supports SSE when
`stream=true` or the Accept header requests streaming.

Fallback route: `src/app/api/v1/[...omnirouteCatchAll]/route.ts` returns JSON 404 for unknown
`/api/v1/*` paths. A live probe of `/api/v1/not-a-real-route` returned JSON 404, not HTML.

HTML 404 layer: the previous process/runtime state, before the real API route was loaded and
ready. The current correct route returned HTTP 200 SSE, so the harness path was not wrong.

Root cause: **DEV_SERVER_ROUTE_NOT_LOADED / runtime-not-ready boundary**, not
OPENAI_COMPAT_ROUTE_MISMATCH and not a provider 404.

Fix: no production route or harness change was necessary. The official OmniRoute process was
restored and allowed to finish its cold startup.

Route matrix:

| Route                                           | Method        | Auth                                                      | Streaming | Governor telemetry         | Response    |
| ----------------------------------------------- | ------------- | --------------------------------------------------------- | --------- | -------------------------- | ----------- |
| `/api/v1/chat/completions`                      | POST          | Local mode accepted; API-key policy remains authoritative | Yes       | Yes                        | JSON or SSE |
| `/api/v1/providers/{provider}/chat/completions` | POST          | Delegates to the same chat/auth pipeline                  | Yes       | Via delegated chat handler | JSON or SSE |
| `/api/v1/[...omnirouteCatchAll]`                | GET/POST/etc. | N/A                                                       | No        | No                         | JSON 404    |

## Harness

X-Correlation-Id: **PASS**. The request sends a unique value and correlates only with the
authoritative response header.

SSE: **PASS** in the smoke; HTTP 200, `text/event-stream`, 13 events, `[DONE]` and connection
close observed.

HARNESS_TIMEOUT: **PASS** as a classification. The long NVIDIA serial attempt was classified
separately from the upstream 504 and ended only after the configured 600-second client deadline.

Auth: **PASS in local mode**. The server logged `No API key provided (local mode)`; no auth
bypass or secret was added.

## Correlation smoke

HTTP: **200**.

Stream: **complete**, with response model `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`, usage
`33 prompt / 7 output / 40 total`, and latency about 24.1 seconds.

Correlation: **PASS**. The response correlation ID was returned and the Governor row was found
by that exact ID; timestamp/model/prompt matching was not used.

Governor plan: **found**. `selectedProvider=opencode`, `selectedModel=big-pickle`,
`resolvedModelTier=low`, `estimatedCounterfactualCost=0`, `costEstimateBasis=PRE_REQUEST_BUDGET`,
`confidence=MEDIUM`, `executable=true`, `unresolvedFields=[]`; all seven guardrails were `YES`.
The actual route was NVIDIA, while the Governor simulated choice was OpenCode.

## NVIDIA

Discovery: **102** previous and revalidated models through the native OmniRoute discovery
handler.

Intersection: **29** previous/current IDs in live ∩ synced ∩ chat-eligible ∩ auto pool.

Selected live model: `nvidia/google/gemma-4-31b-it`, still present in native discovery.

1/1: **PASS**. Direct request reached the NVIDIA adapter/upstream, returned HTTP 200 with
`text/event-stream`, and the server recorded a complete stream with `28 prompt / 32 output`
tokens in about 60 seconds. No route 404 occurred.

3/3: **BLOCKED at the first serial item**. The first serial request reached NVIDIA, then received
`504 server_error` after approximately five minutes. OmniRoute performed native model cooldown
and retries; the client reached its 600-second deadline and aborted. Requests 2/3 and 3/3 were
not started.

Dispatch layer: **confirmed** for the successful 1/1 and for the failed serial attempt; server
logs showed NVIDIA egress and provider handling. The failed serial item is classified as
upstream/runtime 504 followed by native retry, not a route 404.

Health during request: **FAIL / not captured during the failed request** because response headers
never arrived before the client deadline. A post-failure health probe returned HTTP 200 and
`status=healthy`.

## Auto/chat

Three requests: **NOT RUN**. The required NVIDIA 3/3 gate did not pass.

## Governor correlation

Plans: **NOT RUN as 3/3**. The independent correlation smoke was `1/1`.

Executable: **1/1 in the smoke**; the planned `3/3` gate was not reached.

## Shadow pilot

Pair 1: NOT RUN.

Pair 2: NOT RUN.

Pair 3: NOT RUN.

Methodology: **BLOCKED** by the NVIDIA 3/3 runtime gate. No efficiency claim is made.

## Efficiency evidence

NOT_VALIDLY_TESTED.

The required 3-pair shadow comparison was not reached, and the single successful NVIDIA smoke is
not comparative evidence.

## Governor

`simulate / false / 0`.

## Canary

`0 — NOT ACTIVATED`.

## Changes

No production code, provider catalog, credentials, Governor policy, Active flag or persistent
configuration was changed. This report is the only new file for this recovery attempt.

## Tests

- Official `npm run dev` startup: PASS; listener recovered.
- Health gate: PASS, HTTP 200 and healthy.
- Correct route streaming smoke: PASS, HTTP 200 and complete SSE.
- Exact Governor correlation smoke: PASS, plan found by response correlation ID.
- Native NVIDIA discovery: PASS, 102 models; selected model present.
- Unknown `/api/v1/*` route probe: PASS, JSON 404 rather than HTML.
- No production or harness source changed in this attempt; no additional typecheck was required.

## Remaining blocker

The live NVIDIA model is reachable and can complete once, but the serial reliability gate is not
stable: the first serial request entered upstream handling, returned 504 after a long wait, and
exhausted the client deadline while native retries were still active.

## Exact next action

Investigate the NVIDIA upstream 504/retry-duration behavior separately, then rerun only the
bounded NVIDIA 1/1 and serial 3/3 gate after the model cooldown is clear. Do not run auto/chat,
Governor 3/3 or shadow until NVIDIA 3/3 completes.

## Status

`D — NVIDIA_RUNTIME_BLOCKED`

Computer: left on; no Windows shutdown or restart executed.
