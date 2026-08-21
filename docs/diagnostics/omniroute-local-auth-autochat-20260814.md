# OmniRoute local auth and Auto-Chat validation

## Final status

`E - PARTIAL_PUSHED`

The local authentication blocker was resolved through the official login flow.
The existing server stayed running throughout the validation. Native inference,
Auto-Combo discovery, 5/5, 10/10, and a 20-request baseline all passed. The
simulate benchmark was not run because the effective Governor mode is `off`,
not the `simulate` state recorded by the previous report, and changing that
configuration or restarting the server was out of scope.

Validation date: 2026-08-14

## Starting state

- Repository: `C:\Users\in9midia\Downloads\OmniRoute-S3`.
- Starting HEAD: `7a40d32a101996d538490d33048f9e31c32384f4`.
- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- The working tree was clean at the start.
- Existing server process was preserved; no `npm run dev`, process restart,
  Windows restart, or shutdown was executed.
- Server PID: `2740`, `node.exe`, sanitized command line
  `node --max-old-space-size=8192 scripts/dev/run-next.mjs dev`.
- Listener ports `20128`, `20131`, and `20132` remained owned by PID `2740`.
- Health remained HTTP 200 / `healthy`, with three active connections.

## Local auth

### Root cause

Management and discovery routes require the official dashboard session. An
unauthenticated request to `/api/v1/models` returned HTTP 401. This was a test
harness/session issue, not an upstream provider authentication failure.

### Official flow

`POST /api/auth/login` was used with the project's publicly documented default
local test password. The returned HttpOnly `auth_token` cookie was retained only
in memory and was never printed or persisted. `/api/auth/status` then reported
authenticated, `/api/providers` returned HTTP 200, and `/api/v1/models` returned
HTTP 200 with 412 models.

The earlier unauthenticated `auto/chat` request that reached an upstream was not
treated as an auth bypass: management routes still enforced the session, and no
auth code or middleware was changed.

## Runtime persistence

### Finding

The Windows bootstrap resolves its persisted `server.env` under
`C:\Users\in9midia\AppData\Roaming\omniroute`. The active legacy database is
`C:\Users\in9midia\.omniroute\storage.sqlite`; it contains the three active
provider connections and the live call logs. The AppData database is empty.

Safe decryption probes against the active database established:

- the AppData `server.env` encryption key decrypts all three active credentials;
- the legacy `.omniroute\server.env` key does not decrypt those rows;
- the running native provider path succeeds for all three providers.

This is consistent with the running process using the AppData bootstrap key with
the legacy active database. No key was printed, copied, regenerated, or changed.
No server restart was performed, so restart validation remains `NO`.

### Persistence decision

`Reconciled: YES, by identifying the effective bootstrap path; no file write was
needed.` The stale legacy `.omniroute\server.env` was not overwritten because it
is not the Windows bootstrap source and changing it would be an unnecessary
credential mutation.

### Diagnostic side effect

One isolated TypeScript DB import unintentionally initialized the empty AppData
database and applied its pending schema migrations. It contained zero provider
connections and was not the live database. No credentials, active rows, WAL/SHM
files, or repository files were deleted or rewritten; subsequent live reads used
the SQLite read-only API against the active database.

## Providers

Native streaming smokes used the official authenticated session and completed
with HTTP 200, SSE data, and `[DONE]`:

| Provider   | Result | Model                     | Usage                |       Latency |
| ---------- | ------ | ------------------------- | -------------------- | ------------: |
| OpenRouter | 1/1    | `openai/gpt-oss-20b:free` | 80 in / 8 out        |       6279 ms |
| NVIDIA     | 1/1    | `openai/gpt-oss-20b`      | 78 in / 8 out        |       1138 ms |
| Gemini     | 5/5    | `gemini-3.1-flash-lite`   | 15 in / 4-5 out each | 1392-10093 ms |

No malformed stream, timeout, 401, 403, or 429 occurred in these smokes.

