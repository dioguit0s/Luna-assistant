# Painel de controle — plano

**Status:** v1 e v2 implementadas (marcos 1–11) e validadas manualmente no app instalado e no servidor de produção (2026-11-17); a agenda por voz entrou ([ADR 011](adr/011-agenda-compasso.md)); a tela da Agenda ("o que a Luna vê hoje" e histórico, migração 5) entrou em 2026-11-19; fora da v2 ficou o "não perturbe"
**Data:** 2026-09-24
**Decisão de arquitetura:** [ADR 010](adr/010-painel-de-controle-e-api-admin.md)

## Objetivo

Transformar o `luna-desktop` também no **painel de controle** da Luna: uma janela
de configurações para ver satélites, ligar integrações (Home Assistant, o app de
agendas), gerenciar lembretes e ajustar o comportamento. O desktop **continua
sendo um satélite** — o painel é uma janela a mais, não um app novo.

## Decisões de produto

- **Mesmo app, janela separada** da janela oculta de captura de áudio (ver ADR 010,
  decisão 6). Fechar o painel não encerra o app.
- **Um usuário só, só na LAN de casa.** Sem papéis, sem acesso de fora.
- **Configuração no SQLite do servidor**, aplicada a quente onde der — escolhida
  pela experiência, não pela simplicidade (ADR 010, decisões 3 e 5).
- **Sem histórico de conversa.** O painel não guarda nem mostra o que foi dito.
  Logs de ação (tool chamada + resultado) e métricas de latência continuam
  permitidos, sem transcrição.
- **O app de agendas é externo e tem API REST.** O painel só guarda a conexão;
  eventos e tarefas são editados no próprio app.

## Legenda

**Precisa de** — o que cada função custa além da tela:

- **Tela**: só o `luna-desktop`
- **API**: rota nova na API admin do servidor
- **Persist**: dado novo no SQLite do servidor
- **Proto**: mudança no protocolo WS (quatro cópias — ver `CLAUDE.md`)
- **FW**: mudança no firmware do ESP32

**Quando** — **v1** mexe só em servidor e desktop; **v2** vem logo depois;
**depois** puxa protocolo e/ou firmware, ou depende de algo ainda indefinido.

## Inventário

### 1. Início

| Função | Precisa de | Quando |
|---|---|---|
| Servidor online, versão e tempo ligado | API (amplia o `/health`) | v1 |
| Semáforo por conexão: HA, provedor de IA, clima, agenda | API | v1 |
| Satélites conectados agora | API | v1 |
| Próximos lembretes e alarmes | API | v1 |
| Últimos erros (HA falhou, provedor caiu) | API + Persist | v2 ✔ |

### 2. Satélites

| Função | Precisa de | Quando |
|---|---|---|
| Lista: `device_id`, sala, online/offline, conectado desde, último ping | API | v1 |
| Nome amigável por satélite | API + Persist | v1 |
| Desconectar ou bloquear um satélite (aparelho perdido) | API + Persist | v2 ✔ |
| "Tocar som / piscar LED" para identificar | Proto + FW | depois |
| Versão do firmware, IP, sinal do Wi-Fi (`device_info`) | Proto + FW | ✔ |
| Trocar a sala sem recompilar (`set_config`; a sala vive na NVS do satélite) | Proto + FW | ✔ |
| Rotacionar o segredo (`ConfigStore::setAuthSecret` existe, nada o aciona; o canal `set_config` já serve) | Proto + FW | depois |
| Provisionar satélite novo por USB (Wi-Fi, servidor e segredo na NVS) | Tela + FW | depois |
| Volume, brilho do LED, sensibilidade da wake word por satélite | Proto + FW | depois |
| Atualização de firmware pela rede (OTA): atual × disponível no GitHub, atualizar ou voltar de versão com S/N, progresso e "revertido" ([ADR 012](adr/012-ota-de-firmware.md)) | Proto + FW + API | ✔ |

### 3. Salas e dispositivos

| Função | Precisa de | Quando |
|---|---|---|
| Salas conhecidas: dos satélites e das áreas do HA | API | v1 |
| Mapear sala da Luna ↔ área do HA (resolve o `desktop_diogo`) | API + Persist | v1 |
| O que a Luna "enxerga" em cada sala (mesma saída do `list_devices`, [ADR 009](adr/009-inventario-por-comodo.md)) | API | v1 |
| Editar apelidos (`aliases`) | API + Persist | v1 |
| Editar exclusões (`exclude`) e dispositivos manuais | API + Persist | v2 ✔ |
| "Testar": ligar/desligar um dispositivo pelo painel | API | v2 ✔ |
| Forçar refresh do registro de dispositivos do HA | API | v2 ✔ |

