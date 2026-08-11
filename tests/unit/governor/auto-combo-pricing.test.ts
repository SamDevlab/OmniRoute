import assert from "node:assert/strict";
import test from "node:test";
import { resolveGovernorPricingEvidence } from "../../../open-sse/governor/autoComboRuntime.ts";
import {
  resolveCounterfactualPlan,
  type CounterfactualInput,
} from "../../../open-sse/governor/counterfactual.ts";
import { NativeOmniGovernor } from "../../../open-sse/governor/nativeGovernor.ts";

test("explicit pricing remains authoritative", async () => {
  const result = await resolveGovernorPricingEvidence("fixture", "paid-model", {
    input: 1.25,
    output: 4.5,
  });
  assert.deepEqual(result, { pricing: { input: 1.25, output: 4.5 }, pricingKnown: true });
});

test("OpenCode free classification supplies known zero pricing", async () => {
  const result = await resolveGovernorPricingEvidence("opencode", "big-pickle");
  assert.deepEqual(result, { pricing: { input: 0, output: 0 }, pricingKnown: true });
});

test("Felo free classification supplies known zero pricing", async () => {
  const result = await resolveGovernorPricingEvidence("felo-web", "felo-chat");
  assert.deepEqual(result, { pricing: { input: 0, output: 0 }, pricingKnown: true });
});

test("unknown provider remains unknown instead of becoming free", async () => {
  const result = await resolveGovernorPricingEvidence("unknown-provider", "unknown-model");
  assert.deepEqual(result, { pricing: null, pricingKnown: false });
});

test("paid model without pricing never receives zero pricing", async () => {
  const result = await resolveGovernorPricingEvidence("openai", "unlisted-paid-model");
  assert.notDeepEqual(result.pricing, { input: 0, output: 0 });
  assert.equal(result.pricingKnown, false);
});

test("known free candidate can be executable in the counterfactual planner", () => {
  const input: CounterfactualInput = {
    taskKind: "trivial_control",
    estimatedPromptTokens: 50,
    requestedMaxOutput: 1000,
    actualInputTokens: 50,
    actualOutputTokens: 100,
    currentCost: 0,
    currentProvider: "opencode",
    currentModel: "big-pickle",
    candidates: [
      {
        provider: "opencode",
        model: "deepseek-v4-flash-free",
        routingModelId: "oc/deepseek-v4-flash-free",
        tier: "low",
        available: true,
        contextWindow: 128000,
        capabilities: ["streaming"],
        inputPrice: 0,
        outputPrice: 0,
        supportsReasoning: true,
        supportsCompression: ["compact", "caveman", "rtk", "none"],
        quotaState: "normal",
      },
    ],
  };
  const plan = resolveCounterfactualPlan(input, new NativeOmniGovernor().decide(input));
  assert.equal(plan.estimatedCounterfactualCost, 0);
  assert.equal(plan.confidence, "HIGH");
  assert.equal(plan.executable, true);
  assert.equal(plan.unresolvedFields.includes("pricingOrUsage"), false);
});
