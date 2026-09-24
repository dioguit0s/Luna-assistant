# ADR 010 — Painel de controle: API admin no servidor e configuração no SQLite

**Status:** Proposto
**Data:** 2026-09-24
**Contexto:** Painel de controle do `luna-desktop` ([docs/painel-de-controle.md](../painel-de-controle.md))

## Contexto

O `luna-desktop` nasceu como **satélite virtual**: um app de bandeja que fala o
mesmo protocolo WS do ESP32 ([luna-desktop.md](../luna-desktop.md)). A próxima
etapa é ele virar também o **painel de controle** da Luna — ver satélites, ligar
integrações (Home Assistant, o app de agendas), gerenciar lembretes, ajustar o
comportamento — sem deixar de responder como satélite.

Quase nada do que o painel precisa configurar vive no desktop. Vive no servidor,
e de um jeito que não aceita escrita pela rede:

1. **A configuração é lida uma vez, no boot.** `loadConfig()` monta um
   `AppConfig` a partir do `.env` (`/etc/luna-server.env` em produção) e o objeto
   é injetado por construtor em `RoomManager`, `HomeAssistantClient`, `WsServer`,
   `WeatherSource`. Mudar qualquer coisa é editar o arquivo à mão e reiniciar.
2. **O `devices.json` é somente leitura em produção.** Ele mora em
   `config/` **dentro da release** (`/opt/luna/current`), que o `activate.sh`
   substitui a cada deploy, e a unit roda sob `ProtectSystem=strict`. Uma edição
   feita pelo painel falharia na escrita — e, se não falhasse, sumiria no
   próximo push em `main`.
3. **O protocolo WS não tem canal de administração.** É um contrato de
   satélite (`auth`, `audio_chunk`, `ping`…) copiado em quatro lugares sem
   gerador nem teste cruzado (ver `CLAUDE.md`).

Restrições de produto, decididas com o usuário:

- **Um usuário só**, sem papéis nem permissões.
- **Só na rede de casa**: o painel roda no PC do usuário, na mesma LAN do
  servidor (`192.168.0.0/24`). Sem acesso de fora.
- **Configuração aplicada sem editar arquivo e, onde der, sem reiniciar** — a
  escolha foi explicitamente pela melhor experiência, não pelo caminho mais
  simples.
- **Sem histórico de conversa.** O painel não guarda nem mostra o que foi dito.

## Decisão

### 1. Uma API HTTP de administração, separada do protocolo WS

O servidor ganha rotas `/admin/v1/*` no **mesmo servidor HTTP que já responde
`/health`** (`WsServer.start()`), na mesma porta. O protocolo WS fica intacto.

- JSON sobre HTTP, sem nada específico do Electron. Um painel web ou de celular
  no futuro é só outro cliente da mesma API.
- Eventos ao vivo (satélite conectou, log do servidor) via **Server-Sent
  Events**, não WebSocket: é só servidor → painel, e SSE não disputa o
  `WebSocketServer` dos satélites nem o `maxPayload` de 64 KB dele.

Colocar mensagens de administração no WS foi rejeitado: multiplicaria por
quatro o custo de cada mudança de contrato, e misturaria no mesmo canal um
cliente de áudio de tempo real e um cliente de formulário.

### 2. Autenticação própria, e só para a LAN

- **Token de administração dedicado**, `LUNA_ADMIN_TOKEN`, no `.env` do servidor.
  Vai no header `Authorization: Bearer`, comparado com `timingSafeEqual`.
  **Nunca** o `WS_AUTH_SECRET`: vazar o segredo gravado na flash de um satélite
  não pode dar acesso a trocar o token do Home Assistant.
- **Sem token configurado, a API admin não existe** (404 em tudo). Falha
  fechada: um servidor recém-instalado não sobe com a administração aberta.
- **Só aceita origem de rede privada ou loopback** (`remoteAddress` em
  `10/8`, `172.16/12`, `192.168/16`, `127/8`, `::1`). É defesa em
  profundidade para o dia em que alguém abrir a porta no roteador por causa
  dos satélites — não substitui o token.
- **Sem TLS nesta versão.** Na LAN de casa, com um usuário só, o risco aceito é
  alguém na mesma rede capturar o token em trânsito. Se o painel um dia sair da
  LAN, TLS deixa de ser opcional e este ADR precisa ser revisto.
