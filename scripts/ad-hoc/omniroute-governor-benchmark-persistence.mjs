import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1;
export const RUN_ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_PERSISTED_OUTPUT_BYTES = 4_096;
export const OPERATION_TYPES = Object.freeze([
  "native_preflight",
  "native_arm",
  "governor_plan",
  "governor_arm",
  "pair_complete",
]);

const DEFAULT_ARTIFACT_DIRECTORY = fileURLToPath(
  new URL("../../docs/diagnostics/governor-e2e-artifacts/", import.meta.url)
);
const SENSITIVE_KEYS = new Set([
  "access_token",
  "accessToken",
  "api_key",
  "apiKey",
  "authorization",
  "body",
  "content",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "env",
  "headers",
  "message",
  "messages",
  "password",
  "prompt",
  "promptText",
  "rawPrompt",
  "rawPromptText",
  "refresh_token",
  "refreshToken",
  "requestBody",
  "response",
  "responseBody",
  "secret",
  "serverEnv",
  "stack",
  "token",
  "toolOutputBody",
]);

function timestampForFilename(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function timestampForRunId(now) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function randomSuffix() {
  return randomBytes(4).toString("hex");
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function writeAll(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
}

function fsyncDirectory(directory) {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows and some filesystems do not permit opening directories.
  }
}

function writeJsonAtomically(destination, value) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = destination + ".tmp-" + process.pid + "-" + randomSuffix();
  const serialized = JSON.stringify(value, benchmarkJsonReplacer, 2) + "\n";
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeAll(fd, serialized);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    fsyncDirectory(dirname(destination));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename error.
    }
    throw error;
  }
  return destination;
}

function appendJsonLine(path, value) {
  const fd = openSync(path, "a", 0o600);
  try {
    writeAll(fd, JSON.stringify(value, benchmarkJsonReplacer) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function boundedUtf8(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_PERSISTED_OUTPUT_BYTES) {
    return { value: text, bytes, truncated: false };
  }
  return {
    value: Buffer.from(text, "utf8").subarray(0, MAX_PERSISTED_OUTPUT_BYTES).toString("utf8"),
    bytes,
    truncated: true,
  };
}

function cloneForPersistence(value, { allowSyntheticPrompt = false, key = "" } = {}) {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([entryKey, entryValue]) => [
        entryKey,
        cloneForPersistence(entryValue, { allowSyntheticPrompt }),
      ])
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneForPersistence(item, { allowSyntheticPrompt }));
  }
  if (typeof value === "string") {
    return key === "actualOutput" || key === "outputPreview" ? boundedUtf8(value).value : value;
  }
  if (!value || typeof value !== "object") return value;

  const output = {};
  let outputWasTruncated = false;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const keepSyntheticPrompt = allowSyntheticPrompt && entryKey === "prompt";
    if (SENSITIVE_KEYS.has(entryKey) && !keepSyntheticPrompt) continue;
    if (entryKey === "actualOutput" || entryKey === "outputPreview") {
      const bounded = boundedUtf8(entryValue);
      output[entryKey] = bounded.value;
      outputWasTruncated ||= bounded.truncated;
      continue;
    }
    output[entryKey] = cloneForPersistence(entryValue, {
      allowSyntheticPrompt,
      key: entryKey,
    });
  }
  if (outputWasTruncated) output.outputTruncated = true;
  return output;
}

function benchmarkJsonReplacer(_key, value) {
  return value instanceof Map ? Object.fromEntries(value.entries()) : value;
}

function resolveRepositoryValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function resolveRepositoryIdentity() {
  return {
    gitHead:
      process.env.OMNIROUTE_GOVERNOR_GIT_HEAD ||
      process.env.GITHUB_SHA ||
      resolveRepositoryValue(["rev-parse", "HEAD"]),
    branch:
      process.env.OMNIROUTE_GOVERNOR_BRANCH ||
      process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF_NAME ||
      resolveRepositoryValue(["branch", "--show-current"]),
  };
}

export function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value, benchmarkJsonReplacer)).digest("hex");
}

export function createBenchmarkRunId(now = new Date(), suffix = randomSuffix()) {
  return timestampForRunId(toDate(now)) + "-" + suffix;
}

