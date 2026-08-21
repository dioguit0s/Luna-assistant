# Luna Server

Orquestrador central do Projeto Luna: recebe áudio dos satélites por WebSocket,
mantém uma sessão de IA por cômodo, aciona o Home Assistant por function calling e
agenda alarmes e lembretes.

- **Mapa dos módulos e caminho de um turno:** [`docs/arquitetura-servidor.md`](../docs/arquitetura-servidor.md)
- **Contrato de mensagens:** [`docs/protocolo-websocket.md`](../docs/protocolo-websocket.md)
- **Deploy:** [`deploy/README.md`](deploy/README.md)

## Pré-requisitos

- **Node.js >= 22.5** — o `node:sqlite` (banco de lembretes) não existe abaixo disso e
  o processo morre no boot
- Chave de API do provider configurado (`GEMINI_API_KEY` ou `OPENAI_API_KEY`)

## Setup

```bash
cd luna-server
cp .env.example .env
# Edite .env: no mínimo GEMINI_API_KEY e WS_AUTH_SECRET
npm install
```

## Executar

```bash
npm run dev
```

## Testes

```bash
npm test
```

```bash
npx tsc --noEmit
```

> **Atenção ao adicionar um teste:** o script `test` lista os arquivos **um a um, sem
> glob**. Todo `*.test.ts` novo precisa ser acrescentado à mão ao `package.json`, senão
> nunca roda — nem local, nem no CI.

## Variáveis de ambiente

Referência canônica. A fonte da verdade no código é
[`src/config/env.ts`](src/config/env.ts) — todo valor passa por `loadConfig()`, que
falha no boot se algo estiver inválido.

### Núcleo

| Variável | Default | Descrição |
|----------|---------|-----------|
| `AUDIO_PROVIDER` | `gemini` | `gemini` ou `openai` |
| `GEMINI_API_KEY` | — | Chave Google AI. **Obrigatória** quando `AUDIO_PROVIDER=gemini` |
| `OPENAI_API_KEY` | — | Chave OpenAI. **Obrigatória** quando `AUDIO_PROVIDER=openai` |
| `WS_AUTH_SECRET` | — | **Obrigatória sempre.** Segredo base do HMAC dos satélites; a única variável sem default |
| `WS_PORT` | `8080` | Porta do WebSocket e do `GET /health` |
| `LOG_LEVEL` | `info` | Nível do pino |
| `PROVIDER_CONNECT_TIMEOUT_MS` | `5000` | Teto do `connect()` do provider. Sem ele, um blackhole de rede deixa a sala muda até o processo reiniciar |

### Gemini

| Variável | Default | Descrição |
|----------|---------|-----------|
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | Modelo da Live API |
| `GEMINI_VAD_SILENCE_MS` | `500` | Janela de silêncio que fecha o turno. Vazio usa o default do SDK (bem mais longo) |
| `GEMINI_VAD_END_SENSITIVITY` | `HIGH` | `HIGH` fecha o turno assim que a fala para; `LOW` é mais tolerante a pausas |
| `GEMINI_MANUAL_ACTIVITY` | `false` | Push-to-talk: desliga o VAD e exige `activity_end` explícito do cliente |
| `GEMINI_THINKING_BUDGET` | `0` | `0` desabilita o thinking, `-1` deixa o modelo decidir, `off` omite o campo (modelos half-cascade rejeitam `thinkingConfig`) |
| `GEMINI_DEBUG_MESSAGES` | `false` | Loga mensagens cruas, **incluindo transcrição da fala do usuário** |

`thinkingBudget: 0` é o default porque, para um vocabulário de tools pequeno, o
raciocínio roda inteiro **antes** da tool call e custa cerca de 1 s dentro do
`model_decision_ms` — direto no atraso percebido.

Se o VAD estiver cortando frases no meio (pausa para pensar virando fim de turno),
suba `GEMINI_VAD_SILENCE_MS` **antes** de voltar para `LOW`.

### OpenAI

| Variável | Default | Descrição |
|----------|---------|-----------|
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Modelo Realtime |
| `OPENAI_VAD_TYPE` | `server_vad` | `server_vad` corta por silêncio; `semantic_vad` decide pelo conteúdo e **ignora** `OPENAI_VAD_SILENCE_MS` |
| `OPENAI_VAD_SILENCE_MS` | `500` | Janela de silêncio do `server_vad` |
| `OPENAI_VOICE` | `marin` | Voz da resposta |
| `OPENAI_DEBUG_MESSAGES` | `false` | Loga mensagens cruas, incluindo transcrição da fala |

### Endpointing comum