- No desktop, o token fica no processo principal, cifrado com `safeStorage` do
  Electron (DPAPI no Windows). A janela do painel nunca o vê.

### 3. Configuração de runtime passa a viver no SQLite

**Regra única: `.env` e `devices.json` são semente, o banco é a verdade.**

A configuração se divide em dois grupos:

| Grupo | Onde vive | Exemplos | Por quê |
|---|---|---|---|
| **Bootstrap** | `.env`, como hoje | `WS_PORT`, `WS_AUTH_SECRET`, `LUNA_ADMIN_TOKEN`, `LUNA_DB_PATH`, `LOG_LEVEL` | Precisa existir antes de o banco abrir, ou é o que autentica quem mexe no banco |
| **Runtime** | Tabela nova no SQLite | HA (`HA_URL`, `HA_TOKEN`), provedor de IA (provider, modelos, voz, chaves, VAD, thinking), clima, agenda, overrides de dispositivos, mapeamento sala ↔ área, nomes de satélites, comportamento | É o que o painel edita |

- **Semeadura:** no primeiro boot com a tabela de configuração vazia, o
  servidor importa os valores de runtime do `.env` e do `devices.json`. Daí em
  diante o banco manda. Se o `.env` trouxer um valor de runtime diferente do
  banco, o servidor loga um aviso (`config_env_ignored`) em vez de aplicá-lo em
  silêncio ou ignorá-lo em silêncio.
- **Migração aditiva**, com as mesmas regras do [ADR 005](005-persistencia-no-servidor.md):
  `user_version`, sem renomear nem remover coluna, `VACUUM INTO` antes de
  migrar. O `ReminderStore` deixa de ser o único ponto de SQL do servidor — a
  configuração ganha o seu próprio wrapper (`SettingsStore`), no mesmo banco.
- **Validação no servidor, antes de gravar.** Cada grupo tem um validador (o
  mesmo que `loadConfig` usa hoje). A API devolve 422 com o campo errado; o
  banco nunca recebe configuração inválida.

### 4. Segredos no banco

Chaves de API e o token do HA passam de `/etc/luna-server.env` (dono `root`,
modo `600`) para `/var/lib/luna-server/luna.db`. Mitigações:

- **A API nunca devolve um segredo.** Leitura mostra só "definido, termina em
  `…a1b2`". Escrita é só de substituição. O painel não tem como exibir uma
  chave que já foi gravada.
- **`StateDirectoryMode=0700`** na unit, para o diretório do banco não ficar
  legível por outros usuários do host (o default do systemd é `0755`).
  Lembrete da pegadinha do `CLAUDE.md`: a unit **não** é reinstalada pelo
  deploy — essa mudança exige o `sudo cp` + `daemon-reload` manuais.
- As cópias `luna.db.pre-v<N>-*` que o servidor faz antes de migrar também
  carregam os segredos, e herdam a mesma proteção por estarem no mesmo
  diretório. O backup exportado pelo painel (v2) vai **sem** os segredos.

Cifrar os segredos dentro do banco foi rejeitado: a chave teria que morar no
`.env` do mesmo host, lida pelo mesmo usuário `luna`. Seria criptografia com a
chave ao lado do cofre — complexidade sem ganho real de segurança.

### 5. Aplicação a quente, por grupo

Trocar `AppConfig` imutável por uma fonte de configuração observável
(`settings.current()` + `onChange`), e cada consumidor declarar quando a
mudança vale:

| Grupo | Quando vale | Como |
|---|---|---|
| Provedor de IA (provider, modelo, voz, VAD, thinking) | **Na próxima sessão** de cada sala | A sessão em curso não é derrubada no meio de uma frase; o painel mostra "vale na próxima conversa" |
| Home Assistant | Imediato | `HomeAssistantClient` reconfigurável + refresh forçado do registro de dispositivos |
| Overrides de dispositivos, mapeamento sala ↔ área | Imediato | Refresh forçado do registro |
| Clima | Imediato | A `WeatherSource` passa a ficar atrás de um *holder* trocável, recriada com as novas coordenadas |
| Agenda | Imediato | A fonte da agenda nasce já atrás de um *holder* |
| Comportamento (não perturbe, instruções extras) | Na próxima sessão | Entra no system prompt montado em `RoomManager` |
| Bootstrap | Só com restart | Continua no `.env`; o painel só mostra |

