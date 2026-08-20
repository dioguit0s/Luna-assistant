import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from '../logging/logger.js';

export type ReminderKind = 'once' | 'recurring';

export type ReminderStatus = 'armed' | 'ringing' | 'done' | 'cancelled' | 'missed';

/**
 * Regra de recorrência **já resolvida** — não é o campo da tool. `repeat:
 * 'weekly'` + `when_day: 'fri'` chega aqui como `'fri'`; `repeat: 'none'` nem
 * chega, vira um `once` com instante absoluto.
 */
export type RepeatRule =
  | 'daily'
  | 'weekdays'
  | 'weekend'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'
  | 'sun';

export interface Reminder {
  id: number;
  /** Referência falável, 4 caracteres. Único entre os lembretes vivos da sala. */
  shortId: string;
  /** Sala de origem = onde toca. */
  roomId: string;
  /** Texto a ser falado; `null` = só alarme. */
  label: string | null;
  kind: ReminderKind;
  /** `once`: instante absoluto em epoch ms UTC, já resolvido pelo servidor. */
  dueAtUtc: number | null;
  /** `recurring`: hora de parede em America/Sao_Paulo. */
  localHour: number | null;
  localMinute: number | null;
  repeatRule: RepeatRule | null;
  /** Materializado: o que o scheduler lê. Sempre epoch ms UTC. */
  nextDueUtc: number;
  status: ReminderStatus;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

export interface NewOnceReminder {
  roomId: string;
  label: string | null;
  /** Epoch ms UTC. O servidor resolve; o modelo nunca manda instante. */
  dueAtUtc: number;
}

export interface NewRecurringReminder {
  roomId: string;
  label: string | null;
  localHour: number;
  localMinute: number;
  repeatRule: RepeatRule;
  /** Primeira ocorrência, já calculada (ver `recurrence.ts`). Epoch ms UTC. */
  nextDueUtc: number;
}

/**
 * Migrações **só aditivas**, versionadas por `PRAGMA user_version`.
 *
 * Esta é a parte mais arriscada da persistência, e o risco é operacional, não
 * técnico: o CI publica a cada push em `main` e o `activate.sh` faz rollback
 * para a release anterior quando o health check falha. Uma migração que a
 * versão antiga não consegue ler torna o rollback letal — a release nova migra
 * o schema, algo mais falha, volta o código velho, que engasga no schema novo.
 *
 * Daí a regra: nunca renomear, nunca remover, nunca mudar tipo de coluna.
 * Coluna nova entra como nullable ou com default. E todo `SELECT` lista as
 * colunas explicitamente (ver `REMINDER_COLUMNS`), nunca `SELECT *`.
 */
const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        short_id      TEXT    NOT NULL,
        room_id       TEXT    NOT NULL,
        label         TEXT,
        kind          TEXT    NOT NULL CHECK (kind IN ('once','recurring')),

        due_at_utc    INTEGER,

        local_hour    INTEGER CHECK (local_hour   BETWEEN 0 AND 23),
        local_minute  INTEGER CHECK (local_minute BETWEEN 0 AND 59),
        repeat_rule   TEXT CHECK (repeat_rule IN
                        ('daily','weekdays','weekend','mon','tue','wed','thu','fri','sat','sun')),

        next_due_utc  INTEGER NOT NULL,

        status        TEXT    NOT NULL DEFAULT 'armed'
                        CHECK (status IN ('armed','ringing','done','cancelled','missed')),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_fired_at INTEGER,
        fire_count    INTEGER NOT NULL DEFAULT 0,