### 4. Integrações

| Função | Precisa de | Quando |
|---|---|---|
| **Home Assistant**: URL, token, "testar conexão" | API + Persist | v1 |
| **Agenda**: URL, credencial, "testar conexão", status | API + Persist | v1 (tela); tools de voz ✔ ([ADR 011](adr/011-agenda-compasso.md)) |
| **Provedor de IA**: Gemini ou OpenAI, modelo, voz, chaves | API + Persist | v1 |
| **Provedor de IA (avançado)**: VAD, silêncio, thinking | API + Persist | v2 ✔ |
| **Clima**: cidade (vira lat/long), "testar" | API + Persist | v2 ✔ |

### 5. Lembretes e alarmes

| Função | Precisa de | Quando |
|---|---|---|
| Listar ativos: rótulo, sala, horário, recorrência | API | v1 |
| Cancelar | API | v1 |
| Criar e editar pelo painel | API | v2 ✔ |
| Histórico: tocou, perdido, adiado | API (parte já está no banco) | v2 ✔ |

### 6. Agenda

| Função | Precisa de | Quando |
|---|---|---|
| "O que a Luna vê hoje": eventos, tarefas e aulas do dia, como ela receberia | API | v2 ✔ |
| Log do que a Luna consultou ou criou na agenda (ação e resultado, sem transcrição) | API + Persist | v2 ✔ |

Tela própria, **06 AGENDA** (as de Este terminal, Servidor e Diagnóstico desceram uma
posição; o teclado vai de 1 a 9). "O que a Luna vê hoje" chama `GET calendar/today`, que
usa a mesma `calendar/agendaQuery.ts` do `get_agenda` — não há reimplementação: a tela
mostra os itens do dia por tipo, quais cabem no teto que o modelo recebe e, recolhido, o
payload cru da tool. O histórico (`GET calendar/log`) grava ação, parâmetros de enum ou
número, resultado (`ok`, `error.code` do Compasso ou motivo de recusa) e latência — nunca
`search`, `title` ou texto falado.

Edição de eventos e tarefas fica no app de agendas — duplicar aqui só criaria
atrito.

### 7. Diagnóstico

| Função | Precisa de | Quando |
|---|---|---|
| TTFAB por satélite e por provedor, com gráfico e a meta de 800 ms | API + Persist | v2 ✔ |
| Logs do servidor ao vivo, filtro por sala e nível (SSE) | API | v2 ✔ |
| Mudar o `LOG_LEVEL` sem reiniciar | API | depois |

### 8. Este computador (o satélite desktop)

| Função | Precisa de | Quando |
|---|---|---|
| URL do servidor, segredo, sala, token admin — numa tela, não no `.env` | Tela | v1 |
| Escolher microfone e alto-falante | Tela | v1 |
| Teste de mic: nível e score da wake word ao vivo | Tela | v1 |
| Mutar, forçar escuta, autostart (hoje só na bandeja) | Tela | v1 |
| Sensibilidade da wake word | Tela + sidecar | v2 ✔ |
| Atalho global de push-to-talk | Tela | v2 ✔ ("falar agora": o `globalShortcut` só vê o aperto) |
| Notificação do Windows quando um lembrete tocar | Tela | v2 ✔ |
| Digitar para a Luna em vez de falar | Proto | depois |

### 9. Servidor

| Função | Precisa de | Quando |
|---|---|---|
| Configuração de bootstrap (porta, caminho do banco), só leitura | API | v1 |
| Reiniciar o servidor (saída de emergência) | API | v1 |
| Backup e restauração do banco, **sem segredos** | API | v2 ✔ |
| Versão implantada e data do último deploy | API | v2 ✔ |

### 10. Comportamento da Luna

| Função | Precisa de | Quando |
|---|---|---|
| "Não perturbe" global: horário em que ela não fala sem ser chamada ([ADR 007](adr/007-audio-nao-solicitado.md)) | API + Persist | v2 |
| Instruções extras de personalidade anexadas ao system prompt | API + Persist | depois |

O "não perturbe" precisa decidir o que acontece com um alarme marcado dentro da
janela — segurar até o fim dela, tocar assim mesmo ou tocar só em sala escolhida.
Decisão para quando o item entrar, não agora.

