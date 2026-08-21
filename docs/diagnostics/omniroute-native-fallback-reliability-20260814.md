# OmniRoute Native Fallback Reliability

Starting HEAD: `7ccf9288d03b9f828e6ca1b638830ab43e87c9dd`

Branch: `feature/s3-intelligence-governor-prework-20260810`

Governor was kept unchanged throughout this task: `simulate`, Active `false`,
canary rate `0`, telemetry `true`.

## Starting evidence

The preceding controlled benchmark recorded:

- Baseline: `20/20` success.
- Governor simulate: `16/20` success and `4/20` streaming timeouts.
- Mean attempts: `3.25`; maximum attempts: `11`.
- Counterfactual divergence: `20/20`; simulated `opencode/big-pickle` was never dispatched.
- The Governor did not influence native execution.

The four timeout rows were late native fallback outcomes, not Governor route changes.

## Timeout cases

The benchmark report identifies requests 17–20 as final streaming timeouts after
fallback attempts involving upstream `429`, `503`, Gemini `404` model-not-found
responses, and client-abort/timeout statuses. The recorded request maximum was
approximately `120 s`, with up to `11` attempts and fallback depth `10`.

Additional short diagnostics reproduced the same external pattern without exposing
credentials. One later chain reached an NVIDIA upstream `504` after approximately
`302 s`; another diagnostic was client-aborted after a similar wait. These cases
show that a single upstream candidate can dominate total latency when the adapter
does not return promptly. They were not changed by the quota-classification fix.

## Recovered failure cases

The recovered benchmark request crossed an OpenRouter `429`/`503` sequence and
completed through Gemini after fallback. A post-fix short diagnostic with correlation
prefix `5da201a5-3ab` followed Gemini `404` → OpenRouter `429` → Gemini `404` →
Gemini `200`; no second OpenRouter target was attempted in that request. Three other
short diagnostics completed with a single Gemini `200` attempt.

A controlled native OpenRouter request returned the provider's account-wide
`free-models-per-day` `429`. The connection was then persisted as unavailable with
a future `rateLimitedUntil`; the following `auto/chat` request did not attempt
OpenRouter and selected Gemini before the client disconnected. No secret or header
was recorded.

## Error classification

### 429

The OpenRouter `free-models-per-day` marker was previously absent from the quota
classifier. It is now classified as `QUOTA_EXHAUSTED`/daily quota, while ordinary
per-model passthrough behavior remains unchanged. Existing Retry-After and cooldown
handling remain in use.

### 503

Some observed `503` responses were synthetic local responses after waiting roughly
`15 s` for an upstream rate-limit cooldown; others were external provider responses.
The explicit OpenRouter daily-quota marker now causes same-request provider
exhaustion, so remaining OpenRouter targets are skipped. Generic transient `503`
handling was not made more aggressive.

### 404

The observed Gemini `404` responses reported models no longer available to new
users. They are model/provider-catalog health failures and remain a separate stale
catalog risk; this task did not add a hardcoded blacklist.

### Timeout

The dominant long waits were external adapter/upstream waits, including NVIDIA
responses around five minutes in the short gate. No arbitrary timeout reduction or
global budget change was introduced.

## Health propagation

The corrected path is:

`upstream error` → internal raw classification → combo exhaustion decision →
connection/model health mutation → next-target filtering.

The complete upstream message is now carried between internal `Response` objects by
a non-enumerable in-memory symbol. Public response bodies and headers remain
sanitized. `free-models-per-day` is explicitly provider-wide for OpenRouter, so the
connection cooldown is persisted; generic passthrough providers retain their
per-model quota behavior.

The runtime direct test confirmed `testStatus=unavailable` and a future
`rateLimitedUntil` after the OpenRouter daily-quota response. The next auto request
observed that unavailable connection and did not retry OpenRouter.

## Deduplication

The existing deduplication is keyed by execution key. The investigation found that
logical provider/connection/model duplicates can still survive when they have
different execution keys. No duplicate-specific production change was made because
the reproduced quota waste was explained by lost classification and incorrect
connection-wide health propagation, not by a proven duplicate being required for the
failure.

## Candidate ordering

