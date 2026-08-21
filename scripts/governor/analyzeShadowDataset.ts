/** Metadata-only offline analysis. No providers, network, or LLM calls. */
import { NativeOmniGovernor } from "../../open-sse/governor/nativeGovernor.ts";
import type { GovernorInput, GovernorTelemetry } from "../../open-sse/governor/types.ts";

export type ShadowDatasetRecord = { input: GovernorInput; observation: GovernorTelemetry };

export function analyzeCounterfactualPlans(records: ShadowDatasetRecord[]) {
  const plans = records
    .map(
      (record) =>
        record.observation.counterfactualPlan as
          | { executable?: boolean; confidence?: string; estimatedSavings?: number | null }
          | undefined
    )
    .filter(Boolean);
  return {
    DATA_QUALITY: { total: records.length, plans: plans.length },
    COUNTERFACTUAL_PLANS: plans.length,
    EXECUTABLE_PLANS: plans.filter((p) => p?.executable === true).length,
    NON_EXECUTABLE_PLANS: plans.filter((p) => p?.executable === false).length,
    UNKNOWN_PLANS: plans.filter((p) => p?.executable == null).length,
    HIGH_CONFIDENCE: plans.filter((p) => p?.confidence === "HIGH").length,
    MEDIUM_CONFIDENCE: plans.filter((p) => p?.confidence === "MEDIUM").length,
    LOW_CONFIDENCE: plans.filter((p) => p?.confidence === "LOW").length,
    INSUFFICIENT_DATA: plans.filter((p) => p?.confidence === "INSUFFICIENT_DATA").length,
    COST_REDUCTION_OPPORTUNITIES: plans.filter(
      (p) => typeof p?.estimatedSavings === "number" && p.estimatedSavings > 0
    ).length,
  };
}

export interface ShadowAnalysis {
  TOTAL_OBSERVATIONS: number;
  REPLAY_ANALYSIS: {
    REPLAY_EXACT_MATCHES: number;
    REPLAY_POLICY_DRIFT: number;
    REPLAY_MODEL_TIER_DRIFT: number;
    REPLAY_REASONING_DRIFT: number;
    REPLAY_COMPRESSION_DRIFT: number;
    REPLAY_OUTPUT_BUDGET_DRIFT: number;
  };
  ACTUAL_VS_RECOMMENDED: { agreements: number; disagreements: number; unknown: number };
  DATA_QUALITY: Record<string, number>;
  SAVINGS_OPPORTUNITIES: {
    reasoningReduction: number;
    outputReduction: number;
    compression: number;
    cheaperTier: "UNKNOWN";
    strongerTier: "UNKNOWN";
  };
  byTaskKind: Record<string, { total: number; disagreements: number }>;
  byActualModel: Record<string, { total: number; disagreements: number }>;
  byProvider: Record<string, { total: number; disagreements: number }>;
  byRoutingMode: Record<string, { total: number; disagreements: number }>;
}

function bump(
  map: Record<string, { total: number; disagreements: number }>,
  key: string,
  disagree: boolean
) {
  const row = (map[key] ??= { total: 0, disagreements: 0 });
  row.total += 1;
  if (disagree) row.disagreements += 1;
}

