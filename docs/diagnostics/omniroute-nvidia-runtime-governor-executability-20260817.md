# OmniRoute NVIDIA runtime e Governor executability — 2026-08-17

## Escopo e segurança

- HEAD inicial: `5addafd501ce223799a8b482b2d3b0b0014a3f89`.
- Branch: `feature/s3-intelligence-governor-prework-20260810`.
- Nenhum arquivo de runtime, policy do Governor, credencial, configuração de routing ou S3 foi alterado.
- Nenhuma API key, valor criptografado, Authorization header ou corpo de upstream foi registrado.
- Windows não foi reiniciado nem desligado.
- O único processo iniciado foi o OmniRoute local; o canary permaneceu em zero.

## Runtime e controles

O servidor foi reiniciado com variáveis de processo:

```text
INTELLIGENCE_GOVERNOR_MODE=simulate
INTELLIGENCE_GOVERNOR_TELEMETRY=true
GOVERNOR_ACTIVE_ENABLED=false
GOVERNOR_ACTIVE_CANARY_RATE=0
GOVERNOR_TELEMETRY_SAMPLE_RATE=1
```

Validação final:

| Controle                    | Resultado                               |
| --------------------------- | --------------------------------------- |
| Liveness `/api/health/ping` | HTTP 200; 41 ms na última medição       |
| Monitoring health           | `healthy`; HTTP 200; 167 ms             |
| Connections ativas          | 3                                       |
| Credential health           | 3 healthy, 0 failed, 0 unknown, 0 stale |
| Governor mode               | `simulate`                              |
| Governor active enabled     | `false`                                 |
| Canary rate                 | `0`                                     |
| Telemetry                   | `true`                                  |
| Telemetry sample rate       | `1`                                     |
| Active breaker              | `closed`                                |
| NVIDIA provider breaker     | `CLOSED`; `retryAfterMs=0`              |

## Parte A — NVIDIA

### Evidência histórica dos três timeouts

O harness anterior, em `scripts/ad-hoc/omniroute-shadow-benchmark-20260817.mjs`, usa `stream:false` e `AbortSignal.timeout(90_000)`. As três requisições foram seriais e o log do servidor mostra a mesma seleção:

```text
auto/chat: 5 candidate groups
expanded models: 39
context-window filter: 39/39
selected: nvidia/google/gemma-4-31b-it
nvidia: active=1, excluded=0, available=1/1
```

O que foi observado, sem extrapolar fases não registradas:

| Marco       | Evidência                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0          | POST `auto/chat` iniciou às 15:38:18.584, 15:39:34.546 e 15:41:04.392 UTC no log anterior                                                                                                                                                                                                                                       |
| T1          | Adapter NVIDIA entrou; log `NVIDIA \| google/gemma-4-31b-it \| 1 msgs`                                                                                                                                                                                                                                                          |
| T2          | Fetch upstream foi iniciado pelo `DefaultExecutor`; o instante exato não é logado                                                                                                                                                                                                                                               |
| T3/T4/T5/T6 | Headers, primeiro byte e último byte não foram capturados pelo harness; não há log de timeout de headers/readiness/idle                                                                                                                                                                                                         |
| T7          | O harness tinha deadline externo de 90.000 ms. O código atual define `FETCH_TIMEOUT_MS` como timeout de início da resposta; o default no source é 600.000 ms. A alegação histórica de 120 s não é observável nesta inicialização porque não há override em `.env` nem no comando persistido; ~300 s também não aparece nos logs |
| T8          | Aborto do cliente propagado como `client_disconnect` / `hedge-cancelled`                                                                                                                                                                                                                                                        |
| T9/T10/T11  | O request foi finalizado pelo caminho de cancelamento; os logs HTTP mostram `200 in 89s` e o cleanup registra `499` no loop de combo. Não houve evidência de timeout interno do `DefaultExecutor`                                                                                                                               |

Classificação factual: "ABORT" (deadline do cliente/harness → signal de request → stream bridge → "hedge-cancelled"). Não é possível classificar como "CONNECT", "HEADERS", "FIRST_BYTE", "STREAM_IDLE", "TOTAL_ATTEMPT", "COMBO_GLOBAL" ou "SDK_RETRY" com os dados existentes.

