import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const harnessSource = fs.readFileSync(
  new URL("../../scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs", import.meta.url),
  "utf8"
);

function fivePairGateSource() {
  const match = harnessSource.match(
    /function gateForFivePairs\(pairs\) \{([\s\S]*?)\n\}\n\nfunction authoritativePairwise/
  );
  assert.ok(match, "gateForFivePairs source must remain inspectable");
  return match[1];
}

test("authoritative five-pair gate treats model quality as an outcome, not a methodology blocker", () => {
  const source = fivePairGateSource();

  assert.match(source, /qualityMeasured/);
  assert.match(source, /typeof pair\.native\?\.request\?\.qualityPass === "boolean"/);
  assert.match(source, /typeof pair\.governor\?\.direct\?\.qualityPass === "boolean"/);
  assert.doesNotMatch(source, /&&\s*qualityPass\s*&&/);
  assert.doesNotMatch(source, /qualityPass\s*&&\s*artifactIntegrity/);
  assert.match(source, /qualityIsMethodologyGate:\s*false/);
});

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

test("authoritative harness keeps baseline execution identity separate from canonical routing target", () => {
  assert.match(harnessSource, /nativeBaselineExecutionKey/);
  assert.match(harnessSource, /nativeBaselineCanonicalTarget/);
  assert.match(harnessSource, /nativeBaselineTarget/);
});
