import type { CompressionMode, ModelTier } from "./types.ts";
import type { CounterfactualCandidate } from "./counterfactual.ts";

/** Normalizes factual OmniRoute model/provider metadata without maintaining a second catalog. */
export interface OmniRouteModelMetadata {
  provider: string;
  model: string;
  routingModelId?: string | null;
  tier?: ModelTier | null;
  contextWindow?: number | null;
  capabilities?: string[];
  inputPrice?: number | null;
  outputPrice?: number | null;
  available?: boolean;
  quotaState?: "normal" | "warning" | "exhausted" | "unknown";
  supportsReasoning?: boolean | null;
  supportsCompression?: CompressionMode[] | null;
  healthScore?: number | null;
}
export function buildCounterfactualCandidates(
  metadata: OmniRouteModelMetadata[]
): CounterfactualCandidate[] {
  return metadata.map((item) => ({
    provider: item.provider,
    model: item.model,
    routingModelId: item.routingModelId ?? `${item.provider}/${item.model}`,
    tier: item.tier ?? "preserve",
    contextWindow: item.contextWindow ?? undefined,
    capabilities: item.capabilities ?? [],
    inputPrice: item.inputPrice ?? undefined,
    outputPrice: item.outputPrice ?? undefined,
    available: item.available === true && item.quotaState !== "exhausted",
    quotaState: item.quotaState ?? "unknown",
    supportsReasoning: item.supportsReasoning ?? undefined,
    supportsCompression: item.supportsCompression ?? undefined,
    healthScore: item.healthScore ?? undefined,
  }));
}
