import { randomUUID } from "node:crypto";
import { queryGovernorTelemetryRows } from "../../src/lib/db/governorTelemetry.ts";
import {
  accountBenchmarkOperations,
  compareObservedTarget,
  consumeSseText,
  createSseState,
  evaluateQuality,
  flushSseText,
  isStreamComplete,
} from "./omniroute-shadow-benchmark-core.mjs";

const BASE_URL = process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128";
const MAX_PAIRS = 10;
const configuredTimeout = Number(process.env.SHADOW_REQUEST_TIMEOUT_MS || 600_000);
const REQUEST_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 600_000;
const smokeOnly = process.argv.includes("--smoke");
const calibrationOnly = process.argv.includes("--calibration");
const decisionOnly = process.argv.includes("--decision");
const requestedPairs = Number(
  process.argv.find((arg) => arg.startsWith("--pairs="))?.split("=")[1] || MAX_PAIRS
);
const pairCount =
  Number.isInteger(requestedPairs) && requestedPairs >= 1 && requestedPairs <= MAX_PAIRS
    ? requestedPairs
    : MAX_PAIRS;

const INPUTS = [
  {
    id: "factual",
    category: "factual",
    prompt: "What is 2 + 2? Reply with exactly 4 and nothing else.",
    expected: "4",
  },
  {
    id: "instruction",
    category: "instruction-following",
    prompt: "Reply with exactly SHADOW-INSTRUCTION-8 and nothing else.",
    expected: "SHADOW-INSTRUCTION-8",
  },
  {
    id: "json",
    category: "json-structured",
    prompt: 'Return only this JSON object: {"status":"SHADOW-JSON-9"}',
    expected: "SHADOW-JSON-9",
    quality: "json",
  },
  {
    id: "reasoning",
    category: "deterministic-reasoning",
    prompt: "Compute 17 * 3. Reply with exactly 51 and nothing else.",
    expected: "51",
  },
  {
    id: "code",
    category: "simple-code",
    prompt:
      'Return exactly this JavaScript statement and nothing else: console.log("SHADOW-CODE-11");',
    expectedOutput: 'console.log("SHADOW-CODE-11");',
    quality: "code",
  },
  {
    id: "portuguese-structured",
    category: "portuguese-structured-instruction",
    prompt: "Responda exatamente com SHADOW-PORTUGUESE-12 e nada mais.",
    expected: "SHADOW-PORTUGUESE-12",
  },
  {
    id: "english-structured",
    category: "english-structured-instruction",
    prompt: "Output exactly SHADOW-ENGLISH-13 and no other text.",
    expected: "SHADOW-ENGLISH-13",
  },
  {
    id: "transformation",
    category: "simple-transformation",
    prompt: "Convert the word omni to uppercase. Reply with exactly OMNI and nothing else.",
    expected: "OMNI",
  },
  {
    id: "short-reasoning",
    category: "short-reasoning",
    prompt: "What number comes after 98? Reply with exactly 99 and nothing else.",
    expected: "99",
  },
  {
    id: "coding-data",
    category: "small-coding-data",
    prompt:
      "Return the CSV header for a two-column table with columns name and value, exactly: name,value",
    expected: "name,value",
  },
];

const requestedStart = Number(
  process.argv.find((arg) => arg.startsWith("--start="))?.split("=")[1] || 0
);
const startIndex =
  Number.isInteger(requestedStart) && requestedStart >= 0 && requestedStart < INPUTS.length
    ? requestedStart
    : 0;
