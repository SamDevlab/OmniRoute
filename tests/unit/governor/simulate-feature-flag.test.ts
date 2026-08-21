import test from "node:test";
import assert from "node:assert/strict";

test("simulate mode is canonical and invalid values fail closed", async () => {
  const flags = await import("../../../src/shared/utils/featureFlags.ts");
  const original = process.env.INTELLIGENCE_GOVERNOR_MODE;
  process.env.INTELLIGENCE_GOVERNOR_MODE = "simulate";
  assert.equal(flags.getGovernorMode(), "simulate");
  process.env.INTELLIGENCE_GOVERNOR_MODE = "garbage";
  assert.equal(flags.getGovernorMode(), "off");
  if (original === undefined) delete process.env.INTELLIGENCE_GOVERNOR_MODE;
  else process.env.INTELLIGENCE_GOVERNOR_MODE = original;
});