## API admin v1

Implementada em `luna-server/src/admin/AdminApi.ts`. Base `http://<servidor>:<WS_PORT>/admin/v1/`,
header `Authorization: Bearer <LUNA_ADMIN_TOKEN>`, JSON nos dois sentidos.

| Rota | O que faz |
|---|---|
| `GET status` | Versão, `release` (`{ sha, deployed_at }` do `release.json` que o CI grava, ou `null`), uptime, satélites online, semáforo por conexão (`ha`, `provider`, `weather`, `calendar`: `ok`/`error`/`unknown`/`off`) e os 5 próximos lembretes |
| `GET bootstrap` | Porta, caminho do banco, nível de log — só leitura, sem segredo |
| `GET satellites` | Conectados agora + vistos desde o boot + nomeados; `online`, `connected_since`, `last_seen_at`, `device_info` (`fw_version`, `fw_build`, `ip`, `mac`, `rssi`, `free_heap`, `uptime_ms`, `received_at` — `null` se o satélite nunca mandou, e o painel mostra "desconhecida") e `remote_address` (endereço do socket, fallback do IP) |
| `PUT satellites/:device_id` | `{ "name": "Quarto" }` — `null` ou vazio remove; `{ "blocked": true }` recusa o satélite no handshake e derruba a conexão aberta (v2) |
| `POST satellites/:device_id/disconnect` | Fecha as conexões do satélite; ele reconecta sozinho — v2 |
| `PUT satellites/:device_id/config` | `{ "room_id": "quarto" }` — manda `set_config` ao satélite conectado e só responde depois do `config_ack` (até 3 s): `200 { device_id, room_id, previous_room_id, reconnect }`. `409` offline, ocupado com um turno, conexão caiu no meio ou cliente que não suporta (desktop, bancada); `504` sem resposta (firmware anterior ao tipo); `422` sala fora do formato ou recusada. Nada é persistido no servidor — a NVS do satélite é a fonte da verdade; a troca fica no log (`satellite_room_changed`) |
| `GET firmware/releases` | Releases `fw-v*` do repositório (`FIRMWARE_RELEASES_REPO`), da mais nova para a mais velha: `version`, `tag`, `published_at`, `prerelease`, `url`, `changelog` e `manifest` (`build`, `size`, `sha256`, `date`), mais `latest` (a mais nova estável). Cache de 5 min (`?refresh=1` força); GitHub fora devolve a última lista com `stale: true` e `error`, ou `502` sem lista nenhuma |
| `POST satellites/:device_id/ota` | `{ "version": "0.6.0" }` — abre a OTA e responde `202 { device_id, ota }` com o job em `downloading`; o servidor baixa o `.bin`, confere o SHA-256, manda `ota_start` e acompanha. `409` offline ou OTA em andamento, `404` versão não publicada, `422` versão fora do semver. Recusa do satélite (ocupado, não suportado) aparece no job como `failed` |
| `GET satellites/:device_id/ota` | `{ device_id, ota }` — última OTA desde o boot do servidor, ou `null`: `state` (`downloading`, `sending`, `rebooting`, `ok`, `failed`, `rolled_back`), `target_version`, `from_version`, `percent`, `error`, `started_at`, `updated_at`, `finished_at`. A mesma coisa vem em `ota` de cada item de `GET satellites`, que o painel acompanha a cada 1,5 s durante a OTA |
| `GET backup` | Configuração de runtime (sem nenhum campo de segredo) e lembretes vivos, `format: "luna-backup"`, `version: 1` — v2 |
| `POST restore` | `{ backup, reminders: "keep" \| "replace" }`, até 1 MB. Valida todos os grupos antes de gravar; cada um entra como patch (segredo ausente mantém o gravado). `replace` cancela os lembretes vivos e recria os do arquivo, pulando único que já passou — v2 |
| `GET rooms` | Salas (de satélite, áreas do HA, mapeadas), área efetiva e o que o `list_devices` veria nelas |
| `PUT rooms/:room_id` | `{ "area": "escritorio" }` — `null` remove o mapeamento |
| `GET devices` / `PUT devices` | Overrides. `PUT` é patch de `aliases`, `exclude` e `devices` (entradas manuais no formato do `devices.json`); campo ausente mantém. `GET` traz também `ha_entities` (o que o HA descobriu, com `excluded`) e o estado do último refresh — v2 |
| `POST devices/test` | `{ entity_id, action: "on" \| "off" }` pelo HA, sem a IA. Só entidade que o registro conhece e só `switch`/`light`/`fan` — v2 |
| `POST devices/refresh` | Redescobre no HA agora, sem esperar o TTL — v2 |
| `GET reminders` | Lembretes vivos de todas as salas, com a frase falada |
| `DELETE reminders/:id` | Cancela: banco, toque em curso e scheduler |
| `POST reminders` | Cria: `{ room_id, label, repeat, date, time }` — hora de parede de São Paulo (ADR 006), `repeat` `none`/`daily`/`weekdays`/`weekend`/`mon`…`sun`, `date` só no `none`. Mesmas regras de rótulo da voz (sem "Luna", até 200). 201 — v2 |
| `PUT reminders/:id` | Edita um `armed` com o mesmo corpo; `ringing` é 409. Rótulo ou sala novos apagam a fala gravada e pedem outra — v2 |
| `GET reminders/history?limit=50` | Criado, editado, tocou, dispensado, adiado, sem resposta, perdido, cancelado — com `via` (`admin`/`voice`) quando se sabe — v2 |
| `GET settings/:grupo` | `ha`, `provider`, `calendar`, `voice` ou `weather` (os dois últimos na v2), com segredos como `{ set, last4 }` e `applies` (`immediate` / `next_session`) |
| `PUT settings/:grupo` | Patch parcial; campo ausente = mantém. 422 com `field` quando inválido |
| `POST settings/ha/test`, `POST settings/calendar/test` | Testa com o corpo completado pelo que está gravado — dá para testar sem gravar |
| `POST settings/weather/test` | Busca a previsão para `{ latitude, longitude }` (ou as gravadas) sem gravar; devolve a temperatura atual — v2 |
| `POST settings/weather/geocode` | `{ city }` → até 5 candidatos `{ label, latitude, longitude }` pelo geocoding do Open-Meteo — v2 |
| `POST restart` | 202 e shutdown gracioso; o `Restart=always` traz de volta |
| `GET calendar/today` | "O que a Luna vê hoje", pela mesma função do `get_agenda({ when: "today" })`: `state` (`ok` / `off` sem URL ou credencial / `error` com `error: { code, message }` do Compasso — nunca 500), `date`, `period`, `latency_ms`, `total`, `spoken_count`, `max_spoken_items` (15), `more`, `items` (todos os do dia: `type` `event`/`class`/`task`, `title`, `time` — a frase que a Luna fala —, `start`, `end`, `all_day`, `at` para ordenar, `seen_by_luna`; aula com `location`, `professor`, `cancelled`; tarefa com `due`, `done`) e `tool_payload`, o objeto exato que o modelo receberia. Não entra no histórico, mas atualiza o semáforo da agenda — v2 |
| `GET calendar/log?limit=50` | Histórico das tools da agenda, mais recente primeiro (1–500): `at`, `room_id`, `tool`, `action` (`query`, `create_event`, `create_task`, `complete_task`), `params` (só `when`, `day_of_month`, `kind`, `effort`, `attribute`, `has_search` presentes), `result`, `ok`, `item_count`, `item_id` (do Compasso) e `latency_ms` (soma das idas ao Compasso; `null` se nem chamou). Sem texto livre — v2 |
| `GET diagnostics/latency?hours=24` | Série de TTFAB (até 2000 amostras, 1 h–30 d), meta de 800 ms e resumo por sala × provedor: `p50_ms`, `p90_ms`, `max_ms`, `over_target`, `cold` (sessões frias, fora dos percentis) — v2 |
| `GET diagnostics/errors?limit=20` | Últimos erros: todo `error`/`fatal` e os `warn` de dependência externa (HA, clima, provider, lembrete perdido) — v2 |
| `GET logs/stream?level=info&room=` | Log ao vivo em SSE: primeiro o buffer em memória (500 linhas) filtrado, depois cada linha nova; heartbeat a cada 15 s; até 4 streams (429) — v2 |

