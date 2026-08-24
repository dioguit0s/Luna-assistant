# Onboarding — montando o Luna do zero

Guia de ambiente: do repositório clonado até falar com a Luna e acender uma luz.
Os componentes estão em ordem de dependência — cada nível só precisa dos anteriores.

| Nível | O que sobe | Precisa de |
|---|---|---|
| 1 | `luna-server` + `luna-client-test` | Só um PC e uma chave de API |
| 2 | `infra` (Home Assistant) + `luna-firmware-actuator` | Servidor Linux, ESP32 com relé |
| 3 | `luna-firmware` (satélite) | ESP32-S3 + INMP441 + MAX98357A |
| 4 | `luna-desktop` | Windows 10 |

Você pode parar em qualquer nível. O nível 1 já dá uma conversa completa por voz.

***

## Antes de tudo

| Ferramenta | Versão | Para quê |
|---|---|---|
| Node.js | **≥ 22.5** | `luna-server` — abaixo disso o `node:sqlite` não existe e o servidor morre no boot |
| Node.js | ≥ 20 | `luna-client-test`, `luna-desktop` |
| Python | 3.11+ | Sidecar de wake word do `luna-desktop` |
| PlatformIO | atual | `luna-firmware` |
| Docker + `docker compose` | Engine ≥ 24 | `infra` (**Linux apenas**) |
| ESPHome | atual | `luna-firmware-actuator` |

