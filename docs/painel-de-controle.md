# Painel de controle — plano

**Status:** v1 implementada (marcos 1–5) — falta validação manual no app instalado e no servidor de produção; v2 em andamento (M6 Diagnóstico feito)
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
| Desconectar ou bloquear um satélite (aparelho perdido) | API + Persist | v2 |
| "Tocar som / piscar LED" para identificar | Proto + FW | depois |
| Versão do firmware, IP, sinal do Wi-Fi | Proto + FW | depois |
| Trocar a sala sem recompilar (hoje `ROOM_ID` é compilado) | Proto + FW | depois |
| Rotacionar o segredo (`SecretStore::setAuthSecret` existe, nada o aciona) | Proto + FW | depois |
| Provisionar satélite novo por USB (Wi-Fi, servidor e segredo na NVS) | Tela + FW | depois |
| Volume, brilho do LED, sensibilidade da wake word por satélite | Proto + FW | depois |
| Atualização de firmware pela rede (OTA) | FW + API | depois |

### 3. Salas e dispositivos

| Função | Precisa de | Quando |
|---|---|---|
| Salas conhecidas: dos satélites e das áreas do HA | API | v1 |
| Mapear sala da Luna ↔ área do HA (resolve o `desktop_diogo`) | API + Persist | v1 |
| O que a Luna "enxerga" em cada sala (mesma saída do `list_devices`, [ADR 009](adr/009-inventario-por-comodo.md)) | API | v1 |
| Editar apelidos (`aliases`) | API + Persist | v1 |
| Editar exclusões (`exclude`) e dispositivos manuais | API + Persist | v2 |
| "Testar": ligar/desligar um dispositivo pelo painel | API | v2 |
| Forçar refresh do registro de dispositivos do HA | API | v2 |

### 4. Integrações

