# Luna Desktop

Satélite virtual da Luna: app de bandeja no Windows, com a mesma experiência de
voz do satélite ESP32-S3 — sem hardware dedicado.

Plano completo em [`docs/luna-desktop.md`](../docs/luna-desktop.md).

## Estado atual — marco 1 de 5

O que já funciona: ícone na bandeja com estado, menu, autostart no login e trava
de instância única.

O que **ainda não** existe: captura de microfone, WebSocket com o `luna-server`,
wake word "Hey Luna". Os itens *Mutar microfone*, *Forçar escuta agora* e
*Configurações* aparecem no menu desabilitados — o formato do menu já é o final,
só falta a lógica dos marcos 2 e 4.

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

O `.env` ainda não é lido por ninguém — ele documenta o contrato que o marco 2
vai consumir.

## Executar

```bash
npm run dev
```

`dev` compila com `tsc` e só então chama `electron .` — o Electron carrega
`dist/main/index.js`, não TypeScript. Rodar `electron .` direto sem build usa
código velho (ou falha com "Cannot find module").

Para iterar, `npm run watch` num terminal e `npm start` no outro. Saia pelo menu
antes de recompilar: com o app aberto o Windows trava os arquivos e o `tsc`
reclama de EPERM.

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

Cobrem os módulos puros (`state.ts`, `menu.ts`) — o resto depende do runtime do
Electron e é verificado à mão. **Todo `*.test.ts` novo precisa ser adicionado na
mão ao script `test` do `package.json`**: ele lista os arquivos um a um, sem
glob (mesma pegadinha do `luna-server`).

Não há CI para este diretório — o workflow do repositório só cobre
`luna-server/**`.

## Home Assistant

`ROOM_ID=desktop_diogo` é uma sala nova e não corresponde a nenhuma área do Home
Assistant. Quando o marco 2 ligar a conversa, comandos de dispositivo disparados
daqui não vão resolver a nada físico até você criar a área correspondente no HA
(ou apontar o `ROOM_ID` para uma área existente, abrindo mão do isolamento de
sessão). Não bloqueia a conversa por voz — só o "acende a luz daqui".
