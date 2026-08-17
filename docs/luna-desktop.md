# Luna Desktop — plano de implementação

**Status:** Em andamento — marco 2 de 5 concluído (round-trip de áudio sem wake word)
**Data:** 2026-08-16

## Objetivo

Hoje só existe um jeito de falar com a Luna: o satélite físico ESP32-S3 (`luna-firmware`). Este documento planeja um segundo "satélite virtual" — `luna-desktop` — rodando no desktop Windows do usuário: mesma experiência de voz (wake word → conversa → resposta falada), sem hardware dedicado.

Existe hoje um [`luna-client-test/`](../luna-client-test) (Node/TS) que já fala o protocolo do `luna-server` corretamente (auth HMAC, framing binário PCM16, captura de mic via `naudiodon`, playback), mas foi construído só como ferramenta de instrumentação de latência (mede TTFAB, salva `.wav`, sem UI, sem wake word, sem tray). Não é o produto final, mas prova que o protocolo funciona a partir de um PC — e boa parte da sua lógica de protocolo/auth deve ser portada, não reescrita.

## Decisões de produto

- **Ativação:** wake word local ("Hey Luna"), não push-to-talk. Reaproveita o modelo já treinado e validado para o firmware.
- **UI:** tray app minimalista (ícone de bandeja com estado, sem janela permanente).
- **Stack:** app novo em Electron (não uma extensão do `luna-client-test`, mas reaproveitando a lógica de protocolo dele).
- **Sala:** `room_id` dedicado e novo (ex. `desktop_diogo`), separado dos satélites físicos.

## Decisões técnicas

### 1. Captura e playback de áudio: Web Audio no renderer, não addon nativo

`naudiodon`/`node-speaker` (usados no `luna-client-test`) são addons nativos compilados contra o Node do sistema. Rodando em Electron eles precisam ser recompilados contra o ABI do Electron (`@electron/rebuild`) e frequentemente quebram em update de versão — fonte de dor recorrente.

Em vez disso: usar `getUserMedia` + `AudioWorklet` num `BrowserWindow` (pode ser oculto — não precisa aparecer, só existir pra dar acesso às Web APIs) pra capturar o mic, converter pra PCM16 mono 16kHz (o mic tipicamente entrega 48kHz — resample no worklet), e mandar os frames pro processo principal via IPC (`ipcRenderer.send`). Playback do `audio_response` funciona ao contrário: processo principal recebe PCM da WS e manda pro renderer tocar via `AudioContext`.

Vantagem: zero addon nativo pra áudio, funciona com o Chromium embarcado do Electron sem rebuild.

### 2. Wake word: sidecar Python, não binding TFLite em Node

O contrato dos modelos (`.tflite` do preprocessador + do "Hey Luna") já está resolvido e documentado — ver [`luna-firmware/models/README.md`](../luna-firmware/models/README.md) e [`docs/adr/003-wake-word-engine.md`](adr/003-wake-word-engine.md): preprocessador `[1,480]` int16 → `[40]` int8, modelo wake `[1,2,40]` int8 → `[1,1]` uint8 (`prob = raw/255`), stride lido do tensor. Bindings TFLite pra Node são escassos/não mantidos no Windows; reimplementar o preprocessamento (mel filterbank, PCAN etc.) em JS arrisca sutilmente divergir do que já foi validado no hardware real.

Em vez disso: um processo Python sidecar (mesmo ambiente já validado em [`wake-training/`](../wake-training) — `tflite-runtime` ou `tensorflow`, tirado do `Dockerfile` de lá) que carrega os `.tflite` vendorizados de `luna-firmware/models/` e replica a lógica de janela/stride do `WakeWord.cpp` do firmware. O processo principal do Electron sobe esse sidecar (`child_process.spawn`), manda frames PCM16 16kHz cru pelo stdin, e lê eventos de wake (linha JSON) pelo stdout. Reaproveita o pipeline já comprovado em vez de reescrever a inferência.

Empacotamento do Python: para v1, exigir um Python local (documentar `requirements.txt` derivado do `wake-training/Dockerfile`); empacotar como binário standalone (PyInstaller) fica como follow-up se a fricção de instalação incomodar.

### 3. Máquina de estados — espelha o firmware

Mesmos 3 estados do `StateMachine.h` do firmware, mais um "pensando" que o desktop pode expor visualmente (o firmware não distingue):

- **Idle** — mic aberto localmente, frames só vão pro sidecar Python (wake word). Nada é enviado pro `luna-server`. WS pode ficar conectado e autenticado em background (menor latência pra começar a falar) ou reconectar sob demanda — decidir na implementação, autenticar cedo é mais simples.
- **Ouvindo (ACTIVE_STREAMING)** — disparado pelo evento de wake do sidecar. Passa a enviar `audio_chunk` (PCM16, 640 bytes/20ms, igual ao firmware) pro `luna-server`.
- **Pensando** — do fim do envio até o primeiro `audio_response` chegar (equivalente ao TTFAB já instrumentado no `luna-client-test`).
- **Falando (RESPONDING)** — entre `speaking_start` e `speaking_end`; toca os PCM chunks recebidos via `AudioContext` no renderer.

Volta pra Idle depois de `speaking_end` (ou timeout, mesmo padrão do `flushResponseWav`/`scheduleResponseSave` do client-test).

### 4. Identidade e config

Portar (não reescrever) a lógica de `luna-client-test/src/config.ts` e `src/protocol.ts` — já implementam `computeAuthToken` (HMAC-SHA256), `createEnvelope`/`serializeControlMessage`/`parseIncomingMessage` compatíveis com o `MessageEnvelope` do `luna-server/src/ws/protocol.ts`. Não há motivo pra reescrever esse contrato do zero.

