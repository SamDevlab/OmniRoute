/**
 * src/lib/db/governorTelemetry.ts
 *
 * Database persistence layer for Intelligence Governor telemetry.
 * Stores non-blocking metadata evaluation rows in the local SQLite database.
 *
 * PRIVACY GUARANTEE:
 * - NO API keys, bearer tokens, or authorization headers are stored.
 * - NO prompt bodies or model output content are stored.
 * - Stores metadata metrics ONLY.
 *
 * RESILIENCE GUARANTEE:
 * - Database write failures are caught silently.
 * - Telemetry failure MUST NEVER fail an AI request.
 */

import type { GovernorTelemetry } from "@omniroute/open-sse/governor/types.ts";
import { getDbInstance } from "./core";

const MAX_PENDING_TELEMETRY = 256;
const pendingTelemetry: GovernorTelemetry[] = [];
let flushScheduled = false;
const pendingOutcomes = new Map<string, Partial<GovernorTelemetry>>();
const queueMetrics = {
  queued: 0,
  persisted: 0,
  sampledOut: 0,
  queueDropped: 0,
  persistenceFailures: 0,
  highWaterMark: 0,
};

export function getGovernorTelemetryQueueMetrics() {
  return {
    ...queueMetrics,
    dropped: queueMetrics.queueDropped,
    pending: pendingTelemetry.length,
    maxPending: MAX_PENDING_TELEMETRY,
  };
}

export function shouldSampleGovernorTelemetry(correlationId: string): boolean {
  const raw = process.env.GOVERNOR_TELEMETRY_SAMPLE_RATE;
  const rate = raw == null ? 1 : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 2166136261;
  for (const char of correlationId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 0xffffffff < rate;
}

export function enqueueGovernorTelemetryRow(row: GovernorTelemetry): void {
  if (
    !shouldSampleGovernorTelemetry(row.correlationId) ||
    pendingTelemetry.length >= MAX_PENDING_TELEMETRY
  ) {
    if (!shouldSampleGovernorTelemetry(row.correlationId)) queueMetrics.sampledOut += 1;
    else queueMetrics.queueDropped += 1;
    return;
  }
  pendingTelemetry.push(row);
  queueMetrics.queued += 1;
  queueMetrics.highWaterMark = Math.max(queueMetrics.highWaterMark, pendingTelemetry.length);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    const batch = pendingTelemetry.splice(0, pendingTelemetry.length);
    for (const pending of batch) insertGovernorTelemetryRow(pending);
  });
}

