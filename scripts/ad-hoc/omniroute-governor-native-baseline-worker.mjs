import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
// Force the production DB layer onto its in-memory/cloud branch before any DB module is imported.
// The parent process remains on the household DB; this child cannot open or mutate it.
globalThis.caches = {};
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");

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
    executionKey: target.executionKey,
    provider: target.provider,
    model: target.modelStr?.startsWith(`${target.provider}/`)
      ? target.modelStr.slice(target.provider.length + 1)
      : target.modelStr,
    connectionId: target.connectionId || null,
  }));
  const baseline = orderedTargets[0] || null;
  process.stdout.write(
    "NATIVE_BASELINE_RESULT:" +
      JSON.stringify({
        ok: Boolean(baseline),
        nativeBaselineTarget: baseline?.executionKey || null,
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