Grupos novos da v2: `voice` (`geminiVadSilenceMs`, `geminiVadEndSensitivity`,
`geminiThinkingBudget`, `openaiVadType`, `openaiVadSilenceMs`, `userSilenceCutoffMs`), semeado
das variáveis de mesmo nome do `.env` e aplicado na próxima sessão — menos o
`userSilenceCutoffMs`, que o `Orchestrator` lê a cada turno; e `weather` (`city`, `latitude`,
`longitude`), semeado de `WEATHER_LATITUDE`/`WEATHER_LONGITUDE`/`WEATHER_CITY`. Trocar o clima
troca a previsão na hora; a tool `get_weather` entra ou sai na próxima sessão.

A fala de um lembrete criado pelo painel é pré-renderizada pelo mesmo gate de sala quieta
da voz, mas só quando a sala já tem sessão de provider aberta; sem ela o lembrete toca só o
bipe (`has_audio: false` na listagem) até ser editado com a sala ativa. O histórico vem das
linhas de log dos eventos de lembrete (`reminder_events`), então para de crescer com
`LOG_LEVEL` acima de `info`.

O diagnóstico não sabe de conversa: `logTap` descarta toda chave de log que possa carregar
fala (`raw`, `text`, `transcript`…) e guarda só escalares. Retenção no SQLite: 30 dias ou 10
mil linhas por tabela (`latency_samples`, `error_log`, `reminder_events`, migração 4; `agenda_events`, migração 5).
A migração 5 torna o deploy de mão única de novo — ver `luna-server/deploy/README.md`.

