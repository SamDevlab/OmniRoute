import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGovernorStreamOutcome,
  elapsedMilliseconds,
} from "../../../open-sse/governor/streamOutcome.ts";
import {
  insertGovernorTelemetryRow,
  queryGovernorTelemetryRows,
  updateGovernorTelemetryOutcome,
} from "../../../src/lib/db/governorTelemetry.ts";
import type { GovernorTelemetry } from "../../../open-sse/governor/types.ts";

test("HTTP 200 with terminal upstream errors is not success", () => {
  assert.equal(classifyGovernorStreamOutcome(200), "SUCCESS");
  assert.equal(classifyGovernorStreamOutcome(429), "UPSTREAM_429");
  assert.equal(classifyGovernorStreamOutcome(401), "UPSTREAM_401");
  assert.equal(
    classifyGovernorStreamOutcome(200, "provider rate limit", "upstream_429"),
    "UPSTREAM_429"
  );
});

test("latency helper preserves milliseconds", async () => {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const elapsed = elapsedMilliseconds(start, performance.now());
  assert.ok(elapsed >= 90 && elapsed < 250, `expected roughly 100ms, got ${elapsed}`);
});

test("terminal outcome enriches one pre-dispatch telemetry correlation", async () => {
  const correlationId = `observability-${Date.now()}-${Math.random()}`;
  const row: GovernorTelemetry = {
    correlationId,
    timestamp: Date.now(),
    governorMode: "simulate",
    actualProvider: "unknown",
    actualModel: "unknown",
    actualPromptTokens: null,
    actualOutputTokens: null,
    actualTotalTokens: null,
    latencyMs: null,
    retryCount: null,
    success: null,
    recommendation: {
      modelPolicy: { recommendedTier: "low" },
      routingPolicy: { strategy: "cost_optimized" },
      reasoningPolicy: { effort: "none" },
      compressionPolicy: { mode: "compact" },
      contextBudgetPolicy: { maxPromptTokens: 2000 },
      maxOutputTokens: 128,
      escalationPolicy: { allowedRetries: 1 },
    },
    decisionLatencyMs: 1,
  };
  insertGovernorTelemetryRow(row);
  updateGovernorTelemetryOutcome(correlationId, {
    actualProvider: "felo",
    actualModel: "felo-chat",
    actualPromptTokens: 10,
    actualOutputTokens: 3,
    actualTotalTokens: 13,
    latencyMs: 101,
    success: false,
    errorCategory: "UPSTREAM_429",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = queryGovernorTelemetryRows(100).filter(
    (item) => item.correlationId === correlationId
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].errorCategory, "UPSTREAM_429");
  assert.equal(rows[0].actualTotalTokens, 13);
});