        CHECK ((kind = 'once'      AND due_at_utc IS NOT NULL AND repeat_rule IS NULL)
            OR (kind = 'recurring' AND repeat_rule IS NOT NULL AND local_hour IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders (next_due_utc) WHERE status IN ('armed','ringing');
      CREATE INDEX IF NOT EXISTS idx_reminders_room
        ON reminders (room_id, status);
    `);
  },
];

/** Nunca `SELECT *`: a ordem e o conjunto de colunas ficam explícitos aqui. */
const REMINDER_COLUMNS = `
  id, short_id, room_id, label, kind, due_at_utc, local_hour, local_minute,
  repeat_rule, next_due_utc, status, created_at, updated_at, last_fired_at, fire_count
`;

/** Status que ainda ocupam lugar: contam para o teto por sala e para o scheduler. */
const LIVE_STATUSES = "('armed','ringing')";

// Sem vogais e sem os pares que se confundem falados (0/O, 1/I, 5/S): o
// short_id existe para ser dito em voz alta ("cancela o A7K2").
const SHORT_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRTUVWXYZ';
const SHORT_ID_LENGTH = 4;

export class ReminderStore {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Abre (ou cria) o banco e aplica as migrações pendentes.
   *
   * **Falha no boot é de propósito.** Se o banco não abrir — permissão,
   * corrupção, diretório de estado ausente —, o processo morre, o health check
   * do `activate.sh` pega e o rollback funciona. Um fallback silencioso para
   * `:memory:` faria todos os alarmes sumirem a cada restart sem nenhum sinal.
   */
  static open(dbPath: string): ReminderStore {
    let db: DatabaseSync;
    try {
      if (dbPath !== ':memory:') {
        mkdirSync(dirname(dbPath), { recursive: true });
      }
      db = new DatabaseSync(dbPath);
      applyPragmas(db);
    } catch (err) {
      throw new Error(
        `Falha ao abrir o banco de lembretes em "${dbPath}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    const store = new ReminderStore(db);
    try {
      store.migrate();
    } catch (err) {
      db.close();
      throw err;
    }
    return store;
  }

  private migrate(): void {
    const current = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );

    if (current > MIGRATIONS.length) {
      // Rollback do código com o schema já migrado. Não dá para "desmigrar":
      // gritar aqui é melhor que ler um schema que este código não conhece.
      throw new Error(
        `Banco de lembretes na versão ${current}, mais nova que este código (${MIGRATIONS.length}). ` +
          'Rollback com migração aplicada — restaure o backup do banco.',
      );
    }

    for (let version = current; version < MIGRATIONS.length; version++) {
      MIGRATIONS[version]!(this.db);
      // `user_version` não aceita bind de parâmetro.
      this.db.exec(`PRAGMA user_version = ${version + 1}`);
      getLogger().info(
        { event: 'reminder_store_migrated', from: version, to: version + 1 },
        `Banco de lembretes migrado para a versão ${version + 1}`,
      );
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /** Prepara sob demanda e reaproveita: o scheduler chama o mesmo SQL a cada acordada. */
  private stmt(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  insertOnce(input: NewOnceReminder, now = Date.now()): Reminder {
    return this.insert(
      {
        roomId: input.roomId,
        label: input.label,
        kind: 'once',
        dueAtUtc: input.dueAtUtc,
        localHour: null,
        localMinute: null,
        repeatRule: null,
        nextDueUtc: input.dueAtUtc,
      },
      now,
    );
  }

  insertRecurring(input: NewRecurringReminder, now = Date.now()): Reminder {
    return this.insert(
      {
        roomId: input.roomId,
        label: input.label,
        kind: 'recurring',
        dueAtUtc: null,
        localHour: input.localHour,
        localMinute: input.localMinute,
        repeatRule: input.repeatRule,
        nextDueUtc: input.nextDueUtc,
      },
      now,
    );
  }

  private insert(
    row: Omit<
      Reminder,
      'id' | 'shortId' | 'status' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'fireCount'
    >,
    now: number,
  ): Reminder {
    const shortId = this.nextShortId(row.roomId);

    const result = this.stmt(
      `INSERT INTO reminders
         (short_id, room_id, label, kind, due_at_utc, local_hour, local_minute,
          repeat_rule, next_due_utc, status, created_at, updated_at, fire_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, 0)`,
    ).run(
      shortId,
      row.roomId,
      row.label,
      row.kind,
      row.dueAtUtc,
      row.localHour,
      row.localMinute,
      row.repeatRule,
      row.nextDueUtc,
      now,
      now,
    );

    const created = this.get(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error('Lembrete inserido mas não encontrado logo em seguida');
    }
    return created;
  }

  get(id: number): Reminder | null {
    const row = this.stmt(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`).get(id);
    return row ? toReminder(row) : null;
  }

  /** Referência por voz: o `short_id` só é único entre os lembretes vivos da sala. */
  findByShortId(roomId: string, shortId: string): Reminder | null {
    const row = this.stmt(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
        WHERE room_id = ? AND short_id = ? AND status IN ${LIVE_STATUSES}
        ORDER BY next_due_utc LIMIT 1`,
    ).get(roomId, shortId.toUpperCase());
    return row ? toReminder(row) : null;
  }

  /** O que a sala tem marcado, na ordem em que vai tocar. */
  listLiveByRoom(roomId: string): Reminder[] {
    return this.stmt(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
        WHERE room_id = ? AND status IN ${LIVE_STATUSES}
        ORDER BY next_due_utc`,
    )
      .all(roomId)
      .map(toReminder);
  }

  countLiveByRoom(roomId: string): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS total FROM reminders WHERE room_id = ? AND status IN ${LIVE_STATUSES}`,
    ).get(roomId) as { total: number };
    return Number(row.total);
  }

  /**
   * O próximo a vencer. É isto que reduz o scheduler a um `setTimeout` só: sem
   * o `next_due_utc` materializado, ele teria de recomputar recorrência em
   * memória a cada mutação.
   */
  nextArmed(): Reminder | null {
    const row = this.stmt(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
        WHERE status = 'armed' ORDER BY next_due_utc LIMIT 1`,
    ).get();
    return row ? toReminder(row) : null;
  }

  /** Tudo que já venceu até `instant`, do mais antigo para o mais novo. */
  listDue(instant: number): Reminder[] {
    return this.stmt(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
        WHERE status = 'armed' AND next_due_utc <= ?
        ORDER BY next_due_utc`,
    )
      .all(instant)
      .map(toReminder);
  }

  /**
   * Marca o disparo: `ringing`, `fire_count`, `last_fired_at` e o avanço de
   * `next_due_utc` numa transação só, **antes** de qualquer áudio sair.
   *
   * Sem isso, um crash no meio do toque re-dispara o one-shot a cada boot.
   * `nextDueUtc` é a próxima ocorrência do recorrente; num one-shot, repete o
   * vencimento atual — quem o tira de circulação é o `markStatus` do fim do
   * ciclo de toque.
   */
  markRinging(id: number, nextDueUtc: number, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt(
        `UPDATE reminders
            SET status = 'ringing',
                next_due_utc = ?,
                last_fired_at = ?,
                fire_count = fire_count + 1,
                updated_at = ?
          WHERE id = ? AND status = 'armed'`,
      ).run(nextDueUtc, now, now, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markStatus(id: number, status: ReminderStatus, now = Date.now()): void {
    this.stmt('UPDATE reminders SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  /**
   * Volta o lembrete para `armed` num novo vencimento. É a operação da soneca
   * ("mais cinco minutos") e também a do recorrente que avança sem tocar — as
   * duas são `UPDATE next_due_utc`, sem tabela à parte: o `list` depende do
   * invariante "uma linha = um lembrete visível ao usuário".
   */
  rearm(id: number, nextDueUtc: number, now = Date.now()): void {
    this.stmt(
      `UPDATE reminders SET status = 'armed', next_due_utc = ?, updated_at = ? WHERE id = ?`,
    ).run(nextDueUtc, now, id);
  }

  /**
   * Recuperação de crash no boot: `ringing` mais velho que `maxRingMs` não tem
   * quem o encerre — o ciclo de toque morreu junto com o processo.
   *
   * Recorrente volta para `armed` (o `next_due_utc` já foi avançado no
   * disparo); one-shot vira `done`, para não tocar de novo.
   *
   * @returns quantas linhas foram recuperadas.
   */
  recoverStaleRinging(maxRingMs: number, now = Date.now()): number {
    const cutoff = now - maxRingMs;
    const changes =
      Number(
        this.stmt(
          `UPDATE reminders SET status = 'done', updated_at = ?
            WHERE status = 'ringing' AND kind = 'once'
              AND COALESCE(last_fired_at, 0) <= ?`,
        ).run(now, cutoff).changes,
      ) +
      Number(
        this.stmt(
          `UPDATE reminders SET status = 'armed', updated_at = ?
            WHERE status = 'ringing' AND kind = 'recurring'
              AND COALESCE(last_fired_at, 0) <= ?`,
        ).run(now, cutoff).changes,
      );

    if (changes > 0) {
      getLogger().warn(
        { event: 'reminder_ringing_recovered', count: changes, max_ring_ms: maxRingMs },
        `${changes} lembrete(s) presos em "ringing" recuperados no boot`,
      );
    }
    return changes;
  }

  /**
   * `short_id` novo, sem colidir com os lembretes vivos da sala. Só os vivos
   * importam: o id existe para o usuário dizer "cancela o A7K2", e o que já
   * passou não é candidato.
   */
  private nextShortId(roomId: string): string {
    const taken = new Set(
      this.stmt(
        `SELECT short_id FROM reminders WHERE room_id = ? AND status IN ${LIVE_STATUSES}`,
      )
        .all(roomId)
        .map((row) => String((row as { short_id: string }).short_id)),
    );

    // 31^4 ≈ 924k combinações contra, no máximo, o teto de lembretes por sala:
    // a colisão é rara, e o teto garante que este laço termina.
    for (let attempt = 0; attempt < 100; attempt++) {
      let candidate = '';
      for (let i = 0; i < SHORT_ID_LENGTH; i++) {
        candidate += SHORT_ID_ALPHABET[Math.floor(Math.random() * SHORT_ID_ALPHABET.length)];
      }
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`Não foi possível gerar um short_id livre para a sala ${roomId}`);
  }
}

/**
 * WAL + `synchronous = NORMAL`: o `DatabaseSync` bloqueia o event loop, que é o
 * mesmo que roda o tick de 32 ms de `drainAudioQueue`. Um fsync lento no
 * `INSERT` de um lembrete viraria buraco audível na resposta de **outro**
 * cômodo.
 */
function applyPragmas(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA temp_store   = MEMORY;
    PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
  `);
}

function toReminder(row: unknown): Reminder {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    shortId: String(r.short_id),
    roomId: String(r.room_id),
    label: r.label === null ? null : String(r.label),
    kind: String(r.kind) as ReminderKind,
    dueAtUtc: r.due_at_utc === null ? null : Number(r.due_at_utc),
    localHour: r.local_hour === null ? null : Number(r.local_hour),
    localMinute: r.local_minute === null ? null : Number(r.local_minute),
    repeatRule: r.repeat_rule === null ? null : (String(r.repeat_rule) as RepeatRule),
    nextDueUtc: Number(r.next_due_utc),
    status: String(r.status) as ReminderStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastFiredAt: r.last_fired_at === null ? null : Number(r.last_fired_at),
    fireCount: Number(r.fire_count),
  };
}
