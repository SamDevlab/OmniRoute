import type { CounterfactualExecutionPlan } from "./counterfactual.ts";
import {
  assessActiveCanary,
  applyGovernorPlan,
  type GovernorMutableRequest,
} from "./activeCanary.ts";

export interface ActiveV1Config {
  enabled: boolean;
  controlModel: boolean;
  controlProvider: boolean;
  controlReasoning: boolean;
  controlCompression: boolean;
  controlOutput: boolean;
}
export function applyActiveGovernorPlan(
  request: GovernorMutableRequest,
  plan: CounterfactualExecutionPlan,
  correlationId: string,
  config: ActiveV1Config
): { applied: boolean; reason: string; original: GovernorMutableRequest } {
  const original = { ...request };
  if (!config.enabled) return { applied: false, reason: "kill_switch", original };
  const eligibility = assessActiveCanary(plan, correlationId, { enabled: true, rate: 1 });
  if (!eligibility.eligible) return { applied: false, reason: eligibility.reason, original };
  const controlled = {
    ...plan,
    selectedModel: config.controlModel ? plan.selectedModel : null,
    selectedProvider: config.controlProvider ? plan.selectedProvider : null,
    maxOutputTokens: config.controlOutput ? plan.maxOutputTokens : null,
    reasoningEffort: config.controlReasoning ? plan.reasoningEffort : "preserve",
    compressionMode: config.controlCompression ? plan.compressionMode : "preserve",
  };
  applyGovernorPlan(request, controlled);
  return { applied: true, reason: "active_applied", original };
}
