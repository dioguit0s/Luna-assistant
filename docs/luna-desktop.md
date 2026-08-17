# Luna Desktop — plano de implementação

**Status:** Em andamento — marco 5 de 5 (polimento) com código, testes e instalador prontos; falta a validação manual final (tray/autostart/voz a partir do app instalado), ver seção Verificação
**Data:** 2026-08-17

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

O contrato dos modelos (`.tflite` do preprocessador + do "Hey Luna") já está resolvido e documentado — ver [`luna-firmware/models/README.md`](../luna-firmware/models/README.md) e [`docs/adr/003-wake-word-engine.md`](adr/003-wake-word-engine.md): preprocessador `[1,480]` int16 → `[40]` int8, modelo wake `[1,stride,40]` int8 → `[1,1]` uint8 (`prob = raw/255`), stride lido do tensor (**3** para `hey_luna_trained`/`okay_nabu`, os modelos em uso; 2 para os `hey_luna` comunitários). Bindings TFLite pra Node são escassos/não mantidos no Windows; reimplementar o preprocessamento (mel filterbank, PCAN etc.) em JS arrisca sutilmente divergir do que já foi validado no hardware real.

Em vez disso: um processo Python sidecar (`luna-desktop/wakeword-sidecar/`) que carrega o `.tflite` do modelo wake e replica a lógica de janela/stride/refratário do `WakeWord.cpp` do firmware. O processo principal do Electron sobe esse sidecar (`child_process.spawn`), manda frames PCM16 16kHz cru pelo stdin, e lê eventos de wake (linha JSON) pelo stdout.

**O plano original desta seção estava errado em dois pontos, corrigidos no marco 3 (ver [ADR 004](adr/004-wake-word-no-desktop.md)):**

