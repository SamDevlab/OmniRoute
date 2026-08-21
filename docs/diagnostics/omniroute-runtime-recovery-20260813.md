# OmniRoute runtime recovery report

## Execution status

Final status: `B — RUNTIME_READY_CREDENTIALS_REQUIRED`

Timestamp: 2026-08-13T10:17:56-03:00

Starting HEAD: `ae73b01fe882195f081c46d40451be94195bead1`

Previous status: `B — PARTIAL_PUSHED`

This report is sanitized. It contains no API keys, storage-encryption values,
tokens, cookies, authorization headers, decrypted credentials, `.env` content,
SQLite data, or raw runtime logs.

## Git

- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- Starting `HEAD == @{u}`: YES.
- Starting working tree: CLEAN.
- No reset, force push, destructive checkout, or repository deletion was used.

## Runtime reset and archive

- Old runtime archived: YES.
- Archive path: `C:\Users\in9midia\.omniroute-stale-20260813-20260813-101041`.
- Old active path removed by move: `C:\Users\in9midia\.omniroute`.
- Old roaming runtime path: absent.
- Archive was kept outside the repository and was not read, copied, staged, or
  versioned.

## Fresh runtime

- Fresh runtime: PASS.
- Startup command: `npm run dev`.
- Startup data directory: `C:\Users\in9midia\.omniroute` supplied through the
  process environment only.
- Host/port: `0.0.0.0:20128` / local health URL
  `http://127.0.0.1:20128/api/monitoring/health`.
- Health: HTTP 200, `status=healthy`, version 3.8.50.
- Fresh database: YES.
- Database path: `C:\Users\in9midia\.omniroute\storage.sqlite`.
- Database size at inspection: 1,683,456 bytes.
- Database last-write timestamp at inspection: 2026-08-13T10:15:06.
- Migration state: maximum recorded migration version 151; 145 migration
  records.
- Fresh `server.env`: YES.
- `STORAGE_ENCRYPTION_KEY` present: YES. Its value was never read into output,
  printed, logged, or committed.

The new runtime was stopped after validation. Ports 20128, 20131, and 20132
were clear, and no OmniRoute `run-next.mjs` process remained.

## compression_run_telemetry

Runtime validation: PASS.

After fresh startup, the database contained both `_omniroute_migrations` and
`compression_run_telemetry`. The previous `no such table` condition did not
reappear. This confirms the cleanup path now reaches the idempotent table helper
before issuing its delete; the focused regression also proved the absent-table
case on a temporary database.

No SQLite error was observed through the successful fresh health/startup
validation.

## Governor

The server was launched with process-only controls:

- Mode: `simulate`.
- Active enabled: `false`.
- Active canary rate: `0`.
- Telemetry: `true`.
- Telemetry sample rate: `1`.

No active route mutation, canary rollout, or benchmark was executed. The
persisted fresh `server.env` contained no provider credential names and did not
contain a persisted Governor mode override.

## Providers

Fresh provider connection count: 0.

- OpenRouter: MISSING — no connection configured; provider testing blocked by
  user credential requirement.
- NVIDIA: MISSING — no connection configured; provider testing blocked by user
  credential requirement.
- Gemini: MISSING — no connection configured; provider testing blocked by user
  credential requirement.

No provider key was available in the fresh database or fresh server
configuration. No provider request was sent, and no ciphertext from the stale
archive was reused.

## Auto-combo

Provider-dependent fresh-pool validation: BLOCKED — no configured provider
connections.

The previously published Auto-Combo evidence remains unchanged: credentialed
model pool, cross-connection isolation, live authoritative catalog, and
candidate integrity focused tests were green. No new provider-specific pool
claim is made for the empty fresh database.

## auto/chat diagnostics

Status: BLOCKED — USER CREDENTIALS REQUIRED.

No 3–5 request diagnostic was run because the fresh runtime has no configured
OpenRouter, NVIDIA, or Gemini connection. This avoids fabricating provider or
fallback evidence and avoids reusing stale encrypted state.

## 5/5

Status: BLOCKED — USER CREDENTIALS REQUIRED.

The earlier Gemini smoke result remains historical evidence only; it is not
claimed as a fresh-runtime auto/chat gate.

## 10/10

Status: BLOCKED — 5/5 prerequisite and provider credentials are absent.

## Benchmark 20+20

Status: NOT RUN. The 5/5 and 10/10 gates were not satisfied.

## Tests and checks

- Fresh health endpoint — PASS, HTTP 200 and `status=healthy`.
- Fresh database/server environment creation — PASS.
- Fresh `compression_run_telemetry` table after startup — PASS.
- Focused Auto-Combo/Governor/stream/cleanup/compression baseline from the
  previous published commit — PASS, 53/53.
- Previous `npm run typecheck:core` — PASS.
- Previous `git diff --check` — PASS.
- No production code changed in this execution, so the prior focused test
  baseline was not rerun indiscriminately.
- Full unit, Vitest, E2E, protocol E2E, ecosystem, and benchmark suites — NOT
  RUN; provider credentials and the required gates are absent.

## Remaining blockers

1. Register OpenRouter, NVIDIA, and Gemini through the official OmniRoute
   connection flow.
2. Keep the fresh data directory and its generated encryption environment; do
   not restore or reuse the stale archive unless explicitly needed for a
   separate forensic task.
3. With credentials present, launch in `simulate/false/0`, validate each
   provider, then run 3–5 auto/chat diagnostics with sanitized attempt records.
4. Only after that diagnostic is healthy, run 5/5, then 10/10, then benchmark
   20 baseline + 20 simulate.

## Exact next steps

1. Use the UI/API's native provider-connection creation flow to add the three
   user-owned credentials; never hardcode or place them in Git.
2. Confirm each connection is active using only provider ID, connection ID,
   status, and sanitized error class.
3. Start the server with `DATA_DIR=C:\Users\in9midia\.omniroute`,
   `INTELLIGENCE_GOVERNOR_MODE=simulate`,
   `GOVERNOR_ACTIVE_ENABLED=false`, and
   `GOVERNOR_ACTIVE_CANARY_RATE=0`.
4. Validate discovery/sync/eligibility and one conservative native stream per
   provider.
5. Capture 3–5 auto/chat requests and attempts before advancing to the gates.

## Security

- API keys printed: NO.
- Encryption key printed: NO.
- Secrets added to Git: NO.
- Runtime archive staged: NO.
- `.env`, `server.env`, SQLite, WAL, and SHM files staged: NO.
- Governor active or canary rollout: NO.

## Final state before report commit

- Runtime: fresh and healthy, then stopped cleanly.
- Health: HTTP 200.
- Providers: all three target providers missing credentials.
- Governor: simulate / false / 0.
- 5/5: blocked by credentials.
- 10/10: blocked by 5/5 prerequisite and credentials.
- Benchmark: not run.
- Recommended classification: `B — RUNTIME_READY_CREDENTIALS_REQUIRED`.