Códigos: 404 em tudo sem `LUNA_ADMIN_TOKEN`; 403 fora de loopback/rede privada; 401
token errado; 422 validação; 413 corpo acima de 64 KB.

O teste de conexão da agenda é **provisório**: só prova que a URL responde e aceita a
credencial, até a API do app existir (TODO abaixo).

## TODO: API do app de agendas

Resolvido: o app é o **Compasso**, e a integração está no [ADR 011](adr/011-agenda-compasso.md).

- Autenticação por `Authorization: Bearer`.
- Rota de saúde em `GET /health` autenticada, que o "testar conexão" usa.
- Listagem por intervalo, com offset `-03:00` explícito.
- Aulas são itens `type: "class"` na mesma agenda.
- Tarefas têm prazo opcional, `effort` e `attribute` obrigatórios, e `POST /tasks/{id}/complete`.
- Erros tratados por `error.code`.

A URL gravada no painel é a base **com** `/api/v1`:

- Processo no homeserver: `http://127.0.0.1:8090/api/v1`.
- Container na rede `compasso_default`: `http://compasso-api:3000/api/v1`.
- Fora do homeserver, pelo túnel: `https://compasso.homelab-server.space/api/v1`.

Continua pendente só a tela "O que a Luna vê hoje" e o log de consultas, da seção 6.

## Ordem de construção (marcos, cada um verificável isoladamente)

1. **Configuração no SQLite** — `SettingsStore` com migração aditiva, semeadura a
   partir do `.env` e do `devices.json`, aviso `config_env_ignored`, fonte de
   configuração observável no lugar do `AppConfig` imutável para o grupo de
   runtime. Sem API ainda. *Verificável:* servidor sobe igual ao de hoje, com os
   mesmos valores, agora lidos do banco; testes cobrindo semeadura e precedência.
2. **API admin somente leitura** — token, filtro de LAN, rotas de status,
   satélites, conexões, salas, lembretes e bootstrap. *Verificável:* `curl` com e
   sem token, de IP privado e de fora; testes de integração em `ws/`.
3. **Janela do painel no desktop** — `BrowserWindow` isolada, cliente admin em
   `src/main/admin/`, token em `safeStorage`, item "Configurações" da bandeja
   abrindo o painel. Telas: Início, Satélites (só leitura), Lembretes (listar) e
   Este computador. *Verificável:* painel abre e fecha sem afetar o áudio; voz
   funciona com o painel aberto.
4. **Integrações com escrita** — HA, provedor de IA e tela de conexão da agenda;
   aplicação a quente por grupo (ADR 010, decisão 5); reiniciar servidor.
   *Verificável:* trocar o token do HA pelo painel e acender uma luz sem restart;
   trocar a voz e ouvir a nova na conversa seguinte.
5. **Salas e dispositivos** — mapeamento sala ↔ área, visualização por sala,
   edição de apelidos, nomes de satélites, cancelar lembrete. *Verificável:*
   "acende a luz" funcionando a partir do `desktop_diogo` depois de mapeá-lo.
6. **v2**, na ordem que fizer sentido na hora: diagnóstico (TTFAB e logs),
   integração da agenda (depende do TODO), clima, não perturbe, o resto da v2.

Tudo marcado **depois** fica fora destes marcos: exige protocolo e/ou firmware e
merece plano próprio.

