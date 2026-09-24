# Painel de controle — plano

**Status:** Planejado — inventário fechado, nenhum marco iniciado
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
| Últimos erros (HA falhou, provedor caiu) | API + Persist | v2 |

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
| TTFAB por satélite e por provedor, com gráfico e a meta de 800 ms | API + Persist | v2 |
| Logs do servidor ao vivo, filtro por sala e nível (SSE) | API | v2 |
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

## Pegadinhas conhecidas antes de começar

- **A unit systemd muda** (`StateDirectoryMode=0700`) — o deploy não a
  reinstala; passo manual obrigatório (ver `CLAUDE.md` e `deploy/README.md`).
- **`devices.json` deixa de ser a fonte** depois do primeiro boot com o banco
  semeado. `deploy/README.md` e `onboarding.md` precisam dizer isso.
- **O `test` do `luna-server` e do `luna-desktop` lista arquivos um a um** — todo
  teste novo entra à mão no `package.json`.
- **O CI só cobre `luna-server/**`.** O painel no desktop não tem portão
  automático.
