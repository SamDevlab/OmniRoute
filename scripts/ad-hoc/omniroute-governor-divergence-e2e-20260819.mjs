import { randomUUID } from "node:crypto";

import { queryGovernorTelemetryRows } from "../../src/lib/db/governorTelemetry.ts";
import { getCachedProviderConnections, getCachedSettings } from "../../src/lib/db/readCache.ts";
import { getCallLogs } from "../../src/lib/usage/callLogs.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { getCircuitBreaker } from "../../src/shared/utils/circuitBreaker.ts";
import { getModelLockoutInfo } from "../../open-sse/services/accountFallback.ts";
import { getGovernorMode } from "../../src/shared/utils/featureFlags.ts";
import { applyGovernorToAutoComboOrder } from "../../open-sse/governor/autoComboRuntime.ts";
import { resolveGovernorPricingEvidence } from "../../open-sse/governor/autoComboRuntime.ts";
import { estimateFinalInputTokens } from "../../open-sse/handlers/chatCore/contextEstimation.ts";
import { buildAutoCandidates } from "../../open-sse/services/combo.ts";
import { scoreAutoTargets } from "../../open-sse/services/combo/autoStrategy.ts";
import { DEFAULT_WEIGHTS } from "../../open-sse/services/autoCombo/scoring.ts";
import { createVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.ts";
import { parseModel } from "../../open-sse/services/model.ts";
import { classifyTier } from "../../open-sse/services/tierResolver.ts";
import {
  consumeSseText,
  createSseState,
  evaluateQuality,
  flushSseText,
  isStreamComplete,
  normalizeText,
} from "./omniroute-shadow-benchmark-core.mjs";
import {
  createBenchmarkRun,
  hashJson,
  persistBenchmarkArtifact,
} from "./omniroute-governor-benchmark-persistence.mjs";
import {
  assessGovernorRuntimeReadiness,
  classifyGovernorPlan,
  evaluatePairState,
} from "./omniroute-governor-pair-state.mjs";
import {
  createNativeBaselineSnapshot,
  nativeBaselineRequest,
  nativeBaselineStateDigest,
  resolveNativeBaselineWithoutExecution,
} from "./omniroute-governor-native-baseline.mjs";
import {
  canonicalTargetKey,
  evaluatePlannedConnectionIdentity,
  resolveNativeBaselinePoolTarget,
  resolvePlanTargetDescriptor,
  targetIdentityFromResolved,
} from "./omniroute-governor-target-identity.mjs";

const BASE_URL = process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128";
const REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.SHADOW_REQUEST_TIMEOUT_MS || 600_000)
);
const MAX_TOKENS = 128;
const MAX_OUTPUT_CAPTURE = 8_192;
const poolOnly = process.argv.includes("--pool-only");
const workloadOnly = process.argv.includes("--workload-only");
const e2eOnly = process.argv.includes("--e2e-only");
const directOnly = process.argv.includes("--direct-only");
const replayOnly = process.argv.includes("--replay-only");
const e2eReplayOnly = process.argv.includes("--e2e-replay");
const calibrationRecoveryOnly = process.argv.includes("--calibration-recovery");
const authoritativeOnly = process.argv.includes("--authoritative-e2e");
const requestedPairs = Number(
  process.argv.find((arg) => arg.startsWith("--pairs="))?.split("=")[1] || 10
);

let activeBenchmarkRun = null;
let signalHandlersInstalled = false;
let activeBenchmarkSignalHandler = null;

/** Fixed before any request. Do not edit this list based on observed choices. */
export const DIVERGENCE_WORKLOAD = [
  {
    id: "simple-fast",
    category: "SIMPLE_FAST",
    prompt: "Reply with exactly DIVERGENCE-SIMPLE-OK and nothing else.",
    expected: "DIVERGENCE-SIMPLE-OK",
  },
  {
    id: "structured-json",
    category: "STRUCTURED_JSON",
    prompt: 'Return only this JSON object: {"status":"ok","value":17}',
    expectedJson: { status: "ok", value: 17 },
    quality: "json",
  },
  {
    id: "code-generation",
    category: "CODE_GENERATION",
    prompt:
      "Return exactly this JavaScript function and nothing else: function add(a, b) { return a + b; }",
    expectedOutput: "function add(a, b) { return a + b; }",
    quality: "code",
  },
  {
    id: "code-reasoning",
    category: "CODE_REASONING",
    prompt: "What does this print? Reply with exactly 8 and nothing else: let x = 3; x += 5;",
    expected: "8",
  },
  {
    id: "long-context",
    category: "LONG_CONTEXT",
    prompt: `Read the fixed context below and reply with exactly LONG-CONTEXT-OK and nothing else.\n${"context-marker-20260819 ".repeat(
      300
    )}`,
    expected: "LONG-CONTEXT-OK",
  },
  {
    id: "portuguese",
    category: "PORTUGUESE",
    prompt: "Responda exatamente com DIVERGENCIA-PT-OK e nada mais.",
    expected: "DIVERGENCIA-PT-OK",
  },
  {
    id: "english",
    category: "ENGLISH",
    prompt: "Output exactly DIVERGENCE-EN-OK and no other text.",
    expected: "DIVERGENCE-EN-OK",
  },
  {
    id: "extraction",
    category: "EXTRACTION",
    prompt:
      "Extract the value of ticket from this text and reply with exactly T-2048: owner=omniroute; ticket=T-2048; priority=high",
    expected: "T-2048",
  },
  {
    id: "classification",
    category: "CLASSIFICATION",
    prompt: "Classify the word 'oak' as plant or animal. Reply with exactly plant.",
    expected: "plant",
  },
  {
    id: "reasoning",
    category: "REASONING",
    prompt: "A box has 4 rows of 6 items. Reply with exactly 24 and nothing else.",
    expected: "24",
  },
  {
    id: "format-strict",
    category: "FORMAT_STRICT",
    prompt: "Reply with exactly [STRICT|20260819] including brackets and the pipe.",
    expected: "[STRICT|20260819]",
  },
  {
    id: "low-cost-candidate",
    category: "LOW_COST_CANDIDATE_SCENARIO",
    prompt: "For this light request, reply with exactly LOW-COST-OK and nothing else.",
    expected: "LOW-COST-OK",
  },
];

const CALIBRATION_CASES = [
  { caseId: "low-cost-candidate", label: "EXACT" },
  { caseId: "structured-json", label: "JSON" },
  { caseId: "code-reasoning", label: "ARITHMETIC" },
];

