import assert from "node:assert/strict";
import test from "node:test";
import { NativeOmniGovernor } from "../../../open-sse/governor/nativeGovernor.ts";
import type { CompressionMode } from "../../../open-sse/governor/types.ts";
import {
  resolveCounterfactualPlan,
  type CounterfactualInput,
} from "../../../open-sse/governor/counterfactual.ts";

const candidate = {
  provider: "fixture-provider",
  model: "fixture-model",
  tier: "low" as const,
  available: true,
  capabilities: ["tools", "streaming"],
  contextWindow: 128000,
  inputPrice: 1,
  outputPrice: 2,
  supportsReasoning: true,
  supportsCompression: ["compact", "caveman", "rtk", "none"] as CompressionMode[],
  quotaState: "normal" as const,
};
function base(overrides: Partial<CounterfactualInput> = {}): CounterfactualInput {
  return {
    taskKind: "trivial_control",
    estimatedPromptTokens: 50,
    requestedMaxOutput: 1000,
    actualInputTokens: 50,
    actualOutputTokens: 100,
    currentCost: 0.001,
    candidates: [candidate],
    ...overrides,
  };
}

test("counterfactual planner is deterministic and record-only", () => {
  const governor = new NativeOmniGovernor();
  const input = base();
  const decision = governor.decide(input);
  const a = resolveCounterfactualPlan(input, decision);
  const b = resolveCounterfactualPlan(input, decision);
  assert.deepEqual(a, b);
  assert.equal(a.liveActiveControl, false);
  assert.equal(a.executable, true);
});

test("capability guardrail prevents an actionable plan", () => {
  const input = base({ requiredCapabilities: ["vision"] });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.executable, false);
  assert.equal(plan.guardrailResults.CAPABILITY_COMPATIBLE, "NO");
});

test("unknown pricing or usage never becomes zero savings", () => {
  const input = base({ actualInputTokens: null, actualOutputTokens: null, currentCost: null });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.estimatedSavings, null);
  assert.equal(plan.estimatedCounterfactualCost, null);
});

test("explicit output maximum is never exceeded", () => {
  const input = base({ requestedMaxOutput: 200 });
  const decision = { ...new NativeOmniGovernor().decide(input), maxOutputTokens: 99999 };
  assert.equal(resolveCounterfactualPlan(input, decision).maxOutputTokens, 200);
});

test("unavailable providers are not actionable", () => {
  const input = base({ candidates: [{ ...candidate, available: false }] });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.executable, false);
  assert.equal(plan.estimatedSavings, null);
});

test("observed healthy candidate beats a degraded preferred tier", () => {
  const input = base({
    candidates: [
      {
        ...candidate,
        provider: "candidate-a",
        model: "stable-model",
        tier: "high",
        healthScore: 1,
        inputPrice: 1,
        outputPrice: 2,
      },
      {
        ...candidate,
        provider: "candidate-b",
        model: "recently-failed-free-model",
        tier: "low",
        healthScore: 0,
        inputPrice: 0,
        outputPrice: 0,
      },
    ],
  });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.selectedProvider, "candidate-a");
  assert.equal(plan.selectedModel, "stable-model");
  assert.equal(plan.resolvedModelTier, "high");
  assert.equal(plan.executable, true);
});

test("known-free healthy candidate still wins when the preferred tier is healthy", () => {
  const input = base({
    candidates: [
      {
        ...candidate,
        provider: "candidate-a",
        model: "stable-paid-model",
        tier: "high",
        healthScore: 1,
      },
      {
        ...candidate,
        provider: "candidate-b",
        model: "stable-free-model",
        tier: "low",
        healthScore: 0.95,
        inputPrice: 0,
        outputPrice: 0,
      },
    ],
  });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.selectedProvider, "candidate-b");
  assert.equal(plan.estimatedCounterfactualCost, 0);
});

test("missing reliability telemetry is neutral instead of optimistic-best", () => {
  const input = base({
    candidates: [
      {
        ...candidate,
        provider: "candidate-a",
        model: "unobserved-free-model",
        tier: "low",
        healthScore: undefined,
        inputPrice: 0,
        outputPrice: 0,
      },
      {
        ...candidate,
        provider: "candidate-b",
        model: "observed-model",
        tier: "high",
        healthScore: 0.7,
      },
    ],
  });
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.selectedProvider, "candidate-b");
});

test("recovered preferred candidate becomes rankable again", () => {
  const stable = {
    ...candidate,
    provider: "candidate-a",
    model: "stable-model",
    tier: "high" as const,
    healthScore: 1,
  };
  const preferred = {
    ...candidate,
    provider: "candidate-b",
    model: "recovered-free-model",
    tier: "low" as const,
    inputPrice: 0,
    outputPrice: 0,
  };
  const decision = new NativeOmniGovernor().decide(base());
  const before = resolveCounterfactualPlan(
    base({ candidates: [{ ...preferred, healthScore: 0 }, stable] }),
    decision
  );
  const after = resolveCounterfactualPlan(
    base({ candidates: [{ ...preferred, healthScore: 0.9 }, stable] }),
    decision
  );
  assert.equal(before.selectedProvider, "candidate-a");
  assert.equal(after.selectedProvider, "candidate-b");
});
