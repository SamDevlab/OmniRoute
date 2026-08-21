import type {
  GovernorDecision,
  GovernorInput,
  ModelTier,
  ReasoningEffort,
  CompressionMode,
} from "./types.ts";
import { GOVERNOR_POLICY_VERSION } from "./constants.ts";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";
export type GuardrailResult = "YES" | "NO" | "UNKNOWN";
export type CostEstimateBasis = "ACTUAL_USAGE" | "PRE_REQUEST_BUDGET" | null;

export interface CounterfactualCandidate {
  provider: string;
  model: string;
  routingModelId?: string;
  tier: ModelTier;
  available: boolean;
  capabilities: string[];
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsReasoning?: boolean;
  supportsCompression?: CompressionMode[];
  quotaState?: "normal" | "warning" | "exhausted" | "unknown";
  healthScore?: number;
}

export interface CounterfactualInput extends GovernorInput {
  currentProvider?: string;
  currentModel?: string;
  currentModelTier?: ModelTier | null;
  actualInputTokens?: number | null;
  actualOutputTokens?: number | null;
  estimatedInputTokensForCost?: number | null;
  estimatedOutputTokensForCost?: number | null;
  currentCost?: number | null;
  requiredCapabilities?: string[];
  candidates: CounterfactualCandidate[];
}

export interface CounterfactualExecutionPlan {
  planVersion: string;
  governorName: string;
  governorVersion: string;
  policyVersion: string;
  recommendedModelTier: ModelTier;
  selectedProvider: string | null;
  selectedModel: string | null;
  resolvedModelTier: ModelTier | null;
  routingStrategy: string;
  reasoningEffort: ReasoningEffort;
  thinkingBudget: number | null;
  compressionMode: CompressionMode;
  contextBudget: number | null;
  maxOutputTokens: number | null;
  escalationPolicy: GovernorDecision["escalationPolicy"];
  estimatedCurrentCost: number | null;
  estimatedCounterfactualCost: number | null;
  costEstimateBasis: CostEstimateBasis;
  estimatedSavings: number | null;
  estimatedSavingsPercent: number | null;
  tokenReductionOpportunity: number | null;
  confidence: Confidence;
  executable: boolean;
  unresolvedFields: string[];
  guardrailResults: Record<string, GuardrailResult>;
  reasons: string[];
  liveActiveControl: boolean;
}

const RELIABLE_PREFERRED_CANDIDATE_FLOOR = 0.8;
const TIER_ORDER: ModelTier[] = ["low", "medium", "high", "highest"];

function supports(candidate: CounterfactualCandidate, required: string[]): boolean {
  return required.every((value) => candidate.capabilities.includes(value));
}

function resolveCostUsage(input: CounterfactualInput): {
  inputTokens: number;
  outputTokens: number;
  basis: Exclude<CostEstimateBasis, null>;
} | null {
  if (input.actualInputTokens != null && input.actualOutputTokens != null) {
    return {
      inputTokens: input.actualInputTokens,
      outputTokens: input.actualOutputTokens,
      basis: "ACTUAL_USAGE",
    };
  }
  if (input.estimatedInputTokensForCost != null && input.estimatedOutputTokensForCost != null) {
    return {
      inputTokens: input.estimatedInputTokensForCost,
      outputTokens: input.estimatedOutputTokensForCost,
      basis: "PRE_REQUEST_BUDGET",
    };
  }
  return null;
}

function cost(
  candidate: CounterfactualCandidate,
  input: CounterfactualInput
): { value: number; basis: Exclude<CostEstimateBasis, null> } | null {
  const usage = resolveCostUsage(input);
  if (candidate.inputPrice == null || candidate.outputPrice == null || !usage) return null;
  return {
    value:
      (candidate.inputPrice * usage.inputTokens + candidate.outputPrice * usage.outputTokens) /
      1_000_000,
    basis: usage.basis,
  };
}

function quotaGuard(candidate: CounterfactualCandidate | undefined): GuardrailResult {
  if (!candidate) return "UNKNOWN";
  if (candidate.quotaState === "exhausted") return "NO";
  if (candidate.quotaState === "normal" || candidate.quotaState === "warning") return "YES";
  return "UNKNOWN";
}

function candidateHealthScore(candidate: CounterfactualCandidate): number {
  const health = Number(candidate.healthScore);
  if (!Number.isFinite(health)) return 0.5;
  return Math.max(0, Math.min(1, health));
}

function tierDistance(candidate: CounterfactualCandidate, recommendedTier: ModelTier): number {
  const candidateIndex = TIER_ORDER.indexOf(candidate.tier);
  const recommendedIndex = TIER_ORDER.indexOf(recommendedTier);
  if (candidateIndex < 0 || recommendedIndex < 0) return Number.MAX_SAFE_INTEGER;
  return Math.abs(candidateIndex - recommendedIndex);
}

function selectCandidate(
  suitable: CounterfactualCandidate[],
  input: CounterfactualInput,
  decision: GovernorDecision
): CounterfactualCandidate | undefined {
  const recommendedTier = decision.modelPolicy.recommendedTier;
  if (recommendedTier === "preserve") {
    return suitable.find((item) => item.model === input.currentModel);
  }

  const preferred = suitable.filter((item) => item.tier === recommendedTier);
  const hasReliablePreferred = preferred.some(
    (item) => candidateHealthScore(item) >= RELIABLE_PREFERRED_CANDIDATE_FLOOR
  );
  const candidatesToRank = hasReliablePreferred ? preferred : suitable;

  return candidatesToRank
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        candidateHealthScore(b.candidate) - candidateHealthScore(a.candidate) ||
        tierDistance(a.candidate, recommendedTier) - tierDistance(b.candidate, recommendedTier) ||
        a.index - b.index
    )[0]?.candidate;
}

