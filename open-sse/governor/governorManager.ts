/**
 * open-sse/governor/governorManager.ts
 *
 * Intelligence Governor Manager & Shadow Mode Evaluator.
 *
 * GUARANTEES:
 * - When mode is 'off': no Governor decision is performed.
 * - One logical request/correlation id is evaluated at most once inside the cache window.
 * - Shadow/simulate recommendations do not alter authoritative routing selection.
 * - Telemetry persistence is best-effort and never throws into request flow.
 */

import { getGovernorMode, isGovernorTelemetryEnabled } from "@/shared/utils/featureFlags.ts";
import { enqueueGovernorTelemetryRow } from "@/lib/db/governorTelemetry.ts";
import { NativeOmniGovernor } from "./nativeGovernor.ts";
import {
  resolveCounterfactualPlan,
  type CounterfactualExecutionPlan,
  type CounterfactualInput,
} from "./counterfactual.ts";
import { GOVERNOR_POLICY_VERSION } from "./constants.ts";
import { assessActiveCanary, allHardGuardrailsPass } from "./activeCanary.ts";
import { getGovernorRuntimeConfig } from "./runtimeConfig.ts";
import type {
  GovernorDecision,
  GovernorExecutionContext,
  GovernorInput,
  GovernorMode,
  GovernorTelemetry,
  IntelligenceGovernor,
  ActualRequestContext,
} from "./types.ts";

export interface EvaluationResult {
  recommendation: GovernorDecision | null;
  mode: GovernorMode;
  decisionLatencyMs: number;
  plan?: CounterfactualExecutionPlan | null;
}

export interface SimulationResult extends EvaluationResult {
  plan: CounterfactualExecutionPlan | null;
}

interface CachedEvaluation {
  createdAt: number;
  result: EvaluationResult;
  context: GovernorExecutionContext;
}

const EVALUATION_CACHE_TTL_MS = 60_000;
const EVALUATION_CACHE_MAX = 2_048;

function isLateObservationOnlyActiveInput(input?: CounterfactualInput): boolean {
  if (!input || input.candidates.length === 0) return true;
  if (input.candidates.length > 1) return false;
  const candidate = input.candidates[0];
  return (
    candidate.tier === "preserve" &&
    candidate.provider === input.currentProvider &&
    candidate.model === input.currentModel
  );
}

function emptyExecutionContext(
  mode: GovernorMode,
  input: GovernorInput,
  actualContext: ActualRequestContext,
  bypassReason: string
): GovernorExecutionContext {
  return {
    correlationId: input.correlationId ?? "unknown",
    mode,
    decision: null,
    decisionCount: 0,
    planResolutionCount: 0,
    originalRoute: {
      provider: actualContext.provider,
      model: actualContext.model,
      strategy: actualContext.routingStrategy,
    },
    planAvailable: false,
    eligibilityEvaluated: false,
    activeEligible: false,
    activeSelected: false,
    activeApplied: false,
    selectedDispatchCount: 0,
    fallbackDispatchCount: 0,
    fallbackAttempted: false,
    fallbackSucceeded: false,
    bypassReason,
  };
}

export class GovernorManager {
  private static governor: IntelligenceGovernor = new NativeOmniGovernor();
  private static evaluationCache = new Map<string, CachedEvaluation>();

  public static getGovernor(): IntelligenceGovernor {
    return this.governor;
  }

  public static setGovernor(governor: IntelligenceGovernor): void {
    this.governor = governor;
    this.clearEvaluationCacheForTests();
  }

  public static clearEvaluationCacheForTests(): void {
    this.evaluationCache.clear();
  }

  private static getCacheKey(mode: GovernorMode, correlationId?: string): string | null {
    if (!correlationId) return null;
    return `${mode}:${correlationId}`;
  }

