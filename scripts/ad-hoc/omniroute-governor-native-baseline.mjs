import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RESILIENCE_SETTINGS } from "../../src/lib/resilience/settings.ts";

const WORKER_PATH = fileURLToPath(
  new URL("./omniroute-governor-native-baseline-worker.mjs", import.meta.url)
);
const BASELINE_SCHEMA_VERSION = 1;

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function targetKey(target) {
  return target?.executionKey || `${target?.provider || ""}/${target?.modelStr || ""}`;
}

function stableState(pool) {
  const connectionState = Object.fromEntries(
    [...(pool.connectionState instanceof Map ? pool.connectionState.entries() : [])].sort(
      ([left], [right]) => String(left).localeCompare(String(right))
    )
  );
  return {
    targets: (pool.targets || []).map((target) => ({
      executionKey: target.executionKey,
      provider: target.provider,
      modelStr: target.modelStr,
      connectionId: target.connectionId || null,
      allowedConnectionIds: target.allowedConnectionIds || null,
    })),
    candidates: (pool.candidates || []).map((candidate) => ({
      executionKey: candidate.executionKey || null,
      provider: candidate.provider,
      model: candidate.model,
      modelStr: candidate.modelStr || null,
      connectionId: candidate.connectionId || null,
      quotaRemaining: candidate.quotaRemaining,
      quotaCutoffBlocked: candidate.quotaCutoffBlocked === true,
      circuitBreakerState: candidate.circuitBreakerState || null,
      statusPenalty: candidate.statusPenalty === true,
      reliabilityObserved: candidate.reliabilityObserved ?? null,
      errorRate: candidate.errorRate ?? null,
      failureRate: candidate.failureRate ?? null,
      p95LatencyMs: candidate.p95LatencyMs ?? null,
    })),
    connectionState,
    breakers: pool.breakers || {},
    cooldowns: pool.cooldowns || [],
    lockouts: pool.lockouts || [],
  };
}

function pickRoutingSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const keys = [
    "intentDetectionEnabled",
    "intentSimpleMaxWords",
    "intentExtraCodeKeywords",
    "intentExtraReasoningKeywords",
    "intentExtraSimpleKeywords",
    "compatFilterFailOpen",
  ];
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, jsonClone(source[key])])
  );
}

function buildRoutingConfig(pool, settings, resilienceSettings) {
  const virtualCombo = pool.virtualCombo || {};
  const autoConfig = jsonClone(
    virtualCombo.autoConfig || {
      candidatePool: [...new Set((pool.targets || []).map((target) => target.provider))],
      weights: virtualCombo.weights || null,
      explorationRate: virtualCombo.explorationRate ?? 0,
      routerStrategy: virtualCombo.routerStrategy || "rules",
    }
  );
  const comboConfig = jsonClone(virtualCombo.config || { auto: autoConfig });
  return {
    combo: {
      id: virtualCombo.id || "auto",
      name: virtualCombo.name || "auto",
      autoConfig,
      config: comboConfig,
      system_message: virtualCombo.system_message || null,
    },
    settings: pickRoutingSettings(settings),
    config: {
      complexityAwareRouting: settings?.complexityAwareRouting === true,
      compatFilterFailOpen: settings?.compatFilterFailOpen === true,
    },
    resilienceSettings: jsonClone(resilienceSettings),
  };
}

/**
 * Freeze the factual Native Auto Combo input before any execution occurs.
 * The snapshot is deliberately diagnostic data: it contains no credential or prompt material.
 */
export async function createNativeBaselineSnapshot({
  pool,
  routingSettings,
  resilienceSettings,
} = {}) {
  if (!pool || !Array.isArray(pool.targets) || !Array.isArray(pool.candidates)) {
    throw new Error("NATIVE_BASELINE_SNAPSHOT_INVALID_POOL");
  }
  const settings = routingSettings || {};
  const resolvedResilience = resilienceSettings || DEFAULT_RESILIENCE_SETTINGS;
  const state = stableState(pool);
  const routingConfig = buildRoutingConfig(pool, settings, resolvedResilience);
  const health = jsonClone((pool.metadata || []).map(({ pricing: _pricing, ...entry }) => entry));
  const capabilities = Object.fromEntries(
    health
      .filter((entry) => entry.provider && entry.model)
      .map((entry) => [`${entry.provider}/${entry.model}`, entry.capabilities || null])
  );
  const snapshotBody = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    targets: jsonClone(pool.targets),
    candidates: jsonClone(pool.candidates),
    scored: jsonClone(
      (pool.scored || []).map((entry) => ({
        target: targetKey(entry.target),
        score: entry.score,
        factors: entry.factors || null,
      }))
    ),
    health,
    capabilities,
    connections: state.connectionState,
    breakers: state.breakers,
    cooldowns: state.cooldowns,
    lockouts: state.lockouts,
    routingConfig,
    state,
  };
  const baselineSnapshotHash = createHash("sha256")
    .update(JSON.stringify(snapshotBody))
    .digest("hex");
  return {
    ...snapshotBody,
    snapshotId: `native-baseline-${baselineSnapshotHash.slice(0, 16)}`,
    baselineSnapshotHash,
    createdAt: new Date().toISOString(),
  };
}

