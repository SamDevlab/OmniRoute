import test from "node:test";
import assert from "node:assert/strict";
import { getGovernorRuntimeConfig } from "../../../open-sse/governor/runtimeConfig.ts";
import { applyActiveGovernorPlan } from "../../../open-sse/governor/activeV1.ts";
import {
  ActiveCanaryCircuitBreaker,
  assessActiveCanary,
  setGovernorActiveBreakerForTests,
  stableCanarySample,
} from "../../../open-sse/governor/activeCanary.ts";
import {
  applyGovernorToAutoComboOrder,
  buildGovernorRequestOverrides,
  tryAcquireGovernorDispatchProbe,
} from "../../../open-sse/governor/autoComboRuntime.ts";
import { GovernorManager } from "../../../open-sse/governor/governorManager.ts";
import { NativeOmniGovernor } from "../../../open-sse/governor/nativeGovernor.ts";
import type { CounterfactualExecutionPlan } from "../../../open-sse/governor/counterfactual.ts";
import { buildTargetTimeoutRunner } from "../../../open-sse/services/combo/targetTimeoutRunner.ts";
import { selectCompressionPlan } from "../../../open-sse/services/compression/strategySelector.ts";
import { DEFAULT_COMPRESSION_CONFIG } from "../../../open-sse/services/compression/types.ts";

function plan(overrides: Partial<CounterfactualExecutionPlan> = {}): CounterfactualExecutionPlan {
  return {
    planVersion: "test",
    governorName: "test",
    governorVersion: "test",
    policyVersion: "v1",
    recommendedModelTier: "medium",
    selectedProvider: "p2",
    selectedModel: "m2",
    resolvedModelTier: "medium",
    routingStrategy: "cost_optimized",
    reasoningEffort: "medium",
    thinkingBudget: null,
    compressionMode: "rtk",
    contextBudget: 1000,
    maxOutputTokens: 100,
    escalationPolicy: { allowedRetries: 0 },
    estimatedCurrentCost: 2,
    estimatedCounterfactualCost: 1,
    costEstimateBasis: "ACTUAL_USAGE",
    estimatedSavings: 1,
    estimatedSavingsPercent: 50,
    tokenReductionOpportunity: 0,
    confidence: "HIGH",
    executable: true,
    unresolvedFields: [],
    guardrailResults: {
      CAPABILITY_COMPATIBLE: "YES",
      CONTEXT_FITS: "YES",
      PROVIDER_AVAILABLE: "UNKNOWN",
      QUOTA_ACCEPTABLE: "UNKNOWN",
      REASONING_SUPPORTED: "YES",
      COMPRESSION_SUPPORTED: "YES",
      USER_MAX_OUTPUT_RESPECTED: "YES",
    },
    reasons: [],
    liveActiveControl: false,
    ...overrides,
  };
}

test("runtime configuration is factual and fail-safe", () => {
  const old = { ...process.env };
  try {
    process.env.GOVERNOR_ACTIVE_ENABLED = "true";
    process.env.GOVERNOR_ACTIVE_CANARY_RATE = "0.25";
    process.env.GOVERNOR_MAX_ESTIMATED_REQUEST_COST = "1.5";
    assert.equal(getGovernorRuntimeConfig().activeEnabled, true);
    assert.equal(getGovernorRuntimeConfig().canaryRate, 0.25);
    assert.equal(getGovernorRuntimeConfig().maxEstimatedRequestCost, 1.5);

    process.env.GOVERNOR_ACTIVE_CANARY_RATE = "bad";
    process.env.GOVERNOR_MAX_ESTIMATED_REQUEST_COST = "-2";
    assert.equal(getGovernorRuntimeConfig().canaryRate, 0);
    assert.equal(getGovernorRuntimeConfig().maxEstimatedRequestCost, null);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in old)) delete process.env[key];
    }
    Object.assign(process.env, old);
  }
});

test("canary sampling is deterministic and rate bounded", () => {
  assert.equal(stableCanarySample("same-id", 0), false);
  assert.equal(stableCanarySample("same-id", 1), true);
  assert.equal(stableCanarySample("same-id", 0.37), stableCanarySample("same-id", 0.37));
  assert.equal(stableCanarySample("same-id", -1), false);
  assert.equal(stableCanarySample("same-id", 2), false);
});

