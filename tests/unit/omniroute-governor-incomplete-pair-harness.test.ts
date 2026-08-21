import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessGovernorRuntimeReadiness,
  classifyGovernorPlan,
  evaluatePairState,
  PAIR_STATES,
  pairLatencyWinner,
} from "../../scripts/ad-hoc/omniroute-governor-pair-state.mjs";
import {
  createBenchmarkRun,
  deriveFivePairGate,
  summarizeBenchmarkRun,
} from "../../scripts/ad-hoc/omniroute-governor-benchmark-persistence.mjs";

function executablePlan(overrides = {}) {
  return {
    selectedProvider: "fixture",
    selectedModel: "governor-model",
    executable: true,
    confidence: "HIGH",
    unresolvedFields: [],
    guardrailResults: { CAPABILITY_COMPATIBLE: "YES" },
    ...overrides,
  };
}

function nativeArm(overrides = {}) {
  const request = {
    status: 200,
    streamCompleted: true,
    qualityPass: true,
    totalE2EMs: 100,
    ...overrides.request,
  };
  return {
    valid: true,
    request,
    e2eCompletionMs: overrides.e2eCompletionMs ?? 100,
    targetIdentity: overrides.targetIdentity || "PASS",
    nativeFinalTarget: "fixture/native-model",
    ...overrides,
    request,
  };
}

function governorArm(overrides = {}) {
  const plan = overrides.plan === undefined ? executablePlan() : overrides.plan;
  const planState =
    overrides.planState ||
    classifyGovernorPlan({
      plan,
      effectiveMode: overrides.effectiveGovernorMode || "simulate",
      revalidation: overrides.revalidation || null,
    });
  const direct = !Object.prototype.hasOwnProperty.call(overrides, "direct")
    ? {
        status: 200,
        streamCompleted: true,
        qualityPass: true,
        totalE2EMs: 80,
      }
    : overrides.direct;
  return {
    valid: true,
    plan,
    planState,
    direct,
    e2eCompletionMs: overrides.e2eCompletionMs ?? 80,
    targetIdentity: overrides.targetIdentity || "PASS",
    selectedTarget: "fixture/governor-model",
    ...overrides,
    plan,
    planState,
    direct,
  };
}

function evaluateFixture({
  native = nativeArm(),
  governor = governorArm(),
  preflight = null,
} = {}) {
  return evaluatePairState({ native, governor, preflight });
}

function validPairRecord(pairNumber) {
  const pairId = `pair-${String(pairNumber).padStart(2, "0")}`;
  return {
    operationType: "pair_complete",
    pairId,
    caseId: `synthetic-${pairId}`,
    valid: true,
    pairState: PAIR_STATES.PAIR_COMPLETE_VALID,
    winner: "governor",
    reason: "total_e2e_latency_15_percent_threshold",
    qualityWinner: "tie",
    latencyWinner: "governor",
    nativeOperationId: `native-${pairId}`,
    governorPlanOperationId: `plan-${pairId}`,
    governorArmOperationId: `arm-${pairId}`,
    governorPlanExecutable: true,
    nativeTargetIdentity: "PASS",
    baselineVsFirstActual: "PASS",
    baselineDrift: false,
    governorTargetIdentity: "PASS",
    nativeHttp: 200,
    governorHttp: 200,
    nativeStreamCompleted: true,
    governorStreamCompleted: true,
    nativeQualityPass: true,
    governorQualityPass: true,
    failureClass: null,
  };
}

test("pre-fix incomplete-pair fixture reproduces the dereference and current evaluation is safe", () => {
  const native = nativeArm();
  const governor = governorArm({ plan: executablePlan({ executable: false }), direct: undefined });
  const legacyPairLatencyWinner = (nativeRequest, governorRequest) =>
    nativeRequest.qualityPass && governorRequest.qualityPass;

  assert.throws(() => legacyPairLatencyWinner(native.request, governor.direct), TypeError);
  const result = evaluateFixture({ native, governor });
  assert.equal(result.pairState, PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE);
  assert.equal(result.valid, false);
  assert.equal(result.winner, null);
  assert.equal(result.latencyWinner, null);
});

