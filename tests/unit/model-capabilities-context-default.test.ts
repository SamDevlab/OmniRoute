import assert from "node:assert/strict";
import test from "node:test";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import {
  removeModelContextOverride,
  setModelContextOverride,
} from "../../src/lib/db/modelContextOverrides.ts";

test("model-specific registry context wins over provider default", () => {
  assert.equal(
    getResolvedModelCapabilities({ provider: "anthropic", model: "claude-fable-5" }).contextWindow,
    1048576
  );
});

test("models without a specific context inherit the provider default", () => {
  assert.equal(
    getResolvedModelCapabilities({ provider: "opencode", model: "big-pickle" }).contextWindow,
    200000
  );
  assert.equal(
    getResolvedModelCapabilities({ provider: "opencode-zen", model: "big-pickle" }).contextWindow,
    200000
  );
  assert.equal(
    getResolvedModelCapabilities({ provider: "oc", model: "big-pickle" }).contextWindow,
    200000
  );
});

test("provider without a default remains unknown without another source", () => {
  assert.equal(
    getResolvedModelCapabilities({ provider: "unknown-provider", model: "unknown-model" })
      .contextWindow,
    null
  );
});

test("persisted context override wins over provider default", () => {
  assert.equal(setModelContextOverride("opencode-zen", "big-pickle", 777000), true);
  try {
    assert.equal(
      getResolvedModelCapabilities({ provider: "opencode", model: "big-pickle" }).contextWindow,
      777000
    );
  } finally {
    removeModelContextOverride("opencode-zen", "big-pickle");
  }
});
