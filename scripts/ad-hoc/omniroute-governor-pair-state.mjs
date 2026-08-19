export const PAIR_STATES = Object.freeze({
  PAIR_COMPLETE_VALID: "PAIR_COMPLETE_VALID",
  PAIR_INVALID: "PAIR_INVALID",
  NATIVE_ARM_MISSING: "NATIVE_ARM_MISSING",
  GOVERNOR_PLAN_MISSING: "GOVERNOR_PLAN_MISSING",
  GOVERNOR_PLAN_NON_EXECUTABLE: "GOVERNOR_PLAN_NON_EXECUTABLE",
  GOVERNOR_DIRECT_MISSING: "GOVERNOR_DIRECT_MISSING",
  NATIVE_HTTP_FAILURE: "NATIVE_HTTP_FAILURE",
  GOVERNOR_HTTP_FAILURE: "GOVERNOR_HTTP_FAILURE",
  NATIVE_STREAM_FAILURE: "NATIVE_STREAM_FAILURE",
  GOVERNOR_STREAM_FAILURE: "GOVERNOR_STREAM_FAILURE",
  NATIVE_QUALITY_FAILURE: "NATIVE_QUALITY_FAILURE",
  GOVERNOR_QUALITY_FAILURE: "GOVERNOR_QUALITY_FAILURE",
  STALE_PLAN: "STALE_PLAN",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  HARNESS_FAILURE: "HARNESS_FAILURE",
});

const GOVERNOR_PLAN_FAILURES = new Set([
  "NO_EXECUTABLE_TARGET",
  "GUARDRAIL_REJECTION",
  "MISSING_CAPABILITY_DATA",
  "MISSING_CONNECTION",
  "TARGET_NOT_ALLOWED",
]);

export function assessGovernorRuntimeReadiness({
  expectedMode = "simulate",
  effectiveMode,
  governorActive = false,
  canaryRate = 0,
} = {}) {
  if (effectiveMode !== expectedMode) {
    return {
      ready: false,
      state: PAIR_STATES.HARNESS_FAILURE,
      failureClass: "HARNESS_FAILURE",
      failureReason: "GOVERNOR_MODE_MISMATCH",
      rootCause: "HARNESS_LOGIC_ERROR",
      expectedMode,
      effectiveMode: effectiveMode ?? null,
      governorActive: governorActive === true,
      canaryRate,
    };
  }
  if (governorActive !== false) {
    return {
      ready: false,
      state: PAIR_STATES.HARNESS_FAILURE,
      failureClass: "HARNESS_FAILURE",
      failureReason: "GOVERNOR_ACTIVE_MISMATCH",
      rootCause: "HARNESS_LOGIC_ERROR",
      expectedMode,
      effectiveMode,
      governorActive: governorActive === true,
      canaryRate,
    };
  }
  if (canaryRate !== 0) {
    return {
      ready: false,
      state: PAIR_STATES.HARNESS_FAILURE,
      failureClass: "HARNESS_FAILURE",
      failureReason: "CANARY_NOT_ZERO",
      rootCause: "HARNESS_LOGIC_ERROR",
      expectedMode,
      effectiveMode,
      governorActive: false,
      canaryRate,
    };
  }
  return {
    ready: true,
    state: "READY",
    failureClass: null,
    failureReason: null,
    rootCause: null,
    expectedMode,
    effectiveMode,
    governorActive: false,
    canaryRate: 0,
  };
}

function firstGuardrailFailure(plan) {
  const entries = Object.entries(plan?.guardrailResults || {});
  const rejected = entries.find(([, result]) => result === "NO" || result === false);
  return rejected ? rejected[0] : null;
}

function planFailureReason(plan) {
  const rejectedGuardrail = firstGuardrailFailure(plan);
  if (rejectedGuardrail) return `GUARDRAIL_REJECTED:${rejectedGuardrail}`;
  const unresolved = Array.isArray(plan?.unresolvedFields) ? plan.unresolvedFields : [];
  if (unresolved.includes("capabilities") || unresolved.includes("capability")) {
    return "MISSING_CAPABILITY_DATA";
  }
  if (unresolved.includes("connection") || unresolved.includes("connections")) {
    return "MISSING_CONNECTION";
  }
  if (unresolved.includes("providerAvailability")) return "TARGET_NOT_ALLOWED";
  if (!plan?.selectedProvider || !plan?.selectedModel) return "NO_EXECUTABLE_TARGET";
  return "NO_EXECUTABLE_TARGET";
}

