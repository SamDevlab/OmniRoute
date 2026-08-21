/**
 * Wrap a single-model dispatch with a per-target timeout that aborts and falls back.
 *
 * Extracted from handleComboChat's `handleSingleModelWithTimeout` closure (combo.ts).
 * A locally expired timer aborts that target and returns a typed 504 response so the Combo
 * can fall back without treating OmniRoute's own deadline as a provider-connection failure.
 * The per-model abort signal still comes from the target (`target.modelAbortSignal`), so
 * the outer request signal is intentionally NOT a dependency here.
 *
 * See _tasks/superpowers/plans/2026-07-03-blocoJ-combo-hotpath-decomposition.md (Task 1).
 */
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../../utils/error.ts";
import type { HandleSingleModel, SingleModelTarget, ComboLogger } from "./types.ts";

/** Stable internal classification for OmniRoute's own combo per-target timer. */
export const COMBO_TARGET_TIMEOUT_CODE = "combo_target_timeout";

/** Stable internal classification for the combo-wide fallback deadline. */
export const COMBO_GLOBAL_TIMEOUT_CODE = "combo_global_timeout";

/** Stable internal classification for a hedge loser cancelled by its parent. */
export const COMBO_HEDGE_CANCELLED_CODE = "combo_hedge_cancelled";

/** Header used by the combo loop to recognize its own synthetic timeout response. */
export const COMBO_TIMEOUT_HEADER = "x-omniroute-combo-timeout";

