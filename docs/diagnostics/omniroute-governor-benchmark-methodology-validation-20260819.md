# OmniRoute Governor — validação metodológica do benchmark

Data: 2026-08-19  
Branch: `feature/s3-intelligence-governor-prework-20260810`  
HEAD inicial: `47e26a2c4cefe4ff0f8f1c91870136fd5026b9b0`  
Status final: `B — ROUTING_DECISIONS_EQUIVALENT`

## Escopo e controles

Esta execução auditou e corrigiu o harness do benchmark shadow. Não houve alteração de
policy, pricing, scoring, executor ou caminho de dispatch do Governor. O servidor foi
iniciado somente com:

```text
INTELLIGENCE_GOVERNOR_MODE=simulate
INTELLIGENCE_GOVERNOR_TELEMETRY=true
GOVERNOR_ACTIVE_ENABLED=false
GOVERNOR_ACTIVE_CANARY_RATE=0
GOVERNOR_TELEMETRY_SAMPLE_RATE=1
```

Nenhuma decisão ativa foi aplicada; `active=false` e `canary=0` permaneceram durante toda a
validação. O servidor foi encerrado com SIGINT depois dos testes e o computador foi deixado
ligado.

## Conclusão executiva

O status anterior `B — GOVERNOR_DIRECTIONALLY_BETTER` não é sustentado como conclusão de
roteamento. O benchmark anterior misturava contabilidade de operações, não armazenava a saída
reconstruída do SSE e usava o resultado terminal como se fosse sempre a primeira escolha
Native; por isso, a comparação de qualidade e a evidência de primeira escolha eram
insuficientes.

Depois da correção do harness, a calibração passou com 5/5 streams completos e 5/5
validadores em cada braço. No Benchmark A, que compara somente execuções diretas comparáveis,
Native e Governor escolheram o mesmo alvo em 10/10 pares; portanto, não existe vencedor de
roteamento. A conclusão corrigida é `B — ROUTING_DECISIONS_EQUIVALENT`.

## Contabilidade de operações

### Reconstrução do benchmark anterior

O intervalo bruto continha 66 registros `call_logs`: 60 requests do benchmark e 6 testes de
conexão em background, excluídos da amostra. Cada par do harness antigo fazia três requests
de API:

1. Native Auto (`auto/chat`);
2. Governor plan (`auto/chat`, usado para obter a telemetria);
3. Governor Direct (execução explícita do alvo selecionado).

Assim, o histórico físico foi:

| Classificação                            | Pares | Native Auto | Governor plan | Governor Direct | Requests de API |
| ---------------------------------------- | ----: | ----------: | ------------: | --------------: | --------------: |
| Preliminary, excluído                    |    10 |          10 |            10 |              10 |              30 |
| Authoritative, usado no relatório antigo |    10 |          10 |            10 |              10 |              30 |
| Total físico                             |    20 |          20 |            20 |              20 |              60 |

Os primeiros 5 pares foram uma tentativa inválida de cache; os 5 seguintes tiveram a saída
reconstruída descartada; somente os 10 últimos eram authoritative. O relatório anterior
registrou “20 pair operations”, mas não explicitou que cada par tinha três requests nem que
as duas rodadas preliminares também tinham executado fisicamente. Esta auditoria preserva o
fato e não reutiliza esses resultados como evidência de decisão.

### Execuções desta validação

| Fase        | Pares | Native Auto/observação | Native Direct | Governor plan | Governor Direct | Requests de API |
| ----------- | ----: | ---------------------: | ------------: | ------------: | --------------: | --------------: |
| Calibração  |     5 |                      5 |             — |             5 |               5 |              15 |
| Benchmark A |    10 |                     10 |            10 |            10 |              10 |              40 |

Na calibração, a comparação de latência Native Auto versus Governor Direct não foi usada como
resultado. No Benchmark A, a observação Auto também não entra na comparação de latência: os
únicos braços comparados são Native Direct e Governor Direct, executados pela mesma função do
harness.

## Auditoria dos timers

O valor antigo chamado `latencyMs` era medido desde imediatamente antes do `fetch()` até o
fim da leitura e parsing do corpo SSE. Ele não era TTFB, TTFT, overhead de rota ou tempo de
planejamento isolado. Os valores agregados antigos `5035` e `1896` significavam
aproximadamente 5,035 s e 1,896 s, respectivamente, e não 1–5 ms.

O harness corrigido mantém offsets separados:

- `headersAtMs`: resolução dos headers do `fetch`;
- `firstByteMs`: primeiro chunk de bytes;
- `firstEventMs`: primeiro frame SSE;
- `firstContentMs`: primeiro delta de conteúdo não vazio;
- `doneMs`: parsing de `[DONE]`;
- `connectionClosedMs`: fechamento do reader;
- `completionMs`: fechamento do reader depois do parsing completo.

`completionMs` é a métrica de conclusão usada nos agregados. Não há alegação de overhead de
roteamento porque essa grandeza não é exposta pelo request path do harness.

## Auditoria SSE e qualidade

O parser corrigido usa `TextDecoder` em modo streaming, preserva frames divididos entre
chunks, aceita separadores CRLF/LF, concatena `delta.content`, captura `message.content`,
registra `finish_reason` e `[DONE]`, e somente considera o stream completo quando o reader
termina e há sinal terminal. `reasoning_content` é tratado como metadado e não é confundido
com resposta final.

O harness anterior não persistia `content` reconstruído. Portanto, o resultado antigo de
qualidade `0/10` contra `1/10` não era auditável como falha semântica: não era possível saber
se o parser perdeu conteúdo ou se o provider realmente não produziu conteúdo final. Os
registros de cache da rodada preliminar mostraram respostas vazias ou truncadas em `content`
com raciocínio separado, compatíveis com o limite anterior `max_tokens=32`; isso é evidência
diagnóstica, não uma validação retroativa.

