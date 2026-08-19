import { getCachedProviderConnections } from "../../src/lib/db/readCache.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { getCircuitBreaker } from "../../src/shared/utils/circuitBreaker.ts";
import {
  getGovernorMode,
  isGovernorTelemetryEnabled,
} from "../../src/shared/utils/featureFlags.ts";
import { getGovernorRuntimeConfig } from "../../open-sse/governor/runtimeConfig.ts";
import { applyGovernorToAutoComboOrder } from "../../open-sse/governor/autoComboRuntime.ts";
import { buildAutoCandidates } from "../../open-sse/services/combo.ts";
import { scoreAutoTargets } from "../../open-sse/services/combo/autoStrategy.ts";
import { DEFAULT_WEIGHTS } from "../../open-sse/services/autoCombo/scoring.ts";
import { createVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.ts";
import { getModelLockoutInfo } from "../../open-sse/services/accountFallback.ts";
import { estimateFinalInputTokens } from "../../open-sse/handlers/chatCore/contextEstimation.ts";
import { parseModel } from "../../open-sse/services/model.ts";

const WORKLOAD = Object.freeze([
  {
    id: "authoritative-exact-text",
    category: "EXACT_TEXT",
    prompt: "Reply with exactly AUTHORITATIVE-EXACT-OK and nothing else.",
  },
  {
    id: "authoritative-structured-json",
    category: "STRUCTURED_JSON",
    prompt: 'Return only this JSON object: {"status":"ok","value":17}',
  },
  {
    id: "authoritative-arithmetic",
    category: "ARITHMETIC",
    prompt: "Calculate 7 multiplied by 6. Reply with the single number 42 and nothing else.",
  },
  {
    id: "authoritative-extraction",
    category: "EXTRACTION",
    prompt:
      'Extract ticket and priority from this record. Return JSON only: {"ticket":"T-2048","priority":"high"}. Record: owner=omniroute; ticket=T-2048; priority=high',
  },
  {
    id: "authoritative-classification",
    category: "CLASSIFICATION",
    prompt: "Classify the word 'oak' as plant or animal. Reply with exactly plant.",
  },
  {
    id: "authoritative-portuguese-structured",
    category: "PORTUGUESE_STRUCTURED",
    prompt: 'Responda somente com este JSON: {"status":"ok","idioma":"pt","valor":17}',
  },
  {
    id: "authoritative-english-structured",
    category: "ENGLISH_STRUCTURED",
    prompt: 'Return only this JSON object: {"status":"ok","language":"en","value":17}',
  },
  {
    id: "authoritative-transformation",
    category: "TRANSFORMATION",
    prompt:
      "Transform the comma-separated tokens alpha,beta,gamma to uppercase hyphen-separated form. Reply exactly ALPHA-BETA-GAMMA.",
  },
  {
    id: "authoritative-short-reasoning",
    category: "SHORT_REASONING",
    prompt: "A box has 4 rows of 6 items. Reply with exactly 24 and nothing else.",
  },
  {
    id: "authoritative-simple-code",
    category: "SIMPLE_CODE",
    prompt:
      "Return exactly this JavaScript function and nothing else: function add(a, b) { return a + b; }",
  },
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function targetKey(provider, model) {
  return `${provider}/${model}`;
}

function targetFromResolved(target) {
  const parsed = parseModel(target.modelStr);
  const provider = target.provider || parsed.provider || "unknown";
  const model = parsed.model || target.modelStr;
  return {
    provider,
    model,
    key: targetKey(provider, model),
  };
}

function candidateKey(candidate) {
  return targetKey(candidate.provider, candidate.model);
}

function poolTargetDescriptor(target) {
  if (!target) return null;
  const parsed = targetFromResolved(target);
  return {
    provider: parsed.provider,
    model: parsed.model,
    connection: target.connectionId || "noauth",
  };
}

async function buildPool() {
  const virtualCombo = await createVirtualAutoCombo(undefined);
  const targets = virtualCombo.models.map((item) => ({
    kind: "model",
    stepId: item.id,
    executionKey: item.id,
    modelStr: item.model,
    provider: item.providerId,
    providerId: item.providerId,
    connectionId: item.connectionId,
    allowedConnectionIds: item.allowedConnectionIds || null,
    weight: item.weight,
    label: item.label,
  }));
  const candidates = await buildAutoCandidates(targets, "auto");
  const scored = scoreAutoTargets(
    targets,
    candidates,
    "default",
    virtualCombo.weights || DEFAULT_WEIGHTS
  );
  const connections = await getCachedProviderConnections({ isActive: true });
  const connectionState = new Map(
    connections.map((connection) => [
      connection.id,
      {
        provider: connection.provider,
        active: connection.isActive === true,
        testStatus: connection.testStatus || null,
        rateLimitedUntil: connection.rateLimitedUntil || null,
      },
    ])
  );
  const byProvider = {};
  for (const target of targets) {
    byProvider[target.provider] = (byProvider[target.provider] || 0) + 1;
  }
  const breakers = Object.fromEntries(
    Object.keys(byProvider).map((provider) => [provider, getCircuitBreaker(provider).getStatus()])
  );
  return {
    targets,
    candidates,
    scored,
    connections,
    connectionState,
    byProvider,
    breakers,
  };
}

function connectionPresence(connections) {
  const providers = new Set(
    connections.map((connection) => String(connection.provider).toLowerCase())
  );
  const has = (...names) => names.some((name) => providers.has(name));
  return {
    OpenRouter: has("openrouter"),
    Gemini: has("gemini", "google", "google-gemini"),
    NVIDIA: has("nvidia"),
    OpenCode: has("opencode"),
    Felo: has("felo", "felo-web"),
  };
}

async function revalidateTarget(pool, provider, model, target) {
  const candidate = pool.candidates.find(
    (item) => candidateKey(item) === targetKey(provider, model)
  );
  const breaker = getCircuitBreaker(provider).getStatus();
  const connectionIds = [
    target?.connectionId,
    ...(Array.isArray(target?.allowedConnectionIds) ? target.allowedConnectionIds : []),
  ].filter((id) => typeof id === "string" && id !== "noauth");
  const connectionChecks = connectionIds.map((connectionId) => {
    const connection = pool.connectionState.get(connectionId) || null;
    const rateLimitedUntil = connection?.rateLimitedUntil
      ? new Date(connection.rateLimitedUntil).getTime()
      : 0;
    const cooldown = Number.isFinite(rateLimitedUntil) && rateLimitedUntil > Date.now();
    const exhausted = ["unavailable", "banned", "expired", "credits_exhausted"].includes(
      connection?.testStatus
    );
    return {
      connectionId,
      active: connection?.active === true,
      cooldown,
      exhausted,
      available: connection?.active === true && !cooldown && !exhausted,
    };
  });
  const lockout = connectionIds.some((connectionId) =>
    Boolean(getModelLockoutInfo(provider, connectionId, model))
  );
  const connectionAllowed =
    connectionChecks.length === 0 || connectionChecks.some((check) => check.available);
  const cooldown = connectionChecks.length > 0 && connectionChecks.every((check) => check.cooldown);
  const exhausted =
    connectionChecks.length > 0 && connectionChecks.every((check) => check.exhausted);
  const guardrails = {
    active: Boolean(candidate),
    eligible: candidate?.quotaCutoffBlocked !== true,
    healthy: breaker.state !== "OPEN" && candidate?.statusPenalty !== true,
    cooldown: !cooldown,
    lockout: !lockout,
    exhausted: !exhausted,
    circuitAllowed: breaker.state !== "OPEN",
    connectionAllowed,
  };
  return {
    ...guardrails,
    connectionChecks,
    valid: Object.values(guardrails).every(Boolean),
    circuitState: breaker.state,
  };
}

function planGuardrailPass(plan) {
  const values = Object.values(plan?.guardrailResults || {});
  return values.every((value) => value !== "NO" && value !== false);
}

async function main() {
  const status = {
    mode: getGovernorMode(),
    active: getGovernorRuntimeConfig().activeEnabled,
    canary: getGovernorRuntimeConfig().canaryRate,
    telemetry: isGovernorTelemetryEnabled(),
  };
  const pool = await buildPool();
  const native = pool.targets[0] || null;
  const cases = [];
  for (const input of WORKLOAD) {
    const body = {
      model: "auto/chat",
      messages: [{ role: "user", content: input.prompt }],
      stream: true,
      max_tokens: 128,
    };
    let plan = null;
    let revalidation = null;
    let failureReason = null;
    try {
      const runtime = await applyGovernorToAutoComboOrder({
        body,
        promptText: input.prompt,
        estimatedInputTokens: estimateFinalInputTokens(body),
        taskType: "default",
        correlationId: `home-readiness-${input.id}`,
        nativeSelectedTarget: native,
        orderedTargets: pool.targets,
        routableCandidates: pool.candidates,
      });
      plan = runtime.context?.plan || null;
      const selectedProvider = plan?.selectedProvider || null;
      const selectedModel = plan?.selectedModel || null;
      if (selectedProvider && selectedModel) {
        const selectedTarget = pool.targets.find(
          (target) => targetFromResolved(target).key === targetKey(selectedProvider, selectedModel)
        );
        revalidation = await revalidateTarget(
          pool,
          selectedProvider,
          selectedModel,
          selectedTarget
        );
      }
      if (!plan) failureReason = "PLAN_MISSING";
      else if (!selectedProvider || !selectedModel) failureReason = "NO_TARGET";
      else if (!revalidation?.valid) failureReason = "GUARDRAIL_REVALIDATION_FAILED";
      else if (plan.executable !== true) failureReason = "PLAN_NOT_EXECUTABLE";
    } catch (error) {
      failureReason = error instanceof Error ? error.name : "PLANNING_ERROR";
    }
    const target =
      plan?.selectedProvider && plan?.selectedModel
        ? pool.targets.find(
            (item) =>
              targetFromResolved(item).key === targetKey(plan.selectedProvider, plan.selectedModel)
          )
        : null;
    const executable = plan?.executable === true && revalidation?.valid === true;
    cases.push({
      id: input.id,
      category: input.category,
      planProduced: Boolean(plan),
      provider: plan?.selectedProvider || null,
      model: plan?.selectedModel || null,
      connection: target?.connectionId || "unreported",
      active: revalidation?.active ?? false,
      eligible: revalidation?.eligible ?? false,
      healthy: revalidation?.healthy ?? false,
      cooldown: revalidation?.cooldown ?? false,
      lockout: revalidation?.lockout ?? false,
      exhausted: revalidation?.exhausted ?? false,
      circuitAllowed: revalidation?.circuitAllowed ?? false,
      connectionAllowed: revalidation?.connectionAllowed ?? false,
      guardrailPass: planGuardrailPass(plan) && revalidation?.valid === true,
      executable,
      failureReason,
      planGuardrails: plan?.guardrailResults || {},
      revalidation: revalidation || null,
    });
  }
  const distribution = {};
  for (const item of cases) {
    const key = item.provider && item.model ? targetKey(item.provider, item.model) : "UNPLANNED";
    distribution[key] = (distribution[key] || 0) + 1;
  }
  const plans = cases.filter((item) => item.planProduced).length;
  const guardrails = cases.filter((item) => item.guardrailPass).length;
  const executable = cases.filter((item) => item.executable).length;
  console.log(
    JSON.stringify(
      {
        providerModelRequests: 0,
        planningOnly: true,
        status,
        pool: {
          raw: pool.targets.length,
          active: pool.targets.length,
          eligible: pool.candidates.filter((candidate) => candidate.quotaCutoffBlocked !== true)
            .length,
          healthy: pool.candidates.filter(
            (candidate) =>
              candidate.circuitBreakerState !== "OPEN" && candidate.statusPenalty !== true
          ).length,
          providers: pool.byProvider,
          connections: connectionPresence(pool.connections),
          breakerStates: Object.fromEntries(
            Object.entries(pool.breakers).map(([provider, breaker]) => [provider, breaker.state])
          ),
        },
        workloads: cases,
        summary: {
          total: cases.length,
          plans,
          guardrails,
          executable,
          targetDistribution: distribution,
          lowDiversity: Object.keys(distribution).length === 1,
          readinessPass:
            status.mode === "simulate" &&
            status.active === false &&
            status.canary === 0 &&
            status.telemetry === true &&
            plans === cases.length &&
            guardrails === cases.length &&
            executable === cases.length,
        },
      },
      null,
      2
    )
  );
}

await main();