## Auto-Combo

Authenticated `GET /api/combos/auto` returned HTTP 200. The `auto/chat` pool
contained five unique provider entries:

- candidateCount: `5`
- providers: `nvidia`, `gemini`, `openrouter`, `opencode`, `felo-web`
- OpenRouter: present
- NVIDIA: present
- Gemini: present
- cross-connection isolation: PASS for the three active native connections
- live catalog: PASS based on the successful native sync/discovery state
- deduplication: PASS for the returned five-entry provider pool

## Governor

The effective runtime values observed through the authenticated feature-flag
endpoint and source defaults were:

- Mode: `off` (source `default`)
- Telemetry: `true` (source `default`)
- Telemetry sample rate: `1` (default)
- Active enabled: `false` (runtime default)
- Canary rate: `0` (runtime default)
- Route mutation: none
- Persisted Governor telemetry rows after the requests: `0`

The prior report stated `simulate`; that was not the current effective runtime
state. It was not changed during this validation.

## Auto/chat diagnostics

The first authenticated series contained five consecutive completed requests:

- 5/5: PASS
- final provider: OpenRouter
- final model: `liquid/lfm-2.5-2.6b:free`
- attempts: one each
- fallback depth: zero each
- latency: 1851-2357 ms in the call-log records
- all responses: HTTP 200 with complete SSE

The following 10-request gate also passed 10/10. All ten requests used the same
OpenRouter free model with one attempt and no fallback. The earlier pre-auth
diagnostic remains in the call log as two NVIDIA HTTP 502 attempts followed by a
successful OpenRouter fallback; it did not recur in the authenticated gates.

## Baseline benchmark

The 20-request baseline ran in the effective `off` state:

- result: `20/20 SUCCESS`
- success rate: `100%`
- latency: min `2371 ms`, mean `4777 ms`, p50 `3240 ms`, p95 `10240 ms`, max `10412 ms`
- attempts: mean/p50/p95/max `1/1/1/1`
- fallback depth: mean/max `0/0`
- provider distribution: OpenRouter `20`
- model distribution: `liquid/lfm-2.5-2.6b:free` `20`

## Simulate benchmark

`0/20`, not run. The effective mode is `off`, while the previous report claimed
`simulate`. Running this phase would require changing Governor configuration or
restarting the server, neither of which was authorized for this validation.
Therefore no counterfactual choice, divergence rate, or Governor telemetry can
be claimed from this run.

## Tests and checks

- Health: PASS, HTTP 200.
- Official local auth: PASS, login 200 and authenticated management/discovery 200.
- Native provider smokes: PASS, OpenRouter 1/1, NVIDIA 1/1, Gemini 5/5.
- Auto-Combo discovery: PASS, `auto/chat` candidateCount 5.
- Auto/chat gate: PASS, 5/5 and 10/10.
- Baseline: PASS, 20/20.
- Production code changed: NO.
- Automated code-test suite rerun: NO; no code or tests changed.

## Security and Git

- API keys printed: NO.
- Encryption key printed: NO.
- Passwords, cookies, bearer tokens, and authorization headers printed: NO.
- Credentials embedded in code or environment: NO.
- `.env`, `server.env`, SQLite, WAL/SHM, cookies, sessions, and runtime backups
  staged: NO.
- Governor active/canary rollout: NO.
- Computer shutdown or Windows restart: NO.

## Remaining blocker and exact next action

The remaining blocker is not provider reliability or local auth. It is the
runtime-state discrepancy between the previous report (`simulate`) and the
effective current mode (`off`). Before any future simulate benchmark or restart,
confirm the intended Governor mode through the official settings path, preserve
`GOVERNOR_ACTIVE_CANARY_RATE=0`, and only then run the missing 20-request
simulate phase. Do not overwrite either encryption-key file unless a future
controlled bootstrap test proves the active process/persistence pair needs it.
