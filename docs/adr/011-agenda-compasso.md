# ADR 011 — Agenda por voz: integração com o Compasso

**Status:** Aceito
**Data:** 2026-09-25
**Contexto:** Painel de controle v2, item "integração da agenda" ([painel-de-controle.md](../painel-de-controle.md#todo-api-do-app-de-agendas))

## Contexto

O Compasso é o app de agendas do usuário: compromissos, aulas da faculdade e tarefas. Ele expõe uma API HTTP própria para a Luna em `/api/v1`, com a spec OpenAPI em `GET <BASE>/openapi.yaml`. O acesso é de servidor para servidor, com um usuário só. A Luna precisa responder sobre a agenda e criar compromissos e tarefas por voz, sem romper três contratos já estabelecidos:

- o de function calling ([ADR 002](002-function-calling-contract.md)): schema plano, e cada tool custa TTFAB;
- o de tempo ([ADR 006](006-agendamento-e-contrato-de-tempo.md)): o modelo manda intenção, e o servidor resolve o instante;
- o de configuração a quente ([ADR 010](010-painel-de-controle-e-api-admin.md)): URL e token vêm do grupo `calendar` do banco.

O contrato do Compasso que importa aqui:

- datas ISO 8601 **com offset**, e 400 quando falta;
- recorrências já expandidas;
- `Idempotency-Key` nas criações;
- `effort` e `attribute` obrigatórios em tarefa;
- decisão pelo `error.code`;
- timeouts sugeridos de 2 s (3 s no health).

## Decisão

### 1. Duas tools: `get_agenda` e `manage_agenda`

Leitura e escrita ficam separadas, e cada uma usa enums para variar:

- **`get_agenda`:** dia, semana, busca ou tarefas pendentes.
- **`manage_agenda`:** `action` ∈ `create_event | create_task | complete_task`.

Sete tools custariam orçamento de instrução em toda sessão Live. Uma tool só misturaria "consultar" com o caminho que cria, e a escrita tem regra própria: propor esforço e atributo e esperar o sim.

As duas só são declaradas, e a seção `# Agenda` do prompt só aparece, quando URL e token estão configurados (`RoomManager.setCalendarEnabledSource`). É a mesma regra do `get_weather`.

### 2. O modelo nunca manda data

O modelo manda só intenção:

- `when` (`today`, `tomorrow`, `mon`..`sun`, `week`, `next_week`, `upcoming`) ou `day_of_month`;
- `at_time` `"HH:MM"`.

`calendar/dates.ts` converte isso em `[from, to)` e em ISO com o offset fixo de São Paulo, pelo relógio único (`time/clock.ts`).

`day_of_month` é intenção, não data: o servidor escolhe o próximo "dia 30".

### 3. Resultado já falável

Os handlers devolvem cada item em palavras: tipo, título, `"08:00 às 10:00"`, `"dia inteiro"`, `"até 23:59"`, e o dia quando o período tem vários dias. A confirmação de criação vem da **resposta** do Compasso (`spoken_when`, `due`), não do pedido, como no `set_reminder`.

Títulos e salas são dado externo que entra no contexto da sessão. Por isso passam por `cleanText`: sem controle, sem quebra de linha, com teto. O prompt também diz que são dados, não instruções.

### 4. I/O no caminho da fala, sem cache

Diferente do `get_weather`, a agenda muda por fora: o usuário edita no app. Um snapshot responderia "nada hoje" logo depois de algo ser marcado.

O Compasso está na LAN, e o mesmo argumento do `await` ao HA em `control_device` vale aqui. O timeout é de 2 s, e a leitura **não** repete. A escrita repete uma vez, em timeout ou 500, com a mesma `Idempotency-Key` (`luna:<sala>:<ação>:<callId>`).

O resultado de uma consulta mostra no máximo 15 itens; o resto vira `more`. Não há cursor nos args, então o prompt manda estreitar a consulta em vez de pedir "o resto".

### 5. Concluir tarefa por título

`complete_task` aceita o `task_id` de uma consulta ou só o título:

1. O handler procura em `/tasks?done=false`.
2. Se não achar, procura na agenda dos próximos 7 dias, porque tarefa recorrente só aparece lá, com o `occurrence_date` que o complete exige.
3. Ocorrências da mesma série são deduplicadas.

Mais de uma candidata volta como `candidates`, sem concluir nenhuma: o Compasso não desfaz conclusão.

### 6. Painel

- **"Testar conexão":** chama `GET /health` autenticado.
- **Semáforo:** mostra o desfecho da última chamada das tools (`CompassoClient.lastStatus`), sem fazer requisição a cada status.

## Consequências

### Positivas

- A agenda liga e desliga pelo painel, sem restart. O cliente lê URL e token a cada requisição, e as tools valem na próxima sessão.
- A data falada nunca diverge da gravada, e o modelo não tem como marcar no dia errado.
- Reenvio após timeout não duplica evento.

### Negativas

- Cada consulta paga um round-trip ao Compasso dentro do TTFAB. No pior caso: escrita simples chega a ~4 s de silêncio (2 s + nova tentativa), e `complete_task` por título a ~8 s (busca em `/tasks`, busca na agenda, conclusão com nova tentativa). Se o Compasso estiver fora do homeserver (túnel da Cloudflare), a latência sobe.
- Datas além de "próximo dia N" (ex.: "15 de novembro" a dois meses) não são expressáveis. A busca por título cobre o caso de consulta mais comum.
- Evento de vários dias, recorrência, edição e remoção não existem por voz. O prompt manda a pessoa para o app.
