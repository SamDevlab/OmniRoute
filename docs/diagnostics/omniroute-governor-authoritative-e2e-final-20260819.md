# Governor Authoritative E2E Final

## Final status

I — BENCHMARK_INVALID

The five-pair run was stopped after Pair 1. No Pairs 2–5 or 6–10 were executed.
The run cannot answer whether Governor E2E is faster than Native because the published
authoritative harness rejected the side-effect-free Native baseline identity before it
could execute a Governor arm.

## Starting state

- Repository: SamDevlab/OmniRoute
- Branch: feature/s3-intelligence-governor-prework-20260810
- HEAD and origin: 25e8153b1296f48140a43bbdce2dd4654c68effc
- Pull request: SamDevlab/OmniRoute#12
- Base: release/v3.8.50
- Governor: simulate / false / 0
- Telemetry: enabled
- Canary: 0; not activated
- Production code changes: none
- New PR, merge, force-push, upstream push, and Windows restart: none

## CI gate

CI_GATE was PASS for the published HEAD before the benchmark:

- Quality Gates: SUCCESS, with only workflow-expected skips
- Semgrep: SUCCESS
- DAST smoke: SUCCESS
- Fast Production Build: SUCCESS
- Change Classification: SUCCESS
- Merge integrity: SKIPPED by the workflow rule

## Runtime and pool

The only started service was OmniRoute. The official health endpoint returned HTTP 200 with
status healthy. Listeners were present on 20128, 20131, and 20132.

The effective runtime check returned mode simulate, telemetry enabled, activeEnabled false,
and canaryRate 0.

The dynamically reconstructed pool was:

| Field            | Value |
| ---------------- | ----: |
| Raw              |    11 |
| Active           |    11 |
| Eligible         |    11 |
| Healthy          |    11 |
| opencode         |     6 |
| felo-web         |     5 |
| Active cooldowns |     0 |
| Active lockouts  |     0 |

The observed provider breakers were CLOSED. Pricing was not used as a gate or comparison
metric, and NVIDIA was not a gate.

## Methodology

The Native baseline was resolved before model-facing requests from the frozen pool snapshot
using the published production Auto ordering resolver in an isolated child process. The
resolver blocked network and reported zero provider/model requests and no routing-state
mutation.

The baseline semantics remain Native first-choice selection, not the final target after a
runtime fallback. A baseline mismatch with the first actual target is a methodological stop;
a later final target change would only be a legitimate Native fallback after a proven first
choice.

AB/BA was preserved by the harness design, but the first pair could not complete the Governor
arm because the baseline identity was rejected.

## Readiness before model-facing requests

The dynamic offline readiness check passed:

- Native baselines: 10/10
- Governor plans: 10/10
- Governor executable: 10/10
- Baseline network requests: 0
- Baseline provider/model requests: 0
- Frozen snapshot state digest: unchanged

The readiness plan distribution was opencode/big-pickle 10/10. The readiness baseline
distribution used two virtual execution keys, five each:

- virtual-auto-default-1-opencode: 5/10
- virtual-auto-default-6-opencode: 5/10

This is a low-information environment for routing-intelligence conclusions.

## Benchmark artifacts

- Run ID: 20260820T004212Z-daec6fc3
- Artifact directory: docs/diagnostics/governor-e2e-artifacts/20260820T004212Z-daec6fc3
- manifest.json: present and parseable; status FAILED with stopReason BENCHMARK_INVALID
- operations.jsonl: 8 parseable records, no malformed-record warning
- summary.json: present and parseable
- final-snapshot.json: present and parseable

Operation counts from operations.jsonl:

- native_baseline_resolution: 5
- native_arm: 1
- governor_plan: 1
- governor_arm: 0
- pair_complete: 1
- native_preflight: 0

The five baseline resolutions recorded networkCalls 0, providerModelRequests 0, routingState
mutation false, and equal before/after state digests. The manifest recorded
PREFLIGHT_STATE_CONTAMINATION: NO.

## Five-pair gate

The authoritative summary reports:

