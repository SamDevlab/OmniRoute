import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import {
  makeNativeBaselineTestSnapshot,
  nativeBaselineRequest,
  nativeBaselineStateDigest,
  resolveNativeBaselineWithoutExecution,
} from "../../scripts/ad-hoc/omniroute-governor-native-baseline.mjs";
import {
  createBenchmarkRun,
  summarizeBenchmarkRun,
} from "../../scripts/ad-hoc/omniroute-governor-benchmark-persistence.mjs";
import { evaluatePairState } from "../../scripts/ad-hoc/omniroute-governor-pair-state.mjs";

function target(executionKey: string, provider: string, model: string, connectionId: string) {
  return {
    kind: "model" as const,
    stepId: executionKey,
    executionKey,
    modelStr: `${provider}/${model}`,
    provider,
    providerId: provider,
    connectionId,
    allowedConnectionIds: [connectionId],
    weight: 1,
    label: executionKey,
  };
}

function candidate(
  executionKey: string,
  provider: string,
  model: string,
  connectionId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    stepId: executionKey,
    executionKey,
    modelStr: `${provider}/${model}`,
    provider,
    model,
    connectionId,
    quotaRemaining: 100,
    quotaTotal: 100,
    quotaCutoffBlocked: false,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    failureRate: 0,
    reliabilityObserved: true,
    accountTier: "standard",
    quotaResetIntervalSecs: 86400,
    contextAffinity: 0,
    cacheAffinity: 0,
    resetWindowAffinity: 0.5,
    connectionPoolSize: 1,
    ...overrides,
  };
}

async function fixtureSnapshot() {
  const targets = [
    target("openai-1", "openai", "gpt-4o-mini", "conn-openai"),
    target("anthropic-1", "anthropic", "claude-3-haiku", "conn-anthropic"),
  ];
  const candidates = [
    candidate("openai-1", "openai", "gpt-4o-mini", "conn-openai", {
      p95LatencyMs: 40,
      errorRate: 0.01,
    }),
    candidate("anthropic-1", "anthropic", "claude-3-haiku", "conn-anthropic", {
      p95LatencyMs: 160,
      errorRate: 0.2,
    }),
  ];
  return makeNativeBaselineTestSnapshot({
    targets,
    candidates,
    metadata: [
      {
        provider: "openai",
        model: "gpt-4o-mini",
        capabilities: { tools: true, structuredOutput: true, vision: true },
      },
      {
        provider: "anthropic",
        model: "claude-3-haiku",
        capabilities: { tools: true, structuredOutput: true, vision: false },
      },
    ],
    connectionState: new Map([
      ["conn-openai", { provider: "openai", active: true, testStatus: null }],
      ["conn-anthropic", { provider: "anthropic", active: true, testStatus: null }],
    ]),
    breakers: {
      openai: { state: "CLOSED" },
      anthropic: { state: "CLOSED" },
    },
    cooldowns: [],
    lockouts: [],
  });
}

test("Native baseline uses production Auto ordering without network or home-state mutation", async () => {
  const snapshot = await fixtureSnapshot();
  const before = nativeBaselineStateDigest(snapshot);
  const result = resolveNativeBaselineWithoutExecution({
    snapshot,
    request: nativeBaselineRequest("fixture-1", "Reply with exactly BASELINE-OK."),
  });
  const after = nativeBaselineStateDigest(snapshot);

  assert.equal(result.valid, true);
  assert.equal(result.nativeBaselineResolution, "side_effect_free");
  assert.equal(result.resolverFunction, "resolveAutoStrategyOrder");
  assert.equal(result.resolverModule, "open-sse/services/combo/resolveAutoStrategy.ts");
  assert.equal(result.networkCalls, 0);
  assert.equal(result.providerModelRequests, 0);
  assert.equal(result.routingStateMutation, false);
  assert.equal(before, after);
  assert.equal(result.baselineSnapshotId, snapshot.snapshotId);
  assert.equal(result.baselineSnapshotHash, snapshot.baselineSnapshotHash);
  assert.equal(result.nativeBaselineTarget, "openai-1");
  assert.equal(result.nativeBaselineProvider, "openai");
  assert.equal(result.nativeBaselineModel, "gpt-4o-mini");
  assert.equal(result.nativeBaselineConnection, "conn-openai");
  assert.deepEqual(
    result.nativeBaselineCandidateOrder.map((entry) => entry.executionKey),
    ["openai-1", "anthropic-1"]
  );
});

