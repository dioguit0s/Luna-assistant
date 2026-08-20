import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ReminderStore } from './ReminderStore.js';

// Só `logLevel` importa para o `createLogger`; montar um AppConfig inteiro aqui
// só somaria mais um literal à lista dos que quebram a cada campo novo.
const silentConfig = { logLevel: 'silent' } as AppConfig;

const ROOM = 'sala_de_estar';
const OUTRA_SALA = 'cozinha';
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
const HORA = 3_600_000;

describe('ReminderStore: CRUD em memória', () => {
  let store: ReminderStore;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    store = ReminderStore.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('insere one-shot com short_id falável e next_due igual ao vencimento', () => {
    const criado = store.insertOnce(
      { roomId: ROOM, label: 'tomar o remédio', dueAtUtc: T0 + HORA },
      T0,
    );

    assert.equal(criado.roomId, ROOM);
    assert.equal(criado.kind, 'once');
    assert.equal(criado.status, 'armed');
    assert.equal(criado.dueAtUtc, T0 + HORA);
    assert.equal(criado.nextDueUtc, T0 + HORA);
    assert.equal(criado.repeatRule, null);
    assert.equal(criado.fireCount, 0);
    assert.equal(criado.lastFiredAt, null);
    assert.equal(criado.createdAt, T0);

    // Sem vogais e sem os pares que se confundem falados (0/O, 1/I, 5/S).
    assert.match(criado.shortId, /^[23456789ABCDEFGHJKLMNPQRTUVWXYZ]{4}$/);
    assert.deepEqual(store.get(criado.id), criado);
  });

  it('insere recorrente com hora local e regra já resolvida', () => {
    const criado = store.insertRecurring(
      {
        roomId: ROOM,
        label: null,
        localHour: 6,
        localMinute: 30,
        repeatRule: 'weekdays',
        nextDueUtc: T0 + HORA,
      },
      T0,
    );

    assert.equal(criado.kind, 'recurring');
    assert.equal(criado.label, null);
    assert.equal(criado.dueAtUtc, null);
    assert.equal(criado.localHour, 6);
    assert.equal(criado.localMinute, 30);
    assert.equal(criado.repeatRule, 'weekdays');
  });

  it('short_id não colide entre os lembretes vivos da mesma sala', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 40; i++) {
      ids.add(store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + i }, T0).shortId);
    }
    assert.equal(ids.size, 40);
  });

  it('findByShortId ignora caixa e não enxerga outra sala nem lembrete morto', () => {
    const criado = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + HORA }, T0);

    assert.deepEqual(store.findByShortId(ROOM, criado.shortId.toLowerCase()), criado);
    assert.equal(store.findByShortId(OUTRA_SALA, criado.shortId), null);

    store.markStatus(criado.id, 'cancelled', T0);
    assert.equal(store.findByShortId(ROOM, criado.shortId), null);
  });

  it('lista e conta só os vivos da sala, na ordem em que vão tocar', () => {
    const tarde = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + 2 * HORA }, T0);
    const cedo = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + HORA }, T0);
    const cancelado = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + 3 }, T0);
    store.insertOnce({ roomId: OUTRA_SALA, label: null, dueAtUtc: T0 + 1 }, T0);
    store.markStatus(cancelado.id, 'cancelled', T0);

    assert.deepEqual(
      store.listLiveByRoom(ROOM).map((r) => r.id),
      [cedo.id, tarde.id],
    );
    assert.equal(store.countLiveByRoom(ROOM), 2);
    assert.equal(store.countLiveByRoom('quarto'), 0);
  });

  it('nextArmed e listDue enxergam o próximo a vencer, ignorando o que não está armado', () => {
    const cedo = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 - HORA }, T0);
    const tarde = store.insertOnce({ roomId: OUTRA_SALA, label: null, dueAtUtc: T0 + HORA }, T0);

    assert.equal(store.nextArmed()?.id, cedo.id);
    assert.deepEqual(
      store.listDue(T0).map((r) => r.id),
      [cedo.id],
    );

    store.markStatus(cedo.id, 'done', T0);
    assert.equal(store.nextArmed()?.id, tarde.id);
    assert.deepEqual(store.listDue(T0), []);
  });

  it('markRinging grava status, contador e o avanço do vencimento de uma vez', () => {
    // Idempotência a crash: isto é gravado ANTES de o áudio sair, senão um
    // crash no meio do toque re-dispara o one-shot a cada boot.
    const criado = store.insertRecurring(
      {
        roomId: ROOM,
        label: null,
        localHour: 7,
        localMinute: 0,
        repeatRule: 'daily',
        nextDueUtc: T0,
      },
      T0,
    );

    store.markRinging(criado.id, T0 + 24 * HORA, T0 + 1);

    const tocando = store.get(criado.id)!;
    assert.equal(tocando.status, 'ringing');
    assert.equal(tocando.nextDueUtc, T0 + 24 * HORA);
    assert.equal(tocando.fireCount, 1);
    assert.equal(tocando.lastFiredAt, T0 + 1);
  });

  it('markRinging em quem não está armado é no-op (não re-dispara o mesmo toque)', () => {
    const criado = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
    store.markRinging(criado.id, T0, T0);
    store.markRinging(criado.id, T0, T0 + 5);

    assert.equal(store.get(criado.id)!.fireCount, 1);
  });

  it('recoverStaleRinging: one-shot velho vira done, recorrente volta a armed, recente fica', () => {
    const MAX_RING = 5 * 60_000;
    const oneShot = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
    const recorrente = store.insertRecurring(
      { roomId: ROOM, label: null, localHour: 7, localMinute: 0, repeatRule: 'daily', nextDueUtc: T0 },
      T0,
    );
    const recente = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);

    store.markRinging(oneShot.id, T0, T0);
    store.markRinging(recorrente.id, T0 + 24 * HORA, T0);
    const agora = T0 + MAX_RING + 1;
    store.markRinging(recente.id, T0, agora);

    assert.equal(store.recoverStaleRinging(MAX_RING, agora), 2);
    assert.equal(store.get(oneShot.id)!.status, 'done');
    assert.equal(store.get(recorrente.id)!.status, 'armed');
    assert.equal(store.get(recente.id)!.status, 'ringing');
  });

  it('rearm volta para armed no novo horário, sem linha nova', () => {
    const criado = store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
    store.markRinging(criado.id, T0, T0);

    store.rearm(criado.id, T0 + 5 * 60_000, T0 + 1);

    const adiado = store.get(criado.id)!;
    assert.equal(adiado.status, 'armed');
    assert.equal(adiado.nextDueUtc, T0 + 5 * 60_000);
    assert.equal(store.countLiveByRoom(ROOM), 1);
  });
});

