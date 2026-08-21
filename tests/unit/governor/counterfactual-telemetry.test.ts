import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-counterfactual-telemetry-"));
process.env.DATA_DIR = dir;
const { ensureDbInitialized, resetDbInstance } = await import("../../../src/lib/db/core.ts");
await ensureDbInitialized();
const { insertGovernorTelemetryRow, queryGovernorTelemetryRows } =
  await import("../../../src/lib/db/governorTelemetry.ts");
test("simulate plan metadata survives telemetry round trip", async () => {
  insertGovernorTelemetryRow({
    correlationId: "cf-roundtrip",
    timestamp: 1,
    governorMode: "simulate",
    actualProvider: "p",
    actualModel: "m",
    actualPromptTokens: null,
    actualOutputTokens: null,
    actualTotalTokens: null,
    latencyMs: null,
    retryCount: null,
    success: null,
    recommendation: {} as never,
    decisionLatencyMs: 0,
    counterfactualPlan: { planVersion: "3a-v0", executable: false, confidence: "LOW" },
  });
  const row = queryGovernorTelemetryRows(10).find((item) => item.correlationId === "cf-roundtrip");
  assert.equal(row?.governorMode, "simulate");
  assert.equal((row?.counterfactualPlan as { planVersion: string }).planVersion, "3a-v0");
});
test.after(() => {
  resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