export function resolveBenchmarkArtifactPath({
  outputPath,
  now = new Date(),
  pid = process.pid,
} = {}) {
  const configuredPath = outputPath || process.env.OMNIROUTE_GOVERNOR_E2E_OUTPUT;
  if (configuredPath) return resolve(configuredPath);
  return resolve(
    DEFAULT_ARTIFACT_DIRECTORY,
    "omniroute-governor-e2e-" + timestampForFilename(toDate(now)) + "-" + pid + ".json"
  );
}

export function serializeBenchmarkArtifact(artifact) {
  return JSON.stringify(artifact, benchmarkJsonReplacer, 2) + "\n";
}

export function buildBenchmarkArtifact(result, { kind = "authoritative", now = new Date() } = {}) {
  const syntheticWorkload = result?.syntheticWorkload === true;
  return {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    persistedAt: toDate(now).toISOString(),
    kind,
    result: cloneForPersistence(result, { allowSyntheticPrompt: syntheticWorkload }),
  };
}

export function persistBenchmarkArtifact(
  result,
  { kind = "authoritative", now = new Date(), outputPath, pid = process.pid } = {}
) {
  const artifact = buildBenchmarkArtifact(result, { kind, now });
  const destination = resolveBenchmarkArtifactPath({ outputPath, now, pid });
  return writeJsonAtomically(destination, artifact);
}

export function resolveRunDirectory(runDirectoryOrId, { rootDirectory } = {}) {
  const configuredRoot =
    rootDirectory || process.env.OMNIROUTE_GOVERNOR_E2E_ARTIFACT_ROOT || DEFAULT_ARTIFACT_DIRECTORY;
  const candidate = String(runDirectoryOrId || "");
  if (!candidate) throw new Error("A benchmark run directory or runId is required");
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : candidate.includes(sep) || candidate.includes("/")
      ? resolve(candidate)
      : resolve(configuredRoot, candidate);
  if (statSync(resolvedCandidate).isFile()) return dirname(resolvedCandidate);
  return resolvedCandidate;
}

function buildManifest(options, now, runId) {
  const repository = resolveRepositoryIdentity();
  return cloneForPersistence({
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    runId,
    status: "RUNNING",
    startedAt: now.toISOString(),
    gitHead: options.gitHead ?? repository.gitHead,
    branch: options.branch ?? repository.branch,
    governorMode: options.governorMode ?? "simulate",
    governorActive: options.governorActive === true,
    canaryRate: Number.isFinite(options.canaryRate) ? options.canaryRate : 0,
    effectiveGovernorMode: options.effectiveGovernorMode ?? null,
    governorModeMatch: options.governorModeMatch ?? null,
    configurationFailure: options.configurationFailure ?? null,
    requestedPairs: Number.isInteger(options.requestedPairs) ? options.requestedPairs : 0,
    authoritative: options.authoritative === true,
    syntheticWorkload: options.syntheticWorkload !== false,
    workloadHash: options.workloadHash ?? null,
    validatorHash: options.validatorHash ?? null,
    runtimeBaseUrl: options.runtimeBaseUrl ?? null,
    poolSnapshot: options.poolSnapshot ?? null,
    summaryPath: null,
    finalSnapshotPath: null,
    operationCount: 0,
  });
}

function makeOperationId(runId) {
  return runId + "-op-" + randomUUID();
}

export function sanitizeOperationRecord(operation) {
  const operationType = operation?.operationType;
  if (!OPERATION_TYPES.includes(operationType)) {
    throw new Error("Unsupported benchmark operation type: " + String(operationType));
  }
  const record = cloneForPersistence({
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    ...operation,
  });
  delete record.actualOutput;
  delete record.output;
  return record;
}

export class BenchmarkRun {
  constructor({ runDirectory, manifest }) {
    this.runDirectory = runDirectory;
    this.manifestPath = resolve(runDirectory, "manifest.json");
    this.operationsPath = resolve(runDirectory, "operations.jsonl");
    this.summaryPath = resolve(runDirectory, "summary.json");
    this.finalSnapshotPath = resolve(runDirectory, "final-snapshot.json");
    this.manifest = manifest;
    this.operationCount = 0;
  }

