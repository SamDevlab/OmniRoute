import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  MAX_PERSISTED_OUTPUT_BYTES,
  createBenchmarkRun,
  createBenchmarkRunId,
  persistBenchmarkArtifact,
  summarizeBenchmarkRun,
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
  assert.match(harnessSource, /createBenchmarkRun/);
  assert.match(harnessSource, /native_preflight/);
  assert.match(harnessSource, /governor_plan/);
  assert.match(harnessSource, /governor_arm/);
  assert.match(harnessSource, /pair_complete/);
  assert.match(harnessSource, /SIGINT/);
  assert.match(harnessSource, /SIGTERM/);
  assert.match(harnessSource, /finalSnapshotPath/);
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

function appendSyntheticPair(run, pairNumber, options = {}) {
  const pairId = "pair-" + String(pairNumber).padStart(2, "0");
  const caseId = "synthetic-" + pairId;
  const nativeOperationId = run.appendOperation({
    operationType: "native_arm",
    arm: "native",
    pairId,
    caseId,
    category: "SYNTHETIC",
    authoritative: true,
    startedAt: "2026-08-19T12:00:00.000Z",
    completedAt: "2026-08-19T12:00:00.100Z",
    httpStatus: 200,
    headersMs: options.headersMs ?? 100,
    firstByteMs: 120,
    firstContentMs: options.firstContentMs ?? 150,
    doneMs: 180,
    readerCloseMs: 190,
    completionMs: options.completionMs ?? 200,
    totalE2EMs: options.nativeE2EMs ?? 300,
    streamCompleted: true,
    readerCompleted: true,
    doneSeen: true,
    streamEventCount: 3,
    outputLength: 4,
    outputPreview: "PASS",
    outputTruncated: false,
    validator: "exact",
    qualityPass: true,
    qualityReason: null,
    failureClass: null,
    attempts: 1,
    fallbackCount: 0,
    requestCorrelationId: "native-" + pairId,
    responseCorrelationId: "native-response-" + pairId,
    requestId: "native-request-" + pairId,
    executedProvider: "fixture",
    executedModel: "native-model",
    executedTarget: "fixture/native-model",
    executedConnectionId: "native-connection",
  });
  const governorPlanOperationId = run.appendOperation({
    operationType: "governor_plan",
    arm: "governor",
    pairId,
    caseId,
    category: "SYNTHETIC",
    authoritative: true,
    startedAt: "2026-08-19T12:00:00.200Z",
    completedAt: "2026-08-19T12:00:00.210Z",
    planningMs: options.planningMs ?? 10,
    plannedProvider: "fixture",
    plannedModel: "governor-model",
    plannedTarget: "fixture/governor-model",
    plannedConnectionId: "governor-connection",
    executable: true,
    confidence: "MEDIUM",
    guardrailResults: { CAPABILITY_COMPATIBLE: "YES" },
    failureClass: null,
  });
  const governorOperationId = run.appendOperation({
    operationType: "governor_arm",
    arm: "governor",
    pairId,
    caseId,
    category: "SYNTHETIC",
    authoritative: true,
    startedAt: "2026-08-19T12:00:00.220Z",
    completedAt: "2026-08-19T12:00:00.320Z",
    httpStatus: 200,
    headersMs: options.governorHeadersMs ?? 80,
    firstByteMs: 90,
    firstContentMs: options.governorFirstContentMs ?? 110,
    doneMs: 140,
    readerCloseMs: 150,
    completionMs: options.governorCompletionMs ?? 160,
    totalE2EMs: options.governorE2EMs ?? 250,
    streamCompleted: true,
    readerCompleted: true,
    doneSeen: true,
    streamEventCount: 3,
    outputLength: 4,
    outputPreview: "PASS",
    outputTruncated: false,
    validator: "exact",
    qualityPass: true,
    qualityReason: null,
    failureClass: null,
    attempts: 1,
    fallbackCount: 0,
    requestCorrelationId: "governor-" + pairId,
    responseCorrelationId: "governor-response-" + pairId,
    requestId: "governor-request-" + pairId,
    plannedProvider: "fixture",
    plannedModel: "governor-model",
    plannedTarget: "fixture/governor-model",
    plannedConnectionId: "governor-connection",
    executedProvider: "fixture",
    executedModel: "governor-model",
    executedTarget: "fixture/governor-model",
    executedConnectionId: "governor-connection",
    planningMs: options.planningMs ?? 10,
    planningShare: options.planningShare ?? 0.04,
  });
  if (options.complete !== false) {
    run.appendOperation({
      operationType: "pair_complete",
      pairId,
      caseId,
      category: "SYNTHETIC",
      authoritative: true,
      startedAt: "2026-08-19T12:00:00.000Z",
      completedAt: "2026-08-19T12:00:00.400Z",
      nativeOperationId,
      governorOperationIds: { plan: governorPlanOperationId, arm: governorOperationId },
      valid: true,
      winner: "governor",
      reason: "latency",
      qualityWinner: "tie",
      latencyWinner: "governor",
      agreement: false,
      nativeHttp: 200,
      governorHttp: 200,
      nativeStreamCompleted: true,
      governorStreamCompleted: true,
      governorPlanOperationId,
      governorPlanExecutable: true,
      governorTargetIdentity: "PASS",
      failureClass: null,
    });
  }
}

