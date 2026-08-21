import test from "node:test";
import assert from "node:assert/strict";
import {
  assessActiveCanary,
  applyGovernorPlan,
  stableCanarySample,
  ActiveCanaryCircuitBreaker,
} from "../../../open-sse/governor/activeCanary.ts";
const plan = {
  executable: true,
  confidence: "HIGH",
  guardrailResults: {
    CAPABILITY_COMPATIBLE: "YES",
    CONTEXT_FITS: "YES",
    PROVIDER_AVAILABLE: "YES",
    QUOTA_ACCEPTABLE: "YES",
    REASONING_SUPPORTED: "YES",
    COMPRESSION_SUPPORTED: "YES",
    USER_MAX_OUTPUT_RESPECTED: "YES",
  },
  estimatedCurrentCost: 2,
  estimatedCounterfactualCost: 1,
  selectedProvider: "p2",
  selectedModel: "m2",
  maxOutputTokens: 100,
} as never;
test("kill switch and zero rate never mutate", () => {
  assert.equal(assessActiveCanary(plan, "x", { enabled: false, rate: 1 }).selected, false);
  assert.equal(assessActiveCanary(plan, "x", { enabled: true, rate: 0 }).selected, false);
});
test("eligible fixture applies only through explicit mutation boundary", () => {
  let id = "";
  for (let i = 0; i < 1000 && !stableCanarySample(String(i), 1); i++) id = String(i);
  const d = assessActiveCanary(plan, id, { enabled: true, rate: 1 });
  assert.equal(d.selected, true);
  const req = { provider: "p1", model: "m1", max_tokens: 500 };
  const snapshot = applyGovernorPlan(req, plan);
  assert.equal(snapshot.model, "m1");
  assert.equal(req.model, "m2");
});
test("breaker trips and resets", () => {
  const breaker = new ActiveCanaryCircuitBreaker(2);
  breaker.record(false);
  breaker.record(false);
  assert.equal(breaker.isTripped(), true);
  breaker.reset();
  assert.equal(breaker.isTripped(), false);
});