const CALIBRATION_INPUTS = [
  {
    id: "calibration-exact",
    category: "exact",
    prompt: "Respond only with 42 and nothing else.",
    expected: "42",
  },
  {
    id: "calibration-json",
    category: "json",
    prompt: 'Return only this JSON object: {"status":"ok","value":7}',
    expectedJson: { status: "ok", value: 7 },
    quality: "json",
  },
  {
    id: "calibration-portuguese",
    category: "portuguese",
    prompt: "Responda somente com CALIBRACAO-PT-OK e nada mais.",
    expected: "CALIBRACAO-PT-OK",
  },
  {
    id: "calibration-transformation",
    category: "transformation",
    prompt: "Converta omni para maiúsculas. Responda somente OMNI.",
    expected: "OMNI",
  },
  {
    id: "calibration-code",
    category: "code",
    prompt: "Retorne exatamente esta linha JavaScript: const result = 6 * 7;",
    expectedOutput: "const result = 6 * 7;",
    quality: "code",
  },
];
const selectedInputs = (calibrationOnly ? CALIBRATION_INPUTS : INPUTS).slice(
  startIndex,
  startIndex + (calibrationOnly ? Math.min(pairCount, CALIBRATION_INPUTS.length) : pairCount)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function header(response, name) {
  return response.headers.get(name) || null;
}

function providerFromModel(model) {
  if (typeof model !== "string" || !model.includes("/")) return null;
  return model.slice(0, model.indexOf("/"));
}

function modelFromModel(model) {
  if (typeof model !== "string" || !model.includes("/")) return model || null;
  return model.slice(model.indexOf("/") + 1);
}

function classifyFailure(status, errorCode) {
  if (status === 429) return "429";
  if (status === 404) return "404";
  if (status === 503) return "503";
  return status >= 400 ? "OTHER_ERROR" : null;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readStreamingBody(response, input, started) {
  const state = createSseState();

  if (!response.body) {
    state.connectionClosedAt = performance.now();
    return state;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value?.byteLength) continue;
      state.firstByteAt ??= performance.now();
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator;
      while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const match = buffer.slice(separator).match(/^\r?\n\r?\n/);
        const separatorLength = match?.[0].length || 2;
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + separatorLength);
        consumeSseText("", `${frame}\n\n`, state);
      }
    }
    buffer += decoder.decode();
    flushSseText(buffer, state);
    state.readerCompleted = true;
  } finally {
    state.connectionClosedAt = performance.now();
    reader.releaseLock();
  }
  state.quality = evaluateQuality(input, state.content);
  state.qualityPass = state.quality.pass === true;
  return state;
}

async function request(model, input, armLabel) {
  const started = performance.now();
  const requestCorrelationId = `shadow-${input.id}-${armLabel}-${randomUUID()}`;
  let response = null;
  try {
    const requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "X-OmniRoute-No-Cache": "true",
        "X-Correlation-Id": requestCorrelationId,
      },
      signal: requestSignal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: input.prompt }],
        stream: true,
        temperature: 0,
        max_tokens: calibrationOnly || decisionOnly ? 128 : 32,
      }),
    });
    const headersAt = performance.now();
    const stream = await readStreamingBody(response, input, started);
    const responseCorrelationId = header(response, "x-correlation-id");
    const streamCompleted = isStreamComplete(response.status, stream);
    const quality = stream.quality || evaluateQuality(input, stream.content);
    return {
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      completionMs: stream.connectionClosedAt
        ? Math.round(stream.connectionClosedAt - started)
        : null,
      headersAtMs: Math.round(headersAt - started),
      firstByteMs: stream.firstByteAt ? Math.round(stream.firstByteAt - started) : null,
      firstEventMs: stream.firstEventAt ? Math.round(stream.firstEventAt - started) : null,
      firstContentMs: stream.firstContentAt ? Math.round(stream.firstContentAt - started) : null,
      lastEventMs: stream.lastEventAt ? Math.round(stream.lastEventAt - started) : null,
      doneMs: stream.doneAt ? Math.round(stream.doneAt - started) : null,
      connectionClosedMs: stream.connectionClosedAt
        ? Math.round(stream.connectionClosedAt - started)
        : null,
      streamCompleted,
      streamEventCount: stream.eventCount,
      failureClass: streamCompleted
        ? null
        : classifyFailure(response.status, stream.errorCode) ||
          (response.status === 200 ? "INCOMPLETE_STREAM" : null),
      errorCode: stream.errorCode || stream.parseError,
      responseModel: stream.responseModel,
      responseProvider: providerFromModel(stream.responseModel),
      usage: stream.usage,
      actualOutput: quality.actualOutput,
      outputLength: quality.outputLength,
      outputTruncated: quality.outputTruncated,
      qualityValidator: quality.validator,
      qualityReason: quality.reason,
      requestId: header(response, "x-request-id") || header(response, "x-omniroute-request-id"),
      requestCorrelationId,
      responseCorrelationId,
      correlationId: responseCorrelationId,
      fallbackAttempts: parsePositiveInteger(header(response, "x-omniroute-fallback-attempts")),
      cacheStatus: header(response, "x-omniroute-cache"),
      qualityPass: streamCompleted && quality.pass === true,
      harnessTimeout: false,
      model,
      armLabel,
      category: input.category,
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "transport_error";
    const harnessTimeout = errorName === "TimeoutError" || errorName === "AbortError";
    return {
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      completionMs: null,
      headersAtMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstContentMs: null,
      lastEventMs: null,
      doneMs: null,
      connectionClosedMs: null,
      streamCompleted: false,
      streamEventCount: 0,
      failureClass: harnessTimeout ? "HARNESS_TIMEOUT" : "TRANSPORT_ERROR",
      errorCode: errorName,
      responseModel: null,
      responseProvider: null,
      usage: null,
      actualOutput: "",
      outputLength: 0,
      outputTruncated: false,
      qualityValidator: input.quality || "exact",
      qualityReason: "transport_error",
      requestId: null,
      requestCorrelationId,
      responseCorrelationId: null,
      correlationId: null,
      fallbackAttempts: null,
      qualityPass: false,
      harnessTimeout,
      model,
      armLabel,
      category: input.category,
    };
  }
}

