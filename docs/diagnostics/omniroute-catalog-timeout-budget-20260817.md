# OmniRoute Catalog + Timeout Budget Investigation

Data da investigação: 2026-08-17

Branch: `feature/s3-intelligence-governor-prework-20260810`
HEAD verificado: `da6be35a3926114a310453de4dc91b1c5afabe16`

## Starting HEAD

`da6be35a3926114a310453de4dc91b1c5afabe16`

## Escopo e controles

- Governor: `simulate`.
- `GOVERNOR_ACTIVE_ENABLED`: `false`.
- `GOVERNOR_ACTIVE_CANARY_RATE`: `0`.
- Nenhuma requisição foi executada com canary ativo.
- Nenhuma credencial, chave, cookie, header de autorização ou valor criptografado foi impresso.
- O S3 não foi alterado.
- Benchmark 20/20 não foi repetido nesta investigação; o resultado histórico permanece no relatório de 2026-08-14.

O diagnóstico foi feito sobre uma cópia somente leitura do banco efetivamente usado pelo OmniRoute (`%USERPROFILE%\\.omniroute\\storage.sqlite`). A cópia foi usada para inspeção local e não foi adicionada ao repositório.

## Starting candidate pool

Total: 39 candidatos lógicos.

- Gemini: 5 authoritative.
- NVIDIA: 5 authoritative.
- OpenRouter: 18 authoritative.
- OpenCode: 6 static-only/no-auth.
- Felo: 5 static-only/no-auth.

## Resultado executivo

O pool lógico atual contém 39 pares provider/model, sem duplicatas:

| Fonte      | Quantidade | Natureza                                           |
| ---------- | ---------: | -------------------------------------------------- |
| Gemini     |          5 | conexão ativa + catálogo sincronizado autoritativo |
| NVIDIA     |          5 | conexão ativa + catálogo sincronizado autoritativo |
| OpenRouter |         18 | conexão ativa + catálogo sincronizado autoritativo |
| OpenCode   |          6 | catálogo estático/no-auth                          |
| Felo       |          5 | catálogo estático/no-auth                          |

Para Gemini, NVIDIA e OpenRouter, os candidatos atuais vieram do catálogo sincronizado da conexão ativa; não foi encontrada entrada adicional somente do registry. O armazenamento atual não possui timestamp de sincronização, portanto a idade do snapshot não pode ser afirmada a partir do banco.

A atualização live não pôde ser confirmada nesta execução: a rota de gerenciamento de modelos respondeu `401` no runtime local e os fetches externos instrumentais foram bloqueados pelo ambiente de execução. Isso limita a conclusão a consistência do snapshot persistido, não a uma prova de frescor upstream.

## Credentialed catalogs

### Catálogos credenciados

`open-sse/services/autoCombo/virtualFactory.ts` trata um catálogo sincronizado autoritativo como fonte dos modelos da conexão. Os cinco modelos Gemini, cinco NVIDIA e dezoito OpenRouter observados no banco correspondem aos candidatos produzidos pela factory, cada grupo com a conexão ativa correta em `allowedConnectionIds`.

Não houve duplicatas entre provider/model. Os aliases `oc` e `felo` são apenas a forma de exibição dos providers no candidato; a seleção usa os ids canônicos `opencode` e `felo-web`.

Os 404 históricos do Gemini não provam que o candidate factory esteja admitindo um modelo apenas do registry: os modelos afetados também estavam no snapshot sincronizado atual. A hipótese mais conservadora é indisponibilidade/entitlement upstream ou snapshot sincronizado sem frescor verificável; não foi implementado blacklist ou fallback inventado.

## Static candidates

### OpenCode

