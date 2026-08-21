# OmniRoute provider validation report

## Final status

`B — PROVIDERS_READY_AUTOCHAT_BLOCKED`

The current runtime now has three active, healthy provider connections. Native
connection tests and model synchronization succeeded in the running server.
Inference smokes and Auto-Combo gates remain blocked because this validation
session has no authenticated management/dashboard session for the local API.

Validation date: 2026-08-14

## Runtime

- Repository: `C:\Users\in9midia\Downloads\OmniRoute-S3`.
- HEAD at validation: `75d52a65d docs(diagnostics): record provider validation blocker`.
- Branch/upstream: `feature/s3-intelligence-governor-prework-20260810` /
  `origin/feature/s3-intelligence-governor-prework-20260810`.
- Server: existing `npm run dev` process remained running; no restart or shutdown
  was performed. A second launch attempt was rejected because the listener was
  already healthy and was not used for validation.
- Health: HTTP 200, `status=healthy`, version `3.8.50`,
  `activeConnections=3`.
- Data directory: `C:\Users\in9midia\.omniroute`.

## Credential validation

All three provider rows are active API-key connections. Safe runtime metadata
after recovery shows `testStatus=active`, no cooldown, and no persisted error.
The running server recorded successful native connection tests at
`2026-08-14T12:09:45Z`:

| Provider   | Connection  | Auth type | Native test | Latency |
| ---------- | ----------- | --------- | ----------: | ------: |
| OpenRouter | `0429fb80…` | `apikey`  |    HTTP 200 |  231 ms |
| NVIDIA     | `4048ceb6…` | `apikey`  |    HTTP 200 |  895 ms |
| Gemini     | `70aadca1…` | `apikey`  |    HTTP 200 |  562 ms |

The successful rows are from the current server's native path and are the
provider verdict. A separate helper process was intentionally not used for the
verdict: it loaded an older `server.env` encryption setting, produced
`Missing API key` before any upstream request, and was then cleaned up through
the native conditional recovery helper. No credential field was rewritten.

### OpenRouter

- Connection: ACTIVE.
- Credential: HEALTHY — native test HTTP 200.
- Reference model: `openai/gpt-oss-20b:free` present.
- Discovery/normalization: PASS — 18 synchronized imported models.
- Sync: PASS — native model-sync call logs HTTP 200.
- Chat eligibility/Auto-Combo candidate: NOT RUN — inference authorization
  blocked this session.
- Native chat smoke: `0/1`, NOT RUN.

### NVIDIA

- Connection: ACTIVE.
- Credential: HEALTHY — native test HTTP 200.
- Reference model: `openai/gpt-oss-20b` present.
- Discovery/normalization: PASS — 5 synchronized imported models.
- Sync: PASS — native model-sync call logs HTTP 200.
- Chat eligibility/Auto-Combo candidate: NOT RUN — inference authorization
  blocked this session.
- Native chat smoke: `0/1`, NOT RUN.

### Gemini

- Connection: ACTIVE.
- Credential: HEALTHY — native test HTTP 200.
- Primary model: `gemini-3.1-flash-lite` present.
- Requested secondary `gemini-3.5-flash-lite`: not present; the synchronized
  catalog contains `gemini-3.5-flash` instead.
- Discovery/normalization: PASS — 5 synchronized imported models.
- Sync: PASS — native model-sync call logs HTTP 200.
- Chat eligibility/Auto-Combo candidate: NOT RUN — inference authorization
  blocked this session.
- Native smokes: `0/5`, NOT RUN.

No upstream 401/429, timeout, malformed stream, or provider chat error was
observed in this validation. The three `401 Missing API key` rows at
`2026-08-14T12:06:28Z` belong to the isolated helper that lacked the running
process's encryption context; they occurred before an upstream call and are
not evidence of an OpenRouter, NVIDIA, or Gemini rejection.

## Discovery, sync, and catalog

- OpenRouter: 18 synchronized imported models; reference free model present.
- NVIDIA: 5 synchronized imported models; reference model present.
- Gemini: 5 synchronized imported models; primary reference model present.
- Native model-sync call logs: HTTP 200 for all three providers.
- Normalization: PASS for the synchronized entries.
- Cross-connection isolation: NOT RUN in this session.
- Live authoritative catalog: PASS for the native sync observations.
- Deduplication across registry/synced/default/wildcard/aliases: NOT RUN.
- Candidate pool: NOT RUN; raw synchronized model counts are not a substitute
  for credentialed Auto-Combo eligibility.

## Governor

- Mode: `simulate` (current runtime baseline).
- Active: `false`.
- Canary rate: `0`.
- Telemetry: configured with sample rate `1` in the validation launch controls.
- No route mutation or canary selection was executed.
- No new Governor telemetry row was available because no chat request reached
  the authenticated inference handler in this session.

## Auto/chat diagnostics

Status: BLOCKED — authenticated local inference access is required.

No 3–5 diagnostic requests were run, so there are no new sanitized attempt
records, fallback depths, native/Governor choice comparisons, stream outcomes,
or health mutations. The provider validation result is independent of this
blocker and is PASS for all three providers.

## Gates

- 5/5 auto/chat: `0/5`, NOT RUN — provider validation passed, but inference
  endpoint authentication was unavailable.
- 10/10 auto/chat: `0/10`, NOT RUN — 5/5 prerequisite not met.
- Benchmark baseline: `0/20`, NOT RUN.
- Benchmark simulate: `0/20`, NOT RUN.
- Benchmark complete: NO.

## Tests and checks

- Runtime health: PASS, HTTP 200.
- Native provider connection tests: PASS, 3/3 HTTP 200 in the running server.
- Native model sync: PASS for OpenRouter, NVIDIA, and Gemini.
- Existing focused Auto-Combo/Governor/stream/cleanup/compression baseline:
  PASS, 53/53.
- Existing `npm run typecheck:core`: PASS.
- `git diff --check`: PASS.
- `npm run check:docs-all`: PASS; pre-existing soft drift warnings only.
- No production code or tests changed in this validation.

## Changes

Only this sanitized diagnostic report is updated. No provider credential,
`STORAGE_ENCRYPTION_KEY`, `.env`, `server.env`, database, WAL/SHM file, or
runtime backup was intentionally changed. No production code was modified.

## Remaining blocker and next exact action

The remaining blocker is local inference authorization, not provider
credentials: the local API returns HTTP 401 before the protected test/discovery
routes when no dashboard session or management token is supplied.

Next exact action: sign in to the existing local OmniRoute dashboard session (or
run the authorized local client) without restarting the current server, then
run the native chat smokes followed by the 3–5 diagnostics, 5/5, 10/10, and only
then the 20 baseline + 20 simulate benchmark. Keep Governor `simulate / false / 0`.

## Security and Git

- API keys printed: NO.
- Encryption key printed: NO.
- Authorization headers, tokens, and cookies printed: NO.
- Credentials embedded in code: NO.
- Runtime database/backups staged: NO.
- Governor active/canary rollout: NO.
- Computer shutdown/restart: NOT EXECUTED.
