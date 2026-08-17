# Luna Desktop

Satélite virtual da Luna: app de bandeja no Windows, com a mesma experiência de
voz do satélite ESP32-S3 — sem hardware dedicado.

Plano completo em [`docs/luna-desktop.md`](../docs/luna-desktop.md).

## Estado atual — marco 5 de 5 (polimento)

O que já funciona: ícone na bandeja com estado, menu (mutar microfone, forçar
escuta, autostart, configurações), trava de instância única, o round-trip de
áudio completo (captura via Web Audio, WebSocket autenticado, streaming de
`audio_chunk`, playback da resposta), e o **sidecar de wake word ligado à
máquina de estados**: o app começa em repouso ("Ociosa — aguardando 'Hey
Luna'"), sem streamar nada pro servidor até um "Hey Luna" real (ou o bypass
manual "Forçar escuta agora"). Validado ponta a ponta com voz real — ver
[`docs/luna-desktop.md`](../docs/luna-desktop.md) para o histórico completo
dos marcos 1-4.

Marco 5 (em andamento): empacotamento num instalador Windows (ver seção
"Empacotar" abaixo) e este próprio README.

## Pré-requisitos

- Node.js >= 20 (o gerador de ícones e os testes rodam em Node puro)
- Windows 10 — v1 é Windows-only

## Setup

```bash
cd luna-desktop
copy .env.example .env
npm install
```

O `npm install` baixa o binário do Electron (~150 MB). Atrás de proxy, use
`ELECTRON_MIRROR` ou coloque o zip à mão em `%LOCALAPPDATA%\electron\Cache`.

Preencha o `.env`:

```
WS_AUTH_SECRET=dev-secret-change-me   # precisa ser IDÊNTICO ao do luna-server
WS_SERVER_URL=ws://localhost:8080     # ou o host/porta real do luna-server
ROOM_ID=desktop_diogo
```