| Gate field                        |          Result |
| --------------------------------- | --------------: |
| Pairs requested                   |               5 |
| Pairs started                     |               1 |
| Pairs completed                   |               1 |
| Valid pairs                       |               0 |
| Native HTTP / stream              |           1 / 1 |
| Governor plans / executable       |           1 / 0 |
| Governor HTTP / stream            |           0 / 0 |
| Native quality / Governor quality |           0 / 0 |
| Invalid pairs                     |               1 |
| Five-pair gate                    |            FAIL |
| Benchmark invalid                 |            true |
| Forbidden failure class           | HARNESS_FAILURE |

The run stopped before Pair 2. No later pair was started.

## Pair 1

Pair 1 order was native_then_governor.

The persisted baseline was:

- baseline target: virtual-auto-default-1-opencode
- provider: opencode
- model: oc/big-pickle
- connection: noauth

The Native arm executed:

- first actual target: opencode/big-pickle
- final actual target: opencode/big-pickle
- baseline drift: true according to the strict identity gate
- Native fallback: false
- HTTP: 200
- stream: complete
- total Native E2E: 8502 ms
- quality: fail, reason empty_reconstructed_content

The Governor arm did not execute. Its planning operation could not resolve the virtual
baseline key in the current pool, so the pair was classified as a harness failure rather than
a Governor quality, success, or latency result.

The failure is an identity-contract mismatch in the published diagnostic harness: the
side-effect-free resolver returns the target executionKey
virtual-auto-default-1-opencode, while the runtime validation path and Native actual identity
use the normalized provider/model key opencode/big-pickle. This is not evidence of a real
provider routing drift or a Governor performance result. It is a benchmark-invalidating
harness mismatch.

The strict quality validator was not relaxed. The observed Native empty reconstruction remains
a quality failure, and no conclusion is drawn from it because the pair is methodologically
invalid. The historical EXTRACTION, ENGLISH_STRUCTURED, and SIMPLE_CODE cases were not
reached, so no new format-regression claim is made.

## Accounting

The authoritative summary reports:

- Side-effect-free baseline resolutions: 5
- Native provider/model preflight requests: 0
- Governor provider/model preflight requests: 0
- Native physical requests: 1
- Governor planning operations: 1
- Governor physical direct requests: 0
- Total physical authoritative requests: 1
- Physical requests including legacy preflight: 1
- Legacy native preflight operations: 0

Governor planning was represented in the accounting, but no valid Governor total-E2E arm was
available for comparison. No upstream duration was used as E2E and no pricing metric was used.

## Offline replay

The required command was executed against the persisted run:

    node scripts/ad-hoc/omniroute-governor-run-summarizer.mjs --summarize-run=<run-directory>

The CLI returned the expected nonzero process status for a FAILED run and reconstructed the
same FAILED status, five-pair gate, operation count, pair count, accounting, and Native/Governor
aggregate fields as summary.json. Semantic replay equivalence: PASS.

The only non-semantic difference was finalSnapshotPath: the persisted summary contains the
final snapshot filename, while the pure offline recomputation does not synthesize that path.
This expected metadata difference does not change any benchmark result or accounting field.

The final snapshot's embedded pre-finalization gate marker reports artifactIntegrity false,
while summary.json and the offline replay report artifactIntegrity PASS after finalization.
Both records are preserved; the run is still invalid because of HARNESS_FAILURE and baseline
identity drift.

## Conclusions

- Decision benchmark: INCONCLUSIVE
- E2E conclusion: E2E_INCONCLUSIVE
- Governor E2E better: not claimable
- Native E2E better: not claimable
- Quality delta: not comparable
- Speed ratios: unavailable
- Pairwise wins: 0 Governor, 0 Native, 0 ties, 1 invalid
- Reproducible format-obedience regression: not determined
- Cost: INCOMPLETE
- NVIDIA: NOT A GATE
- Canary readiness: NOT_READY

The historical Native 10/10 versus Governor 7/10 quality result was not re-evaluated by this
invalid run. In particular, no speed advantage can compensate for a quality regression, and no
quality comparison was valid here anyway.

## Exact next action

Do not use this run for a performance conclusion. Before another benchmark, correct the
published diagnostic harness's target-key normalization in a new pre-CI change, add a regression
test covering virtual executionKey versus normalized provider/model identity, rerun the required
CI gate, and start a fresh artifact run. Do not patch this run in place, resume it, or execute
Pairs 6–10 from it.
