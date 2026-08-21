import { getResolvedModelCapabilities } from "@/lib/modelCapabilities.ts";
import { getGovernorMode } from "@/shared/utils/featureFlags.ts";
import { GovernorManager } from "./governorManager.ts";
import { getGovernorActiveBreaker, type ActiveCanaryCircuitBreaker } from "./activeCanary.ts";
import { getGovernorRuntimeConfig } from "./runtimeConfig.ts";
import type { GovernorRuntimeConfig } from "./runtimeConfig.ts";
import type {
  CounterfactualCandidate,
  CounterfactualExecutionPlan,
  CounterfactualInput,
} from "./counterfactual.ts";
import type { GovernorExecutionContext, GovernorInput, ModelTier } from "./types.ts";
import { parseModel } from "../services/model.ts";
import { classifyTier } from "../services/tierResolver.ts";
import { getTaskFitness } from "../services/autoCombo/taskFitness.ts";
import type { AutoProviderCandidate, ResolvedComboTarget } from "../services/combo/types.ts";

const LOCAL_COMPRESSION_MODES = ["none", "rtk", "caveman", "compact", "preserve"] as const;

interface PricingEvidence {
  input: number;
  output: number;
}

export interface GovernorPricingResolution {
  pricing: PricingEvidence | null;
  pricingKnown: boolean;
}

export interface AutoComboGovernorRuntimeInput {
  body: Record<string, unknown>;
  promptText?: string;
  estimatedInputTokens: number;
  taskType: string;
  correlationId?: string | null;
  nativeSelectedTarget: ResolvedComboTarget;
  orderedTargets: ResolvedComboTarget[];
  routableCandidates: AutoProviderCandidate[];
}

export interface AutoComboGovernorRuntimeResult {
  orderedTargets: ResolvedComboTarget[];
  context: GovernorExecutionContext | null;
  selectedExecutionKey: string | null;
  applied: boolean;
  requestOverrides?: Record<string, unknown>;
}

export interface GovernorDispatchProbeEligibility {
  activeSelected: boolean;
  planExecutable: boolean;
  selectedTargetAvailable: boolean;
  controlsPermitTarget: boolean;
  differsFromNativeTarget: boolean;
}

/**
 * The breaker probe belongs to a concrete Governor dispatch, never to planning.
 * Keeping every pre-dispatch condition here makes HALF-OPEN acquisition auditable
 * and prevents future call-site reordering from consuming a probe on a bypass.
 */
export function tryAcquireGovernorDispatchProbe(
  breaker: ActiveCanaryCircuitBreaker,
  eligibility: GovernorDispatchProbeEligibility
): boolean {
  if (
    !eligibility.activeSelected ||
    !eligibility.planExecutable ||
    !eligibility.selectedTargetAvailable ||
    !eligibility.controlsPermitTarget ||
    !eligibility.differsFromNativeTarget
  ) {
    return false;
  }
  return breaker.tryAcquireActiveAttempt();
}