  appendOperation(operation) {
    const record = sanitizeOperationRecord({
      ...operation,
      operationId: operation.operationId || makeOperationId(this.manifest.runId),
      runId: this.manifest.runId,
    });
    appendJsonLine(this.operationsPath, record);
    this.operationCount += 1;
    return record.operationId;
  }

  updateManifest(patch) {
    this.manifest = {
      ...this.manifest,
      ...patch,
      operationCount: this.operationCount,
    };
    writeJsonAtomically(this.manifestPath, this.manifest);
    return this.manifest;
  }

  markAborted(signal) {
    return this.updateManifest({
      status: "ABORTED",
      completedAt: new Date().toISOString(),
      abortSignal: signal,
      summaryPath: null,
      finalSnapshotPath: null,
    });
  }

  finalize({ status = "COMPLETE", finalSnapshotPath = this.finalSnapshotPath } = {}) {
    const summary = summarizeBenchmarkRun(this.runDirectory, { statusOverride: status });
    const completedAt = new Date().toISOString();
    writeJsonAtomically(this.summaryPath, {
      ...summary,
      completedAt,
      finalSnapshotPath: finalSnapshotPath ? "final-snapshot.json" : null,
    });
    this.updateManifest({
      status,
      completedAt,
      summaryPath: "summary.json",
      finalSnapshotPath: finalSnapshotPath ? "final-snapshot.json" : null,
    });
    return summary;
  }
}

export function createBenchmarkRun(options = {}) {
  const now = toDate(options.now);
  const rootDirectory = resolve(
    options.rootDirectory ||
      process.env.OMNIROUTE_GOVERNOR_E2E_ARTIFACT_ROOT ||
      DEFAULT_ARTIFACT_DIRECTORY
  );
  mkdirSync(rootDirectory, { recursive: true });
  let runId = options.runId || createBenchmarkRunId(now);
  let runDirectory = resolve(rootDirectory, runId);
  while (existsSync(runDirectory)) {
    runId = createBenchmarkRunId(now);
    runDirectory = resolve(rootDirectory, runId);
  }
  mkdirSync(runDirectory);
  const manifest = buildManifest(options, now, runId);
  writeJsonAtomically(resolve(runDirectory, "manifest.json"), manifest);
  const operationsPath = resolve(runDirectory, "operations.jsonl");
  const fd = openSync(operationsPath, "a", 0o600);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return new BenchmarkRun({ runDirectory, manifest });
}

function parseOperations(runDirectory) {
  const operationsPath = resolve(runDirectory, "operations.jsonl");
  if (!existsSync(operationsPath)) return { operations: [], warnings: [] };
  const operations = [];
  const warnings = [];
  const lines = readFileSync(operationsPath, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const operation = JSON.parse(line);
      if (!OPERATION_TYPES.includes(operation.operationType)) {
        warnings.push({
          code: "MALFORMED_OPERATION_RECORD",
          line: index + 1,
          reason: "unsupported_operation_type",
        });
        return;
      }
      operations.push(operation);
    } catch {
      warnings.push({
        code: "MALFORMED_OPERATION_RECORD",
        line: index + 1,
        reason: "invalid_json",
      });
    }
  });
  return { operations, warnings };
}

function finiteValues(records, field) {
  return records.map((record) => record[field]).filter(Number.isFinite);
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
    : null;
}

function timingAggregate(values) {
  const finite = values.filter(Number.isFinite);
  return {
    mean: finite.length
      ? Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * 100) / 100
      : null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length ? Math.max(...finite) : null,
  };
}