Continua existindo um **"reiniciar servidor"** no painel, como saída de
emergência: o servidor encerra com o shutdown gracioso que já existe e o
`Restart=always` da unit o traz de volta.

### 6. No desktop: uma janela nova, isolada da janela de áudio

O painel mora no **mesmo app**, mas numa `BrowserWindow` própria, nunca na
janela oculta de captura (`src/main/window.ts`). Essa janela foi afinada só para
áudio, e três escolhas dela não servem ao painel:

- `backgroundThrottling: false` — ali é o que impede o AudioWorklet de atrasar;
  uma interface pesada no mesmo renderer disputaria a thread com o áudio.
- `setPermissionRequestHandler` na `session.defaultSession` libera `media` sem
  perguntar — o painel usa uma `partition` própria para não herdar isso.
- `sandbox: false`, aceito ali porque a página é só nossa — o painel exibe dado
  vindo de fora (títulos da agenda, nomes do HA) e roda com `sandbox: true`,
  `contextIsolation`, preload mínimo e CSP restritiva.

O cliente da API admin vive no processo principal (`src/main/admin/`). A janela
fala só com ele, por IPC. Fechar o painel não encerra o app: o satélite
continua escutando.

## Consequências

### Positivas

- Nenhuma edição de `.env` ou `devices.json` à mão para o dia a dia —
  inclusive a pegadinha do PowerShell corrompendo acentos some para esses
  casos.
- Mudanças de HA, dispositivos e clima valem sem restart; as de provedor, na
  próxima conversa.
- O protocolo WS e o firmware não mudam para a v1 do painel.
- Um painel web ou de celular no futuro reaproveita a API inteira.

### Negativas

- **Refatoração transversal no servidor**: `AppConfig` é injetado em quase todo
  módulo. Tirar dele o que é runtime é o maior custo desta decisão, e tem que
  vir antes de qualquer tela que escreva configuração.
- **Segredos saem de `/etc` e vão para o banco**, e com eles para as cópias
  pré-migração. O modelo de ameaça continua "o host é confiável", mas a
  superfície no disco cresce.
- **Duas fontes durante a transição**: quem editar o `.env` depois da
  semeadura vai ver o aviso no log, não a mudança aplicada. Precisa estar
  escrito no `deploy/README.md` e no `onboarding.md`.
- **O `devices.json` versionado deixa de ser a fonte depois do primeiro boot.**
  Correções como as de `aliases` passam a ser feitas pelo painel, e o arquivo
  vira só a semente de uma instalação nova.
- Um servidor HTTP que antes só respondia `/health` passa a aceitar escrita.
  Cada rota nova de `/admin` é superfície de ataque, e merece a mesma revisão
  que uma mudança de contrato.

## Alternativas consideradas

### Painel escreve no `.env` e reinicia o servidor (rejeitada)

Mais simples: nenhuma refatoração de `AppConfig`, segredos continuam em `/etc`.
Rejeitada porque o processo roda sob `ProtectSystem=strict` sem permissão de
escrita em `/etc` (liberar isso seria pior que ter os segredos no banco), porque
cada ajuste derrubaria todas as salas e qualquer alarme tocando, e porque não
resolve o `devices.json`, que está dentro da release.

### Mensagens de administração no protocolo WS (rejeitada)

Ver decisão 1.

### Painel como app separado do satélite desktop (rejeitada)

Com um usuário só, no mesmo PC e na mesma rede, um segundo app duplicaria a
configuração de conexão e o instalador, e perderia acesso direto ao que só o
processo do satélite sabe (nível do microfone, score da wake word). A API ser
HTTP genérica mantém aberta a porta para um painel separado depois.

### Cifrar segredos no banco (rejeitada)

Ver decisão 4.

## Referências

- [painel-de-controle.md](../painel-de-controle.md) — inventário de funções e marcos
- [ADR 005](005-persistencia-no-servidor.md) — o banco e as regras de migração que esta decisão herda
- [ADR 009](009-inventario-por-comodo.md) — o `list_devices` que a tela de salas espelha
- [luna-desktop.md](../luna-desktop.md) — o satélite desktop que ganha o painel
- [`luna-server/deploy/README.md`](../../luna-server/deploy/README.md) — passo manual da unit