function buildHedgeCancelledResponse(modelStr: string): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(
        499,
        sanitizeErrorMessage(`Combo hedge cancelled for ${modelStr}`),
        undefined,
        {
          type: COMBO_HEDGE_CANCELLED_CODE,
          code: COMBO_HEDGE_CANCELLED_CODE,
        }
      )
    ),
    {
      status: 499,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function buildGovernorAttemptBody(
  body: Record<string, unknown>,
  target?: SingleModelTarget
): Record<string, unknown> {
  if (!target || !("governorSelected" in target) || target.governorSelected !== true) return body;
  const overrides = target.governorRequestOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return body;
  const attemptBody = typeof structuredClone === "function" ? structuredClone(body) : { ...body };
  return Object.assign(attemptBody, overrides);
}

export function buildTargetTimeoutRunner(deps: {
  handleSingleModel: HandleSingleModel;
  comboTargetTimeoutMs: number;
  log: ComboLogger;
  /** Absolute deadline for the current combo's fallback budget, when configured. */
  globalDeadlineAtMs?: number | null;
  /** Internal code to use when the global deadline, rather than the target timer, wins. */
  globalTimeoutCode?: string;
}): (
  b: Record<string, unknown>,
  modelStr: string,
  target?: SingleModelTarget
) => Promise<Response> {
  const {
    handleSingleModel,
    comboTargetTimeoutMs,
    log,
    globalDeadlineAtMs = null,
    globalTimeoutCode = COMBO_GLOBAL_TIMEOUT_CODE,
  } = deps;
  return async (
    b: Record<string, unknown>,
    modelStr: string,
    target?: SingleModelTarget
  ): Promise<Response> => {
    const attemptBody = buildGovernorAttemptBody(b, target);

    const globalRemainingMs = globalDeadlineAtMs === null ? null : globalDeadlineAtMs - Date.now();
    const globalDeadlineActive = globalRemainingMs !== null;
    const effectiveTimeoutMs = globalDeadlineActive
      ? Math.min(
          comboTargetTimeoutMs > 0 ? comboTargetTimeoutMs : Number.POSITIVE_INFINITY,
          Math.max(0, globalRemainingMs)
        )
      : comboTargetTimeoutMs;
    const timeoutCode =
      globalDeadlineActive &&
      (comboTargetTimeoutMs <= 0 || globalRemainingMs <= comboTargetTimeoutMs)
        ? globalTimeoutCode
        : COMBO_TARGET_TIMEOUT_CODE;

    if (globalDeadlineActive && effectiveTimeoutMs <= 0) {
      return new Response(
        JSON.stringify(
          buildErrorBody(
            504,
            sanitizeErrorMessage(`Combo global timeout for ${modelStr}`),
            undefined,
            {
              type: timeoutCode,
              code: timeoutCode,
            }
          )
        ),
        {
          status: 504,
          headers: {
            "Content-Type": "application/json",
            [COMBO_TIMEOUT_HEADER]: timeoutCode,
          },
        }
      );
    }

    if (!globalDeadlineActive && comboTargetTimeoutMs <= 0) {
      return handleSingleModel(attemptBody, modelStr, target).catch((err) =>
        errorResponse(502, err?.message ?? "Upstream model error")
      );
    }

    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let hedgeCancelled = false;
    let resolveHedgeCancellation: ((response: Response) => void) | null = null;
    const parentHedgeSignal = target?.modelAbortSignal ?? null;
    const hedgeCancellationPromise = parentHedgeSignal
      ? new Promise<Response>((resolve) => {
          resolveHedgeCancellation = resolve;
        })
      : null;
    const cancelForHedge = () => {
      if (hedgeCancelled) return;
      hedgeCancelled = true;
      timeoutController.abort(new Error("hedge-cancelled"));
      resolveHedgeCancellation?.(buildHedgeCancelledResponse(modelStr));
    };
    const timeoutPromise = new Promise<Response>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        const isGlobalTimeout = timeoutCode === globalTimeoutCode;
        log.warn(
          "COMBO",
          isGlobalTimeout
            ? `Combo global timeout reached for ${modelStr} after ${effectiveTimeoutMs}ms — stopping fallback`
            : `Model ${modelStr} exceeded ${effectiveTimeoutMs}ms timeout — falling back`
        );
        timeoutController.abort(
          new Error(isGlobalTimeout ? "combo-global-timeout" : "combo-per-model-timeout")
        );
        // HTTP 504 (not proprietary 524): this is OmniRoute's own target/global timer.
        // Typed as a request-scoped combo timeout so health classification keeps the
        // connection eligible instead of treating it like a genuine upstream failure.
        resolve(
          new Response(
            JSON.stringify(
              buildErrorBody(
                504,
                sanitizeErrorMessage(
                  isGlobalTimeout
                    ? `Combo global timeout for ${modelStr}`
                    : `Model ${modelStr} timed out`
                ),
                undefined,
                {
                  type: timeoutCode,
                  code: timeoutCode,
                }
              )
            ),
            {
              status: 504,
              headers: {
                "Content-Type": "application/json",
                [COMBO_TIMEOUT_HEADER]: timeoutCode,
              },
            }
          )
        );
      }, effectiveTimeoutMs);
    });
    const targetWithSignal = {
      ...(target ?? {}),
      modelAbortSignal: timeoutController.signal,
    };
    let onParentHedgeAbort: (() => void) | null = null;
    if (parentHedgeSignal) {
      if (parentHedgeSignal.aborted) {
        cancelForHedge();
      } else {
        onParentHedgeAbort = () => {
          cancelForHedge();
        };
        parentHedgeSignal.addEventListener("abort", onParentHedgeAbort, { once: true });
      }
    }
    try {
      const childPromise = handleSingleModel(attemptBody, modelStr, targetWithSignal)
        .then((response) => (hedgeCancelled ? buildHedgeCancelledResponse(modelStr) : response))
        .catch((err) => {
          if (timedOut) {
            // Inner call rejected because we aborted it. The synthetic 504 from
            // timeoutPromise already wins the race; return an empty response so
            // the loser branch resolves cleanly without leaking err.message.
            return new Response(null, { status: 599 });
          }
          if (hedgeCancelled) return buildHedgeCancelledResponse(modelStr);
          return errorResponse(502, err?.message ?? "Upstream model error");
        });
      const races: Array<Promise<Response>> = [childPromise, timeoutPromise];
      if (hedgeCancellationPromise) races.push(hedgeCancellationPromise);
      return await Promise.race(races);
    } finally {
      clearTimeout(timeoutId);
      if (parentHedgeSignal && onParentHedgeAbort) {
        parentHedgeSignal.removeEventListener("abort", onParentHedgeAbort);
      }
    }
  };
}
