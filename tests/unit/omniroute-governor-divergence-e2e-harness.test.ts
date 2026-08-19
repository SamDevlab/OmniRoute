import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import {
  accountBenchmarkOperations,
  consumeSseText,
  createSseState,
  evaluateQuality,
  flushSseText,
  isStreamComplete,
} from "../../scripts/ad-hoc/omniroute-shadow-benchmark-core.mjs";
import {
  BENCHMARK_ARTIFACT_SCHEMA_VERSION,
  persistBenchmarkArtifact,
} from "../../scripts/ad-hoc/omniroute-governor-benchmark-persistence.mjs";

const harnessPath = new URL(
  "../../scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs",
  import.meta.url
);
const harnessSource = fs.readFileSync(harnessPath, "utf8");

test("divergence harness keeps a fixed 12-category workload and no adaptive case generation", () => {
  const workloadSource = harnessSource.match(
    /export const DIVERGENCE_WORKLOAD = \[(.*?)\n\];/s
  )?.[1];
  assert.ok(workloadSource);
  const categories = [...workloadSource.matchAll(/category: "([A-Z_]+)"/g)].map(
    (match) => match[1]
  );
  assert.equal(categories.length, 12);
  assert.deepEqual(new Set(categories).size, 12);
  assert.deepEqual(categories, [
    "SIMPLE_FAST",
    "STRUCTURED_JSON",
    "CODE_GENERATION",
    "CODE_REASONING",
    "LONG_CONTEXT",
    "PORTUGUESE",
    "ENGLISH",
    "EXTRACTION",
    "CLASSIFICATION",
    "REASONING",
    "FORMAT_STRICT",
    "LOW_COST_CANDIDATE_SCENARIO",
  ]);
  assert.match(harnessSource, /applyGovernorToAutoComboOrder/);
  assert.doesNotMatch(harnessSource, /GOVERNOR_ACTIVE_CANARY_RATE\s*=\s*1/);
});

test("authoritative harness freezes ten cases and stops expansion on a failed five-pair gate", () => {
  const workloadSource = harnessSource.match(
    /export const AUTHORITATIVE_WORKLOAD = Object\.freeze\(\[(.*?)\n\]\);/s
  )?.[1];
  assert.ok(workloadSource);
  const categories = [...workloadSource.matchAll(/category: "([A-Z_]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(categories, [
    "EXACT_TEXT",
    "STRUCTURED_JSON",
    "ARITHMETIC",
    "EXTRACTION",
    "CLASSIFICATION",
    "PORTUGUESE_STRUCTURED",
    "ENGLISH_STRUCTURED",
    "TRANSFORMATION",
    "SHORT_REASONING",
    "SIMPLE_CODE",
  ]);
  assert.match(harnessSource, /--authoritative-e2e/);
  assert.match(harnessSource, /gateForFivePairs/);
  assert.match(harnessSource, /FIVE_PAIR_GATE_FAILED/);
  assert.match(harnessSource, /five-pair gate=/);
  assert.match(harnessSource, /1\.15/);
  assert.match(harnessSource, /planningShare/);
  assert.match(harnessSource, /authoritativeAccounting/);
  assert.match(harnessSource, /authoritative_native_target_preflight_failed/);
});

test("E2E harness measures Governor planning before direct execution and records stale skips", () => {
  assert.match(harnessSource, /const started = performance\.now\(\);/);
  assert.match(harnessSource, /const planningStarted = performance\.now\(\);/);
  assert.match(
    harnessSource,
    /const planningMs = Math\.round\(performance\.now\(\) - planningStarted\);/
  );
  assert.match(harnessSource, /governor_target_stale/);
  assert.match(harnessSource, /governor-e2e-direct/);
  assert.match(harnessSource, /governor_then_native/);
  assert.match(harnessSource, /native_then_governor/);
  assert.match(harnessSource, /pair\.native\.request\?\.qualityPass === true/);
  assert.match(harnessSource, /pair\.governor\.direct\?\.qualityPass === true/);
  assert.match(harnessSource, /stopReason: "e2e_calibration_failed"/);
  assert.match(harnessSource, /const latencyWinner =/);
  assert.match(harnessSource, /winnerReason/);
  assert.match(harnessSource, /item\.pairwise\?\.winner === "governor"/);
  assert.match(harnessSource, /--calibration-recovery/);
  assert.match(harnessSource, /MODEL_QUALITY_FAILURE/);
  assert.match(harnessSource, /TARGET_MISMATCH/);
  assert.match(harnessSource, /STALE_PLAN/);
  assert.match(harnessSource, /plannedTarget/);
  assert.match(harnessSource, /executedTarget/);
  assert.match(harnessSource, /calibrationRecoverySummary/);
  assert.match(harnessSource, /headersMs/);
  assert.match(harnessSource, /headersAtMs/);
  assert.match(harnessSource, /readerCompleted/);
  assert.match(harnessSource, /streamEventCount/);
  assert.match(harnessSource, /requestCorrelationId/);
  assert.match(harnessSource, /responseCorrelationId/);
  assert.match(harnessSource, /connectionIdentity/);
  assert.match(harnessSource, /persistBenchmarkArtifact/);
  assert.match(harnessSource, /kind: "authoritative"/);
  assert.match(harnessSource, /kind: "calibration-recovery"/);
});

