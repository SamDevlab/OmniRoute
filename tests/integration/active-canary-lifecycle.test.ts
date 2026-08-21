import test from "node:test";
import assert from "node:assert/strict";
import { assessActiveCanary, applyGovernorPlan } from "../../open-sse/governor/activeCanary.ts";

test("mock request lifecycle applies eligible canary once and falls back on failure", async () => {
  const plan = {
    executable: true,
    confidence: "HIGH",
    guardrailResults: { all: "YES" },
    estimatedCurrentCost: 2,
    estimatedCounterfactualCost: 1,
    selectedProvider: "candidate",
    selectedModel: "candidate-model",
    maxOutputTokens: 100,
  } as never;
  const request = { provider: "original", model: "original-model", max_tokens: 500 };
  const original = { ...request };
  const decision = assessActiveCanary(plan, "fixture", { enabled: true, rate: 1 });
  assert.equal(decision.selected, true);
  applyGovernorPlan(request, plan);
  assert.equal(request.model, "candidate-model");
  await Promise.resolve();
  Object.assign(request, original);
  assert.deepEqual(request, original);
});
