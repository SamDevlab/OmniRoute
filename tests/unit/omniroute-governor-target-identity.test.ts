import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTargetKey,
  evaluatePlannedConnectionIdentity,
  resolveNativeBaselinePoolTarget,
  resolvePlanTargetDescriptor,
  targetIdentityFromResolved,
} from "../../scripts/ad-hoc/omniroute-governor-target-identity.mjs";

function target(
  executionKey: string,
  provider: string,
  modelStr: string,
  connectionId: string,
  allowedConnectionIds: string[] = [connectionId]
) {
  return {
    kind: "model",
    stepId: executionKey,
    executionKey,
    provider,
    providerId: provider,
    modelStr,
    connectionId,
    allowedConnectionIds,
  };
}

test("canonical identity preserves internal execution key but normalizes OpenCode model dialect", () => {
  const identity = targetIdentityFromResolved(
    target("virtual-auto-default-1-opencode", "opencode", "oc/big-pickle", "noauth")
  );

  assert.equal(identity.executionKey, "virtual-auto-default-1-opencode");
  assert.equal(identity.provider, "opencode");
  assert.equal(identity.model, "big-pickle");
  assert.equal(identity.canonicalTarget, "opencode/big-pickle");
  assert.equal(identity.connectionId, "noauth");
  assert.equal(canonicalTargetKey("opencode", "big-pickle"), "opencode/big-pickle");
});

test("baseline lookup prefers exact execution key and verifies its canonical identity", () => {
  const first = target("virtual-1", "opencode", "oc/big-pickle", "noauth");
  const second = target("virtual-6", "opencode", "oc/big-pickle", "noauth");
  const result = resolveNativeBaselinePoolTarget([first, second], {
    nativeBaselineExecutionKey: "virtual-6",
    nativeBaselineTarget: "opencode/big-pickle",
    nativeBaselineConnection: "noauth",
  });

  assert.equal(result.failureReason, null);
  assert.equal(result.matchMode, "execution_key");
  assert.equal(result.target, second);
  assert.equal(result.identity?.canonicalTarget, "opencode/big-pickle");
});

test("baseline lookup fails closed when only canonical identity is ambiguous", () => {
  const result = resolveNativeBaselinePoolTarget(
    [
      target("virtual-1", "opencode", "oc/big-pickle", "conn-a"),
      target("virtual-6", "opencode", "oc/big-pickle", "conn-b"),
    ],
    { nativeBaselineTarget: "opencode/big-pickle" }
  );

  assert.equal(result.target, null);
  assert.equal(result.failureReason, "AMBIGUOUS_BASELINE_IDENTITY");
});

test("execution key cannot silently point at a different canonical target", () => {
  const result = resolveNativeBaselinePoolTarget(
    [target("virtual-1", "opencode", "oc/big-pickle", "noauth")],
    {
      nativeBaselineExecutionKey: "virtual-1",
      nativeBaselineTarget: "felo-web/felo-chat",
      nativeBaselineConnection: "noauth",
    }
  );

  assert.equal(result.target, null);
  assert.equal(result.failureReason, "BASELINE_EXECUTION_CANONICAL_MISMATCH");
});

test("plan descriptor unions connections instead of inventing the first one", () => {
  const descriptor = resolvePlanTargetDescriptor(
    [
      target("virtual-a", "provider", "provider/model", "conn-a"),
      target("virtual-b", "provider", "provider/model", "conn-b"),
    ],
    "provider/model"
  );

  assert.ok(descriptor);
  assert.equal(descriptor.connectionId, null);
  assert.equal(descriptor.ambiguousConnection, true);
  assert.deepEqual(new Set(descriptor.allowedConnectionIds), new Set(["conn-a", "conn-b"]));
  assert.equal(evaluatePlannedConnectionIdentity(descriptor, "conn-a"), "PASS");
  assert.equal(evaluatePlannedConnectionIdentity(descriptor, "conn-b"), "PASS");
  assert.equal(evaluatePlannedConnectionIdentity(descriptor, "conn-c"), "MISMATCH");
});

test("single planned connection remains exact", () => {
  const descriptor = resolvePlanTargetDescriptor(
    [target("virtual-a", "provider", "provider/model", "conn-a")],
    "provider/model"
  );
  assert.ok(descriptor);
  assert.equal(descriptor.connectionId, "conn-a");
  assert.equal(descriptor.ambiguousConnection, false);
  assert.equal(evaluatePlannedConnectionIdentity(descriptor, "conn-a"), "PASS");
  assert.equal(evaluatePlannedConnectionIdentity(descriptor, "conn-b"), "MISMATCH");
});
