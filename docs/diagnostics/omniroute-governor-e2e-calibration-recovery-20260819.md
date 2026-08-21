# OmniRoute Governor E2E Calibration Recovery — 2026-08-19

## Scope and controls

This document records the authoritative recovery calibration after the prior three-pair
comparison reported one Governor quality failure. The run started from commit
`8f666b4005aba535fe8f97b0e9bb12186ad2ce0d` on
`feature/s3-intelligence-governor-prework-20260810`.

The Governor was kept in `simulate / false / 0`: simulation mode, active execution disabled,
and canary rate zero. Telemetry was enabled with a sample rate of one. No production routing,
pricing, provider, scoring, reliability, health, or tier policy was changed. The official local
server was started with transient process settings only; persistent environment files were not
modified. No credentials, cookies, authorization headers, or secret values were printed.

## Previous calibration and root cause

The previous calibration had three pairs: Native quality passed `3/3`; Governor quality passed
`2/3`. The only failing pair was the exact-output code case:

- Prompt: `Return exactly this JavaScript function and nothing else: function add(a, b) { return a + b; }`
- Expected: `function add(a, b) { return a + b; }`
- Native output: `function add(a, b) { return a + b; }`
- Governor output: a JavaScript fenced block containing the same function
- HTTP status: `200` for both arms
- Stream persisted and completed: yes for both arms
- Finish reason: `stop`
- Shared request settings: temperature zero, `max_tokens=128`, streaming enabled, no system
  prompt, tools, or response format

The strict validator correctly rejected the Governor output because the prompt required the exact
value and nothing else. The result was a model-quality failure, not a harness failure, validator
failure, stale plan, target mismatch, or SSE failure. The evidence came from read-only call-log
inspection and did not expose secrets.

## Execution trace

Governor execution was timed in `runGovernorE2E`. The flow was:

1. `applyGovernorToAutoComboOrder` planned the Governor route.
2. `planTarget` selected the target.
3. `revalidateTarget` checked active, eligible, healthy, cooldown, lockout, exhaustion, circuit,
   and allowed-connection state.
4. `request(..., "governor-e2e-direct")` executed the direct arm.
5. `readStreamingBody`, `consumeSseText`, and `flushSseText` reconstructed the response.
6. `evaluateQuality` applied the same case validator used by the Native arm.
7. `e2eCompletionMs` ended the timing window.

Native execution was timed in `runNativeE2E`. It used `request("auto/chat")`, read the selected
plan, reconstructed the SSE body through the same streaming path, applied `evaluateQuality`, and
ended the timing window with the same completion measurement.

## Symmetry controls

Each pair reused the exact same prompt, expected value, validator, temperature, `max_tokens=128`,
streaming mode, and `120000ms` request timeout. No system prompt, tools, or response format were
sent. The request headers had the same content type, SSE accept header, and no-cache behavior;
only the correlation/request identifier differed. Models intentionally differed because the Native
arm used the Native route while the Governor arm used the Governor-selected route.

## New authoritative calibration

Exactly three calibration pairs were executed, alternating arm order. The deterministic cases
were exact text, structured JSON, and arithmetic reasoning. No ten-pair benchmark was run.

| Pair | Case                 | Order             | Native target                 | Governor target                            | Native quality | Governor quality |
| ---- | -------------------- | ----------------- | ----------------------------- | ------------------------------------------ | -------------: | ---------------: |
| 1    | exact text           | Native → Governor | `openrouter/qwen/qwen3.8-27b` | `openrouter/openai/gpt-4o-mini-2024-07-18` |           pass |             pass |
| 2    | structured JSON      | Governor → Native | `openrouter/qwen/qwen3.8-27b` | `openrouter/openai/gpt-4o-mini-2024-07-18` |           pass |             pass |
| 3    | arithmetic reasoning | Native → Governor | `openrouter/qwen/qwen3.8-27b` | `openrouter/openai/gpt-4o-mini-2024-07-18` |           pass |             pass |

All three pairs used the same OpenRouter connection across the compared arms. Governor planned
and executed target identity matched in all three pairs. Every revalidation guardrail was true:
active, eligible, healthy, not in cooldown, not locked, not exhausted, and circuit allowed.

### Calibration counters

- Pairs: `3`
- Native E2E requests: `3`
- Governor planning requests: `3`
- Governor direct execution requests: `3`
- Total arm requests: `6` — accounting pass
- Native HTTP: `3/3`
- Native stream complete: `3/3`
- Native quality: `3/3`
- Native target identity: `3/3`
- Governor plans: `3/3`
- Governor executable plans: `3/3`
- Governor HTTP: `3/3`
- Governor stream complete: `3/3`
- Governor quality: `3/3`
- Governor target identity: `3/3`
- SSE `DONE`: Native `3/3`, Governor `3/3`
- Failure classes: none

### Per-pair observations

Pair 1 returned `LOW-COST-OK` on the Governor arm and `LOW-COST-OK` with two leading newlines
on the Native arm; both passed the exact validator. Native total E2E was `49166ms`; Governor
planning was `1029ms` and total E2E was `2029ms`.

Pair 2 returned the expected JSON object on both arms, with only two leading newlines on the
Native output; both passed the JSON validator. Native total E2E was `6942ms`; Governor planning
was `1093ms` and total E2E was `2540ms`.

Pair 3 returned `8` on both arms, with two leading newlines on the Native output; both passed the
arithmetic validator. Native total E2E was `4562ms`; Governor planning was `756ms` and total E2E
was `1707ms`.

### Timing summary

The harness percentile rule uses the lower indexed value for three observations:

- Native direct completion p50: `6933ms`
- Native total E2E p50: `6942ms`
- Governor direct execution completion p50: `961ms`
- Governor planning p50: `1029ms`
- Governor total E2E p50: `2029ms`
- Native first-content p50: `6782ms`
- Governor direct first-content p50: `909ms`

The request layer measured header timing internally, but the compact output from this calibration
did not serialize `headersMs`. The harness now persists `headersMs`, reader completion, and event
count for subsequent runs. This omission does not affect the calibration pass because the pass
criteria were HTTP success, complete SSE, target identity, executable plan, and quality.

## Result

The recovered calibration passes: Native `3/3` and Governor `3/3` for HTTP, stream completion,
target identity, and quality. The prior failure is classified as a model-quality difference for
the rejected fenced code response; the corrected deterministic calibration does not reproduce it.

The earlier ten-pair benchmark remains preliminary and non-authoritative. It was not rerun and is
not used to claim a global quality, reliability, latency, or cost winner.

## Changes

Production code changes: none.

Harness-only changes in
`scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs` add the recovery-only three-case
mode, target and connection identity checks, guardrail revalidation, explicit failure classes,
SSE completion fields, timing fields, and calibration accounting. The unit test adds regression
coverage for exact-output quality classification, SSE completion, three-pair request accounting,
and recovery-mode source invariants.

## Verification

- JavaScript syntax check: passed
- Focused methodology and harness tests: `9/9` passed
- `git diff --check`: passed
- Governor remained `simulate / false / 0`; canary was never activated
- No benchmark was repeated

## Next action

The next task may run an authoritative Governor E2E benchmark beginning with five pairs and
expanding to ten only if its own calibration remains green. Keep the Governor in
`simulate / false / 0` until that benchmark is separately reviewed.