/** Frozen before Pair 1 of the authoritative benchmark. */
export const AUTHORITATIVE_WORKLOAD = Object.freeze([
  {
    id: "authoritative-exact-text",
    category: "EXACT_TEXT",
    prompt: "Reply with exactly AUTHORITATIVE-EXACT-OK and nothing else.",
    expected: "AUTHORITATIVE-EXACT-OK",
    validator: "exact",
  },
  {
    id: "authoritative-structured-json",
    category: "STRUCTURED_JSON",
    prompt: 'Return only this JSON object: {"status":"ok","value":17}',
    expectedJson: { status: "ok", value: 17 },
    validator: "json",
  },
  {
    id: "authoritative-arithmetic",
    category: "ARITHMETIC",
    prompt: "Calculate 7 multiplied by 6. Reply with the single number 42 and nothing else.",
    expected: "42",
    validator: "arithmetic",
  },
  {
    id: "authoritative-extraction",
    category: "EXTRACTION",
    prompt:
      'Extract ticket and priority from this record. Return JSON only: {"ticket":"T-2048","priority":"high"}. Record: owner=omniroute; ticket=T-2048; priority=high',
    expectedFields: { ticket: "T-2048", priority: "high" },
    validator: "extraction",
  },
  {
    id: "authoritative-classification",
    category: "CLASSIFICATION",
    prompt: "Classify the word 'oak' as plant or animal. Reply with exactly plant.",
    expected: "plant",
    allowedValues: ["plant", "animal"],
    validator: "classification",
  },
  {
    id: "authoritative-portuguese-structured",
    category: "PORTUGUESE_STRUCTURED",
    prompt: 'Responda somente com este JSON: {"status":"ok","idioma":"pt","valor":17}',
    expectedFields: { status: "ok", idioma: "pt", valor: 17 },
    validator: "portuguese_structured",
  },
  {
    id: "authoritative-english-structured",
    category: "ENGLISH_STRUCTURED",
    prompt: 'Return only this JSON object: {"status":"ok","language":"en","value":17}',
    expectedFields: { status: "ok", language: "en", value: 17 },
    validator: "english_structured",
  },
  {
    id: "authoritative-transformation",
    category: "TRANSFORMATION",
    prompt:
      "Transform the comma-separated tokens alpha,beta,gamma to uppercase hyphen-separated form. Reply exactly ALPHA-BETA-GAMMA.",
    expected: "ALPHA-BETA-GAMMA",
    validator: "transformation",
  },
  {
    id: "authoritative-short-reasoning",
    category: "SHORT_REASONING",
    prompt: "A box has 4 rows of 6 items. Reply with exactly 24 and nothing else.",
    expected: "24",
    validator: "short_reasoning",
  },
  {
    id: "authoritative-simple-code",
    category: "SIMPLE_CODE",
    prompt:
      "Return exactly this JavaScript function and nothing else: function add(a, b) { return a + b; }",
    expected: "function add(a, b) { return a + b; }",
    validator: "simple_code",
    localCheck: { operation: "add", inputs: [2, 3], result: 5 },
  },
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function captureQualityOutput(content) {
  const output = typeof content === "string" ? content : "";
  return {
    actualOutput: output.slice(0, MAX_OUTPUT_CAPTURE),
    outputLength: output.length,
    outputTruncated: output.length > MAX_OUTPUT_CAPTURE,
  };
}

function qualityResult(input, content, pass, reason, expected = input?.expected ?? null) {
  return {
    pass,
    judged: true,
    validator: input?.validator || input?.quality || "exact",
    expected,
    reason: pass ? null : reason,
    ...captureQualityOutput(content),
  };
}

function evaluateHarnessQuality(input, content) {
  if (
    !input?.validator ||
    (!input.validator.includes("structured") && input.validator !== "extraction")
  ) {
    return evaluateQuality(input, content, { outputCaptureLimit: MAX_OUTPUT_CAPTURE });
  }

  const actual = normalizeText(content);
  if (!actual) return qualityResult(input, content, false, "empty_reconstructed_content");

  let parsed;
  try {
    parsed = JSON.parse(actual);
  } catch {
    return qualityResult(input, content, false, "invalid_json", input.expectedFields);
  }

  const expected = input.expectedFields;
  const pass = Object.entries(expected || {}).every(([key, value]) =>
    sameJson(parsed?.[key], value)
  );
  return qualityResult(input, content, pass, "structured_field_mismatch", expected);
}

function evaluateAuthoritativeQuality(input, content) {
  if (!input?.validator)
    return evaluateQuality(input, content, { outputCaptureLimit: MAX_OUTPUT_CAPTURE });
  if (input.validator.includes("structured") || input.validator === "extraction") {
    return evaluateHarnessQuality(input, content);
  }

  const actual = normalizeText(content);
  if (!actual) return qualityResult(input, content, false, "empty_reconstructed_content");
  const expected = normalizeText(input.expected);
  let pass = false;
  let reason = "exact_value_mismatch";

  switch (input.validator) {
    case "json": {
      try {
        pass = sameJson(JSON.parse(actual), input.expectedJson);
        reason = pass ? null : "json_value_mismatch";
      } catch {
        reason = "invalid_json";
      }
      return qualityResult(input, content, pass, reason, input.expectedJson);
    }
    case "arithmetic":
    case "short_reasoning":
      pass = Number(actual) === Number(expected);
      reason = pass ? null : "numeric_value_mismatch";
      break;
    case "classification":
      pass = input.allowedValues.includes(actual) && actual === expected;
      reason = pass ? null : "closed_set_value_mismatch";
      break;
    case "simple_code": {
      const localCheck = input.localCheck;
      const localCheckPass =
        localCheck?.operation === "add" &&
        Array.isArray(localCheck.inputs) &&
        localCheck.inputs.length === 2 &&
        localCheck.inputs[0] + localCheck.inputs[1] === localCheck.result;
      pass =
        actual === expected &&
        /^function add\(a, b\) \{ return a \+ b; \}$/.test(actual) &&
        localCheckPass;
      reason = pass
        ? null
        : actual === expected
          ? "local_code_check_failed"
          : "exact_value_mismatch";
      break;
    }
    case "exact":
    case "transformation":
    default:
      pass = actual === expected;
      break;
  }
  return qualityResult(input, content, pass, reason, input.expected);
}

function requestBodyForInput(model, input) {
  const configured =
    input?.requestBody && typeof input.requestBody === "object" && !Array.isArray(input.requestBody)
      ? input.requestBody
      : {};
  const defaultMessages = [{ role: "user", content: input?.prompt || "" }];
  return {
    model,
    messages: defaultMessages,
    stream: true,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...configured,
    model,
    messages: configured.messages || defaultMessages,
  };
}

function header(response, name) {
  return response.headers.get(name) || response.headers.get(name.toLowerCase()) || null;
}

function targetKey(provider, model) {
  return `${provider}/${model}`;
}

function normalizeTarget(provider, model) {
  return (
    canonicalTargetKey(provider, model) || targetKey(provider || "unknown", model || "unknown")
  );
}

function targetFromResolved(target) {
  const identity = targetIdentityFromResolved(target);
  return {
    provider: identity.provider || "unknown",
    model: identity.model || target?.modelStr || "unknown",
    key: identity.canonicalTarget || normalizeTarget(identity.provider, identity.model),
    modelStr: target?.modelStr || null,
    executionKey: identity.executionKey || null,
    connectionId: identity.connectionId || null,
  };
}

function resolvedTargetDescriptor(target) {
  if (!target) return null;
  const resolved = targetFromResolved(target);
  return {
    provider: resolved.provider,
    model: resolved.model,
    connectionId: target.connectionId || null,
    allowedConnectionIds: Array.isArray(target.allowedConnectionIds)
      ? target.allowedConnectionIds
      : null,
    target: resolved.key,
  };
}

function callLogTarget(identity) {
  if (!identity?.provider || !identity.model) return null;
  return normalizeTarget(identity.provider, identity.model);
}

function safePlan(row) {
  const plan = row?.counterfactualPlan;
  if (!plan) return null;
  return {
    governorMode: row.governorMode || null,
    selectedProvider: plan.selectedProvider || null,
    selectedModel: plan.selectedModel || null,
    resolvedModelTier: plan.resolvedModelTier || null,
    estimatedCurrentCost: plan.estimatedCurrentCost ?? null,
    estimatedCounterfactualCost: plan.estimatedCounterfactualCost ?? null,
    costEstimateBasis: plan.costEstimateBasis || null,
    estimatedSavings: plan.estimatedSavings ?? null,
    confidence: plan.confidence || null,
    executable: plan.executable === true,
    unresolvedFields: Array.isArray(plan.unresolvedFields) ? plan.unresolvedFields : [],
    guardrails: plan.guardrailResults || {},
    reasons: Array.isArray(plan.reasons) ? plan.reasons : [],
    recommendationTier: row.recommendation?.modelPolicy?.recommendedTier || null,
    routingStrategy: row.recommendation?.routingPolicy?.strategy || null,
    actualProvider: row.actualProvider || null,
    actualModel: row.actualModel || null,
    decisionLatencyMs: finite(row.decisionLatencyMs),
  };
}

async function readGovernorPlan(correlationId) {
  if (!correlationId) return null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const row = queryGovernorTelemetryRows(300).find(
      (entry) => entry.correlationId === correlationId && entry.counterfactualPlan
    );
    const plan = safePlan(row);
    if (plan) return plan;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

async function readCallLogIdentity(correlationIds) {
  const ids = [
    ...new Set((Array.isArray(correlationIds) ? correlationIds : [correlationIds]).filter(Boolean)),
  ];
  if (ids.length === 0) return null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (const correlationId of ids) {
      const row = (await getCallLogs({ correlationId, limit: 5 })).find(
        (entry) => entry.correlationId === correlationId
      );
      if (row) {
        return {
          provider: row.provider || null,
          model: row.model || null,
          requestedModel: row.requestedModel || null,
          connectionId: row.connectionId || null,
          status: row.status ?? null,
          durationMs: finite(row.duration),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function readStreamingBody(response, input, started) {
  const state = createSseState();
  if (!response.body) return state;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const now = performance.now();
      state.firstByteAt ??= now;
      buffer = consumeSseText(buffer, decoder.decode(value, { stream: true }), state, now);
    }
    buffer += decoder.decode();
    flushSseText(buffer, state, performance.now());
    state.readerCompleted = true;
  } finally {
    state.connectionClosedAt = performance.now();
    state.readerCloseMs = Math.round(state.connectionClosedAt - started);
    reader.releaseLock();
  }
  state.quality = evaluateAuthoritativeQuality(input, state.content);
  state.qualityPass = state.quality.pass === true;
  state.completionMs = Math.round(state.connectionClosedAt - started);
  state.firstByteMs = state.firstByteAt ? Math.round(state.firstByteAt - started) : null;
  state.firstContentMs = state.firstContentAt ? Math.round(state.firstContentAt - started) : null;
  state.doneMs = state.doneAt ? Math.round(state.doneAt - started) : null;
  return state;
}

export async function request(model, input, armLabel) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const requestCorrelationId = `divergence-${input.id}-${armLabel}-${randomUUID()}`;
  let response = null;
  try {
    response = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "X-OmniRoute-No-Cache": "true",
        "X-Correlation-Id": requestCorrelationId,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify(requestBodyForInput(model, input)),
    });
    const headersAt = performance.now();
    const stream = await readStreamingBody(response, input, started);
    const responseCorrelationId = header(response, "x-correlation-id");
    const streamCompleted = isStreamComplete(response.status, stream);
    const quality = stream.quality || evaluateAuthoritativeQuality(input, stream.content);
    const callLogIdentity = await readCallLogIdentity([
      requestCorrelationId,
      responseCorrelationId,
    ]);
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      status: response.status,
      completionMs: stream.completionMs ?? Math.round(performance.now() - started),
      latencyMs: Math.round(performance.now() - started),
      headersAtMs: Math.round(headersAt - started),
      firstByteMs: stream.firstByteMs,
      firstContentMs: stream.firstContentMs,
      doneMs: stream.doneMs,
      readerCloseMs: stream.readerCloseMs,
      streamCompleted,
      readerCompleted: stream.readerCompleted,
      streamEventCount: stream.eventCount,
      responseModel: stream.responseModel,
      usage: stream.usage,
      actualOutput: quality.actualOutput,
      outputLength: quality.outputLength,
      outputTruncated: quality.outputTruncated,
      qualityValidator: quality.validator,
      qualityReason: quality.reason,
      qualityPass: streamCompleted && quality.pass === true,
      failureClass: !streamCompleted
        ? response.status === 200
          ? "STREAM_FAILURE"
          : "EXECUTION_HTTP_FAILURE"
        : quality.pass === false
          ? "MODEL_QUALITY_FAILURE"
          : null,
      errorCode: stream.errorCode || stream.parseError,
      requestCorrelationId,
      responseCorrelationId,
      correlationId: responseCorrelationId || requestCorrelationId,
      requestId: header(response, "x-request-id") || header(response, "x-omniroute-request-id"),
      fallbackAttempts: Number(header(response, "x-omniroute-fallback-attempts")) || 0,
      callLogIdentity,
      executedTarget: callLogTarget(callLogIdentity),
      executedConnectionId: callLogIdentity?.connectionId || null,
      model,
      armLabel,
      category: input.category,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "TRANSPORT_ERROR";
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      status: 0,
      completionMs: null,
      latencyMs: Math.round(performance.now() - started),
      headersAtMs: null,
      firstByteMs: null,
      firstContentMs: null,
      doneMs: null,
      readerCloseMs: null,
      streamCompleted: false,
      readerCompleted: false,
      streamEventCount: 0,
      responseModel: null,
      usage: null,
      actualOutput: "",
      outputLength: 0,
      outputTruncated: false,
      qualityValidator: input.validator || input.quality || "exact",
      qualityReason: "transport_error",
      qualityPass: false,
      failureClass:
        name === "TimeoutError" || name === "AbortError" ? "HARNESS_TIMEOUT" : "HARNESS_FAILURE",
      errorCode: name,
      requestCorrelationId,
      responseCorrelationId: null,
      correlationId: requestCorrelationId,
      requestId: null,
      fallbackAttempts: null,
      callLogIdentity: null,
      executedTarget: null,
      executedConnectionId: null,
      model,
      armLabel,
      category: input.category,
    };
  }
}

function modelForTarget(pool, provider, model) {
  const key = normalizeTarget(provider, model);
  const matches = pool.targets.filter((item) => targetFromResolved(item).key === key);
  const modelStrs = [...new Set(matches.map((target) => target.modelStr).filter(Boolean))];
  return modelStrs.length === 1 ? modelStrs[0] : `${provider}/${model}`;
}

function candidateKey(candidate) {
  return normalizeTarget(candidate.provider, candidate.model);
}

function candidateDetails(pool, provider, model) {
  const key = normalizeTarget(provider, model);
  const candidate = pool.candidates.find((item) => candidateKey(item) === key);
  const score = pool.scored.find((item) => targetFromResolved(item.target).key === key);
  return {
    score: finite(score?.score),
    factors: score?.factors || null,
    health: finite(
      candidate?.reliabilityObserved === false
        ? null
        : candidate?.failureRate != null
          ? 1 - candidate.failureRate
          : candidate?.errorRate != null
            ? 1 - candidate.errorRate
            : null
    ),
    reliabilityObserved: candidate?.reliabilityObserved ?? null,
    errorRate: finite(candidate?.errorRate),
    failureRate: finite(candidate?.failureRate),
    circuitBreakerState: candidate?.circuitBreakerState || null,
    statusPenalty: candidate?.statusPenalty === true,
    quotaCutoffBlocked: candidate?.quotaCutoffBlocked === true,
    latencyMs: finite(candidate?.p95LatencyMs),
  };
}

async function buildPool() {
  const virtualCombo = await createVirtualAutoCombo(undefined);
  const routingSettings = await getCachedSettings().catch(() => ({}));
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
  const metadata = await Promise.all(
    candidates.slice(0, 24).map(async (candidate) => {
      const capabilities = getResolvedModelCapabilities({
        provider: candidate.provider,
        model: candidate.model,
      });
      const pricing = await resolveGovernorPricingEvidence(candidate.provider, candidate.model);
      const score = scored.find(
        (entry) => candidateKey(candidate) === targetFromResolved(entry.target).key
      );
      return {
        provider: candidate.provider,
        model: candidate.model,
        score: finite(score?.score),
        pricing: pricing.pricingKnown ? "known" : "unknown",
        contextWindow: capabilities.contextWindow ?? null,
        capabilities: {
          tools: capabilities.toolCalling || capabilities.supportsTools === true,
          structuredOutput: capabilities.structuredOutput === true,
          vision: capabilities.supportsVision === true,
          reasoning: capabilities.reasoning ?? null,
        },
        tier: classifyTier(candidate.provider, candidate.model).tier || null,
        latencyP95Ms: finite(candidate.p95LatencyMs),
        reliabilityObserved: candidate.reliabilityObserved ?? null,
        failureRate: finite(candidate.failureRate),
        errorRate: finite(candidate.errorRate),
        healthScore:
          candidate.reliabilityObserved === false
            ? null
            : finite(
                candidate.failureRate != null
                  ? 1 - candidate.failureRate
                  : candidate.errorRate != null
                    ? 1 - candidate.errorRate
                    : null
              ),
        circuitBreakerState: candidate.circuitBreakerState || null,
        connectionState:
          candidate.connectionId === "noauth"
            ? "synthetic-noauth"
            : connectionState.get(candidate.connectionId) || "unreported",
      };
    })
  );
  const byProvider = {};
  for (const target of targets)
    byProvider[target.provider] = (byProvider[target.provider] || 0) + 1;
  const breakers = Object.fromEntries(
    Object.keys(byProvider).map((provider) => [provider, getCircuitBreaker(provider).getStatus()])
  );
  const cooldowns = connections
    .filter((connection) => {
      const rateLimitedUntil = connection.rateLimitedUntil
        ? new Date(connection.rateLimitedUntil).getTime()
        : 0;
      return Number.isFinite(rateLimitedUntil) && rateLimitedUntil > Date.now();
    })
    .map((connection) => ({
      provider: connection.provider,
      connectionId: connection.id,
      rateLimitedUntil: connection.rateLimitedUntil,
    }));
  const lockouts = candidates
    .filter(
      (candidate) =>
        candidate.connectionId &&
        getModelLockoutInfo(candidate.provider, candidate.connectionId, candidate.model)
    )
    .map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      connectionId: candidate.connectionId,
    }));
  return {
    virtualCombo,
    routingSettings,
    targets,
    candidates,
    scored,
    metadata,
    connectionState,
    byProvider,
    snapshotAt: new Date().toISOString(),
    breakers,
    cooldowns,
    lockouts,
    raw: targets.length,
    active: targets.length,
    eligible: candidates.filter((candidate) => candidate.quotaCutoffBlocked !== true).length,
    healthy: candidates.filter(
      (candidate) =>
        candidate.circuitBreakerState !== "OPEN" &&
        candidate.statusPenalty !== true &&
        candidate.quotaCutoffBlocked !== true
    ).length,
    executablePlans: null,
  };
}

async function revalidateTarget(pool, provider, model) {
  const key = normalizeTarget(provider, model);
  const targets = pool.targets.filter((item) => targetFromResolved(item).key === key);
  const candidates = pool.candidates.filter((item) => candidateKey(item) === key);
  if (targets.length === 0 || candidates.length === 0) {
    return { valid: false, reason: "target_not_in_current_pool" };
  }

  const breaker = getCircuitBreaker(provider).getStatus();
  const connectionIds = [
    ...new Set(
      targets.flatMap((target) => [
        target.connectionId,
        ...(Array.isArray(target.allowedConnectionIds) ? target.allowedConnectionIds : []),
      ])
    ),
  ].filter((id) => typeof id === "string" && id !== "noauth");
  const hasSyntheticNoauth = targets.some(
    (target) =>
      target.connectionId === "noauth" ||
      (Array.isArray(target.allowedConnectionIds) && target.allowedConnectionIds.includes("noauth"))
  );
  const connectionChecks = connectionIds.map((connectionId) => {
    const connection = pool.connectionState?.get(connectionId) || null;
    const rateLimitedUntil = connection?.rateLimitedUntil
      ? new Date(connection.rateLimitedUntil).getTime()
      : 0;
    const cooldownActive = Number.isFinite(rateLimitedUntil) && rateLimitedUntil > Date.now();
    const unavailableStatus = ["unavailable", "banned", "expired", "credits_exhausted"].includes(
      connection?.testStatus
    );
    const modelLocked = Boolean(getModelLockoutInfo(provider, connectionId, model));
    return {
      connectionId,
      connection,
      cooldownActive,
      unavailableStatus,
      modelLocked,
      available:
        connection?.active === true && !cooldownActive && !unavailableStatus && !modelLocked,
    };
  });
  const modelLockout =
    connectionChecks.length > 0 && connectionChecks.every((check) => check.modelLocked);
  const connectionEligible =
    hasSyntheticNoauth || connectionChecks.some((check) => check.available);
  const cooldownActive =
    connectionChecks.length > 0 && connectionChecks.every((check) => check.cooldownActive);
  const unavailableStatus =
    connectionChecks.length > 0 && connectionChecks.every((check) => check.unavailableStatus);
  const candidateEligible = candidates.some((candidate) => candidate.quotaCutoffBlocked !== true);
  const candidateHealthy = candidates.some(
    (candidate) => candidate.circuitBreakerState !== "OPEN" && candidate.statusPenalty !== true
  );
  const guardrails = {
    active: true,
    eligible: candidateEligible,
    healthy: breaker.state !== "OPEN" && candidateHealthy,
    notCooldown: hasSyntheticNoauth || !cooldownActive,
    notLocked: hasSyntheticNoauth || !modelLockout,
    notExhausted: hasSyntheticNoauth || !unavailableStatus,
    circuitAllowed: breaker.state !== "OPEN",
  };
  const valid = Object.values(guardrails).every(Boolean) && connectionEligible;
  return {
    valid,
    providerCircuitState: breaker.state,
    targetCount: targets.length,
    candidateCount: candidates.length,
    connectionState:
      connectionChecks.length > 0
        ? connectionChecks.map(
            ({ connectionId, connection, cooldownActive, unavailableStatus, modelLocked }) => ({
              connectionId,
              active: connection?.active === true,
              testStatus: connection?.testStatus || null,
              cooldownActive,
              unavailableStatus,
              modelLocked,
            })
          )
        : hasSyntheticNoauth
          ? "synthetic-noauth"
          : "unreported",
    cooldownActive,
    unavailableStatus,
    modelLockout,
    connectionEligible,
    hasSyntheticNoauth,
    guardrails,
    reason: valid ? null : "stale_or_ineligible_target",
  };
}