test("durable benchmark persistence retains timers, raw output, and Map state", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-artifact-"));
  const outputPath = path.join(temporaryDirectory, "authoritative.json");
  const result = {
    governor: "simulate / false / 0",
    pairs: [
      {
        pairId: "pair-01",
        native: { request: { actualOutput: "native", headersAtMs: 12 } },
        governor: { direct: { actualOutput: "governor", planningMs: 7 } },
      },
    ],
    pool: { connectionState: new Map([["connection-1", { active: true }]]) },
  };

  try {
    const persistedPath = persistBenchmarkArtifact(result, {
      kind: "authoritative",
      now: new Date("2026-08-19T12:34:56.000Z"),
      outputPath,
      pid: 1234,
    });
    const artifact = JSON.parse(fs.readFileSync(persistedPath, "utf8"));

    assert.equal(artifact.schemaVersion, BENCHMARK_ARTIFACT_SCHEMA_VERSION);
    assert.equal(artifact.kind, "authoritative");
    assert.equal(artifact.persistedAt, "2026-08-19T12:34:56.000Z");
    assert.equal(artifact.result.pairs[0].native.request.actualOutput, "native");
    assert.equal(artifact.result.pairs[0].native.request.headersAtMs, 12);
    assert.equal(artifact.result.pairs[0].governor.direct.planningMs, 7);
    assert.deepEqual(artifact.result.pool.connectionState, {
      "connection-1": { active: true },
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("calibration validator passes exact output and classifies fenced code as model quality failure", () => {
  const input = {
    prompt: "Return exactly this JavaScript function and nothing else.",
    expectedOutput: "function add(a, b) { return a + b; }",
    quality: "code",
  };
  const valid = evaluateQuality(input, input.expectedOutput);
  const fenced = evaluateQuality(input, "```javascript\nfunction add(a, b) { return a + b; }\n```");

  assert.equal(valid.pass, true);
  assert.equal(valid.reason, null);
  assert.equal(fenced.pass, false);
  assert.equal(fenced.reason, "exact_value_mismatch");
});

test("calibration SSE reconstruction requires finish/DONE and preserves output", () => {
  const state = createSseState();
  let buffer = "";
  buffer = consumeSseText(
    buffer,
    'data: {"model":"model-a","choices":[{"delta":{"content":"AR"}}]}\n\n',
    state,
    10
  );
  buffer = consumeSseText(
    buffer,
    'data: {"choices":[{"delta":{"content":"ITH"},"finish_reason":"stop"}]}\n\n',
    state,
    11
  );
  buffer = consumeSseText(buffer, "data: [DONE]\n\n", state, 12);
  flushSseText(buffer, state, 13);
  state.readerCompleted = true;

  assert.equal(state.content, "ARITH");
  assert.equal(state.sawDone, true);
  assert.equal(isStreamComplete(200, state), true);
});

test("calibration accounting keeps three pairs and six E2E arm requests explicit", () => {
  const pairs = Array.from({ length: 3 }, () => ({
    native: { request: {} },
    governor: { direct: {} },
  }));
  const accounting = accountBenchmarkOperations(pairs);

  assert.equal(accounting.pairs, 3);
  assert.equal(accounting.clientRequests, 6);
  assert.equal(accounting.nativeAutoRequests, 3);
  assert.equal(accounting.governorDirectRequests, 3);
});