async function readGovernorPlan(correlationId) {
  if (!correlationId) return null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const row = queryGovernorTelemetryRows(100).find(
      (entry) => entry.correlationId === correlationId
    );
    if (row?.counterfactualPlan) {
      const plan = row.counterfactualPlan;
      return {
        governorMode: row.governorMode,
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
        recommendationTier: row.recommendation?.modelPolicy?.recommendedTier || null,
        routingStrategy: row.recommendation?.routingPolicy?.strategy || null,
        actualProvider: row.actualProvider || null,
        actualModel: row.actualModel || null,
      };
    }
    await sleep(150);
  }
  return null;
}

async function requestWithPlan(input, armLabel) {
  const requestResult = await request("auto/chat", input, armLabel);
  const plan = await readGovernorPlan(requestResult.correlationId);
  return { request: requestResult, plan };
}

function decorateNativeObservation(nativeArm) {
  const firstChoiceProven = Boolean(
    nativeArm.request.streamCompleted &&
    nativeArm.request.fallbackAttempts === 0 &&
    nativeArm.plan?.actualProvider &&
    nativeArm.plan?.actualModel &&
    compareObservedTarget(nativeArm.request.responseModel, nativeArm.plan)
  );
  return {
    ...nativeArm.request,
    plan: nativeArm.plan,
    firstChoiceProvider: nativeArm.plan?.actualProvider || null,
    firstChoiceModel: nativeArm.plan?.actualModel || null,
    firstChoiceProven,
    firstChoiceSuccess: firstChoiceProven,
    firstChoiceSource:
      nativeArm.request.fallbackAttempts === 0
        ? "terminal_outcome_without_fallback"
        : "unproven_after_fallback",
  };
}

function nativeTargetFromObservation(native) {
  if (!native.firstChoiceProven) return null;
  return `${native.firstChoiceProvider}/${native.firstChoiceModel}`;
}