function planTarget(plan) {
  return plan?.selectedProvider && plan?.selectedModel
    ? normalizeTarget(plan.selectedProvider, plan.selectedModel)
    : null;
}

function nativeTarget(observation) {
  if (!observation.plan?.actualProvider || !observation.plan?.actualModel) return null;
  if (observation.request.status !== 200 || observation.request.fallbackAttempts !== 0) return null;
  return normalizeTarget(observation.plan.actualProvider, observation.plan.actualModel);
}

function summarizeTarget(pool, key) {
  if (!key) return null;
  const [provider, ...modelParts] = key.split("/");
  return {
    target: key,
    ...candidateDetails(pool, provider, modelParts.join("/")),
  };
}

function choiceReason(pool, plan) {
  if (!plan) return "no_governor_plan";
  const selected = summarizeTarget(pool, planTarget(plan));
  return [
    `tier=${plan.resolvedModelTier || "unknown"}`,
    `strategy=${plan.routingStrategy || "unknown"}`,
    `health=${selected?.health ?? "unknown"}`,
    `score=${selected?.score ?? "unavailable"}`,
    `guards=${plan.executable ? "executable" : "not_executable"}`,
  ].join(",");
}

async function runDivergenceWorkload(pool) {
  const decisions = [];
  for (const input of DIVERGENCE_WORKLOAD) {
    const requestResult = await request("auto/chat", input, "native-observe");
    const plan = await readGovernorPlan(requestResult.correlationId);
    const native = nativeTarget({ request: requestResult, plan });
    const governor = planTarget(plan);
    const agreement = native && governor ? native === governor : null;
    decisions.push({
      caseId: input.id,
      category: input.category,
      nativeTarget: native,
      governorTarget: governor,
      agreement,
      nativeProven: native !== null,
      request: requestResult,
      plan,
      governorScore: summarizeTarget(pool, governor)?.score ?? null,
      governorHealth: summarizeTarget(pool, governor)?.health ?? null,
      governorReliabilityObserved: summarizeTarget(pool, governor)?.reliabilityObserved ?? null,
      unresolvedFields: plan?.unresolvedFields || ["governorPlan"],
      reasonForGovernorChoice: choiceReason(pool, plan),
      featuresThatDiffer: {
        native: summarizeTarget(pool, native),
        governor: summarizeTarget(pool, governor),
      },
    });
  }
  return decisions;
}

function replayLatestDecisionsFromTelemetry() {
  const rows = queryGovernorTelemetryRows(500)
    .filter((row) => row.governorMode === "simulate" && row.counterfactualPlan)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const completedCaseIds = DIVERGENCE_WORKLOAD.filter((input) => input.id !== "classification").map(
    (input) => input.id
  );
  const selectedRows = rows.slice(-completedCaseIds.length);
  return selectedRows.map((row, index) => {
    const plan = safePlan(row);
    const native =
      index === 0
        ? null
        : row.actualProvider && row.actualModel
          ? normalizeTarget(row.actualProvider, row.actualModel)
          : null;
    const governor = planTarget(plan);
    return {
      caseId: completedCaseIds[index],
      category: DIVERGENCE_WORKLOAD.find((input) => input.id === completedCaseIds[index]).category,
      nativeTarget: native,
      governorTarget: governor,
      agreement: native && governor ? native === governor : null,
      nativeProven: Boolean(native),
      request: null,
      plan,
      governorScore: summarizeTarget(pool, governor)?.score ?? null,
      governorHealth: summarizeTarget(pool, governor)?.health ?? null,
      governorReliabilityObserved: summarizeTarget(pool, governor)?.reliabilityObserved ?? null,
      unresolvedFields: plan?.unresolvedFields || ["governorPlan"],
      reasonForGovernorChoice: choiceReason(pool, plan),
      featuresThatDiffer: {
        native: summarizeTarget(pool, native),
        governor: summarizeTarget(pool, governor),
      },
    };
  });
}

async function runDirectComparisons(pool, decisions) {
  const eligible = decisions.filter((decision) => decision.nativeTarget && decision.governorTarget);
  const disagreements = eligible.filter((decision) => decision.agreement === false);
  const controls = eligible.filter((decision) => decision.agreement === true).slice(0, 2);
  const selected = [...disagreements, ...controls];
  const results = [];
  for (const [index, decision] of selected.entries()) {
    const nativeParts = decision.nativeTarget.split("/");
    const governorParts = decision.governorTarget.split("/");
    const nativeProvider = nativeParts.shift();
    const governorProvider = governorParts.shift();
    const nativeModel = nativeParts.join("/");
    const governorModel = governorParts.join("/");
    const input = DIVERGENCE_WORKLOAD.find((item) => item.id === decision.caseId);
    const nativeCheck = await revalidateTarget(pool, nativeProvider, nativeModel);
    const governorCheck = await revalidateTarget(pool, governorProvider, governorModel);
    if (!nativeCheck.valid || !governorCheck.valid) {
      results.push({
        caseId: decision.caseId,
        targetComparison: decision.agreement ? "AGREEMENT_CONTROL" : "DISAGREEMENT",
        invalid: true,
        invalidReason: { native: nativeCheck, governor: governorCheck },
      });
      continue;
    }
    const nativeModelStr = modelForTarget(pool, nativeProvider, nativeModel);
    const governorModelStr = modelForTarget(pool, governorProvider, governorModel);
    const governorFirst = index % 2 === 1;
    const first = governorFirst
      ? await request(governorModelStr, input, "governor-direct")
      : await request(nativeModelStr, input, "native-direct");
    const second = governorFirst
      ? await request(nativeModelStr, input, "native-direct")
      : await request(governorModelStr, input, "governor-direct");
    const native = governorFirst ? second : first;
    const governor = governorFirst ? first : second;
    const qualityWinner =
      native.qualityPass === governor.qualityPass
        ? "tie"
        : native.qualityPass
          ? "native"
          : "governor";
    const reliabilityWinner =
      native.streamCompleted === governor.streamCompleted
        ? "tie"
        : native.streamCompleted
          ? "native"
          : "governor";
    const nativeSucceeded = native.status === 200 && native.streamCompleted === true;
    const governorSucceeded = governor.status === 200 && governor.streamCompleted === true;
    const latencyWinner =
      Number.isFinite(native.completionMs) && Number.isFinite(governor.completionMs)
        ? native.completionMs === governor.completionMs
          ? "tie"
          : native.completionMs < governor.completionMs
            ? "native"
            : "governor"
        : Number.isFinite(native.firstContentMs) && Number.isFinite(governor.firstContentMs)
          ? native.firstContentMs === governor.firstContentMs
            ? "tie"
            : native.firstContentMs < governor.firstContentMs
              ? "native"
              : "governor"
          : "tie";
    const winner =
      qualityWinner !== "tie"
        ? qualityWinner
        : nativeSucceeded !== governorSucceeded
          ? nativeSucceeded
            ? "native"
            : "governor"
          : latencyWinner;
    const winnerReason =
      qualityWinner !== "tie"
        ? "quality"
        : nativeSucceeded !== governorSucceeded
          ? "success"
          : latencyWinner !== "tie"
            ? Number.isFinite(native.completionMs) && Number.isFinite(governor.completionMs)
              ? "completion_latency"
              : "ttft"
            : "tie";
    results.push({
      caseId: decision.caseId,
      targetComparison: decision.agreement ? "AGREEMENT_CONTROL" : "DISAGREEMENT",
      invalid: false,
      order: governorFirst ? "governor_then_native" : "native_then_governor",
      native,
      governor,
      pairwise: {
        qualityWinner,
        reliabilityWinner,
        latencyWinner,
        winner,
        winnerReason,
        completionDeltaMs:
          (governor.completionMs ?? governor.latencyMs) - (native.completionMs ?? native.latencyMs),
      },
    });
  }
  return results;
}

async function runGovernorE2E(
  pool,
  input,
  nativeBaseline,
  { artifactRun = null, pairId = null, order = null, authoritative = false } = {}
) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const baselineReference =
    typeof nativeBaseline === "string"
      ? { nativeBaselineTarget: nativeBaseline }
      : nativeBaseline || {};
  const baselineLookup = resolveNativeBaselinePoolTarget(pool.targets, baselineReference);
  const nativeTargetResolved = baselineLookup.target;
  if (!nativeTargetResolved) {
    const failureReason =
      baselineLookup.failureReason || "NATIVE_BASELINE_TARGET_NOT_IN_CURRENT_POOL";
    const governorPlanOperationId = appendGovernorPlanOperation(artifactRun, {
      pairId,
      input,
      order,
      startedAt,
      completedAt: new Date().toISOString(),
      planningMs: null,
      plan: null,
      plannedTarget: null,
      planState: {
        state: "NATIVE_TARGET_MISSING",
        executable: false,
        failureClass: "HARNESS_FAILURE",
        failureReason,
        rootCause: "HARNESS_LOGIC_ERROR",
      },
      effectiveGovernorMode: artifactRun?.effectiveGovernorMode || getGovernorMode(),
      authoritative,
    });
    return {
      caseId: input.id,
      valid: false,
      reason: failureReason,
      failureClass: "HARNESS_FAILURE",
      failureReason,
      rootCause: "HARNESS_LOGIC_ERROR",
      stopBenchmark: true,
      governorPlanOperationId,
      baselineLookup,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
  const body = requestBodyForInput("auto/chat", input);
  const planningStarted = performance.now();
  const planningStartedAt = new Date().toISOString();
  const planningCorrelationId = "e2e-governor-" + input.id + "-" + randomUUID();
  const runtime = await applyGovernorToAutoComboOrder({
    body,
    promptText: input.prompt,
    estimatedInputTokens: estimateFinalInputTokens(body),
    taskType: "default",
    correlationId: planningCorrelationId,
    nativeSelectedTarget: nativeTargetResolved,
    orderedTargets: pool.targets,
    routableCandidates: pool.candidates,
  });
  const planningMs = Math.round(performance.now() - planningStarted);
  const planningCompletedAt = new Date().toISOString();
  const plan = runtime.context?.plan || null;
  const effectiveGovernorMode = artifactRun?.effectiveGovernorMode || getGovernorMode();
  const key = planTarget(plan);
  const plannedTarget = key ? resolvePlanTargetDescriptor(pool.targets, key) : null;
  const revalidation =
    plan?.executable === true && key
      ? await revalidateTarget(pool, ...key.split(/\/(.*)/s).slice(0, 2))
      : null;
  const planState = classifyGovernorPlan({ plan, effectiveGovernorMode, revalidation });
  const targetDiagnostics = key
    ? {
        ...candidateDetails(pool, ...key.split(/\/(.*)/s).slice(0, 2)),
        targetPresent: pool.candidates.some((candidate) => candidateKey(candidate) === key),
        target: key,
      }
    : null;
  const governorPlanOperationId = appendGovernorPlanOperation(artifactRun, {
    pairId,
    input,
    order,
    startedAt: planningStartedAt,
    completedAt: planningCompletedAt,
    planningMs,
    plan,
    plannedTarget,
    planState,
    effectiveGovernorMode,
    targetDiagnostics,
    revalidation,
    authoritative,
  });
  if (planState.state !== "PLAN_EXECUTABLE") {
    return {
      caseId: input.id,
      valid: false,
      reason: planState.failureReason || "GOVERNOR_PLAN_NOT_EXECUTABLE",
      failureClass: planState.failureClass,
      failureReason: planState.failureReason,
      rootCause: planState.rootCause,
      pairState: planState.state,
      stopBenchmark: planState.stopBenchmark,
      planState,
      effectiveGovernorMode,
      planningMs,
      planningCorrelationId,
      e2eCompletionMs: Math.round(performance.now() - started),
      governorPlanOperationId,
      startedAt,
      completedAt: new Date().toISOString(),
      plan,
      revalidation,
      baselineLookup,
    };
  }
  const [provider, ...modelParts] = key.split("/");
  const model = modelParts.join("/");
  const direct = await request(modelForTarget(pool, provider, model), input, "governor-e2e-direct");
  const executedTarget = direct.executedTarget;
  const targetMatch = executedTarget ? (executedTarget === key ? "PASS" : "MISMATCH") : "UNKNOWN";
  const plannedConnectionId = plannedTarget?.connectionId || null;
  const connectionIdentity = evaluatePlannedConnectionIdentity(
    plannedTarget,
    direct.executedConnectionId
  );
  const targetIdentity =
    targetMatch === "MISMATCH" || connectionIdentity === "MISMATCH"
      ? "MISMATCH"
      : targetMatch === "PASS" && connectionIdentity === "PASS"
        ? "PASS"
        : "UNKNOWN";
  const identityFailureClass =
    targetIdentity === "MISMATCH"
      ? "TARGET_MISMATCH"
      : targetIdentity === "UNKNOWN"
        ? "HARNESS_FAILURE"
        : null;
  const e2eCompletionMs = Math.round(performance.now() - started);
  const governorOperationId = appendArmOperation(artifactRun, {
    operationType: "governor_arm",
    arm: "governor",
    pairId,
    caseId: input.id,
    category: input.category,
    order,
    request: direct,
    totalE2EMs: e2eCompletionMs,
    startedAt: direct.startedAt || startedAt,
    completedAt: direct.completedAt || new Date().toISOString(),
    plannedTarget,
    planningMs,
    planningShare: e2eCompletionMs > 0 ? planningMs / e2eCompletionMs : null,
    authoritative,
  });
  return {
    caseId: input.id,
    valid: direct.status === 200 && direct.streamCompleted && identityFailureClass === null,
    failureClass: identityFailureClass || direct.failureClass,
    failureReason: identityFailureClass ? identityFailureClass : direct.failureClass || null,
    rootCause: identityFailureClass || null,
    pairState: "GOVERNOR_ARM_COMPLETE",
    stopBenchmark: identityFailureClass !== null,
    planState,
    effectiveGovernorMode,
    planningMs,
    planningCorrelationId,
    e2eCompletionMs,
    governorPlanOperationId,
    governorOperationId,
    startedAt,
    completedAt: new Date().toISOString(),
    plan,
    plannedTarget,
    executedTarget,
    plannedConnectionId,
    executedConnectionId: direct.executedConnectionId,
    targetIdentity,
    targetMatch,
    connectionIdentity,
    revalidation,
    direct,
    selectedTarget: key,
    baselineLookup,
  };
}

async function runNativeE2E(
  input,
  {
    artifactRun = null,
    pairId = null,
    order = null,
    authoritative = false,
    nativeBaselineTarget = null,
    nativeBaselineExecutionKey = null,
    nativeBaselineConnection = null,
    baselineSnapshotId = null,
    baselineSnapshotHash = null,
  } = {}
) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const requestResult = await request("auto/chat", input, "native-e2e");
  const plan = await readGovernorPlan(requestResult.correlationId);
  const observedTarget =
    plan?.actualProvider && plan?.actualModel
      ? normalizeTarget(plan.actualProvider, plan.actualModel)
      : requestResult.responseModel
        ? normalizeTarget(
            parseModel(requestResult.responseModel).provider || "unknown",
            parseModel(requestResult.responseModel).model || requestResult.responseModel
          )
        : null;
  const executedTarget = requestResult.executedTarget;
  const nativeFinalTarget = executedTarget || observedTarget;
  const nativeFirstTarget = requestResult.fallbackAttempts === 0 ? observedTarget : null;
  const targetIdentity =
    observedTarget && executedTarget
      ? observedTarget === executedTarget
        ? "PASS"
        : "MISMATCH"
      : "UNKNOWN";
  const e2eCompletionMs = Math.round(performance.now() - started);
  const nativeOperationId = appendArmOperation(artifactRun, {
    operationType: "native_arm",
    arm: "native",
    pairId,
    caseId: input.id,
    category: input.category,
    order,
    request: requestResult,
    totalE2EMs: e2eCompletionMs,
    startedAt: requestResult.startedAt || startedAt,
    completedAt: requestResult.completedAt || new Date().toISOString(),
    nativeFirstTarget,
    nativeFinalTarget,
    nativeBaselineTarget,
    nativeBaselineExecutionKey,
    nativeBaselineConnection,
    nativeBaselineResolution: nativeBaselineTarget ? "side_effect_free" : null,
    baselineSnapshotId,
    baselineSnapshotHash,
    baselineDrift:
      nativeBaselineTarget && nativeFirstTarget ? nativeBaselineTarget !== nativeFirstTarget : null,
    nativeFallback:
      nativeFirstTarget && nativeFinalTarget ? nativeFirstTarget !== nativeFinalTarget : null,
    authoritative,
  });
  return {
    caseId: input.id,
    valid:
      requestResult.status === 200 && requestResult.streamCompleted && targetIdentity === "PASS",
    failureClass:
      targetIdentity === "MISMATCH"
        ? "TARGET_MISMATCH"
        : targetIdentity === "UNKNOWN"
          ? "HARNESS_FAILURE"
          : requestResult.failureClass,
    e2eCompletionMs,
    nativeOperationId,
    startedAt,
    completedAt: new Date().toISOString(),
    routingOverheadMs: null,
    request: requestResult,
    plan,
    selectedTarget: observedTarget,
    nativeFirstTarget,
    nativeFinalTarget,
    nativeBaselineTarget,
    nativeBaselineExecutionKey,
    baselineNativeTarget: nativeBaselineTarget,
    nativeFirstActualTarget: nativeFirstTarget,
    nativeFinalActualTarget: nativeFinalTarget,
    baselineVsFirstActual:
      nativeBaselineTarget && nativeFirstTarget
        ? nativeBaselineTarget === nativeFirstTarget
          ? "PASS"
          : "MISMATCH"
        : "UNKNOWN",
    baselineVsFinalActual:
      nativeBaselineTarget && nativeFinalTarget
        ? nativeBaselineTarget === nativeFinalTarget
          ? "PASS"
          : "MISMATCH"
        : "UNKNOWN",
    baselineDrift:
      nativeBaselineTarget && nativeFirstTarget && nativeBaselineTarget !== nativeFirstTarget,
    nativeFallback:
      nativeFirstTarget && nativeFinalTarget && nativeFirstTarget !== nativeFinalTarget,
    executedTarget,
    executedConnectionId: requestResult.executedConnectionId,
    targetIdentity,
  };
}

