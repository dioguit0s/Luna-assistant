# ADR 005 — Persistência no `luna-server`

**Status:** Aceito
**Data:** 2026-08-24
**Contexto:** Marco 3 de alarmes e lembretes ([docs/alarmes-e-lembretes.md](../alarmes-e-lembretes.md))

## Contexto

Até este marco o `luna-server` **não escrevia em disco**. O único I/O era o
`readFileSync` do `devices.json`, e a unit systemd dizia literalmente *"O processo
nao escreve em disco: nenhum ReadWritePaths necessario"*. Todo o estado vivia em
memória: sessões de provider, `ConversationRingBuffer`, catálogo de dispositivos.

Marcar alarmes por voz quebra essa propriedade. O CI faz deploy a cada push em
`main`, com restart do systemd — um alarme para as 7h não sobrevive a um deploy às
3h. Nenhuma quantidade de cuidado em memória resolve isso: o estado precisa
sobreviver ao processo.

A pergunta não era "se" persistir, e sim **onde** e **com o quê**, dado que o
processo roda sob `ProtectSystem=strict` e que o `activate.sh` troca o symlink de
`/opt/luna/current` a cada deploy, podando releases antigas.

## Decisão

**SQLite via `node:sqlite`**, com o banco fora da árvore de releases, atrás de um
wrapper (`ReminderStore`) que é o único ponto de SQL do servidor.

### `node:sqlite`, não `better-sqlite3`

`node:sqlite` funciona **sem flag** no Node 22.22.2 e expõe `DatabaseSync`/
`StatementSync`. Zero dependência nova — o `package.json` continua com as 4 deps
que tinha.

O `better-sqlite3` foi rejeitado por causa do deploy, não da API: o `activate.sh`
roda `npm ci --omit=dev` no runner self-hosted a cada release, o que compilaria um
addon nativo toda vez (python3 + gcc, +30-60 s, ABI casada com o Node do host).

**O risco real não é a lib, é a versão do Node do host.** O workflow não tem
`setup-node` — usa o Node da máquina. Em Node < 22.5 o import morre no boot, o
`health_ok` falha e o rollback dispara: falha segura, mas deploy queimado. Por isso
`engines.node` subiu para `>=22.5.0` e o workflow ganhou um guard que roda
`require('node:sqlite')` **antes** de montar a release.

### Onde o banco fica

`resolveDbPath`, em ordem de precedência: `LUNA_DB_PATH` explícito →
`$STATE_DIRECTORY` do systemd → `./.luna-state/luna.db` (dev).

`StateDirectory=luna-server` na unit cria `/var/lib/luna-server` com dono
`luna:luna` e libera escrita mesmo sob `ProtectSystem=strict`, sem `ReadWritePaths`
à mão.

O caminho é **absoluto de propósito**, e não segue o padrão relativo do
`devicesConfigPath` (`'config/devices.json'`, relativo ao `WorkingDirectory`): esse
default apontaria exatamente para o diretório que some a cada deploy.

### Migrações só aditivas, e o que isso não cobre

**Migração é o maior risco operacional desta feature — maior que a escolha da
lib.** Com CI publicando a cada push e `activate.sh` fazendo rollback para a
release anterior, uma migração que a versão antiga não lê torna o rollback letal:
a release nova migra o schema, o health falha, volta o código velho, que engasga
no schema novo.

Daí: `PRAGMA user_version`, migrações **só aditivas** (nunca renomear, nunca
remover, nunca mudar tipo), e `SELECT` sempre de colunas explícitas, nunca
`SELECT *`.

Isso cobre o código velho lendo **dados** novos. Não cobre o código velho abrindo
um banco com `user_version` maior que o número de migrações que ele conhece —
`migrate()` recusa, de propósito, para não operar sobre schema que não entende. A
segunda migração (`reminder_audio`, marco 8) foi a primeira a esbarrar nisso, e a
resposta foi operacional: o `activate.sh` faz **backup do `.db` antes de trocar o
symlink**, preferindo `sqlite3 .backup` a `cp` (um banco em WAL copiado com `cp`
pode sair inconsistente com o `-wal` ao lado).

### Fail-fast na abertura

Se o banco não abrir — permissão, corrupção, versão à frente —, o boot falha alto.
O health check pega e o rollback funciona.

Um fallback silencioso para `:memory:` foi rejeitado: alarmes sumiriam a cada
restart sem nenhum sinal, e a primeira pessoa a descobrir seria alguém que não
acordou.

### WAL e escritas minúsculas

`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 3000`.

O motivo é de latência, não de throughput: `DatabaseSync` é síncrono e bloqueia o
mesmo event loop que roda o tick de 32 ms de `drainAudioQueue`. Um fsync lento no
`INSERT` de um lembrete viraria **buraco audível na resposta de outro cômodo**.

## Consequências

### Positivas

- Alarmes sobrevivem a deploy, restart e queda de energia — é o ponto da feature.
- Zero dependência nova, `npm ci` continua rápido no runner.
- Todo o SQL num arquivo só: trocar de lib é mexer em `ReminderStore`, nada mais.
- `short_id` legível dá ao usuário uma forma de referenciar um lembrete por voz.

### Negativas

- **O servidor agora tem estado em disco.** Backup, permissão e corrupção viram
  preocupações reais de operação, que antes não existiam.
- O piso de Node subiu para 22.5: quem rodar o servidor precisa disso.
- `node:sqlite` é experimental — daí `--disable-warning=ExperimentalWarning` no
  `ExecStart`, e o wrapper como único ponto a trocar se a API mudar.
- Rollback deixou de ser gratuito: depende de um backup que o `activate.sh` faz,
  mas que ninguém testa a não ser quando precisa.

## Alternativas consideradas

### Arquivo JSON com escrita atômica (rejeitada)

`writeFileSync` num `.tmp` + `rename`. Sem dependência e simples de inspecionar.
Rejeitada porque toda mutação reescreve o arquivo inteiro (o pior caso de latência
cresce com o número de lembretes) e porque não há transação: `status='ringing'` e o
avanço de `next_due_utc` precisam ser atômicos, senão um crash no meio do toque
re-dispara o alarme a cada boot.

### `better-sqlite3` (rejeitada)

Ver acima: addon nativo recompilado a cada deploy no runner self-hosted.

### Redis ou Postgres (rejeitada)

Um serviço a mais para instalar, monitorar e fazer backup numa casa. O banco tem
dezenas de linhas, não milhares.

### Migrar o `ConversationRingBuffer` para o banco (rejeitada)

"Já que agora tem banco." Ciclo de vida e história de privacidade completamente
diferentes: o ring buffer é memória curta e descartável de conversa, e persisti-lo
é uma decisão de produto que merece ADR própria.

## Referências

- [alarmes-e-lembretes.md](../alarmes-e-lembretes.md) — decisões 3 e 4
- [ADR 006](006-agendamento-e-contrato-de-tempo.md) — o que consome esta persistência
- [`luna-server/deploy/README.md`](../../luna-server/deploy/README.md)