### O que a v1 entregou

- **Servidor:** `settings/` (SQLite, semeadura, `config_env_ignored`, aplicação a quente por
  grupo) e `admin/` (API da seção acima). Unit com `StateDirectoryMode=0700`.
- **Desktop:** janela `panel/` isolada (sandbox, partição própria, CSP), cliente admin e
  whitelist de métodos em `src/main/admin/` e `src/main/panel/`, configuração local em
  `userData/settings.json` com segredos no `safeStorage`. O item "Configurações" da bandeja
  abre o painel; sem segredo configurado, o app abre o painel sozinho.
- **Sidecar:** evento `score` (`--score-interval-ms`) para o medidor de wake word ao vivo.
- **Visual:** sistema "LUNA 6000" (terminal de fósforo verde), vindo do Claude Design —
  tokens, componentes e regras em [design-system-painel.md](design-system-painel.md).

Diferenças em relação ao inventário:

- O item "Mutar, forçar escuta, autostart" ganhou tela, mas continua também na bandeja.
- "Configuração de bootstrap, só leitura" e "Reiniciar o servidor" ficaram numa tela
  **Servidor** própria.
- A tela de salas lista as áreas do HA que têm ao menos um dispositivo acionável
  (`switch`/`light`/`fan`) — área vazia não aparece, porque o registro só conhece o que
  descobriu.
- O semáforo do provider reflete a **última sessão aberta**, não uma sonda: até alguém
  falar com a Luna depois do boot, fica amarelo ("nenhuma sessão aberta").

### O que a v2 entregou

Marcos 6 a 11, cada um com commit próprio e passado pelo `luna-code-reviewer`:

- **M6 Diagnóstico:** `logging/logTap.ts` + `diagnostics/` (TTFAB, últimos erros, log ao vivo por
  SSE, sem transcrição); tela Diagnóstico e quadro de erros no Início.
- **M7 Lembretes:** criar/editar pelo painel (hora de parede de São Paulo, mesmas regras da voz),
  histórico, fala pré-renderizada por fila própria do painel.
- **M8 Dispositivos:** exclusões, manuais (só `switch`/`light`/`fan` novos), testar e refresh.
- **M9 Integrações:** grupos `voice` e `weather`, clima trocável a quente com geocoding.
- **M10 Satélites e servidor:** bloquear/desconectar, backup sem segredos e restauração,
  release implantada (`release.json` do CI).
- **M11 Este computador:** sensibilidade da wake word (reinicia o sidecar com `--threshold`, o
  `frontend.py` não muda), atalho global "falar agora", notificação do Windows quando um lembrete
  toca na sala do desktop (o processo principal consulta `GET reminders` a cada 10 s — o
  protocolo WS não ganhou evento).

A migração 4 do banco (tabelas do diagnóstico) torna o deploy de mão única — ver
`luna-server/deploy/README.md`.

### Verificação manual

✅ Todos os passos abaixo confirmados pelo usuário em 2026-11-17. Ficam aqui como roteiro
para repetir depois de mudanças grandes.

1. No servidor: reinstalar a unit (`sudo cp` + `daemon-reload`, ver `deploy/README.md`) e
   definir `LUNA_ADMIN_TOKEN` em `/etc/luna-server.env` **antes** do deploy — o
   `activate.sh` recusa o deploy enquanto a unit divergir.
2. No desktop: token admin em Este computador; Início com semáforos verdes.
3. Marco 3: painel aberto e fechado com a voz funcionando o tempo todo.
4. Marco 4: trocar o token do HA pelo painel e acender uma luz sem restart; trocar a voz e
   ouvir a nova na conversa seguinte.
5. Marco 5: mapear `desktop_diogo → <área>` e "acende a luz" a partir do desktop.

## Pegadinhas conhecidas antes de começar

- **A unit systemd muda** (`StateDirectoryMode=0700`) — o deploy não a
  reinstala; passo manual obrigatório (ver `CLAUDE.md` e `deploy/README.md`).
- **`devices.json` deixa de ser a fonte** depois do primeiro boot com o banco
  semeado. `deploy/README.md` e `onboarding.md` precisam dizer isso.
- **O `test` do `luna-server` e do `luna-desktop` lista arquivos um a um** — todo
  teste novo entra à mão no `package.json`.
- **O CI só cobre `luna-server/**`.** O painel no desktop não tem portão
  automático.