  private static readCachedEvaluation(key: string | null): CachedEvaluation | null {
    if (!key) return null;
    const cached = this.evaluationCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > EVALUATION_CACHE_TTL_MS) {
      this.evaluationCache.delete(key);
      return null;
    }
    return cached;
  }

  private static writeCachedEvaluation(key: string | null, value: CachedEvaluation): void {
    if (!key) return;
    this.evaluationCache.set(key, value);
    if (this.evaluationCache.size <= EVALUATION_CACHE_MAX) return;

    const oldest = this.evaluationCache.keys().next().value as string | undefined;
    if (oldest) this.evaluationCache.delete(oldest);
  }

  public static evaluateRequest(
    input: GovernorInput,
    actualContext: ActualRequestContext,
    counterfactualInput?: CounterfactualInput
  ): { result: EvaluationResult; context: GovernorExecutionContext } {
    const mode = getGovernorMode();
    const cacheKey = this.getCacheKey(mode, input.correlationId);
    const cached = this.readCachedEvaluation(cacheKey);
    if (cached) return { result: cached.result, context: cached.context };

    // Active modes are evaluated before Auto Combo dispatch with the factual
    // candidate pool. The late chatCore observer only has the current preserve
    // route; evaluating there again would create two decisions for one logical
    // request. Direct/pinned requests are deliberately not governed by model/
    // provider active control, so a single preserve candidate is a safe no-op.
    if (
      (mode === "active" || mode === "active-canary") &&
      isLateObservationOnlyActiveInput(counterfactualInput)
    ) {
      const result: EvaluationResult = {
        recommendation: null,
        mode,
        decisionLatencyMs: 0,
      };
      const context = emptyExecutionContext(
        mode,
        input,
        actualContext,
        "active_requires_runtime_candidate_pool"
      );
      this.writeCachedEvaluation(cacheKey, { createdAt: Date.now(), result, context });
      return { result, context };
    }

    const baseResult = this.evaluateShadow(input, actualContext, counterfactualInput);
    let result = baseResult;
    const correlationId = input.correlationId ?? "unknown";
    const config = getGovernorRuntimeConfig();
    const plan = baseResult.plan;

    const context: GovernorExecutionContext = {
      correlationId,
      mode,
      decision: baseResult.recommendation,
      plan: plan ?? undefined,
      decisionCount: baseResult.recommendation ? 1 : 0,
      planResolutionCount: plan ? 1 : 0,
      originalRoute: {
        provider: actualContext.provider,
        model: actualContext.model,
        strategy: actualContext.routingStrategy,
      },
      planAvailable: Boolean(plan),
      eligibilityEvaluated: false,
      activeEligible: false,
      activeSelected: false,
      activeApplied: false,
      selectedDispatchCount: 0,
      fallbackDispatchCount: 0,
      fallbackAttempted: false,
      fallbackSucceeded: false,
      bypassReason: mode === "off" ? "off" : undefined,
    };

    if (mode === "active-canary" && plan) {
      const canary = assessActiveCanary(plan, correlationId, {
        enabled: config.activeEnabled,
        rate: config.canaryRate,
        maxEstimatedCost: config.maxEstimatedRequestCost,
      });
      context.eligibilityEvaluated = true;
      context.activeEligible = canary.eligible;
      context.activeSelected = canary.selected;
      context.bypassReason = canary.selected ? undefined : canary.reason;

      if (!canary.selected) {
        const runtimePlan = {
          ...plan,
          executable: false,
          reasons: [...plan.reasons, `active_canary=${canary.reason}`],
        };
        result = { ...baseResult, plan: runtimePlan };
        context.plan = runtimePlan;
      }
    } else if (mode === "active" && plan) {
      const costSafe =
        plan.estimatedCurrentCost != null &&
        plan.estimatedCounterfactualCost != null &&
        plan.estimatedCounterfactualCost <= plan.estimatedCurrentCost &&
        (config.maxEstimatedRequestCost == null ||
          plan.estimatedCounterfactualCost <= config.maxEstimatedRequestCost);
      context.eligibilityEvaluated = true;
      context.activeEligible =
        config.activeEnabled &&
        plan.executable &&
        plan.confidence === "HIGH" &&
        allHardGuardrailsPass(plan) &&
        costSafe;
      context.activeSelected = context.activeEligible;
      context.bypassReason = context.activeEligible
        ? undefined
        : !config.activeEnabled
          ? "kill_switch"
          : !plan.executable
            ? "plan_not_executable"
            : plan.confidence !== "HIGH"
              ? "insufficient_confidence"
              : !costSafe
                ? "cost_unknown_or_higher"
                : "guardrail_unknown_or_failed";
    }

    const value: CachedEvaluation = {
      createdAt: Date.now(),
      result,
      context,
    };
    this.writeCachedEvaluation(cacheKey, value);
    return { result, context };
  }

  public static evaluateShadow(
    input: GovernorInput,
    actualContext: ActualRequestContext,
    counterfactualInput?: CounterfactualInput
  ): EvaluationResult {
    const mode = getGovernorMode();

    if (mode === "off") {
      return {
        recommendation: null,
        mode: "off",
        decisionLatencyMs: 0,
      };
    }

    const startTime = performance.now();
    let recommendation: GovernorDecision;

    try {
      recommendation = this.governor.decide(input);
    } catch (error) {
      console.warn("[GovernorManager] Governor decision error:", error);
      return {
        recommendation: null,
        mode,
        decisionLatencyMs: Number((performance.now() - startTime).toFixed(3)),
      };
    }

    const decisionLatencyMs = Number((performance.now() - startTime).toFixed(3));
    const counterfactualPlan =
      ["simulate", "active-canary", "active"].includes(mode) && counterfactualInput
        ? resolveCounterfactualPlan(counterfactualInput, recommendation)
        : undefined;

    if (isGovernorTelemetryEnabled()) {
      const telemetryRecord: GovernorTelemetry = {
        correlationId:
          input.correlationId || `gov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        governorMode: mode,
        actualProvider: actualContext.provider || "unknown",
        actualModel: actualContext.model || "unknown",
        actualRoutingStrategy: actualContext.routingStrategy,
        actualReasoningConfig: actualContext.reasoningConfig,
        actualCompressionConfig: actualContext.compressionConfig,
        actualPromptTokens: actualContext.promptTokens ?? null,
        actualOutputTokens: actualContext.outputTokens ?? null,
        actualTotalTokens: actualContext.totalTokens ?? null,
        estimatedCost: actualContext.estimatedCost,
        latencyMs: actualContext.latencyMs ?? null,
        retryCount: actualContext.retryCount ?? null,
        success: actualContext.success ?? null,
        errorCategory: actualContext.errorCategory,
        recommendation,
        decisionLatencyMs,
        governorName: this.governor.name,
        governorVersion: this.governor.version,
        policyVersion: GOVERNOR_POLICY_VERSION,
        observedFeatures: {
          estimatedPromptTokens: input.estimatedPromptTokens ?? null,
          contextUtilization: input.contextUtilization ?? null,
          toolCount: input.toolCount ?? null,
          messageCount: input.messageCount ?? null,
          requestedMaxOutput: input.requestedMaxOutput ?? null,
          retryCount: input.retryCount ?? null,
          cacheState: input.cacheState ?? null,
        },
        counterfactualPlan,
      };

      enqueueGovernorTelemetryRow(telemetryRecord);
    }

    return {
      recommendation,
      mode,
      decisionLatencyMs,
      ...(counterfactualPlan ? { plan: counterfactualPlan } : {}),
    };
  }

  public static evaluateSimulation(input: CounterfactualInput): SimulationResult {
    const mode = getGovernorMode();
    if (mode !== "simulate") {
      return { recommendation: null, mode, decisionLatencyMs: 0, plan: null };
    }

    const start = performance.now();
    try {
      const recommendation = this.governor.decide(input);
      return {
        recommendation,
        mode: "simulate",
        decisionLatencyMs: Number((performance.now() - start).toFixed(3)),
        plan: resolveCounterfactualPlan(input, recommendation),
      };
    } catch {
      return {
        recommendation: null,
        mode: "simulate",
        decisionLatencyMs: Number((performance.now() - start).toFixed(3)),
        plan: null,
      };
    }
  }
}