test("Governor runtime readiness fails closed when effective mode is not simulate", () => {
  const readiness = assessGovernorRuntimeReadiness({
    effectiveMode: "off",
    governorActive: false,
    canaryRate: 0,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.failureClass, "HARNESS_FAILURE");
  assert.equal(readiness.failureReason, "GOVERNOR_MODE_MISMATCH");
  assert.equal(readiness.rootCause, "HARNESS_LOGIC_ERROR");
});

test("pair state matrix enforces structural order and winner hierarchy", () => {
  const governorFast = evaluateFixture({
    native: nativeArm({ e2eCompletionMs: 100 }),
    governor: governorArm({ e2eCompletionMs: 80 }),
  });
  assert.equal(governorFast.winner, "governor");
  assert.equal(governorFast.latencyWinner, "governor");

  const nativeFast = evaluateFixture({
    native: nativeArm({ e2eCompletionMs: 80 }),
    governor: governorArm({ e2eCompletionMs: 100 }),
  });
  assert.equal(nativeFast.winner, "native");
  assert.equal(nativeFast.latencyWinner, "native");

  const tie = evaluateFixture({
    native: nativeArm({ e2eCompletionMs: 100 }),
    governor: governorArm({ e2eCompletionMs: 110 }),
  });
  assert.equal(tie.winner, "tie");
  assert.equal(tie.latencyWinner, "tie");

  const nativeQuality = evaluateFixture({
    governor: governorArm({ direct: { status: 200, streamCompleted: true, qualityPass: false } }),
  });
  assert.equal(nativeQuality.pairState, PAIR_STATES.GOVERNOR_QUALITY_FAILURE);
  assert.equal(nativeQuality.valid, true);
  assert.equal(nativeQuality.qualityWinner, "native");
  assert.equal(nativeQuality.latencyWinner, null);

  const governorQuality = evaluateFixture({
    native: nativeArm({ request: { status: 200, streamCompleted: true, qualityPass: false } }),
  });
  assert.equal(governorQuality.pairState, PAIR_STATES.NATIVE_QUALITY_FAILURE);
  assert.equal(governorQuality.valid, true);
  assert.equal(governorQuality.qualityWinner, "governor");
  assert.equal(governorQuality.latencyWinner, null);

  const planMissing = evaluateFixture({ governor: governorArm({ plan: null, direct: undefined }) });
  assert.equal(planMissing.pairState, PAIR_STATES.GOVERNOR_PLAN_MISSING);
  assert.equal(planMissing.stopBenchmark, true);

  const planNonExecutable = evaluateFixture({
    governor: governorArm({
      plan: executablePlan({ executable: false, selectedProvider: null, selectedModel: null }),
      direct: undefined,
    }),
  });
  assert.equal(planNonExecutable.pairState, PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE);
  assert.equal(planNonExecutable.failureClass, "NO_EXECUTABLE_TARGET");
  assert.equal(planNonExecutable.stopBenchmark, false);

  const malformedExecutablePlan = evaluateFixture({
    governor: governorArm({ plan: { executable: true }, direct: undefined }),
  });
  assert.equal(malformedExecutablePlan.pairState, PAIR_STATES.HARNESS_FAILURE);
  assert.equal(malformedExecutablePlan.failureReason, "EXECUTABLE_PLAN_WITHOUT_TARGET");
  assert.equal(malformedExecutablePlan.stopBenchmark, true);

  const directMissing = evaluateFixture({ governor: governorArm({ direct: undefined }) });
  assert.equal(directMissing.pairState, PAIR_STATES.GOVERNOR_DIRECT_MISSING);
  assert.equal(directMissing.failureClass, "HARNESS_FAILURE");
  assert.equal(directMissing.stopBenchmark, true);

  const nativeMissing = evaluateFixture({ native: null });
  assert.equal(nativeMissing.pairState, PAIR_STATES.NATIVE_ARM_MISSING);
  assert.equal(nativeMissing.stopBenchmark, true);

  const nativeStream = evaluateFixture({
    native: nativeArm({ request: { status: 200, streamCompleted: false, qualityPass: true } }),
  });
  assert.equal(nativeStream.pairState, PAIR_STATES.NATIVE_STREAM_FAILURE);
  assert.equal(nativeStream.successWinner, "governor");
  assert.equal(nativeStream.latencyWinner, null);

  const governorStream = evaluateFixture({
    governor: governorArm({ direct: { status: 200, streamCompleted: false, qualityPass: true } }),
  });
  assert.equal(governorStream.pairState, PAIR_STATES.GOVERNOR_STREAM_FAILURE);
  assert.equal(governorStream.successWinner, "native");
  assert.equal(governorStream.latencyWinner, null);

  const targetMismatch = evaluateFixture({ governor: governorArm({ targetIdentity: "MISMATCH" }) });
  assert.equal(targetMismatch.pairState, PAIR_STATES.TARGET_MISMATCH);
  assert.equal(targetMismatch.stopBenchmark, true);

  const stalePlan = evaluateFixture({
    governor: governorArm({ revalidation: { valid: false, reason: "target_not_in_current_pool" } }),
  });
  assert.equal(stalePlan.pairState, PAIR_STATES.STALE_PLAN);
  assert.equal(stalePlan.failureClass, "STALE_PLAN");
  assert.equal(stalePlan.stopBenchmark, false);

  const httpFailure = evaluateFixture({
    governor: governorArm({ direct: { status: 502, streamCompleted: false, qualityPass: false } }),
  });
  assert.equal(httpFailure.pairState, PAIR_STATES.GOVERNOR_HTTP_FAILURE);
  assert.equal(httpFailure.latencyWinner, null);

  const missingE2E = evaluateFixture({
    native: nativeArm({ e2eCompletionMs: null, request: { totalE2EMs: undefined } }),
    governor: governorArm({
      e2eCompletionMs: null,
      direct: { status: 200, streamCompleted: true, qualityPass: true },
    }),
  });
  assert.equal(missingE2E.pairState, PAIR_STATES.PAIR_COMPLETE_VALID);
  assert.equal(missingE2E.latencyWinner, null);
  assert.equal(pairLatencyWinner(missingE2E.native, missingE2E.governor), null);
});

test("five-pair gate safely distinguishes valid, non-executable, and harness-invalid fixtures", () => {
  const valid = Array.from({ length: 5 }, (_, index) => validPairRecord(index + 1));
  assert.equal(deriveFivePairGate(valid, { requestedPairs: 5 }).pass, true);

  const nonExecutable = [
    ...valid.slice(0, 4),
    {
      ...validPairRecord(5),
      valid: false,
      pairState: PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE,
      winner: null,
      latencyWinner: null,
      governorPlanExecutable: false,
      governorArmOperationId: null,
      governorHttp: null,
      governorStreamCompleted: false,
      governorQualityPass: false,
      failureClass: "NO_EXECUTABLE_TARGET",
    },
  ];
  const nonExecutableGate = deriveFivePairGate(nonExecutable, { requestedPairs: 5 });
  assert.equal(nonExecutableGate.pass, false);
  assert.equal(nonExecutableGate.governorExecutable, 4);
  assert.equal(nonExecutableGate.benchmarkInvalid, false);

  const harnessFailure = [
    ...valid.slice(0, 4),
    {
      ...validPairRecord(5),
      valid: false,
      pairState: PAIR_STATES.GOVERNOR_DIRECT_MISSING,
      winner: null,
      latencyWinner: null,
      governorArmOperationId: null,
      governorHttp: null,
      governorStreamCompleted: false,
      governorQualityPass: false,
      failureClass: "HARNESS_FAILURE",
      stopBenchmark: true,
    },
  ];
  const harnessGate = deriveFivePairGate(harnessFailure, { requestedPairs: 5 });
  assert.equal(harnessGate.pass, false);
  assert.equal(harnessGate.benchmarkInvalid, true);
});

test("offline identity gate requires Native identity and rejects baseline drift", () => {
  const valid = Array.from({ length: 5 }, (_, index) => validPairRecord(index + 1));
  const governorOnly = valid.map((pair) => ({
    ...pair,
    nativeTargetIdentity: undefined,
    baselineVsFirstActual: undefined,
    baselineDrift: undefined,
  }));
  const governorOnlyGate = deriveFivePairGate(governorOnly, { requestedPairs: 5 });
  assert.equal(governorOnlyGate.identity, "FAIL");
  assert.equal(governorOnlyGate.nativeIdentity, "FAIL");
  assert.equal(governorOnlyGate.pass, false);

  const drift = valid.map((pair, index) =>
    index === 1
      ? {
          ...pair,
          nativeTargetIdentity: "MISMATCH",
          baselineVsFirstActual: "MISMATCH",
          baselineDrift: true,
          failureClass: "MODEL_QUALITY_FAILURE",
        }
      : pair
  );
  const driftGate = deriveFivePairGate(drift, { requestedPairs: 5 });
  assert.equal(driftGate.identity, "FAIL");
  assert.equal(driftGate.benchmarkInvalid, true);
  assert.deepEqual(driftGate.failureClasses.sort(), ["MODEL_QUALITY_FAILURE", "TARGET_MISMATCH"]);
  assert.equal(driftGate.pass, false);
});

test("model quality failure remains experimental when both identities pass", () => {
  const pairs = Array.from({ length: 5 }, (_, index) => ({
    ...validPairRecord(index + 1),
    nativeQualityPass: index === 0,
    governorQualityPass: index === 0,
    failureClass: index === 0 ? null : "MODEL_QUALITY_FAILURE",
  }));
  const gate = deriveFivePairGate(pairs, { requestedPairs: 5 });
  assert.equal(gate.nativeIdentity, "PASS");
  assert.equal(gate.governorIdentity, "PASS");
  assert.equal(gate.identity, "PASS");
  assert.equal(gate.benchmarkInvalid, false);
  assert.equal(gate.quality, "FAIL");
});

test("offline summary persists and reads an invalid pair with no Governor arm", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-incomplete-pair-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: temporaryDirectory,
      runId: "20260819T120000000Z-incomplete-pair",
      requestedPairs: 5,
      authoritative: true,
      governorMode: "simulate",
      governorActive: false,
      canaryRate: 0,
      effectiveGovernorMode: "simulate",
      governorModeMatch: true,
    });
    run.appendOperation({
      operationType: "native_arm",
      pairId: "pair-01",
      caseId: "synthetic-pair-01",
      httpStatus: 200,
      streamCompleted: true,
      qualityPass: true,
      totalE2EMs: 300,
    });
    run.appendOperation({
      operationType: "governor_plan",
      pairId: "pair-01",
      caseId: "synthetic-pair-01",
      planPresent: true,
      planState: PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE,
      executable: false,
      failureClass: "NO_EXECUTABLE_TARGET",
    });
    run.appendOperation({
      operationType: "pair_complete",
      pairId: "pair-01",
      caseId: "synthetic-pair-01",
      valid: false,
      pairState: PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE,
      winner: null,
      latencyWinner: null,
      nativeOperationId: "native-pair-01",
      governorPlanOperationId: "plan-pair-01",
      governorArmOperationId: null,
      governorPlanExecutable: false,
      governorTargetIdentity: null,
      nativeHttp: 200,
      governorHttp: null,
      nativeStreamCompleted: true,
      governorStreamCompleted: false,
      nativeQualityPass: true,
      governorQualityPass: false,
      failureClass: "NO_EXECUTABLE_TARGET",
      failureReason: "NO_EXECUTABLE_TARGET",
    });

    const summary = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(summary.status, "INCOMPLETE_RUN");
    assert.equal(summary.pairsStarted, 1);
    assert.equal(summary.pairsCompleted, 1);
    assert.equal(summary.governor.plans, 1);
    assert.equal(summary.governor.executable, 0);
    assert.equal(summary.governor.requests, 0);
    assert.equal(summary.fivePairGate.pass, false);
    assert.equal(summary.fivePairGate.governorExecutable, 0);
    assert.equal(summary.accounting.governorExecutionRequests, 0);
    assert.equal(summary.effectiveGovernorMode, "simulate");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