describe('ReminderStore: arquivo, migrações e falha na abertura', () => {
  let dir: string;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'luna-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cria o diretório do banco e sobrevive à reabertura (é o alarme sobrevivendo ao deploy)', () => {
    // O caminho tem um nível que ainda não existe: em produção o
    // StateDirectory já existe, mas em dev o default é `./.luna-state/`.
    const dbPath = join(dir, 'estado', 'luna.db');

    const primeira = ReminderStore.open(dbPath);
    const criado = primeira.insertOnce(
      { roomId: ROOM, label: 'acordar', dueAtUtc: T0 + HORA },
      T0,
    );
    primeira.close();

    const segunda = ReminderStore.open(dbPath);
    assert.deepEqual(segunda.get(criado.id), criado);
    assert.deepEqual(
      segunda.listLiveByRoom(ROOM).map((r) => r.shortId),
      [criado.shortId],
    );
    segunda.close();
  });

  it('carimba user_version e não remigra na segunda abertura', () => {
    const dbPath = join(dir, 'luna.db');

    ReminderStore.open(dbPath).close();
    const depoisDaPrimeira = userVersion(dbPath);
    assert.ok(depoisDaPrimeira >= 1, 'migração não carimbou user_version');

    ReminderStore.open(dbPath).close();
    assert.equal(userVersion(dbPath), depoisDaPrimeira);
  });

  it('banco mais novo que o código falha alto (rollback com migração aplicada)', () => {
    // O caso letal do `activate.sh`: release nova migra o schema, o health
    // falha, volta o código velho. Ler um schema desconhecido em silêncio
    // seria pior que não subir.
    const dbPath = join(dir, 'luna.db');
    ReminderStore.open(dbPath).close();

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 999');
    db.close();

    assert.throws(() => ReminderStore.open(dbPath), /mais nova que este código/);
  });

  it('banco que não abre derruba o boot, sem cair para :memory: em silêncio', () => {
    // Diretório-pai que na verdade é um arquivo: o mkdir falha, e o processo
    // precisa morrer aqui para o health check pegar e o rollback funcionar.
    const arquivo = join(dir, 'nao-e-diretorio');
    writeFileSync(arquivo, 'x');

    assert.throws(
      () => ReminderStore.open(join(arquivo, 'luna.db')),
      /Falha ao abrir o banco de lembretes/,
    );
  });
});

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}