| Função | Precisa de | Quando |
|---|---|---|
| **Home Assistant**: URL, token, "testar conexão" | API + Persist | v1 |
| **Agenda**: URL, credencial, "testar conexão", status | API + Persist | v1 (tela) — as tools dependem do [TODO da agenda](#todo-api-do-app-de-agendas) |
| **Provedor de IA**: Gemini ou OpenAI, modelo, voz, chaves | API + Persist | v1 |
| **Provedor de IA (avançado)**: VAD, silêncio, thinking | API + Persist | v2 |
| **Clima**: cidade (vira lat/long), "testar" | API + Persist | v2 |

### 5. Lembretes e alarmes

| Função | Precisa de | Quando |
|---|---|---|
| Listar ativos: rótulo, sala, horário, recorrência | API | v1 |
| Cancelar | API | v1 |
| Criar e editar pelo painel | API | v2 |
| Histórico: tocou, perdido, adiado | API (parte já está no banco) | v2 |

### 6. Agenda

| Função | Precisa de | Quando |
|---|---|---|
| "O que a Luna vê hoje": eventos, tarefas e aulas do dia, como ela receberia | API + TODO da agenda | v2 |
| Log do que a Luna consultou ou criou na agenda (ação e resultado, sem transcrição) | API + Persist | v2 |

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
| Sensibilidade da wake word | Tela + sidecar | v2 |
| Atalho global de push-to-talk | Tela | v2 |
| Notificação do Windows quando um lembrete tocar | Tela | v2 |
| Digitar para a Luna em vez de falar | Proto | depois |

### 9. Servidor

| Função | Precisa de | Quando |
|---|---|---|
| Configuração de bootstrap (porta, caminho do banco), só leitura | API | v1 |
| Reiniciar o servidor (saída de emergência) | API | v1 |
| Backup e restauração do banco, **sem segredos** | API | v2 |
| Versão implantada e data do último deploy | API | v2 |

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
| `GET status` | Versão, uptime, satélites online, semáforo por conexão (`ha`, `provider`, `weather`, `calendar`: `ok`/`error`/`unknown`/`off`) e os 5 próximos lembretes |
| `GET bootstrap` | Porta, caminho do banco, nível de log — só leitura, sem segredo |
| `GET satellites` | Conectados agora + vistos desde o boot + nomeados; `online`, `connected_since`, `last_seen_at` |
| `PUT satellites/:device_id` | `{ "name": "Quarto" }` — `null` ou vazio remove |
| `GET rooms` | Salas (de satélite, áreas do HA, mapeadas), área efetiva e o que o `list_devices` veria nelas |
| `PUT rooms/:room_id` | `{ "area": "escritorio" }` — `null` remove o mapeamento |
| `GET devices` / `PUT devices` | Overrides; v1 grava só `{ "aliases": {...} }` |
| `GET reminders` | Lembretes vivos de todas as salas, com a frase falada |
| `DELETE reminders/:id` | Cancela: banco, toque em curso e scheduler |
| `GET settings/:grupo` | `ha`, `provider` ou `calendar`, com segredos como `{ set, last4 }` e `applies` (`immediate` / `next_session`) |
| `PUT settings/:grupo` | Patch parcial; campo ausente = mantém. 422 com `field` quando inválido |
| `POST settings/ha/test`, `POST settings/calendar/test` | Testa com o corpo completado pelo que está gravado — dá para testar sem gravar |
| `POST restart` | 202 e shutdown gracioso; o `Restart=always` traz de volta |
| `GET diagnostics/latency?hours=24` | Série de TTFAB (até 2000 amostras, 1 h–30 d), meta de 800 ms e resumo por sala × provedor: `p50_ms`, `p90_ms`, `max_ms`, `over_target`, `cold` (sessões frias, fora dos percentis) — v2 |
| `GET diagnostics/errors?limit=20` | Últimos erros: todo `error`/`fatal` e os `warn` de dependência externa (HA, clima, provider, lembrete perdido) — v2 |
| `GET logs/stream?level=info&room=` | Log ao vivo em SSE: primeiro o buffer em memória (500 linhas) filtrado, depois cada linha nova; heartbeat a cada 15 s; até 4 streams (429) — v2 |

O diagnóstico não sabe de conversa: `logTap` descarta toda chave de log que possa carregar
fala (`raw`, `text`, `transcript`…) e guarda só escalares. Retenção no SQLite: 30 dias ou 10
mil linhas por tabela (`latency_samples`, `error_log`, migração 4).

Códigos: 404 em tudo sem `LUNA_ADMIN_TOKEN`; 403 fora de loopback/rede privada; 401
token errado; 422 validação; 413 corpo acima de 64 KB.

O teste de conexão da agenda é **provisório**: só prova que a URL responde e aceita a
credencial, até a API do app existir (TODO abaixo).

## TODO: API do app de agendas

A API REST do app ainda não está definida. O que se sabe do uso:

- A Luna precisa **responder** sobre eventos, tarefas e aulas do dia (e de outros
  dias, por data relativa — "amanhã", "sexta").
- A Luna precisa **criar** eventos e tarefas por voz.

A definir antes de o marco da agenda começar:

- [ ] Autenticação (token fixo? qual header?)
- [ ] Rota de saúde para o "testar conexão" do painel
- [ ] Listagem por intervalo de datas, com fuso explícito (o contrato de tempo
      do [ADR 006](adr/006-agendamento-e-contrato-de-tempo.md) vale aqui também)
- [ ] Aulas: são eventos com tipo próprio, ou recurso separado?
- [ ] Tarefas: têm data? prioridade? como marcar como feita?
- [ ] Criação de evento e de tarefa: campos mínimos obrigatórios
- [ ] Erros e limites (o que a Luna fala quando o app está fora)

No servidor, a integração segue o formato de `weather/` e `reminders/`: uma fonte
(`CalendarSource`) atrás de um *holder* trocável, e tools novas no contrato do
[ADR 002](adr/002-function-calling-contract.md). Os lembretes da Luna continuam
separados dos eventos da agenda.

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

### Verificação manual pendente

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