test("crash-safe run preserves completed pairs and classifies an unfinished Pair 7", () => {
  const fixedNow = new Date("2026-08-19T12:00:00.000Z");
  const firstRunId = createBenchmarkRunId(fixedNow, "abc123");
  const secondRunId = createBenchmarkRunId(fixedNow, "def456");
  assert.match(firstRunId, /^20260819T120000Z-[a-z0-9]+$/);
  assert.notEqual(firstRunId, secondRunId);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-crash-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-crash7",
      now: new Date("2026-08-19T12:00:00.000Z"),
      gitHead: "fixture-head",
      branch: "fixture-branch",
      requestedPairs: 10,
      authoritative: true,
      governorMode: "simulate",
      governorActive: false,
      canaryRate: 0,
      runtimeBaseUrl: "http://fixture.invalid",
      workloadHash: "workload-hash",
      validatorHash: "validator-hash",
      poolSnapshot: { raw: 2, active: 2, eligible: 2, healthy: 2 },
    });
    for (let pair = 1; pair <= 6; pair += 1) appendSyntheticPair(run, pair);
    run.appendOperation({
      operationType: "governor_plan",
      arm: "governor",
      pairId: "pair-07",
      caseId: "synthetic-pair-07",
      category: "SYNTHETIC",
      authoritative: true,
      planningMs: 12,
      plannedTarget: "fixture/governor-model",
      executable: true,
    });

    const summary = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(summary.status, "INCOMPLETE_RUN");
    assert.equal(summary.completedPairs, 6);
    assert.equal(summary.pairsValid, 6);
    assert.equal(summary.accounting.governorPlanningOperations, 7);
    assert.equal(fs.existsSync(path.join(run.runDirectory, "summary.json")), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("offline summary reconstructs complete runs, timings, accounting, and atomic summary", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-summary-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-complete",
      now: new Date("2026-08-19T12:00:00.000Z"),
      gitHead: "fixture-head",
      branch: "fixture-branch",
      requestedPairs: 3,
      authoritative: true,
      poolSnapshot: { raw: 2 },
    });
    appendSyntheticPair(run, 1, {
      headersMs: 100,
      completionMs: 200,
      nativeE2EMs: 300,
      governorHeadersMs: 80,
      governorCompletionMs: 160,
      governorE2EMs: 250,
      planningMs: 10,
      planningShare: 0.04,
    });
    appendSyntheticPair(run, 2, {
      headersMs: 200,
      completionMs: 300,
      nativeE2EMs: 400,
      governorHeadersMs: 100,
      governorCompletionMs: 200,
      governorE2EMs: 350,
      planningMs: 20,
      planningShare: 0.05,
    });
    appendSyntheticPair(run, 3, {
      headersMs: 300,
      completionMs: 400,
      nativeE2EMs: 500,
      governorHeadersMs: 120,
      governorCompletionMs: 240,
      governorE2EMs: 450,
      planningMs: 30,
      planningShare: 0.06,
    });

    const finalized = run.finalize({ status: "COMPLETE" });
    const replayed = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(finalized.status, "COMPLETE");
    assert.equal(replayed.status, "COMPLETE");
    assert.equal(replayed.completedPairs, 3);
    assert.equal(replayed.native.headers.p50, 200);
    assert.equal(replayed.native.headers.p95, 200);
    assert.equal(replayed.native.e2e.max, 500);
    assert.equal(replayed.governor.completion.mean, 200);
    assert.equal(replayed.planning.p50, 20);
    assert.equal(replayed.planningShare.p95, 0.05);
    assert.equal(replayed.accounting.nativeRequests, 3);
    assert.equal(replayed.accounting.governorPlanningOperations, 3);
    assert.equal(replayed.accounting.governorExecutionRequests, 3);
    assert.equal(replayed.accounting.physicalAuthoritativeRequests, 6);
    assert.equal(fs.existsSync(path.join(run.runDirectory, "summary.json")), true);
    assert.equal(
      fs.readdirSync(run.runDirectory).some((name) => name.startsWith("summary.json.tmp")),
      false
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("SIGINT marking preserves operations without fabricating a summary", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-abort-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-aborted",
      now: new Date("2026-08-19T12:00:00.000Z"),
      requestedPairs: 10,
    });
    appendSyntheticPair(run, 1);
    run.markAborted("SIGINT");
    const summary = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(summary.status, "ABORTED");
    assert.equal(summary.completedPairs, 1);
    assert.equal(summary.accounting.physicalAuthoritativeRequests, 2);
    assert.equal(fs.existsSync(path.join(run.runDirectory, "summary.json")), false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(run.runDirectory, "manifest.json"), "utf8")
    );
    assert.equal(manifest.status, "ABORTED");
    assert.equal(manifest.abortSignal, "SIGINT");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("malformed final JSONL line preserves valid operations and blocks COMPLETE", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "omniroute-governor-malformed-")
  );
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-malformed",
      now: new Date("2026-08-19T12:00:00.000Z"),
      requestedPairs: 1,
    });
    run.appendOperation({ operationType: "native_preflight", caseId: "fixture-1" });
    run.appendOperation({ operationType: "governor_plan", caseId: "fixture-1" });
    run.appendOperation({ operationType: "native_arm", caseId: "fixture-1" });
    fs.appendFileSync(
      path.join(run.runDirectory, "operations.jsonl"),
      '{"operationType":"native_arm"'
    );
    const summary = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(summary.status, "INCOMPLETE_RUN");
    assert.equal(summary.validOperations, 3);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.warnings[0].code, "MALFORMED_OPERATION_RECORD");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("offline summarizer CLI reads a run without DB, server, or provider access", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-cli-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-cli",
      now: new Date("2026-08-19T12:00:00.000Z"),
      requestedPairs: 10,
    });
    appendSyntheticPair(run, 1);
    const summarizerPath = fileURLToPath(
      new URL("../../scripts/ad-hoc/omniroute-governor-run-summarizer.mjs", import.meta.url)
    );
    const result = spawnSync(
      process.execPath,
      [summarizerPath, "--summarize-run=" + run.runDirectory],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, "INCOMPLETE_RUN");
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("operation persistence bounds output and excludes prompt/response/credential fields", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-privacy-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-privacy",
      now: new Date("2026-08-19T12:00:00.000Z"),
      requestedPairs: 1,
    });
    run.appendOperation({
      operationType: "native_arm",
      caseId: "fixture-privacy",
      outputPreview: "x".repeat(MAX_PERSISTED_OUTPUT_BYTES + 100),
      prompt: "SENSITIVE_PROMPT_SENTINEL",
      responseBody: "SENSITIVE_RESPONSE_SENTINEL",
      authorization: "Bearer SENSITIVE_TOKEN_SENTINEL",
      credentials: { apiKey: "SENSITIVE_KEY_SENTINEL" },
    });
    const line = fs.readFileSync(path.join(run.runDirectory, "operations.jsonl"), "utf8").trim();
    const operation = JSON.parse(line);
    assert.equal(
      Buffer.byteLength(operation.outputPreview, "utf8") <= MAX_PERSISTED_OUTPUT_BYTES,
      true
    );
    assert.equal(operation.outputTruncated, true);
    assert.equal(line.includes("SENSITIVE_PROMPT_SENTINEL"), false);
    assert.equal(line.includes("SENSITIVE_RESPONSE_SENTINEL"), false);
    assert.equal(line.includes("SENSITIVE_TOKEN_SENTINEL"), false);
    assert.equal(line.includes("SENSITIVE_KEY_SENTINEL"), false);
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