export function classifyGovernorPlan({
  plan = null,
  effectiveMode = "simulate",
  revalidation = null,
} = {}) {
  if (effectiveMode !== "simulate") {
    return {
      state: PAIR_STATES.GOVERNOR_PLAN_MISSING,
      planPresent: false,
      executable: false,
      failureClass: "HARNESS_FAILURE",
      failureReason: "GOVERNOR_MODE_MISMATCH",
      rootCause: "HARNESS_LOGIC_ERROR",
      stopBenchmark: true,
    };
  }
  if (!plan) {
    return {
      state: PAIR_STATES.GOVERNOR_PLAN_MISSING,
      planPresent: false,
      executable: false,
      failureClass: "HARNESS_FAILURE",
      failureReason: "PLAN_MISSING",
      rootCause: "HARNESS_LOGIC_ERROR",
      stopBenchmark: true,
    };
  }
  if (revalidation && revalidation.valid !== true) {
    return {
      state: PAIR_STATES.STALE_PLAN,
      planPresent: true,
      executable: plan.executable === true,
      failureClass: "STALE_PLAN",
      failureReason: revalidation.reason || "STALE_PLAN",
      rootCause: "STALE_PLAN",
      stopBenchmark: false,
    };
  }
  if (plan.executable === true && (!plan.selectedProvider || !plan.selectedModel)) {
    return {
      state: PAIR_STATES.HARNESS_FAILURE,
      planPresent: true,
      executable: false,
      failureClass: "HARNESS_FAILURE",
      failureReason: "EXECUTABLE_PLAN_WITHOUT_TARGET",
      rootCause: "HARNESS_LOGIC_ERROR",
      stopBenchmark: true,
    };
  }
  if (plan.executable !== true) {
    const failureReason = planFailureReason(plan);
    const failureClass = firstGuardrailFailure(plan)
      ? "GUARDRAIL_REJECTION"
      : GOVERNOR_PLAN_FAILURES.has(failureReason)
        ? failureReason
        : "NO_EXECUTABLE_TARGET";
    return {
      state: PAIR_STATES.GOVERNOR_PLAN_NON_EXECUTABLE,
      planPresent: true,
      executable: false,
      failureClass,
      failureReason,
      rootCause: failureClass,
      stopBenchmark: false,
    };
  }
  return {
    state: "PLAN_EXECUTABLE",
    planPresent: true,
    executable: true,
    failureClass: null,
    failureReason: null,
    rootCause: null,
    stopBenchmark: false,
  };
}

function requestForArm(arm) {
  return arm?.request || arm?.direct || arm || null;
}

function armE2E(arm) {
  const request = requestForArm(arm);
  return Number.isFinite(arm?.e2eCompletionMs)
    ? arm.e2eCompletionMs
    : Number.isFinite(request?.totalE2EMs)
      ? request.totalE2EMs
      : null;
}

export function pairLatencyWinner(nativeArm, governorArm) {
  const native = requestForArm(nativeArm);
  const governor = requestForArm(governorArm);
  const nativeE2E = armE2E(nativeArm);
  const governorE2E = armE2E(governorArm);
  if (
    !native ||
    !governor ||
    native.qualityPass !== true ||
    governor.qualityPass !== true ||
    native.status !== 200 ||
    governor.status !== 200 ||
    native.streamCompleted !== true ||
    governor.streamCompleted !== true ||
    !Number.isFinite(nativeE2E) ||
    !Number.isFinite(governorE2E)
  ) {
    return null;
  }
  if (nativeE2E >= governorE2E * 1.15) return "governor";
  if (governorE2E >= nativeE2E * 1.15) return "native";
  return "tie";
}

function outcome({
  state,
  valid = false,
  structuralValid = false,
  qualityWinner = null,
  successWinner = null,
  latencyWinner = null,
  winner = null,
  winnerReason = null,
  failureClass = null,
  failureReason = null,
  stopBenchmark = false,
  planState = null,
} = {}) {
  return {
    pairState: state,
    valid,
    structuralValid,
    qualityWinner,
    successWinner,
    latencyWinner,
    winner,
    winnerReason,
    failureClass,
    failureReason,
    stopBenchmark,
    planState,
  };
}

