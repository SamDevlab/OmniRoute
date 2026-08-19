import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GovernorTelemetry } from "../../../open-sse/governor/types.ts";
import {
  insertGovernorTelemetryRow,
  queryGovernorTelemetryRows,
} from "../../../src/lib/db/governorTelemetry.ts";
import { getDbInstance } from "../../../src/lib/db/core.ts";
import { applyGovernorToAutoComboOrder } from "../../../open-sse/governor/autoComboRuntime.ts";
import { GovernorManager } from "../../../open-sse/governor/governorManager.ts";
import { NativeOmniGovernor } from "../../../open-sse/governor/nativeGovernor.ts";
import { setGovernorActiveBreakerForTests } from "../../../open-sse/governor/activeCanary.ts";

describe("Governor Telemetry Privacy & Resilience", () => {
  it("should persist telemetry record containing only non-sensitive metadata", () => {
    const record: GovernorTelemetry = {
      correlationId: "priv-test-101",
      timestamp: Date.now(),
      governorMode: "shadow",
      actualProvider: "openai",
      actualModel: "gpt-4o-mini",
      actualRoutingStrategy: "cost_optimized",
      actualPromptTokens: 350,
      actualOutputTokens: 120,
      actualTotalTokens: 470,
      estimatedCost: 0.00015,
      latencyMs: 120,
      retryCount: 0,
      success: true,
      recommendation: {
        modelPolicy: { recommendedTier: "low" },
        routingPolicy: { strategy: "cost_optimized" },
        reasoningPolicy: { effort: "none" },
        compressionPolicy: { mode: "compact" },
        contextBudgetPolicy: { maxPromptTokens: 2000 },
        escalationPolicy: { allowedRetries: 1 },
      },
      decisionLatencyMs: 0.04,
    };

    const canaryRequest = {
      ...record,
      rawPromptText: "password=governor-secret-canary",
      apiKey: "sk-test-governor-secret-canary",
      authorization: "Bearer governor-secret-canary",
      toolOutputBody: "tool output governor-secret-canary",
      responseBody: "response SENSITIVE_RESPONSE_SENTINEL governor-secret-canary",
    } as unknown as GovernorTelemetry;

    insertGovernorTelemetryRow(canaryRequest);
    const rows = queryGovernorTelemetryRows(10);
    const matched = rows.find((r) => r.correlationId === "priv-test-101");

    assert.notEqual(matched, undefined);
    if (matched) {
      assert.equal(matched.actualProvider, "openai");
      assert.equal(matched.actualPromptTokens, 350);
      assert.equal(matched.actualTotalTokens, 470);
      // Verify no API keys, bearer tokens, or prompt body fields exist on row interface
      assert.equal((matched as unknown as Record<string, unknown>).apiKey, undefined);
      assert.equal((matched as unknown as Record<string, unknown>).promptBody, undefined);

      const serializedStored = JSON.stringify(
        getDbInstance()
          .prepare(
            "SELECT correlation_id, recommendation_json FROM governor_telemetry WHERE correlation_id = ?"
          )
          .all("priv-test-101")
      );
      assert.equal(serializedStored.includes("governor-secret-canary"), false);
      assert.equal(serializedStored.includes("SENSITIVE_RESPONSE_SENTINEL"), false);
      assert.equal(serializedStored.includes("sk-test-governor-secret-canary"), false);
      assert.equal(serializedStored.includes("Bearer governor-secret-canary"), false);
    }
  });

  it("real active runtime keeps request secret canaries out of context and telemetry", async () => {
    const oldEnv = { ...process.env };
    const secretFragments = [
      "SENSITIVE_PROMPT_SENTINEL",
      "SENSITIVE_RESPONSE_SENTINEL",
      "sk-governor-final-secret",
      "Bearer governor-final-secret",
      "password=governor-final-secret",
      "cookie=governor-final-secret",
    ];
    process.env.INTELLIGENCE_GOVERNOR_MODE = "active";
    process.env.INTELLIGENCE_GOVERNOR_TELEMETRY = "true";
    process.env.GOVERNOR_ACTIVE_ENABLED = "true";
    process.env.GOVERNOR_TELEMETRY_SAMPLE_RATE = "1";
    GovernorManager.setGovernor({
      name: "privacy-active-fixture",
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
    setGovernorActiveBreakerForTests(null);
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
    const native = target("gpt-4o", "privacy-a");
    const selected = target("o3-mini", "privacy-b");

    try {
      const result = await applyGovernorToAutoComboOrder({
        body: {
          messages: [{ role: "user", content: secretFragments.join(" ") }],
          max_tokens: 800,
        },
        promptText: secretFragments.join(" "),
        estimatedInputTokens: 100,
        taskType: "chat",
        correlationId: "privacy-active-final",
        nativeSelectedTarget: native,
        orderedTargets: [native, selected],
        routableCandidates: [
          { provider: "openai", model: "gpt-4o", connectionId: "privacy-a", errorRate: 0.5 },
          { provider: "openai", model: "o3-mini", connectionId: "privacy-b", errorRate: 0 },
        ],
      });
      assert.equal(result.applied, true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const stored = getDbInstance()
        .prepare("SELECT * FROM governor_telemetry WHERE correlation_id = ?")
        .all("privacy-active-final");
      const inspected = JSON.stringify({ context: result.context, stored });
      for (const secret of secretFragments) assert.equal(inspected.includes(secret), false);
    } finally {
      GovernorManager.setGovernor(new NativeOmniGovernor());
      setGovernorActiveBreakerForTests(null);
      for (const key of Object.keys(process.env)) {
        if (!(key in oldEnv)) delete process.env[key];
      }
      Object.assign(process.env, oldEnv);
    }
  });
});
