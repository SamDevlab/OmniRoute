import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
// Keep production DB reads isolated from the parent process before any DB module is imported.
// The parent process remains on the household DB; this child cannot open or mutate it.
globalThis.caches = {};
const [{ resolveAutoStrategyOrder }, { parseModel }] = await Promise.all([
  import("../../open-sse/services/combo/resolveAutoStrategy.ts"),
  import("../../open-sse/services/model.ts"),
]);

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NATIVE_BASELINE_NETWORK_FORBIDDEN");
};

const snapshot = payload.snapshot;
const request = payload.request;
const targets = snapshot.targets.map((target) => ({ ...target }));
const candidateByKey = new Map(
  snapshot.candidates.map((candidate) => [
    candidate.executionKey || candidateKey(candidate),
    candidate,
  ])
);
const combo = {
  id: snapshot.routingConfig.combo.id,
  name: snapshot.routingConfig.combo.name,
  models: targets,
  autoConfig: snapshot.routingConfig.combo.autoConfig,
  config: snapshot.routingConfig.combo.config,
  system_message: snapshot.routingConfig.combo.system_message || null,
};
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function candidateKey(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const provider = typeof candidate.provider === "string" ? candidate.provider : "";
  const model = typeof candidate.model === "string" ? candidate.model : "";
  return provider && model ? `${provider}/${model}` : null;
}

/**
 * A virtual Auto target has two different identities:
 * - executionKey: internal combo-step identity (for example virtual-auto-default-1-opencode)
 * - canonicalTarget: routing identity provider/model (for example opencode/big-pickle)
 *
 * Never compare an executionKey to runtime provider/model observations. The explicit target
 * provider is authoritative; parseModel is used only to normalize the target's modelStr dialect
 * (for example oc/big-pickle -> big-pickle while provider remains opencode).
 */
function canonicalTargetIdentity(target) {
  if (!target || typeof target !== "object") {
    return {
      executionKey: null,
      provider: null,
      model: null,
      canonicalTarget: null,
      connectionId: null,
    };
  }
  const parsed = parseModel(target.modelStr);
  const provider =
    typeof target.provider === "string" && target.provider
      ? target.provider
      : parsed.provider || null;
  const model =
    typeof parsed.model === "string" && parsed.model
      ? parsed.model
      : typeof target.modelStr === "string" && target.modelStr
        ? target.modelStr
        : null;
  return {
    executionKey:
      typeof target.executionKey === "string" && target.executionKey ? target.executionKey : null,
    provider,
    model,
    canonicalTarget: provider && model ? `${provider}/${model}` : null,
    connectionId: target.connectionId || null,
  };
}

function candidateForTarget(target) {
  return (
    candidateByKey.get(target.executionKey) ||
    snapshot.candidates.find(
      (candidate) =>
        candidate.provider === target.provider &&
        (candidate.modelStr === target.modelStr || candidate.model === target.modelStr)
    ) ||
    null
  );
}

try {
  const result = await resolveAutoStrategyOrder({
    orderedTargets: targets,
    body: request.body,
    combo,
    settings: snapshot.routingConfig.settings,
    config: snapshot.routingConfig.config,
    correlationId: `native-baseline-${snapshot.snapshotId}`,
    relayOptions: {
      bypassProviderQuotaPolicy: false,
      mode: null,
      budgetCap: null,
      budgetFallback: null,
    },
    resilienceSettings: snapshot.routingConfig.resilienceSettings,
    log: logger,
    buildAutoCandidates: async (eligibleTargets) =>
      eligibleTargets
        .map(candidateForTarget)
        .filter(Boolean)
        .map((candidate) => ({ ...candidate })),
  });

  if ("earlyResponse" in result) {
    throw new Error("NATIVE_BASELINE_EARLY_RESPONSE");
  }
  const orderedTargets = result.orderedTargets.map((target) => ({
    ...canonicalTargetIdentity(target),
    modelStr: target.modelStr || null,
  }));
  const baseline = orderedTargets[0] || null;
  process.stdout.write(
    "NATIVE_BASELINE_RESULT:" +
      JSON.stringify({
        ok: Boolean(baseline?.canonicalTarget),
        // nativeBaselineTarget is deliberately the canonical routing identity.
        // Keep the virtual execution key separately so artifacts remain auditable.
        nativeBaselineTarget: baseline?.canonicalTarget || null,
        nativeBaselineCanonicalTarget: baseline?.canonicalTarget || null,
        nativeBaselineExecutionKey: baseline?.executionKey || null,
        nativeBaselineProvider: baseline?.provider || null,
        nativeBaselineModel: baseline?.model || null,
        nativeBaselineConnection: baseline?.connectionId || null,
        nativeBaselineCandidateOrder: orderedTargets,
        nativeBaselineCandidateCount: orderedTargets.length,
        nativeBaselineSelection: "resolveAutoStrategyOrder",
        nativeBaselineResolution: "side_effect_free",
        networkCalls,
      })
  );
} catch (error) {
  process.stdout.write(
    "NATIVE_BASELINE_RESULT:" +
      JSON.stringify({
        ok: false,
        nativeBaselineTarget: null,
        nativeBaselineCanonicalTarget: null,
        nativeBaselineExecutionKey: null,
        nativeBaselineProvider: null,
        nativeBaselineModel: null,
        nativeBaselineConnection: null,
        nativeBaselineCandidateOrder: [],
        nativeBaselineCandidateCount: 0,
        nativeBaselineSelection: "resolveAutoStrategyOrder",
        nativeBaselineResolution: "side_effect_free",
        networkCalls,
        error: error instanceof Error ? error.message : String(error),
      })
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