export function resolveCounterfactualPlan(
  input: CounterfactualInput,
  decision: GovernorDecision
): CounterfactualExecutionPlan {
  const unresolved: string[] = [];
  const required = input.requiredCapabilities ?? [];
  const suitable = input.candidates.filter(
    (candidate) =>
      candidate.available === true &&
      candidate.quotaState !== "exhausted" &&
      supports(candidate, required)
  );

  const candidate = selectCandidate(suitable, input, decision);

  if (!candidate) unresolved.push("candidate");

  const capability: GuardrailResult = candidate ? "YES" : suitable.length > 0 ? "UNKNOWN" : "NO";

  const contextFits: GuardrailResult = !candidate
    ? "UNKNOWN"
    : candidate.contextWindow == null || input.estimatedPromptTokens == null
      ? "UNKNOWN"
      : input.estimatedPromptTokens <= candidate.contextWindow
        ? "YES"
        : "NO";

  const reasoningSupported: GuardrailResult =
    decision.reasoningPolicy.effort === "none" || decision.reasoningPolicy.effort === "preserve"
      ? "YES"
      : candidate?.supportsReasoning == null
        ? "UNKNOWN"
        : candidate.supportsReasoning
          ? "YES"
          : "NO";

  const compressionSupported: GuardrailResult =
    decision.compressionPolicy.mode === "none" || decision.compressionPolicy.mode === "preserve"
      ? "YES"
      : candidate?.supportsCompression == null
        ? "UNKNOWN"
        : candidate.supportsCompression.includes(decision.compressionPolicy.mode)
          ? "YES"
          : "NO";

  const providerAvailable: GuardrailResult = candidate
    ? candidate.available === true
      ? "YES"
      : "NO"
    : "UNKNOWN";
  const quotaAcceptable = quotaGuard(candidate);

  const counterCostResult = candidate ? cost(candidate, input) : null;
  const currentCost = input.currentCost ?? null;
  const counterCost = counterCostResult?.value ?? null;
  const costEstimateBasis = counterCostResult?.basis ?? null;
  if (counterCost == null) unresolved.push("pricingOrUsage");

  const requestedMax = input.requestedMaxOutput;
  const recommendedMax = decision.maxOutputTokens;
  const outputTokens =
    requestedMax == null && recommendedMax == null
      ? null
      : Math.max(
          1,
          Math.min(
            recommendedMax ?? requestedMax ?? Number.MAX_SAFE_INTEGER,
            requestedMax ?? Number.MAX_SAFE_INTEGER
          )
        );

  const userMaxRespected: GuardrailResult =
    outputTokens == null || requestedMax == null || outputTokens <= requestedMax ? "YES" : "NO";

  const savings = currentCost != null && counterCost != null ? currentCost - counterCost : null;

  const guardrailResults: Record<string, GuardrailResult> = {
    CAPABILITY_COMPATIBLE: capability,
    CONTEXT_FITS: contextFits,
    PROVIDER_AVAILABLE: providerAvailable,
    QUOTA_ACCEPTABLE: quotaAcceptable,
    REASONING_SUPPORTED: reasoningSupported,
    COMPRESSION_SUPPORTED: compressionSupported,
    USER_MAX_OUTPUT_RESPECTED: userMaxRespected,
  };

  // Provider availability/quota can remain UNKNOWN at planning time because the
  // active runtime resolves them through OmniRoute's real credential/quota
  // preflight before dispatch. A factual NO is still terminal.
  const planningGuardsPass = [
    capability,
    contextFits,
    reasoningSupported,
    compressionSupported,
    userMaxRespected,
  ].every((value) => value === "YES");
  const runtimePreflightNotRejected = providerAvailable !== "NO" && quotaAcceptable !== "NO";
  const executable = Boolean(candidate) && planningGuardsPass && runtimePreflightNotRejected;

  const confidence: Confidence = executable
    ? counterCost != null && currentCost != null
      ? "HIGH"
      : "MEDIUM"
    : candidate
      ? "LOW"
      : "INSUFFICIENT_DATA";

  return {
    planVersion: "3a-v1",
    governorName: "NativeOmniGovernor",
    governorVersion: "0.1.0",
    policyVersion: GOVERNOR_POLICY_VERSION,
    recommendedModelTier: decision.modelPolicy.recommendedTier,
    selectedProvider: candidate?.provider ?? null,
    selectedModel: candidate?.model ?? null,
    resolvedModelTier: candidate?.tier ?? null,
    routingStrategy: decision.routingPolicy.strategy,
    reasoningEffort: decision.reasoningPolicy.effort,
    thinkingBudget: null,
    compressionMode: decision.compressionPolicy.mode,
    contextBudget: decision.contextBudgetPolicy.maxPromptTokens ?? null,
    maxOutputTokens: outputTokens,
    escalationPolicy: decision.escalationPolicy,
    estimatedCurrentCost: currentCost,
    estimatedCounterfactualCost: counterCost,
    costEstimateBasis,
    estimatedSavings: savings,
    estimatedSavingsPercent:
      savings != null && currentCost != null && currentCost !== 0
        ? (savings / currentCost) * 100
        : null,
    tokenReductionOpportunity:
      requestedMax != null && outputTokens != null
        ? Math.max(0, requestedMax - outputTokens)
        : null,
    confidence,
    executable,
    unresolvedFields: unresolved,
    guardrailResults,
    reasons: [
      `tier=${decision.modelPolicy.recommendedTier}`,
      `candidate=${candidate ? "resolved" : "unresolved"}`,
      `routing=${decision.routingPolicy.strategy}`,
      `cost_basis=${costEstimateBasis ?? "unknown"}`,
      "plan=counterfactual",
    ],
    liveActiveControl: false,
  };
}