test("active canary requires high confidence, known non-increasing cost and selection", () => {
  assert.deepEqual(assessActiveCanary(plan(), "id", { enabled: false, rate: 1 }), {
    selected: false,
    eligible: false,
    reason: "kill_switch",
  });
  assert.equal(assessActiveCanary(plan(), "id", { enabled: true, rate: 0 }).selected, false);
  assert.equal(assessActiveCanary(plan(), "id", { enabled: true, rate: 1 }).selected, true);
  assert.equal(
    assessActiveCanary(plan({ confidence: "MEDIUM" }), "id", { enabled: true, rate: 1 }).eligible,
    false
  );
  assert.equal(
    assessActiveCanary(plan({ estimatedCurrentCost: null }), "id", { enabled: true, rate: 1 })
      .eligible,
    false
  );
  assert.equal(
    assessActiveCanary(plan({ estimatedCurrentCost: 1, estimatedCounterfactualCost: 2 }), "id", {
      enabled: true,
      rate: 1,
    }).eligible,
    false
  );
  assert.equal(
    assessActiveCanary(plan(), "id", { enabled: true, rate: 1, maxEstimatedCost: 0.5 }).eligible,
    false
  );
});

test("runtime-resolvable availability may be unknown, but factual hard guard failure blocks", () => {
  assert.equal(assessActiveCanary(plan(), "id", { enabled: true, rate: 1 }).eligible, true);
  assert.equal(
    assessActiveCanary(
      plan({ guardrailResults: { ...plan().guardrailResults, CONTEXT_FITS: "UNKNOWN" } }),
      "id",
      { enabled: true, rate: 1 }
    ).eligible,
    false
  );
  assert.equal(
    assessActiveCanary(
      plan({ guardrailResults: { ...plan().guardrailResults, PROVIDER_AVAILABLE: "NO" } }),
      "id",
      { enabled: true, rate: 1 }
    ).eligible,
    false
  );
});

test("shared breaker primitive trips deterministically and resets", () => {
  const breaker = new ActiveCanaryCircuitBreaker(2);
  assert.equal(breaker.getState(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.getFailureCount(), 1);
  assert.equal(breaker.isTripped(), false);
  breaker.recordFailure();
  assert.equal(breaker.isTripped(), true);
  assert.equal(breaker.getState(), "open");
  breaker.reset();
  assert.equal(breaker.getFailureCount(), 0);
  assert.equal(breaker.getState(), "closed");
});

test("half-open breaker consumes only one real dispatch probe and recovers", () => {
  let now = 1;
  const breaker = new ActiveCanaryCircuitBreaker(1, 100, () => now);
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
  now = 101;
  assert.equal(breaker.getState(), "half-open");
  assert.equal(breaker.isHalfOpenProbeInFlight(), false, "eligibility exits consume no probe");
  assert.equal(breaker.tryAcquireActiveAttempt(), true);
  assert.equal(breaker.isHalfOpenProbeInFlight(), true);
  assert.equal(breaker.tryAcquireActiveAttempt(), false, "concurrent probe is rejected");
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "closed");
  assert.equal(breaker.getFailureCount(), 0);
});

test("failed half-open probe reopens and restarts cooldown", () => {
  let now = 1;
  const breaker = new ActiveCanaryCircuitBreaker(1, 100, () => now);
  breaker.recordFailure();
  now = 101;
  assert.equal(breaker.tryAcquireActiveAttempt(), true);
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
  now = 200;
  assert.equal(breaker.getState(), "open");
  now = 201;
  assert.equal(breaker.getState(), "half-open");
});

test("half-open probe is not consumed by any no-dispatch eligibility exit", () => {
  let now = 1;
  const breaker = new ActiveCanaryCircuitBreaker(1, 100, () => now);
  breaker.recordFailure();
  now = 101;

  const eligible = {
    activeSelected: true,
    planExecutable: true,
    selectedTargetAvailable: true,
    controlsPermitTarget: true,
    differsFromNativeTarget: true,
  };
  const exits = [
    { ...eligible, activeSelected: false },
    { ...eligible, planExecutable: false },
    { ...eligible, selectedTargetAvailable: false },
    { ...eligible, controlsPermitTarget: false },
    { ...eligible, differsFromNativeTarget: false },
  ];

  for (const exit of exits) {
    assert.equal(tryAcquireGovernorDispatchProbe(breaker, exit), false);
    assert.equal(breaker.getState(), "half-open");
    assert.equal(breaker.isHalfOpenProbeInFlight(), false);
  }

  assert.equal(tryAcquireGovernorDispatchProbe(breaker, eligible), true);
  assert.equal(breaker.isHalfOpenProbeInFlight(), true);
  assert.equal(tryAcquireGovernorDispatchProbe(breaker, eligible), false);
});

