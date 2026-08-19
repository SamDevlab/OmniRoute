import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1;

const DEFAULT_ARTIFACT_DIRECTORY = fileURLToPath(
  new URL("../../docs/diagnostics/governor-e2e-artifacts/", import.meta.url)
);

function timestampForFilename(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function benchmarkJsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return value;
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
    `omniroute-governor-e2e-${timestampForFilename(now)}-${pid}.json`
  );
}

export function serializeBenchmarkArtifact(artifact) {
  return `${JSON.stringify(artifact, benchmarkJsonReplacer, 2)}\n`;
}

export function buildBenchmarkArtifact(result, { kind = "authoritative", now = new Date() } = {}) {
  return {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    persistedAt: now.toISOString(),
    kind,
    result,
  };
}

/**
 * Persist a complete benchmark result without relying on terminal capture.
 * The temporary file is created beside the destination and renamed into place
 * so a process interruption cannot leave a partially written JSON artifact.
 */
export function persistBenchmarkArtifact(
  result,
  { kind = "authoritative", now = new Date(), outputPath, pid = process.pid } = {}
) {
  const artifact = buildBenchmarkArtifact(result, { kind, now });
  const destination = resolveBenchmarkArtifactPath({ outputPath, now, pid });
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${pid}`;
  writeFileSync(temporary, serializeBenchmarkArtifact(artifact), {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    renameSync(temporary, destination);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return destination;
}