async function runE2E(
  pool,
  decisions,
  pairCount,
  { artifactRun = null, authoritative = false } = {}
) {
  const usable = decisions
    .filter((decision) => decision.nativeTarget)
    .slice(0, Math.min(10, pairCount));
  const pairs = [];
  for (const [index, decision] of usable.entries()) {
    const input = DIVERGENCE_WORKLOAD.find((item) => item.id === decision.caseId);
    const governorFirst = index % 2 === 1;
    const pairId = "pair-" + String(index + 1).padStart(2, "0");
    const order = governorFirst ? "governor_then_native" : "native_then_governor";
    const baselineReference =
      decision.nativeBaseline ||
      (decision.nativeBaselineTarget
        ? {
            nativeBaselineTarget: decision.nativeBaselineTarget,
            nativeBaselineCanonicalTarget:
              decision.nativeBaselineCanonicalTarget || decision.nativeBaselineTarget,
            nativeBaselineExecutionKey: decision.nativeBaselineExecutionKey || null,
            nativeBaselineConnection: decision.nativeBaselineConnection || null,
          }
        : decision.nativeTarget);
    const governorPromise = () =>
      runGovernorE2E(pool, input, baselineReference, {
        artifactRun,
        pairId,
        order,
        authoritative,
      });
    const nativePromise = () =>
      runNativeE2E(input, {
        artifactRun,
        pairId,
        order,
        authoritative,
        nativeBaselineTarget: decision.nativeBaselineTarget || null,
        nativeBaselineExecutionKey: decision.nativeBaselineExecutionKey || null,
        nativeBaselineConnection: decision.nativeBaselineConnection || null,
        baselineSnapshotId: decision.baselineSnapshotId || null,
        baselineSnapshotHash: decision.baselineSnapshotHash || null,
      });
    const first = governorFirst ? await governorPromise() : await nativePromise();
    const second = governorFirst ? await nativePromise() : await governorPromise();
    const native = governorFirst ? second : first;
    const governor = governorFirst ? first : second;
    const pair = {
      pairId,
      caseId: decision.caseId,
      order,
      native,
      governor,
      baseline: typeof baselineReference === "object" ? baselineReference : null,
      nativeBaselineTarget: decision.nativeBaselineTarget || null,
      nativeBaselineExecutionKey: decision.nativeBaselineExecutionKey || null,
      baselineSnapshotId: decision.baselineSnapshotId || null,
      baselineSnapshotHash: decision.baselineSnapshotHash || null,
    };
    appendPairCompleteOperation(artifactRun, pair, input, authoritative);
    pairs.push(pair);
  }
  return pairs;
}

function summarizeResults(results, resultSelector) {
  const values = results
    .map(resultSelector)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const percentile = (fraction) =>
    values.length
      ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))]
      : null;
  return {
    count: results.length,
    success: results.filter(
      (result) =>
        (result.valid && result.request?.status === 200) ||
        (result.valid && result.direct?.status === 200)
    ).length,
    quality: results.filter((result) => (result.request || result.direct)?.qualityPass === true)
      .length,
    ttftP50: percentile(0.5),
    completionP50: percentile(0.5),
    completionP95: percentile(0.95),
  };
}

function summarizeE2EArm(pairs, side) {
  const values = pairs
    .map((pair) => pair[side])
    .filter((result) => result?.valid)
    .map((result) => result.e2eCompletionMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const ttft = pairs
    .map((pair) => pair[side])
    .filter((result) => result?.valid)
    .map((result) => (result.request || result.direct)?.firstContentMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (values, fraction) =>
    values.length
      ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))]
      : null;
  const results = pairs.map((pair) => pair[side]);
  return {
    pairs: pairs.length,
    success: results.filter(
      (result) => result?.valid && (result.request?.status === 200 || result.direct?.status === 200)
    ).length,
    quality: results.filter((result) => (result.request || result.direct)?.qualityPass === true)
      .length,
    ttftP50Ms: percentile(ttft, 0.5),
    completionP50Ms: percentile(values, 0.5),
    completionP95Ms: percentile(values, 0.95),
    planningP50Ms: percentile(
      pairs
        .map((pair) => pair.governor?.planningMs)
        .filter(Number.isFinite)
        .sort((a, b) => a - b),
      0.5
    ),
  };
}

function compactRequest(request) {
  if (!request) return null;
  return {
    status: request.status,
    streamCompleted: request.streamCompleted,
    readerCompleted: request.readerCompleted,
    sawDone: request.doneMs !== null,
    qualityPass: request.qualityPass,
    qualityValidator: request.qualityValidator,
    qualityReason: request.qualityReason,
    failureClass: request.failureClass,
    actualOutput: request.actualOutput,
    outputLength: request.outputLength,
    usage: request.usage,
    headersMs: request.headersAtMs,
    firstByteMs: request.firstByteMs,
    firstContentMs: request.firstContentMs,
    doneMs: request.doneMs,
    readerCloseMs: request.readerCloseMs,
    completionMs: request.completionMs,
    streamEventCount: request.streamEventCount,
    responseModel: request.responseModel,
    requestCorrelationId: request.requestCorrelationId,
    responseCorrelationId: request.responseCorrelationId,
    correlationId: request.correlationId,
    requestId: request.requestId,
    executedTarget: request.executedTarget,
    executedConnectionId: request.executedConnectionId,
  };
}

function operationTargetParts(target) {
  const key = typeof target === "string" ? target : target?.target || null;
  if (!key) return { provider: null, model: null, target: null };
  const [provider, ...modelParts] = key.split("/");
  return { provider, model: modelParts.join("/"), target: key };
}

function requestOperationFields(request, totalE2EMs) {
  const executed = operationTargetParts(request?.executedTarget);
  return {
    httpStatus: request?.status ?? null,
    headersMs: request?.headersAtMs ?? null,
    firstByteMs: request?.firstByteMs ?? null,
    firstContentMs: request?.firstContentMs ?? null,
    doneMs: request?.doneMs ?? null,
    readerCloseMs: request?.readerCloseMs ?? null,
    completionMs: request?.completionMs ?? null,
    totalE2EMs: totalE2EMs ?? null,
    streamCompleted: request?.streamCompleted === true,
    readerCompleted: request?.readerCompleted === true,
    doneSeen: request?.doneMs != null,
    streamEventCount: request?.streamEventCount ?? 0,
    outputLength: request?.outputLength ?? 0,
    outputPreview: request?.actualOutput ?? "",
    outputTruncated: request?.outputTruncated === true,
    validator: request?.qualityValidator ?? null,
    qualityPass: request?.qualityPass === true,
    qualityReason: request?.qualityReason ?? null,
    failureClass: request?.failureClass ?? null,
    attempts: Number.isFinite(request?.fallbackAttempts) ? request.fallbackAttempts + 1 : null,
    fallbackCount: request?.fallbackAttempts ?? null,
    requestCorrelationId: request?.requestCorrelationId ?? null,
    responseCorrelationId: request?.responseCorrelationId ?? null,
    requestId: request?.requestId ?? null,
    executedProvider: executed.provider,
    executedModel: executed.model,
    executedTarget: executed.target,
    executedConnectionId: request?.executedConnectionId ?? null,
  };
}

function appendArmOperation(
  run,
  {
    operationType,
    arm,
    pairId,
    caseId,
    category,
    order,
    request,
    totalE2EMs,
    startedAt,
    completedAt,
    plannedTarget,
    nativeFirstTarget,
    nativeFinalTarget,
    nativeBaselineTarget,
    nativeBaselineExecutionKey,
    nativeBaselineConnection,
    nativeBaselineResolution,
    baselineSnapshotId,
    baselineSnapshotHash,
    baselineDrift,
    nativeFallback,
    planningMs,
    planningShare,
    authoritative,
  }
) {
  if (!run) return null;
  const planned = operationTargetParts(plannedTarget);
  const nativeFirst = operationTargetParts(nativeFirstTarget);
  const nativeFinal = operationTargetParts(nativeFinalTarget);
  return run.appendOperation({
    operationType,
    arm,
    pairId: pairId || null,
    caseId,
    category,
    order: order || null,
    authoritative: authoritative === true,
    startedAt: startedAt || request?.startedAt || new Date().toISOString(),
    completedAt: completedAt || request?.completedAt || new Date().toISOString(),
    ...requestOperationFields(request, totalE2EMs),
    plannedProvider: planned.provider,
    plannedModel: planned.model,
    plannedTarget: planned.target,
    plannedConnectionId: plannedTarget?.connectionId || null,
    nativeFirstProvider: nativeFirst.provider,
    nativeFirstModel: nativeFirst.model,
    nativeFirstTarget: nativeFirst.target,
    nativeFinalProvider: nativeFinal.provider,
    nativeFinalModel: nativeFinal.model,
    nativeFinalTarget: nativeFinal.target,
    nativeFirstActualTarget: nativeFirst.target,
    nativeFinalActualTarget: nativeFinal.target,
    nativeBaselineProvider: operationTargetParts(nativeBaselineTarget).provider,
    nativeBaselineModel: operationTargetParts(nativeBaselineTarget).model,
    nativeBaselineTarget: operationTargetParts(nativeBaselineTarget).target,
    nativeBaselineCanonicalTarget: operationTargetParts(nativeBaselineTarget).target,
    nativeBaselineExecutionKey: nativeBaselineExecutionKey || null,
    nativeBaselineConnection: nativeBaselineConnection || plannedTarget?.connectionId || null,
    nativeBaselineResolution: nativeBaselineResolution || null,
    baselineSnapshotId: baselineSnapshotId || null,
    baselineSnapshotHash: baselineSnapshotHash || null,
    baselineDrift: baselineDrift ?? null,
    nativeFallback: nativeFallback ?? null,
    planningMs: planningMs ?? null,
    planningShare: planningShare ?? null,
  });
}