export function insertGovernorTelemetryRow(row: GovernorTelemetry): void {
  try {
    const db = getDbInstance();

    const outcome = pendingOutcomes.get(row.correlationId);
    if (outcome) pendingOutcomes.delete(row.correlationId);
    const merged = outcome ? { ...row, ...outcome } : row;
    db.prepare(
      `
      INSERT INTO governor_telemetry (
        timestamp, correlation_id, governor_mode, actual_provider, actual_model,
        actual_routing_strategy, actual_reasoning_config, actual_compression_config,
        actual_prompt_tokens, actual_output_tokens, actual_total_tokens,
        estimated_cost, latency_ms, retry_count, success, error_category,
        recommendation_json, decision_latency_ms, governor_name, governor_version, policy_version,
        observed_features_json, counterfactual_plan_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      merged.timestamp ?? Date.now(),
      merged.correlationId || "unknown",
      merged.governorMode,
      merged.actualProvider ?? null,
      merged.actualModel ?? null,
      merged.actualRoutingStrategy ?? null,
      merged.actualReasoningConfig ?? null,
      merged.actualCompressionConfig ?? null,
      merged.actualPromptTokens ?? null,
      merged.actualOutputTokens ?? null,
      merged.actualTotalTokens ?? null,
      merged.estimatedCost ?? null,
      merged.latencyMs ?? null,
      merged.retryCount ?? null,
      merged.success == null ? null : merged.success ? 1 : 0,
      merged.errorCategory ?? null,
      JSON.stringify(merged.recommendation),
      merged.decisionLatencyMs ?? null,
      merged.governorName ?? "NativeOmniGovernor",
      merged.governorVersion ?? "0.1.0",
      merged.policyVersion ?? "v0",
      merged.observedFeatures ? JSON.stringify(merged.observedFeatures) : null,
      merged.counterfactualPlan ? JSON.stringify(merged.counterfactualPlan) : null
    );
    queueMetrics.persisted += 1;
  } catch (error) {
    queueMetrics.persistenceFailures += 1;
    // Best-effort telemetry: failure to persist NEVER impacts an AI request
    console.warn("[governorTelemetry] Best-effort telemetry write failed:", error);
  }
}

export function updateGovernorTelemetryOutcome(
  correlationId: string,
  outcome: Partial<
    Pick<
      GovernorTelemetry,
      | "actualProvider"
      | "actualModel"
      | "actualRoutingStrategy"
      | "actualPromptTokens"
      | "actualOutputTokens"
      | "actualTotalTokens"
      | "estimatedCost"
      | "latencyMs"
      | "retryCount"
      | "success"
      | "errorCategory"
    >
  >
): void {
  if (!shouldSampleGovernorTelemetry(correlationId)) return;
  setImmediate(() => {
    if (pendingTelemetry.some((row) => row.correlationId === correlationId)) {
      const index = pendingTelemetry.findIndex((row) => row.correlationId === correlationId);
      pendingTelemetry[index] = { ...pendingTelemetry[index], ...outcome };
      return;
    }
    if (pendingOutcomes.size >= MAX_PENDING_TELEMETRY) {
      const oldest = pendingOutcomes.keys().next().value;
      if (oldest) pendingOutcomes.delete(oldest);
    }
    pendingOutcomes.set(correlationId, outcome);
    const timer = setTimeout(() => pendingOutcomes.delete(correlationId), 10_000);
    timer.unref?.();
    try {
      const db = getDbInstance();
      db.prepare(
        `UPDATE governor_telemetry SET
      actual_provider = COALESCE(?, actual_provider), actual_model = COALESCE(?, actual_model),
      actual_routing_strategy = COALESCE(?, actual_routing_strategy), actual_prompt_tokens = COALESCE(?, actual_prompt_tokens),
      actual_output_tokens = COALESCE(?, actual_output_tokens), actual_total_tokens = COALESCE(?, actual_total_tokens),
      estimated_cost = COALESCE(?, estimated_cost), latency_ms = COALESCE(?, latency_ms),
      retry_count = COALESCE(?, retry_count), success = COALESCE(?, success), error_category = COALESCE(?, error_category)
      WHERE correlation_id = ?`
      ).run(
        outcome.actualProvider ?? null,
        outcome.actualModel ?? null,
        outcome.actualRoutingStrategy ?? null,
        outcome.actualPromptTokens ?? null,
        outcome.actualOutputTokens ?? null,
        outcome.actualTotalTokens ?? null,
        outcome.estimatedCost ?? null,
        outcome.latencyMs ?? null,
        outcome.retryCount ?? null,
        outcome.success == null ? null : outcome.success ? 1 : 0,
        outcome.errorCategory ?? null,
        correlationId
      );
      pendingOutcomes.delete(correlationId);
    } catch {
      queueMetrics.persistenceFailures += 1;
    }
  });
}

export function queryGovernorTelemetryRows(limit = 100): GovernorTelemetry[] {
  try {
    const db = getDbInstance();

    const rows = db
      .prepare(
        `
      SELECT * FROM governor_telemetry ORDER BY id DESC LIMIT ?
    `
      )
      .all(limit) as Array<{
      id: number;
      timestamp: number;
      correlation_id: string;
      governor_mode: GovernorTelemetry["governorMode"];
      actual_provider: string | null;
      actual_model: string | null;
      actual_routing_strategy: string | null;
      actual_reasoning_config: string | null;
      actual_compression_config: string | null;
      actual_prompt_tokens: number | null;
      actual_output_tokens: number | null;
      actual_total_tokens: number | null;
      estimated_cost: number | null;
      latency_ms: number | null;
      retry_count: number | null;
      success: number | null;
      error_category: string | null;
      recommendation_json: string;
      decision_latency_ms: number;
      governor_name: string | null;
      governor_version: string | null;
      policy_version: string | null;
      observed_features_json: string | null;
      counterfactual_plan_json: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      correlationId: r.correlation_id,
      governorMode: r.governor_mode,
      actualProvider: r.actual_provider ?? "",
      actualModel: r.actual_model ?? "",
      actualRoutingStrategy: r.actual_routing_strategy ?? undefined,
      actualReasoningConfig: r.actual_reasoning_config ?? undefined,
      actualCompressionConfig: r.actual_compression_config ?? undefined,
      actualPromptTokens: r.actual_prompt_tokens,
      actualOutputTokens: r.actual_output_tokens,
      actualTotalTokens: r.actual_total_tokens,
      estimatedCost: r.estimated_cost ?? undefined,
      latencyMs: r.latency_ms,
      retryCount: r.retry_count,
      success: r.success == null ? null : Boolean(r.success),
      errorCategory: r.error_category ?? undefined,
      recommendation: JSON.parse(r.recommendation_json),
      decisionLatencyMs: r.decision_latency_ms,
      governorName: r.governor_name ?? undefined,
      governorVersion: r.governor_version ?? undefined,
      policyVersion: r.policy_version ?? undefined,
      observedFeatures: r.observed_features_json ? JSON.parse(r.observed_features_json) : undefined,
      counterfactualPlan: r.counterfactual_plan_json
        ? JSON.parse(r.counterfactual_plan_json)
        : undefined,
    }));
  } catch {
    return [];
  }
}
