const DEFAULT_OUTPUT_CAPTURE_LIMIT = 8_192;

export function createSseState() {
  return {
    content: "",
    eventCount: 0,
    firstByteAt: null,
    firstEventAt: null,
    firstContentAt: null,
    lastEventAt: null,
    doneAt: null,
    connectionClosedAt: null,
    sawDone: false,
    sawFinishReason: false,
    readerCompleted: false,
    responseModel: null,
    usage: null,
    errorCode: null,
    parseError: null,
  };
}

export function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function nowOrProvided(now) {
  return typeof now === "function" ? now() : (now ?? performance.now());
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

export function parseSseFrame(frame, state, now) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return;

  const eventTime = nowOrProvided(now);
  state.eventCount += 1;
  state.firstEventAt ??= eventTime;
  state.lastEventAt = eventTime;
  if (data === "[DONE]") {
    state.sawDone = true;
    state.doneAt ??= eventTime;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    state.parseError = "sse_json_parse_error";
    return;
  }

  if (typeof payload?.model === "string") state.responseModel = payload.model;
  if (payload?.usage) state.usage = normalizeUsage(payload.usage);
  if (payload?.error) {
    state.errorCode =
      typeof payload.error.code === "string"
        ? payload.error.code
        : typeof payload.error.type === "string"
          ? payload.error.type
          : "provider_error";
  }

  const choice = payload?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  if (typeof content === "string") {
    if (content.length > 0) state.firstContentAt ??= eventTime;
    state.content += content;
  }
  if (choice?.finish_reason != null) state.sawFinishReason = true;
}

export function consumeSseText(buffer, text, state, now) {
  let nextBuffer = `${buffer}${text}`;
  let separator;
  while ((separator = nextBuffer.search(/\r?\n\r?\n/)) >= 0) {
    const match = nextBuffer.slice(separator).match(/^\r?\n\r?\n/);
    const separatorLength = match?.[0].length || 2;
    const frame = nextBuffer.slice(0, separator);
    nextBuffer = nextBuffer.slice(separator + separatorLength);
    parseSseFrame(frame, state, now);
  }
  return nextBuffer;
}

export function flushSseText(buffer, state, now) {
  if (buffer.trim()) parseSseFrame(buffer, state, now);
  return "";
}

function captureOutput(value, limit = DEFAULT_OUTPUT_CAPTURE_LIMIT) {
  const output = typeof value === "string" ? value : "";
  return {
    actualOutput: output.slice(0, limit),
    outputLength: output.length,
    outputTruncated: output.length > limit,
  };
}

export function evaluateQuality(input, content, options = {}) {
  const captured = captureOutput(content, options.outputCaptureLimit);
  const validator = input?.quality || "exact";
  const actual = normalizeText(content);

  if (validator === "unjudged") {
    return {
      pass: null,
      judged: false,
      validator,
      expected: input?.expected ?? null,
      reason: "validator_not_defined",
      ...captured,
    };
  }

  if (!actual) {
    return {
      pass: false,
      judged: true,
      validator,
      expected: input?.expected ?? input?.expectedJson ?? null,
      reason: "empty_reconstructed_content",
      ...captured,
    };
  }

  if (validator === "json") {
    try {
      const parsed = JSON.parse(actual);
      const expected = input?.expectedJson;
      const pass = expected
        ? JSON.stringify(parsed) === JSON.stringify(expected)
        : parsed?.status === input?.expected;
      return {
        pass,
        judged: true,
        validator,
        expected: expected ?? input?.expected ?? null,
        reason: pass ? null : "json_value_mismatch",
        ...captured,
      };
    } catch {
      return {
        pass: false,
        judged: true,
        validator,
        expected: input?.expectedJson ?? input?.expected ?? null,
        reason: "invalid_json",
        ...captured,
      };
    }
  }

  const expected = normalizeText(input?.expectedOutput ?? input?.expected);
  const pass = actual === expected;
  return {
    pass,
    judged: true,
    validator,
    expected: input?.expectedOutput ?? input?.expected ?? null,
    reason: pass ? null : "exact_value_mismatch",
    ...captured,
  };
}

export function isStreamComplete(status, state) {
  return status === 200 && state.readerCompleted && (state.sawDone || state.sawFinishReason);
}

export function compareObservedTarget(responseModel, plan) {
  if (!responseModel || !plan?.actualProvider || !plan?.actualModel) return false;
  const expectedModel = String(plan.actualModel);
  return (
    responseModel === expectedModel || responseModel === `${plan.actualProvider}/${expectedModel}`
  );
}

export function accountBenchmarkOperations(pairs, { preliminary = false } = {}) {
  const counts = {
    pairs: pairs.length,
    clientRequests: 0,
    nativeAutoRequests: 0,
    nativeDirectRequests: 0,
    governorPlanRequests: 0,
    governorDirectRequests: 0,
    preliminaryPairs: preliminary ? pairs.length : 0,
    authoritativePairs: preliminary ? 0 : pairs.length,
  };
  for (const pair of pairs) {
    if (pair.native || pair.nativeObservation) {
      counts.clientRequests += 1;
      counts.nativeAutoRequests += 1;
    }
    if (pair.governor?.planningRequest) {
      counts.clientRequests += 1;
      counts.governorPlanRequests += 1;
    }
    if (pair.nativeDirect) {
      counts.clientRequests += 1;
      counts.nativeDirectRequests += 1;
    }
    if (pair.governor?.direct) {
      counts.clientRequests += 1;
      counts.governorDirectRequests += 1;
    }
  }
  return counts;
}