function appendGovernorPlanOperation(
  run,
  {
    pairId,
    input,
    order,
    startedAt,
    completedAt,
    planningMs,
    plan,
    plannedTarget,
    planState,
    effectiveGovernorMode,
    targetDiagnostics,
    revalidation,
    authoritative,
  }
) {
  if (!run) return null;
  const planned = operationTargetParts(plannedTarget);
  const guardrails = revalidation?.guardrails || null;
  return run.appendOperation({
    operationType: "governor_plan",
    arm: "governor",
    pairId: pairId || null,
    caseId: input.id,
    category: input.category,
    order: order || null,
    authoritative: authoritative === true,
    startedAt: startedAt || new Date().toISOString(),
    completedAt: completedAt || new Date().toISOString(),
    planningMs: planningMs ?? null,
    planningShare: null,
    plannedProvider: planned.provider,
    plannedModel: planned.model,
    plannedTarget: planned.target,
    plannedConnectionId: plannedTarget?.connectionId || null,
    allowedConnectionIds: plannedTarget?.allowedConnectionIds || [],
    planPresent: Boolean(plan),
    planState: planState?.state || null,
    executable: planState?.executable === true,
    confidence: plan?.confidence || null,
    guardrailResults: plan?.guardrailResults || null,
    unresolvedFields: plan?.unresolvedFields || [],
    reasons: plan?.reasons || [],
    effectiveGovernorMode: effectiveGovernorMode || null,
    governorModeMatch: effectiveGovernorMode === "simulate",
    targetActive: guardrails?.active ?? null,
    targetEligible:
      guardrails?.eligible ??
      (targetDiagnostics?.targetPresent ? !targetDiagnostics.quotaCutoffBlocked : null),
    targetHealthy:
      guardrails?.healthy ??
      (targetDiagnostics?.targetPresent ? targetDiagnostics.statusPenalty !== true : null),
    targetCooldown: revalidation?.cooldownActive ?? null,
    targetLockout: revalidation?.modelLockout ?? null,
    targetExhausted: revalidation?.unavailableStatus ?? null,
    targetCircuitAllowed: guardrails?.circuitAllowed ?? null,
    providerCircuitState:
      revalidation?.providerCircuitState ?? targetDiagnostics?.circuitBreakerState ?? null,
    connectionAllowed: revalidation?.connectionEligible ?? null,
    connectionState: revalidation?.connectionState ?? null,
    revalidation: revalidation
      ? {
          valid: revalidation.valid,
          reason: revalidation.reason,
          guardrails,
          cooldownActive: revalidation.cooldownActive ?? null,
          modelLockout: revalidation.modelLockout ?? null,
          unavailableStatus: revalidation.unavailableStatus ?? null,
          connectionEligible: revalidation.connectionEligible ?? null,
        }
      : null,
    failureClass: planState?.failureClass || null,
    failureReason: planState?.failureReason || null,
    rootCause: planState?.rootCause || null,
  });
}

function appendPairCompleteOperation(run, pair, input, authoritative) {
  if (!run) return null;
  const nativeRequest = pair.native?.request || null;
  const governorRequest = pair.governor?.direct || null;
  const pairState =
    pair.pairState ||
    evaluatePairState({ native: pair.native, governor: pair.governor, baseline: pair.baseline });
  const pairwise = pair.pairwise || pairState;
  const valid = pair.invalid !== true && pairState.valid === true;
  const operationId = run.appendOperation({
    operationType: "pair_complete",
    pairId: pair.pairId || "pair-" + input.id,
    caseId: input.id,
    category: input.category,
    order: pair.order || null,
    authoritative: authoritative === true,
    startedAt: pair.startedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    nativeOperationId: pair.nativeOperationId || pair.native?.nativeOperationId || null,
    governorOperationIds: {
      plan: pair.governorPlanOperationId || pair.governor?.governorPlanOperationId || null,
      arm: pair.governorOperationId || pair.governor?.governorOperationId || null,
    },
    valid,
    pairState: pairState.pairState,
    structuralValid: pairState.structuralValid,
    winner: valid ? (pairwise.winner ?? null) : null,
    reason: valid ? (pairwise.winnerReason ?? null) : null,
    qualityWinner: pairwise.qualityWinner ?? null,
    successWinner: pairwise.successWinner ?? null,
    latencyWinner: pairwise.latencyWinner ?? null,
    agreement:
      pair.agreement ??
      (pair.native.selectedTarget && pair.governor.selectedTarget
        ? pair.native.selectedTarget === pair.governor.selectedTarget
        : null),
    nativeHttp: nativeRequest?.status ?? null,
    governorHttp: governorRequest?.status ?? null,
    nativeStreamCompleted: nativeRequest?.streamCompleted === true,
    governorStreamCompleted: governorRequest?.streamCompleted === true,
    nativeQualityPass: nativeRequest?.qualityPass === true,
    governorQualityPass: governorRequest?.qualityPass === true,
    nativeQualityReason: nativeRequest?.qualityReason ?? null,
    governorQualityReason: governorRequest?.qualityReason ?? null,
    governorPlanOperationId:
      pair.governorPlanOperationId || pair.governor?.governorPlanOperationId || null,
    governorArmOperationId: pair.governorOperationId || pair.governor?.governorOperationId || null,
    nativeBaselineOperationId: pair.nativeBaselineOperationId || null,
    nativeBaselineTarget: pair.nativeBaselineTarget || pair.baseline?.nativeBaselineTarget || null,
    nativeBaselineCanonicalTarget:
      pair.nativeBaselineTarget || pair.baseline?.nativeBaselineCanonicalTarget || null,
    nativeBaselineExecutionKey:
      pair.nativeBaselineExecutionKey || pair.baseline?.nativeBaselineExecutionKey || null,
    nativeFirstActualTarget: pair.nativeFirstActualTarget || null,
    nativeFinalActualTarget: pair.nativeFinalActualTarget || null,
    baselineVsFirstActual: pair.baselineVsFirstActual || null,
    baselineVsFinalActual: pair.baselineVsFinalActual || null,
    baselineDrift: pair.baselineDrift || null,
    nativeFallback: pair.nativeFallback || null,
    nativeTargetIdentity: pair.native?.targetIdentity || null,
    baselineSnapshotId:
      pair.native?.baselineSnapshotId || pair.baseline?.baselineSnapshotId || null,
    baselineSnapshotHash:
      pair.native?.baselineSnapshotHash || pair.baseline?.baselineSnapshotHash || null,
    governorPlanExecutable:
      pair.governor?.planState?.executable === true || pair.governor?.plan?.executable === true,
    governorTargetIdentity: pair.governor?.targetIdentity || null,
    failureClass:
      pairState.failureClass || pair.governor?.failureClass || pair.native?.failureClass || null,
    failureReason: pairState.failureReason || pair.governor?.failureReason || null,
    stopBenchmark: pairState.stopBenchmark === true,
  });
  pair.pairCompleteOperationId = operationId;
  return operationId;
}

function compactE2E(pairs) {
  return pairs.map((pair) => {
    const input = DIVERGENCE_WORKLOAD.find((item) => item.id === pair.caseId);
    return {
      caseId: pair.caseId,
      category: input?.category || null,
      prompt: input?.prompt || null,
      expected: input?.expectedOutput ?? input?.expected ?? input?.expectedJson ?? null,
      order: pair.order,
      native: {
        valid: pair.native.valid,
        failureClass: pair.native.failureClass || null,
        selectedTarget: pair.native.selectedTarget,
        nativeFirstTarget: pair.native.nativeFirstTarget || null,
        nativeFinalTarget: pair.native.nativeFinalTarget || null,
        executedTarget: pair.native.executedTarget || null,
        executedConnectionId: pair.native.executedConnectionId || null,
        targetIdentity: pair.native.targetIdentity || null,
        e2eCompletionMs: pair.native.e2eCompletionMs,
        request: compactRequest(pair.native.request),
      },
      governor: {
        valid: pair.governor.valid,
        failureClass: pair.governor.failureClass || null,
        selectedTarget: pair.governor.selectedTarget,
        plannedTarget: pair.governor.plannedTarget || null,
        executedTarget: pair.governor.executedTarget || null,
        plannedConnectionId: pair.governor.plannedConnectionId || null,
        executedConnectionId: pair.governor.executedConnectionId || null,
        targetIdentity: pair.governor.targetIdentity || null,
        targetMatch: pair.governor.targetMatch || null,
        connectionIdentity: pair.governor.connectionIdentity || null,
        planningMs: pair.governor.planningMs,
        planningCorrelationId: pair.governor.planningCorrelationId || null,
        e2eCompletionMs: pair.governor.e2eCompletionMs,
        revalidation: pair.governor.revalidation || null,
        direct: compactRequest(pair.governor.direct),
      },
    };
  });
}

async function resolveAuthoritativeNativeBaseline(
  input,
  snapshot,
  { artifactRun = null, authoritative = true } = {}
) {
  const beforeDigest = nativeBaselineStateDigest(snapshot);
  const startedAt = new Date().toISOString();
  const resolution = resolveNativeBaselineWithoutExecution({
    snapshot,
    request: nativeBaselineRequest(
      input.id,
      input.prompt,
      input.requestBody && typeof input.requestBody === "object" ? input.requestBody : {}
    ),
  });
  const afterDigest = nativeBaselineStateDigest(snapshot);
  const completedAt = new Date().toISOString();
  const baselineTarget = resolution.nativeBaselineTarget || null;
  const baselineCanonicalTarget = resolution.nativeBaselineCanonicalTarget || baselineTarget;
  const baselineExecutionKey = resolution.nativeBaselineExecutionKey || null;
  const baselineOperationId = artifactRun?.appendOperation({
    operationType: "native_baseline_resolution",
    arm: "native",
    caseId: input.id,
    category: input.category,
    order: null,
    authoritative,
    startedAt,
    completedAt,
    nativeBaselineProvider: resolution.nativeBaselineProvider || null,
    nativeBaselineModel: resolution.nativeBaselineModel || null,
    nativeBaselineConnection: resolution.nativeBaselineConnection || null,
    nativeBaselineTarget: baselineTarget,
    nativeBaselineCanonicalTarget: baselineCanonicalTarget,
    nativeBaselineExecutionKey: baselineExecutionKey,
    nativeBaselineResolution: "side_effect_free",
    baselineSnapshotId: resolution.baselineSnapshotId,
    baselineSnapshotHash: resolution.baselineSnapshotHash,
    nativeBaselineCandidateOrder: resolution.nativeBaselineCandidateOrder || [],
    nativeBaselineCandidateCount: resolution.nativeBaselineCandidateCount || 0,
    nativeBaselineSelection: resolution.nativeBaselineSelection,
    providerModelRequests: 0,
    governorProviderModelPreflightRequests: 0,
    networkCalls: resolution.networkCalls,
    routingStateMutation: false,
    homeStateDigestBefore: beforeDigest,
    homeStateDigestAfter: afterDigest,
    valid: resolution.valid === true,
    failureClass: resolution.valid ? null : "NATIVE_BASELINE_RESOLUTION_FAILED",
    failureReason: resolution.error || null,
  });
  return {
    caseId: input.id,
    nativeBaselineTarget: baselineTarget,
    nativeBaselineCanonicalTarget: baselineCanonicalTarget,
    nativeBaselineExecutionKey: baselineExecutionKey,
    nativeBaselineProvider: resolution.nativeBaselineProvider || null,
    nativeBaselineModel: resolution.nativeBaselineModel || null,
    nativeBaselineConnection: resolution.nativeBaselineConnection || null,
    nativeBaselineResolution: "side_effect_free",
    baselineSnapshotId: resolution.baselineSnapshotId,
    baselineSnapshotHash: resolution.baselineSnapshotHash,
    nativeBaselineCandidateOrder: resolution.nativeBaselineCandidateOrder || [],
    nativeBaselineCandidateCount: resolution.nativeBaselineCandidateCount || 0,
    providerModelRequests: 0,
    networkCalls: resolution.networkCalls,
    routingStateMutation: false,
    homeStateDigestBefore: beforeDigest,
    homeStateDigestAfter: afterDigest,
    valid: resolution.valid === true && Boolean(baselineTarget),
    failureClass: resolution.valid ? null : "NATIVE_BASELINE_RESOLUTION_FAILED",
    failureReason: resolution.error || null,
    baselineOperationId,
  };
}

async function resolveOfflineNativeBaselines(
  pool,
  workload,
  { artifactRun = null, authoritative = false } = {}
) {
  const snapshot = await createNativeBaselineSnapshot({
    pool,
    routingSettings: pool.routingSettings,
  });
  const baselines = [];
  for (const input of workload) {
    baselines.push(
      await resolveAuthoritativeNativeBaseline(input, snapshot, {
        artifactRun,
        authoritative,
      })
    );
  }
  return { snapshot, baselines };
}

