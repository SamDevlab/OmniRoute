import test from "node:test";
import assert from "node:assert/strict";
import { applyActiveGovernorPlan } from "../../../open-sse/governor/activeV1.ts";
const plan = {
  executable: true,
  confidence: "HIGH",
  guardrailResults: { all: "YES" },
  estimatedCurrentCost: 2,
  estimatedCounterfactualCost: 1,
  selectedProvider: "p2",
  selectedModel: "m2",
  maxOutputTokens: 100,
} as never;
test("active V1 is opt-in and respects control dimensions", () => {
  const request = { provider: "p1", model: "m1", max_tokens: 500 };
  assert.equal(
    applyActiveGovernorPlan(request, plan, "id", {
      enabled: false,
      controlModel: true,
      controlProvider: true,
      controlReasoning: false,
      controlCompression: false,
      controlOutput: true,
    }).applied,
    false
  );
  const result = applyActiveGovernorPlan(request, plan, "id", {
    enabled: true,
    controlModel: true,
    controlProvider: true,
    controlReasoning: false,
    controlCompression: false,
    controlOutput: true,
  });
  assert.equal(result.applied, true);
  assert.equal(request.model, "m2");
  assert.equal(request.max_tokens, 100);
});