async function revalidateTarget(plan) {
  if (!plan?.selectedProvider || !plan?.selectedModel || plan.executable !== true) {
    return { valid: false, reason: "plan_not_executable" };
  }

  try {
    const response = await fetch(`${BASE_URL}/api/monitoring/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const health = await response.json();
    const breaker = Array.isArray(health.providerBreakers)
      ? health.providerBreakers.find((item) => item?.provider === plan.selectedProvider)
      : null;
    const providerCircuitAllowed = !breaker || breaker.state !== "OPEN";
    const lockoutText = JSON.stringify(health.lockouts || []).toLowerCase();
    const targetLockout =
      lockoutText.includes(String(plan.selectedProvider).toLowerCase()) &&
      lockoutText.includes(String(plan.selectedModel).toLowerCase());
    const healthReady = response.ok && health.status === "healthy";
    const valid = healthReady && providerCircuitAllowed && !targetLockout;
    return {
      valid,
      healthStatus: health.status || null,
      healthHttpStatus: response.status,
      providerCircuitState: breaker?.state || "UNREPORTED",
      providerCircuitAllowed,
      targetLockout,
      lockoutCount: Array.isArray(health.lockouts) ? health.lockouts.length : null,
      cooldownState: "not exposed by health endpoint; plan/provider preflight retained",
      reason: valid ? null : "runtime_revalidation_failed",
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.name : "runtime_revalidation_error",
    };
  }
}

async function runGovernorArm(input) {
  const planned = await requestWithPlan(input, "governor-plan");
  const revalidation = await revalidateTarget(planned.plan);
  const targetValid = Boolean(
    planned.plan?.governorMode === "simulate" &&
    planned.plan.selectedProvider &&
    planned.plan.selectedModel &&
    planned.plan.executable &&
    revalidation.valid
  );
  const directTarget = targetValid
    ? `${planned.plan.selectedProvider}/${planned.plan.selectedModel}`
    : null;
  const direct = directTarget ? await request(directTarget, input, "governor-exec") : null;
  return { ...planned, direct, directTarget, revalidation };
}

function summarizeArm(results, firstChoiceSuccess = false) {
  const latencies = results
    .map((result) => result.completionMs ?? result.latencyMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const successes = results.filter((result) => result.status === 200);
  const quality = results.filter((result) => result.qualityPass);
  const percentile = (fraction) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * fraction))]
      : null;
  const mean = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : null;
  return {
    count: results.length,
    success: successes.length,
    successRate: results.length ? successes.length / results.length : null,
    qualityPass: quality.length,
    qualityPassRate: results.length ? quality.length / results.length : null,
    timeout: results.filter((result) => result.failureClass === "TIMEOUT").length,
    errors: results.filter((result) => result.status >= 400 || result.status === 0).length,
    minLatencyMs: latencies[0] ?? null,
    meanLatencyMs: mean,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    maxLatencyMs: latencies.at(-1) ?? null,
    firstChoiceSuccess,
  };
}

if (smokeOnly) {
  const smoke = await requestWithPlan(INPUTS[0], "correlation-smoke");
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        governor: "simulate / false / 0",
        request: smoke.request,
        plan: smoke.plan,
        correlationPass: Boolean(
          smoke.request.requestCorrelationId &&
          smoke.request.responseCorrelationId &&
          smoke.plan?.governorMode === "simulate"
        ),
      },
      null,
      2
    )
  );
  process.exit(smoke.plan ? 0 : 1);
}

async function runDecisionPair(input) {
  const nativeObservation = decorateNativeObservation(
    await requestWithPlan(input, "decision-native-observe")
  );
  const nativeTarget = nativeTargetFromObservation(nativeObservation);
  const nativeDirect = nativeTarget
    ? await request(nativeTarget, input, "decision-native-direct")
    : null;
  const governor = await runGovernorArm(input);
  const governorTarget = governor.directTarget;
  const governorDirect = governor.direct;
  const targetComparison =
    nativeTarget && governorTarget
      ? nativeTarget === governorTarget
        ? "AGREEMENT"
        : "DISAGREEMENT"
      : "UNPROVEN";
  return {
    pairId: input.id,
    category: input.category,
    benchmarkType: "A_DECISION_QUALITY",
    nativeObservation,
    nativeTarget,
    nativeDirect,
    governor: {
      planningRequest: governor.request,
      plan: governor.plan,
      directTarget: governorTarget,
      direct: governorDirect,
      revalidation: governor.revalidation,
    },
    targetComparison,
    pairwise:
      nativeDirect && governorDirect
        ? {
            qualityWinner:
              nativeDirect.qualityPass === governorDirect.qualityPass
                ? "tie"
                : nativeDirect.qualityPass
                  ? "native"
                  : "governor",
            reliabilityWinner:
              nativeDirect.streamCompleted && !governorDirect.streamCompleted
                ? "native"
                : governorDirect.streamCompleted && !nativeDirect.streamCompleted
                  ? "governor"
                  : "tie",
            latencyDeltaMs:
              (governorDirect.completionMs ?? governorDirect.latencyMs) -
              (nativeDirect.completionMs ?? nativeDirect.latencyMs),
          }
        : { qualityWinner: "unjudgeable", reliabilityWinner: "unjudgeable", latencyDeltaMs: null },
    correlation: {
      nativeObservation: nativeObservation.correlationId,
      nativeDirect: nativeDirect?.correlationId || null,
      governorPlan: governor.request.correlationId,
      governorExecution: governorDirect?.correlationId || null,
    },
  };
}

if (decisionOnly) {
  const decisionPairs = [];
  for (const input of selectedInputs) decisionPairs.push(await runDecisionPair(input));
  const nativeDirectResults = decisionPairs.map((pair) => pair.nativeDirect).filter(Boolean);
  const governorDirectResults = decisionPairs.map((pair) => pair.governor.direct).filter(Boolean);
  const targetAgreement = decisionPairs.filter(
    (pair) => pair.targetComparison === "AGREEMENT"
  ).length;
  const targetDisagreement = decisionPairs.filter(
    (pair) => pair.targetComparison === "DISAGREEMENT"
  ).length;
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        benchmarkType: "A_DECISION_QUALITY",
        pairCount: decisionPairs.length,
        executionPath:
          "Native Auto observation -> Native direct target and Governor plan -> Governor direct target",
        directRequestsComparable: true,
        governor: "simulate / false / 0",
        requestMode: "stream=true",
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxTokens: calibrationOnly || decisionOnly ? 128 : 32,
        timingMethod:
          "direct completionMs=reader close after SSE parsing; Auto observation timing excluded from direct comparison",
        qualityMethod:
          "deterministic exact/json/code validators over reconstructed content; no LLM judge",
        targetAgreement,
        targetDisagreement,
        targetUnproven: decisionPairs.length - targetAgreement - targetDisagreement,
        nativeDirect: summarizeArm(nativeDirectResults),
        governorDirect: summarizeArm(governorDirectResults),
        operationAccounting: accountBenchmarkOperations(decisionPairs),
        pairs: decisionPairs,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const pairs = [];
for (const [index, input] of selectedInputs.entries()) {
  const governorFirst = (startIndex + index) % 2 === 1;
  let native;
  let governor;
  if (governorFirst) {
    governor = await runGovernorArm(input);
    const nativeArm = await requestWithPlan(input, "native");
    native = decorateNativeObservation(nativeArm);
  } else {
    const nativeArm = await requestWithPlan(input, "native");
    native = decorateNativeObservation(nativeArm);
    governor = await runGovernorArm(input);
  }

  const nativePlan = native.plan;
  const governorPlan = governor.plan;
  const direct = governor.direct;
  pairs.push({
    pairId: input.id,
    category: input.category,
    executionOrder: governorFirst ? "governor_then_native" : "native_then_governor",
    native,
    governor: {
      planningRequest: governor.request,
      plan: governorPlan,
      directTarget: governor.directTarget,
      direct: direct ? { ...direct, attempts: 1, fallbackDepth: 0, directChoice: true } : null,
      revalidation: governor.revalidation,
    },
    targetValidity: {
      executable: governorPlan?.executable === true,
      unresolvedFields: governorPlan?.unresolvedFields || [],
      guardrails: governorPlan?.guardrails || {},
      directTarget: governor.directTarget,
      revalidation: governor.revalidation,
    },
    pairwise: direct
      ? {
          qualityWinner:
            native.qualityPass === direct.qualityPass
              ? "tie"
              : native.qualityPass
                ? "native"
                : "governor",
          reliabilityWinner:
            native.streamCompleted && !direct.streamCompleted
              ? "native"
              : direct.streamCompleted && !native.streamCompleted
                ? "governor"
                : "tie",
          latencyDeltaMs:
            (direct.completionMs ?? direct.latencyMs) - (native.completionMs ?? native.latencyMs),
        }
      : { qualityWinner: "unjudgeable", reliabilityWinner: "unjudgeable", latencyDeltaMs: null },
    correlation: {
      native: native.correlationId,
      governorPlan: governor.request.correlationId,
      governorExecution: direct?.correlationId || null,
      distinct:
        new Set(
          [
            native.requestCorrelationId,
            governor.request.requestCorrelationId,
            direct?.requestCorrelationId,
          ].filter(Boolean)
        ).size === (direct ? 3 : 2),
    },
    nativeFirstChoiceProvider: nativePlan?.actualProvider || null,
    nativeFirstChoiceModel: nativePlan?.actualModel || null,
  });
}

const nativeResults = pairs.map((pair) => pair.native);
const governorResults = pairs.map((pair) => pair.governor.direct).filter(Boolean);
const nativeFirstChoiceSuccess = nativeResults.filter((result) => result.firstChoiceSuccess).length;
const qualityCounts = pairs.reduce((counts, pair) => {
  counts[pair.pairwise.qualityWinner] = (counts[pair.pairwise.qualityWinner] || 0) + 1;
  return counts;
}, {});
const reliabilityCounts = pairs.reduce((counts, pair) => {
  counts[pair.pairwise.reliabilityWinner] = (counts[pair.pairwise.reliabilityWinner] || 0) + 1;
  return counts;
}, {});

console.log(
  JSON.stringify(
    {
      baseUrl: BASE_URL,
      pairCount: pairs.length,
      executionOrder: ["native_then_governor", "governor_then_native", "native_then_governor"],
      qualityMethod:
        "deterministic exact/json/code validators over reconstructed content; no LLM judge",
      governor: "simulate / false / 0",
      requestMode: "stream=true",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      timingMethod:
        "completionMs=reader close after SSE parsing; headers/firstByte/firstContent/done are offsets from fetch start",
      maxTokens: calibrationOnly || decisionOnly ? 128 : 32,
      externalTimeoutClassification: "HARNESS_TIMEOUT",
      native: summarizeArm(nativeResults, nativeFirstChoiceSuccess),
      governorDirect: summarizeArm(governorResults),
      governorPlansCorrelated: pairs.filter((pair) => pair.governor.plan).length,
      governorExecutable: pairs.filter((pair) => pair.governor.plan?.executable === true).length,
      qualityWins: qualityCounts,
      reliabilityWins: reliabilityCounts,
      operationAccounting: accountBenchmarkOperations(pairs),
      pairs,
    },
    null,
    2
  )
);
