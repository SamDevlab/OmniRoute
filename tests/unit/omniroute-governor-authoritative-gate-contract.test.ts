import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const harnessSource = fs.readFileSync(
  new URL("../../scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs", import.meta.url),
  "utf8"
);

function functionSource(name: string, nextName: string) {
  const start = harnessSource.indexOf(`function ${name}(`);
  const end = harnessSource.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0, `${name} source must remain inspectable`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return harnessSource.slice(start, end);
}

function fivePairGateSource() {
  return functionSource("gateForFivePairs", "authoritativePairwise");
}

test(
  "authoritative five-pair gate treats model quality as an outcome, not a methodology blocker",
  () => {
    const source = fivePairGateSource();

    assert.match(source, /qualityMeasured/);
    assert.match(source, /typeof pair\.native\?\.request\?\.qualityPass === "boolean"/);
    assert.match(source, /typeof pair\.governor\?\.direct\?\.qualityPass === "boolean"/);
    assert.doesNotMatch(source, /&&\s*qualityPass\s*&&/);
    assert.doesNotMatch(source, /qualityPass\s*&&\s*artifactIntegrity/);
    assert.match(source, /qualityIsMethodologyGate:\s*false/);
  }
);

test(
  "authoritative gate requires both target identities, complete artifacts, and independent accounting",
  () => {
    const source = fivePairGateSource();

    assert.match(source, /pair\.native\?\.targetIdentity === "PASS"/);
    assert.match(source, /pair\.governor\?\.targetIdentity === "PASS"/);
    assert.match(source, /pair\.pairCompleteOperationId/);
    assert.match(source, /const accountingPass =/);
    assert.match(source, /accounting\.nativeRequests === 5/);
    assert.match(source, /accounting\.governorPlanningOperations === 5/);
    assert.match(source, /accounting\.governorExecutionRequests === 5/);
    assert.match(source, /accounting\.physicalRequests === 10/);
    assert.match(source, /accounting:\s*accountingPass \? "PASS" : "FAIL"/);
    assert.doesNotMatch(source, /accounting:\s*pass \? "PASS" : "FAIL"/);
  }
);

test("authoritative gate still rejects structural, identity, and runtime failures", () => {
  const source = fivePairGateSource();

  for (const failure of [
    "HARNESS_FAILURE",
    "VALIDATOR_FAILURE",
    "TARGET_MISMATCH",
    "STALE_PLAN",
    "SYSTEMIC_RUNTIME_FAILURE",
  ]) {
    assert.match(source, new RegExp(`\\"${failure}\\"`));
  }
  assert.match(source, /identityPass/);
  assert.match(source, /correlationPass/);
  assert.match(source, /artifactIntegrity/);
  assert.match(source, /invalid === 0/);
});

test("authoritative conclusion refuses latency claims when no pair is latency-comparable", () => {
  const source = functionSource("authoritativeConclusion", "calibrationRecoverySummary");

  assert.match(source, /latencyComparablePairs/);
  assert.match(source, /pair\.native\?\.request\?\.qualityPass === true/);
  assert.match(source, /pair\.governor\?\.direct\?\.qualityPass === true/);
  assert.match(source, /Number\.isFinite\(pair\.native\?\.e2eCompletionMs\)/);
  assert.match(source, /Number\.isFinite\(pair\.governor\?\.e2eCompletionMs\)/);
  assert.match(source, /latencyComparablePairs\.length === 0\) return "E2E_INCONCLUSIVE"/);
  assert.match(source, /pairwise\.nativeLatencyWins > pairwise\.governorLatencyWins/);
  assert.match(source, /pairwise\.governorLatencyWins > pairwise\.nativeLatencyWins/);
});

test(
  "Governor execution identity fails closed unless target and required connection are both proven",
  () => {
    const start = harnessSource.indexOf(
      "const targetIdentity =",
      harnessSource.indexOf("runGovernorE2E")
    );
    const end = harnessSource.indexOf("const identityFailureClass =", start);
    assert.ok(start >= 0 && end > start);
    const source = harnessSource.slice(start, end);

    assert.match(source, /targetMatch === "MISMATCH" \|\| connectionIdentity === "MISMATCH"/);
    assert.match(source, /targetMatch === "PASS" && connectionIdentity === "PASS"/);
    assert.match(source, /: "UNKNOWN"/);
  }
);

test(
  "target revalidation evaluates all matching connection-specific targets instead of first-match state",
  () => {
    const source = functionSource("revalidateTarget", "planTarget");

    assert.match(source, /pool\.targets\.filter/);
    assert.match(source, /pool\.candidates\.filter/);
    assert.match(source, /targets\.flatMap/);
    assert.match(source, /connectionChecks\.some\(\(check\) => check\.available\)/);
    assert.match(source, /connectionChecks\.every\(\(check\) => check\.modelLocked\)/);
    assert.match(
      source,
      /candidates\.some\(\(candidate\) => candidate\.quotaCutoffBlocked !== true\)/
    );
    assert.doesNotMatch(source, /pool\.targets\.find/);
    assert.doesNotMatch(source, /pool\.candidates\.find/);
  }
);

test(
  "authoritative harness keeps baseline execution identity separate from canonical routing target",
  () => {
    assert.match(harnessSource, /nativeBaselineExecutionKey/);
    assert.match(harnessSource, /nativeBaselineCanonicalTarget/);
    assert.match(harnessSource, /nativeBaselineTarget/);
  }
);
