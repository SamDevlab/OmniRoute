# Governor Quality Failure Forensics — 2026-08-19

## Evidence boundary

This audit reconstructs the three Governor quality failures recorded in the authoritative
benchmark report. The benchmark's compact terminal transcript was truncated, and no complete JSON
artifact was retained. Therefore the exact raw response bytes and whitespace are **not** available
for these three cases. The fenced shapes below are the strongest reconstruction supported by the
report; they must not be treated as byte-for-byte captures.

The classification is still determinate because the report records HTTP `200`, complete SSE,
`stop` finish reasons, passing target/connection identity, and the exact validator outcome for
each case. No target mismatch, stale plan, HTTP failure, or stream failure was reported.

Governor state remained `simulate / false / 0`, with canary `0`.

## Findings

| Pair | pairId    | caseId                             | Category           | Validator            | Classification        | Quality reason         |
| ---: | --------- | ---------------------------------- | ------------------ | -------------------- | --------------------- | ---------------------- |
|    4 | `pair-04` | `authoritative-extraction`         | EXTRACTION         | `extraction`         | MODEL_QUALITY_FAILURE | `invalid_json`         |
|    7 | `pair-07` | `authoritative-english-structured` | ENGLISH_STRUCTURED | `english_structured` | MODEL_QUALITY_FAILURE | `invalid_json`         |
|   10 | `pair-10` | `authoritative-simple-code`        | SIMPLE_CODE        | `simple_code`        | MODEL_QUALITY_FAILURE | `exact_value_mismatch` |

### Pair 4 — extraction

Prompt:

`Extract ticket and priority from this record. Return JSON only: {"ticket":"T-2048","priority":"high"}. Record: owner=omniroute; ticket=T-2048; priority=high`

Expected contract: a JSON object whose `ticket` is `T-2048` and `priority` is `high`.

Validator: `evaluateHarnessQuality()` parses the normalized response with `JSON.parse()` and
checks the required fields. Markdown fences are not valid JSON.

Reconstructed Governor shape (not byte-exact):

```json
{ "ticket": "T-2048", "priority": "high" }
```

The authoritative report identifies this as a JSON-fenced Markdown response. The exact raw
Governor output and exact accepted Native bytes were not retained; Native passed the required-field
contract. The fence caused `JSON.parse()` to fail, producing `invalid_json` and a
MODEL_QUALITY_FAILURE.

### Pair 7 — English structured output

Prompt:

`Return only this JSON object: {"status":"ok","language":"en","value":17}`

Expected contract: a JSON object whose `status` is `ok`, `language` is `en`, and `value` is `17`.

Validator: `evaluateHarnessQuality()` parses JSON and checks exactly those required fields.

Reconstructed Governor shape (not byte-exact):

```json
{ "status": "ok", "language": "en", "value": 17 }
```

The authoritative report identifies this as a JSON-fenced Markdown response. The exact raw
Governor output and exact accepted Native bytes were not retained; Native passed the required-field
contract. The fence caused `JSON.parse()` to fail, producing `invalid_json` and a
MODEL_QUALITY_FAILURE.

### Pair 10 — simple code

Prompt:

`Return exactly this JavaScript function and nothing else: function add(a, b) { return a + b; }`

Expected contract: the exact function text, plus the deterministic local check that `2 + 3 = 5`.

Validator: `evaluateAuthoritativeQuality()` requires exact equality and then checks the static
function shape and local arithmetic contract. It does not evaluate the model output.

Reconstructed Governor shape (not byte-exact):

```javascript
function add(a, b) {
  return a + b;
}
```

The authoritative report identifies this as a JavaScript-fenced Markdown response. Native passed
the exact contract, so its accepted output is the expected function text. Governor's surrounding
fences made the full value differ from the expected text, producing `exact_value_mismatch` and a
MODEL_QUALITY_FAILURE.

## Classification exclusions

- VALIDATOR_TOO_STRICT: rejected. Each prompt explicitly required raw JSON/code with no wrapper,
  and the validator implemented that contract.
- PROMPT_VALIDATOR_MISMATCH: rejected. The expected values and validator modes match the frozen
  workload contracts.
- HARNESS_RECONSTRUCTION_ERROR: rejected. All three arms were HTTP 200, completed SSE, and had
  persisted `stop` finish reasons; the failure was in the model output content.
- UNKNOWN: rejected. The report supplies enough evidence to determine the failure class, while
  preserving the limitation that raw response bytes were not retained.

## Corrective implication

The harness must persist the complete authoritative result—including raw per-arm output, quality
reason, headers/TTFT/completion timers, planning time/share, correlation IDs, and accounting—before
printing the terminal JSON. This task adds that durable artifact path but does not execute another
benchmark or activate canary.