OpenCode é no-auth e não possui catálogo autoritativo integrado. Seus seis modelos vêm do registry estático de `open-sse/config/providers/registry/opencode/index.ts`, incluindo `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `nemotron-3-ultra-free` e `north-mini-code-free`.

Há evidência histórica específica de que `north-mini-code-free` retornou `401` com classificação de modelo não suportado. Isso caracteriza risco de entrada estática desatualizada para esse modelo, mas não prova um bug genérico de seleção: não existe fonte authoritative para substituir o registry e o lockout de modelo existente é deliberadamente em memória e temporário. Não removi modelos estáticos nem criei uma blacklist baseada em um único upstream.

### Felo

Felo também é no-auth e static-only. Os cinco candidatos são categorias do executor reverse-engineered, sem catálogo público de modelos. Os eventos históricos observados foram compatíveis com `429`/rate limit e lockout transitório; não há evidência suficiente para classificar as entradas estáticas como inválidas.

## 404 semantics

### 404, lockout e persistência

O caminho de fallback classifica respostas de modelo não encontrado e registra lockout por provider + conexão + modelo quando aplicável. O lockout é em memória e expira; não é uma blacklist permanente e não sobrevive a reinício. Portanto, a repetição de uma entrada estática inválida após o período de expiração é comportamento esperado pela arquitetura atual, não prova de que a exclusão tenha sido ignorada.

Existe um risco latente no código: quando o catálogo de uma conexão é authoritative, `defaultModelIds` ainda podem ser considerados se o `defaultModel` da conexão apontar para um id fora desse snapshot. As três conexões credenciadas observadas têm `default_model` nulo; esse caso não foi reproduzido e não foi alterado.

## Candidate dedupe

Os 39 pares provider/model foram deduplicados por provider canônico + modelo normalizado, preservando conexões independentes quando existentes. Não foram encontradas duplicatas geradas por alias, registry, catálogo sincronizado, wildcard, default model ou normalização de prefixo.

## Next request learning

O lockout é registrado por provider + conexão + modelo quando a classificação permite; permanece em memória, expira e é reaplicado somente durante a vida útil do processo. Não há blacklist persistente de nomes de modelos.

## Timeout architecture

O caminho padrão do auto combo resolve os seguintes valores:

- `DEFAULT_COMBO_TARGET_TIMEOUT_MS = 120000` em `open-sse/services/comboConfig.ts`.
- `comboTimeoutMs = 0` por padrão, portanto o deadline global temporal do combo fica desativado.
- `MAX_GLOBAL_ATTEMPTS = 30` em `open-sse/services/combo/comboPredicates.ts`; é limite de dispatches, não limite de tempo.
- `FETCH_TIMEOUT_MS = 600000` por padrão para início da resposta upstream.
- readiness de streaming: 80000 ms por padrão, com teto de 180000 ms.
- leitura do corpo e idle entre chunks: 600000 ms por padrão.
- o bridge server possui timeout padrão de 300000 ms, mas o log disponível não traz correlação suficiente para atribuir os eventos históricos diretamente a essa camada.

`open-sse/services/combo/targetTimeoutRunner.ts` cria um `AbortController` local, propaga o `target.modelAbortSignal`, aborta o candidato no limite e devolve `504 combo_target_timeout`. A suíte existente também confirma a propagação do abort e o failover.

O timeout de 120 s é de resposta/prontidão do alvo, não necessariamente de toda a geração SSE: depois que a resposta fica pronta, o timer do alvo é limpo e passam a governar os deadlines de readiness, corpo, idle e o sinal externo. Assim, um evento em torno de 300 s não é, sozinho, prova de que o runner por candidato deixou de abortar; pode ocorrer depois dos headers, em leitura/idle, no bridge ou no upstream.

O log histórico sanitizado contém eventos de aproximadamente 300423–300435 ms sem provider/model/correlation id suficiente para atribuição por tentativa. Também há registros históricos de erro upstream 504 e de cadeias que chegaram a cerca de 302 s. Não foi possível demonstrar, com os dados persistidos, um único candidato aguardando mais de 120 s antes dos headers sem `combo_target_timeout`.

## NVIDIA ~300s

Timeline disponível: o log histórico não preserva uma correlação por tentativa suficiente para reconstruir T0–T11. Há eventos sanitizados em torno de 300423–300435 ms sem identificação completa do alvo, além de erros upstream 504 em outras entradas; portanto não é possível atribuir os ~300 s a uma tentativa pré-headers isolada.

Expected timeout: 120000 ms para o runner de alvo no combo padrão. Observed: eventos históricos em torno de 300 s. Root cause: não determinado; o contrato interno de per-target/AbortSignal não foi refutado, e o tempo excedente pode ocorrer em stream/body, bridge ou upstream.

## Abort propagation

O `modelAbortSignal` é ligado ao controller local do runner, chega ao request de dispatch e é mesclado ao `signal` usado no executor/fetch e no stream controller. O teste focado confirmou que o abort parent chega ao alvo e que o timeout local produz `combo_target_timeout` sem lockout indevido.

## Global budget

O mecanismo de `comboTimeoutMs` existe e foi testado: com valor positivo ele interrompe a iteração restante; com valor zero todos os alvos continuam elegíveis. No auto combo padrão não foi encontrada configuração persistida que forneça um valor positivo. Portanto:

- limite de tentativas global: existe, 30;
- deadline global de tempo: existe como capacidade opt-in, mas está desativado no caminho padrão;
- causa comprovada dos eventos de ~300 s: não determinada por falta de timeline/correlation id por tentativa;
- alteração segura neste ciclo: nenhuma. Definir um novo deadline padrão exigiria política explícita, porque pode cortar gerações legítimas longas.

## Regression tests

Comando focado:

```text
node --import tsx/esm --test tests/unit/combo-target-timeout-runner.test.ts tests/unit/combo-routing-engine.test.ts
```

Resultado: **92/92 pass**, **0 fail**, incluindo:

- timeout local retorna `504 combo_target_timeout` e aborta o alvo;
- abort do parent é propagado ao filho;
- `comboTimeoutMs` positivo interrompe o combo;
- `comboTimeoutMs=0` preserva a tentativa dos alvos;
- estratégias de fallback e auto routing existentes.

Suíte adicional de pool/catalogação: **21/21 pass**, **0 fail**, cobrindo catálogo sincronizado, escopo por conexão, exclusões, no-auth e regressões de overrides.

Checks anteriores mantidos como evidência: Governor **50/50**, typecheck core **PASS** e `git diff --check` **PASS** antes desta documentação.

## Runtime validation

- 3–5: evidência histórica de 5/5 respostas HTTP 200; não repetido nesta etapa.
- 5/5: evidência histórica de 5/5; não repetido nesta etapa.
- 10/10: não concluído; a execução histórica teve alvo NVIDIA em torno de 300 s.
- 20/20: não executado nesta etapa.
- Soak 10K: não executado.

## Governor

`simulate / false / 0`

Canary: `0` — não ativado.

## Code changes

Nenhuma alteração de produção, Governor, configuração, credencial ou S3. O único artefato intencional é este relatório diagnóstico.

Commit local: `HEAD` (hash final confirmado na entrega).

Push: bloqueado pelo remoto com HTTP 403; nenhum force push foi tentado.

Preservação: bundle local criado em `C:\\Users\\in9midia\\Downloads\\OmniRoute-S3-final-backup.bundle`.

## Remaining risks

Nenhum bug de produção foi comprovado que justifique alteração mínima agora. O próximo trabalho, em tarefa separada e sem canary, deve ser dividido em duas decisões explícitas:

1. adicionar uma validade/live-cache genérica para providers static-only, se houver contrato upstream aprovado; e
2. definir e instrumentar um orçamento temporal global de auto combo, com timeline por tentativa, sem inventar um valor padrão.

Até essas decisões, o comportamento permanece fail-closed: catálogos sincronizados são respeitados, modelos static-only não são promovidos artificialmente a authoritative, e timeout desconhecido não é convertido em sucesso.

## Status final

`F — BLOCKED`

O diagnóstico e o commit local foram concluídos, mas o push foi recusado pelo remoto com HTTP 403 (`SamDevlab` sem permissão para `diegosouzapw/OmniRoute.git`). A atualização live de catálogo não foi confirmada no ambiente, o teste 10/10 segue incompleto e nenhum benchmark/canary adicional foi executado.

## Exact next action

Publicar o commit local final com uma identidade GitHub autorizada no remoto correto; não fazer force push. O commit e o bundle já estão preservados localmente.