export function evaluatePairState({ native = null, governor = null, preflight = null } = {}) {
  if (!native?.request) {
    return outcome({
      state: PAIR_STATES.NATIVE_ARM_MISSING,
      failureClass: "HARNESS_FAILURE",
      failureReason: "NATIVE_ARM_MISSING",
      stopBenchmark: true,
    });
  }

  const planState =
    governor?.planState ||
    classifyGovernorPlan({
      plan: governor?.plan || null,
      effectiveMode: governor?.effectiveGovernorMode || "simulate",
      revalidation: governor?.revalidation || null,
    });
  if (planState.state !== "PLAN_EXECUTABLE") {
    return outcome({
      state: planState.state,
      failureClass: planState.failureClass,
      failureReason: planState.failureReason,
      stopBenchmark: planState.stopBenchmark,
      planState: planState.state,
    });
  }
  if (!governor?.direct) {
    return outcome({
      state: PAIR_STATES.GOVERNOR_DIRECT_MISSING,
      failureClass: "HARNESS_FAILURE",
      failureReason: "EXECUTABLE_PLAN_WITHOUT_GOVERNOR_ARM",
      stopBenchmark: true,
      planState: planState.state,
    });
  }

  const nativeTarget = native.nativeFinalTarget || native.executedTarget || null;
  const preflightTarget = preflight?.nativeFinalTarget || preflight?.nativeFirstTarget || null;
  if (preflightTarget && nativeTarget && preflightTarget !== nativeTarget) {
    return outcome({
      state: PAIR_STATES.TARGET_MISMATCH,
      failureClass: "TARGET_MISMATCH",
      failureReason: "NATIVE_PREFLIGHT_TARGET_MISMATCH",
      stopBenchmark: true,
      planState: planState.state,
    });
  }
  if (native.targetIdentity === "MISMATCH" || governor.targetIdentity === "MISMATCH") {
    return outcome({
      state: PAIR_STATES.TARGET_MISMATCH,
      failureClass: "TARGET_MISMATCH",
      failureReason: "EXECUTED_TARGET_MISMATCH",
      stopBenchmark: true,
      planState: planState.state,
    });
  }
  if (native.targetIdentity !== "PASS" || governor.targetIdentity !== "PASS") {
    return outcome({
      state: PAIR_STATES.HARNESS_FAILURE,
      failureClass: "HARNESS_FAILURE",
      failureReason: "TARGET_IDENTITY_UNPROVEN",
      stopBenchmark: true,
      planState: planState.state,
    });
  }

  const nativeRequest = native.request;
  const governorRequest = governor.direct;
  const nativeHttpPass = nativeRequest.status === 200;
  const governorHttpPass = governorRequest.status === 200;
  if (!nativeHttpPass || !governorHttpPass) {
    const state = !nativeHttpPass
      ? PAIR_STATES.NATIVE_HTTP_FAILURE
      : PAIR_STATES.GOVERNOR_HTTP_FAILURE;
    return outcome({
      state,
      successWinner:
        nativeHttpPass === governorHttpPass ? "tie" : nativeHttpPass ? "native" : "governor",
      failureClass: state,
      failureReason: !nativeHttpPass ? "NATIVE_HTTP_NOT_200" : "GOVERNOR_HTTP_NOT_200",
      planState: planState.state,
    });
  }

  const nativeStreamPass = nativeRequest.streamCompleted === true;
  const governorStreamPass = governorRequest.streamCompleted === true;
  if (!nativeStreamPass || !governorStreamPass) {
    const state = !nativeStreamPass
      ? PAIR_STATES.NATIVE_STREAM_FAILURE
      : PAIR_STATES.GOVERNOR_STREAM_FAILURE;
    return outcome({
      state,
      successWinner:
        nativeStreamPass === governorStreamPass ? "tie" : nativeStreamPass ? "native" : "governor",
      failureClass: "STREAM_FAILURE",
      failureReason: !nativeStreamPass ? "NATIVE_STREAM_INCOMPLETE" : "GOVERNOR_STREAM_INCOMPLETE",
      planState: planState.state,
    });
  }

  const nativeQuality = nativeRequest.qualityPass === true;
  const governorQuality = governorRequest.qualityPass === true;
  const qualityWinner =
    nativeQuality === governorQuality ? "tie" : nativeQuality ? "native" : "governor";
  if (!nativeQuality || !governorQuality) {
    const state = !nativeQuality
      ? PAIR_STATES.NATIVE_QUALITY_FAILURE
      : PAIR_STATES.GOVERNOR_QUALITY_FAILURE;
    return outcome({
      state,
      valid: true,
      structuralValid: true,
      qualityWinner,
      winner: qualityWinner === "tie" ? null : qualityWinner,
      winnerReason: qualityWinner === "tie" ? "quality_tie" : "quality",
      failureClass: "MODEL_QUALITY_FAILURE",
      failureReason: !nativeQuality ? "NATIVE_QUALITY_FAILURE" : "GOVERNOR_QUALITY_FAILURE",
      planState: planState.state,
    });
  }

  const latencyWinner = pairLatencyWinner(native, governor);
  return outcome({
    state: PAIR_STATES.PAIR_COMPLETE_VALID,
    valid: true,
    structuralValid: true,
    qualityWinner: "tie",
    latencyWinner,
    winner: latencyWinner,
    winnerReason: latencyWinner
      ? "total_e2e_latency_15_percent_threshold"
      : "latency_not_applicable",
    planState: planState.state,
  });
}