test("real active runtime acquires the half-open probe only for governed B dispatch", async () => {
  const oldEnv = { ...process.env };
  let now = 1;
  const breaker = new ActiveCanaryCircuitBreaker(1, 100, () => now);
  breaker.recordFailure();
  now = 101;
  setGovernorActiveBreakerForTests(breaker);
  GovernorManager.setGovernor({
    name: "runtime-closure-fixture",
    version: "1",
    decide: () => ({
      modelPolicy: { recommendedTier: "high" },
      routingPolicy: { strategy: "cost_optimized" },
      reasoningPolicy: { effort: "medium" },
      compressionPolicy: { mode: "rtk" },
      contextBudgetPolicy: { maxPromptTokens: 1_000 },
      maxOutputTokens: 100,
      escalationPolicy: { allowedRetries: 0 },
    }),
  });
  process.env.INTELLIGENCE_GOVERNOR_MODE = "active";
  process.env.GOVERNOR_ACTIVE_ENABLED = "true";
  process.env.GOVERNOR_CONTROL_MODEL = "true";
  process.env.GOVERNOR_CONTROL_PROVIDER = "true";

  const target = (model: string, executionKey: string) => ({
    kind: "model" as const,
    stepId: executionKey,
    executionKey,
    modelStr: `openai/${model}`,
    provider: "openai",
    providerId: null,
    connectionId: executionKey,
    weight: 1,
    label: null,
  });
  const native = target("gpt-4o", "a");
  const governed = target("o3-mini", "b");
  const input = {
    body: { messages: [{ role: "user", content: "x" }], max_tokens: 800 },
    promptText: "x",
    estimatedInputTokens: 100,
    taskType: "chat",
    correlationId: "runtime-half-open-real-dispatch",
    nativeSelectedTarget: native,
    orderedTargets: [native, governed],
    routableCandidates: [
      { provider: "openai", model: "gpt-4o", connectionId: "a", errorRate: 0.5 },
      { provider: "openai", model: "o3-mini", connectionId: "b", errorRate: 0 },
    ],
  };

  try {
    const first = await applyGovernorToAutoComboOrder(input);
    assert.equal(first.applied, true);
    assert.equal(first.context?.activeSelected, true);
    assert.equal(first.context?.activeApplied, true);
    assert.equal(first.context?.originalRoute.provider, "openai");
    assert.equal(first.context?.originalRoute.model, "gpt-4o");
    assert.equal(first.context?.selectedRoute?.provider, "openai");
    assert.equal(first.context?.selectedRoute?.model, "o3-mini");
    assert.equal(first.context?.bypassReason, undefined);
    assert.equal(first.context?.selectedDispatchCount, 0);
    assert.equal(first.context?.fallbackDispatchCount, 0);
    assert.equal(first.context?.fallbackAttempted, false);
    assert.equal(first.context?.fallbackSucceeded, false);
    assert.equal(first.orderedTargets[0].executionKey, "b");
    assert.equal(first.selectedExecutionKey, "b");
    assert.deepEqual(
      first.orderedTargets.map((target) => target.executionKey),
      ["b", "a"]
    );
    assert.equal(new Set(first.orderedTargets.map((target) => target.executionKey)).size, 2);
    assert.equal(breaker.isHalfOpenProbeInFlight(), true);
    assert.deepEqual(first.requestOverrides, {
      reasoning_effort: "medium",
      max_tokens: 100,
      __omnirouteGovernorCompressionPreference: "rtk",
    });

    const selectedAttempt = {
      ...first.orderedTargets[0],
      governorSelected: true,
      governorRequestOverrides: { ...first.requestOverrides },
    };
    const fallbackAttempt = first.orderedTargets[1];
    const finalBodies: Array<Record<string, unknown>> = [];
    const localCompressionModes: string[] = [];
    const run = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 0,
      log: { info() {}, warn() {}, debug() {} },
      handleSingleModel: async (attemptBody, model) => {
        localCompressionModes.push(
          selectCompressionPlan(
            { ...DEFAULT_COMPRESSION_CONFIG, enabled: true, defaultMode: "off" },
            null,
            500,
            attemptBody
          ).mode
        );
        delete attemptBody.__omnirouteGovernorCompressionPreference;
        finalBodies.push(attemptBody);
        return new Response(null, { status: model.includes("o3-mini") ? 503 : 200 });
      },
    });
    assert.equal((await run(input.body, selectedAttempt.modelStr, selectedAttempt)).status, 503);
    assert.equal((await run(input.body, fallbackAttempt.modelStr, fallbackAttempt)).status, 200);
    assert.deepEqual(localCompressionModes, ["rtk", "off"]);
    assert.equal(finalBodies[0].reasoning_effort, "medium");
    assert.equal(finalBodies[0].max_tokens, 100);
    assert.equal("__omnirouteGovernorCompressionPreference" in finalBodies[0], false);
    assert.equal(finalBodies[1], input.body);
    assert.equal("reasoning_effort" in finalBodies[1], false);
    assert.equal(finalBodies[1].max_tokens, 800);
    assert.equal("__omnirouteGovernorCompressionPreference" in finalBodies[1], false);

    const second = await applyGovernorToAutoComboOrder({
      ...input,
      correlationId: "runtime-half-open-concurrent-dispatch",
    });
    assert.equal(second.applied, false);
    assert.equal(second.context?.bypassReason, "governor_breaker_open");
    assert.equal(second.orderedTargets[0].executionKey, "a");
  } finally {
    GovernorManager.setGovernor(new NativeOmniGovernor());
    setGovernorActiveBreakerForTests(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in oldEnv)) delete process.env[key];
    }
    Object.assign(process.env, oldEnv);
  }
});