Native ordering remains health- and strategy-dependent. The investigation observed
that recent/provider candidate selection can still expose slow or stale upstreams;
health and cooldown filters are applied after the corrected mutations. No fixed
provider ordering was introduced.

## Timeout budget

The measured behavior includes:

- local synthetic rate-limit waits of about `15 s` before a `503`;
- ordinary short upstream attempts;
- external NVIDIA waits around `300 s` in the later diagnostic gate;
- no verified global auto/chat budget that bounds the sum of all candidate waits.

The chain can therefore remain long when several candidates are slow or stale. This
is an architectural follow-up, not part of the quota-classification fix.

## Root cause

Two related internal defects were confirmed:

1. OpenRouter's explicit `free-models-per-day` account quota was not recognized by
   the shared `429` classifier.
2. The full error text was lost at internal sanitization/model-cooldown boundaries,
   so combo fallback saw only a generic model-cooldown message. Even after restoring
   the internal marker, OpenRouter's passthrough per-model branch kept the connection
   eligible for a later free model despite an account-wide quota response.

The remaining long NVIDIA/Felo/OpenCode/Gemini responses are separate external or
catalog-health risks, not evidence of a Governor policy defect.

## Code changes

Production changes:

- `src/shared/utils/classify429.ts`: recognize the explicit OpenRouter daily free-
  model quota marker.
- `open-sse/services/accountFallback.ts`: classify that marker as daily quota.
- `open-sse/utils/error.ts`: preserve the raw message only in an internal symbol;
  keep public responses sanitized, including model cooldown responses.
- `open-sse/services/combo.ts`: use the internal message for fallback classification
  while retaining sanitized client text.
- `open-sse/services/combo/targetExhaustion.ts`: allow explicit provider-wide quota
  evidence to exhaust a provider even when the provider normally has per-model
  passthrough quota.
- `src/sse/handlers/chat.ts` and `src/sse/handlers/chatHelpers.ts`: preserve the
  internal marker across execution and no-credentials/model-cooldown boundaries.
- `src/sse/services/auth.ts`: persist connection-wide cooldown for the explicit
  OpenRouter daily quota signal.

Regression tests cover the classifier, fallback result, combo exhaustion, sanitized
internal message propagation, model-cooldown propagation, and connection-wide
OpenRouter cooldown.

## Regression tests

- Focused fallback/combo/auth/error tests: `220/220` passed, `0` failed.
- `npm run typecheck:core`: passed.
- `git diff --check`: passed.

## Runtime retest

### 3–5 diagnostics

The short post-classification-fix diagnostics completed with HTTP `200`. The
recovered chain no longer retried another OpenRouter target after the explicit daily
quota response. Three single-Gemini requests completed without a secondary
OpenRouter attempt. Streaming telemetry sometimes had `currentCost=null` until
usage finalization; the counterfactual zero-cost plan remained executable where
budget data was available.

### 5/5

The five-request gate completed with `5/5` HTTP `200` responses before the final
connection-health refinement. One request took approximately `326 s` because of
external NVIDIA/Felo/OpenCode waits; this is not a healthy-latency result. The
final refinement was then validated directly with OpenRouter `429` → persisted
connection cooldown → next auto request excluding OpenRouter.

### 10/10

Not completed. The gate encountered repeated external NVIDIA waits of approximately
`300 s`; four diagnostic requests were observed before the run was terminated after
a client abort. No `10/10` reliability claim is made.

### Confirmation benchmark

Not executed. The required `10/10` gate did not pass, so the larger confirmation
benchmark was correctly not started.

## Governor

- Mode: `simulate`
- Active: `false`
- Canary: `0`
- Telemetry: `true`
- Active route changes: none

## Remaining risk

- NVIDIA upstream responses can still consume approximately five minutes.
- Gemini's synchronized/catalog state contains stale or unavailable models.
- Felo/OpenCode candidates can return provider/model errors and add fallback depth.
- The 10/10 gate remains incomplete.
- A global request budget and authoritative catalog cleanup require a separate,
  explicitly approved task.

## Exact next action

Keep the Governor in `simulate`, Active `false`, and canary rate `0`. A future task
should separately address authoritative model catalog freshness and a documented
global timeout budget, with no canary change as part of that work.