function armAggregate(records) {
  const attempts = finiteValues(records, "attempts");
  return {
    requests: records.length,
    http: records.filter((record) => record.httpStatus === 200).length,
    streams: records.filter((record) => record.streamCompleted === true).length,
    quality: records.filter((record) => record.qualityPass === true).length,
    headers: timingAggregate(finiteValues(records, "headersMs")),
    ttft: timingAggregate(finiteValues(records, "firstContentMs")),
    completion: timingAggregate(finiteValues(records, "completionMs")),
    e2e: timingAggregate(finiteValues(records, "totalE2EMs")),
    attemptsMean: timingAggregate(attempts).mean,
    attemptsMax: attempts.length ? Math.max(...attempts) : null,
    fallbackCount: finiteValues(records, "fallbackCount").reduce((sum, value) => sum + value, 0),
  };
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

export function deriveFivePairGate(pairs, { requestedPairs = null, artifactWarnings = [] } = {}) {
  const firstFive = Array.isArray(pairs) ? pairs.slice(0, 5) : [];
  const pairsStarted = new Set(firstFive.map((pair) => pair.pairId).filter(Boolean)).size;
  const failureClasses = [...new Set(firstFive.map((pair) => pair.failureClass).filter(Boolean))];
  const qualityPass = firstFive.every(
    (pair) => pair.nativeQualityPass === true && pair.governorQualityPass === true
  );
  const artifactIntegrity = artifactWarnings.length === 0;
  const benchmarkInvalid = firstFive.some(
    (pair) =>
      ["HARNESS_FAILURE", "TARGET_MISMATCH", "ARTIFACT_CORRUPTION", "METHODOLOGY_FAILURE"].includes(
        pair.failureClass
      ) || pair.stopBenchmark === true
  );
  const pass =
    firstFive.length === 5 &&
    firstFive.every(
      (pair) =>
        pair.valid === true &&
        pair.nativeHttp === 200 &&
        pair.governorHttp === 200 &&
        pair.nativeStreamCompleted === true &&
        pair.governorStreamCompleted === true &&
        pair.governorPlanExecutable === true &&
        pair.governorTargetIdentity === "PASS" &&
        pair.nativeQualityPass === true &&
        pair.governorQualityPass === true
    ) &&
    artifactIntegrity;
  return {
    pass,
    pairsRequested: requestedPairs,
    pairsStarted,
    pairsCompleted: firstFive.length,
    pairsValid: firstFive.filter((pair) => pair.valid === true).length,
    pairs: firstFive.length,
    invalid: firstFive.filter((pair) => pair.valid !== true).length,
    nativeHttp: firstFive.filter((pair) => pair.nativeHttp === 200).length,
    governorHttp: firstFive.filter((pair) => pair.governorHttp === 200).length,
    nativeStreams: firstFive.filter((pair) => pair.nativeStreamCompleted === true).length,
    governorStreams: firstFive.filter((pair) => pair.governorStreamCompleted === true).length,
    governorPlans: firstFive.filter((pair) => pair.governorPlanOperationId).length,
    governorExecutable: firstFive.filter((pair) => pair.governorPlanExecutable === true).length,
    nativeQuality: firstFive.filter((pair) => pair.nativeQualityPass === true).length,
    governorQuality: firstFive.filter((pair) => pair.governorQualityPass === true).length,
    quality: qualityPass ? "PASS" : "FAIL",
    identity: firstFive.every((pair) => pair.governorTargetIdentity === "PASS") ? "PASS" : "FAIL",
    accounting: firstFive.every(
      (pair) =>
        pair.nativeOperationId && pair.governorPlanOperationId && pair.governorArmOperationId
    )
      ? "PASS"
      : "FAIL",
    artifactIntegrity: artifactIntegrity ? "PASS" : "FAIL",
    benchmarkInvalid,
    failureClasses,
  };
}

function classifyRunStatus(manifest, warnings, statusOverride) {
  if (statusOverride) {
    return warnings.length && statusOverride === "COMPLETE" ? "INCOMPLETE_RUN" : statusOverride;
  }
  if (manifest.status === "ABORTED") return "ABORTED";
  if (warnings.length) return "INCOMPLETE_RUN";
  if (manifest.status === "COMPLETE" || manifest.status === "FAILED") return manifest.status;
  return "INCOMPLETE_RUN";
}

export function summarizeBenchmarkRun(runDirectoryOrId, { statusOverride } = {}) {
  const runDirectory = resolveRunDirectory(runDirectoryOrId);
  const manifest = JSON.parse(readFileSync(resolve(runDirectory, "manifest.json"), "utf8"));
  const { operations, warnings } = parseOperations(runDirectory);
  const pairs = operations.filter((operation) => operation.operationType === "pair_complete");
  const pairIds = new Set(operations.map((operation) => operation.pairId).filter(Boolean));
  const nativeArms = operations.filter((operation) => operation.operationType === "native_arm");
  const governorPlans = operations.filter(
    (operation) => operation.operationType === "governor_plan"
  );
  const governorArms = operations.filter((operation) => operation.operationType === "governor_arm");
  const status = classifyRunStatus(manifest, warnings, statusOverride);
  const pairsCompleted = pairs.length;
  const native = armAggregate(nativeArms);
  const governor = armAggregate(governorArms);
  governor.plans = governorPlans.length;
  governor.executable = governorPlans.filter((operation) => operation.executable === true).length;
  const planningValues = finiteValues(governorPlans, "planningMs");
  const planningShares = finiteValues(governorArms, "planningShare");
  const preflightCount = operations.filter(
    (operation) => operation.operationType === "native_preflight"
  ).length;
  const pairwise = {
    governorWins: pairs.filter((pair) => pair.winner === "governor").length,
    nativeWins: pairs.filter((pair) => pair.winner === "native").length,
    ties: pairs.filter((pair) => pair.winner === "tie").length,
    invalid: pairs.filter((pair) => pair.valid !== true).length,
    governorQualityWins: pairs.filter((pair) => pair.qualityWinner === "governor").length,
    nativeQualityWins: pairs.filter((pair) => pair.qualityWinner === "native").length,
    governorLatencyWins: pairs.filter((pair) => pair.latencyWinner === "governor").length,
    nativeLatencyWins: pairs.filter((pair) => pair.latencyWinner === "native").length,
    agreement: pairs.filter((pair) => pair.agreement === true).length,
    disagreement: pairs.filter((pair) => pair.agreement === false).length,
  };
  const accounting = {
    pairs: pairsCompleted,
    pairsAttempted: manifest.requestedPairs,
    pairsStarted: pairIds.size,
    nativePreflightRequests: preflightCount,
    nativeRequests: nativeArms.length,
    governorPlanningOperations: governorPlans.length,
    governorExecutionRequests: governorArms.length,
    physicalAuthoritativeRequests: nativeArms.length + governorArms.length,
    physicalRequestsIncludingPreflight: nativeArms.length + governorArms.length + preflightCount,
  };
  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    runId: manifest.runId,
    status,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt || null,
    pairsAttempted: manifest.requestedPairs,
    pairsStarted: pairIds.size,
    pairsCompleted,
    completedPairs: pairsCompleted,
    pairsValid: pairs.filter((pair) => pair.valid === true).length,
    operationsCount: operations.length,
    validOperations: operations.length,
    warnings,
    fivePairGate: deriveFivePairGate(pairs, {
      requestedPairs: manifest.requestedPairs,
      artifactWarnings: warnings,
    }),
    native,
    governor,
    pairwise,
    agreement: pairwise.agreement,
    disagreement: pairwise.disagreement,
    accounting,
    configurationFailure: manifest.configurationFailure || null,
    effectiveGovernorMode: manifest.effectiveGovernorMode || null,
    governorModeMatch: manifest.governorModeMatch ?? null,
    failureClasses: uniqueValues(operations.map((operation) => operation.failureClass)),
    quality: {
      native: native.quality,
      governor: governor.quality,
      nativeTotal: nativeArms.length,
      governorTotal: governorArms.length,
    },
    headers: { native: native.headers, governor: governor.headers },
    ttft: { native: native.ttft, governor: governor.ttft },
    completion: { native: native.completion, governor: governor.completion },
    e2e: { native: native.e2e, governor: governor.e2e },
    planning: timingAggregate(planningValues),
    planningShare: timingAggregate(planningShares),
    targetDistribution: {
      native: Object.groupBy(
        nativeArms.map((record) => record.executedTarget).filter(Boolean),
        (value) => value
      ),
      governor: Object.groupBy(
        governorArms.map((record) => record.plannedTarget).filter(Boolean),
        (value) => value
      ),
    },
  };
}