export function analyzeShadowDataset(records: ShadowDatasetRecord[]): ShadowAnalysis {
  const out: ShadowAnalysis = {
    TOTAL_OBSERVATIONS: records.length,
    REPLAY_ANALYSIS: {
      REPLAY_EXACT_MATCHES: 0,
      REPLAY_POLICY_DRIFT: 0,
      REPLAY_MODEL_TIER_DRIFT: 0,
      REPLAY_REASONING_DRIFT: 0,
      REPLAY_COMPRESSION_DRIFT: 0,
      REPLAY_OUTPUT_BUDGET_DRIFT: 0,
    },
    ACTUAL_VS_RECOMMENDED: { agreements: 0, disagreements: 0, unknown: 0 },
    DATA_QUALITY: {
      ACTUAL_PROVIDER_KNOWN: 0,
      ACTUAL_MODEL_KNOWN: 0,
      ACTUAL_REASONING_KNOWN: 0,
      ACTUAL_COMPRESSION_KNOWN: 0,
      OUTCOME_KNOWN: 0,
      TOKEN_USAGE_KNOWN: 0,
      MODEL_TIER_KNOWN: 0,
    },
    SAVINGS_OPPORTUNITIES: {
      reasoningReduction: 0,
      outputReduction: 0,
      compression: 0,
      cheaperTier: "UNKNOWN",
      strongerTier: "UNKNOWN",
    },
    byTaskKind: {},
    byActualModel: {},
    byProvider: {},
    byRoutingMode: {},
  };
  const governor = new NativeOmniGovernor();
  for (const record of records) {
    const d = governor.decide(record.input);
    const r = record.observation.recommendation;
    const tier = d.modelPolicy.recommendedTier !== r.modelPolicy.recommendedTier;
    const reasoning = d.reasoningPolicy.effort !== r.reasoningPolicy.effort;
    const compression = d.compressionPolicy.mode !== r.compressionPolicy.mode;
    const output = d.maxOutputTokens !== r.maxOutputTokens;
    const drift =
      tier ||
      reasoning ||
      compression ||
      output ||
      d.routingPolicy.strategy !== r.routingPolicy.strategy;
    if (drift) out.REPLAY_ANALYSIS.REPLAY_POLICY_DRIFT += 1;
    else out.REPLAY_ANALYSIS.REPLAY_EXACT_MATCHES += 1;
    if (tier) out.REPLAY_ANALYSIS.REPLAY_MODEL_TIER_DRIFT += 1;
    if (reasoning) out.REPLAY_ANALYSIS.REPLAY_REASONING_DRIFT += 1;
    if (compression) out.REPLAY_ANALYSIS.REPLAY_COMPRESSION_DRIFT += 1;
    if (output) out.REPLAY_ANALYSIS.REPLAY_OUTPUT_BUDGET_DRIFT += 1;
    const actualTier = record.observation.actualModel || "unknown";
    const actualReasoning = record.observation.actualReasoningConfig;
    const actualCompression = record.observation.actualCompressionConfig;
    const actualRouting = record.observation.actualRoutingStrategy;
    const comparable =
      actualRouting != null || actualReasoning != null || actualCompression != null;
    if (comparable) {
      const actualDisagree =
        (actualRouting != null && actualRouting !== r.routingPolicy.strategy) ||
        (actualReasoning != null && actualReasoning !== r.reasoningPolicy.effort) ||
        (actualCompression != null && actualCompression !== r.compressionPolicy.mode);
      if (actualDisagree) out.ACTUAL_VS_RECOMMENDED.disagreements += 1;
      else out.ACTUAL_VS_RECOMMENDED.agreements += 1;
    } else out.ACTUAL_VS_RECOMMENDED.unknown += 1;
    if (record.observation.actualProvider) out.DATA_QUALITY.ACTUAL_PROVIDER_KNOWN += 1;
    if (record.observation.actualModel) out.DATA_QUALITY.ACTUAL_MODEL_KNOWN += 1;
    if (actualReasoning != null) {
      out.DATA_QUALITY.ACTUAL_REASONING_KNOWN += 1;
      if (actualReasoning !== "none" && r.reasoningPolicy.effort === "none")
        out.SAVINGS_OPPORTUNITIES.reasoningReduction += 1;
    }
    if (actualCompression != null) {
      out.DATA_QUALITY.ACTUAL_COMPRESSION_KNOWN += 1;
      if (actualCompression === "none" && r.compressionPolicy.mode !== "none")
        out.SAVINGS_OPPORTUNITIES.compression += 1;
    }
    if (record.observation.success != null) out.DATA_QUALITY.OUTCOME_KNOWN += 1;
    if (record.observation.actualTotalTokens != null) out.DATA_QUALITY.TOKEN_USAGE_KNOWN += 1;
    if (
      typeof record.input.requestedMaxOutput === "number" &&
      typeof r.maxOutputTokens === "number" &&
      r.maxOutputTokens < record.input.requestedMaxOutput
    )
      out.SAVINGS_OPPORTUNITIES.outputReduction += 1;
    bump(
      out.byTaskKind,
      record.input.taskKind ?? "unknown",
      comparable && out.ACTUAL_VS_RECOMMENDED.disagreements > 0
    );
    bump(out.byActualModel, actualTier, comparable && out.ACTUAL_VS_RECOMMENDED.disagreements > 0);
    bump(
      out.byProvider,
      record.observation.actualProvider || "unknown",
      comparable && out.ACTUAL_VS_RECOMMENDED.disagreements > 0
    );
    bump(
      out.byRoutingMode,
      record.observation.actualRoutingStrategy || "unknown",
      comparable && out.ACTUAL_VS_RECOMMENDED.disagreements > 0
    );
  }
  return out;
}
