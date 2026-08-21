export type GovernorProfile = "economy" | "balanced" | "quality";
export interface CalibrationObservation {
  success: boolean | null;
  currentCost: number | null;
  counterfactualCost: number | null;
  confidence: string;
  fallback: boolean | null;
}
export interface PolicyCalibrationReport {
  policyVersion: string;
  evidence: "OBSERVED" | "DIRECTIONAL" | "INSUFFICIENT_DATA";
  sampleSize: number;
  profiles: Record<GovernorProfile, { costWeight: number; confidenceMinimum: string }>;
  suggestedProfile: GovernorProfile;
}
export const GOVERNOR_PROFILES: Record<
  GovernorProfile,
  { costWeight: number; confidenceMinimum: string }
> = {
  economy: { costWeight: 1, confidenceMinimum: "HIGH" },
  balanced: { costWeight: 0.5, confidenceMinimum: "HIGH" },
  quality: { costWeight: 0.1, confidenceMinimum: "HIGH" },
};
export function calibratePolicy(observations: CalibrationObservation[]): PolicyCalibrationReport {
  const complete = observations.filter(
    (o) => o.success != null && o.currentCost != null && o.counterfactualCost != null
  );
  const evidence =
    complete.length >= 30 ? "OBSERVED" : complete.length >= 5 ? "DIRECTIONAL" : "INSUFFICIENT_DATA";
  return {
    policyVersion: "v1",
    evidence,
    sampleSize: complete.length,
    profiles: GOVERNOR_PROFILES,
    suggestedProfile: "balanced",
  };
}
