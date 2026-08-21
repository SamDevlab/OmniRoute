import { readFileSync } from "node:fs";

import { handleComboChat } from "../../open-sse/services/combo.ts";
import { parseModel } from "../../open-sse/services/model.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const networkCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  networkCalls.push(String(args[0]));
  return originalFetch(...args);
};

const captured = [];
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const targets = input.snapshot.targets.map((target) => ({
  id: target.executionKey,
  kind: "model",
  model:
    input.snapshot.candidates.find(
      (candidate) =>
        candidate.provider === target.provider &&
        (target.modelStr === candidate.model || target.modelStr.endsWith(`/${candidate.model}`))
    )?.model ||
    (target.modelStr.startsWith(`${target.provider}/`)
      ? target.modelStr.slice(target.provider.length + 1)
      : target.modelStr),
  providerId: target.provider,
  connectionId: target.connectionId ?? null,
  allowedConnectionIds: target.allowedConnectionIds ?? undefined,
  weight: target.weight ?? 1,
  label: target.label ?? target.modelStr,
}));
const combo = {
  id: input.snapshot.routingConfig.combo.id || "auto",
  name: input.snapshot.routingConfig.combo.name || "auto",
  strategy: "auto",
  models: targets,
  autoConfig: input.snapshot.routingConfig.combo.autoConfig,
  config: input.snapshot.routingConfig.combo.config,
};

const handleSingleModel = async (_body, modelStr, target) => {
  captured.push({
    modelStr,
    provider: target?.provider ?? null,
    model: target?.modelStr ?? modelStr,
    connectionId: target?.connectionId ?? null,
    executionKey: target?.executionKey ?? null,
    effectiveComboStrategy: target?.effectiveComboStrategy ?? null,
  });
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const frozenCandidates = input.snapshot.candidates;
const buildAutoCandidates = async (resolvedTargets) =>
  resolvedTargets
    .map((target) => {
      const parsed = parseModel(target.modelStr);
      const model = parsed.model || target.modelStr;
      const candidate = frozenCandidates.find(
        (item) => item.provider === target.provider && item.model === model
      );
      return candidate
        ? {
            ...candidate,
            stepId: target.stepId,
            executionKey: target.executionKey,
            modelStr: target.modelStr,
            connectionId: target.connectionId ?? candidate.connectionId,
          }
        : null;
    })
    .filter(Boolean);

try {
  await handleComboChat({
    body: input.request.body,
    combo,
    handleSingleModel,
    settings: input.snapshot.routingConfig.settings,
    relayOptions: input.request.relayOptions ?? null,
    apiKeyAllowedConnections: null,
    log,
    buildAutoCandidates,
  });
  const first = captured[0] || null;
  const parsedFirst = first ? parseModel(first.model) : null;
  const canonicalModel = parsedFirst?.model || first?.model || null;
  console.log(
    `PRODUCTION_ROUTING_PARITY_RESULT:${JSON.stringify({
      ok: Boolean(first),
      productionFirstExecutionKey: first?.executionKey ?? null,
      productionFirstCanonicalTarget:
        first?.provider && canonicalModel ? `${first.provider}/${canonicalModel}` : null,
      productionFirstProvider: first?.provider ?? null,
      productionFirstModel: canonicalModel,
      productionFirstConnection: first?.connectionId ?? null,
      productionEvidenceSource: first ? "HANDLE_SINGLE_MODEL_INTERCEPT" : null,
      preludeOwner: first ? "ATTEMPT_LOOP_OR_DISPATCH_PRELUDE" : null,
      orderedTargetCount: input.snapshot.targets.length,
      interceptedCalls: captured.length,
      networkCallsBeforeIntercept: networkCalls.length,
      providerModelCalls: 0,
      physicalDispatchPrevented: true,
      networkUrls: networkCalls,
    })}`
  );
} finally {
  globalThis.fetch = originalFetch;
}
