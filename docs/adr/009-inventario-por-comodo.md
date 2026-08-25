# ADR 009 — Inventário por cômodo: `list_devices` aceita o `room_id` do modelo

**Status:** Aceito
**Data:** 2026-08-25
**Contexto:** Tool `list_devices` ([docs/arquitetura-servidor.md](../arquitetura-servidor.md#function-calling))

## Contexto

A Luna sabia *acionar* aparelhos, mas não sabia dizer o que existe. Perguntada "quais
aparelhos você controla?" ou "quais luzes tem na cozinha?", ela caía na regra
anti-alucinação do prompt ("Essa eu não sei") ou, pior, respondia de conhecimento
paramétrico — inventando aparelhos que não estão cadastrados, ou omitindo os que estão.

O catálogo já existe pronto no servidor: `DeviceRegistrySource` descobre os dispositivos
no próprio Home Assistant e mantém um snapshot em memória (ver
[ADR 002](002-function-calling-contract.md)), e `DeviceRegistry` já expõe
`devicesInRoom(roomId)` e `rooms` — usados até aqui só para log, diagnóstico e o
`scripts/devices-smoke.ts`. Faltava só uma tool que os expusesse ao modelo.

O ponto que exigia uma decisão explícita, e não só "copiar `control_device`": o ADR 002
estabelece que **o `room_id` gerado pelo modelo é sempre descartado**, porque o modelo
alucina o cômodo (caso documentado na LUNA-306, sessão em `sala_de_estar` produzindo
`room_id: "cozinha"`). Uma tool de listagem sem parâmetro de cômodo, porém, não consegue
responder "quais luzes tem na cozinha?" perguntado de outro cômodo — um caso de uso
central do pedido.

## Decisão

### `room_id` do modelo é aceito, validado, com fallback — exceção ao ADR 002

`list_devices` valida o `room_id` recebido contra `DeviceRegistry.resolveRoom()` (novo
método, mesma normalização de caixa/espaço que `resolve()` já fazia) e o usa quando
resolve para um `area_id` real. Quando o campo vem ausente, vazio, ou não resolve contra
nenhum cômodo conhecido, cai no `roomId` da sessão (`ctx.roomId`) — a mesma fonte de
verdade que `control_device` usa sempre.

Isso é uma exceção **restrita à tool ser somente leitura**. Em `control_device`, um
`room_id` alucinado aciona o aparelho errado — irreversível e silencioso, o usuário não
tem como saber que a luz da sala acendeu quando ele pediu a da cozinha. Em
`list_devices`, o pior caso de um cômodo alucinado é ler a lista errada em voz alta — o
próprio usuário percebe na hora ("mas eu perguntei da cozinha"), porque a resposta sempre
nomeia o cômodo que foi de fato consultado. O descarte do ADR 002 continua absoluto em
toda tool que aciona algo; aqui ele vira validação porque o dano de errar é diferente.

### Só nomes, zero estado, zero I/O

O handler lê apenas `deviceRegistry.current()`, síncrono — mesmo desenho que
`getWeather.ts` já estabeleceu ([ADR 008](008-tempo-e-previsao.md)): a tool não faz
round-trip nenhum no caminho fala→resposta. Estender para incluir estado
ligado/desligado exigiria um `getState` por entidade (`HomeAssistantClient.getState()` é
uma chamada por `entity_id`), ou seja, N round-trips seriais dentro do turno — o mesmo
problema que fez `get_weather` preferir cache a fetch síncrono. `control_device` só aceita
seu único `await` ao HA por ser um POST LAN (~20-40 ms); N chamadas para listar um cômodo
não teria essa desculpa.

### A mesma tool devolve os cômodos conhecidos

Uma tool a mais custa orçamento de instrução da sessão Live e infla o `model_decision_ms`
(ADR 002, "cada tool nova custa TTFAB") — a mesma razão que fez `manage_reminders` virar
uma tool com `action: enum` em vez de quatro. `list_devices` devolve, no mesmo retorno,
`rooms` (via `DeviceRegistry.rooms`, já existente) — cobre "que ambientes você controla?"
sem um segundo schema, e também melhora a resposta quando o cômodo pedido não existe: a
Luna pode dizer o que existe de verdade em vez de só "não encontrei".

## Consequências

### Positivas

- A Luna responde ao caso de uso que motivou o ADR sem inventar aparelho nem cômodo.
- Zero I/O novo: nenhum risco à meta de TTFAB.
- `DeviceRegistry.resolveRoom()` e `inRoom()` (exportada, antes privada) ficam
  disponíveis para qualquer tool futura que precise da mesma validação.

### Negativas

- **O descarte de `room_id` deixa de ser regra universal e vira uma decisão por tool.**
  Mitigado por este ADR, pelo teste que fixa o comportamento
  (`listDevices.test.ts`, "room_id do modelo, conhecido e diferente da sessão, é
  respeitado") e pela ressalva explícita no comentário de `ToolContext.roomId` e em
  `arquitetura-servidor.md`. Quem adicionar uma tool nova precisa decidir de novo, não
  presumir.
- A lista fica até `DEVICE_REGISTRY_TTL_MS` (5 min) atrás do que está de fato no HA —
  mesmo custo que `control_device` e o smoke script já pagam.
- `friendly_name` é texto que a pessoa escreveu no HA para uso visual, não para fala —
  a Luna passa a falar exatamente o que foi cadastrado, sem revisão.
- Sem estado: "a luz está acesa?" continua sem resposta própria — deliberado, ver acima.
  O prompt instrui a Luna a admitir isso e oferecer acionar, em vez de silenciar a
  pergunta ou inventar um estado.

## Alternativas consideradas

### Descartar `room_id` como em `control_device` (rejeitada)

Mantém a regra universal do ADR 002 sem exceção, mas torna irrespondível o caso central
do pedido: "quais luzes tem na cozinha?" dito da sala de estar sempre listaria a sala.

### `enum` dinâmico com os cômodos conhecidos no schema (rejeitada)

Evitaria qualquer validação em runtime — o próprio schema já restringiria os valores
aceitos. Mas `ToolDefinition` é uma constante de módulo compartilhada por todas as
sessões (`RoomManager.ts`); um enum dinâmico exigiria montar o schema por sessão a partir
do snapshot do HA, acoplando a declaração da tool ao registro e reconstruindo-a a cada
cômodo novo cadastrado. A validação em `resolveRoom()` já é o lugar certo — o registro é
justamente onde ela é confiável.

### Tool separada `list_rooms` (rejeitada)

Resolveria "que ambientes você controla?" sem tocar em `list_devices`, mas custa uma tool
inteira de TTFAB para uma pergunta que `rooms` no mesmo retorno já cobre de graça.

### Incluir estado ligado/desligado (rejeitada)

Ver "Só nomes, zero estado, zero I/O" acima — I/O serializado no caminho crítico, sem
desenho de cache que o justifique hoje. Pode voltar como extensão futura se `HomeAssistantClient`
ganhar um método de estado em lote (ex.: via `/api/template`, como `listAreaEntities()`
já faz para o catálogo).

## Referências

- [ADR 002](002-function-calling-contract.md) — contrato de tools, schema plano, descarte
  de `room_id`
- [ADR 008](008-tempo-e-previsao.md) — mesmo padrão de handler sem round-trip
- [`luna-server/src/ha/`](../../luna-server/src/ha/)
- [`luna-server/src/orchestrator/tools/listDevices.ts`](../../luna-server/src/orchestrator/tools/listDevices.ts)