| Variável | Default | Descrição |
|----------|---------|-----------|
| `USER_SILENCE_CUTOFF_MS` | `500` | Silêncio sem novo fragmento de fala até o servidor mandar `speaking_start` — sem esperar o primeiro áudio de resposta |

Fecha a janela em que o LED do satélite seguia aceso com o comando já capturado
(modelo/TTS ainda processando), evitando que o usuário fale por cima de um turno em
voo. No Gemini é essencial: sem o debounce, cortaria no primeiro fragmento de
transcrição, ainda no meio da frase.

### Home Assistant

| Variável | Default | Descrição |
|----------|---------|-----------|
| `HA_URL` | — | Ex: `http://192.168.0.10:8123` |
| `HA_TOKEN` | — | Long-Lived Access Token |
| `DEVICES_CONFIG_PATH` | `config/devices.json` | **Overrides** do registro (apelidos, exclusões, entradas manuais). O catálogo em si vem do HA |
| `DEVICE_REGISTRY_TTL_MS` | `300000` | Revalidação do registro: dispositivo novo fica acionável sem restart |

Caminho relativo ao `WorkingDirectory` do serviço — por isso o `config/` acompanha
cada release no deploy.

### Alarmes e lembretes

| Variável | Default | Descrição |
|----------|---------|-----------|
| `LUNA_DB_PATH` | ver abaixo | Caminho **absoluto** do banco SQLite |
| `MISSED_GRACE_MS` | `900000` | Carência do catch-up: lembrete mais atrasado que isto no boot não toca |
| `ALARM_MAX_RING_MS` | `300000` | Teto do ciclo de toque; fecha `ringing` órfão no boot |
| `REMINDER_MAX_CONCURRENT` | `20` | Teto de disparos simultâneos — 20 alarmes não podem abrir 20 sessões de provider |
| `REMINDER_MAX_PER_ROOM` | `20` | Teto de lembretes vivos por sala; contém um loop de tool calls |
| `REMINDER_FALLBACK_ROOM_ID` | vazio | Cômodo de fallback quando o satélite de origem está offline. Vazio **desliga** o fallback |

Precedência do caminho do banco: `LUNA_DB_PATH` → `$STATE_DIRECTORY` do systemd →
`./.luna-state/luna.db`. É absoluto de propósito: o `activate.sh` troca o symlink de
`/opt/luna/current` a cada deploy e poda releases antigas, então um default relativo
apontaria justamente para o diretório que some.

O fallback de cômodo é **burro de propósito** — config fixa, não "onde tem gente".
Silêncio é melhor que adivinhar errado o cômodo.

### Notas

O adapter da OpenAI fala a API Realtime **GA** (`session.type: 'realtime'`), não a
beta — `gpt-4o-realtime-preview-*` não serve. Para comparar latência entre os dois
providers de forma justa, mantenha `OPENAI_VAD_SILENCE_MS` igual ao
`GEMINI_VAD_SILENCE_MS`: a janela de endpointing entra inteira no `ttfab`.

Medições de 19/07/2026 **não** mostraram ganho ajustando a janela do VAD — o gargalo
está no modelo, não no endpointing. Os knobs seguem como ferramenta de diagnóstico.

O `HA_TOKEN` é gerado na UI do Home Assistant: perfil do usuário → aba *Segurança* →
**Long-Lived Access Tokens** → *Criar token*. O valor só é exibido uma vez. Ver
[`infra/README.md`](../infra/README.md) para a subida do serviço.

## Verificação rápida

1. Suba o servidor: `npm run dev`
2. Confira o health: `curl http://localhost:8080/health`
3. Em outro terminal, suba o cliente de bancada em [`luna-client-test`](../luna-client-test/README.md)
4. Fale no microfone e procure `ttfab` nos logs (meta: < 800 ms)
5. Multi-turno: apresente-se e pergunte seu nome em seguida
6. Troque `AUDIO_PROVIDER` no `.env` e reinicie — sem alteração de código

> O campo de latência é **`ttfab`**, não `latency_ms`. A âncora da medição é o último
> instante de fala do usuário, não o último chunk recebido — ver
> [`metrics/ttfab.ts`](src/metrics/ttfab.ts).

## Deploy

CI dispara em push na `main` que toque `luna-server/**`: guard de versão do Node,
testes, build, montagem da release e `activate.sh` com health check e rollback.

Runbook completo, layout no servidor e rollback manual em
[`deploy/README.md`](deploy/README.md).

> **A unit systemd não é reinstalada pelo deploy.** O `activate.sh` só copia `dist/` e
> `config/`; mudar a unit exige `sudo cp` + `daemon-reload` manuais no servidor. O
> `activate.sh` falha rápido com `cmp` ao detectar a divergência, mas o passo manual é
> responsabilidade de quem mexe na unit.
