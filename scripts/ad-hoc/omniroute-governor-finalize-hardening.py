from pathlib import Path

HARNESS = Path("scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs")


def replace_between(source: str, start_marker: str, end_marker: str, replacement: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[:start] + replacement + source[end:]


def main() -> None:
    text = HARNESS.read_text(encoding="utf-8")

    identity = '''  const targetIdentity =
    targetMatch === "MISMATCH" || connectionIdentity === "MISMATCH"
      ? "MISMATCH"
      : targetMatch === "PASS" && connectionIdentity === "PASS"
        ? "PASS"
        : "UNKNOWN";
'''
    current_identity_start = text.index("  const targetIdentity =", text.index("async function runGovernorE2E("))
    current_identity_end = text.index("  const identityFailureClass =", current_identity_start)
    text = text[:current_identity_start] + identity + text[current_identity_end:]

    revalidate = '''async function revalidateTarget(pool, provider, model) {
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
    (candidate) =>
      candidate.circuitBreakerState !== "OPEN" && candidate.statusPenalty !== true
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

'''
    text = replace_between(
        text,
        "async function revalidateTarget(pool, provider, model) {",
        "function planTarget(plan) {",
        revalidate,
    )

    gate = '''function gateForFivePairs(pairs) {
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
      (pair) =>
        pair.native?.targetIdentity === "PASS" && pair.governor?.targetIdentity === "PASS"
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

'''
    text = replace_between(
        text,
        "function gateForFivePairs(pairs) {",
        "function authoritativePairwise(pairs) {",
        gate,
    )

    conclusion = '''function authoritativeConclusion(pairs, aggregates, pairwise) {
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

'''
    text = replace_between(
        text,
        "function authoritativeConclusion(pairs, aggregates, pairwise) {",
        "function calibrationRecoverySummary(pairs) {",
        conclusion,
    )

    HARNESS.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