`DEVICE_ID` não entra no `.env` — é um UUID gerado sozinho na primeira
execução e persistido em `userData/device.json` (`%APPDATA%\luna-desktop\`).

**Editar o `.env` no PowerShell 5.1?** `Get-Content | Set-Content` corrompe
acentos (pegadinha documentada no `CLAUDE.md` do repo) — use o editor de
texto ou `Set-Content -Encoding utf8`. Como não há acento aqui, não é um
risco imediato, mas vale saber antes de editar outros `.env` do projeto.

## Executar

```bash
npm run dev
```

`dev` roda `tsc`, copia `src/renderer/index.html` para `dist/renderer/` (o
`tsc` só compila `.ts`, não copia HTML) e só então chama `electron .` — o
Electron carrega `dist/main/index.js`, não TypeScript. Rodar `electron .`
direto sem build usa código velho (ou falha com "Cannot find module" / HTML
ausente).

Para iterar, `npm run watch` num terminal e `npm start` no outro — mas
`watch` só recompila `.ts`; se você mexer em `src/renderer/index.html`, rode
`node scripts/copy-renderer.mjs` à mão antes do próximo `npm start`. Saia
pelo menu antes de recompilar: com o app aberto o Windows trava os arquivos e
o `tsc` reclama de EPERM.

### Microfone

O Windows 10 pede permissão de privacidade de microfone por app
(**Configurações → Privacidade → Microfone**) — normalmente concedida
automaticamente para o processo que chama `getUserMedia`, mas se o app ficar
em `error` mesmo com `.env` correto e o `luna-server` no ar, confira ali.

**Captura sempre ligada, envio com gate:** o mic nunca para de capturar
localmente (necessário para o barge-in por wake word), mas só manda
`audio_chunk` pro `luna-server` depois de um "Hey Luna" real (evento do
sidecar) ou de "Forçar escuta agora" no menu — em repouso, o áudio só
alimenta o detector de wake word local. *Mutar microfone* corta os dois: nem
detecção de wake, nem envio pro servidor. Desmutar não retoma sozinho — exige
um novo "Hey Luna" (ou "Forçar escuta agora", que fica desabilitado no menu
enquanto mudo). Para debugar visualmente a captura (nível de mic, erros),
rode com `LUNA_DEBUG_WINDOW=1`:

```bash
LUNA_DEBUG_WINDOW=1 npm start
```

Isso mostra a janela normalmente oculta que hospeda `getUserMedia` +
`AudioWorklet` + `AudioContext` — nunca aparece em uso normal.

**Gravar o microfone para calibrar o wake word:** `LUNA_DUMP_MIC=1` salva
tudo que passa por `onMicFrame` — o áudio pós AGC/ruído/eco do
`getUserMedia`, exatamente o que o sidecar de wake word vai ouvir em produção
— num `.wav` em `userData` (`%APPDATA%\luna-desktop\mic-dump-<timestamp>.wav`).
`LUNA_DUMP_MIC=<caminho>` grava nesse caminho exato em vez de gerar um nome.

```bash
LUNA_DUMP_MIC=1 npm run dev
```

Só grava até você sair pelo menu (o header do `.wav` só fica correto depois do
`close()`, chamado em `will-quit`). Teto de 30 minutos por padrão
(`LUNA_DUMP_MIC_SECONDS` para ajustar) — isto grava a casa continuamente
enquanto ligado, por isso é opt-in só por variável de ambiente, nunca uma
chave de `.env` que possa ficar ligada sem querer. Uso: ver
[`wakeword-sidecar/fixtures/README.md`](wakeword-sidecar/fixtures/README.md).

## Wake word (sidecar Python)

O detector de "Hey Luna" roda como processo Python separado, não como binding
TFLite no Electron — ver [`wakeword-sidecar/README.md`](wakeword-sidecar/README.md)
para o porquê e [`docs/adr/004-wake-word-no-desktop.md`](../docs/adr/004-wake-word-no-desktop.md)
para a decisão completa. Resumo prático:

```bash
cd wakeword-sidecar
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe wake_sidecar.py --wav fixtures\silence.wav --trace
```

Testes do sidecar (puro Python, sem tflite/pymicro):

```bash
npm run test:wakeword
```

Desde o marco 4, o Electron sobe o sidecar sozinho (`src/main/wakeword/`) e
liga o evento `wake` à máquina de estados — ver "Estado atual" acima.

**`WAKEWORD_MODEL`/`WAKEWORD_THRESHOLD` no `.env`** (opcionais — omitidos,
o sidecar usa os próprios defaults, `hey_luna_trained.tflite` e `0.97`):

```
WAKEWORD_MODEL=../luna-firmware/models/okay_nabu.tflite
WAKEWORD_THRESHOLD=0.97
```

`hey_luna_trained.tflite` (modelo treinado da Luna) teve recall baixo (~30%)
em voz real no M3 — dispara sem falso-positivo quando dispara, mas erra a
maioria das tentativas. `okay_nabu.tflite` é uma alternativa provisória mais
confiável (~100% recall no teste de controle), mas muda a frase de ativação
para "Okay Nabu". Detalhe completo em
[`wakeword-sidecar/README.md`](wakeword-sidecar/README.md).

## Conexão e áudio

- **Reconexão automática:** se o `luna-server` cair ou não estiver no ar, o
  tray fica vermelho (*Erro*) e o app tenta reconectar com backoff exponencial
  (1s → 30s, com jitter). Volta sozinho para *Ouvindo* assim que o servidor
  sobe de novo — não precisa reiniciar o app. Um `WS_AUTH_SECRET` errado
  também deixa o tray vermelho, mas com backoff fixo em 30s (não adianta
  tentar rápido — o secret não se corrige sozinho).
- **TTFAB no log:** cada resposta loga `[TTFAB] speaking_start→áudio: Xms` —
  comparável à métrica do [`luna-client-test`](../luna-client-test).
- **"Hey Luna" / "Forçar escuta agora"** abrem o gate a partir do repouso, ou
  interrompem uma resposta em andamento (barge-in): corta o playback na hora e
  volta a ouvir. Frames de áudio que o servidor já tinha mandado antes da
  interrupção são descartados, não tocam por cima da fala seguinte. "Forçar
  escuta agora" fica desabilitado no menu enquanto o mic está mudo.
- **Watchdogs:** se o servidor parar de responder no meio de um turno
  (`thinking` por 15s ou `speaking` por 5s sem novo chunk), o app volta a
  ouvir sozinho em vez de ficar surdo pra sempre — mesma classe de bug do
  corte de VAD já visto neste projeto.

## Ícones

```bash
npm run icons
```

Gera `assets/tray-*.png` (16px, `@1.5x`, `@2x`) e `assets/icon.ico`
(16/32/48/256px, usado pelo instalador) com Node puro — sem dependência de
rasterização. Os arquivos são commitados; só rode isso depois de mexer na
paleta ou na geometria em [`scripts/png.mjs`](scripts/png.mjs) (compartilhado
por [`generate-icons.mjs`](scripts/generate-icons.mjs) e
[`generate-app-icon.mjs`](scripts/generate-app-icon.mjs)).

Uma cor por estado: cinza (ociosa), azul (ouvindo), âmbar (pensando), verde
(falando), vermelho (erro). O ícone do app usa a cor "ociosa".

## Empacotar (instalador Windows)

```bash
npm run package:win
```

Builda (`tsc` + copy-renderer) e roda o [electron-builder](https://www.electron.build/)
(`electron-builder.yml`) com alvo NSIS. O instalador sai em
`release/Luna Desktop Setup <versão>.exe` — instala em
`%LOCALAPPDATA%\Programs\` sem exigir admin (`perMachine: false`, o default do
electron-builder), adequado pra distribuição single-user.

**O sidecar de wake word vai junto** (código Python + os dois `.tflite`
vendorizados, copiados de `luna-firmware/models/` — ver `extraResources` em
`electron-builder.yml`), mas **o `.venv` não** (v1 continua exigindo Python
local, decisão já tomada). Depois de instalar, pra "Hey Luna" funcionar:

```bash
cd "%LOCALAPPDATA%\Programs\Luna Desktop\resources\wakeword-sidecar"
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Mesmos passos de [`wakeword-sidecar/README.md`](wakeword-sidecar/README.md),
só que a partir da instalação em vez do checkout do repo.

**`.env` na primeira execução:** o instalador não pergunta nada — na primeira
vez que o app roda sem um `.env` em `userData`
(`%APPDATA%\luna-desktop\.env`), ele copia sozinho o modelo bundlado
(`.env.example`) pra lá e fica em estado de erro até você abrir
"Configurações" no menu, preencher `WS_AUTH_SECRET` (idêntico ao do
`luna-server`) e reiniciar o app.

## Bandeja

**O Windows 10 esconde ícones novos no overflow.** Se o ícone não aparecer,
clique no chevron `^` ao lado do relógio e arraste a Luna para a área visível —
é o falso-negativo mais comum ao testar.

Clique esquerdo ou direito abrem o mesmo menu.

## Autostart

O item *Iniciar com o Windows* vem **desligado**. Ligá-lo escreve em
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; o registro é a fonte da
verdade (o menu lê de lá toda vez que é aberto), então não há estado duplicado.
Ressalva: desativar pelo Gerenciador de Tarefas usa uma flag separada
(`StartupApproved\Run`) que o checkbox não consulta — para desligar de fato,
desmarque pelo próprio menu da Luna.

Para conferir ou remover à mão:

```bash
powershell -Command "Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'"
```

Em desenvolvimento a entrada aponta para o `electron.exe` de `node_modules` com
o caminho do projeto — funciona, mas o teste de verdade desse item só acontece
com o app empacotado (marco 5). **Desligue o toggle antes de apagar ou mover
`node_modules`** (reinstalar, trocar de pasta/máquina): a entrada do registro
ficaria órfã e o Windows mostra um diálogo de erro no login seguinte, sem jeito
de o app limpar isso sozinho.

## Testes

```bash
npm test
```

```bash
npx tsc --noEmit
```

Cobrem os módulos puros (`state.ts`, `menu.ts`, `session.ts`, o protocolo WS em
`main/ws/protocol.ts`, a conversão PCM em `shared/pcm.ts`, o header WAV em
`shared/wav.ts` e o gravador em `main/mic-dump.ts`) — o resto (janela
oculta, captura/playback de verdade, WebSocket contra um servidor real)
depende do runtime do Electron e é verificado à mão, com o `luna-server`
rodando. **Todo `*.test.ts` novo precisa ser adicionado na mão ao script
`test` do `package.json`**: ele lista os arquivos um a um, sem glob (mesma
pegadinha do `luna-server`).

O sidecar de wake word (`wakeword-sidecar/`) tem testes Python próprios,
fora do `npm test`:

```bash
npm run test:wakeword
```

Não há CI para este diretório — o workflow do repositório só cobre
`luna-server/**`.

## Home Assistant

`ROOM_ID=desktop_diogo` é uma sala nova e não corresponde a nenhuma área do Home
Assistant. Comandos de dispositivo disparados daqui não vão resolver a nada
físico até você criar a área correspondente no HA (ou apontar o `ROOM_ID` para
uma área existente, abrindo mão do isolamento de sessão). Não bloqueia a
conversa por voz — só o "acende a luz daqui".