O harness corrigido persiste apenas a saída reconstruída limitada, comprimento, truncamento,
validador e razão da falha. Os validadores são determinísticos e sem LLM judge:

- exact: texto normalizado igual ao esperado;
- json: parse JSON e comparação semântica do objeto esperado;
- code: texto normalizado igual ao statement esperado;
- unjudged: explicitamente não avaliado, nunca convertido em aprovação.

## Calibração — 5 pares

Workload pré-declarado: resposta exata, JSON, instrução em português, transformação e código;
`stream=true`, `temperature=0`, `max_tokens=128`.

| Métrica                | Native Auto | Governor Direct |
| ---------------------- | ----------: | --------------: |
| Requests               |           5 |               5 |
| HTTP 200               |         5/5 |             5/5 |
| Streams completos      |         5/5 |             5/5 |
| Qualidade aprovada     |         5/5 |             5/5 |
| Timeouts/erros         |         0/5 |             0/5 |
| Planos correlacionados |           — |             5/5 |
| Planos executáveis     |           — |             5/5 |

O tempo médio de conclusão foi 10.202 ms no Native Auto e 2.440 ms no Governor Direct,
mas essa diferença não é uma comparação end-to-end válida: os braços têm caminhos diferentes.
Ela serve somente para demonstrar que o harness registrou streams completos e não apenas
headers.

## Benchmark A — qualidade da decisão

Desenho corrigido por par:

```text
Native Auto (observa o primeiro alvo)
  -> Native Direct (executa esse alvo)

Governor plan Auto (obtém o plano shadow)
  -> Governor Direct (executa o alvo do plano)
```

O primeiro alvo Native só foi considerado comprovado quando o request terminou com HTTP 200,
`fallbackAttempts=0` e o modelo observado foi compatível com o provider/model do resultado
terminal. Quando os alvos são iguais, o par é `AGREEMENT` e não há vencedor de roteamento.

### Resultado

| Métrica                               | Resultado |
| ------------------------------------- | --------: |
| Pares                                 |        10 |
| Alvo Native comprovado                |     10/10 |
| AGREEMENT                             |     10/10 |
| DISAGREEMENT                          |      0/10 |
| UNPROVEN                              |      0/10 |
| Native Direct HTTP/stream/qualidade   |  10/10/10 |
| Governor Direct HTTP/stream/qualidade |  10/10/10 |
| Ties de qualidade                     |     10/10 |
| Ties de confiabilidade                |     10/10 |

Todos os 10 pares usaram o mesmo alvo observado:
`openrouter/qwen/qwen3.8-27b`.

As médias de conclusão direta foram 2.257 ms no Native Direct e 2.407 ms no Governor
Direct; p50 foi 2.089 ms e 2.211 ms, e p95 foi 3.517 ms e 3.448 ms. Esses números descrevem
duas execuções diretas do mesmo alvo, não uma vantagem de seleção; a pequena diferença de
tempo não altera a classificação `AGREEMENT`.

### Benchmark B — end-to-end

Não foi usado para declarar vencedor. A rodada de calibração ainda tinha Native Auto contra
Governor Direct, portanto seus tempos são deliberadamente não comparados. Um benchmark B
válido exigiria um desenho end-to-end previamente especificado para ambos os braços, separado
do Benchmark A.

## Custo e campos incompletos

Os planos durante a calibração e o Benchmark A permaneceram com `resolvedModelTier=preserve`,
`estimatedCurrentCost=null`, `estimatedCounterfactualCost=null` e `unresolvedFields` contendo
`pricingOrUsage` para o alvo OpenRouter/Qwen. Nenhum preço foi inventado, nenhum custo zero foi
atribuído e não há conclusão de savings. O custo fica explicitamente INCOMPLETE e não é gate
da equivalência de decisão deste benchmark.

## Alterações realizadas

Somente o harness e seus testes foram alterados:

- `scripts/ad-hoc/omniroute-shadow-benchmark-core.mjs`: parser SSE, conclusão, validadores,
  comparação de alvo e contabilidade puros/testáveis;
- `scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs`: captura de output, primeiro
  conteúdo, conclusão, modo de calibração e Benchmark A comparável;
- `tests/unit/omniroute-shadow-benchmark-methodology.test.ts`: testes sintéticos de chunks,
  `[DONE]`, fechamento, qualidade e contabilidade.

Não houve mudança em `src/`, `open-sse/governor/`, pricing, scoring, policy, NVIDIA ou
configuração persistente.

## Verificações

- Testes sintéticos do harness: 4/4 pass, 0 fail.
- Governor focado: 59/59 pass, 0 fail.
- `npm run typecheck:core`: PASS.
- `node --check` nos dois scripts `.mjs`: PASS.
- `git diff --check`: PASS.
- Servidor: encerrado graciosamente; nenhuma porta 20128/20131/20132 ficou em escuta.
- Governor ativo: NÃO.
- Canary rate: `0`.
- Benchmark de 10K/soak: NÃO executado.
- NVIDIA: não foi gate desta auditoria.

## Status e próximo passo

`FINAL_STATUS=B — ROUTING_DECISIONS_EQUIVALENT`

O método foi corrigido e validado, mas este resultado não demonstra vantagem de custo nem
vantagem de roteamento porque os 10 pares tiveram a mesma decisão. O próximo benchmark de
produção deve usar um workload que gere desacordos de seleção e deve manter a separação entre
decisão, execução direta comparável e end-to-end.
