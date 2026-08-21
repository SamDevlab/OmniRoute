import test from "node:test";
import assert from "node:assert/strict";
import { calibratePolicy } from "../../../open-sse/governor/calibration.ts";
test("calibration is deterministic and does not self-modify policy", () => {
  const a = calibratePolicy([
    { success: true, currentCost: 1, counterfactualCost: 0.5, confidence: "HIGH", fallback: false },
  ]);
  const b = calibratePolicy([
    { success: true, currentCost: 1, counterfactualCost: 0.5, confidence: "HIGH", fallback: false },
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.policyVersion, "v1");
  assert.equal(a.evidence, "INSUFFICIENT_DATA");
});