O `DefaultExecutor` usa o timeout de fetch somente até a resposta inicial; depois a proteção é readiness/body/idle. O gate de concorrência NVIDIA tem limite padrão 6 e o harness foi serial, portanto não há evidência de fila/concurrency como causa. O `streamHandler` propaga o abort ao upstream e não classifica disconnect do cliente como falha da conexão.

### Reprodução controlada desta execução

Foi feita uma requisição streaming serial ao modelo de referência `nvidia/openai/gpt-oss-20b`, com prompt curto e `max_tokens=8`, sem imprimir o corpo. Ela retornou HTTP 404 em aproximadamente 3,6 s, sem abort. Como verificação do modelo que havia sido selecionado no piloto, `nvidia/google/gemma-4-31b-it` também retornou HTTP 404 em aproximadamente 1,4 s, sem abort. Em ambas não apareceu log de dispatch NVIDIA correspondente; portanto o 404 desta reprodução não comprova um 404 do upstream NVIDIA e não deve ser usado como sucesso de autenticação.

O servidor permaneceu responsivo: os probes atuais retornaram 200; no log histórico, probes posteriores ao terceiro timeout também retornaram ping 200 em 48 ms e monitoring 200 em 411 ms/25 ms. Não existe probe concorrente registrado durante cada uma das três esperas históricas, então não é possível afirmar que o event loop foi medido durante todo o stall; não há, contudo, evidência de runtime permanentemente travado.

### Fluxo de credencial NVIDIA

- Registry: provider `nvidia`, executor `default`, `baseUrl=https://integrate.api.nvidia.com/v1/chat/completions`, `authType=apikey`, auth scheme `Bearer`.
- Registry local contém `google/gemma-4-31b-it` e `openai/gpt-oss-20b`; isso comprova apenas catálogo local, não disponibilidade atual no NIM.
- O health check encontrou 1 connection NVIDIA ativa e saudável; o log de auto-routing confirma `active=1`, `available=1/1` e seleção da connection mascarada `4048ceb6...`.
- `BaseExecutor` resolve a credencial selecionada e constrói `Authorization: Bearer <token bruto>`; não foi encontrado Bearer duplicado, uso da ciphertext ou URL NVIDIA alternativa no caminho padrão.
- A presença de credencial saudável não prova que o model id local ainda seja aceito pelo endpoint de chat. O 404 rápido desta execução bloqueia a confirmação de um request upstream bem-sucedido.

## Parte B — Governor e funil de candidatos

### Funil observado

| Estágio                                |                                   Quantidade/estado | Fonte                                       |
| -------------------------------------- | --------------------------------------------------: | ------------------------------------------- |
| Connections persistidas                |                                                   3 | monitoring health                           |
| Connections ativas/saudáveis           |                                                 3/3 | credential health                           |
| Grupos lógicos do virtual `auto/chat`  |                                                   5 | log `Virtual auto-combo ... (5 candidates)` |
| Modelos expandidos                     |                                                  39 | log `context-window filter kept 39/39`      |
| Context filter                         |                                      39/39 mantidos | log do auto strategy                        |
| NVIDIA health                          |                 1 ativa, 0 excluída, 1/1 disponível | log do combo                                |
| Circuit/lockout do alvo selecionado    | breaker `CLOSED`; sem lockout persistido encontrado | health/DB                                   |
| Planos Governor gerados nas 3 chamadas |                                                 3/3 | `governor_telemetry`                        |
| Planos executáveis                     |                                                 3/3 | `executable=true`                           |
| Planos recuperados pelo harness        |                                                 0/3 | correlação HTTP ausente                     |

Os 11 candidatos no-auth reais foram:

- `opencode` / connection `noauth`: `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `nemotron-3-ultra-free`, `north-mini-code-free`.
- `felo-web` / connection `noauth`: `felo-chat`, `felo-search`, `felo-scholar`, `felo-social`, `felo-document`.

Os outros três grupos lógicos eram as connections credentialed de `nvidia`, `openrouter` e `gemini`; o log disponível registra o total expandido (39) e o estado por provider no momento da seleção, mas não serializa uma lista completa por modelo. Nenhum campo sensível é necessário para concluir o diagnóstico.

### Por que o harness viu zero

O Governor não produziu zero planos. As três linhas mais recentes de `governor_telemetry` são:

```text
actualProvider=nvidia
actualModel=google/gemma-4-31b-it
selectedProvider=opencode
selectedModel=big-pickle
resolvedModelTier=low
estimatedCurrentCost=null
estimatedCounterfactualCost=0
costEstimateBasis=PRE_REQUEST_BUDGET
confidence=MEDIUM
executable=true
unresolvedFields=[]
CAPABILITY_COMPATIBLE=YES
CONTEXT_FITS=YES
PROVIDER_AVAILABLE=YES
QUOTA_ACCEPTABLE=YES
REASONING_SUPPORTED=YES
COMPRESSION_SUPPORTED=YES
USER_MAX_OUTPUT_RESPECTED=YES
liveActiveControl=false
```

O harness perdeu a correlação por três motivos combinados:

1. a função de request usa `stream:false`;
2. o header `X-Correlation-Id` é adicionado pela rota somente no ramo streaming; e
3. o harness espera o header até a resposta chegar, mas aborta em 90 s e só procura a telemetria por aquele correlation id.

O `GovernorManager` grava a telemetria antes do dispatch, portanto o plano existe mesmo quando o cliente não recebe headers. A ausência de fallback por janela temporal/ordem de request no script é uma limitação do instrumento de medição, não uma falha de candidate eligibility.

## Native vs Governor eligibility

Não há desalinhamento factual entre Native e Governor no piloto:

- Native auto-routing selecionou NVIDIA com connection ativa e disponível.
- Governor recebeu o pool já filtrado pelo Auto-Combo e produziu plano executável.
- `CONTEXT_FITS` foi `YES`, não `UNKNOWN`, para o candidato `opencode/big-pickle` nas três linhas observadas.
- Nenhum candidato foi forçado para tornar o plano executável.
- Não foram encontrados sinais de "EXPECTED_CANDIDATE_EXHAUSTION", "GOVERNOR_OVERFILTERING", "HEALTH_SCOPE_TOO_BROAD", "STALE_HEALTH" ou "CANDIDATE_POOL_GAP".

## Código alterado e testes

Nenhum código de runtime foi alterado e nenhuma regressão foi adicionada, porque nenhum bug de produção foi provado nesta investigação. Os únicos novos dados são este relatório diagnóstico. O reteste NVIDIA 3/3, `auto/chat` 3 e shadow 3 foi corretamente não executado: os gates exigiam primeiro um smoke NVIDIA válido, mas os dois model ids testados retornaram 404 antes de um dispatch upstream confirmado.

Não foi executado benchmark de 5/20 pares nem canary. O controle permanece `simulate`, active disabled e canary `0`.

## Conclusão e status

- NVIDIA runtime root cause: o timeout histórico é comprovadamente encerrado pelo deadline externo de 90 s do harness e propagado como abort; a causa upstream/local do stall do modelo `google/gemma-4-31b-it` não foi isolada porque a reprodução atual retorna 404 antes do dispatch observável.
- Governor executability root cause: nenhum bug; os três planos eram executáveis. O zero foi falha de correlação do harness.
- Correção de código: nenhuma indicada nesta execução. Uma melhoria futura do harness pode correlacionar telemetria por timestamp/request ordinal e usar `stream:true`, mas isso não foi implementado.
- `CURRENT EFFICIENCY EVIDENCE=NOT_VALIDLY_TESTED`.
- `FINAL STATUS=G_BLOCKED`.

### Próximo passo seguro

Confirmar, com o model id efetivamente presente no catálogo live NVIDIA e sem alterar policy, uma única chamada Native que chegue ao adapter e retorne 200; somente depois repetir os gates seriais. Não ativar `GOVERNOR_ACTIVE_CANARY_RATE=1`.