function buildAuthoritativePair(pairId, input, order, baseline, native, governor) {
  const pairState = evaluatePairState({ native, governor, baseline });
  const latencyWinner = pairState.latencyWinner;
  const nativeBaselineTarget = baseline.nativeBaselineTarget || null;
  const nativeFirstActualTarget =
    native.nativeFirstActualTarget || native.nativeFirstTarget || null;
  const nativeFinalActualTarget =
    native.nativeFinalActualTarget || native.nativeFinalTarget || native.selectedTarget || null;
  const governorTarget = governor.selectedTarget || null;
  const agreement =
    nativeBaselineTarget && governorTarget ? nativeBaselineTarget === governorTarget : null;
  const baselineDrift =
    nativeBaselineTarget && nativeFirstActualTarget
      ? nativeBaselineTarget !== nativeFirstActualTarget
      : null;
  const nativeFallback =
    nativeFirstActualTarget && nativeFinalActualTarget
      ? nativeFirstActualTarget !== nativeFinalActualTarget
      : null;
  return {
    pairId,
    caseId: input.id,
    category: input.category,
    prompt: input.prompt,
    expected: input.expectedJson ?? input.expectedFields ?? input.expected ?? null,
    validator: input.validator || input.quality || "exact",
    order,
    authoritative: true,
    native,
    governor,
    baseline,
    nativeBaselineTarget,
    nativeBaselineCanonicalTarget: baseline.nativeBaselineCanonicalTarget || nativeBaselineTarget,
    nativeBaselineExecutionKey: baseline.nativeBaselineExecutionKey || null,
    baselineNativeTarget: nativeBaselineTarget,
    nativeFirstActualTarget,
    nativeFinalActualTarget,
    nativeFirstTarget: nativeFirstActualTarget,
    nativeFinalTarget: nativeFinalActualTarget,
    baselineVsFirstActual: baselineDrift === null ? "UNKNOWN" : baselineDrift ? "MISMATCH" : "PASS",
    baselineVsFinalActual:
      nativeBaselineTarget && nativeFinalActualTarget
        ? nativeBaselineTarget === nativeFinalActualTarget
          ? "PASS"
          : "MISMATCH"
        : "UNKNOWN",
    baselineDrift,
    nativeFallback,
    nativeBaselineOperationId: baseline.baselineOperationId || null,
    governorSelectedTarget: governorTarget,
    agreement,
    pairwise: {
      qualityWinner: pairState.qualityWinner,
      successWinner: pairState.successWinner,
      reliabilityWinner: pairState.successWinner,
      latencyWinner,
      winner: pairState.winner,
      winnerReason: pairState.winnerReason,
      completionDeltaMs:
        (governor.e2eCompletionMs ?? governor.direct?.latencyMs ?? null) -
        (native.e2eCompletionMs ?? native.request?.latencyMs ?? null),
    },
    pairState: pairState.pairState,
    structuralValid: pairState.structuralValid,
    stopBenchmark: pairState.stopBenchmark,
    failureClass: pairState.failureClass,
    failureReason: pairState.failureReason,
    invalid: pairState.valid !== true,
  };
}

async function runAuthoritativePair(pool, input, baseline, pairIndex, { artifactRun = null } = {}) {
  const nativeKey = baseline.nativeBaselineTarget;
  if (!nativeKey) {
    return {
      pairId: `pair-${String(pairIndex + 1).padStart(2, "0")}`,
      caseId: input.id,
      category: input.category,
      order: pairIndex % 2 === 1 ? "governor_then_native" : "native_then_governor",
      authoritative: true,
      invalid: true,
      nativeBaselineTarget: null,
      native: { valid: false, failureClass: "HARNESS_FAILURE" },
      governor: { valid: false, failureClass: "HARNESS_FAILURE" },
    };
  }
  const governorFirst = pairIndex % 2 === 1;
  const order = governorFirst ? "governor_then_native" : "native_then_governor";
  const pairId = "pair-" + String(pairIndex + 1).padStart(2, "0");
  const governorPromise = () =>
    runGovernorE2E(pool, input, baseline, {
      artifactRun,
      pairId,
      order,
      authoritative: true,
    });
  const nativePromise = () =>
    runNativeE2E(input, {
      artifactRun,
      pairId,
      order,
      authoritative: true,
      nativeBaselineTarget: baseline.nativeBaselineTarget,
      nativeBaselineExecutionKey: baseline.nativeBaselineExecutionKey,
      nativeBaselineConnection: baseline.nativeBaselineConnection,
      baselineSnapshotId: baseline.baselineSnapshotId,
      baselineSnapshotHash: baseline.baselineSnapshotHash,
    });
  const first = governorFirst ? await governorPromise() : await nativePromise();
  const second = governorFirst ? await nativePromise() : await governorPromise();
  const native = governorFirst ? second : first;
  const governor = governorFirst ? first : second;
  return buildAuthoritativePair(pairId, input, order, baseline, native, governor);
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
    : null;
}

function mean(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? Math.round(
        (finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length) * 100
      ) / 100
    : null;
}

