# Governor Divergence + Symmetric E2E Benchmark

Data: 2026-08-19
Branch: `feature/s3-intelligence-governor-prework-20260810`
HEAD de início: `0783cc2a5f4530b81903e3b0ad0f94bfc1810de8`

## Starting State

Governor: `simulate / false / 0`
Telemetry: habilitada, amostragem `1`
Canary: `0 — NOT ACTIVATED`

O servidor oficial respondeu health `200`. A primeira tentativa com Turbopack ficou
instável; a validação foi concluída com `OMNIROUTE_USE_TURBOPACK=0` somente no processo do
servidor, sem alterar `.env`, `server.env`, `DATA_DIR` ou credenciais. Nenhuma rota ativa foi
alterada.

## Previous benchmark

O benchmark anterior corrigido teve agreement `10/10` e a conclusão correta foi
equivalência das decisões de roteamento. O workload anterior era homogêneo o suficiente para que o
Native e o plano shadow convergissem no mesmo `openrouter/qwen/qwen3.8-27b` em todos os pares.

## Current pool

O pool foi reconstruído dinamicamente depois do bootstrap da configuração de armazenamento;
nenhum valor de credencial foi impresso.

| Métrica    |                                                        Resultado |
| ---------- | ---------------------------------------------------------------: |
| Raw        |                                                              531 |
| Active     |                                                              531 |
| Eligible   |                                                              531 |
| Healthy    |                                                              531 |
| Executable | não é escalar do pool; `11/12` casos produziram plano executável |

Distribuição atual por provider/backend:

| Provider   | Targets |
| ---------- | ------: |
| NVIDIA     |     102 |
| Gemini     |       5 |
| OpenRouter |     413 |
| OpenCode   |       6 |
| Felo-web   |       5 |

Havia diversidade factual suficiente para provocar decisões diferentes. Nos metadados
observados, o Qwen tinha reliability histórica aproximada de `0,967` (failure rate de cerca
de `3,3%`) e p95 histórico próximo de `9.950 ms`; o `openai/gpt-4o-mini-2024-07-18` tinha
failure rate observado `0` no snapshot usado. Pricing continuou desconhecido para esses
targets. Context windows e capabilities foram usados somente quando presentes no catálogo;
nenhum valor ausente foi inventado.

## Why previous workload converged

O workload anterior exercitava essencialmente o mesmo conjunto de requisitos e o Qwen era o
primeiro alvo Native comprovado e também o alvo retornado pelo plano Governor. O workload novo
incluiu contexto longo, formato estrito, JSON, código, idiomas e cenários leves. Com essa
diversidade, o Governor passou a retornar `openrouter/openai/gpt-4o-mini-2024-07-18` em dez
casos válidos, enquanto o Native continuou observando Qwen. Os motivos registrados foram em
geral `tier=low`/`routing=cost_optimized` com `cost_basis=unknown`, e `tier=medium`/`direct`
no caso de contexto longo; isso não permite atribuir a divergência a custo conhecido.

## Divergence workload

O conjunto foi fixado antes das requisições e executado com `stream=true` e `max_tokens=128`:

1. simple-fast
2. structured-json
3. code-generation
4. code-reasoning
5. long-context
6. portuguese
7. english
8. extraction
9. classification
10. reasoning
11. format-strict
12. low-cost-candidate-scenario

## Decision matrix

Nos dez casos válidos, todos os targets permaneceram elegíveis/saudáveis na pré-validação,
com `confidence=MEDIUM`, `executable=true` e `unresolvedFields=["pricingOrUsage"]`.

| Case               | Category                    | Native first target                                            | Governor target                            | Agreement | Health / reliability                                          | Unresolved     |
| ------------------ | --------------------------- | -------------------------------------------------------------- | ------------------------------------------ | --------- | ------------------------------------------------------------- | -------------- |
| simple-fast        | simple-fast                 | não comprovado; resposta terminal veio após fallback observado | `openrouter/qwen/qwen3.8-27b`              | UNPROVEN  | fallback NVIDIA 404; não usado como decisão Native            | —              |
| structured-json    | structured-json             | `openrouter/qwen/qwen3.8-27b`                                  | `openrouter/openai/gpt-4o-mini-2024-07-18` | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| code-generation    | code-generation             | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| code-reasoning     | code-reasoning              | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| long-context       | long-context                | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; contexto/capabilities avaliados quando disponíveis | pricingOrUsage |
| portuguese         | portuguese                  | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| english            | english                     | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| extraction         | extraction                  | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| classification     | classification              | não comprovado; timeout do harness em `120011 ms`              | não disponível                             | UNPROVEN  | sem decisão executável observada                              | —              |
| reasoning          | reasoning                   | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| format-strict      | format-strict               | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |
| low-cost-candidate | low-cost-candidate-scenario | Qwen                                                           | GPT-4o-mini                                | NO        | elegíveis; históricos diferentes                              | pricingOrUsage |

`Qwen` na tabela significa `openrouter/qwen/qwen3.8-27b`; `GPT-4o-mini` significa
`openrouter/openai/gpt-4o-mini-2024-07-18`.

## Decision benchmark summary

| Métrica                           | Resultado |
| --------------------------------- | --------: |
| Cases                             |        12 |
| Agreement                         |         0 |
| Disagreement                      |        10 |
| Valid disagreement                |        10 |
| Unproven/timeout                  |         2 |
| Direct invalid por stale/cooldown |         0 |

### Direct execution results

Foram executados somente os dez disagreements válidos, em vinte requests diretos, alternando
`Native → Governor` e `Governor → Native`. A pré-validação não encontrou target stale.

