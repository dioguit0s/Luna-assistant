# ADR 006 — Agendamento server-side e contrato de tempo

**Status:** Aceito
**Data:** 2026-08-24
**Contexto:** Marcos 0, 4 e 9 de alarmes e lembretes ([docs/alarmes-e-lembretes.md](../alarmes-e-lembretes.md))

## Contexto

Um alarme precisa de três coisas que o sistema não tinha: saber que horas são,
acordar na hora certa, e entender o que "amanhã às sete" significa.

Nenhuma delas é óbvia neste sistema:

- **O satélite não tem relógio.** O firmware não configura NTP nem RTC — só
  `millis()`/`esp_timer` —, e os `ts` do envelope WebSocket são uptime, não hora
  de parede.
- **O servidor tinha a hora errada.** `buildLunaSystemPrompt` usava
  `now.getHours()`, a hora local **do processo**. A unit systemd não definia `TZ=`
  e o CI também não: num host UTC o prompt já dizia a hora errada por 3 horas.
  Isso só afetava o "período do dia"; com alarmes, "amanhã às 7" resolveria 3 h
  fora.
- **O modelo não sabe que horas são.** O prompt congela a hora no `connect`; numa
  sessão longa o relógio dele envelhece.

## Decisão

### 1. Todo agendamento é server-side

O satélite continua um alto-falante burro. Não recebe horários, não conta tempo,
não decide nada — só toca o que chega pelo WebSocket.

### 2. Um relógio só, compartilhado

`time/clock.ts` é a **única** fonte de "agora" do processo, fixada em
`America/Sao_Paulo`, consumida pelos três lugares que precisam concordar: o
timestamp dos logs, a hora do system prompt e a resolução de "amanhã às 7".

`Environment=TZ=America/Sao_Paulo` na unit fecha o outro lado.

Corrigir só o scheduler seria **pior que o bug original**: o "agora" do modelo e o
do servidor passariam a discordar, e a Luna confirmaria em voz um horário
diferente do que ficou agendado.

O offset -03:00 é fixo desde 2019, quando o Brasil aboliu o horário de verão.
Toda a aritmética de recorrência assume isso — um dia local tem exatamente 24 h —
e há um teste tripwire que falha se a premissa cair, antes de os alarmes
começarem a tocar uma hora fora.

### 3. Um timer único auto-corretivo, não um `setTimeout` por alarme

O `ReminderScheduler` mantém **um** `setTimeout`, clampado em ~60 s, re-derivando
`delay = due - now()` a cada acordada.

Não é polling burro: é um timer só que se corrige. O clamp resolve de uma vez três
coisas que um `setTimeout` direto não acompanha — o teto de ~24,8 dias, o drift do
relógio, e o salto de NTP ou a suspensão da VM (o `setTimeout` conta tempo
monotônico, não hora de parede).

### 4. Catch-up precisa de política, não só de mecanismo

Um deploy às 3h depois de 3 h fora não pode disparar o alarme das 6:30 às 9:30,
nem despejar um dia de alarmes de uma vez:

- dispara se `now - due <= MISSED_GRACE_MS` (15 min); mais velho vira `missed`;
- recorrente **não** vira `missed`: avança para a próxima ocorrência futura **sem
  tocar**, colapsando um atraso de vários dias numa ocorrência só.

### 5. Idempotência a crash

`status='ringing'` e o avanço de `next_due_utc` são gravados na mesma transação,
**antes** de o áudio sair. Sem isso, um crash no meio do toque re-dispara o
one-shot a cada boot. No boot, `ringing` mais velho que `ALARM_MAX_RING_MS` é
fechado.

### 6. O modelo manda intenção; o servidor resolve o instante

A tool aceita `in_seconds` (relativo) **ou** `at_time` (`"HH:MM"` local) +
`when_day`/`repeat` — nunca um timestamp absoluto.

Aceitar um ISO datetime gerado pelo LLM daria alarme na data errada, **em
silêncio**: é a mesma classe de bug que o [ADR 002](002-function-calling-contract.md)
documenta para o `room_id` alucinado, e a mesma regra resolve — quem tem certeza
decide.

O resultado da tool devolve a data resolvida **em texto** (`spoken_when`), e o
prompt manda a Luna confirmar usando esse texto. A confirmação falada nunca
diverge do que foi agendado.

### 7. Recorrência por `enum`, e derivada da hora de parede

O campo é um `enum` (`none`, `daily`, `weekdays`, `weekend`, `weekly`), não um CSV
de dias: `providers/gemini/tool-mapping.ts` só propaga `type`, `description` e
`enum`, e um array quebraria o adapter. Além disso, um CSV **não distingue** "sexta
às 20h" (uma vez) de "toda sexta às 20h" — `repeat` e `when_day` ortogonais
distinguem.

A próxima ocorrência é sempre derivada de `local_hour`/`local_minute` + regra,
nunca de `anterior + delta`. Isso não é preferência de estilo: a soneca sobrescreve
`next_due_utc`, então um cálculo incremental faria "todo dia às 6:30" virar 6:35,
6:40, 6:45 — um pouco mais tarde a cada soneca.

## Consequências

### Positivas

- Um alarme sobrevive a deploy, restart e relógio saltando.
- Prompt, logs e agendamento concordam sobre que horas são.
- O firmware não muda: nenhum NTP, nenhum RTC, nenhum estado novo no satélite.
- O modelo não consegue agendar na data errada, porque não escolhe datas.

### Negativas

- Uma acordada por minuto, para sempre, mesmo sem alarme nenhum — barato, mas não
  é zero.
- Fuso fixo: uma casa fora de São Paulo precisa de mudança de código.
- O clamp de 60 s significa que criar ou adiar um lembrete **precisa** chamar
  `reschedule()`; esquecer isso atrasa um alarme em até um minuto, silenciosamente.
- A política de catch-up é uma escolha de produto embutida em código: 15 minutos é
  arbitrário, e a única forma de descobrir que está errado é alguém reclamar.

## Alternativas consideradas

### Um `setTimeout` por alarme (rejeitada)

Mais direto e sem acordadas ociosas. Rejeitada pelo teto de ~24,8 dias e,
principalmente, por não acompanhar salto de relógio: um alarme marcado antes de uma
suspensão de VM dispararia tarde, na proporção do tempo suspenso.

### `cron`/systemd timers (rejeitada)

Delegaria o agendamento ao SO. Rejeitada por exigir que o servidor escrevesse
unidades ou crontab a cada lembrete criado — muito mais superfície de permissão e
de falha do que um timer em memória sobre um banco.

### Agendar no satélite (rejeitada)

Exigiria NTP e RTC no ESP32-S3, mais estado persistente no firmware e um tipo novo
de mensagem no protocolo. Toda a arquitetura trata o satélite como periférico burro,
e alarme não é motivo suficiente para mudar isso.

### Fuso configurável por cômodo (adiada)

Faz sentido numa casa em dois países. Não nesta.

## Referências

- [alarmes-e-lembretes.md](../alarmes-e-lembretes.md) — decisões 1, 2, 5, 6 e 7
- [ADR 002](002-function-calling-contract.md) — a mesma política de "quem tem certeza decide"
- [ADR 005](005-persistencia-no-servidor.md) — onde este estado vive
