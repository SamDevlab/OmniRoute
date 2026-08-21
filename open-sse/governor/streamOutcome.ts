export type GovernorStreamOutcome =
  "SUCCESS" | "UPSTREAM_401" | "UPSTREAM_429" | "UPSTREAM_5XX" | "CLIENT_ABORT" | "STREAM_ERROR";

export function classifyGovernorStreamOutcome(
  status: number,
  error?: string,
  errorCode?: string
): GovernorStreamOutcome | undefined {
  const signal = `${errorCode ?? ""} ${error ?? ""}`;
  if (status === 401 || /(?:^|\D)401(?:\D|$)/.test(signal)) return "UPSTREAM_401";
  if (status === 429 || /(?:^|\D)429(?:\D|$)/.test(signal)) return "UPSTREAM_429";
  if (status >= 500 || /(?:^|\D)5\d{2}(?:\D|$)/.test(signal)) return "UPSTREAM_5XX";
  if (status === 499 || errorCode === "client_disconnected") return "CLIENT_ABORT";
  if (error || errorCode) return "STREAM_ERROR";
  if (status === 200) return "SUCCESS";
  return undefined;
}

export function elapsedMilliseconds(start: number, end: number): number {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}