test("request control precedence preserves explicit reasoning and never widens output", () => {
  const config = {
    activeEnabled: true,
    canaryRate: 1,
    maxEstimatedRequestCost: null,
    controlModel: true,
    controlProvider: true,
    controlReasoning: true,
    controlCompression: true,
    controlOutput: true,
    breakerFailureThreshold: 3,
    breakerCooldownMs: 30_000,
  };
  assert.deepEqual(
    buildGovernorRequestOverrides(
      { reasoning_effort: "low", max_tokens: 50 },
      plan({ maxOutputTokens: 100 }),
      config
    ),
    {
      max_tokens: 50,
      __omnirouteGovernorCompressionPreference: "rtk",
    }
  );
  assert.deepEqual(
    buildGovernorRequestOverrides({ max_tokens: 800 }, plan(), {
      ...config,
      controlReasoning: false,
      controlCompression: false,
      controlOutput: false,
    }),
    {}
  );
});

test("explicit compression override and master-off beat Governor preference", () => {
  const body = {
    messages: [{ role: "user", content: "x" }],
    __omnirouteGovernorCompressionPreference: "rtk",
  };
  const config = { ...DEFAULT_COMPRESSION_CONFIG, enabled: true, defaultMode: "off" as const };
  assert.equal(selectCompressionPlan(config, null, 100, body).mode, "rtk");
  assert.equal(selectCompressionPlan(config, null, 100, body, undefined, {}, "off").mode, "off");
  assert.equal(selectCompressionPlan({ ...config, enabled: false }, null, 100, body).mode, "off");
});

test("precommit fallback receives original body after governed attempt fails", async () => {
  const original = {
    reasoning_effort: "low",
    max_tokens: 800,
    messages: [{ role: "user", content: "x" }],
  };
  const captured: Array<Record<string, unknown>> = [];
  const run = buildTargetTimeoutRunner({
    comboTargetTimeoutMs: 0,
    log: { info() {}, warn() {}, debug() {} },
    handleSingleModel: async (attemptBody, model) => {
      captured.push(attemptBody);
      return new Response(null, { status: model === "p2/m2" ? 500 : 200 });
    },
  });
  const governed = {
    kind: "model" as const,
    stepId: "b",
    executionKey: "b",
    modelStr: "p2/m2",
    provider: "p2",
    providerId: null,
    connectionId: "b-connection",
    weight: 1,
    label: null,
    governorSelected: true,
    governorRequestOverrides: {
      reasoning_effort: "medium",
      max_tokens: 100,
      __omnirouteGovernorCompressionPreference: "rtk",
    },
  };
  const native = {
    kind: "model" as const,
    stepId: "a",
    executionKey: "a",
    modelStr: "p1/m1",
    provider: "p1",
    providerId: null,
    connectionId: "a-connection",
    weight: 1,
    label: null,
  };
  assert.equal((await run(original, governed.modelStr, governed)).status, 500);
  assert.equal((await run(original, native.modelStr, native)).status, 200);
  assert.equal(captured[0].reasoning_effort, "medium");
  assert.equal(captured[0].max_tokens, 100);
  assert.equal(captured[1], original);
  assert.equal(captured[1].reasoning_effort, "low");
  assert.equal(captured[1].max_tokens, 800);
  assert.equal("__omnirouteGovernorCompressionPreference" in captured[1], false);
});

test("reasoning and compression controls apply only when enabled", () => {
  const request = {
    provider: "p1",
    model: "m1",
    reasoning: "original",
    compression: "original",
  };
  const result = applyActiveGovernorPlan(request, plan(), "id", {
    enabled: true,
    controlModel: false,
    controlProvider: false,
    controlReasoning: true,
    controlCompression: true,
    controlOutput: false,
  });
  assert.equal(result.applied, true);
  assert.equal(request.provider, "p1");
  assert.equal(request.model, "m1");
  assert.equal(request.reasoning, "medium");
  assert.equal(request.compression, "rtk");
});
