import { PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.ts";
import { parseModel } from "../../open-sse/services/model.ts";

function cleanString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Produce the benchmark's canonical routing identity while keeping the explicit provider
 * authoritative. Some providers expose a public model dialect that itself contains a provider
 * alias (for example OpenCode `oc/big-pickle`), while other providers legitimately expose model
 * IDs containing `/` (for example NVIDIA serving `openai/gpt-oss-*`). Only strip an inner prefix
 * when parsing that raw model resolves back to the same explicit provider.
 */
export function canonicalTargetKey(provider, model) {
  const explicitProvider = cleanString(provider);
  const rawModel = cleanString(model);
  if (!explicitProvider || !rawModel) return null;

  const rawParsed = parseModel(rawModel);
  if (rawParsed.provider === explicitProvider && rawParsed.model) {
    return `${explicitProvider}/${rawParsed.model}`;
  }

  const providerPrefix = PROVIDER_ID_TO_ALIAS[explicitProvider] || explicitProvider;
  const pairParsed = parseModel(`${providerPrefix}/${rawModel}`);
  return `${explicitProvider}/${pairParsed.model || rawModel}`;
}

export function targetIdentityFromResolved(target) {
  if (!target || typeof target !== "object") {
    return {
      executionKey: null,
      provider: null,
      model: null,
      canonicalTarget: null,
      connectionId: null,
      allowedConnectionIds: [],
      modelStr: null,
    };
  }
  const modelStr = cleanString(target.modelStr);
  const parsed = modelStr ? parseModel(modelStr) : { provider: null, model: null };
  const provider = cleanString(target.provider) || cleanString(parsed.provider) || "unknown";
  const model = cleanString(parsed.model) || modelStr;
  const canonicalTarget = model ? canonicalTargetKey(provider, model) : null;
  const allowedConnectionIds = [
    cleanString(target.connectionId),
    ...(Array.isArray(target.allowedConnectionIds)
      ? target.allowedConnectionIds.map(cleanString)
      : []),
  ].filter(Boolean);
  return {
    executionKey: cleanString(target.executionKey) || cleanString(target.stepId),
    provider,
    model,
    canonicalTarget,
    connectionId: cleanString(target.connectionId),
    allowedConnectionIds: [...new Set(allowedConnectionIds)],
    modelStr,
  };
}

export function targetIdentityFromObserved(provider, model, connectionId = null) {
  const canonicalTarget = canonicalTargetKey(provider, model);
  if (!canonicalTarget) {
    return {
      provider: cleanString(provider),
      model: cleanString(model),
      canonicalTarget: null,
      connectionId: cleanString(connectionId),
    };
  }
  const slash = canonicalTarget.indexOf("/");
  return {
    provider: canonicalTarget.slice(0, slash),
    model: canonicalTarget.slice(slash + 1),
    canonicalTarget,
    connectionId: cleanString(connectionId),
  };
}

function connectionCompatible(identity, requestedConnection) {
  const connection = cleanString(requestedConnection);
  if (!connection) return true;
  return identity.connectionId === connection || identity.allowedConnectionIds.includes(connection);
}

export function resolveNativeBaselinePoolTarget(targets, baseline) {
  const list = Array.isArray(targets) ? targets : [];
  const executionKey = cleanString(baseline?.nativeBaselineExecutionKey);
  const canonicalTarget =
    cleanString(baseline?.nativeBaselineCanonicalTarget) ||
    cleanString(baseline?.nativeBaselineTarget);
  const connectionId = cleanString(baseline?.nativeBaselineConnection);

  if (executionKey) {
    const matches = list.filter(
      (target) => targetIdentityFromResolved(target).executionKey === executionKey
    );
    if (matches.length > 1) {
      return {
        target: null,
        identity: null,
        failureReason: "AMBIGUOUS_BASELINE_EXECUTION_KEY",
        matchMode: "execution_key",
      };
    }
    if (matches.length === 1) {
      const identity = targetIdentityFromResolved(matches[0]);
      if (canonicalTarget && identity.canonicalTarget !== canonicalTarget) {
        return {
          target: null,
          identity,
          failureReason: "BASELINE_EXECUTION_CANONICAL_MISMATCH",
          matchMode: "execution_key",
        };
      }
      if (!connectionCompatible(identity, connectionId)) {
        return {
          target: null,
          identity,
          failureReason: "BASELINE_EXECUTION_CONNECTION_MISMATCH",
          matchMode: "execution_key",
        };
      }
      return { target: matches[0], identity, failureReason: null, matchMode: "execution_key" };
    }
  }

  if (!canonicalTarget) {
    return {
      target: null,
      identity: null,
      failureReason: "NATIVE_BASELINE_CANONICAL_TARGET_MISSING",
      matchMode: null,
    };
  }

  const canonicalMatches = list
    .map((target) => ({ target, identity: targetIdentityFromResolved(target) }))
    .filter(({ identity }) => identity.canonicalTarget === canonicalTarget)
    .filter(({ identity }) => connectionCompatible(identity, connectionId));

  if (canonicalMatches.length === 1) {
    return {
      target: canonicalMatches[0].target,
      identity: canonicalMatches[0].identity,
      failureReason: null,
      matchMode: "canonical",
    };
  }
  if (canonicalMatches.length === 0) {
    return {
      target: null,
      identity: null,
      failureReason: "NATIVE_BASELINE_TARGET_NOT_IN_CURRENT_POOL",
      matchMode: "canonical",
    };
  }
  return {
    target: null,
    identity: null,
    failureReason: "AMBIGUOUS_BASELINE_IDENTITY",
    matchMode: "canonical",
  };
}

export function resolvePlanTargetDescriptor(targets, canonicalTarget) {
  const key = cleanString(canonicalTarget);
  if (!key) return null;
  const matches = (Array.isArray(targets) ? targets : [])
    .map((target) => ({ target, identity: targetIdentityFromResolved(target) }))
    .filter(({ identity }) => identity.canonicalTarget === key);
  if (matches.length === 0) return null;

  const connections = [
    ...new Set(matches.flatMap(({ identity }) => identity.allowedConnectionIds)),
  ];
  const directConnections = [
    ...new Set(matches.map(({ identity }) => identity.connectionId).filter(Boolean)),
  ];
  const first = matches[0].identity;
  return {
    provider: first.provider,
    model: first.model,
    target: key,
    connectionId: directConnections.length === 1 ? directConnections[0] : null,
    allowedConnectionIds: connections,
    executionKeys: matches.map(({ identity }) => identity.executionKey).filter(Boolean),
    ambiguousConnection: directConnections.length > 1,
  };
}

export function evaluatePlannedConnectionIdentity(plannedTarget, executedConnectionId) {
  const executed = cleanString(executedConnectionId);
  if (!plannedTarget) return "UNKNOWN";
  const explicit = cleanString(plannedTarget.connectionId);
  const allowed = Array.isArray(plannedTarget.allowedConnectionIds)
    ? plannedTarget.allowedConnectionIds.map(cleanString).filter(Boolean)
    : [];

  // Synthetic no-auth targets have no credential identity to prove. A missing call-log
  // connection is therefore acceptable only for this explicit noauth case.
  if (explicit === "noauth") {
    return !executed || executed === "noauth" ? "PASS" : "MISMATCH";
  }
  if (!executed) {
    return explicit || allowed.length > 0 ? "UNKNOWN" : "NOT_AVAILABLE";
  }
  if (explicit) return executed === explicit ? "PASS" : "MISMATCH";
  if (allowed.length > 0) return allowed.includes(executed) ? "PASS" : "MISMATCH";
  return "NOT_AVAILABLE";
}
