import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import type { ComboLogger, SingleModelTarget } from "../../open-sse/services/combo/types.ts";

const noopLog: ComboLogger = { warn() {}, info() {}, error() {}, debug() {} };

test("timeout<=0: passthrough direto (sem timer)", async () => {
  let called = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      called = true;
      return new Response("ok");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(called, true);
  assert.equal(await res.text(), "ok");
});

test("timeout<=0: erro do upstream vira errorResponse 502", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      throw new Error("boom");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 502);
});

test("excede o limite: aborta e retorna 504 combo_target_timeout", async () => {
  let aborted = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        // resolve só se abortado (simula um upstream que respeita o signal)
        const sig = target?.modelAbortSignal ?? undefined;
        sig?.addEventListener("abort", () => {
          aborted = true;
          resolve(new Response(null, { status: 599 }));
        });
      }),
    comboTargetTimeoutMs: 20,
    log: noopLog,
  });
  const res = await runner({}, "slow-model");
  assert.equal(res.status, 504);
  assert.equal(aborted, true, "per-target timeout must abort the in-flight target");
  const body = await res.json();
  assert.match(JSON.stringify(body), /timed out/i);
  assert.equal(body?.error?.code, "combo_target_timeout");
  assert.equal(body?.error?.type, "combo_target_timeout");
});

test("sucesso rápido vence a corrida do timeout", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => new Response("fast", { status: 200 }),
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "fast");
});

test("hedge do parent já abortado propaga o abort ao filho sem virar erro 502", async () => {
  const parent = new AbortController();
  parent.abort(new Error("hedge-cancelled"));
  let sawAbort = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        const sig = target?.modelAbortSignal ?? undefined;
        if (sig?.aborted) sawAbort = true;
        resolve(new Response("ok"));
      }),
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  const parentTarget: SingleModelTarget = { modelAbortSignal: parent.signal };
  const res = await runner({}, "m", parentTarget);
  assert.equal(sawAbort, true);
  assert.equal(res.status, 499);
  const body = await res.json();
  assert.equal(body?.error?.code, "combo_hedge_cancelled");
});

test("cancelamento de hedge encerra imediatamente e não espera o timeout do alvo", async () => {
  const parent = new AbortController();
  let sawAbort = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        target?.modelAbortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve(new Response("late child result"));
          },
          { once: true }
        );
      }),
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  const promise = runner({}, "m", { modelAbortSignal: parent.signal });
  setTimeout(() => parent.abort(new Error("hedge-cancelled")), 10);
  const res = await promise;
  assert.equal(sawAbort, true);
  assert.equal(res.status, 499);
  const body = await res.json();
  assert.equal(body?.error?.type, "combo_hedge_cancelled");
});

test("deadline global usa o saldo restante e emite classificação do roteador", async () => {
  let aborted = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        const sig = target?.modelAbortSignal;
        sig?.addEventListener("abort", () => {
          aborted = true;
          resolve(new Response(null, { status: 599 }));
        });
      }),
    comboTargetTimeoutMs: 1000,
    globalDeadlineAtMs: Date.now() + 20,
    log: noopLog,
  });

  const res = await runner({}, "slow-model");
  assert.equal(res.status, 504);
  assert.equal(res.headers.get("x-omniroute-combo-timeout"), "combo_global_timeout");
  assert.equal(aborted, true);
  const body = await res.json();
  assert.equal(body?.error?.code, "combo_global_timeout");
});
