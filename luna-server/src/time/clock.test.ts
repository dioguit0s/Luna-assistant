import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LUNA_TIME_ZONE,
  LUNA_UTC_OFFSET_MINUTES,
  formatLocalDate,
  formatLocalTime,
  formatLocalTimestamp,
  localDateTime,
  offsetMinutes,
  systemNow,
} from './clock.js';

// Instantes são sempre construídos em UTC: assim o teste vale igual no Windows
// do dev e num runner de CI em UTC. Um teste que usasse `new Date(2026, 6, 19,
// 7)` afirmaria coisas diferentes em cada máquina — exatamente o bug que este
// módulo corrige.
const utc = (iso: string): Date => new Date(iso);

describe('clock', () => {
  it('decompõe um instante na hora de parede de São Paulo', () => {
    const parts = localDateTime(utc('2026-07-19T13:45:07.500Z'));

    assert.deepEqual(parts, {
      year: 2026,
      month: 7,
      day: 19,
      hour: 10,
      minute: 45,
      second: 7,
      weekday: 0, // domingo
    });
  });

  it('recua o dia quando o UTC já virou mas São Paulo não', () => {
    const parts = localDateTime(utc('2026-07-20T02:00:00Z'));

    assert.equal(parts.day, 19);
    assert.equal(parts.hour, 23);
    assert.equal(parts.weekday, 0);
  });

  it('rende meia-noite como 00, não 24', () => {
    assert.equal(formatLocalTime(utc('2026-07-20T03:00:00Z')), '00:00');
    assert.equal(localDateTime(utc('2026-07-20T03:00:00Z')).hour, 0);
  });

  it('formata hora e data com zero à esquerda', () => {
    assert.equal(formatLocalTime(utc('2026-01-05T10:05:00Z')), '07:05');
    assert.equal(formatLocalDate(utc('2026-01-05T10:05:00Z')), '2026-01-05');
  });

  it('mede o offset em vez de assumi-lo, e continua sem horário de verão', () => {
    // Guarda de DST: o Brasil aboliu o horário de verão em 2019, e a aritmética
    // de "próxima ocorrência" do agendador conta com offset fixo. Se a zona
    // voltar a ter DST, este teste falha antes de um alarme tocar 1h errado.
    const janeiro = offsetMinutes(utc('2026-01-15T12:00:00Z'));
    const julho = offsetMinutes(utc('2026-07-15T12:00:00Z'));

    assert.equal(janeiro, LUNA_UTC_OFFSET_MINUTES);
    assert.equal(julho, LUNA_UTC_OFFSET_MINUTES);
    assert.equal(janeiro, julho, `${LUNA_TIME_ZONE} voltou a observar DST`);
  });

  it('rende timestamp ISO com offset explícito e milissegundos', () => {
    assert.equal(
      formatLocalTimestamp(utc('2026-07-19T13:45:07.042Z')),
      '2026-07-19T10:45:07.042-03:00',
    );
  });

  it('systemNow devolve o instante atual', () => {
    const antes = Date.now();
    const agora = systemNow().getTime();

    assert.ok(agora >= antes && agora <= Date.now(), 'systemNow fora da janela de execução');
  });
});
