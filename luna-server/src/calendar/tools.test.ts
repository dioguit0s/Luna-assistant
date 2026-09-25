import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiFunctionDeclarations } from '../providers/gemini/tool-mapping.js';
import { GET_AGENDA_TOOL, MANAGE_AGENDA_TOOL, isGetAgendaArgs, isManageAgendaArgs } from './tools.js';

describe('tools da agenda', () => {
  it('schemas são planos: o adapter do Gemini aceita sem lançar', () => {
    const [get, manage] = toGeminiFunctionDeclarations([GET_AGENDA_TOOL, MANAGE_AGENDA_TOOL]);
    assert.equal(get.name, 'get_agenda');
    assert.equal(manage.name, 'manage_agenda');
    for (const tool of [GET_AGENDA_TOOL, MANAGE_AGENDA_TOOL]) {
      for (const prop of Object.values(tool.parameters.properties)) {
        assert.notEqual((prop as { type: string }).type, 'array');
        assert.notEqual((prop as { type: string }).type, 'object');
      }
    }
  });

  it('isGetAgendaArgs: vazio é válido, enum e tipos conferidos', () => {
    assert.equal(isGetAgendaArgs({}), true);
    assert.equal(isGetAgendaArgs({ when: 'week', kind: 'classes', search: 'prova' }), true);
    assert.equal(isGetAgendaArgs({ day_of_month: 30 }), true);
    assert.equal(isGetAgendaArgs({ when: '2026-09-26' }), false);
    assert.equal(isGetAgendaArgs({ kind: 'reminders' }), false);
    assert.equal(isGetAgendaArgs({ day_of_month: '30' }), false);
  });

  it('isManageAgendaArgs: action obrigatória, atributo no enum', () => {
    assert.equal(isManageAgendaArgs({ action: 'create_task', title: 'x', effort: 2, attribute: 'casa' }), true);
    assert.equal(isManageAgendaArgs({ title: 'x' }), false);
    assert.equal(isManageAgendaArgs({ action: 'delete_event' }), false);
    assert.equal(isManageAgendaArgs({ action: 'create_task', attribute: 'trabalho' }), false);
    assert.equal(isManageAgendaArgs({ action: 'create_event', when_day: 'next_week' }), false);
    assert.equal(isManageAgendaArgs({ action: 'create_event', effort: '2' }), false);
  });
});
