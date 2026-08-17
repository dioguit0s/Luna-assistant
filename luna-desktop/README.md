# Luna Desktop

Satélite virtual da Luna: app de bandeja no Windows, com a mesma experiência de
voz do satélite ESP32-S3 — sem hardware dedicado.

Plano completo em [`docs/luna-desktop.md`](../docs/luna-desktop.md).

## Estado atual — marco 3 de 5

O que já funciona: ícone na bandeja com estado, menu, autostart no login, trava
de instância única, o round-trip de áudio completo (captura via Web Audio,
WebSocket autenticado, streaming de `audio_chunk`, playback da resposta), e
agora um **sidecar de wake word isolado** (`wakeword-sidecar/`) — roda fora do
Electron, recebe `.wav` ou stdin, confirma detecção de "Hey Luna" via stdout.
Ver [`wakeword-sidecar/README.md`](wakeword-sidecar/README.md).

O que **ainda não** existe: o sidecar **ligado** à máquina de estados (marco
4) — hoje o mic ainda streama **continuamente** para o servidor assim que
autenticado, sem filtro nenhum; o sidecar roda em paralelo, mas não interrompe
nem inicia o streaming sozinho. Nem a validação final do M3 com voz real
gravada (a máquina onde o M3 foi implementado não tinha como gravar áudio) —
ver a seção "Wake word" abaixo.

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

**Streaming contínuo:** enquanto não mutado (menu *Mutar microfone*), o app
manda tudo que o mic capta para o `luna-server` — não há wake word neste
marco para filtrar. Para debugar visualmente a captura (nível de mic, erros),
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

Neste marco (M3) o sidecar roda **isolado** — o Electron ainda não o inicia.
Isso é o marco 4.

## Conexão e áudio

- **Reconexão automática:** se o `luna-server` cair ou não estiver no ar, o
  tray fica vermelho (*Erro*) e o app tenta reconectar com backoff exponencial
  (1s → 30s, com jitter). Volta sozinho para *Ouvindo* assim que o servidor
  sobe de novo — não precisa reiniciar o app. Um `WS_AUTH_SECRET` errado
  também deixa o tray vermelho, mas com backoff fixo em 30s (não adianta
  tentar rápido — o secret não se corrige sozinho).
- **TTFAB no log:** cada resposta loga `[TTFAB] speaking_start→áudio: Xms` —
  comparável à métrica do [`luna-client-test`](../luna-client-test).
- **"Forçar escuta agora"** interrompe uma resposta em andamento (equivalente
  manual ao barge-in que o wake word do marco 4 vai disparar sozinho): corta o
  playback na hora e volta a ouvir. Frames de áudio que o servidor já tinha
  mandado antes da interrupção são descartados, não tocam por cima da fala
  seguinte.
- **Watchdogs:** se o servidor parar de responder no meio de um turno
  (`thinking` por 15s ou `speaking` por 5s sem novo chunk), o app volta a
  ouvir sozinho em vez de ficar surdo pra sempre — mesma classe de bug do
  corte de VAD já visto neste projeto.

## Ícones

```bash
npm run icons
```

Gera `assets/tray-*.png` (16px, `@1.5x`, `@2x`) com Node puro — sem dependência
de rasterização. Os PNGs são commitados; só rode isso depois de mexer na paleta
ou na geometria em [`scripts/generate-icons.mjs`](scripts/generate-icons.mjs).

Uma cor por estado: cinza (ociosa), azul (ouvindo), âmbar (pensando), verde
(falando), vermelho (erro).

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