function parseWorkerResult(stdout) {
  const marker = "NATIVE_BASELINE_RESULT:";
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error("NATIVE_BASELINE_WORKER_OUTPUT_MISSING");
  return JSON.parse(line.slice(marker.length));
}

/**
 * Resolve Native's initial target with the production Auto strategy in an isolated process.
 * No request, upstream call, home-DB write, Governor telemetry, or live router mutation occurs.
 */
export function resolveNativeBaselineWithoutExecution({ snapshot, request }) {
  if (!snapshot?.snapshotId || !snapshot?.baselineSnapshotHash) {
    throw new Error("NATIVE_BASELINE_SNAPSHOT_ID_MISSING");
  }
  const isolatedDataDir = mkdtempSync(resolve(tmpdir(), "omniroute-native-baseline-"));
  const childEnv = {
    ...process.env,
    DATA_DIR: isolatedDataDir,
    NEXT_PHASE: "phase-production-build",
    INTELLIGENCE_GOVERNOR_MODE: "off",
    INTELLIGENCE_GOVERNOR_TELEMETRY: "false",
    INTELLIGENCE_GOVERNOR_CANARY_RATE: "0",
    OMNIROUTE_SKIP_DB_HEALTHCHECK: "1",
  };
  let child;
  try {
    child = spawnSync(process.execPath, ["--import", "tsx/esm", WORKER_PATH], {
      cwd: dirname(dirname(dirname(WORKER_PATH))),
      env: childEnv,
      input: JSON.stringify({ snapshot, request }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.error) throw child.error;
    const worker = parseWorkerResult(child.stdout || "");
    const valid = child.status === 0 && worker.ok === true && worker.networkCalls === 0;
    return {
      ...worker,
      valid,
      baselineSnapshotId: snapshot.snapshotId,
      baselineSnapshotHash: snapshot.baselineSnapshotHash,
      nativeBaselineResolution: "side_effect_free",
      providerModelRequests: 0,
      routingStateMutation: false,
      networkCalls: worker.networkCalls ?? null,
      workerExitCode: child.status,
      workerStderr: child.stderr || "",
      resolverModule: "open-sse/services/combo/resolveAutoStrategy.ts",
      resolverFunction: "resolveAutoStrategyOrder",
    };
  } finally {
    rmSync(isolatedDataDir, { recursive: true, force: true });
  }
}

export function nativeBaselineStateDigest(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(snapshot?.state || null))
    .digest("hex");
}

export function nativeBaselineRequest(caseId, prompt, extra = {}) {
  return {
    caseId,
    body: {
      model: "auto/chat",
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 128,
      ...extra,
    },
  };
}

export function makeNativeBaselineTestSnapshot({ targets, candidates, ...rest } = {}) {
  const pool = {
    targets: jsonClone(targets || []),
    candidates: jsonClone(candidates || []),
    scored: rest.scored || [],
    metadata: rest.metadata || [],
    connectionState: rest.connectionState || new Map(),
    breakers: rest.breakers || {},
    cooldowns: rest.cooldowns || [],
    lockouts: rest.lockouts || [],
    virtualCombo: rest.virtualCombo || {
      id: "auto",
      name: "auto",
      autoConfig: {
        candidatePool: [...new Set((targets || []).map((target) => target.provider))],
        weights: undefined,
        explorationRate: 0,
        routerStrategy: "rules",
      },
      config: {},
      models: targets || [],
    },
  };
  return createNativeBaselineSnapshot({ pool, routingSettings: rest.routingSettings || {} });
}
