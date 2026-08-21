import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-governor-simulate-"));
process.env.DATA_DIR = dataDir;
const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
await ensureDbInitialized();
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
function response() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
async function target(mode: "off" | "simulate") {
  process.env.INTELLIGENCE_GOVERNOR_MODE = mode;
  const selected: string[] = [];
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "small request" }] },
    combo: { name: `sim-${mode}`, strategy: "priority", models: ["fixture/provider-model"] },
    handleSingleModel: async (_body: unknown, model: string) => {
      selected.push(model);
      return response();
    },
    isModelAvailable: async () => true,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings: null,
    allCombos: null,
  });
  assert.equal(result.ok, true);
  return selected[0];
}
test("simulate records a counterfactual without changing authoritative routing", async () => {
  assert.equal(await target("off"), await target("simulate"));
});
test.after(() => {
  delete process.env.INTELLIGENCE_GOVERNOR_MODE;
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