- `device_id`: gerar um UUID na primeira execução e persistir em `userData` (via `electron-store` ou um JSON simples) — não é a MAC de um ESP32, mas cumpre o mesmo papel.
- `room_id`: fixo em `.env` (ex. `desktop_diogo`), não escolhido em runtime (decisão já tomada).
- `WS_AUTH_SECRET` e URL do servidor: `.env` gitignored, mesmo modelo de confiança do `luna-client-test` — **nunca commitar** (mesma pegadinha já documentada no `CLAUDE.md` do repo pra outros secrets).

### 5. Nota sobre Home Assistant (avisar o usuário, não bloqueia v1)

`room_id` novo não bate com nenhum `area_id` existente no HA. Comandos de controle de dispositivo (`command_result`) disparados a partir do desktop **não vão resolver** a nenhum device físico até o usuário criar uma área no HA correspondente a `desktop_diogo` (ou apontar o `room_id` do desktop pra uma área já existente, abrindo mão do isolamento de sessão/zona). Não bloqueia a conversa por voz — só o "acender a luz daqui".

### 6. Tray UX

- Ícone muda com o estado (idle/ouvindo/pensando/falando) — reaproveitar o mesmo conceito de LED do firmware (`StatusLed.cpp`), agora com mais granularidade.
- Menu: **Mutar microfone** (para o sidecar de escutar sem fechar o app), **Forçar escuta agora** (bypassa o wake word manualmente — fallback caso o wake falhe, útil pra debug), **Configurações** (abre `.env`/pasta de config — sem UI dedicada em v1), **Sair**.
- `app.requestSingleInstanceLock()` — evita duas instâncias brigando pelo mic/WS.
- Autostart no login do Windows via `app.setLoginItemSettings({ openAtLogin: true })`, mas **desligado por padrão** — usuário liga pelo menu depois de validar que funciona.

## Estrutura do projeto

Novo diretório `luna-desktop/` (irmão de `luna-server`, `luna-firmware`, `luna-client-test`), Electron + TypeScript:

```
luna-desktop/
  src/
    main/           # processo principal: WS client, state machine, tray, sidecar lifecycle
      ws/           # protocol.ts, config.ts, auth.ts portados do luna-client-test
      wakeword/      # spawn do sidecar Python, protocolo stdin/stdout
      tray.ts
    renderer/        # janela oculta: captura (getUserMedia+AudioWorklet) e playback (AudioContext)
    preload.ts
  wakeword-sidecar/   # script Python + requirements.txt (deriva de wake-training/Dockerfile)
  assets/             # ícones de tray por estado
  .env.example
  package.json
```

## Ordem de construção (marcos, cada um verificável isoladamente)

1. ✅ **Esqueleto Electron + tray** — app sobe, ícone na bandeja, menu Sair funciona, autostart configurável. Sem áudio ainda. Valida empacotamento/single-instance antes de qualquer complexidade de áudio.
2. ✅ **Round-trip de áudio sem wake word** — protocolo/auth portados (`src/main/ws/`), captura via Web Audio no renderer (janela oculta), streaming contínuo pro `luna-server`, playback da resposta. Validado ponta a ponta contra o `luna-server` local: auth_ok, sessão Gemini Live aberta, TTFAB logado. Reconexão com backoff (o `luna-client-test` não tinha — um app de bandeja não pode sair no primeiro erro), watchdogs contra turno travado, e uplink pausado durante `speaking`/`thinking` (a captura em si nunca para — é o caminho que o barge-in por wake word do M4 vai reusar via `session.forceListen()`, já exposto manualmente no menu). Detalhes em [`luna-desktop/README.md`](../luna-desktop/README.md).
3. **Sidecar de wake word isolado** — script Python roda sozinho, recebe um `.wav` de fixture (reaproveitar `luna-client-test/fixtures/silence.wav` + gravar um "hey luna" real), confirma detecção via stdout. Testado fora do Electron primeiro.
4. **Integrar sidecar na máquina de estados** — gatilho de wake liga o streaming; ícones de tray refletem idle/ouvindo/pensando/falando.
5. **Polimento** — mutar/forçar-escuta no menu, `electron-builder` pra gerar instalador Windows, README de setup (`.env`, dependência do Python).

## Verificação

- M1: ✅ rodar `npm run dev`, confirmar ícone na bandeja e que fechar/reabrir não duplica instância.
- M2: ✅ confirmado contra o `luna-server` local (mesmo `WS_AUTH_SECRET`, porta 8086): `auth_ok` recebido, `device_id` (UUID) persistido em `userData`, captura de mic real inicializada (getUserMedia + AudioWorklet, sem addon nativo), e o servidor abriu sessão Gemini Live + sala ao receber os primeiros `audio_chunk` — confirma que os frames de áudio chegaram e foram aceitos. Falta ainda um teste manual de ponta a ponta com resposta falada audível e cronometragem de TTFAB por um humano (o smoke test automatizado desta sessão não tem microfone/alto-falante para validar o áudio em si, só o protocolo).
- M3: rodar o sidecar isolado contra a fixture e contra fala real gravada, conferir que só dispara em "Hey Luna" (checar falso-positivo com TV/conversa de fundo, mesmo teste que validou o firmware).
- M4/M5: teste manual ponta a ponta — falar "Hey Luna" longe do teclado, confirmar transição de ícone idle→ouvindo→pensando→falando e resposta correta; testar timeout/erro de auth (`.env` errado) mostra estado de erro no tray, não crash silencioso.

## Fora de escopo para v1

- Janela de configurações / troca de sala em runtime.
- Histórico/transcrição de conversa na UI.
- Atalhos de Home Assistant na tray.
- Empacotamento standalone do sidecar Python (PyInstaller) — v1 assume Python instalado localmente.