| Braço           | HTTP 200 | Stream completo | Qualidade |
| --------------- | -------: | --------------: | --------: |
| Native Direct   |    10/10 |           10/10 |      9/10 |
| Governor Direct |    10/10 |           10/10 |      9/10 |

O único validator reprovado foi `code-generation`, em ambos os targets. A qualidade e a
confiabilidade foram portanto empate em `10/10` casos. Como o resultado compacto do harness
não foi persistido durante a execução, os valores de duração recuperados de `call_logs` são
apenas metadados de servidor, não uma nova execução do harness: Native/Qwen p50 `2.569 ms`,
p95 `4.175 ms`; Governor/GPT p50 `982 ms`, p95 `2.429 ms`. Eles são uma indicação
direcional de latência, mas não são usados sozinhos para declarar vencedor de seleção.

### Decision conclusion

`INCONCLUSIVE`. A divergência foi reproduzida com dez pares válidos, mas o resultado de
qualidade foi `9/10` em cada braço, houve um validator de código reprovado nos dois targets e
os tempos recuperados não possuem a mesma fronteira `completionMs` do harness persistido.

## E2E methodology

Native E2E mediu uma requisição normal `auto/chat`, desde o início do request até o fechamento
completo do stream. Governor E2E mediu, na mesma fronteira conceitual, o planejamento local
(`applyGovernorToAutoComboOrder`), a validação do target selecionado, a execução direta e o
fechamento do stream. O Governor não foi ativado globalmente.

## E2E calibration

Foram executados três pares de calibração. Native teve HTTP/stream/quality `3/3/3`; Governor
teve HTTP/stream `3/3`, mas quality `2/3`. O caso reprovado foi `code-generation` no braço
Governor. Portanto, a calibração é `FAIL` e o benchmark E2E não deveria prosseguir.

Durante a execução original, o modo completo do harness ainda usava a condição antiga que
validava apenas HTTP/stream e, por isso, executou dez pares de benchmark antes de a correção
do gate ser aplicada. O harness agora exige quality pass nos dois braços e encerra com
`stopReason=e2e_calibration_failed`; os dez pares executados antes dessa correção são
preliminares e não autoritativos.

## E2E benchmark

Resultado preliminar, registrado somente para transparência e não para declarar vencedor:

| Métrica                   |                         Native E2E |         Governor E2E |
| ------------------------- | ---------------------------------: | -------------------: |
| Pairs                     |                                 10 |                   10 |
| Success                   |                              10/10 |                10/10 |
| Quality                   |                              10/10 |                 9/10 |
| TTFT p50                  |                          ~6.829 ms |            ~1.199 ms |
| Completion p50            |                          ~7.349 ms |            ~2.475 ms |
| Completion p95            |                         ~10.869 ms |            ~4.736 ms |
| Routing/planning overhead | Native não mensurável isoladamente | planning p50 ~994 ms |

O Governor foi mais rápido nesse conjunto preliminar, mas teve regressão de qualidade
`9/10` contra `10/10` e não passou pela calibração exigida. A conclusão E2E é
e2e inconclusive.

## Choice distribution

Entre os dez casos válidos:

- Native: Qwen `10/10`;
- Governor: GPT-4o-mini `10/10`;
- agreement: `0/10`;
- concentração: Native `100%`, Governor `100%`.

## Pricing

`INCOMPLETE`. `pricingOrUsage` continuou unresolved; nenhum preço, economia ou vitória de
custo foi inventado.

## NVIDIA

`NOT A GATE`. Houve um evento factual de `404/model not found` para um target NVIDIA durante o
primeiro caso; o request terminou em fallback para OpenRouter. O caso foi marcado
unproven/fail-closed e não contaminou os dez disagreements válidos.

## Overall conclusion

`INCONCLUSIVE`. O workload produziu divergência real, mas a decisão direta não demonstrou
diferença de qualidade/confiabilidade e a calibração E2E falhou antes do benchmark
autoritatório.

## Canary

`0 — NOT ACTIVATED`.

## Canary readiness

not ready. O próximo gate obrigatório é uma nova calibração E2E com o harness corrigido,
sem ativar o Governor, além de uma decisão explícita sobre o caso `code-generation`.

## Remaining risks

- O primeiro caso Native não é evidência de primeira escolha por ter passado por fallback.
- `classification` não produziu plano por timeout do harness.
- Pricing continua desconhecido e permanece fora da conclusão.
- O benchmark E2E preliminar foi executado antes do gate de quality corrigido e não pode ser
  usado como resultado final.
- O overhead de routing Native não é exposto separadamente pelo caminho externo.
- NVIDIA teve um erro de modelo em background, mas não é gate desta validação.

## Exact next action

Executar novamente somente a calibração corrigida de três pares, persistindo o JSON compacto do
harness. Parar imediatamente se qualquer braço falhar HTTP, stream ou quality; somente se os
três pares passarem, executar cinco pares E2E e, então, no máximo dez. Manter sempre
`simulate / false / 0`; não ativar canary.

## Alterações desta validação

- `scripts/ad-hoc/omniroute-governor-divergence-e2e-20260819.mjs`: workload fixo de 12 casos,
  reconstrução de pool, replay fail-closed, direct comparison alternado, medição E2E com
  planning, gate de calibração por quality e contabilidade de vencedor por quality/success/
  latency.
- `tests/unit/omniroute-governor-divergence-e2e-harness.test.ts`: invariantes do workload,
  timing, stale handling, gate de quality e accounting de vencedor.
- Nenhum arquivo de produção foi alterado.