Chave de API de pelo menos um provider: [Google AI Studio](https://aistudio.google.com/apikey)
(Gemini, default) ou OpenAI.

> **Windows, PowerShell 5.1:** editar `.env` com `Get-Content | Set-Content` **corrompe
> os acentos**. Use o editor de texto ou `Set-Content -Encoding utf8` explícito. Vários
> `.env` do projeto têm comentários acentuados.

***

## Nível 1 — Servidor e cliente de bancada

O caminho mais curto para ver o sistema funcionando. Sem hardware nenhum.

### 1.1 Servidor

```bash
cd luna-server && cp .env.example .env && npm install
```

Preencha no `.env` o mínimo obrigatório:

```
AUDIO_PROVIDER=gemini
GEMINI_API_KEY=<sua chave>
WS_AUTH_SECRET=dev-secret-change-me
```

`WS_AUTH_SECRET` é o segredo base do HMAC dos satélites. **Anote:** este mesmo valor
vai no `secrets.h` do firmware e no `.env` do desktop — se divergir, a autenticação
falha com `auth_error`.

```bash
cd luna-server && npm run dev
```

Deve logar `Banco de lembretes aberto` e o servidor escutando na 8080.

Confira o health:

```bash
curl http://localhost:8080/health
```

### 1.2 Cliente de bancada

Em outro terminal:

```bash
cd luna-client-test && cp .env.example .env && npm install && npm run dev:mic
```

No Windows o `naudiodon` precisa do PortAudio — detalhes e alternativa por WAV no
[README do client-test](../luna-client-test/README.md).

Fale e ouça a resposta. Nos logs do servidor procure `ttfab` (meta: < 800 ms) e
`model_decision_ms`.

### 1.3 Verificação do nível 1

- [ ] `GET /health` responde `200` com o provider correto
- [ ] Áudio ida e volta pelo microfone do PC
- [ ] Multi-turno: apresente-se, depois pergunte seu nome — o
      [ring buffer](arquitetura-servidor.md#caminho-de-um-turno) guarda 10 turnos / 5 min
- [ ] Trocar `AUDIO_PROVIDER` para `openai` e reiniciar funciona **sem tocar em código**

***

## Nível 2 — Home Assistant e atuador

### 2.1 Home Assistant

**Precisa ser Linux.** O `network_mode: host` do compose não funciona no Docker Desktop
(Windows/macOS) e a descoberta mDNS falha.

```bash
cd infra && docker compose up -d
```

Conclua o onboarding em `http://<ip-do-servidor>:8123`.

### 2.2 Áreas — a decisão que amarra tudo

**As áreas do Home Assistant são a fonte de verdade dos `room_id`.** O `area_id` gerado
pelo HA precisa ser a **mesma string** usada no `ROOM_ID` do firmware, no `.env` do
desktop e no `room_id` do envelope WebSocket.

Crie as áreas antes de configurar qualquer satélite e anote os `area_id` exatos.
Convenção atual: `sala_de_estar`, `cozinha`, `quarto`. Como listá-los em
[`infra/README.md`](../infra/README.md).

### 2.3 Token

Perfil do usuário → aba **Segurança** → **Long-Lived Access Tokens** → criar. O valor
**só é exibido uma vez**. Vai para o `.env` do servidor:

```
HA_URL=http://192.168.0.10:8123
HA_TOKEN=<o token>
```

Reinicie o servidor. Ele descobre os dispositivos no boot e revalida a cada 5 min —
cadastrar um dispositivo no HA e atribuir uma área o torna acionável **sem editar
arquivo nem reiniciar**.

### 2.4 Atuador

Siga o [README do atuador](../luna-firmware-actuator/README.md): `secrets.yaml`, flash
inicial por USB, adoção no HA, depois OTA.

### 2.5 Verificação do nível 2

- [ ] Dizer "Luna, ligar a luz de teste" aciona o relé
- [ ] O log traz `command_result` com `success: true` e o `entity_id` certo
- [ ] Um dispositivo cadastrado no HA aparece acionável em até 5 min, sem restart

***

## Nível 3 — Satélite ESP32-S3

Pinagem completa e as armadilhas de hardware em [`PINAGEM_EPICO_2.md`](PINAGEM_EPICO_2.md).

> **Se o speaker só chiar:** BCLK no GPIO8 corrompe o clock do I2S. BCLK vai no
> **GPIO16** e LRC no **GPIO17** — já corrigido no `config.h`, mas é o erro de montagem
> mais provável ao replicar a protoboard.

```bash
cd luna-firmware && cp include/secrets.h.example include/secrets.h
```

Preencha `WIFI_SSID`, `WIFI_PASS`, `LUNA_HOST` (IP do servidor na LAN), `ROOM_ID`
(idêntico ao `area_id` do HA) e `WS_AUTH_SECRET` (idêntico ao do servidor).

> O `WS_AUTH_SECRET` do `secrets.h` só é usado no **provisionamento do primeiro boot**:
> o firmware grava na NVS e passa a ler de lá. Para trocar depois, `pio run -t erase`
> ou `SecretStore::setAuthSecret()`.

```bash
cd luna-firmware && pio run -t upload -t monitor
```

Valide em fases, não tudo de uma vez — a sequência está no
[README do firmware](../luna-firmware/README.md#validação-faseada).

### Verificação do nível 3

- [ ] Conecta no Wi-Fi e recebe `auth_ok` no monitor serial
- [ ] "Hey Luna" deixa o LED RGB **sólido** (era azul respirando devagar) e dispara o chirp
- [ ] Resposta audível e inteligível no speaker
- [ ] Falar durante a resposta **não** reacorda o satélite (AEC + wake word desligada
      em `RESPONDING`)

Se o detector não subir, o firmware cai para open-mic em vez de ficar mudo
(`setWakeWordAvailable(false)`). `WAKE_WORD_ENABLED=0` no `config.h` força esse modo.

***

## Nível 4 — Desktop (Windows)

```bash
cd luna-desktop && copy .env.example .env && npm install
```

O `npm install` baixa ~150 MB de Electron. Preencha `WS_AUTH_SECRET` (idêntico ao do
servidor), `WS_SERVER_URL` e `ROOM_ID`. O `DEVICE_ID` é um UUID gerado sozinho no
primeiro boot, em `%APPDATA%\luna-desktop\device.json`.

```bash
cd luna-desktop && npm run dev
```

`dev` roda `tsc`, copia o HTML do renderer e só então chama o Electron — rodar
`electron .` direto usa código velho. O sidecar de wake word é Python, com venv
próprio; setup em [`wakeword-sidecar/README.md`](../luna-desktop/wakeword-sidecar/README.md).

***

## Tarefas comuns

### Rodar os testes

```bash
cd luna-server && npm test
```

```bash
cd luna-server && npx tsc --noEmit
```

```bash
cd luna-desktop && npm run test:wakeword
```

### Adicionar um cômodo

1. Crie a área no Home Assistant e **anote o `area_id`**.
2. Use essa string exata no `ROOM_ID` do satélite (`secrets.h` ou `.env` do desktop).
3. Se quiser um rótulo falável ("a cozinha"), acrescente em `ROOM_LABELS`
   ([`luna-system-prompt.ts`](../luna-server/src/prompts/luna-system-prompt.ts)). Sem
   isso a Luna diz `o ambiente "cozinha"` — funciona, mas soa robótico.

### Adicionar um teste no servidor

Escreva o `*.test.ts` **e acrescente o caminho à mão** no script `test` do
`package.json`. Ele lista os arquivos um a um, sem glob: teste não listado nunca roda,
nem local nem no CI. É a regressão silenciosa mais provável do repositório.

### Mexer numa mensagem do protocolo

O contrato vive em **quatro** cópias. O checklist está em
[`protocolo-websocket.md`](protocolo-websocket.md).

### Diagnosticar latência

Suba `GEMINI_DEBUG_MESSAGES=true` (ou `OPENAI_DEBUG_MESSAGES=true`) e observe `ttfab` e
`model_decision_ms`. Os knobs de VAD e `thinkingBudget` estão na
[tabela de variáveis](../luna-server/README.md#variáveis-de-ambiente).

Medições de 19/07/2026 **não** mostraram ganho ajustando a janela do VAD — o gargalo
está no modelo, não no endpointing. Os knobs seguem como ferramenta de diagnóstico.

### Retreinar a wake word

```bash
bash wake-training/run.sh all
```

Roda em Docker. Estado do modelo atual e o que fazer se sair fraco em
[`wake-training/README.md`](../wake-training/README.md).

***

## Onde procurar quando algo quebra

| Sintoma | Comece por |
|---|---|
| Satélite não autentica | `WS_AUTH_SECRET` divergente; NVS com segredo velho (`pio run -t erase`) |
| `auth_error: room_id fora do formato` | `room_id` precisa casar `/^[a-z0-9_]{1,64}$/` |
| Comando de voz não acha o dispositivo | Área do HA não bate com o `ROOM_ID`; ou falta apelido no `devices.json` |
| Satélite mudo depois de uma resposta | Preso em `RESPONDING` — ver [garantias de `speaking_end`](protocolo-websocket.md#garantias-de-speaking_end) |
| Resposta longa cortada no meio | Pacing / `RESPONDING_TIMEOUT_MS` — mesma seção |
| Speaker só chia | BCLK/LRC no GPIO8/9 em vez de 16/17 |
| Servidor morre no boot | Node < 22.5 (`node:sqlite`), ou o banco de lembretes não abriu |
| Deploy quebrou após mexer na unit | A unit **não** é reinstalada pelo deploy — [`deploy/README.md`](../luna-server/deploy/README.md) |
| Acentos virando lixo no `.env` | `Get-Content \| Set-Content` no PowerShell 5.1 |

A lista completa de armadilhas do repositório está em [`CLAUDE.md`](../CLAUDE.md).