function toFiniteNonNegative(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function getPricingEvidence(
  provider: string,
  model: string
): Promise<PricingEvidence | null> {
  try {
    const { getPricingForModel } = await import("@/lib/localDb");
    let pricing = await getPricingForModel(provider, model);
    if (!pricing && model.includes("/")) {
      const leaf = model.split("/").filter(Boolean).pop();
      if (leaf && leaf !== model) pricing = await getPricingForModel(provider, leaf);
    }
    if (!pricing || typeof pricing !== "object") return null;
    const input = toFiniteNonNegative((pricing as Record<string, unknown>).input);
    const output = toFiniteNonNegative((pricing as Record<string, unknown>).output);
    return input != null && output != null ? { input, output } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve only factual zero-cost evidence when the pricing catalog has no row.
 * `classifyTier` is deliberately gated by all three signals: a free tier,
 * explicit free-tier evidence, and zero input/output costs. Unknown or paid
 * models therefore retain the historical unknown-pricing behavior.
 */
export async function resolveGovernorPricingEvidence(
  provider: string,
  model: string,
  explicitPricing?: PricingEvidence | null
): Promise<GovernorPricingResolution> {
  const pricing =
    explicitPricing === undefined ? await getPricingEvidence(provider, model) : explicitPricing;
  if (pricing) return { pricing, pricingKnown: true };

  try {
    const classification = classifyTier(provider, model);
    if (
      classification.tier === "free" &&
      classification.hasFreeTier === true &&
      classification.costPer1MInput === 0 &&
      classification.costPer1MOutput === 0
    ) {
      return { pricing: { input: 0, output: 0 }, pricingKnown: true };
    }
  } catch {
    // Preserve fail-closed unknown pricing if tier classification is unavailable.
  }
  return { pricing: null, pricingKnown: false };
}

function parseTarget(target: ResolvedComboTarget): { provider: string; model: string } {
  const parsed = parseModel(target.modelStr);
  return {
    provider: target.provider || parsed.provider || parsed.providerAlias || "unknown",
    model: parsed.model || target.modelStr,
  };
}

function mapPricingTier(provider: string, model: string, pricingKnown: boolean): ModelTier {
  if (!pricingKnown) return "preserve";
  try {
    const tier = classifyTier(provider, model).tier;
    if (tier === "free") return "low";
    if (tier === "cheap") return "medium";
    if (tier === "premium") return "high";
  } catch {
    // Unknown tier stays preserve. Active routing will still require known cost.
  }
  return "preserve";
}

export function resolveGovernorCandidateHealth(
  candidate:
    Pick<AutoProviderCandidate, "errorRate" | "failureRate" | "reliabilityObserved"> | undefined
): number {
  if (!candidate) return 0.5;
  if (candidate.reliabilityObserved === false) return 0.5;
  const failureRate = toFiniteNonNegative(candidate.failureRate);
  if (failureRate != null) return Math.max(0, Math.min(1, 1 - failureRate));
  const errorRate = toFiniteNonNegative(candidate.errorRate);
  if (errorRate == null) return 0.5;
  return Math.max(0, Math.min(1, 1 - errorRate));
}

function quotaState(
  candidate: AutoProviderCandidate | undefined
): "normal" | "warning" | "exhausted" | "unknown" {
  if (!candidate) return "unknown";
  const remaining = toFiniteNonNegative(candidate.quotaRemaining);
  if (remaining == null) return "unknown";
  if (remaining <= 0) return "exhausted";
  if (remaining < 20) return "warning";
  return "normal";
}

function costFromPricing(
  pricing: PricingEvidence | null,
  inputTokens: number | null,
  outputTokens: number | null
): number | null {
  if (!pricing || inputTokens == null || outputTokens == null) return null;
  return (pricing.input * inputTokens + pricing.output * outputTokens) / 1_000_000;
}

function requestedOutputBudget(body: Record<string, unknown>): number | null {
  for (const value of [body.max_tokens, body.max_completion_tokens]) {
    const parsed = toFiniteNonNegative(value);
    if (parsed != null && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

export function buildGovernorRequestOverrides(
  body: Record<string, unknown>,
  plan: CounterfactualExecutionPlan,
  config: GovernorRuntimeConfig
): Record<string, unknown> {
  const requestOverrides: Record<string, unknown> = {};
  if (
    config.controlReasoning &&
    plan.reasoningEffort &&
    plan.reasoningEffort !== "preserve" &&
    body.reasoning_effort == null &&
    body.reasoning == null &&
    body.thinking == null
  ) {
    requestOverrides.reasoning_effort = plan.reasoningEffort;
  }
  if (config.controlOutput && plan.maxOutputTokens != null) {
    const explicit = requestedOutputBudget(body);
    requestOverrides.max_tokens =
      explicit == null ? plan.maxOutputTokens : Math.min(explicit, plan.maxOutputTokens);
  }
  if (config.controlCompression && plan.compressionMode && plan.compressionMode !== "preserve") {
    requestOverrides.__omnirouteGovernorCompressionPreference = plan.compressionMode;
  }
  return requestOverrides;
}

function findAutoCandidate(
  candidates: AutoProviderCandidate[],
  provider: string,
  model: string,
  connectionId?: string | null
): AutoProviderCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.provider === provider &&
      candidate.model === model &&
      (!connectionId || !candidate.connectionId || candidate.connectionId === connectionId)
  );
}

async function buildCounterfactualCandidates(
  targets: ResolvedComboTarget[],
  routableCandidates: AutoProviderCandidate[],
  taskType: string
): Promise<CounterfactualCandidate[]> {
  const normalized: CounterfactualCandidate[] = [];
  const premium: Array<{
    candidate: CounterfactualCandidate;
    fitness: number;
    contextWindow: number;
  }> = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const { provider, model } = parseTarget(target);
    const dedupeKey = `${provider}\u0000${model}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const [pricingResolution, capabilities] = await Promise.all([
      resolveGovernorPricingEvidence(provider, model),
      Promise.resolve(getResolvedModelCapabilities({ provider, model })),
    ]);
    const pricing = pricingResolution.pricing;
    const autoCandidate = findAutoCandidate(
      routableCandidates,
      provider,
      model,
      target.connectionId ?? null
    );
    const tier = mapPricingTier(provider, model, pricingResolution.pricingKnown);
    const candidate: CounterfactualCandidate = {
      provider,
      model,
      routingModelId: target.modelStr,
      tier,
      // These targets already survived Auto Combo's runtime candidate construction.
      // Per-request credentials/allowlists remain authoritative in isModelAvailable.
      available: true,
      capabilities: [
        ...(capabilities.toolCalling || capabilities.supportsTools === true ? ["tools"] : []),
        ...(capabilities.supportsVision === true ? ["vision"] : []),
        ...(capabilities.structuredOutput === true ? ["structured_output"] : []),
        "streaming",
      ],
      ...(capabilities.contextWindow != null ? { contextWindow: capabilities.contextWindow } : {}),
      ...(pricing ? { inputPrice: pricing.input, outputPrice: pricing.output } : {}),
      supportsReasoning: capabilities.reasoning,
      // Compression is a local OmniRoute preprocessing control, not a provider API capability.
      supportsCompression: [...LOCAL_COMPRESSION_MODES],
      quotaState: quotaState(autoCandidate),
      healthScore: resolveGovernorCandidateHealth(autoCandidate),
    };
    normalized.push(candidate);

    if (tier === "high") {
      let fitness = 0.5;
      try {
        fitness = getTaskFitness(model, taskType);
      } catch {}
      premium.push({
        candidate,
        fitness,
        contextWindow: capabilities.contextWindow ?? 0,
      });
    }
  }

  const strongest = premium.sort(
    (a, b) =>
      b.fitness - a.fitness ||
      b.contextWindow - a.contextWindow ||
      (b.candidate.healthScore ?? 0) - (a.candidate.healthScore ?? 0)
  )[0]?.candidate;
  if (strongest) normalized.push({ ...strongest, tier: "highest" });

  return normalized;
}

export async function applyGovernorToAutoComboOrder(
  input: AutoComboGovernorRuntimeInput
): Promise<AutoComboGovernorRuntimeResult> {
  if (input.orderedTargets.length === 0) {
    return {
      orderedTargets: input.orderedTargets,
      context: null,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  // Shadow stays on the late observation hook in chatCore. Simulate must evaluate
  // here as well so it receives the same factual Auto Combo pool as active mode;
  // it still returns before any target order mutation.
  const mode = getGovernorMode();
  if (mode === "off" || mode === "shadow") {
    return {
      orderedTargets: input.orderedTargets,
      context: null,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  const native = parseTarget(input.nativeSelectedTarget);
  const outputBudget = requestedOutputBudget(input.body);
  const candidates = await buildCounterfactualCandidates(
    input.orderedTargets,
    input.routableCandidates,
    input.taskType
  );
  const nativeCandidate = candidates.find(
    (candidate) => candidate.provider === native.provider && candidate.model === native.model
  );
  const currentCost = costFromPricing(
    nativeCandidate?.inputPrice != null && nativeCandidate.outputPrice != null
      ? { input: nativeCandidate.inputPrice, output: nativeCandidate.outputPrice }
      : null,
    input.estimatedInputTokens > 0 ? input.estimatedInputTokens : null,
    outputBudget
  );

  const governorInput: GovernorInput = {
    correlationId: input.correlationId ?? undefined,
    estimatedPromptTokens: input.estimatedInputTokens > 0 ? input.estimatedInputTokens : undefined,
    contextWindow: nativeCandidate?.contextWindow,
    contextUtilization:
      nativeCandidate?.contextWindow && input.estimatedInputTokens > 0
        ? Math.min(1, input.estimatedInputTokens / nativeCandidate.contextWindow)
        : undefined,
    messageCount: Array.isArray(input.body.messages)
      ? input.body.messages.length
      : Array.isArray(input.body.input)
        ? input.body.input.length
        : undefined,
    toolCount: Array.isArray(input.body.tools) ? input.body.tools.length : 0,
    requestedMaxOutput: outputBudget ?? undefined,
    rawPromptText: input.promptText,
    availableCandidates: candidates.map(
      (candidate) => candidate.routingModelId || `${candidate.provider}/${candidate.model}`
    ),
  };

  const requiredCapabilities =
    Array.isArray(input.body.tools) && input.body.tools.length > 0 ? ["tools"] : [];
  const counterfactualInput: CounterfactualInput = {
    ...governorInput,
    currentProvider: native.provider,
    currentModel: native.model,
    currentModelTier: nativeCandidate?.tier ?? null,
    actualInputTokens: null,
    actualOutputTokens: null,
    estimatedInputTokensForCost: input.estimatedInputTokens > 0 ? input.estimatedInputTokens : null,
    estimatedOutputTokensForCost: outputBudget,
    currentCost,
    requiredCapabilities,
    candidates,
  };

  const { result, context } = GovernorManager.evaluateRequest(
    governorInput,
    {
      provider: native.provider,
      model: native.model,
      routingStrategy: "auto",
      estimatedCost: currentCost,
      success: null,
    },
    counterfactualInput
  );

  if (mode === "simulate") {
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  const breaker = getGovernorActiveBreaker();
  context.breakerState = breaker.getState();
  if (!context.activeSelected || !result.plan?.executable) {
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  const selectedIndex = input.orderedTargets.findIndex((target) => {
    const parsed = parseTarget(target);
    return (
      parsed.provider === result.plan?.selectedProvider &&
      parsed.model === result.plan?.selectedModel
    );
  });
  if (selectedIndex < 0) {
    context.activeSelected = false;
    context.activeApplied = false;
    context.bypassReason = "selected_target_not_in_runtime_pool";
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  const selected = input.orderedTargets[selectedIndex];
  const config = getGovernorRuntimeConfig();
  const selectedTarget = parseTarget(selected);
  const modelChanged = selectedTarget.model !== native.model;
  const providerChanged = selectedTarget.provider !== native.provider;
  if ((modelChanged && !config.controlModel) || (providerChanged && !config.controlProvider)) {
    context.activeSelected = false;
    context.activeApplied = false;
    context.bypassReason =
      modelChanged && providerChanged
        ? "model_provider_control_disabled"
        : modelChanged
          ? "model_control_disabled"
          : "provider_control_disabled";
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: null,
      applied: false,
    };
  }
  context.selectedRoute = {
    provider: result.plan.selectedProvider || "unknown",
    model: result.plan.selectedModel || selected.modelStr,
    strategy: "auto",
  };
  if (selectedIndex === 0) {
    context.activeApplied = false;
    context.bypassReason = "native_route_already_matches_governor";
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: selected.executionKey || null,
      applied: false,
    };
  }

  // Acquire only at the real dispatch boundary. Earlier acquisition can leak the
  // sole HALF-OPEN probe when a later eligibility/control exit preserves native routing.
  if (
    !tryAcquireGovernorDispatchProbe(breaker, {
      activeSelected: context.activeSelected,
      planExecutable: result.plan.executable,
      selectedTargetAvailable: true,
      controlsPermitTarget: true,
      differsFromNativeTarget: true,
    })
  ) {
    context.activeSelected = false;
    context.activeApplied = false;
    context.bypassReason = "governor_breaker_open";
    return {
      orderedTargets: input.orderedTargets,
      context,
      selectedExecutionKey: null,
      applied: false,
    };
  }

  context.activeApplied = true;
  context.selectedDispatchCount = 0;
  context.bypassReason = undefined;
  const requestOverrides = buildGovernorRequestOverrides(input.body, result.plan, config);
  return {
    orderedTargets: [
      selected,
      ...input.orderedTargets.filter((_, index) => index !== selectedIndex),
    ],
    context,
    selectedExecutionKey: selected.executionKey || null,
    applied: true,
    requestOverrides,
  };
}