test("baseline snapshot preserves provider/model/connection and resilience sentinels", async () => {
  const snapshot = await fixtureSnapshot();
  assert.equal(snapshot.targets.length, 2);
  assert.equal(snapshot.candidates.length, 2);
  assert.ok(snapshot.capabilities["openai/gpt-4o-mini"]);
  assert.deepEqual(snapshot.cooldowns, []);
  assert.deepEqual(snapshot.lockouts, []);
  assert.equal(snapshot.breakers.openai.state, "CLOSED");
  assert.equal(snapshot.connections["conn-openai"].active, true);
  assert.equal(snapshot.routingConfig.combo.autoConfig.routerStrategy, "rules");
  assert.equal(snapshot.routingConfig.config.compatFilterFailOpen, false);
  assert.ok(snapshot.snapshotId.startsWith("native-baseline-"));
  assert.equal(snapshot.baselineSnapshotHash.length, 64);
});

test("offline summary counts side-effect-free baselines and zero provider/model preflights", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-native-baseline-summary-"));
  try {
    const run = createBenchmarkRun({
      rootDirectory: root,
      runId: "20260819T120000000Z-baseline",
      requestedPairs: 1,
      authoritative: true,
      governorMode: "simulate",
      governorActive: false,
      canaryRate: 0,
    });
    run.appendOperation({
      operationType: "native_baseline_resolution",
      caseId: "fixture-1",
      nativeBaselineTarget: "openai-1",
      nativeBaselineResolution: "side_effect_free",
      providerModelRequests: 0,
      governorProviderModelPreflightRequests: 0,
      networkCalls: 0,
      routingStateMutation: false,
    });
    run.appendOperation({
      operationType: "native_arm",
      pairId: "pair-01",
      caseId: "fixture-1",
      httpStatus: 200,
      streamCompleted: true,
      qualityPass: true,
      totalE2EMs: 10,
      executedTarget: "openai/gpt-4o-mini",
    });
    run.appendOperation({
      operationType: "governor_plan",
      pairId: "pair-01",
      caseId: "fixture-1",
      executable: true,
      planningMs: 1,
    });
    run.appendOperation({
      operationType: "governor_arm",
      pairId: "pair-01",
      caseId: "fixture-1",
      httpStatus: 200,
      streamCompleted: true,
      qualityPass: true,
      totalE2EMs: 12,
      plannedTarget: "openai/gpt-4o-mini",
    });
    run.appendOperation({
      operationType: "pair_complete",
      pairId: "pair-01",
      caseId: "fixture-1",
      valid: true,
      nativeHttp: 200,
      governorHttp: 200,
      nativeStreamCompleted: true,
      governorStreamCompleted: true,
      nativeQualityPass: true,
      governorQualityPass: true,
      governorPlanExecutable: true,
    });

    const summary = summarizeBenchmarkRun(run.runDirectory);
    assert.equal(summary.accounting.nativeBaselineResolutions, 1);
    assert.equal(summary.accounting.nativePreflightRequests, 0);
    assert.equal(summary.accounting.nativeBaselineProviderModelRequests, 0);
    assert.equal(summary.accounting.governorProviderModelPreflightRequests, 0);
    assert.equal(summary.accounting.physicalAuthoritativeRequests, 2);
    assert.equal(summary.accounting.physicalRequestsIncludingPreflight, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline drift and an unproven first actual are hard methodological failures", () => {
  const native = {
    request: { status: 200, streamCompleted: true, qualityPass: true },
    nativeFirstActualTarget: "provider/first",
    nativeFinalActualTarget: "provider/final",
    targetIdentity: "PASS",
  };
  const governor = {
    planState: { state: "PLAN_EXECUTABLE", executable: true },
    direct: { status: 200, streamCompleted: true, qualityPass: true },
    targetIdentity: "PASS",
  };
  const drift = evaluatePairState({
    native,
    governor,
    baseline: { nativeBaselineTarget: "provider/other" },
  });
  assert.equal(drift.failureReason, "NATIVE_BASELINE_DRIFT");
  assert.equal(drift.stopBenchmark, true);

  const unproven = evaluatePairState({
    native: { ...native, nativeFirstActualTarget: null },
    governor,
    baseline: { nativeBaselineTarget: "provider/first" },
  });
  assert.equal(unproven.failureReason, "NATIVE_BASELINE_FIRST_ACTUAL_UNPROVEN");
  assert.equal(unproven.stopBenchmark, true);

  const fallback = evaluatePairState({
    native: { ...native, nativeFinalActualTarget: "provider/fallback" },
    governor,
    baseline: { nativeBaselineTarget: "provider/first" },
  });
  assert.equal(fallback.valid, true);
  assert.equal(fallback.failureClass, null);
});
