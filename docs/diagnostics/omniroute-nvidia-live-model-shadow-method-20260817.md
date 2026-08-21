# NVIDIA Live Model + Shadow Method Validation

Starting HEAD: `3c33da876` (`docs: record NVIDIA Governor executability investigation`).

## Harness

Previous issues:

- `stream:false` did not represent the real auto/chat response path.
- The request did not send a unique `X-Correlation-Id`.
- Governor lookup depended on a response header that was never available on the old
  non-streaming path.
- The external deadline was 90 seconds and was not distinguishable from a provider timeout.

Fix:

- `scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs` now sends `stream:true` and
  `Accept: text/event-stream`.
- Every Native request, Governor planning request and Governor direct execution request gets a
  distinct generated request ID in the outgoing `X-Correlation-Id` header.
- Lookup uses only the exact `X-Correlation-Id` returned by the streaming route. It does not use
  timestamps, prompt text or request ordinal matching.
- The stream reader records headers, first byte, first event, last event, `[DONE]` or finish
  reason, connection close and final outcome without storing response content in the report.
- The default harness deadline is 600 seconds. A 120-second deadline was used only for the
  blocked smoke attempt and is classified as HARNESS_TIMEOUT when it fires.

Correlation contract:

The streaming route creates the authoritative request ID, passes it to `handleChat`, and returns
it as `X-Correlation-Id`. The incoming client header is not adopted as the authoritative ID, so the
harness records both IDs and correlates only with the response header.

Harness correlation smoke: **FAIL/BLOCKED**. The first smoke reached a running process but received
HTTP 404 `text/html` for `/api/v1/chat/completions`, with no response correlation header and no new
Governor row. A process-local restart with `simulate`, active disabled, canary zero and a
process-only webpack override did not reach the 20128 listening state before it was stopped.

## NVIDIA discovery

- Discovery source: native OmniRoute `GET /api/providers/{connectionId}/models?refresh=true`
  handler, called in-process with the stored connection; no web or direct external script was
  used.
- Discovery HTTP status: `200`.
- Discovered: `102`.
- Normalized/persisted after the native refresh: `102`.
- Previous synced snapshot observed before refresh: `5`.
- Registry-declared chat intersection: `29` models.
- Current `auto/chat` virtual pool: NVIDIA was present with the live catalog models and the
  active connection allowlist.
- Live ∩ synced ∩ chat-eligible ∩ auto pool: `29` confirmed IDs.

Relevant IDs present in the intersection include `google/gemma-4-31b-it`,
`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `z-ai/glm-5.2`, and `moonshotai/kimi-k2.6`.

Selected smoke model: `nvidia/google/gemma-4-31b-it`. It was selected because it is present in
the live discovery result, the refreshed synced catalog, the registry chat catalog and the
`auto/chat` model pool. No model ID was inserted manually.

## Previous 404s

The historical `google/gemma-4-31b-it` and `openai/gpt-oss-20b` IDs are both present in the
current native live discovery and synchronized set. The earlier 404 evidence did not show a
confirmed NVIDIA adapter/upstream dispatch; the current failed smoke was an OmniRoute route-level
HTML 404 before the handler. Classification: **OTHER — runtime/route boundary 404, upstream
dispatch not proven**, not NOT_IN_LIVE_DISCOVERY and not a proven NVIDIA timeout.

## NVIDIA runtime

- 1/1: **NOT RUN** — the harness correlation smoke gate did not pass.
- 3/3 serial: **NOT RUN** — blocked by the 1/1 gate.
- Health during NVIDIA requests: no new NVIDIA request was made; the restarted dev process did
  not expose 20128.
- Dispatch confirmed: **NO new dispatch evidence**.

## Auto/chat

The required three serial `auto/chat` requests were **NOT RUN**. The smoke itself returned the
route-level 404 described above and therefore cannot be counted as a completed auto/chat request.

## Governor correlation

- New plans correlated by the corrected harness: `0/3` because the smoke gate failed before the
  three-request run.
- New executable plans: `0/3`.
- Historical persisted rows were not reused as new results. The previous database evidence of
  `3/3` executable plans remains diagnostic background only and was not mixed with this run.

## Shadow pilot

The required three alternating pairs were **NOT RUN**. No Native→Governor, Governor→Native or
Native→Governor pair is counted.

## Method validity

**BLOCKED.** The harness change is syntactically valid and its contract is explicit, but the real
streaming correlation smoke could not complete because the local runtime was first serving a
route-level 404 and then failed to reach the listening state during a controlled process restart.

## Efficiency evidence

`CURRENT EFFICIENCY EVIDENCE=NOT_VALIDLY_TESTED`.

No efficiency, reliability or latency comparison is claimed from this blocked run.

## Governor

`simulate / false / 0` was used for the process-local restart. No Governor policy, active control,
or canary decision was changed.

## Canary

`0 — NOT ACTIVATED`.

## Code/harness changes

Only the diagnostic harness was changed. Production routing, Governor policy, provider adapters,
credentials and `.env` files were not changed. The dev restart used `OMNIROUTE_USE_TURBOPACK=0`
only as a process-local override; the persistent configuration was not edited.

## Tests

- `node --check scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs`: PASS.
- Native NVIDIA discovery through the OmniRoute handler: PASS, HTTP 200, 102 models.
- Native auto-pool inspection: PASS, NVIDIA present; 29 live/synced/registry-chat IDs intersect.
- `git diff --check`: PASS.
- `npm run typecheck:core`: PASS.
- `npm run check:docs-all`: PASS; it reported only 2 soft count warnings and 62 pre-existing
  version-drift warnings.

## Remaining blocker

The local dev runtime did not provide a usable `/api/v1/chat/completions` listener during this
validation. Before restart it returned an HTML 404 for that route; after restart attempts it
remained in instrumentation/proxy compilation and never listened on 20128. Other unrelated
processes on the machine were left untouched.

## Exact next action

Restore a healthy OmniRoute dev listener on `http://127.0.0.1:20128`, verify the four Governor
controls programmatically, rerun the single streaming correlation smoke, and only if it passes run
NVIDIA 1/1, NVIDIA 3/3, auto/chat 3, Governor correlation 3/3 and the exactly three alternating
shadow pairs.
