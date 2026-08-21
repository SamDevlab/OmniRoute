import assert from "node:assert/strict";
import test from "node:test";

import {
  accountBenchmarkOperations,
  consumeSseText,
  createSseState,
  evaluateQuality,
  flushSseText,
  isStreamComplete,
} from "../../scripts/ad-hoc/omniroute-shadow-benchmark-core.mjs";

test("reconstructs SSE content across chunks and records first content separately from first event", () => {
  const state = createSseState();
  let clock = 100;
  const now = () => clock++;
  let buffer = "";
  buffer = consumeSseText(
    buffer,
    'data: {"model":"provider/model","choices":[{"delta":{"role":"assistant"}}]}\n\n',
    state,
    now
  );
  buffer = consumeSseText(buffer, 'data: {"choices":[{"delta":{"content":"hel', state, now);
  buffer = consumeSseText(buffer, 'lo"}}]}\n\n', state, now);
  buffer = consumeSseText(
    buffer,
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    state,
    now
  );
  buffer = consumeSseText(
    buffer,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    state,
    now
  );
  flushSseText(buffer, state, now);
  state.readerCompleted = true;

  assert.equal(state.content, "hello world");
  assert.equal(state.eventCount, 5);
  assert.equal(state.firstEventAt, 100);
  assert.equal(state.firstContentAt, 101);
  assert.equal(state.sawFinishReason, true);
  assert.equal(state.sawDone, true);
  assert.equal(isStreamComplete(200, state), true);
  assert.equal(isStreamComplete(200, { ...state, readerCompleted: false }), false);
});

test("does not treat incomplete reader closure or malformed JSON as a completed stream", () => {
  const state = createSseState();
  consumeSseText("", "data: {not-json}\n\n", state, 50);
  assert.equal(state.parseError, "sse_json_parse_error");
  assert.equal(isStreamComplete(200, state), false);

  state.readerCompleted = true;
  assert.equal(isStreamComplete(200, state), false);
  assert.equal(isStreamComplete(502, state), false);
});

test("quality validators are deterministic and preserve the reconstructed output", () => {
  const exact = evaluateQuality({ expected: "42" }, " 42\n");
  assert.equal(exact.pass, true);
  assert.equal(exact.validator, "exact");
  assert.equal(exact.actualOutput, " 42\n");

  const json = evaluateQuality(
    { quality: "json", expectedJson: { status: "ok", value: 7 } },
    '{"status":"ok","value":7}'
  );
  assert.equal(json.pass, true);
  assert.equal(json.judged, true);

  const code = evaluateQuality(
    { quality: "code", expectedOutput: "const result = 6 * 7;" },
    "const result = 6 * 7;"
  );
  assert.equal(code.pass, true);

  const invalid = evaluateQuality({ quality: "json", expectedJson: { ok: true } }, "not-json");
  assert.equal(invalid.pass, false);
  assert.equal(invalid.reason, "invalid_json");

  const unjudged = evaluateQuality({ quality: "unjudged" }, "anything");
  assert.equal(unjudged.pass, null);
  assert.equal(unjudged.judged, false);
});

test("benchmark accounting separates authoritative pairs from preliminary work", () => {
  const pairs = [
    {
      native: { status: 200 },
      governor: { planningRequest: { status: 200 }, direct: { status: 200 } },
    },
    {
      native: { status: 200 },
      governor: { planningRequest: { status: 200 }, direct: null },
    },
  ];
  assert.deepEqual(accountBenchmarkOperations(pairs), {
    pairs: 2,
    clientRequests: 5,
    nativeAutoRequests: 2,
    nativeDirectRequests: 0,
    governorPlanRequests: 2,
    governorDirectRequests: 1,
    preliminaryPairs: 0,
    authoritativePairs: 2,
  });
  assert.deepEqual(accountBenchmarkOperations(pairs, { preliminary: true }), {
    pairs: 2,
    clientRequests: 5,
    nativeAutoRequests: 2,
    nativeDirectRequests: 0,
    governorPlanRequests: 2,
    governorDirectRequests: 1,
    preliminaryPairs: 2,
    authoritativePairs: 0,
  });
});