function timingAggregate(values) {
  return {
    mean: mean(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.filter(Number.isFinite).length ? Math.max(...values.filter(Number.isFinite)) : null,
  };
}

function authoritativeArmAggregate(pairs, side) {
  const results = pairs.map((pair) => pair?.[side]).filter(Boolean);
  const requests = results.map((result) => (side === "native" ? result?.request : result?.direct));
  const e2e = results.map((result) => result?.e2eCompletionMs);
  const headers = requests.map((request) => request?.headersAtMs);
  const ttft = requests.map((request) => request?.firstContentMs);
  const completion = requests.map((request) => request?.completionMs);
  const attempts = requests.map((request) =>
    Number.isFinite(request?.fallbackAttempts) ? request.fallbackAttempts + 1 : null
  );
  const fallbackCounts = requests
    .map((request) => request?.fallbackAttempts)
    .filter(Number.isFinite);
  const result = {
    pairs: pairs.length,
    http: requests.filter((request) => request?.status === 200).length,
    stream: requests.filter((request) => request?.streamCompleted === true).length,
    quality: requests.filter((request) => request?.qualityPass === true).length,
    headers: timingAggregate(headers),
    ttft: timingAggregate(ttft),
    completion: timingAggregate(completion),
    e2e: timingAggregate(e2e),
    attemptsMean: mean(attempts),
    attemptsMax: attempts.filter(Number.isFinite).length
      ? Math.max(...attempts.filter(Number.isFinite))
      : null,
    fallbackCount: fallbackCounts.reduce((sum, value) => sum + value, 0),
  };
  if (side === "governor") {
    const planning = results.map((result) => result?.planningMs);
    const planningShare = results.map((result) =>
      Number.isFinite(result.planningMs) &&
      Number.isFinite(result.e2eCompletionMs) &&
      result.e2eCompletionMs > 0
        ? result.planningMs / result.e2eCompletionMs
        : null
    );
    result.planning = timingAggregate(planning);
    result.planningShare = {
      mean: mean(planningShare),
      p50: percentile(planningShare, 0.5),
    };
    result.plans = results.filter((result) => Boolean(result?.plan)).length;
    result.executable = results.filter(
      (result) => result?.planState?.executable === true || result?.plan?.executable === true
    ).length;
  }
  return result;
}

function authoritativeAccounting(pairs) {
  const rows = [];
  for (const pair of pairs) {
    const nativeRequest = pair.native?.request || null;
    const governorRequest = pair.governor?.direct || null;
    rows.push({
      pairId: pair.pairId,
      caseId: pair.caseId,
      arm: "native",
      order: pair.order,
      authoritative: true,
      requestCorrelationId: nativeRequest?.requestCorrelationId || null,
      responseCorrelationId: nativeRequest?.responseCorrelationId || null,
      requestId: nativeRequest?.requestId || null,
    });
    rows.push({
      pairId: pair.pairId,
      caseId: pair.caseId,
      arm: "governor",
      operation: "planning",
      order: pair.order,
      authoritative: true,
      planningCorrelationId: pair.governor?.planningCorrelationId || null,
    });
    rows.push({
      pairId: pair.pairId,
      caseId: pair.caseId,
      arm: "governor",
      operation: "execution",
      order: pair.order,
      authoritative: true,
      requestCorrelationId: governorRequest?.requestCorrelationId || null,
      responseCorrelationId: governorRequest?.responseCorrelationId || null,
      requestId: governorRequest?.requestId || null,
    });
  }
  const nativeRequests = pairs.filter((pair) => Boolean(pair.native?.request)).length;
  const nativeBaselineResolutions = pairs.filter((pair) =>
    Boolean(pair.nativeBaselineOperationId || pair.baseline?.baselineOperationId)
  ).length;
  const governorPlanningOperations = pairs.filter((pair) =>
    Boolean(pair.governorPlanOperationId || pair.governor?.governorPlanOperationId)
  ).length;
  const governorExecutionRequests = pairs.filter((pair) => Boolean(pair.governor?.direct)).length;
  return {
    authoritativePairs: pairs.length,
    nativeBaselineResolutions,
    nativeBaselineProviderModelRequests: 0,
    governorProviderModelPreflightRequests: 0,
    nativeRequests,
    governorPlanningOperations,
    governorExecutionRequests,
    physicalRequests: nativeRequests + governorExecutionRequests,
    rows,
  };
}

function gateForFivePairs(pairs) {
  const native = authoritativeArmAggregate(pairs, "native");
  const governor = authoritativeArmAggregate(pairs, "governor");
  const accounting = authoritativeAccounting(pairs);
  const failureClasses = [
    ...pairs.flatMap((pair) => [
      pair.native?.failureClass,
      pair.governor?.failureClass,
      pair.failureClass,
    ]),
  ].filter(Boolean);
  const invalid = pairs.filter((pair) => pair.invalid === true).length;
  const correlationPass =
    pairs.length === 5 &&
    pairs.every(
      (pair) =>
        Boolean(pair.native?.request?.correlationId) &&
        Boolean(pair.governor?.direct?.correlationId)
    );
  const identityPass =
    pairs.length === 5 &&
    pairs.every(
      (pair) => pair.native?.targetIdentity === "PASS" && pair.governor?.targetIdentity === "PASS"
    );
  // A real MODEL_QUALITY_FAILURE is a measured experimental outcome, not a methodology failure.
  // Require both validators to have produced boolean measurements, but do not require them true.
  const qualityMeasured =
    pairs.length === 5 &&
    pairs.every(
      (pair) =>
        typeof pair.native?.request?.qualityPass === "boolean" &&
        typeof pair.governor?.direct?.qualityPass === "boolean"
    );
  const artifactIntegrity =
    pairs.length === 5 &&
    pairs.every(
      (pair) =>
        Boolean(pair.nativeOperationId || pair.native?.nativeOperationId) &&
        Boolean(pair.governorPlanOperationId || pair.governor?.governorPlanOperationId) &&
        Boolean(pair.governorOperationId || pair.governor?.governorOperationId) &&
        Boolean(pair.pairCompleteOperationId)
    );
  const accountingPass =
    pairs.length === 5 &&
    accounting.nativeRequests === 5 &&
    accounting.governorPlanningOperations === 5 &&
    accounting.governorExecutionRequests === 5 &&
    accounting.physicalRequests === 10;
  const forbiddenFailures = failureClasses.filter((failureClass) =>
    [
      "HARNESS_FAILURE",
      "VALIDATOR_FAILURE",
      "TARGET_MISMATCH",
      "STALE_PLAN",
      "SYSTEMIC_RUNTIME_FAILURE",
    ].includes(failureClass)
  );
  const pass =
    pairs.length === 5 &&
    native.http === 5 &&
    native.stream === 5 &&
    governor.plans === 5 &&
    governor.executable === 5 &&
    governor.http === 5 &&
    governor.stream === 5 &&
    accountingPass &&
    correlationPass &&
    identityPass &&
    qualityMeasured &&
    artifactIntegrity &&
    invalid === 0 &&
    forbiddenFailures.length === 0;
  return {
    pass,
    pairsRequested: 5,
    pairsStarted: pairs.length,
    pairsCompleted: pairs.length,
    pairsValid: pairs.filter((pair) => pair.invalid !== true).length,
    pairs: pairs.length,
    nativeHttp: native.http,
    nativeStreams: native.stream,
    governorPlans: governor.plans,
    governorExecutable: governor.executable,
    governorHttp: governor.http,
    governorStreams: governor.stream,
    nativeQuality: native.quality,
    governorQuality: governor.quality,
    quality: qualityMeasured ? "MEASURED" : "UNMEASURED",
    qualityMeasured,
    qualityIsMethodologyGate: false,
    accounting: accountingPass ? "PASS" : "FAIL",
    identity: identityPass ? "PASS" : "FAIL",
    correlation: correlationPass ? "PASS" : "FAIL",
    artifactIntegrity: artifactIntegrity ? "PASS" : "FAIL",
    benchmarkInvalid: forbiddenFailures.length > 0,
    invalid,
    failureClasses,
    forbiddenFailures,
  };
}

function authoritativePairwise(pairs) {
  const count = (selector, value) => pairs.filter((pair) => selector(pair) === value).length;
  return {
    governorWins: count((pair) => pair.pairwise?.winner, "governor"),
    nativeWins: count((pair) => pair.pairwise?.winner, "native"),
    ties: count((pair) => pair.pairwise?.winner, "tie"),
    invalid: pairs.filter((pair) => pair.invalid).length,
    governorQualityWins: count((pair) => pair.pairwise?.qualityWinner, "governor"),
    nativeQualityWins: count((pair) => pair.pairwise?.qualityWinner, "native"),
    governorLatencyWins: count((pair) => pair.pairwise?.latencyWinner, "governor"),
    nativeLatencyWins: count((pair) => pair.pairwise?.latencyWinner, "native"),
  };
}

function targetDistribution(pairs, side) {
  const values = pairs
    .map((pair) => (side === "native" ? pair.nativeFinalTarget : pair.governorSelectedTarget))
    .filter(Boolean);
  return Object.fromEntries(
    Object.entries(Object.groupBy(values, (value) => value)).map(([key, group]) => [
      key,
      group.length,
    ])
  );
}

function authoritativeConclusion(pairs, aggregates, pairwise) {
  const validPairs = pairs.filter((pair) => !pair.invalid);
  if (validPairs.length === 0) return "E2E_INCONCLUSIVE";
  const nativeQuality = aggregates.native.quality;
  const governorQuality = aggregates.governor.quality;
  if (governorQuality < nativeQuality) return "NATIVE_E2E_BETTER";
  if (nativeQuality < governorQuality) return "GOVERNOR_E2E_BETTER";

  // Once aggregate quality is tied, latency may decide only on pairs where both arms
  // passed quality/reliability and produced a complete total-E2E measurement.
  const latencyComparablePairs = validPairs.filter(
    (pair) =>
      pair.native?.request?.qualityPass === true &&
      pair.governor?.direct?.qualityPass === true &&
      pair.native?.request?.status === 200 &&
      pair.governor?.direct?.status === 200 &&
      pair.native?.request?.streamCompleted === true &&
      pair.governor?.direct?.streamCompleted === true &&
      Number.isFinite(pair.native?.e2eCompletionMs) &&
      Number.isFinite(pair.governor?.e2eCompletionMs)
  );
  if (latencyComparablePairs.length === 0) return "E2E_INCONCLUSIVE";
  if (pairwise.nativeLatencyWins > pairwise.governorLatencyWins) {
    return "NATIVE_E2E_BETTER";
  }
  if (pairwise.governorLatencyWins > pairwise.nativeLatencyWins) {
    return "GOVERNOR_E2E_BETTER";
  }
  return "E2E_ROUGHLY_EQUIVALENT";
}

function calibrationRecoverySummary(pairs) {
  const native = pairs.map((pair) => pair.native);
  const governor = pairs.map((pair) => pair.governor);
  const nativeRequests = native.map((arm) => arm.request).filter(Boolean);
  const governorRequests = governor.map((arm) => arm.direct).filter(Boolean);
  const qualityPass = (requests) =>
    requests.filter((request) => request.qualityPass === true).length;
  const streamPass = (requests) =>
    requests.filter((request) => request.streamCompleted === true && request.doneMs !== null)
      .length;
  const targetIdentityPass = (arms) => arms.filter((arm) => arm.targetIdentity === "PASS").length;
  const calibrationPassed =
    pairs.length === 3 &&
    native.every((arm) => arm.valid) &&
    governor.every((arm) => arm.valid) &&
    governor.every((arm) => arm.plan?.executable === true) &&
    qualityPass(nativeRequests) === 3 &&
    qualityPass(governorRequests) === 3 &&
    streamPass(nativeRequests) === 3 &&
    streamPass(governorRequests) === 3 &&
    targetIdentityPass(native) === 3 &&
    targetIdentityPass(governor) === 3;
  return {
    calibrationPassed,
    accounting: {
      pairs: pairs.length,
      nativeE2ERequests: native.length,
      governorPlanningRequests: governor.length,
      governorDirectRequests: governorRequests.length,
      totalArmRequests: native.length + governorRequests.length,
    },
    native: {
      http: nativeRequests.filter((request) => request.status === 200).length,
      stream: streamPass(nativeRequests),
      quality: qualityPass(nativeRequests),
      targetIdentity: targetIdentityPass(native),
    },
    governor: {
      plans: governor.filter((arm) => Boolean(arm.plan)).length,
      executable: governor.filter((arm) => arm.plan?.executable === true).length,
      http: governorRequests.filter((request) => request.status === 200).length,
      stream: streamPass(governorRequests),
      quality: qualityPass(governorRequests),
      targetIdentity: targetIdentityPass(governor),
    },
    failureClasses: pairs.flatMap((pair) =>
      [pair.native.failureClass, pair.governor.failureClass].filter(Boolean)
    ),
    sse: {
      nativeDone: streamPass(nativeRequests),
      governorDone: streamPass(governorRequests),
    },
  };
}

function poolSnapshot(pool) {
  return {
    raw: pool.raw,
    active: pool.active,
    eligible: pool.eligible,
    healthy: pool.healthy,
    snapshotAt: pool.snapshotAt || null,
    byProvider: pool.byProvider,
    breakers: pool.breakers,
    cooldowns: pool.cooldowns,
    lockouts: pool.lockouts,
  };
}

function createHarnessRun(pool, workload, requestedPairCount, authoritative) {
  const effectiveGovernorMode = getGovernorMode();
  const governorReadiness = assessGovernorRuntimeReadiness({
    expectedMode: "simulate",
    effectiveMode: effectiveGovernorMode,
    governorActive: false,
    canaryRate: 0,
  });
  const run = createBenchmarkRun({
    requestedPairs: requestedPairCount,
    authoritative,
    governorMode: "simulate",
    governorActive: false,
    canaryRate: 0,
    effectiveGovernorMode,
    governorModeMatch: governorReadiness.ready,
    configurationFailure: governorReadiness.ready ? null : governorReadiness.failureReason,
    runtimeBaseUrl: BASE_URL,
    poolSnapshot: poolSnapshot(pool),
    workloadHash: hashJson(workload.map(({ id, category, prompt }) => ({ id, category, prompt }))),
    validatorHash: hashJson(
      workload.map(
        ({ id, category, validator, quality, expected, expectedJson, expectedFields }) => ({
          id,
          category,
          validator: validator || quality || "exact",
          expected: expectedJson ?? expectedFields ?? expected ?? null,
        })
      )
    ),
  });
  run.effectiveGovernorMode = effectiveGovernorMode;
  run.governorReadiness = governorReadiness;
  run.updateManifest({
    effectiveGovernorMode,
    governorModeMatch: governorReadiness.ready,
    configurationFailure: governorReadiness.ready ? null : governorReadiness.failureReason,
  });
  activeBenchmarkRun = run;
  const handler = (signal) => {
    try {
      run.markAborted(signal);
    } catch (error) {
      console.error("[GOVERNOR] failed to mark benchmark run aborted", error);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  activeBenchmarkSignalHandler = handler;
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  signalHandlersInstalled = true;
  return run;
}

function clearBenchmarkRun() {
  if (signalHandlersInstalled && activeBenchmarkRun) {
    process.removeListener("SIGINT", activeBenchmarkSignalHandler);
    process.removeListener("SIGTERM", activeBenchmarkSignalHandler);
  }
  signalHandlersInstalled = false;
  activeBenchmarkSignalHandler = null;
  activeBenchmarkRun = null;
}

function outputDocument(
  result,
  { persist = false, kind = "diagnostic", artifactRun = null, status = "COMPLETE" } = {}
) {
  const resultWithRun = artifactRun ? { runId: artifactRun.manifest.runId, ...result } : result;
  if (persist) {
    const artifactPath = persistBenchmarkArtifact(
      artifactRun ? { syntheticWorkload: true, ...resultWithRun } : resultWithRun,
      { kind, outputPath: artifactRun?.finalSnapshotPath }
    );
    console.error(`[GOVERNOR] durable artifact=${artifactPath}`);
    if (artifactRun) {
      artifactRun.finalize({ status, finalSnapshotPath: artifactPath });
      clearBenchmarkRun();
    }
  }
  console.log(JSON.stringify(resultWithRun, null, 2));
}

const pool = await buildPool();
if (poolOnly) {
  outputDocument({
    governor: "simulate / false / 0",
    pool: {
      raw: pool.raw,
      active: pool.active,
      eligible: pool.eligible,
      healthy: pool.healthy,
      executable: "per-request plan; not a pool scalar",
      byProvider: pool.byProvider,
      topCandidates: pool.metadata,
    },
  });
  process.exit(0);
}
if (directOnly || replayOnly) {
  const decisions = replayLatestDecisionsFromTelemetry();
  if (replayOnly) {
    outputDocument({ decisions });
    process.exit(0);
  }
  const direct = await runDirectComparisons(pool, decisions);
  outputDocument({
    governor: "simulate / false / 0",
    canary: 0,
    pool: {
      raw: pool.raw,
      active: pool.active,
      eligible: pool.eligible,
      healthy: pool.healthy,
      byProvider: pool.byProvider,
    },
    decisions,
    direct,
  });
  process.exit(0);
}
if (calibrationRecoveryOnly) {
  const calibrationRun = createHarnessRun(pool, CALIBRATION_CASES, 3, false);
  const calibrationInputs = CALIBRATION_CASES.map(({ caseId }) =>
    DIVERGENCE_WORKLOAD.find((input) => input.id === caseId)
  ).filter(Boolean);
  const { snapshot: calibrationSnapshot, baselines: calibrationBaselines } =
    await resolveOfflineNativeBaselines(pool, calibrationInputs, {
      artifactRun: calibrationRun,
      authoritative: false,
    });
  calibrationRun.updateManifest({
    nativeBaselineResolution: "side_effect_free",
    baselineSnapshotId: calibrationSnapshot.snapshotId,
    baselineSnapshotHash: calibrationSnapshot.baselineSnapshotHash,
    nativeBaselineProviderModelRequests: 0,
    governorProviderModelPreflightRequests: 0,
    sideEffectFreeBaselineResolutions: calibrationBaselines.length,
    preflightStateContamination: calibrationBaselines.every(
      (item) =>
        item.valid === true &&
        item.networkCalls === 0 &&
        item.providerModelRequests === 0 &&
        item.routingStateMutation === false &&
        item.homeStateDigestBefore === item.homeStateDigestAfter
    )
      ? "NO"
      : "YES",
  });
  const calibrationDecisions = calibrationInputs.map((input, index) => {
    const baseline = calibrationBaselines[index];
    return {
      caseId: input.id,
      category: input.category,
      nativeTarget: baseline.nativeBaselineTarget,
      nativeBaseline: baseline,
      nativeBaselineTarget: baseline.nativeBaselineTarget,
      nativeBaselineCanonicalTarget: baseline.nativeBaselineCanonicalTarget,
      nativeBaselineExecutionKey: baseline.nativeBaselineExecutionKey,
      nativeBaselineConnection: baseline.nativeBaselineConnection,
      baselineSnapshotId: baseline.baselineSnapshotId,
      baselineSnapshotHash: baseline.baselineSnapshotHash,
      nativeProven: baseline.valid === true,
    };
  });
  if (
    calibrationDecisions.length !== CALIBRATION_CASES.length ||
    calibrationDecisions.some((decision) => !decision.nativeTarget)
  ) {
    outputDocument(
      {
        governor: "simulate / false / 0",
        canary: 0,
        nativeBaseline: calibrationBaselines,
        baselineSnapshotId: calibrationSnapshot.snapshotId,
        baselineSnapshotHash: calibrationSnapshot.baselineSnapshotHash,
        calibration: [],
        calibrationPassed: false,
        stopReason: "calibration_native_baseline_unproven",
        missingCases: CALIBRATION_CASES.filter(
          ({ caseId }) =>
            !calibrationDecisions.find((decision) => decision.caseId === caseId)?.nativeTarget
        ).map(({ caseId }) => caseId),
      },
      {
        persist: true,
        kind: "calibration-recovery",
        artifactRun: calibrationRun,
        status: "FAILED",
      }
    );
    process.exit(2);
  }
  const calibration = await runE2E(pool, calibrationDecisions, 3, {
    artifactRun: calibrationRun,
    authoritative: false,
  });
  const summary = calibrationRecoverySummary(calibration);
  outputDocument(
    {
      governor: "simulate / false / 0",
      canary: 0,
      pool: {
        raw: pool.raw,
        active: pool.active,
        eligible: pool.eligible,
        healthy: pool.healthy,
        byProvider: pool.byProvider,
      },
      nativeBaseline: calibrationBaselines,
      baselineSnapshotId: calibrationSnapshot.snapshotId,
      baselineSnapshotHash: calibrationSnapshot.baselineSnapshotHash,
      calibration: compactE2E(calibration),
      summary,
    },
    {
      persist: true,
      kind: "calibration-recovery",
      artifactRun: calibrationRun,
      status: summary.calibrationPassed ? "COMPLETE" : "FAILED",
    }
  );
  process.exit(summary.calibrationPassed ? 0 : 2);
}
if (authoritativeOnly) {
  const pairLimit = Math.min(
    10,
    Math.max(5, Number.isInteger(requestedPairs) ? requestedPairs : 10)
  );
  const workload = AUTHORITATIVE_WORKLOAD.slice(0, pairLimit);
  const authoritativeRun = createHarnessRun(pool, workload, pairLimit, true);
  const baselineSnapshot = await createNativeBaselineSnapshot({
    pool,
    routingSettings: pool.routingSettings,
  });
  authoritativeRun.updateManifest({
    nativeBaselineResolution: "side_effect_free",
    baselineSnapshotId: baselineSnapshot.snapshotId,
    baselineSnapshotHash: baselineSnapshot.baselineSnapshotHash,
    nativeBaselineProviderModelRequests: 0,
    governorProviderModelPreflightRequests: 0,
    sideEffectFreeBaselineResolutions: 0,
    preflightStateContamination: "PENDING",
  });
  if (!authoritativeRun.governorReadiness.ready) {
    authoritativeRun.updateManifest({
      status: "FAILED",
      stopReason: "BENCHMARK_INVALID",
      configurationFailure: authoritativeRun.governorReadiness.failureReason,
    });
    outputDocument(
      {
        governor: "simulate / false / 0",
        canary: 0,
        effectiveGovernorMode: authoritativeRun.effectiveGovernorMode,
        governorReadiness: authoritativeRun.governorReadiness,
        pool,
        workload,
        nativeBaseline: [],
        pairs: [],
        fivePairGate: { pass: false, reason: "GOVERNOR_MODE_MISMATCH" },
        stopReason: "BENCHMARK_INVALID",
      },
      {
        persist: true,
        kind: "authoritative",
        artifactRun: authoritativeRun,
        status: "FAILED",
      }
    );
    process.exit(2);
  }
  const nativeBaseline = [];
  for (const input of workload) {
    nativeBaseline.push(
      await resolveAuthoritativeNativeBaseline(input, baselineSnapshot, {
        artifactRun: authoritativeRun,
      })
    );
  }
  authoritativeRun.updateManifest({
    sideEffectFreeBaselineResolutions: nativeBaseline.length,
    preflightStateContamination: nativeBaseline.every(
      (item) =>
        item.valid === true &&
        item.networkCalls === 0 &&
        item.providerModelRequests === 0 &&
        item.routingStateMutation === false &&
        item.homeStateDigestBefore === item.homeStateDigestAfter
    )
      ? "NO"
      : "YES",
  });
  const missingBaseline = nativeBaseline.filter(
    (item) =>
      !item.nativeBaselineTarget ||
      !item.valid ||
      item.networkCalls !== 0 ||
      item.providerModelRequests !== 0 ||
      item.routingStateMutation !== false ||
      item.homeStateDigestBefore !== item.homeStateDigestAfter
  );
  if (missingBaseline.length > 0) {
    outputDocument(
      {
        governor: "simulate / false / 0",
        canary: 0,
        pool: {
          raw: pool.raw,
          active: pool.active,
          eligible: pool.eligible,
          healthy: pool.healthy,
          executable: "per-request plan; not a pool scalar",
          byProvider: pool.byProvider,
          snapshotAt: pool.snapshotAt,
          breakers: pool.breakers,
          cooldowns: pool.cooldowns,
          lockouts: pool.lockouts,
        },
        workload: workload.map(
          ({ id, category, prompt, validator, expected, expectedJson, expectedFields }) => ({
            id,
            category,
            prompt,
            validator,
            expected: expectedJson ?? expectedFields ?? expected ?? null,
          })
        ),
        nativeBaseline: nativeBaseline.map((item) => ({
          caseId: item.caseId,
          nativeBaselineTarget: item.nativeBaselineTarget,
          nativeBaselineCanonicalTarget: item.nativeBaselineCanonicalTarget,
          nativeBaselineExecutionKey: item.nativeBaselineExecutionKey,
          nativeBaselineProvider: item.nativeBaselineProvider,
          nativeBaselineModel: item.nativeBaselineModel,
          nativeBaselineConnection: item.nativeBaselineConnection,
          nativeBaselineResolution: item.nativeBaselineResolution,
          baselineSnapshotId: item.baselineSnapshotId,
          baselineSnapshotHash: item.baselineSnapshotHash,
          networkCalls: item.networkCalls,
          providerModelRequests: item.providerModelRequests,
          routingStateMutation: item.routingStateMutation,
          homeStateDigestBefore: item.homeStateDigestBefore,
          homeStateDigestAfter: item.homeStateDigestAfter,
          valid: item.valid,
          failureClass: item.failureClass || null,
        })),
        pairs: [],
        fivePairGate: { pass: false, reason: "native_baseline_resolution_failed" },
        stopReason: "BENCHMARK_INVALID",
      },
      {
        persist: true,
        kind: "authoritative",
        artifactRun: authoritativeRun,
        status: "FAILED",
      }
    );
    process.exit(2);
  }

  const pairs = [];
  for (let index = 0; index < workload.length; index += 1) {
    const pair = await runAuthoritativePair(pool, workload[index], nativeBaseline[index], index, {
      artifactRun: authoritativeRun,
    });
    appendPairCompleteOperation(authoritativeRun, pair, workload[index], true);
    pairs.push(pair);
    if (pair.stopBenchmark === true) {
      authoritativeRun.updateManifest({
        status: "FAILED",
        stopReason: "BENCHMARK_INVALID",
        failureClass: pair.failureClass || "HARNESS_FAILURE",
        failureReason: pair.failureReason || null,
      });
      outputDocument(
        {
          governor: "simulate / false / 0",
          canary: 0,
          pool,
          workload,
          nativeBaseline,
          pairs,
          fivePairGate: gateForFivePairs(pairs.slice(0, 5)),
          accounting: authoritativeAccounting(pairs),
          aggregates: {
            native: authoritativeArmAggregate(pairs, "native"),
            governor: authoritativeArmAggregate(pairs, "governor"),
          },
          pairwise: authoritativePairwise(pairs),
          stopReason: "BENCHMARK_INVALID",
        },
        {
          persist: true,
          kind: "authoritative",
          artifactRun: authoritativeRun,
          status: "FAILED",
        }
      );
      process.exit(2);
    }
    if (index === 4 && pairLimit > 5) {
      const fivePairGate = gateForFivePairs(pairs.slice(0, 5));
      console.error(`[AUTHORITATIVE] five-pair gate=${fivePairGate.pass ? "PASS" : "FAIL"}`);
      if (!fivePairGate.pass) {
        const aggregates = {
          native: authoritativeArmAggregate(pairs, "native"),
          governor: authoritativeArmAggregate(pairs, "governor"),
        };
        outputDocument(
          {
            governor: "simulate / false / 0",
            canary: 0,
            pool,
            workload,
            nativeBaseline,
            pairs,
            fivePairGate,
            accounting: authoritativeAccounting(pairs),
            aggregates,
            pairwise: authoritativePairwise(pairs),
            stopReason: "FIVE_PAIR_GATE_FAILED",
          },
          {
            persist: true,
            kind: "authoritative",
            artifactRun: authoritativeRun,
            status: "FAILED",
          }
        );
        process.exit(2);
      }
    }
  }

  const fivePairGate = gateForFivePairs(pairs.slice(0, 5));
  const accounting = authoritativeAccounting(pairs);
  const aggregates = {
    native: authoritativeArmAggregate(pairs, "native"),
    governor: authoritativeArmAggregate(pairs, "governor"),
  };
  const pairwise = authoritativePairwise(pairs);
  const nativeE2EP50 = aggregates.native.e2e.p50;
  const governorE2EP50 = aggregates.governor.e2e.p50;
  const nativeE2EMean = aggregates.native.e2e.mean;
  const governorE2EMean = aggregates.governor.e2e.mean;
  const speed = {
    p50RatioNativeGovernor:
      Number.isFinite(nativeE2EP50) && Number.isFinite(governorE2EP50) && governorE2EP50 > 0
        ? nativeE2EP50 / governorE2EP50
        : null,
    meanRatioNativeGovernor:
      Number.isFinite(nativeE2EMean) && Number.isFinite(governorE2EMean) && governorE2EMean > 0
        ? nativeE2EMean / governorE2EMean
        : null,
  };
  const nativeChoices = targetDistribution(pairs, "native");
  const governorChoices = targetDistribution(pairs, "governor");
  const knownAgreements = pairs.filter((pair) => pair.agreement !== null);
  const outlier = (side, direction) => {
    const candidates = pairs
      .map((pair) => ({ pair, value: pair[side].e2eCompletionMs }))
      .filter((item) => Number.isFinite(item.value));
    if (!candidates.length) return null;
    return candidates.reduce((best, item) =>
      direction === "slowest"
        ? item.value > best.value
          ? item
          : best
        : item.value < best.value
          ? item
          : best
    );
  };
  outputDocument(
    {
      governor: "simulate / false / 0",
      canary: 0,
      pool,
      workload: workload.map(
        ({ id, category, prompt, validator, expected, expectedJson, expectedFields }) => ({
          id,
          category,
          prompt,
          validator,
          expected: expectedJson ?? expectedFields ?? expected ?? null,
        })
      ),
      nativeBaseline,
      pairs,
      fivePairGate,
      accounting,
      aggregates,
      speed,
      pairwise,
      choices: {
        agreement: knownAgreements.filter((pair) => pair.agreement === true).length,
        disagreement: knownAgreements.filter((pair) => pair.agreement === false).length,
        agreementRate: knownAgreements.length
          ? knownAgreements.filter((pair) => pair.agreement === true).length /
            knownAgreements.length
          : null,
        native: nativeChoices,
        governor: governorChoices,
        governorConcentration: pairs.length
          ? Math.max(...Object.values(governorChoices), 0) / pairs.length
          : null,
      },
      outliers: {
        nativeSlowest: outlier("native", "slowest"),
        nativeFastest: outlier("native", "fastest"),
        governorSlowest: outlier("governor", "slowest"),
        governorFastest: outlier("governor", "fastest"),
      },
      conclusion: fivePairGate.pass
        ? authoritativeConclusion(pairs, aggregates, pairwise)
        : "E2E_INCONCLUSIVE",
      cost: "INCOMPLETE",
      decisionBenchmark: "INCONCLUSIVE",
      canaryReadiness: "NOT_READY",
    },
    {
      persist: true,
      kind: "authoritative",
      artifactRun: authoritativeRun,
      status: fivePairGate.pass ? "COMPLETE" : "FAILED",
    }
  );
  process.exit(fivePairGate.pass ? 0 : 2);
}
if (e2eReplayOnly) {
  const decisions = replayLatestDecisionsFromTelemetry();
  const usable = decisions.filter((decision) => decision.nativeTarget);
  const calibration = await runE2E(pool, usable.slice(0, 3), 3);
  const calibrationPassed =
    calibration.length === 3 &&
    calibration.every(
      (pair) =>
        pair.native.valid &&
        pair.governor.valid &&
        pair.native.request?.qualityPass === true &&
        pair.governor.direct?.qualityPass === true
    );
  if (!calibrationPassed) {
    outputDocument({
      governor: "simulate / false / 0",
      canary: 0,
      calibration: compactE2E(calibration),
      calibrationPassed: false,
      benchmark: [],
      stopReason: "e2e_calibration_failed",
    });
    process.exit(2);
  }
  const benchmark = await runE2E(pool, usable, 10);
  outputDocument({
    governor: "simulate / false / 0",
    canary: 0,
    calibration: compactE2E(calibration),
    calibrationPassed,
    benchmark: compactE2E(benchmark),
    calibrationSummary: {
      native: summarizeE2EArm(calibration, "native"),
      governor: summarizeE2EArm(calibration, "governor"),
    },
    benchmarkSummary: {
      native: summarizeE2EArm(benchmark, "native"),
      governor: summarizeE2EArm(benchmark, "governor"),
    },
  });
  process.exit(0);
}
if (workloadOnly || e2eOnly) {
  const decisions = await runDivergenceWorkload(pool);
  if (workloadOnly) {
    outputDocument({
      governor: "simulate / false / 0",
      pool: {
        raw: pool.raw,
        active: pool.active,
        eligible: pool.eligible,
        healthy: pool.healthy,
        executable: decisions.filter((item) => item.plan?.executable === true).length,
        byProvider: pool.byProvider,
        topCandidates: pool.metadata,
      },
      workload: DIVERGENCE_WORKLOAD.map(({ id, category, prompt }) => ({
        id,
        category,
        promptLength: prompt.length,
      })),
      decisions,
    });
    process.exit(0);
  }
  const e2e = await runE2E(pool, decisions, Number.isInteger(requestedPairs) ? requestedPairs : 10);
  outputDocument({ pool, decisions, e2e });
  process.exit(0);
}

const decisions = await runDivergenceWorkload(pool);
const direct = await runDirectComparisons(pool, decisions);
pool.executablePlans = decisions.filter((item) => item.plan?.executable === true).length;
const e2eCalibration = await runE2E(pool, decisions.slice(0, 3), 3);
const e2eCalibrationPassed =
  e2eCalibration.length === 3 &&
  e2eCalibration.every(
    (pair) =>
      pair.native.valid &&
      pair.governor.valid &&
      pair.native.request?.qualityPass === true &&
      pair.governor.direct?.qualityPass === true
  );
if (!e2eCalibrationPassed) {
  outputDocument({
    governor: "simulate / false / 0",
    canary: 0,
    baseUrl: BASE_URL,
    pool: {
      raw: pool.raw,
      active: pool.active,
      eligible: pool.eligible,
      healthy: pool.healthy,
      executable: pool.executablePlans,
      byProvider: pool.byProvider,
    },
    workload: DIVERGENCE_WORKLOAD.map(({ id, category, prompt }) => ({
      id,
      category,
      promptLength: prompt.length,
    })),
    decisions,
    direct,
    e2e: {
      calibrationPairs: compactE2E(e2eCalibration),
      calibrationPassed: false,
      benchmarkPairs: [],
      stopReason: "e2e_calibration_failed",
    },
  });
  process.exit(2);
}
const e2eBenchmark = await runE2E(
  pool,
  decisions,
  Number.isInteger(requestedPairs) ? requestedPairs : 10
);
const allE2E = [...e2eCalibration, ...e2eBenchmark];
const agreement = decisions.filter((item) => item.agreement === true).length;
const disagreement = decisions.filter((item) => item.agreement === false).length;
const nativeChoices = Object.fromEntries(
  Object.entries(
    Object.groupBy(decisions.map((item) => item.nativeTarget).filter(Boolean), (value) => value)
  ).map(([key, values]) => [key, values.length])
);
const governorChoices = Object.fromEntries(
  Object.entries(
    Object.groupBy(decisions.map((item) => item.governorTarget).filter(Boolean), (value) => value)
  ).map(([key, values]) => [key, values.length])
);
outputDocument({
  governor: "simulate / false / 0",
  canary: 0,
  baseUrl: BASE_URL,
  pool: {
    raw: pool.raw,
    active: pool.active,
    eligible: pool.eligible,
    healthy: pool.healthy,
    executable: pool.executablePlans,
    byProvider: pool.byProvider,
    topCandidates: pool.metadata,
  },
  workload: DIVERGENCE_WORKLOAD.map(({ id, category, prompt }) => ({
    id,
    category,
    promptLength: prompt.length,
  })),
  decisionBenchmark: {
    cases: decisions.length,
    agreement,
    disagreement,
    validDisagreement: direct.filter(
      (item) => item.targetComparison === "DISAGREEMENT" && !item.invalid
    ).length,
    governorWins: direct.filter((item) => item.pairwise?.winner === "governor").length,
    nativeWins: direct.filter((item) => item.pairwise?.winner === "native").length,
    ties: direct.filter((item) => item.pairwise?.winner === "tie").length,
    invalid: direct.filter((item) => item.invalid).length,
    operation: {
      nativeObservationRequests: decisions.length,
      directRequests: direct.reduce((sum, item) => sum + (item.invalid ? 0 : 2), 0),
    },
  },
  decisions,
  direct,
  e2e: {
    calibrationPairs: e2eCalibration,
    calibrationPassed: e2eCalibrationPassed,
    benchmarkPairs: e2eBenchmark,
    native: summarizeResults(
      e2eBenchmark.map((pair) => pair.native),
      (result) => result.e2eCompletionMs
    ),
    governor: summarizeResults(
      e2eBenchmark.map((pair) => pair.governor),
      (result) => result.e2eCompletionMs
    ),
    nativeChoices,
    governorChoices,
    agreementRate: decisions.length ? agreement / decisions.length : null,
    concentration: {
      nativeMaxShare: decisions.length
        ? Math.max(...Object.values(nativeChoices), 0) / decisions.length
        : null,
      governorMaxShare: decisions.length
        ? Math.max(...Object.values(governorChoices), 0) / decisions.length
        : null,
    },
  },
});