- **As dependências não vêm do `wake-training/Dockerfile`.** `tflite-runtime`, `tensorflow` e `tflite-micro` não têm wheel para Windows + Python 3.14 (verificado em 2026-08-17) — o ambiente do `wake-training/` é Linux/Python 3.11 e continua sendo só o ambiente de *treino*. O sidecar tem seu próprio `requirements.txt`: [`ai-edge-litert`](https://pypi.org/project/ai-edge-litert/) (sucessor mantido do `tflite-runtime`, com wheel para Windows/py3.14) carrega o modelo wake.
- **O preprocessador `.tflite` não é carregável fora do tflite-micro.** `audio_preprocessor_int8.tflite` roda em kernels `tflite::tflm_signal` (`SignalWindow`, `SignalRfft`, `SignalPcan`, ...) que só existem nesse runtime; tentar carregá-lo com `ai-edge-litert` falha com `RuntimeError: Encountered unresolved custom op: SignalWindow`. No lugar dele, o sidecar usa [`pymicro-features`](https://pypi.org/project/pymicro-features/) — o mesmo micro frontend em C++, embalado como wheel `abi3` standalone, e coincidentemente a implementação que o próprio microWakeWord usou para gerar as features de *treino* dos modelos vendorizados. Como o firmware copia a saída int8 do preprocessador crua para dentro do modelo wake (sem dequantizar), o sidecar precisa reconstruir essa quantização a partir de uma constante (`FEATURE_SCALE`, resolvida empiricamente — ver `wakeword-sidecar/README.md`) em vez de herdá-la de graça.

Detalhe completo (paridade linha a linha com `WakeWord.cpp`, protocolo stdin/stdout, calibração) em [`luna-desktop/wakeword-sidecar/README.md`](../luna-desktop/wakeword-sidecar/README.md).

Empacotamento do Python: para v1, exigir um Python local (`requirements.txt` próprio do sidecar, não do `wake-training/`); empacotar como binário standalone (PyInstaller) fica como follow-up se a fricção de instalação incomodar.

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
  wakeword-sidecar/   # sidecar Python (requirements.txt próprio) + fixtures/
  assets/             # ícones de tray por estado
  .env.example
  package.json
```

## Ordem de construção (marcos, cada um verificável isoladamente)

1. ✅ **Esqueleto Electron + tray** — app sobe, ícone na bandeja, menu Sair funciona, autostart configurável. Sem áudio ainda. Valida empacotamento/single-instance antes de qualquer complexidade de áudio.
2. ✅ **Round-trip de áudio sem wake word** — protocolo/auth portados (`src/main/ws/`), captura via Web Audio no renderer (janela oculta), streaming contínuo pro `luna-server`, playback da resposta. Validado ponta a ponta contra o `luna-server` local: auth_ok, sessão Gemini Live aberta, TTFAB logado. Reconexão com backoff (o `luna-client-test` não tinha — um app de bandeja não pode sair no primeiro erro), watchdogs contra turno travado, e uplink pausado durante `speaking`/`thinking` (a captura em si nunca para — é o caminho que o barge-in por wake word do M4 vai reusar via `session.forceListen()`, já exposto manualmente no menu). Detalhes em [`luna-desktop/README.md`](../luna-desktop/README.md).
3. ✅ **Sidecar de wake word isolado** — script Python (`luna-desktop/wakeword-sidecar/`) roda sozinho, `--wav`/`--stdin` na CLI, confirma detecção via stdout (JSON lines) e diagnóstico em stderr (`--trace`, `--feature-stats`). Paridade com `WakeWord.cpp` coberta por testes puros (`detector_test.py`, sem tflite/pymicro). Validado ponta a ponta com voz real gravada via `LUNA_DUMP_MIC`: **teste de controle com `okay_nabu.tflite` passou** (8/8 repetições de "okay nabu" detectadas, `mean_prob` 0.970-0.993, recall ~100%) — confirma que a pipeline do sidecar (`pymicro-features` + `FEATURE_SCALE=1.0` + `detector.py`) está correta. **`hey_luna_trained.tflite` (o modelo do satélite) só detectou 3 de 10** "hey luna" reais (recall ~30%) — quando dispara é com confiança e sem falso-positivo, mas a maioria das tentativas nem chega perto do cutoff. Confirma o risco já documentado no manifesto do modelo (`test_auc: 0.536`), pior na prática que os números de treino. Falso-positivo testado com 50s de ruído de fundo → 0 detecções nos dois modelos (`max_mean_prob` 0.29 e 0.017, ambos abaixo do cutoff 0.97) — curto demais pra ser prova robusta, mas sinal positivo; uma sessão ≥15min fica como follow-up recomendado, não bloqueia o marco. **Decisão em aberto pro M4**: usar `hey_luna_trained` assim mesmo (recall baixo, mas sem falso-positivo), trocar por `okay_nabu` como provisório (mesma saída que o ADR 003 tomou no firmware por motivo idêntico), ou aguardar um modelo "hey luna" retreinado — ver `wakeword-sidecar/README.md`.
4. ✅ **Integrar sidecar na máquina de estados** — `Session` (`session.ts`) ganhou um gate explícito de "aguardando wake" (`awaitingWake`, `onWakeDetected()`, `setSidecarHealthy()`): o app agora começa em `idle` depois de autenticar, sem fazer streaming automático — o uplink só abre com um "Hey Luna" real (evento `wake` do sidecar) ou o bypass manual de "Forçar escuta agora" (`forceListen()`, que passou a abrir o gate a partir do repouso em vez de ser no-op). Novo módulo `src/main/wakeword/`: `protocol.ts` parseia as linhas JSON de stdout do sidecar (`ready`/`wake`/`eof`/`error`, nunca lança); `sidecar.ts` sobe `wake_sidecar.py --stdin` como processo filho (mesmo padrão de reconexão com backoff de `ws/client.ts`), alimenta PCM cru via stdin, e reinicia sozinho se o processo cair. `index.ts` liga tudo: `onMicFrame` passa a alimentar o sidecar (pausado quando mudo — mutar muta a detecção de wake também) além do `luna-server`; eventos do sidecar viram `session.onWakeDetected()`/`session.setSidecarHealthy()`. Ícones de tray não precisaram de mudança estrutural — já eram genéricos sobre os 5 `AppState`. Modelo default mantido em `hey_luna_trained.tflite` (decisão tomada apesar do recall baixo medido no M3), configurável via `WAKEWORD_MODEL`/`WAKEWORD_THRESHOLD` no `.env` sem mudar código. `npm test` (55/55) e `npx tsc --noEmit` passam limpos — **falta o teste manual ponta a ponta com voz real**, ver seção Verificação.
5. ✅ **Polimento** — revisão do menu mutar/forçar-escuta à luz do gate de wake word do M4 (achou e corrigiu um bug real: `forceListen()` enquanto mudo pré-armava o gate silenciosamente, fazendo o próximo "desmutar" pular a exigência de um novo "Hey Luna" — `session.ts` agora ignora `forceListen()`/`onWakeDetected()` enquanto mudo, item de menu correspondente fica desabilitado, e o tray/cabeçalho do menu passam a distinguir "mudo" de "aguardando 'Hey Luna'", antes indistinguíveis sob o mesmo estado `idle`). `electron-builder` com alvo NSIS (`electron-builder.yml`) gera o instalador — inclui o sidecar de wake word (código-fonte + os dois `.tflite` vendorizados via `extraResources`, já que só `luna-desktop/` é empacotado e o caminho default do modelo era relativo ao monorepo) e um ícone de app gerado em Node puro (`scripts/generate-app-icon.mjs`, mesmo padrão de `generate-icons.mjs`). Validando o instalador nesta sessão apareceu um segundo bug de empacotamento, também corrigido: a resolução do `.env` (`config.ts`) apontava pra dentro do `app.asar` (somente leitura) quando empacotado — agora usa `userData` e semeia o `.env` a partir de um `.env.example` bundlado na primeira execução. README de setup atualizado (estava descrevendo o comportamento pré-M4 de streaming contínuo sem wake word).

## Verificação

- M1: ✅ rodar `npm run dev`, confirmar ícone na bandeja e que fechar/reabrir não duplica instância.
- M2: ✅ confirmado contra o `luna-server` local (mesmo `WS_AUTH_SECRET`, porta 8086): `auth_ok` recebido, `device_id` (UUID) persistido em `userData`, captura de mic real inicializada (getUserMedia + AudioWorklet, sem addon nativo), e o servidor abriu sessão Gemini Live + sala ao receber os primeiros `audio_chunk` — confirma que os frames de áudio chegaram e foram aceitos. Falta ainda um teste manual de ponta a ponta com resposta falada audível e cronometragem de TTFAB por um humano (o smoke test automatizado desta sessão não tem microfone/alto-falante para validar o áudio em si, só o protocolo).
- M3: ✅ `--wav luna-client-test/fixtures/silence.wav` → 0 detecções, 66 inferências, `max_mean_prob` 0.0. `okay_nabu.tflite` (controle) → 8/8 detecções em "okay nabu" real, `mean_prob` 0.970-0.993 — confirma a pipeline do sidecar de ponta a ponta (features + quantização + detector). `hey_luna_trained.tflite` (modelo do satélite) → 3/10 detecções em "hey luna" real — recall baixo (~30%), mas zero ambiguidade quando dispara e zero falso-positivo; achado real a considerar no M4, não um bug do sidecar. `noise-smoke.wav` (50s de ruído) → 0 detecções nos dois modelos. Fixtures commitadas em `wakeword-sidecar/fixtures/`; números completos e a discussão de recall em `wakeword-sidecar/README.md`.
- M4: ✅ automatizado — `npm test` (55/55) cobre a máquina de estados nova (`awaitingWake` interagindo com `forceListen()`/`setMuted()`/`setSidecarHealthy()`/watchdogs) e o parser `wakeword/protocol.ts` (`ready`/`wake`/`eof`/`error`, tolerância a linha inválida/desconhecida). `npx tsc --noEmit` limpo. ✅ **Teste manual ponta a ponta confirmado pelo usuário** (2026-08-17): "Hey Luna" + transição de ícone no tray, mute, forçar escuta e recuperação de crash do sidecar rodaram certo.
- M5: ✅ automatizado — `npm test` (59/59, cobre os casos novos de mute/forceListen/idleQualifier) e `npx tsc --noEmit` limpos. `npm run package:win` gera o instalador; verificado nesta sessão que o pacote contém `dist/`, `assets/` (incluindo `icon.ico`) e os deps de produção (`dotenv`, `ws`) dentro do `asar`, e `resources/wakeword-sidecar/` (código-fonte + `hey_luna_trained.tflite` + `okay_nabu.tflite`, sem `.venv`/`fixtures`) fora dele. Rodando o app empacotado (`win-unpacked/Luna Desktop.exe`) direto, sem o checkout do monorepo por perto: primeira execução sem `.env` em `userData` semeia um a partir do `.env.example` bundlado (UTF-8 preservado, conferido por fora do console do PowerShell) e fica em estado de erro esperando `WS_AUTH_SECRET`, sem crashar; uma segunda instância é bloqueada pelo `requestSingleInstanceLock()`; encerramento não deixa processo órfão. **Falta:** validação manual — ícone/estados na bandeja visíveis, autostart escrevendo o registro de verdade a partir do clique no menu (só testável com o app instalado, GUI), e "Hey Luna" funcionando a partir da instalação depois de montar o `.venv` em `resources/wakeword-sidecar/` (sem `luna-server` rodando nesta máquina no momento do teste).

## Fora de escopo para v1

- Janela de configurações / troca de sala em runtime.
- Histórico/transcrição de conversa na UI.
- Atalhos de Home Assistant na tray.
- Empacotamento standalone do sidecar Python (PyInstaller) — v1 assume Python instalado localmente.
